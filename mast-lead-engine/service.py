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
from typing import Any, AsyncIterator

from scraper.maps_scraper import MapsScraper
from scraper.pipeline import EnrichmentPipeline
from enrichment.site_crawler import SiteCrawler
from enrichment.ig_intel import IGIntelligence
from scoring.scorer import is_cannabis, is_chain
from storage.dedup import LeadStore, fingerprints_for
from utils.runtime import ProxyManager, RunStats, ScraperConfig, get_logger

log = get_logger("service")


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

    delivered = 0
    try:
        async with MapsScraper(config, proxy_manager, stats) as scraper:
            pipeline = EnrichmentPipeline(config=config, browser=scraper.browser, store=store, stats=stats)

            async for raw_place in scraper.search(
                query=query,
                city=city,
                country=country,
                niche=niche,
                region=region,
                max_results=max_results * 3,  # over-fetch to account for filters, same ratio as main.py
            ):
                if delivered >= max_results:
                    break

                lead = await pipeline.process(
                    raw_place,
                    require_viability=require_viability,
                    max_ig_followers=max_ig_followers,
                    max_reviews=max_reviews,
                )
                if not lead:
                    continue
                if lead.score < min_score:
                    stats.skip(f"score_<_{min_score}")
                    continue

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
        log.info(f"[service] done — delivered={delivered} {stats.summary()}")


async def _main_cli() -> None:
    raw_args = sys.argv[1] if len(sys.argv) > 1 else sys.stdin.read()
    params = json.loads(raw_args)

    delivered = 0
    async for lead_dict in run_query(**params):
        delivered += 1
        sys.stdout.write(json.dumps(lead_dict, default=str) + "\n")
        sys.stdout.flush()

    sys.stdout.write(json.dumps({"__done__": True, "delivered": delivered}) + "\n")
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
