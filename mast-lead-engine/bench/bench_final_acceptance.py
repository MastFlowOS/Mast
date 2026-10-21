"""
MAST Lead Engine — Final Performance Acceptance Benchmark Suite
================================================================
Compares Baseline (commit 73ecda79baddbc8928f3cad07b22ef22c5a13345)
against Optimized (current local working tree with all capabilities and fixes).

Workloads:
1. Unique businesses: 12 candidates with different URLs, mixed contact availability, controlled latency.
2. Concurrent identical requests: 16 concurrent requests across workers hitting 4 equivalent URLs simultaneously.
3. Distinct business pages: 10 candidates with case-sensitive paths, trailing slashes, and distinct query strings.
4. Mixed website/contact full-pipeline workload: 10 delivered leads, secondary-page fallbacks, stage concurrency.
5. Failure recovery: Transient HTTP 429/500, timeouts, retries, and permanent failure resilience.

Runs 1 warm-up + 5 measured trials per comparison. Runs entirely offline.
Outputs comprehensive metrics and outputs results to final_acceptance_benchmark_results.json.
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
import time
from typing import Any, Dict, List, Tuple

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
OPTIMIZED_ENGINE_DIR = os.path.join(ROOT, "mast-lead-engine")
RUNNER_SCRIPT = os.path.join(OPTIMIZED_ENGINE_DIR, "bench", "bench_final_acceptance_runner.py")
BASELINE_COMMIT = "73ecda79baddbc8928f3cad07b22ef22c5a13345"


class AcceptanceMockServer(http.server.ThreadingHTTPServer):
    def __init__(self, addr):
        super().__init__(addr, AcceptanceRequestHandler)
        self.request_log: List[Tuple[str, str, float]] = []
        self.flaky_attempts: Dict[str, int] = collections.defaultdict(int)
        self.lock = threading.Lock()

    def record_request(self, path: str, user_agent: str) -> int:
        with self.lock:
            self.request_log.append((path, user_agent, time.time()))
            self.flaky_attempts[path] += 1
            return self.flaky_attempts[path]

    def clear_state(self) -> int:
        with self.lock:
            count = len(self.request_log)
            self.request_log.clear()
            self.flaky_attempts.clear()
            return count

    def get_request_count(self) -> int:
        with self.lock:
            return len(self.request_log)


class AcceptanceRequestHandler(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, format, *args):
        pass

    def _send(self, status: int, body: bytes, content_type: str = "text/html; charset=utf-8"):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        attempt = self.server.record_request(self.path, self.headers.get("User-Agent", ""))

        # Workload 1: Unique businesses
        if self.path.startswith("/w1/biz_"):
            time.sleep(0.015)
            idx = int(self.path.split("/w1/biz_")[-1])
            # Mixed contact channels
            email_tag = f'<a href="mailto:contact@biz{idx}.com">Email</a>' if idx < 8 or idx >= 10 else ""
            phone_tag = f'<a href="tel:+1-555-01{idx:02d}">Phone</a>' if idx < 10 else ""
            ig_tag = f'<a href="https://www.instagram.com/biz_{idx}/">Instagram</a>' if idx < 4 else ""

            body = f"""<!DOCTYPE html>
<html>
  <head><title>Unique Biz {idx} Official Site</title></head>
  <body>
    <h1>Biz {idx}</h1>
    {email_tag}
    {phone_tag}
    {ig_tag}
  </body>
</html>""".encode("utf-8")
            self._send(200, body)
            return

        # Workload 2: Concurrent identical roots
        if self.path.startswith("/w2/root_"):
            time.sleep(0.025)
            name = self.path.split("/w2/")[-1]
            body = f"""<!DOCTYPE html>
<html>
  <head><title>Root {name.upper()}</title></head>
  <body><p>Welcome to {name}</p></body>
</html>""".encode("utf-8")
            self._send(200, body)
            return

        # Workload 3: Distinct pages
        if self.path.startswith("/w3/"):
            time.sleep(0.010)
            clean_path = self.path[len("/w3/"):]
            body = f"""<!DOCTYPE html>
<html>
  <head><title>Page: {clean_path}</title></head>
  <body>Content for {clean_path}</body>
</html>""".encode("utf-8")
            self._send(200, body)
            return

        # Workload 4: Mixed pipeline & secondary page fallbacks
        if self.path.startswith("/w4/biz_"):
            time.sleep(0.015)
            idx = int(self.path.split("/w4/biz_")[-1])
            if 4 <= idx <= 7:
                # Incomplete homepage: has email and contact page link, missing phone
                body = f"""<!DOCTYPE html>
<html>
  <head><title>Pipeline Biz {idx}</title></head>
  <body>
    <a href="mailto:info@pipeline{idx}.com">Email</a>
    <a href="/w4/contact_{idx}">Contact Page</a>
  </body>
</html>""".encode("utf-8")
            else:
                # Complete homepage
                body = f"""<!DOCTYPE html>
<html>
  <head><title>Pipeline Biz {idx}</title></head>
  <body>
    <a href="mailto:info@pipeline{idx}.com">Email</a>
    <a href="tel:+1-555-01{idx:02d}">Phone</a>
    <a href="https://www.instagram.com/pipeline_{idx}/">Instagram</a>
  </body>
</html>""".encode("utf-8")
            self._send(200, body)
            return

        if self.path.startswith("/w4/contact_"):
            time.sleep(0.015)
            idx = int(self.path.split("/w4/contact_")[-1])
            body = f"""<!DOCTYPE html>
<html>
  <head><title>Contact Secondary Page {idx}</title></head>
  <body>
    <a href="tel:+1-555-01{idx:02d}">Direct Phone</a>
  </body>
</html>""".encode("utf-8")
            self._send(200, body)
            return

        # Workload 5: Failure recovery & transient errors
        if self.path.startswith("/w5/flaky_"):
            idx = int(self.path.split("/w5/flaky_")[-1])
            if idx in (0, 1):
                # 429 Too Many Requests on attempt 1, 200 OK on attempt 2+
                if attempt == 1:
                    self._send(429, b"Too Many Requests (Rate Limited)")
                    return
            elif idx in (2, 3):
                # 500 Internal Server Error on attempt 1, 200 OK on attempt 2+
                if attempt == 1:
                    self._send(500, b"Internal Server Error")
                    return
            elif idx in (4, 5):
                # Socket timeout on attempt 1
                if attempt == 1:
                    time.sleep(0.20)
                    # Close connection abruptly without response
                    self.close_connection = True
                    return
            elif idx in (6, 7):
                # Permanent 404
                self._send(404, b"Not Found")
                return

            time.sleep(0.015)
            body = f"""<!DOCTYPE html>
<html>
  <head><title>Recovered Flaky Biz {idx}</title></head>
  <body>
    <a href="mailto:recovered@flaky{idx}.com">Email</a>
    <a href="tel:+1-555-09{idx:02d}">Phone</a>
  </body>
</html>""".encode("utf-8")
            self._send(200, body)
            return

        self._send(404, b"Not Found")


def extract_baseline_engine(tmpdir: str) -> str:
    """Extract historical baseline commit without switching branches."""
    archive_proc = subprocess.run(
        ["git", "archive", "--format=tar", BASELINE_COMMIT, "mast-lead-engine"],
        cwd=ROOT,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=True,
    )
    tar_stream = io.BytesIO(archive_proc.stdout)
    with tarfile.open(fileobj=tar_stream, mode="r:") as tf:
        tf.extractall(path=tmpdir)
    return os.path.join(tmpdir, "mast-lead-engine")


def run_trial(
    workload_num: int,
    engine_path: str,
    server: AcceptanceMockServer,
    label: str,
) -> Dict[str, Any]:
    """Execute one trial in a clean, isolated subprocess."""
    server.clear_state()
    env = os.environ.copy()
    env["BENCH_ENGINE_DIR"] = engine_path
    env["PYTHONPATH"] = engine_path

    cmd = [
        sys.executable,
        RUNNER_SCRIPT,
        "--workload", str(workload_num),
        "--port", str(server.server_address[1]),
    ]

    proc = subprocess.run(
        cmd,
        cwd=ROOT,
        env=env,
        capture_output=True,
        text=True,
    )

    if proc.returncode != 0:
        print(f"ERROR in runner for {label}:\nSTDOUT:\n{proc.stdout}\nSTDERR:\n{proc.stderr}")
        sys.exit(1)

    req_count = server.get_request_count()

    bench_line = None
    for line in proc.stdout.splitlines():
        if line.startswith("__BENCH_RESULT__"):
            bench_line = line[len("__BENCH_RESULT__"):]
            break

    if not bench_line:
        print(f"ERROR stdout:\n{proc.stdout}")
        print(f"ERROR stderr:\n{proc.stderr}")
        raise RuntimeError(f"Subprocess failed to output __BENCH_RESULT__ for {label}")

    data = json.loads(bench_line)
    data["http_requests"] = req_count
    data["label"] = label
    return data


def compare_workload(
    name: str,
    baseline_trials: List[Dict[str, Any]],
    optimized_trials: List[Dict[str, Any]],
) -> Dict[str, Any]:
    """Compare baseline and optimized trials for a workload."""
    b_wall = [t["elapsed_wall_s"] for t in baseline_trials]
    o_wall = [t["elapsed_wall_s"] for t in optimized_trials]

    b_cpu = [t["elapsed_cpu_s"] for t in baseline_trials]
    o_cpu = [t["elapsed_cpu_s"] for t in optimized_trials]

    b_reqs = [t["http_requests"] for t in baseline_trials]
    o_reqs = [t["http_requests"] for t in optimized_trials]

    med_b_wall = statistics.median(b_wall)
    med_o_wall = statistics.median(o_wall)
    speedup = med_b_wall / med_o_wall if med_o_wall > 0 else 1.0

    med_b_cpu = statistics.median(b_cpu)
    med_o_cpu = statistics.median(o_cpu)
    cpu_reduction = ((med_b_cpu - med_o_cpu) / med_b_cpu * 100.0) if med_b_cpu > 0 else 0.0

    med_b_req = statistics.median(b_reqs)
    med_o_req = statistics.median(o_reqs)
    req_avoided = med_b_req - med_o_req
    req_reduction = (req_avoided / med_b_req * 100.0) if med_b_req > 0 else 0.0

    summary = {
        "workload_name": name,
        "baseline_wall_median_s": med_b_wall,
        "optimized_wall_median_s": med_o_wall,
        "speedup_factor": speedup,
        "baseline_cpu_median_s": med_b_cpu,
        "optimized_cpu_median_s": med_o_cpu,
        "cpu_reduction_pct": cpu_reduction,
        "baseline_http_requests_median": med_b_req,
        "optimized_http_requests_median": med_o_req,
        "duplicate_requests_avoided": max(0, req_avoided),
        "request_reduction_pct": req_reduction,
    }

    if "leads_per_minute" in baseline_trials[0]:
        b_lpm = [t["leads_per_minute"] for t in baseline_trials]
        o_lpm = [t["leads_per_minute"] for t in optimized_trials]
        summary["baseline_leads_per_min_median"] = statistics.median(b_lpm)
        summary["optimized_leads_per_min_median"] = statistics.median(o_lpm)
        summary["throughput_improvement_factor"] = (
            statistics.median(o_lpm) / statistics.median(b_lpm) if statistics.median(b_lpm) > 0 else 1.0
        )

    if "ttfl_s" in baseline_trials[0]:
        b_ttfl = [t["ttfl_s"] for t in baseline_trials]
        o_ttfl = [t["ttfl_s"] for t in optimized_trials]
        summary["baseline_ttfl_median_s"] = statistics.median(b_ttfl)
        summary["optimized_ttfl_median_s"] = statistics.median(o_ttfl)

    if "peak_memory_kb" in optimized_trials[0]:
        o_mem = [t["peak_memory_kb"] for t in optimized_trials]
        summary["optimized_peak_memory_kb"] = statistics.median(o_mem)

    # Parity verification
    b_key = "delivered_leads" if "delivered_leads" in baseline_trials[0] else "results"
    o_key = "delivered_leads" if "delivered_leads" in optimized_trials[0] else "results"

    b_res = baseline_trials[0][b_key]
    o_res = optimized_trials[0][o_key]

    parity_ok = True
    discrepancies = []

    if len(b_res) != len(o_res):
        parity_ok = False
        discrepancies.append(f"Result count mismatch: baseline={len(b_res)}, optimized={len(o_res)}")
    else:
        for i, (b_item, o_item) in enumerate(zip(b_res, o_res)):
            for k in b_item:
                if k in ("has_homepage_html",):
                    continue  # Architectural addition
                if b_item.get(k) != o_item.get(k):
                    parity_ok = False
                    discrepancies.append(f"Item {i} key '{k}' mismatch: baseline={b_item.get(k)}, optimized={o_item.get(k)}")

    summary["parity_verified"] = parity_ok
    summary["discrepancies"] = discrepancies
    summary["delivered_count"] = len(o_res)
    return summary


def main():
    print("=" * 80)
    print("MAST LEAD ENGINE — FINAL PERFORMANCE ACCEPTANCE BENCHMARK")
    print(f"Baseline Commit:  {BASELINE_COMMIT}")
    print(f"Optimized Build:  Current Local Working Tree")
    print(f"Test Methodology: 1 warm-up + 5 measured trials per comparison, alternating order")
    print(f"Environment:      Offline loopback execution (no cloud/remote calls)")
    print("=" * 80)

    server = AcceptanceMockServer(("127.0.0.1", 0))
    server_thread = threading.Thread(target=server.serve_forever, daemon=True)
    server_thread.start()
    port = server.server_address[1]
    print(f"[*] Offline loopback HTTP server active on 127.0.0.1:{port}")

    with tempfile.TemporaryDirectory() as tmpdir:
        print("[*] Extracting pristine baseline engine from git...")
        baseline_dir = extract_baseline_engine(tmpdir)
        print(f"[*] Baseline engine extracted to {baseline_dir}")

        workloads = [
            (1, "Workload 1: Unique Businesses (Homepage HTML Reuse)"),
            (2, "Workload 2: Concurrent Identical Requests (SingleFlight Collapse)"),
            (3, "Workload 3: Distinct Business Pages (Canonicalization Distinctness)"),
            (4, "Workload 4: Full Pipeline Execution (Secondary Fallback & Concurrency)"),
            (5, "Workload 5: Failure Recovery & Transient Error Handling"),
        ]

        all_summaries = {}

        for w_num, w_name in workloads:
            print("\n" + "-" * 80)
            print(f"Executing {w_name}...")
            print("-" * 80)

            # Warm-up (1 trial, unrecorded)
            print("  [Warm-up] Baseline...")
            run_trial(w_num, baseline_dir, server, "Baseline")
            print("  [Warm-up] Optimized...")
            run_trial(w_num, OPTIMIZED_ENGINE_DIR, server, "Optimized")

            # 5 Measured trials, alternating order
            b_trials = []
            o_trials = []

            for trial_idx in range(1, 6):
                if trial_idx % 2 == 1:
                    print(f"  [Trial {trial_idx}/5] Baseline -> Optimized...")
                    bt = run_trial(w_num, baseline_dir, server, "Baseline")
                    ot = run_trial(w_num, OPTIMIZED_ENGINE_DIR, server, "Optimized")
                else:
                    print(f"  [Trial {trial_idx}/5] Optimized -> Baseline...")
                    ot = run_trial(w_num, OPTIMIZED_ENGINE_DIR, server, "Optimized")
                    bt = run_trial(w_num, baseline_dir, server, "Baseline")

                b_trials.append(bt)
                o_trials.append(ot)
                print(f"    Baseline:  wall={bt['elapsed_wall_s']:.3f}s, cpu={bt['elapsed_cpu_s']:.3f}s, reqs={bt['http_requests']}")
                print(f"    Optimized: wall={ot['elapsed_wall_s']:.3f}s, cpu={ot['elapsed_cpu_s']:.3f}s, reqs={ot['http_requests']}")

            summary = compare_workload(w_name, b_trials, o_trials)
            all_summaries[f"workload_{w_num}"] = summary

            print(f"\n  Summary for {w_name}:")
            print(f"    Median Wall-Clock:  Baseline={summary['baseline_wall_median_s']:.3f}s -> Optimized={summary['optimized_wall_median_s']:.3f}s (Speedup: {summary['speedup_factor']:.2f}x)")
            print(f"    Median CPU Time:    Baseline={summary['baseline_cpu_median_s']:.3f}s -> Optimized={summary['optimized_cpu_median_s']:.3f}s ({summary['cpu_reduction_pct']:.1f}% reduction)")
            print(f"    HTTP Requests:      Baseline={summary['baseline_http_requests_median']} -> Optimized={summary['optimized_http_requests_median']} (Avoided: {summary['duplicate_requests_avoided']:.0f})")
            if "throughput_improvement_factor" in summary:
                print(f"    Qualified Leads/Min: Baseline={summary['baseline_leads_per_min_median']:.1f} -> Optimized={summary['optimized_leads_per_min_median']:.1f} ({summary['throughput_improvement_factor']:.2f}x)")
                print(f"    Median TTFL:        Baseline={summary['baseline_ttfl_median_s']:.3f}s -> Optimized={summary['optimized_ttfl_median_s']:.3f}s")
            print(f"    Parity Verified:    {'YES (100% Match)' if summary['parity_verified'] else 'FAILED: ' + str(summary['discrepancies'])}")

        output_path = os.path.join(OPTIMIZED_ENGINE_DIR, "bench", "final_acceptance_benchmark_results.json")
        with open(output_path, "w", encoding="utf-8") as f:
            json.dump(all_summaries, f, indent=2)
        print("\n" + "=" * 80)
        print(f"[*] Benchmark complete! Results saved to {output_path}")
        print("=" * 80)

    server.shutdown()


if __name__ == "__main__":
    main()
