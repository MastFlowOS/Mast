"""
Validation: service.run_query() driving the real Engine 2.0 production path
=============================================================================

Follows the same convention as validate_execution_driver.py and
validate_fan_in_runtime.py: a standalone script (no pytest), plain
asserts, printed checkpoints, run directly with `python3
validate_service_run_query.py`.

What this validates
--------------------
The *actual* production entrypoint, service.run_query(), end to end:

    service.run_query()
      -> EngineCoordinator.create_session/start_session/mark_running
      -> build_seven_stage_pipeline()          (engine/execution_driver.py)
      -> ExecutionDriver.run_once()             (driven by run_query itself)
      -> Discovery -> Website -> Instagram -> Contact -> Merge
         -> Qualification -> Scoring -> Storage
      -> streamed lead dicts back to the caller

Nothing in engine/, workers/, queues/, providers/, or storage_backends/
is modified, patched, subclassed, or reimplemented here. The ONLY two
things this script substitutes are exactly the two run_query() names
the task calls out as requiring a mock:

    1. service.GoogleMapsProvider   -> _FakeDiscoveryProvider
       (module-level monkeypatch; run_query() looks this name up as a
       global at call time, so this is a test seam, not a code change)
    2. service._build_storage_backend -> returns _FakeStorageBackend()
       instead of a real SupabaseStorageBackend (no env vars / network)

Website, Instagram, and Contact workers are the REAL, unmodified
workers — not mocked. To keep the whole run fully offline without
weakening that (per "no real network access required"), the fake
candidates either carry no website/instagram at all (so those workers
take their documented zero-network "nothing to inspect" path — see
workers/website_worker.py / instagram_worker.py, both explicit that a
missing field means no network call is attempted), or point at a tiny
HTTP server this script binds to 127.0.0.1 itself (loopback only, no
internet, no external dependency) so WebsiteWorker's real urllib fetch
still gets exercised end to end.
"""

from __future__ import annotations

import asyncio
import http.server
import sys
import threading
import time
import uuid
from datetime import datetime, timezone
from typing import Any, Iterator, List

import service
from engine.contracts import BusinessCandidate, QualifiedOpportunity, StoredOpportunity

FAILURES: List[str] = []


def check(label: str, condition: bool, detail: str = "") -> None:
    status = "PASS" if condition else "FAIL"
    print(f"  [{status}] {label}" + (f" — {detail}" if detail and not condition else ""))
    if not condition:
        FAILURES.append(label)


# ---------------------------------------------------------------------------
# Tiny loopback HTTP server — exercises the real WebsiteWorker network path
# without any internet access. Bound to 127.0.0.1, ephemeral port.
# ---------------------------------------------------------------------------
class _Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self) -> None:  # noqa: N802 - stdlib method name
        body = b"<html><head><title>Test Business</title></head><body>hi</body></html>"
        self.send_response(200)
        self.send_header("Content-Type", "text/html")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt: str, *args: Any) -> None:  # silence stdlib logging
        pass


def _start_local_server() -> tuple[http.server.HTTPServer, str]:
    httpd = http.server.HTTPServer(("127.0.0.1", 0), _Handler)
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    port = httpd.server_address[1]
    return httpd, f"http://127.0.0.1:{port}/"


# ---------------------------------------------------------------------------
# Fake Discovery provider — matches DiscoveryProviderInterface.discover()
# ---------------------------------------------------------------------------
class _FakeDiscoveryProvider:
    """
    Drop-in for GoogleMapsProvider. Only this file constructs it, and
    only via monkeypatching service.GoogleMapsProvider (see run() below)
    — engine/interfaces.py's DiscoveryProviderInterface is otherwise
    untouched.
    """

    def __init__(self, reachable_url: str) -> None:
        self._reachable_url = reachable_url
        self.discover_call_count = 0

    def discover(self, request: Any) -> Iterator[BusinessCandidate]:
        self.discover_call_count += 1
        # Per BusinessCandidate's own docstring ("The ONLY object a
        # discovery provider is allowed to create"), the provider is
        # responsible for minting pipeline_id/session_id on each
        # candidate — this mirrors GoogleMapsProvider's real behavior.
        specs = [
            # Two businesses that should qualify: real website (served
            # locally, no internet), a phone number (satisfies
            # QualificationWorker rule 3 - contact method), no Instagram
            # (InstagramWorker's documented zero-network path).
            dict(name="Good Business One", website=self._reachable_url, phone="+1-555-0100"),
            dict(name="Good Business Two", website=self._reachable_url, phone="+1-555-0101"),
            # One business that should be rejected: no website at all
            # (QualificationWorker rule 1) — also takes WebsiteWorker's
            # own zero-network path, so this candidate never touches
            # the network either.
            dict(name="No Website Business", website=None, phone="+1-555-0102"),
        ]
        for spec in specs:
            yield BusinessCandidate(
                pipeline_id=str(uuid.uuid4()),
                session_id=request.session_id,
                provider="fake",
                maps_url=f"https://maps.example.invalid/{uuid.uuid4()}",
                name=spec["name"],
                category="Restaurant",
                address="1 Test St",
                city=request.city,
                country=request.country,
                website=spec["website"],
                phone=spec["phone"],
                rating=4.5,
                review_count=42,
                discovered_at=datetime.now(timezone.utc).isoformat(),
            )


# ---------------------------------------------------------------------------
# Fake Storage backend — matches _StoragePersistenceProtocol.persist()
# ---------------------------------------------------------------------------
class _FakeStorageBackend:
    def __init__(self) -> None:
        self.persisted: List[QualifiedOpportunity] = []

    def persist(self, opportunity: QualifiedOpportunity) -> StoredOpportunity:
        self.persisted.append(opportunity)
        return StoredOpportunity(
            opportunity_id=str(uuid.uuid4()),
            pipeline_id=opportunity.pipeline_id,
            created_at=datetime.now(timezone.utc).isoformat(),
        )


# ---------------------------------------------------------------------------
# Scenario 1: full run to completion (genuine exhaustion, not a target cap)
# ---------------------------------------------------------------------------
async def scenario_full_run() -> None:
    print("\n=== Scenario 1: full run to exhaustion ===")

    httpd, url = _start_local_server()
    provider = _FakeDiscoveryProvider(url)
    backend = _FakeStorageBackend()

    orig_provider_cls = service.GoogleMapsProvider
    orig_build_backend = service._build_storage_backend
    service.GoogleMapsProvider = lambda: provider  # type: ignore[assignment]
    service._build_storage_backend = lambda: backend  # type: ignore[assignment]

    sessions_before = set(service.engine_coordinator._sessions.keys()) if hasattr(
        service.engine_coordinator, "_sessions"
    ) else None

    delivered: List[dict] = []
    try:
        # deliver_target=5 but only 2 of the 3 fake candidates can ever
        # qualify -> this must terminate via genuine exhaustion
        # (_fully_drained()), not by ever reaching the target.
        async for lead in service.run_query(
            query="test query", city="Testville", country="US",
            max_results=10, deliver_target=5, db_path="/tmp/mast_validate_dedup.db",
        ):
            delivered.append(lead)
    finally:
        service.GoogleMapsProvider = orig_provider_cls
        service._build_storage_backend = orig_build_backend
        httpd.shutdown()

    check("discovery invoked exactly once", provider.discover_call_count == 1,
          f"got {provider.discover_call_count}")
    check("exactly 2 leads delivered (the 2 qualifiable candidates)", len(delivered) == 2,
          f"got {len(delivered)}: {[l.get('name') for l in delivered]}")
    names = {l.get("name") for l in delivered}
    check("both qualified businesses present", names == {"Good Business One", "Good Business Two"},
          f"got {names}")
    check("rejected (no-website) business never yielded", "No Website Business" not in names)

    for lead in delivered:
        check(f"{lead.get('name')}: opportunity_id present (Storage ran)",
              bool(lead.get("opportunity_id")))
        check(f"{lead.get('name')}: score attached", lead.get("score") is not None,
              f"score={lead.get('score')!r}")
        check(f"{lead.get('name')}: tier attached", lead.get("tier") is not None)
        check(f"{lead.get('name')}: qualified flag true", lead.get("qualified") is True)
        check(f"{lead.get('name')}: fingerprints computed", "fingerprints" in lead)
        check(f"{lead.get('name')}: is_disqualified computed", "is_disqualified" in lead)

    check("Storage backend received exactly 2 QualifiedOpportunity objects",
          len(backend.persisted) == 2, f"got {len(backend.persisted)}")
    for opp in backend.persisted:
        check(f"opportunity {opp.pipeline_id}: has EnrichedBusiness", opp.business is not None)
        check(f"opportunity {opp.pipeline_id}: has QualificationResult", opp.qualification is not None)
        check(f"opportunity {opp.pipeline_id}: has OpportunityScore (Scoring ran)", opp.score is not None)

    # -- FanInRuntime releases exactly once per business --------------------
    # Every persisted opportunity's pipeline_id must be unique (no business
    # merged/stored twice = fan-in released exactly once each).
    pids = [opp.pipeline_id for opp in backend.persisted]
    check("no duplicate pipeline_ids reached Storage (fan-in released once each)",
          len(pids) == len(set(pids)), f"pids={pids}")

    # -- No session leak: session should be terminal, not left RUNNING ------
    if sessions_before is not None:
        sessions_after = service.engine_coordinator._sessions
        new_session_ids = set(sessions_after.keys()) - sessions_before
        check("exactly one new session created for this run", len(new_session_ids) == 1,
              f"got {new_session_ids}")
        for sid in new_session_ids:
            ctx = sessions_after[sid]
            status = getattr(ctx.session, "status", None)
            status_name = getattr(status, "name", str(status))
            check(f"session {sid} reached a terminal status (no leak)",
                  status_name in ("FINISHED", "COMPLETED", "CANCELLED", "FAILED"),
                  f"status={status_name}")


# ---------------------------------------------------------------------------
# Scenario 2: deliver_target reached before exhaustion (early stop)
# ---------------------------------------------------------------------------
async def scenario_target_reached_early() -> None:
    print("\n=== Scenario 2: deliver_target reached before exhaustion ===")

    httpd, url = _start_local_server()
    provider = _FakeDiscoveryProvider(url)
    backend = _FakeStorageBackend()

    orig_provider_cls = service.GoogleMapsProvider
    orig_build_backend = service._build_storage_backend
    service.GoogleMapsProvider = lambda: provider  # type: ignore[assignment]
    service._build_storage_backend = lambda: backend  # type: ignore[assignment]

    delivered: List[dict] = []
    try:
        async for lead in service.run_query(
            query="test query", city="Testville", country="US",
            max_results=10, deliver_target=1, db_path="/tmp/mast_validate_dedup.db",
        ):
            delivered.append(lead)
    finally:
        service.GoogleMapsProvider = orig_provider_cls
        service._build_storage_backend = orig_build_backend
        httpd.shutdown()

    check("stopped at exactly deliver_target=1", len(delivered) == 1, f"got {len(delivered)}")


# ---------------------------------------------------------------------------
# Scenario 3: cancellation mid-run shuts the driver down cleanly
# ---------------------------------------------------------------------------
async def scenario_cancellation() -> None:
    print("\n=== Scenario 3: cancellation shuts the driver down cleanly ===")

    httpd, url = _start_local_server()
    provider = _FakeDiscoveryProvider(url)
    backend = _FakeStorageBackend()

    orig_provider_cls = service.GoogleMapsProvider
    orig_build_backend = service._build_storage_backend
    service.GoogleMapsProvider = lambda: provider  # type: ignore[assignment]
    service._build_storage_backend = lambda: backend  # type: ignore[assignment]

    async def _consume_then_cancel():
        agen = service.run_query(
            query="test query", city="Testville", country="US",
            max_results=10, deliver_target=5, db_path="/tmp/mast_validate_dedup.db",
        )
        first = await agen.__anext__()
        return agen, first

    task = asyncio.create_task(_consume_then_cancel())
    try:
        agen, first_lead = await asyncio.wait_for(task, timeout=15)
        check("first lead received before cancellation", first_lead is not None)
        # Cancelling the async generator directly (as a real Node-side
        # abort would, e.g. via GeneratorExit from breaking a consuming
        # `async for` loop / task cancellation) must run run_query()'s
        # finally block (driver.stop(), session cleanup) without hanging
        # or raising.
        await asyncio.wait_for(agen.aclose(), timeout=15)
        check("agen.aclose() returned without hanging", True)
    except asyncio.TimeoutError:
        check("agen.aclose() returned without hanging", False, "timed out")
    finally:
        service.GoogleMapsProvider = orig_provider_cls
        service._build_storage_backend = orig_build_backend
        httpd.shutdown()

    # Give the background driver thread (if any survived aclose oddly) a
    # moment, then confirm no non-daemon thread was left behind.
    time.sleep(0.2)
    leaked_threads = [
        t for t in threading.enumerate()
        if t is not threading.main_thread() and not t.daemon and t.is_alive()
        and "mast" in t.name.lower() or "ExecutionDriver" in t.name
    ]
    check("no non-daemon worker threads leaked after cancellation", len(leaked_threads) == 0,
          f"leaked: {[t.name for t in leaked_threads]}")


async def main() -> int:
    await scenario_full_run()
    await scenario_target_reached_early()
    await scenario_cancellation()

    print("\n" + "=" * 60)
    if FAILURES:
        print(f"RESULT: {len(FAILURES)} check(s) FAILED:")
        for f in FAILURES:
            print(f"  - {f}")
        return 1
    print("RESULT: all checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
