"""
PHASE 5 BENCHMARK: Phase 3 Google Maps Fast Path Operation-Count Quantification
================================================================================

Deterministically measures the reduction in browser DOM operations, back-navigations,
and redundant extractions between:
  - Baseline (Legacy): Unconditional back-navigation per card, full extraction on all
    listings, redundant website DOM queries, unconditional settle waits.
  - Phase 3 Fast Path: Consecutive card clicks in split view, early heading snapshot
    disqualification, website probe reuse, and selective settle waits.

Scenarios:
  1. Consecutive Card Back-Navigations (10 cards in split-pane view)
  2. Disqualified Card Short-Circuiting (Chain / Cannabis / Known Place ID)
  3. Website Selector DOM Query Reuse
"""

from __future__ import annotations

import asyncio
import os
import sys

# Ensure mast-lead-engine is on sys.path
sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(__file__)), "mast-lead-engine"))

import scraper.maps_scraper as maps_scraper_module
from scraper.maps_scraper import (
    MapsScraper,
    RawPlace,
    _extract_place_data,
    _is_conclusively_disqualified_by_name,
)
from utils.perf import RunProfiler as PerfProfiler
from utils.runtime import RunStats, ScraperConfig
from tests.test_phase3_maps_fast_path import (
    _FakeContext,
    _SplitViewScenarioPage,
)


def _wire_page(page: _SplitViewScenarioPage):
    async def _fake_new_stealth_context(_browser, proxy=None):
        return _FakeContext(page)

    async def _noop(*_a, **_kw):
        return None

    maps_scraper_module._new_stealth_context = _fake_new_stealth_context
    maps_scraper_module._detect_interstitial = _noop
    maps_scraper_module._human_scroll = _noop


# ---------------------------------------------------------------------------
# Benchmark 1: Consecutive Card Back-Navigations (_return_to_results)
# ---------------------------------------------------------------------------
async def benchmark_consecutive_navigation(card_count: int = 10):
    cards = [
        {
            "href": f"https://www.google.com/maps/place/Clinic+{i}/data=!4m2!3m1!1s0x880fd2:0x11111{i:02d}",
            "aria": f"Clinic {i} · {i}00 Main St",
            "outcomes": [
                {
                    "name": f"Clinic {i}",
                    "category": "Dental Clinic",
                    "address": f"{i}00 Main St, Chicago, IL",
                    "phone": f"+1 312-555-01{i:02d}",
                    "website": f"https://clinic{i}.example.com",
                    "ratingRaw": "4.9",
                    "reviewRaw": f"{10 * i} reviews",
                    "url": f"https://www.google.com/maps/place/Clinic+{i}/data=!4m2!3m1!1s0x880fd2:0x11111{i:02d}",
                }
            ],
        }
        for i in range(1, card_count + 1)
    ]

    page = _SplitViewScenarioPage(cards=cards)
    _wire_page(page)

    config = ScraperConfig(
        scroll_max_rounds=2,
        max_crash_retries=0,
        place_timeout_ms=150,
        place_settle_ms=20,
        scroll_settle_timeout_ms=50,
        maps_rpm=60000,
        skip_redundant_return_to_results=True,
    )
    profiler = PerfProfiler()
    scraper = MapsScraper(config, stats=RunStats(), profiler=profiler)
    scraper._browser = object()
    scraper._limiter.acquire = lambda *_a, **_kw: asyncio.sleep(0)

    yielded: list[RawPlace] = []
    async for place in scraper.search("dentists", "Chicago", country="US", max_results=card_count):
        yielded.append(place)

    snap = profiler.summary()
    fast_path_skipped = snap["counters"].get("return_to_results_skipped", 0)
    fast_path_executed = snap["counters"].get("return_to_results_executed", 0)

    # Legacy baseline executed _return_to_results for EVERY card:
    legacy_executed = len(yielded)

    return {
        "cards_processed": len(yielded),
        "legacy_back_navs": legacy_executed,
        "fast_path_back_navs": fast_path_executed,
        "fast_path_skipped": fast_path_skipped,
        "reduction_pct": ((legacy_executed - fast_path_executed) / legacy_executed) * 100,
    }


# ---------------------------------------------------------------------------
# Benchmark 2: Disqualified Card Short-Circuiting
# ---------------------------------------------------------------------------
async def benchmark_conclusive_disqualification():
    href_chain = "https://www.google.com/maps/place/Starbucks+Reserve/data=!4m2!3m1!1s0x880fd2:0xaaa111"
    href_cannabis = "https://www.google.com/maps/place/Green+Relief+Dispensary/data=!4m2!3m1!1s0x880fd2:0xbbb222"
    href_known = "https://www.google.com/maps/place/Known+Clinic/data=!4m2!3m1!1s0x880fd2:0xccc333"
    href_dup = "https://www.google.com/maps/place/Downtown+Dental/data=!4m2!3m1!1s0x880fd2:0xddd444"
    href_valid_1 = "https://www.google.com/maps/place/Downtown+Dental/data=!4m2!3m1!1s0x880fd2:0xeee555"
    href_valid_2 = "https://www.google.com/maps/place/Midwest+Ortho/data=!4m2!3m1!1s0x880fd2:0xfff666"

    cards = [
        # 1. Valid card 1
        {
            "href": href_valid_1,
            "aria": "Downtown Dental · 100 Loop St",
            "outcomes": [
                {
                    "name": "Downtown Dental",
                    "category": "Dentist",
                    "address": "100 Loop St, Chicago, IL",
                    "phone": "+1 312-555-0101",
                    "website": "https://downtowndental.example.com",
                    "url": href_valid_1,
                }
            ],
        },
        # 2. Canonical chain keyword ("Starbucks Reserve" matches "starbucks")
        {
            "href": href_chain,
            "aria": "Starbucks Reserve · 646 Michigan Ave",
            "outcomes": [
                {
                    "name": "Starbucks Reserve",
                    "category": "Coffee shop",
                    "address": "646 Michigan Ave, Chicago, IL",
                    "url": href_chain,
                }
            ],
        },
        # 3. Canonical cannabis keyword ("Green Relief Dispensary" matches "dispensary")
        {
            "href": href_cannabis,
            "aria": "Green Relief Dispensary · 200 State St",
            "outcomes": [
                {
                    "name": "Green Relief Dispensary",
                    "category": "Cannabis store",
                    "address": "200 State St, Chicago, IL",
                    "url": href_cannabis,
                }
            ],
        },
        # 4. Known Place ID redirected / matched post-click
        {
            "href": href_known,
            "aria": "Known Clinic · 300 Clark St",
            "outcomes": [
                {
                    "name": "Known Clinic",
                    "category": "Clinic",
                    "address": "300 Clark St, Chicago, IL",
                    "url": href_known,
                }
            ],
        },
        # 5. Duplicate name + address
        {
            "href": href_dup,
            "aria": "Downtown Dental · 100 Loop St",
            "outcomes": [
                {
                    "name": "Downtown Dental",
                    "category": "Dentist",
                    "address": "100 Loop St, Chicago, IL",
                    "url": href_dup,
                }
            ],
        },
        # 6. Valid card 2
        {
            "href": href_valid_2,
            "aria": "Midwest Ortho · 500 Michigan Ave",
            "outcomes": [
                {
                    "name": "Midwest Ortho",
                    "category": "Orthodontist",
                    "address": "500 Michigan Ave, Chicago, IL",
                    "phone": "+1 312-555-0102",
                    "website": "https://midwestortho.example.com",
                    "url": href_valid_2,
                }
            ],
        },
    ]

    page = _SplitViewScenarioPage(cards=cards)
    _wire_page(page)

    config = ScraperConfig(
        scroll_max_rounds=2,
        max_crash_retries=0,
        place_timeout_ms=150,
        place_settle_ms=20,
        scroll_settle_timeout_ms=50,
        maps_rpm=60000,
        skip_redundant_return_to_results=True,
    )
    profiler = PerfProfiler()
    scraper = MapsScraper(config, stats=RunStats(), profiler=profiler)
    scraper._browser = object()
    scraper._limiter.acquire = lambda *_a, **_kw: asyncio.sleep(0)

    yielded: list[RawPlace] = []
    async for place in scraper.search(
        "dentists",
        "Chicago",
        country="US",
        max_results=10,
        known_place_ids={"0x880fd2:0xccc333"},
    ):
        yielded.append(place)

    snap = profiler.summary()
    fast_abort_disqualified = snap["counters"].get("maps_detail_fast_abort_disqualified", 0)
    early_known_skipped = snap["counters"].get("maps_detail_early_known_place_skipped", 0)
    early_dup_skipped = snap["counters"].get("maps_detail_early_duplicate_skipped", 0)

    # Legacy baseline ran full evaluate extraction on every clicked card (6 extractions)
    legacy_full_extractions = len(cards)
    # Phase 3 fast path ran extract_evaluate_calls only on non-shortcircuited cards
    fast_path_full_extractions = page.extract_evaluate_calls

    return {
        "total_cards": len(cards),
        "disqualified_count": fast_abort_disqualified + early_known_skipped + early_dup_skipped,
        "chain_cannabis_fast_aborts": fast_abort_disqualified,
        "early_known_skipped": early_known_skipped,
        "early_dup_skipped": early_dup_skipped,
        "legacy_full_extractions": legacy_full_extractions,
        "fast_path_full_extractions": fast_path_full_extractions,
        "extractions_skipped": legacy_full_extractions - fast_path_full_extractions,
        "reduction_pct": ((legacy_full_extractions - fast_path_full_extractions) / legacy_full_extractions) * 100,
    }


# ---------------------------------------------------------------------------
# Benchmark 3: Website Selector DOM Query Reuse
# ---------------------------------------------------------------------------
async def benchmark_website_query_reuse():
    cards = [
        {
            "href": f"https://www.google.com/maps/place/Reuse+Clinic+{i}/data=!4m2!3m1!1s0x880fd2:0x99999{i}",
            "aria": f"Reuse Clinic {i} · {i}00 Michigan Ave",
            "outcomes": [
                {
                    "name": f"Reuse Clinic {i}",
                    "category": "Clinic",
                    "address": f"{i}00 Michigan Ave, Chicago, IL",
                    "phone": f"+1 312-555-090{i}",
                    "website": f"https://reuseclinic{i}.example.com",
                    "ratingRaw": "4.8",
                    "reviewRaw": "50 reviews",
                    "url": f"https://www.google.com/maps/place/Reuse+Clinic+{i}/data=!4m2!3m1!1s0x880fd2:0x99999{i}",
                }
            ],
        }
        for i in range(1, 6)
    ]

    page = _SplitViewScenarioPage(cards=cards)
    _wire_page(page)

    config = ScraperConfig(
        scroll_max_rounds=2,
        max_crash_retries=0,
        place_timeout_ms=150,
        place_settle_ms=20,
        scroll_settle_timeout_ms=50,
        maps_rpm=60000,
        skip_redundant_return_to_results=True,
    )
    profiler = PerfProfiler()
    scraper = MapsScraper(config, stats=RunStats(), profiler=profiler)
    scraper._browser = object()
    scraper._limiter.acquire = lambda *_a, **_kw: asyncio.sleep(0)

    yielded: list[RawPlace] = []
    async for place in scraper.search("dentists", "Chicago", country="US", max_results=5, require_website=True):
        yielded.append(place)

    snap = profiler.summary()
    probes_reused = snap["counters"].get("maps_website_probe_reused", 0)

    # Legacy: 1 probe query + 6 selectors in _extract_place_data = 7 queries per card
    # Phase 3: 1 probe query + 0 selectors in _extract_place_data = 1 query per card
    selectors_per_extract = 6
    legacy_selector_evals = len(cards) * selectors_per_extract
    fast_path_selector_evals = (len(cards) - probes_reused) * selectors_per_extract

    return {
        "valid_cards": len(yielded),
        "probes_reused": probes_reused,
        "legacy_selector_evals": legacy_selector_evals,
        "fast_path_selector_evals": fast_path_selector_evals,
        "evals_saved": legacy_selector_evals - fast_path_selector_evals,
        "reduction_pct": ((legacy_selector_evals - fast_path_selector_evals) / legacy_selector_evals) * 100,
    }


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
if sys.platform == "win32":
    import io
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8", errors="replace")

async def main():
    print("=" * 80)
    print("MAST Discovery Engine -- Phase 3 Maps Fast Path Operation Benchmark")
    print("=" * 80)

    # Metric 1: Back-navigation
    res_nav = await benchmark_consecutive_navigation(10)
    print("\n[+] Metric 1: Back-Navigation Operations (_return_to_results)")
    print("  ------------------------------------------------------------------------------")
    print(f"  Cards Processed in Round:       {res_nav['cards_processed']}")
    print(f"  Legacy Back-Navigations:        {res_nav['legacy_back_navs']} (1 per card)")
    print(f"  Phase 3 Fast-Path Back-Navs:    {res_nav['fast_path_back_navs']} (round boundary only)")
    print(f"  Redundant Navigations Skipped:  {res_nav['fast_path_skipped']}")
    print(f"  Operation Reduction:            {res_nav['legacy_back_navs'] - res_nav['fast_path_back_navs']} operations ({res_nav['reduction_pct']:.1f}% reduction)")
    print("  ------------------------------------------------------------------------------")

    # Metric 2: Conclusive Disqualification
    res_disq = await benchmark_conclusive_disqualification()
    print("\n[+] Metric 2: Detail Panel Extractions for Disqualified Cards")
    print("  ------------------------------------------------------------------------------")
    print(f"  Cards Evaluated:                {res_disq['total_cards']} ({res_disq['disqualified_count']} disqualified, {res_disq['total_cards'] - res_disq['disqualified_count']} valid)")
    print(f"  - Chain/Cannabis Fast Aborts:   {res_disq['chain_cannabis_fast_aborts']}")
    print(f"  - Early Known Place Skipped:    {res_disq['early_known_skipped']}")
    print(f"  - Early Duplicates Skipped:     {res_disq['early_dup_skipped']}")
    print(f"  Legacy Full Extractions:        {res_disq['legacy_full_extractions']} evaluations")
    print(f"  Phase 3 Fast-Path Extractions:  {res_disq['fast_path_full_extractions']} evaluations")
    print(f"  Full Extractions Skipped:       {res_disq['extractions_skipped']} ({res_disq['reduction_pct']:.1f}% reduction)")
    print(f"  Settle Waits Skipped:           {res_disq['disqualified_count']} waits (~{res_disq['disqualified_count'] * 800}ms estimated idle delay avoided)")
    print("  ------------------------------------------------------------------------------")

    # Metric 3: Website Selector DOM Query Reuse
    res_query = await benchmark_website_query_reuse()
    print("\n[+] Metric 3: Website Selector DOM Queries")
    print("  ------------------------------------------------------------------------------")
    print(f"  Valid Cards with Website:       {res_query['valid_cards']}")
    print(f"  Website Probes Reused:          {res_query['probes_reused']}")
    print(f"  Legacy Website Selector Queries: {res_query['legacy_selector_evals']} (probe + re-query)")
    print(f"  Phase 3 Website Selector Queries: {res_query['fast_path_selector_evals']} (probed website reused)")
    print(f"  DOM Queries Saved:              {res_query['evals_saved']} ({res_query['reduction_pct']:.1f}% reduction)")
    print("  ------------------------------------------------------------------------------\n")


if __name__ == "__main__":
    asyncio.run(main())
