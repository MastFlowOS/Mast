"""
MAST Lead Engine — Post-Optimization Benchmark Suite
====================================================
Compares Baseline (commit 73ecda79baddbc8928f3cad07b22ef22c5a13345)
against Optimized (current working tree with sprint optimizations).

Objectives:
1. Scenario 1: Website Verification + Contact Extraction (homepage re-fetch check)
2. Scenario 2: Multi-location / Shared Domain Candidates (LRU domain cache check)
3. Scenario 3: Phone Extraction and Deduplication ($O(1)$ phone key check)
4. Scenario 4: End-to-End Discovery Pipeline Execution (idle backoff & CPU check)

Runs 1 warm-up + 5 measured trials per scenario, alternating order.
Captures wall time, CPU time, HTTP request counts, cache stats, TTFL, and verifies exact parity.
"""

from __future__ import annotations

import collections
import http.server
import io
import json
import os
import statistics
import subprocess
import sys
import tarfile
import tempfile
import threading
import builtins
import time
from typing import Any, Dict, List, Tuple

def print(*args, **kwargs):
    kwargs["flush"] = True
    builtins.print(*args, **kwargs)

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
OPTIMIZED_ENGINE_DIR = os.path.join(ROOT, "mast-lead-engine")
RUNNER_SCRIPT = os.path.join(OPTIMIZED_ENGINE_DIR, "bench", "bench_post_optimization_runner.py")
BASELINE_COMMIT = "73ecda79baddbc8928f3cad07b22ef22c5a13345"


class BenchmarkMockServer(http.server.ThreadingHTTPServer):
    def __init__(self, addr):
        super().__init__(addr, BenchmarkRequestHandler)
        self.request_log: List[Tuple[str, str, float]] = []
        self.lock = threading.Lock()

    def record_request(self, path: str, user_agent: str):
        with self.lock:
            self.request_log.append((path, user_agent, time.time()))

    def clear_log(self) -> int:
        with self.lock:
            count = len(self.request_log)
            self.request_log.clear()
            return count

    def get_log_count(self) -> int:
        with self.lock:
            return len(self.request_log)


class BenchmarkRequestHandler(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, format, *args):
        pass  # Suppress console logging

    def _send(self, status: int, body: bytes, content_type: str = "text/html; charset=utf-8"):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        # Record request
        self.server.record_request(self.path, self.headers.get("User-Agent", ""))

        # Simulate 15ms network latency
        time.sleep(0.015)

        if self.path.startswith("/s1/biz_"):
            idx_str = self.path.split("/s1/biz_")[-1]
            body = f"""<!DOCTYPE html>
<html>
  <head>
    <title>Scenario 1 Biz {idx_str} Title</title>
    <meta name="description" content="Official Description for Biz {idx_str}">
  </head>
  <body>
    <h1>Biz {idx_str}</h1>
    <a href="mailto:contact@biz{idx_str}.com">Email</a>
    <a href="tel:+1-555-01{int(idx_str):02d}">Phone</a>
    <a href="https://www.instagram.com/biz_{idx_str}/">Instagram</a>
  </body>
</html>""".encode("utf-8")
            self._send(200, body)

        elif self.path.startswith("/s2/franchise_"):
            body = b"""<!DOCTYPE html>
<html>
  <head>
    <title>Franchise Headquarters</title>
    <meta name="description" content="Franchise Headquarters Nationwide">
  </head>
  <body>
    <h1>Franchise HQ</h1>
    <a href="mailto:hq@franchise.com">HQ Email</a>
    <a href="tel:+1-800-555-0100">HQ Phone</a>
  </body>
</html>"""
            self._send(200, body)

        elif self.path.startswith("/s2/broken_chain"):
            self._send(500, b"Internal Server Error")

        elif self.path.startswith("/s4/biz_"):
            idx_str = self.path.split("/s4/biz_")[-1]
            body = f"""<!DOCTYPE html>
<html>
  <head>
    <title>Coffee House {idx_str} Title</title>
    <meta name="description" content="Artisan Espresso in Testville">
  </head>
  <body>
    <h1>Coffee House {idx_str}</h1>
    <a href="mailto:hello@coffeehouse{idx_str}.com">Email</a>
    <a href="tel:+1-555-01{int(idx_str):02d}">Phone</a>
  </body>
</html>""".encode("utf-8")
            self._send(200, body)

        else:
            self._send(404, b"Not Found")


def extract_baseline_engine(target_tmpdir: str) -> str:
    """Extracts pristine mast-lead-engine tree from commit BASELINE_COMMIT without repo changes."""
    buf = subprocess.check_output(
        ["git", "archive", "--format=tar", BASELINE_COMMIT, "mast-lead-engine"],
        cwd=ROOT,
    )
    with tarfile.open(fileobj=io.BytesIO(buf)) as tar:
        tar.extractall(target_tmpdir)
    baseline_dir = os.path.join(target_tmpdir, "mast-lead-engine")
    return baseline_dir


def run_trial(
    scenario: int,
    engine_dir: str,
    server: BenchmarkMockServer,
    version_label: str,
) -> Dict[str, Any]:
    """Runs a single trial in a child Python process."""
    server.clear_log()

    env = os.environ.copy()
    env["BENCH_ENGINE_DIR"] = engine_dir
    env["PYTHONPATH"] = engine_dir
    env["PYTHONIOENCODING"] = "utf-8"

    port = server.server_address[1]

    proc = subprocess.run(
        [sys.executable, RUNNER_SCRIPT, f"--scenario={scenario}", f"--port={port}"],
        env=env,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
    )

    if proc.returncode != 0:
        print(f"Error in {version_label} trial (scenario {scenario}):")
        print("STDERR:\n", proc.stderr)
        print("STDOUT:\n", proc.stdout)
        raise RuntimeError(f"Subprocess failed with exit code {proc.returncode}")

    http_requests = server.get_log_count()

    # Parse JSON result from stdout
    result_data = None
    for line in proc.stdout.splitlines():
        if line.startswith("__BENCH_RESULT__"):
            result_data = json.loads(line[len("__BENCH_RESULT__"):])
            break

    if result_data is None:
        raise ValueError(f"Could not find __BENCH_RESULT__ in stdout:\n{proc.stdout}")

    result_data["http_requests"] = http_requests
    result_data["version"] = version_label
    return result_data


def compare_scenario_metrics(
    scenario_name: str,
    baseline_trials: List[Dict[str, Any]],
    optimized_trials: List[Dict[str, Any]],
) -> Dict[str, Any]:
    """Aggregates metrics and verifies parity across trials."""
    b_wall = [t["elapsed_wall_s"] for t in baseline_trials]
    o_wall = [t["elapsed_wall_s"] for t in optimized_trials]

    b_cpu = [t["elapsed_cpu_s"] for t in baseline_trials]
    o_cpu = [t["elapsed_cpu_s"] for t in optimized_trials]

    b_reqs = [t["http_requests"] for t in baseline_trials]
    o_reqs = [t["http_requests"] for t in optimized_trials]

    summary = {
        "scenario": scenario_name,
        "baseline_wall_median_s": statistics.median(b_wall),
        "optimized_wall_median_s": statistics.median(o_wall),
        "wall_speedup": statistics.median(b_wall) / statistics.median(o_wall) if statistics.median(o_wall) > 0 else 1.0,
        "baseline_cpu_median_s": statistics.median(b_cpu),
        "optimized_cpu_median_s": statistics.median(o_cpu),
        "cpu_reduction_pct": ((statistics.median(b_cpu) - statistics.median(o_cpu)) / statistics.median(b_cpu) * 100.0) if statistics.median(b_cpu) > 0 else 0.0,
        "baseline_requests_median": statistics.median(b_reqs),
        "optimized_requests_median": statistics.median(o_reqs),
        "requests_reduction_pct": ((statistics.median(b_reqs) - statistics.median(o_reqs)) / statistics.median(b_reqs) * 100.0) if statistics.median(b_reqs) > 0 else 0.0,
        "baseline_trials": baseline_trials,
        "optimized_trials": optimized_trials,
    }

    if "ttfl_s" in baseline_trials[0]:
        b_ttfl = [t["ttfl_s"] for t in baseline_trials]
        o_ttfl = [t["ttfl_s"] for t in optimized_trials]
        summary["baseline_ttfl_median_s"] = statistics.median(b_ttfl)
        summary["optimized_ttfl_median_s"] = statistics.median(o_ttfl)

    # Parity verification
    b_results = baseline_trials[0]["results"] if "results" in baseline_trials[0] else baseline_trials[0]["delivered_leads"]
    o_results = optimized_trials[0]["results"] if "results" in optimized_trials[0] else optimized_trials[0]["delivered_leads"]

    parity_ok = True
    discrepancies = []

    if len(b_results) != len(o_results):
        parity_ok = False
        discrepancies.append(f"Result count mismatch: baseline={len(b_results)}, optimized={len(o_results)}")
    else:
        for i, (b_item, o_item) in enumerate(zip(b_results, o_results)):
            for k in b_item:
                if k in ("has_homepage_html",):
                    continue  # Expected architectural addition
                if b_item.get(k) != o_item.get(k):
                    parity_ok = False
                    discrepancies.append(f"Item {i} key '{k}' mismatch: baseline={b_item.get(k)}, optimized={o_item.get(k)}")

    summary["parity_verified"] = parity_ok
    summary["discrepancies"] = discrepancies
    return summary


def main():
    print("=" * 80)
    print("MAST LEAD ENGINE — POST-OPTIMIZATION VERIFICATION BENCHMARK")
    print(f"Baseline Commit:  {BASELINE_COMMIT}")
    print(f"Optimized Build:  Current Working Tree")
    print(f"Test Methodology: 1 warm-up + 5 measured trials per scenario, alternating order")
    print("=" * 80)

    # Start mock server
    server = BenchmarkMockServer(("127.0.0.1", 0))
    server_thread = threading.Thread(target=server.serve_forever, daemon=True)
    server_thread.start()
    port = server.server_address[1]
    print(f"[*] Offline loopback HTTP server active on 127.0.0.1:{port}")

    with tempfile.TemporaryDirectory() as tmpdir:
        print("[*] Extracting pristine baseline engine from git...")
        baseline_dir = extract_baseline_engine(tmpdir)
        print(f"[*] Baseline engine extracted to {baseline_dir}")

        all_summaries = {}

        scenarios = [
            (1, "Scenario 1: Homepage Re-fetch Elimination (Website -> Contact)"),
            (2, "Scenario 2: Multi-Location / Shared Domain LRU Cache"),
            (3, "Scenario 3: Phone Extraction & Deduplication (O(1) Set)"),
            (4, "Scenario 4: End-to-End Pipeline Execution & Idle CPU Backoff"),
        ]

        for s_num, s_name in scenarios:
            print("\n" + "-" * 80)
            print(f"Running {s_name}...")
            print("-" * 80)

            # Warm-up trial (unrecorded)
            print("  [Warm-up trial] Baseline...")
            run_trial(s_num, baseline_dir, server, "Baseline")
            print("  [Warm-up trial] Optimized...")
            run_trial(s_num, OPTIMIZED_ENGINE_DIR, server, "Optimized")

            b_trials = []
            o_trials = []

            for trial_idx in range(1, 6):
                # Alternate execution order to eliminate thermal/OS drift
                if trial_idx % 2 == 1:
                    print(f"  Trial {trial_idx}/5: Baseline -> Optimized")
                    b_res = run_trial(s_num, baseline_dir, server, "Baseline")
                    o_res = run_trial(s_num, OPTIMIZED_ENGINE_DIR, server, "Optimized")
                else:
                    print(f"  Trial {trial_idx}/5: Optimized -> Baseline")
                    o_res = run_trial(s_num, OPTIMIZED_ENGINE_DIR, server, "Optimized")
                    b_res = run_trial(s_num, baseline_dir, server, "Baseline")

                b_trials.append(b_res)
                o_trials.append(o_res)

            summary = compare_scenario_metrics(s_name, b_trials, o_trials)
            all_summaries[s_num] = summary

            # Print quick scenario summary
            print(f"  => Parity Verified: {summary['parity_verified']}")
            if not summary['parity_verified']:
                print(f"     DISCREPANCIES: {summary['discrepancies']}")
            print(f"  => Wall Time (Median): Baseline={summary['baseline_wall_median_s']:.4f}s | Optimized={summary['optimized_wall_median_s']:.4f}s ({summary['wall_speedup']:.2f}x speedup)")
            print(f"  => CPU Time  (Median): Baseline={summary['baseline_cpu_median_s']:.4f}s | Optimized={summary['optimized_cpu_median_s']:.4f}s ({summary['cpu_reduction_pct']:.1f}% reduction)")
            print(f"  => HTTP Reqs (Median): Baseline={summary['baseline_requests_median']} | Optimized={summary['optimized_requests_median']} ({summary['requests_reduction_pct']:.1f}% reduction)")

        server.shutdown()

    # Save detailed JSON results for artifact generation
    results_path = os.path.join(OPTIMIZED_ENGINE_DIR, "bench", "post_optimization_benchmark_results.json")
    with open(results_path, "w", encoding="utf-8") as f:
        json.dump(all_summaries, f, indent=2)
    print(f"\n[*] Full benchmark results saved to {results_path}")


if __name__ == "__main__":
    main()
