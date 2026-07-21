"""
Mast Lead Engine — Service Entrypoint (Part 3 / Phase 2 addition, extended
in Phase 6 and Phase 7).

This is the ONLY new file added to the engine. It does not modify
scraper/, enrichment/, storage/, scoring/, or utils/ in any way — it only
imports and orchestrates them, the same way main.py already does.

Two operations, both usable as a library or as a subprocess:

1. SEARCH (Phase 2) — finds new places for a niche/city, streaming
   enriched, scored leads as they clear the pipeline:

       from service import run_query
       async for lead_dict in run_query(query="yoga studios", city="Austin"):
           ...

       echo '{"query":"yoga studios","city":"Austin","max_results":20}' \\
           | python service.py

2. VERIFY (Phase 7) — re-checks a single, already-known business's website
   and/or Instagram directly, with NO Maps search involved:

       from service import verify_business
       result = await verify_business(website="https://example.com", instagram="https://instagram.com/example")

       echo '{"website":"https://example.com","instagram":"https://instagram.com/example"}' \\
           | python service.py verify

Search mode is the default (no mode argument) for backward compatibility
with the Phase 2 Node bridge, which spawns `python service.py` with no
argv and writes params to stdin.
"""

from __future__ import annotations

import time as _time
# Phase 2A instrumentation: approximates the "Python imports" stage the
# audit asked for — the delta between this line (as early as the module
# can record a timestamp) and the point right after every project import
# below finishes. This does NOT capture interpreter startup itself (process
# spawn -> first bytecode of this file), which can only be measured from
# outside the process (e.g. at the Node bridge's spawn() call) — that
# boundary is out of scope for this phase (no TS changes), so it's reported
# as unmeasured rather than guessed at.
_IMPORTS_START_TS = _time.perf_counter()

import asyncio
import json
import signal
import sys
import time
from typing import Any, AsyncIterator

from scraper.maps_scraper import MapsScraper
from scraper.pipeline import EnrichmentPipeline
from enrichment.site_crawler import SiteCrawler
from enrichment.ig_intel import IGIntelligence
from scoring.scorer import is_cannabis, is_chain
from storage.dedup import LeadStore, fingerprints_for
from utils.runtime import ProxyManager, RunStats, ScraperConfig, get_logger
from utils.lifecycle_tracker import log_milestone
from utils.perf import RunProfiler, NullProfiler

_IMPORTS_DONE_TS = _time.perf_counter()
_IMPORTS_ELAPSED_MS = (_IMPORTS_DONE_TS - _IMPORTS_START_TS) * 1000.0

log = get_logger("service")

# Phase 2: module-level slot so _main_cli can read the profiler's summary
# after run_query's finally block has populated it.  This avoids changing
# run_query's public async-generator signature.
_last_perf_summary: dict = {}


async def run_query(
    *,
    query: str,
    city: str,
    country: str = "US",
    niche: str = "",
    region: str = "",
    max_results: int = 60,
    max_ig_followers: int = 5000,
    max_reviews: int = 500,
    min_score: int = 0,
    fast: bool = False,
    skip_ig: bool = False,
    skip_site_crawl: bool = False,
    require_viability: bool = True,
    discovery_only: bool = False,
    db_path: str = "data/leads.db",
) -> AsyncIterator[dict[str, Any]]:
    """
    Async generator wrapping the exact same orchestration as main.py's
    `run()` — MapsScraper -> EnrichmentPipeline.process() per place -> score
    filter — minus file writers and CLI-only concerns. Yields one lead dict
    at a time (with a `fingerprints` list attached, from the engine's own
    dedup.fingerprints_for, so the caller can dedup against the Global Lead
    Pool using the same normalization the engine already uses internally —
    no dedup logic is reimplemented on the caller's side).
    """
    config = ScraperConfig(
        fast=fast,
        headless=True,
        skip_ig=skip_ig,
        skip_site_crawl=skip_site_crawl,
        max_ig_followers=max_ig_followers,
        max_reviews=max_reviews,
    )
    stats = RunStats()
    proxy_manager = ProxyManager()

    # Phase 2: create profiler for this run. Created before LeadStore
    # (Phase 2A reorder) so the fingerprint cache load (audit §3.7) can be
    # timed instead of running invisibly before any timer exists.
    profiler = RunProfiler()
    profiler.mark("python_imports_done")  # see _IMPORTS_ELAPSED_MS below
    store = LeadStore(db_path, profiler=profiler)

    delivered = 0
    _last_lead_time: float | None = None   # for inter-lead gap tracking
    log_milestone("Before run_query discovery starts")
    try:
        async with MapsScraper(config, proxy_manager, stats, profiler=profiler) as scraper:
            pipeline = EnrichmentPipeline(
                config=config,
                browser=scraper.browser,
                store=store,
                stats=stats,
                profiler=profiler,
            )

            # ROOT CAUSE fix ("requested quantity is not honored"): this used
            # to ask MapsScraper for only `max_results * 3` raw places, on
            # the assumption that ~1/3 of raw Maps listings survive
            # enrichment + the outreach-viability gate. In production that
            # pass rate is routinely much lower (strict min_channels=2 gate,
            # dedup, chain/cannabis/review filters), so the raw generator
            # would exhaust itself — and the `async for` loop below would
            # simply end — long before `delivered` reached `max_results`,
            # even though Google Maps still had plenty more *unseen*
            # listings for this query. The caller then saw "10 requested, 3
            # delivered, done" and had no way to tell that from genuine
            # exhaustion.
            #
            # The fix: stop tying the raw-supply cap to a guessed pass rate.
            # Request a generous ceiling instead, so MapsScraper.search()'s
            # OWN exhaustion signals — the "end of results" sentinel or
            # scroll_max_rounds — are what actually decide "no more matching
            # businesses", while this loop's `delivered >= max_results`
            # check is what decides "requested quantity reached". Whichever
            # condition is true first is correct; neither was reliably
            # reachable before when the artificial 3x cap won first.
            raw_supply_cap = max(max_results * 20, 200)

            if discovery_only:
                async for raw_place in scraper.search(
                    query=query,
                    city=city,
                    country=country,
                    niche=niche,
                    region=region,
                    max_results=raw_supply_cap,
                ):
                    if delivered >= max_results:
                        break
                    raw_dict = raw_place.to_dict()
                    if raw_place.closed or is_chain(raw_place.name) or is_cannabis(raw_dict):
                        continue
                    raw_dict["fingerprints"] = sorted(fingerprints_for(raw_dict))
                    raw_dict["is_disqualified"] = False
                    delivered += 1
                    yield raw_dict
            else:
                # Bounded queue for backpressure: at most 10 items can wait in the queue
                enrich_queue = asyncio.Queue(maxsize=10)
                results_queue = asyncio.Queue()
                shared_state = {"delivered": 0}
                discovery_done = asyncio.Event()

                async def discovery_worker():
                    log.info("[discovery] worker started")
                    profiler.mark("discovery_worker_start")
                    try:
                        search_iter = scraper.search(
                            query=query,
                            city=city,
                            country=country,
                            niche=niche,
                            region=region,
                            max_results=raw_supply_cap,
                        ).__aiter__()
                        while True:
                            log.info("[discovery] waiting for scraper — awaiting next Maps business...")
                            try:
                                raw_place = await search_iter.__anext__()
                            except StopAsyncIteration:
                                log.info("[discovery] scraper exhausted — no more Maps businesses")
                                break
                            log.info(f"[discovery] scraper yielded business: {raw_place.name!r}")
                            if shared_state["delivered"] >= max_results:
                                log.info(
                                    "[discovery] requested quantity already reached "
                                    f"(delivered={shared_state['delivered']}, max_results={max_results}) — stopping"
                                )
                                break
                            # put() blocks automatically if queue is full
                            # (backpressure). Phase 2A / audit §3.5: timed
                            # so the "is discovery capped by a slower
                            # downstream consumer" hypothesis is measured
                            # rather than just flagged.
                            log.info(
                                f"[discovery] enqueue -> enrich_queue: {raw_place.name!r} "
                                f"(queue size before put={enrich_queue.qsize()})"
                            )
                            with profiler.timer("queue_wait_put"):
                                await enrich_queue.put(raw_place)
                            log.info(
                                f"[discovery] enqueued: {raw_place.name!r} "
                                f"(queue size after put={enrich_queue.qsize()})"
                            )
                    except asyncio.CancelledError:
                        log.info("[discovery] worker cancelled")
                        pass
                    except Exception as exc:
                        log.error(f"[discovery] error in maps search: {exc!r}", exc_info=True)
                    finally:
                        discovery_done.set()
                        profiler.mark("discovery_worker_end")
                        # Signal consumer that producer is done
                        log.info("[discovery] enqueue -> enrich_queue: None (completion sentinel)")
                        await enrich_queue.put(None)
                        log.info("[discovery] worker exiting")

                async def enrichment_worker():
                    log.info("[enrichment] worker started")
                    profiler.mark("enrichment_worker_start")
                    try:
                        while True:
                            log.info(
                                f"[enrichment] waiting for enrichment work — awaiting enrich_queue.get() "
                                f"(queue size before get={enrich_queue.qsize()})"
                            )
                            with profiler.timer("queue_wait_get"):
                                raw_place = await enrich_queue.get()
                            if raw_place is None:
                                log.info("[enrichment] dequeue <- enrich_queue: None (completion sentinel)")
                                break
                            log.info(
                                f"[enrichment] dequeue <- enrich_queue: {raw_place.name!r} "
                                f"(queue size after get={enrich_queue.qsize()})"
                            )

                            # Double check if we already have enough before starting slow process
                            if shared_state["delivered"] >= max_results:
                                log.info(
                                    f"[enrichment] skipping {raw_place.name!r} — requested quantity "
                                    f"already reached (delivered={shared_state['delivered']}, max_results={max_results})"
                                )
                                continue

                            log.info(f"[enrichment] processing business — Starting pipeline: {raw_place.name!r}")
                            try:
                                lead = await pipeline.process(
                                    raw_place,
                                    require_viability=require_viability,
                                    max_ig_followers=max_ig_followers,
                                    max_reviews=max_reviews,
                                )
                            except Exception as exc:
                                stats.errors += 1
                                log.info(f"[enrichment] Pipeline finished (exception): {raw_place.name!r}")
                                log.error(
                                    f"[trace] {raw_place.name!r} ↓ REJECTED — unhandled "
                                    f"exception in pipeline.process(): {exc!r}",
                                    exc_info=True,
                                )
                                continue
                            log.info(f"[enrichment] Pipeline finished: {raw_place.name!r}")

                            if not lead:
                                log.info(f"[enrichment] business rejected: {raw_place.name!r} (pipeline returned no lead)")
                                continue

                            if lead.score < min_score:
                                stats.skip(f"score_<_{min_score}")
                                log.info(
                                    f"[trace] {lead.name!r} ↓ REJECTED — score={lead.score} "
                                    f"below min_score={min_score} (post-pipeline gate, applied here "
                                    f"in run_query rather than pipeline.process)"
                                )
                                log.info(f"[enrichment] business rejected: {lead.name!r} (score below min_score)")
                                profiler.record_rejection(
                                    reason=f"score_<_{min_score}",
                                    elapsed_ms=profiler.elapsed_since_business_start_ms(),
                                )
                                continue

                            lead_dict = lead.to_dict()
                            lead_dict["fingerprints"] = sorted(fingerprints_for(lead_dict))
                            lead_dict["is_disqualified"] = bool(is_chain(lead_dict.get("name"))) or bool(is_cannabis(lead_dict))
                            log.info(
                                f"[enrichment] enrichment complete — enqueue -> results_queue: {lead.name!r} "
                                f"(queue size before put={results_queue.qsize()})"
                            )
                            await results_queue.put(lead_dict)
                            log.info(f"[enrichment] business delivered to results_queue: {lead.name!r}")
                    except asyncio.CancelledError:
                        log.info("[enrichment] worker cancelled")
                        pass
                    except Exception as exc:
                        log.error(f"[enrichment] error in worker: {exc!r}", exc_info=True)
                    finally:
                        profiler.mark("enrichment_worker_end")
                        log.info("[enrichment] enqueue -> results_queue: None (completion sentinel)")
                        await results_queue.put(None)
                        log.info("[enrichment] worker exiting")

                # Start the background tasks
                discovery_task = asyncio.create_task(discovery_worker())
                log.info("[run_query] discovery task started")
                enrichment_task = asyncio.create_task(enrichment_worker())
                log.info("[run_query] enrichment task started")

                try:
                    while shared_state["delivered"] < max_results:
                        log.info(
                            f"[run_query] waiting for results — awaiting results_queue.get() "
                            f"(delivered={shared_state['delivered']}/{max_results}, "
                            f"queue size={results_queue.qsize()})"
                        )
                        lead_dict = await results_queue.get()
                        if lead_dict is None:
                            # Sentinel indicating enrichment is done
                            log.info("[run_query] exhaustion reached — received None sentinel from results_queue")
                            break
                        log.info(
                            f"[run_query] result received: {lead_dict.get('name')!r} "
                            f"(delivered so far={shared_state['delivered']})"
                        )

                        # ── Phase 2: track inter-lead gap and first opportunity ───────
                        _now = time.perf_counter()
                        if _last_lead_time is not None:
                            profiler._stages["inter_lead_gap"].record(
                                (_now - _last_lead_time) * 1000.0
                            )
                        _last_lead_time = _now
                        profiler.mark_first_opportunity()  # no-op after first call

                        shared_state["delivered"] += 1
                        delivered = shared_state["delivered"]
                        if shared_state["delivered"] >= max_results:
                            log.info(
                                f"[run_query] requested quantity reached — delivered={shared_state['delivered']} "
                                f"max_results={max_results}"
                            )
                        yield lead_dict
                finally:
                    log.info("[run_query] entering cleanup — cancelling discovery/enrichment tasks")
                    discovery_task.cancel()
                    enrichment_task.cancel()
                    await asyncio.gather(discovery_task, enrichment_task, return_exceptions=True)
                    log.info("[run_query] cleanup finished — discovery/enrichment tasks resolved")
    finally:
        log.info("[run_query] entering outer cleanup (store close, browser shutdown, profiler report)")
        store.close()
        log_milestone("After run_query cleanup (including browser closing)")
        log.info(f"[service] done — delivered={delivered} {stats.summary()}")
        log.info(
            "[service] rejection summary:\n" + stats.rejection_summary()
        )
        # Phase 2: stash profiler summary so _main_cli can embed it in
        # the __done__ sentinel without changing run_query's public API.
        global _last_perf_summary
        _last_perf_summary = profiler.summary()
        # Phase 2A: attach the module-level import timing captured once at
        # process start. Not per-run (imports only happen once per Python
        # process, not once per run_query() call), but embedding it here
        # means every run's __perf__ output carries it for visibility.
        _last_perf_summary["python_imports_ms"] = round(_IMPORTS_ELAPSED_MS, 1)
        profiler.print_report(
            query=query,
            city=city,
            delivered=delivered,
            requested=max_results,
        )
        log.info("[run_query] outer cleanup finished")


async def _main_cli() -> None:
    raw_args = sys.argv[1] if len(sys.argv) > 1 else sys.stdin.read()
    params = json.loads(raw_args)
    requested = params.get("max_results", 60)

async def _main_cli() -> None:
    raw_args = sys.argv[1] if len(sys.argv) > 1 else sys.stdin.read()
    params = json.loads(raw_args)
    requested = params.get("max_results", 60)

    delivered = 0
    log.info("[main_cli] entering run_query async for loop")
    async for lead_dict in run_query(**params):
        delivered += 1
        sys.stdout.write(json.dumps(lead_dict, default=str) + "\n")
        sys.stdout.flush()
    log.info(f"[main_cli] run_query async for loop ended normally (delivered={delivered}) — about to write __done__")

    # `exhausted=True` means this query's own search space ran out (Maps
    # end-of-results / scroll cap) before `requested` was reached — i.e.
    # this is a genuine shortfall for this query, not an artificial stop.
    # `exhausted=False` means we stopped because we delivered everything
    # that was asked for; there may well be more out there.
    #
    # Phase 2: __perf__ carries the structured performance report so the
    # TS bridge can log it server-side without any separate file.
    sys.stdout.write(json.dumps({
        "__done__": True,
        "delivered": delivered,
        "requested": requested,
        "exhausted": delivered < requested,
        "__perf__": _last_perf_summary,
    }, default=str) + "\n")
    sys.stdout.flush()
    log.info(f"[main_cli] __done__ sentinel written (delivered={delivered}, requested={requested})")


async def verify_business(*, website: str = "", instagram: str = "", headless: bool = True) -> dict:
    """
    Phase 7. Re-checks a single, already-known business's website and/or
    Instagram DIRECTLY — no Maps search, no niche/city query. Reuses
    `SiteCrawler` / `IGIntelligence` exactly as `EnrichmentPipeline` does
    internally for extraction; the only genuinely new logic is the raw
    reachability probe below (a bare `page.goto` + catch), since
    `SiteCrawler.crawl()` was built to answer "what did we extract" and
    silently returns an empty dict on both a dead site and a live-but-
    contentless one — it has no reason to distinguish those, so it can't
    tell verification whether the site is still up. Duplicating its
    extraction logic to add that distinction would violate "don't
    duplicate crawler logic"; a two-line separate probe doesn't.

    Returns:
      {
        "website_ok": bool | None,      # None = no website on file to check
        "website_data": dict,           # SiteCrawler.crawl() output, only if website_ok
        "instagram_ok": bool | None,    # None = no instagram on file to check
        "instagram_data": dict,         # IGIntelligence.fetch_profile() output, only if instagram_ok
      }
    """
    config = ScraperConfig(headless=headless)
    stats = RunStats()
    proxy_manager = ProxyManager()

    result: dict[str, Any] = {
        "website_ok": None,
        "website_data": {},
        "instagram_ok": None,
        "instagram_data": {},
    }

    async with MapsScraper(config, proxy_manager, stats) as scraper:
        browser = scraper.browser

        if website:
            page = await browser.new_page()
            try:
                await page.goto(website, wait_until="domcontentloaded", timeout=config.site_timeout_ms)
                result["website_ok"] = True
            except Exception as e:
                log.debug(f"[verify] website unreachable: {website} ({e})")
                result["website_ok"] = False
            finally:
                await page.close()

            if result["website_ok"]:
                crawler = SiteCrawler(config, browser)
                try:
                    result["website_data"] = await crawler.crawl(website)
                except Exception as e:
                    # The reachability probe above already succeeded (the
                    # page loaded), so website_ok stays True — this is an
                    # extraction failure, not a dead site. Website crawling
                    # and Instagram intelligence are independent
                    # responsibilities; a crash here must not prevent the
                    # Instagram check below from running.
                    log.debug(f"[verify] website crawl failed after reachability check succeeded: {website} ({e})")

        if instagram:
            ig = IGIntelligence(config, browser)
            profile = await ig.fetch_profile(instagram)
            # `blocked` is IG_intel's own signal for "sorry, this page isn't
            # available" — i.e. the handle no longer resolves, distinct from
            # a merely private (but still existing) account.
            result["instagram_ok"] = not profile.get("blocked", False)
            result["instagram_data"] = profile

    return result


async def _verify_cli() -> None:
    raw_args = sys.argv[2] if len(sys.argv) > 2 else sys.stdin.read()
    params = json.loads(raw_args)
    result = await verify_business(**params)
    sys.stdout.write(json.dumps(result, default=str))
    sys.stdout.flush()


async def _run_with_graceful_shutdown(coro_fn) -> None:
    """
    BUG FIX (missing profiler report): the Node bridge (pythonBridge.ts /
    runEngineQuery) deliberately asks this process for more leads than it
    needs (`askFor`) and breaks out of its consuming loop as soon as its own
    target is met — that is the NORMAL way almost every run ends, not an
    error case. When it stops consuming early, its cleanup path now sends
    SIGTERM (see pythonBridge.ts gracefulKillProcessTree), falling back to
    SIGKILL only if this process doesn't exit on its own within a grace
    period.

    Without a handler, SIGTERM's default OS action terminates the
    interpreter immediately — same as SIGKILL — so run_query()'s outer
    `finally` (store.close(), profiler.print_report(), the __done__
    sentinel) never runs. That's the actual root cause of the missing
    profiler report: it's not that print_report() has a bug, it's that the
    process is being killed before Python ever gets to run it.

    The fix here just cancels the running task on SIGTERM instead of doing
    nothing: cancellation raises CancelledError at the task's current await
    point, which unwinds the stack through run_query()'s existing
    try/finally chain exactly like any other exception — so its cleanup
    (including the profiler report) still runs before the process exits.
    """
    task = asyncio.ensure_future(coro_fn())

    def _on_sigterm() -> None:
        log.warning(
            "[service] received SIGTERM — cancelling run for graceful "
            "shutdown so cleanup (profiler report) can still finish"
        )
        task.cancel()

    if sys.platform != "win32":
        # add_signal_handler needs a running loop and isn't supported on
        # Windows' default event loop; on Windows the process falls back to
        # the pre-existing (immediate) shutdown behavior.
        asyncio.get_running_loop().add_signal_handler(signal.SIGTERM, _on_sigterm)

    try:
        await task
    except asyncio.CancelledError:
        log.info("[service] exited after graceful SIGTERM shutdown")


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "verify":
        asyncio.run(_run_with_graceful_shutdown(_verify_cli))
    else:
        asyncio.run(_run_with_graceful_shutdown(_main_cli))
