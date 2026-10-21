"""
MAST Lead Engine — Post-Optimization Benchmark Subprocess Runner
================================================================
Invoked by bench_post_optimization.py to run a single trial in an isolated
Python process with a specific PYTHONPATH (Baseline or Optimized).
Outputs a JSON object on stdout containing all measured metrics and payloads.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
import tempfile
import time
from typing import Any, Dict, List
from unittest.mock import MagicMock

# Ensure the targeted mast-lead-engine is on sys.path
engine_dir = os.environ.get("BENCH_ENGINE_DIR")
if not engine_dir:
    engine_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if engine_dir and engine_dir not in sys.path:
    sys.path.insert(0, engine_dir)

import service
from engine.contracts import BusinessCandidate, QualifiedOpportunity, StoredOpportunity, WebsiteIntel
from workers.website_worker import WebsiteWorker
from workers.contact_worker import ContactWorker


def run_scenario1(server_port: int) -> Dict[str, Any]:
    """Scenario 1: Website Verification + Contact Extraction (homepage re-fetch check)."""
    # Create 10 distinct candidates
    candidates = [
        BusinessCandidate(
            pipeline_id=f"p-s1-{i}",
            session_id="s-s1",
            provider="test",
            name=f"Scenario 1 Biz {i}",
            website=f"http://127.0.0.1:{server_port}/s1/biz_{i}",
            city="Testville",
            country="US",
        )
        for i in range(10)
    ]

    website_worker = WebsiteWorker(timeout=5.0)
    contact_worker = ContactWorker(timeout=5.0)

    start_cpu = time.process_time()
    start_wall = time.perf_counter()

    results = []
    for cand in candidates:
        web_intel = website_worker.process(cand)
        contact_intel = contact_worker.process(web_intel)
        results.append({
            "pipeline_id": cand.pipeline_id,
            "website_reachable": web_intel.website_reachable,
            "final_url": web_intel.final_url,
            "title": web_intel.title,
            "has_homepage_html": bool(getattr(web_intel, "homepage_html", None)),
            "emails": sorted(list(contact_intel.emails)),
            "phones": sorted(list(contact_intel.phones)),
            "instagram_url": contact_intel.instagram_url,
        })

    elapsed_wall = time.perf_counter() - start_wall
    elapsed_cpu = time.process_time() - start_cpu

    return {
        "scenario": 1,
        "elapsed_wall_s": elapsed_wall,
        "elapsed_cpu_s": elapsed_cpu,
        "candidate_count": len(candidates),
        "results": results,
    }


def run_scenario2(server_port: int) -> Dict[str, Any]:
    """Scenario 2: Multi-location / Shared Domain Candidates (LRU cache check)."""
    # 20 candidates across 4 domains (5 locations each)
    domains = [
        f"http://127.0.0.1:{server_port}/s2/franchise_alpha",
        f"http://127.0.0.1:{server_port}/s2/franchise_beta",
        f"http://127.0.0.1:{server_port}/s2/franchise_gamma",
        f"http://127.0.0.1:{server_port}/s2/broken_chain",
    ]

    candidates = []
    for d_idx, domain in enumerate(domains):
        for loc in range(5):
            idx = d_idx * 5 + loc
            candidates.append(
                BusinessCandidate(
                    pipeline_id=f"p-s2-{idx}",
                    session_id="s-s2",
                    provider="test",
                    name=f"Chain {d_idx} Location {loc}",
                    website=domain,
                    address=f"{loc * 100} Market St",
                    city="Testville",
                    country="US",
                )
            )

    # Clear cache if worker supports it
    if hasattr(WebsiteWorker, "clear_cache"):
        WebsiteWorker.clear_cache()

    website_worker = WebsiteWorker(timeout=5.0)

    start_cpu = time.process_time()
    start_wall = time.perf_counter()

    results = []
    for cand in candidates:
        web_intel = website_worker.process(cand)
        results.append({
            "pipeline_id": web_intel.pipeline_id,
            "website_reachable": web_intel.website_reachable,
            "final_url": web_intel.final_url,
            "title": web_intel.title,
            "http_status": web_intel.http_status,
        })

    elapsed_wall = time.perf_counter() - start_wall
    elapsed_cpu = time.process_time() - start_cpu

    cache_size = len(getattr(WebsiteWorker, "_domain_cache", {})) if hasattr(WebsiteWorker, "_domain_cache") else 0

    return {
        "scenario": 2,
        "elapsed_wall_s": elapsed_wall,
        "elapsed_cpu_s": elapsed_cpu,
        "candidate_count": len(candidates),
        "cache_size": cache_size,
        "results": results,
    }


def run_scenario3() -> Dict[str, Any]:
    """Scenario 3: Phone Extraction and Deduplication across 50 complex HTML documents."""
    # Generate 50 complex HTML documents with mixed phone formats and duplicate representations
    test_htmls = []
    for doc_idx in range(50):
        # 15 phone occurrences, some duplicates of the same 10 digits
        html = f"""
        <!DOCTYPE html>
        <html>
          <head><title>Doc {doc_idx}</title></head>
          <body>
            <div>
              <a href="tel:+1 (555) 010-{doc_idx:02d}">Primary Tel</a>
              <a href="tel:555.010.{doc_idx:02d}">Same Phone Dot Format</a>
              <a href="tel:+1555010{doc_idx:02d}">Same Phone E164</a>
              <span aria-label="Call +1-555-019-{doc_idx:02d}">Secondary Phone</span>
              <p>Text phone: (555) 018-{doc_idx:02d} or 555-018-{doc_idx:02d}</p>
              <script type="application/ld+json">
              {{
                "@context": "https://schema.org",
                "@type": "LocalBusiness",
                "telephone": "+1-555-017-{doc_idx:02d}"
              }}
              </script>
              <a href="tel:+1-800-555-0199">Toll Free</a>
              <a href="tel:800.555.0199">Toll Free Duplicate</a>
            </div>
          </body>
        </html>
        """
        test_htmls.append(html)

    start_cpu = time.process_time()
    start_wall = time.perf_counter()

    results = []
    for idx, html in enumerate(test_htmls):
        emails: Dict[str, str] = {}
        phones: Dict[str, str] = {}
        ContactWorker._extract_page_contact_data(
            html=html,
            page_url=f"https://doc{idx}.com",
            page_role="homepage",
            emails=emails,
            phones=phones,
        )
        results.append({
            "doc_idx": idx,
            "phone_count": len(phones),
            "phone_keys": sorted(list(phones.keys())),
        })

    elapsed_wall = time.perf_counter() - start_wall
    elapsed_cpu = time.process_time() - start_cpu

    return {
        "scenario": 3,
        "elapsed_wall_s": elapsed_wall,
        "elapsed_cpu_s": elapsed_cpu,
        "doc_count": len(test_htmls),
        "results": results,
    }


def run_scenario4(server_port: int) -> Dict[str, Any]:
    """Scenario 4: End-to-End Discovery Pipeline Execution with Controlled I/O Delays."""
    class FakeStorage:
        def __init__(self):
            self.persisted = []
        def store_opportunity(self, opp):
            self.persisted.append(opp)
            return MagicMock(id=f"opp-{len(self.persisted)}", pipeline_id=opp.pipeline_id)

    class FakeProvider:
        def __init__(self, port: int):
            self.port = port
            self.yielded = 0
        def discover(self, req):
            # 25 candidates, paced at 25ms
            for i in range(25):
                time.sleep(0.025)
                # Some candidates have no website or missing phone to test qualification
                has_web = (i % 7 != 0)
                web_url = f"http://127.0.0.1:{self.port}/s4/biz_{i}" if has_web else None
                yield BusinessCandidate(
                    pipeline_id=f"p-s4-{i}",
                    session_id=req.session_id,
                    provider="fake_maps",
                    name=f"Coffee House {i}",
                    category="Coffee Shop",
                    address=f"{i * 12} Espresso Blvd",
                    city=req.city,
                    country=req.country,
                    website=web_url,
                    phone=f"+1-555-01{i:02d}",
                    rating=4.6,
                    review_count=80 + i,
                )
                self.yielded += 1

    service.GoogleMapsProvider = lambda: FakeProvider(server_port)
    service._build_storage_backend = lambda: FakeStorage()
    service._build_batch_intelligence_backend = lambda: MagicMock()

    async def _execute():
        with tempfile.TemporaryDirectory() as tmp:
            delivered = []
            ttfl = None
            start_wall = time.perf_counter()
            start_cpu = time.process_time()

            async for lead in service.run_query(
                query="coffee shop",
                city="Testville",
                country="US",
                max_results=20,
                deliver_target=10,
                db_path=os.path.join(tmp, "bench_leads.db"),
            ):
                if ttfl is None:
                    ttfl = time.perf_counter() - start_wall
                delivered.append(lead)

            elapsed_wall = time.perf_counter() - start_wall
            elapsed_cpu = time.process_time() - start_cpu

            return {
                "scenario": 4,
                "elapsed_wall_s": elapsed_wall,
                "elapsed_cpu_s": elapsed_cpu,
                "ttfl_s": ttfl or 0.0,
                "delivered_count": len(delivered),
                "delivered_leads": [
                    {
                        "name": l.get("name"),
                        "phone": l.get("phone"),
                        "email": l.get("email"),
                        "score": l.get("score"),
                        "fingerprints": l.get("fingerprints"),
                        "_pipeline_id": l.get("_pipeline_id"),
                    }
                    for l in delivered
                ],
            }

    return asyncio.run(_execute())


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--scenario", type=int, required=True)
    parser.add_argument("--port", type=int, default=0)
    args = parser.parse_args()

    # Suppress internal engine logging for clean benchmark stdout
    import logging
    logging.disable(logging.CRITICAL)

    if args.scenario == 1:
        res = run_scenario1(args.port)
    elif args.scenario == 2:
        res = run_scenario2(args.port)
    elif args.scenario == 3:
        res = run_scenario3()
    elif args.scenario == 4:
        res = run_scenario4(args.port)
    else:
        raise ValueError(f"Unknown scenario: {args.scenario}")

    # Print JSON line with prefix for harness parsing
    print("__BENCH_RESULT__" + json.dumps(res))


if __name__ == "__main__":
    main()
