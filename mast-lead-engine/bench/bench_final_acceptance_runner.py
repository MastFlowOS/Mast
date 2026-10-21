"""
MAST Lead Engine — Final Performance Acceptance Benchmark Subprocess Runner
===========================================================================
Executes a single benchmark workload in an isolated Python process under
either the historical Baseline (commit 73ecda7) or Optimized (current working tree).
Outputs a clean JSON payload prefixed with __BENCH_RESULT__.
"""

from __future__ import annotations

import argparse
import asyncio
import concurrent.futures
import json
import os
import sys
import tempfile
import time
import tracemalloc
from typing import Any, Dict, List
from unittest.mock import MagicMock

engine_dir = os.environ.get("BENCH_ENGINE_DIR")
if not engine_dir:
    engine_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if engine_dir and engine_dir not in sys.path:
    sys.path.insert(0, engine_dir)

import service
from engine.contracts import BusinessCandidate, QualifiedOpportunity, StoredOpportunity, WebsiteIntel
from workers.website_worker import WebsiteWorker
from workers.contact_worker import ContactWorker


def run_workload1(server_port: int) -> Dict[str, Any]:
    """Workload 1: Unique businesses with mixed contact channels and controlled latency."""
    candidates = [
        BusinessCandidate(
            pipeline_id=f"p-w1-{i}",
            session_id="s-w1",
            provider="test",
            name=f"Unique Biz {i}",
            website=f"http://127.0.0.1:{server_port}/w1/biz_{i}",
            city="Testville",
            country="US",
        )
        for i in range(12)
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
            "title": web_intel.title,
            "has_homepage_html": bool(getattr(web_intel, "homepage_html", None)),
            "emails": sorted(list(contact_intel.emails or [])),
            "phones": sorted(list(contact_intel.phones or [])),
            "instagram_url": contact_intel.instagram_url,
        })

    elapsed_wall = time.perf_counter() - start_wall
    elapsed_cpu = time.process_time() - start_cpu

    return {
        "workload": 1,
        "elapsed_wall_s": elapsed_wall,
        "elapsed_cpu_s": elapsed_cpu,
        "candidate_count": len(candidates),
        "results": results,
    }


def run_workload2(server_port: int) -> Dict[str, Any]:
    """Workload 2: Concurrent identical requests across worker threads (SingleFlight test)."""
    # 16 requests hitting 4 URLs concurrently (4 per URL)
    urls = [
        f"http://127.0.0.1:{server_port}/w2/root_a",
        f"http://127.0.0.1:{server_port}/w2/root_b",
        f"http://127.0.0.1:{server_port}/w2/root_c",
        f"http://127.0.0.1:{server_port}/w2/root_d",
    ]

    candidates = [
        BusinessCandidate(
            pipeline_id=f"p-w2-{url_idx}-{req_idx}",
            session_id="s-w2",
            provider="test",
            name=f"Root Biz {url_idx} Client {req_idx}",
            website=urls[url_idx],
        )
        for url_idx in range(4)
        for req_idx in range(4)
    ]

    worker = WebsiteWorker(timeout=5.0)

    start_cpu = time.process_time()
    start_wall = time.perf_counter()

    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as executor:
        futures = [executor.submit(worker.process, c) for c in candidates]
        intel_results = [f.result() for f in futures]

    elapsed_wall = time.perf_counter() - start_wall
    elapsed_cpu = time.process_time() - start_cpu

    results = [
        {
            "pipeline_id": intel.pipeline_id,
            "website_reachable": intel.website_reachable,
            "title": intel.title,
        }
        for intel in sorted(intel_results, key=lambda x: x.pipeline_id)
    ]

    return {
        "workload": 2,
        "elapsed_wall_s": elapsed_wall,
        "elapsed_cpu_s": elapsed_cpu,
        "candidate_count": len(candidates),
        "results": results,
    }


def run_workload3(server_port: int) -> Dict[str, Any]:
    """Workload 3: Distinct business pages (paths, queries, case sensitivity, trailing slashes)."""
    paths = [
        "/w3/Locations/Chicago",
        "/w3/locations/chicago",
        "/w3/Branch/NYC",
        "/w3/Branch/NYC/",
        "/w3/Search?Item=WidgetA",
        "/w3/Search?item=widgeta",
        "/w3/Dept/Sales",
        "/w3/Dept/Support",
        "/w3/Store/North",
        "/w3/Store/South",
    ]

    candidates = [
        BusinessCandidate(
            pipeline_id=f"p-w3-{i}",
            session_id="s-w3",
            provider="test",
            name=f"Distinct Page Biz {i}",
            website=f"http://127.0.0.1:{server_port}{path}",
        )
        for i, path in enumerate(paths)
    ]

    worker = WebsiteWorker(timeout=5.0)

    start_cpu = time.process_time()
    start_wall = time.perf_counter()

    results = []
    for cand in candidates:
        web_intel = worker.process(cand)
        results.append({
            "pipeline_id": cand.pipeline_id,
            "final_url": web_intel.final_url,
            "title": web_intel.title,
            "website_reachable": web_intel.website_reachable,
        })

    elapsed_wall = time.perf_counter() - start_wall
    elapsed_cpu = time.process_time() - start_cpu

    return {
        "workload": 3,
        "elapsed_wall_s": elapsed_wall,
        "elapsed_cpu_s": elapsed_cpu,
        "candidate_count": len(candidates),
        "results": results,
    }


def run_workload4(server_port: int) -> Dict[str, Any]:
    """Workload 4: Full pipeline execution with secondary page fallbacks & configured stage concurrency."""
    class FakeStorage:
        def __init__(self):
            self.persisted = []
        def persist(self, opp):
            self.persisted.append(opp)
            return StoredOpportunity(
                opportunity_id=f"opp-{opp.pipeline_id}",
                pipeline_id=opp.pipeline_id,
                created_at="2026-10-21T12:00:00Z",
            )

    class FakeProvider:
        def __init__(self, port: int):
            self.port = port
            self.yielded = 0
        def discover(self, req):
            # 16 candidates streamed with controlled 20ms pace
            for i in range(16):
                time.sleep(0.02)
                # Candidates 10 and 11 have no website (triggers qualification rejection)
                has_web = (i not in (10, 11))
                web_url = f"http://127.0.0.1:{self.port}/w4/biz_{i}" if has_web else None
                yield BusinessCandidate(
                    pipeline_id=f"p-w4-{i}",
                    session_id=req.session_id,
                    provider="fake_maps",
                    name=f"Full Pipeline Biz {i}",
                    category="Coffee Shop",
                    address=f"{i * 10} Main St",
                    city=req.city,
                    country=req.country,
                    website=web_url,
                    phone=f"+1-555-01{i:02d}",
                    rating=4.7,
                    review_count=100 + i,
                )
                self.yielded += 1

    service.GoogleMapsProvider = lambda: FakeProvider(server_port)
    service._build_storage_backend = lambda: FakeStorage()
    service._build_batch_intelligence_backend = lambda: MagicMock()

    async def _execute():
        with tempfile.TemporaryDirectory() as tmp:
            delivered = []
            ttfl = None

            tracemalloc.start()
            start_wall = time.perf_counter()
            start_cpu = time.process_time()

            async for lead in service.run_query(
                query="coffee shop",
                city="Testville",
                country="US",
                max_results=15,
                deliver_target=10,
                db_path=os.path.join(tmp, "bench_acceptance.db"),
            ):
                if ttfl is None:
                    ttfl = time.perf_counter() - start_wall
                delivered.append(lead)

            elapsed_wall = time.perf_counter() - start_wall
            elapsed_cpu = time.process_time() - start_cpu
            current_mem, peak_mem = tracemalloc.get_traced_memory()
            tracemalloc.stop()

            leads_per_minute = (len(delivered) / elapsed_wall * 60.0) if elapsed_wall > 0 else 0.0

            return {
                "workload": 4,
                "elapsed_wall_s": elapsed_wall,
                "elapsed_cpu_s": elapsed_cpu,
                "ttfl_s": ttfl or 0.0,
                "peak_memory_kb": peak_mem / 1024.0,
                "delivered_count": len(delivered),
                "leads_per_minute": leads_per_minute,
                "delivered_leads": [
                    {
                        "name": l.get("name"),
                        "phone": l.get("phone"),
                        "email": l.get("email"),
                        "score": l.get("score"),
                        "_pipeline_id": l.get("_pipeline_id"),
                    }
                    for l in delivered
                ],
            }

    return asyncio.run(_execute())


def run_workload5(server_port: int) -> Dict[str, Any]:
    """Workload 5: Failure recovery & transient error handling (429, 500, timeouts, retries)."""
    # 8 candidates with transient errors and retries
    candidates = [
        BusinessCandidate(
            pipeline_id=f"p-w5-{i}",
            session_id="s-w5",
            provider="test",
            name=f"Flaky Biz {i}",
            website=f"http://127.0.0.1:{server_port}/w5/flaky_{i}",
        )
        for i in range(8)
    ]

    website_worker = WebsiteWorker(timeout=5.0)
    contact_worker = ContactWorker(timeout=5.0)

    start_cpu = time.process_time()
    start_wall = time.perf_counter()

    results = []
    # Two passes simulating retry of recoverable items
    for cand in candidates:
        web_intel = website_worker.process(cand)
        # If reachable, process contacts
        if web_intel.website_reachable:
            contact_intel = contact_worker.process(web_intel)
            emails = sorted(list(contact_intel.emails or []))
            phones = sorted(list(contact_intel.phones or []))
        else:
            emails = []
            phones = []

        results.append({
            "pipeline_id": cand.pipeline_id,
            "website_reachable": web_intel.website_reachable,
            "http_status": web_intel.http_status,
            "title": web_intel.title,
            "emails": emails,
            "phones": phones,
        })

    elapsed_wall = time.perf_counter() - start_wall
    elapsed_cpu = time.process_time() - start_cpu

    return {
        "workload": 5,
        "elapsed_wall_s": elapsed_wall,
        "elapsed_cpu_s": elapsed_cpu,
        "candidate_count": len(candidates),
        "results": results,
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--workload", type=int, required=True)
    parser.add_argument("--port", type=int, default=0)
    args = parser.parse_args()

    import logging
    logging.disable(logging.CRITICAL)

    if args.workload == 1:
        res = run_workload1(args.port)
    elif args.workload == 2:
        res = run_workload2(args.port)
    elif args.workload == 3:
        res = run_workload3(args.port)
    elif args.workload == 4:
        res = run_workload4(args.port)
    elif args.workload == 5:
        res = run_workload5(args.port)
    else:
        raise ValueError(f"Unknown workload: {args.workload}")

    print("__BENCH_RESULT__" + json.dumps(res))


if __name__ == "__main__":
    main()
