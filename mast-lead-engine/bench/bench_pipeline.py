"""MOCKED pipeline benchmark for the MAST lead engine.

!!! THESE NUMBERS ARE NOT PRODUCTION PERFORMANCE !!!
Everything outside the engine is simulated: the "Maps" provider is an
in-process generator, "websites" are a loopback HTTP server with injected
latency, Instagram (optional) is a sleep, storage is an in-memory list.
What this measures is the ENGINE'S OWN scheduling behaviour (stage barrier,
fan-in, dedup, worker pool, contact secondary-page fetches) under a
controlled latency model. It is useful for A/B comparing a scheduling change
against the same workload, and for counting duplicate work. It says nothing
about Google Maps, real websites, Supabase, pg-boss or Railway.

Usage (from mast-lead-engine/):
    python3 bench/bench_pipeline.py --scenario fast_sites --runs 3
    python3 bench/bench_pipeline.py --list
    python3 bench/bench_pipeline.py --scenario slow_tail --runs 3 --json out.json

Safety: binds only to local sockets, makes no outbound requests, needs no
credentials (SUPABASE_* are deliberately unset so the persistent early-dedup
checker stays disabled), and writes nothing outside a temp dir.
"""
from __future__ import annotations

import argparse
import asyncio
import collections
import http.server
import json
import os
import socketserver
import statistics
import subprocess
import sys
import tempfile
import threading
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

# Never let a benchmark touch real infrastructure.
for _k in ("SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "DATABASE_URL"):
    os.environ.pop(_k, None)

# ---------------------------------------------------------------------------
# Scenario definitions: every knob is explicit so a run is reproducible.
# site_latency_s: per-request latency of the loopback "website".
# slow_every / slow_latency_s: every Nth site is slow (head-of-line probe).
# ig_latency_s: simulated Instagram fetch (None = candidates have no IG url).
# discover_gap_s: simulated pause between Maps candidates (None/0 = instant).
# ---------------------------------------------------------------------------
SCENARIOS = {
    # Engine overhead floor: instant discovery, fast sites, no IG.
    "fast_sites": dict(n=12, target=10, site_latency_s=0.15, slow_every=0,
                       slow_latency_s=0.0, ig_latency_s=None, discover_gap_s=0.0),
    # Head-of-line probe: 1 in 4 sites takes 3s (inside the 8s worker timeout).
    "slow_tail": dict(n=12, target=10, site_latency_s=0.15, slow_every=4,
                      slow_latency_s=3.0, ig_latency_s=None, discover_gap_s=0.0),
    # Website + Instagram both present: do they overlap?
    "with_ig": dict(n=12, target=10, site_latency_s=0.5, slow_every=0,
                    slow_latency_s=0.0, ig_latency_s=1.0, discover_gap_s=0.0),
    # Same as with_ig but discovery paced like ~40 places/min (1.5s apart),
    # to see whether the pipeline keeps up with the producer.
    "paced_discovery": dict(n=12, target=10, site_latency_s=0.5, slow_every=0,
                            slow_latency_s=0.0, ig_latency_s=1.0, discover_gap_s=1.5),
}

HOME_HTML = (b"<html><head><title>Biz</title></head><body>"
             b"<h1>Welcome</h1><a href='/contact'>Contact us</a></body></html>")


def make_server(cfg, counters):
    class Handler(http.server.BaseHTTPRequestHandler):
        def do_GET(self):  # noqa: N802
            host = (self.headers.get("Host") or "").split(":")[0]
            idx = int(host.rsplit(".", 1)[-1]) - 1 if host.startswith("127.0.0.") else 0
            counters["http_total"] += 1
            counters["by_url"][f"{host}{self.path}"] += 1
            lat = cfg["site_latency_s"]
            if cfg["slow_every"] and idx % cfg["slow_every"] == cfg["slow_every"] - 1:
                lat = cfg["slow_latency_s"]
            time.sleep(lat)
            if self.path.startswith("/contact"):
                body = (f"<html><body><p>Reach us: info@bizcafe{idx}.com "
                        f"or +1 555 01{idx:02d}</p></body></html>").encode()
            else:
                body = HOME_HTML
            self.send_response(200)
            self.send_header("Content-Type", "text/html")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *a):  # silence
            pass

    class Srv(socketserver.ThreadingMixIn, http.server.HTTPServer):
        daemon_threads = True

    httpd = Srv(("0.0.0.0", 0), Handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd, httpd.server_address[1]


async def run_once(name: str) -> dict:
    cfg = SCENARIOS[name]
    import service
    from engine.contracts import BusinessCandidate, QualifiedOpportunity, StoredOpportunity

    counters = {"http_total": 0, "by_url": collections.Counter(), "ig_calls": 0,
                "discovered": 0, "persisted": 0}
    httpd, port = make_server(cfg, counters)
    t_disc: list[float] = []
    t0_box = {}

    class FakeProvider:
        def discover(self, request):
            for i in range(cfg["n"]):
                if getattr(request, "should_stop", None) and request.should_stop():
                    return
                counters["discovered"] += 1
                t_disc.append(time.perf_counter() - t0_box["t0"])
                yield BusinessCandidate(
                    pipeline_id=str(uuid.uuid4()), session_id=request.session_id,
                    provider="fake", maps_url=f"https://maps.example.invalid/{uuid.uuid4()}",
                    name=f"Bench Cafe {i}", category="Coffee shop",
                    address=f"{i} Bench St", city=request.city, country=request.country,
                    website=f"http://127.0.0.{i + 1}:{port}/", phone=f"+1-555-01{i:02d}",
                    instagram_url=(f"https://www.instagram.com/benchcafe{i}/"
                                   if cfg["ig_latency_s"] is not None else None),
                    rating=4.5, review_count=42,
                    discovered_at=datetime.now(timezone.utc).isoformat())
                if cfg["discover_gap_s"]:
                    time.sleep(cfg["discover_gap_s"])

    class FakeStorage:
        def persist(self, opp: QualifiedOpportunity):
            counters["persisted"] += 1
            return StoredOpportunity(opportunity_id=str(uuid.uuid4()),
                                     pipeline_id=opp.pipeline_id,
                                     created_at=datetime.now(timezone.utc).isoformat())

    if cfg["ig_latency_s"] is not None:
        from engine.contracts import InstagramIntel
        from workers.instagram_worker import InstagramWorker

        def fake_ig(self, item):
            counters["ig_calls"] += 1
            time.sleep(cfg["ig_latency_s"])
            return InstagramIntel(pipeline_id=item.pipeline_id, profile_reachable=True,
                                  followers=500)
        InstagramWorker.process = fake_ig

    service.GoogleMapsProvider = lambda: FakeProvider()
    service._build_storage_backend = lambda: FakeStorage()

    tmp = tempfile.mkdtemp(prefix="mastbench_")
    t0 = time.perf_counter()
    t0_box["t0"] = t0
    lead_times: list[float] = []
    try:
        async for _lead in service.run_query(
                query="coffee shop", city="Benchville", country="US",
                max_results=cfg["n"], deliver_target=cfg["target"],
                db_path=os.path.join(tmp, "b.db")):
            lead_times.append(time.perf_counter() - t0)
    finally:
        httpd.shutdown()
    total = time.perf_counter() - t0

    summary = getattr(service, "_last_perf_summary", {}) or {}
    dup_urls = {u: c for u, c in counters["by_url"].items() if c > 1}
    return {
        "scenario": name, "label": "MOCKED - not production performance",
        "config": cfg,
        "leads_delivered": len(lead_times),
        "time_to_first_discovered_s": round(t_disc[0], 3) if t_disc else None,
        "time_to_first_lead_s": round(lead_times[0], 3) if lead_times else None,
        "time_to_5th_lead_s": round(lead_times[4], 3) if len(lead_times) > 4 else None,
        "time_to_10th_lead_s": round(lead_times[9], 3) if len(lead_times) > 9 else None,
        "total_s": round(total, 3),
        "leads_per_minute": round(len(lead_times) / total * 60, 1) if total else None,
        "discovered": counters["discovered"], "persisted": counters["persisted"],
        "http_requests_total": counters["http_total"],
        "http_requests_per_site": round(counters["http_total"] / max(1, cfg["n"]), 2),
        "duplicate_url_fetches": sum(c - 1 for c in dup_urls.values()),
        "duplicate_urls": dup_urls,
        "ig_calls": counters["ig_calls"],
        "engine_latency": summary.get("latency"),
        "engine_stage_ms": {k: v for k, v in (summary.get("stages") or {}).items()}
        if isinstance(summary.get("stages"), dict) else None,
        "engine_summary_keys": sorted(summary.keys()),
    }


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--scenario", choices=sorted(SCENARIOS))
    ap.add_argument("--runs", type=int, default=3)
    ap.add_argument("--list", action="store_true")
    ap.add_argument("--json")
    ap.add_argument("--_child", action="store_true", help=argparse.SUPPRESS)
    a = ap.parse_args()
    if a.list:
        for k, v in SCENARIOS.items():
            print(f"{k:16s} {v}")
        return
    if not a.scenario:
        ap.error("--scenario required")
    if a._child:
        import logging
        logging.disable(logging.CRITICAL)
        # Engine writes progress JSON lines to stdout; keep our result on the last line.
        res = asyncio.run(run_once(a.scenario))
        sys.stdout.write("\n__BENCH_RESULT__" + json.dumps(res) + "\n")
        return
    results = []
    for r in range(a.runs):
        p = subprocess.run([sys.executable, __file__, "--scenario", a.scenario, "--_child"],
                           capture_output=True, text=True, timeout=300, cwd=str(ROOT))
        line = next((l for l in p.stdout.splitlines() if l.startswith("__BENCH_RESULT__")), None)
        if not line:
            print("run failed:", p.stderr[-800:])
            continue
        results.append(json.loads(line[len("__BENCH_RESULT__"):]))
    if not results:
        sys.exit(1)

    def stat(key):
        vals = [x[key] for x in results if x.get(key) is not None]
        if not vals:
            return "n/a"
        return f"mean={statistics.mean(vals):.2f} min={min(vals):.2f} max={max(vals):.2f}"
    print(f"\n== {a.scenario} x{len(results)} runs  [MOCKED - not production performance]")
    print("config:", SCENARIOS[a.scenario])
    for k in ("time_to_first_discovered_s", "time_to_first_lead_s", "time_to_5th_lead_s",
              "time_to_10th_lead_s", "total_s", "leads_per_minute"):
        print(f"  {k:28s} {stat(k)}")
    r0 = results[0]
    print(f"  leads_delivered={[x['leads_delivered'] for x in results]} "
          f"discovered={r0['discovered']} persisted={r0['persisted']}")
    print(f"  http_requests_total={[x['http_requests_total'] for x in results]} "
          f"(per site {r0['http_requests_per_site']}), "
          f"duplicate_url_fetches={[x['duplicate_url_fetches'] for x in results]}, "
          f"ig_calls={[x['ig_calls'] for x in results]}")
    if a.json:
        Path(a.json).write_text(json.dumps(results, indent=2))


if __name__ == "__main__":
    main()
