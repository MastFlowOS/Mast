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

import asyncio
import json
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
    store = LeadStore(db_path)

    # Phase 2: create profiler for this run
    profiler = RunProfiler()

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

                # Low-latency stage: emit independently observed Maps data
                # now; durable worker queues perform slow enrichment later.
                if discovery_only:
                    raw_dict = raw_place.to_dict()
                    if raw_place.closed or is_chain(raw_place.name) or is_cannabis(raw_dict):
                        continue
                    raw_dict["fingerprints"] = sorted(fingerprints_for(raw_dict))
                    raw_dict["is_disqualified"] = False
                    delivered += 1
                    yield raw_dict
                    continue

                try:
                    lead = await pipeline.process(
                        raw_place,
                        require_viability=require_viability,
                        max_ig_followers=max_ig_followers,
                        max_reviews=max_reviews,
                    )
                except Exception as exc:
                    # ROOT CAUSE hardening: pipeline.process() previously had
                    # no error isolation at this call site — an unhandled
                    # exception on ANY single business (e.g. a malformed
                    # RawPlace field, a scoring edge case) propagated all the
                    # way out of run_query(), killing the whole subprocess
                    # before the `__done__` sentinel was ever written. Node's
                    # pythonBridge then saw a non-zero exit with zero leads
                    # delivered — indistinguishable from "everything was
                    # legitimately rejected." One bad business must never be
                    # able to take down an entire run.
                    stats.errors += 1
                    log.error(
                        f"[trace] {raw_place.name!r} ↓ REJECTED — unhandled "
                        f"exception in pipeline.process(): {exc!r}",
                        exc_info=True,
                    )
                    continue
                if not lead:
                    continue
                if lead.score < min_score:
                    stats.skip(f"score_<_{min_score}")
                    log.info(
                        f"[trace] {lead.name!r} ↓ REJECTED — score={lead.score} "
                        f"below min_score={min_score} (post-pipeline gate, applied here "
                        f"in run_query rather than pipeline.process)"
                    )
                    profiler.record_rejection(
                        reason=f"score_<_{min_score}",
                        elapsed_ms=profiler.elapsed_since_business_start_ms(),
                    )
                    continue

                # ── Phase 2: track inter-lead gap and first opportunity ───────
                _now = time.perf_counter()
                if _last_lead_time is not None:
                    profiler._stages["inter_lead_gap"].record(
                        (_now - _last_lead_time) * 1000.0
                    )
                _last_lead_time = _now
                profiler.mark_first_opportunity()  # no-op after first call

                delivered += 1
                lead_dict = lead.to_dict()
                lead_dict["fingerprints"] = sorted(fingerprints_for(lead_dict))
                # Phase 6: the Opportunity Score (computed backend-side, in
                # TypeScript) needs to hard-disqualify chains/cannabis the
                # same way calculate_lead_score already does internally.
                # Reusing these functions directly avoids re-implementing
                # scorer.py's keyword lists as a second copy in Node.
                lead_dict["is_disqualified"] = bool(is_chain(lead_dict.get("name"))) or bool(is_cannabis(lead_dict))
                yield lead_dict
    finally:
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
        profiler.print_report(
            query=query,
            city=city,
            delivered=delivered,
            requested=max_results,
        )


async def _main_cli() -> None:
    raw_args = sys.argv[1] if len(sys.argv) > 1 else sys.stdin.read()
    params = json.loads(raw_args)
    requested = params.get("max_results", 60)

async def _main_cli() -> None:
    raw_args = sys.argv[1] if len(sys.argv) > 1 else sys.stdin.read()
    params = json.loads(raw_args)
    requested = params.get("max_results", 60)

    delivered = 0
    async for lead_dict in run_query(**params):
        delivered += 1
        sys.stdout.write(json.dumps(lead_dict, default=str) + "\n")
        sys.stdout.flush()

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
                result["website_data"] = await crawler.crawl(website)

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


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "verify":
        asyncio.run(_verify_cli())
    else:
        asyncio.run(_main_cli())
