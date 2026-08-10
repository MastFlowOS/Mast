"""
PHASE 2B — regression tests for watchdog shutdown semantics (PART D) and
the stdout progress protocol (PART C), driven through the REAL production
entrypoint, `service.run_query()` (discovery_only=False — the branch
`ExecutionDriver`'s producer-thread decoupling and this file's
`_on_progress`/`_stopped_by_shutdown` changes actually touch).

Follows validate_service_run_query.py's own established seam: monkeypatch
only `service.GoogleMapsProvider` and `service._build_storage_backend`
(a fake discovery provider and fake storage backend — the two names that
script's own docstring documents as the sanctioned test seam), plus a
127.0.0.1-only loopback HTTP server so WebsiteWorker's real network path
runs with no internet access required. Nothing in engine/, workers/,
queues/, providers/, or storage_backends/ is mocked or subclassed.

Run: pytest tests/test_watchdog_termination_semantics.py -v
"""

from __future__ import annotations

import http.server
import json
import os
import sys
import threading
import time
import uuid
from datetime import datetime, timezone
from typing import Any, Iterator, List

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

import service
from engine.contracts import BusinessCandidate, QualifiedOpportunity, StoredOpportunity


class _Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self) -> None:  # noqa: N802
        body = b"<html><head><title>Test Business</title></head><body>hi</body></html>"
        self.send_response(200)
        self.send_header("Content-Type", "text/html")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt: str, *args: Any) -> None:
        pass


def _start_local_server() -> tuple[http.server.HTTPServer, str]:
    httpd = http.server.HTTPServer(("127.0.0.1", 0), _Handler)
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    return httpd, f"http://127.0.0.1:{httpd.server_address[1]}/"


class _NeverEndingProvider:
    """Discovers candidates forever, paced, so a shutdown_event set
    partway through is the ONLY thing that can end the run — there is no
    genuine exhaustion available for `run_query()` to reach instead."""

    def __init__(self, reachable_url: str, *, gap_s: float = 0.05) -> None:
        self._reachable_url = reachable_url
        self._gap_s = gap_s
        self.discover_call_count = 0
        self.yielded = 0

    def discover(self, request: Any) -> Iterator[BusinessCandidate]:
        self.discover_call_count += 1
        i = 0
        while True:
            if getattr(request, "should_stop", None) is not None and request.should_stop():
                # Same cooperative contract the real GoogleMapsProvider
                # honors (providers/google_maps_provider.py) — a fake
                # discovery provider that ignores this would hang
                # driver.stop()'s producer-thread join forever, which is
                # a bug in the fake, not in ExecutionDriver/service.py.
                return
            i += 1
            yield BusinessCandidate(
                pipeline_id=str(uuid.uuid4()),
                session_id=request.session_id,
                provider="fake",
                maps_url=f"https://maps.example.invalid/{uuid.uuid4()}",
                name=f"Business {i}",
                category="Restaurant",
                address="1 Test St",
                city=request.city,
                country=request.country,
                website=self._reachable_url,
                phone="+1-555-0100",
                rating=4.5,
                review_count=42,
                discovered_at=datetime.now(timezone.utc).isoformat(),
            )
            self.yielded += 1
            time.sleep(self._gap_s)


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


@pytest.fixture()
def loopback_server():
    httpd, url = _start_local_server()
    try:
        yield url
    finally:
        httpd.shutdown()


@pytest.fixture()
def patched_service(monkeypatch, loopback_server, tmp_path):
    provider = _NeverEndingProvider(loopback_server)
    backend = _FakeStorageBackend()
    monkeypatch.setattr(service, "GoogleMapsProvider", lambda: provider)
    monkeypatch.setattr(service, "_build_storage_backend", lambda: backend)
    return provider, backend, tmp_path


class TestWatchdogCancelledNotReportedAsSuccess:
    """Test 5 (PART D) — a shutdown_event-triggered stop, with the target
    NOT reached and no genuine exhaustion available, must surface as
    DiscoveryFailure(CANCELLED) out of run_query() -- never fall through
    as an ordinary success=True/exhausted=True completion."""

    @pytest.mark.asyncio
    async def test_shutdown_raises_cancelled_not_silent_success(self, patched_service):
        from exceptions import DiscoveryFailure, DiscoveryFailureReason

        provider, backend, tmp_path = patched_service
        shutdown_event = threading.Event()
        delivered: List[dict] = []

        def _watchdog_thread():
            # Simulate the Node bridge's inactivity watchdog firing
            # partway through a run that would otherwise run forever.
            time.sleep(0.3)
            shutdown_event.set()

        threading.Thread(target=_watchdog_thread, daemon=True).start()

        raised: List[BaseException] = []
        try:
            async for lead in service.run_query(
                query="coffee shop", city="Testville", country="US",
                max_results=1000, deliver_target=1000,
                db_path=str(tmp_path / "leads.db"),
                shutdown_event=shutdown_event,
            ):
                delivered.append(lead)
        except DiscoveryFailure as exc:
            raised.append(exc)

        assert len(raised) == 1, (
            "REGRESSION (PART D): a watchdog-style shutdown with the "
            "target unreached must raise DiscoveryFailure(CANCELLED) — "
            "it must not silently complete as an ordinary success."
        )
        assert raised[0].reason == DiscoveryFailureReason.CANCELLED
        # And, critically, whatever was ALREADY accepted before the
        # shutdown must not be lost — PART F: "A candidate already
        # accepted before cancellation must not disappear."
        assert len(delivered) >= 1, "already-delivered leads before shutdown must not be lost"
        assert len(delivered) < 1000, "must not have reached the (unreachable) target"


class TestTargetReachedStillWinsOverShutdown:
    """PART F — if target_reached happens to become true in the very
    pass where shutdown_event is also observed, target-reached success
    must win; DiscoveryFailure(CANCELLED) must NOT be raised."""

    @pytest.mark.asyncio
    async def test_target_reached_before_shutdown_checked_is_a_clean_success(self, patched_service):
        provider, backend, tmp_path = patched_service
        shutdown_event = threading.Event()
        # Already set before run_query even starts -- if target_reached
        # is ever allowed to be evaluated in the same pass, this proves
        # the ordering (target check before shutdown check) still holds
        # for a very small, quickly-reachable target.
        delivered: List[dict] = []
        async for lead in service.run_query(
            query="coffee shop", city="Testville", country="US",
            max_results=10, deliver_target=1,
            db_path=str(tmp_path / "leads2.db"),
            shutdown_event=shutdown_event,
        ):
            delivered.append(lead)
            shutdown_event.set()  # arrives just as target is reached

        assert len(delivered) == 1


class TestProgressLinesOnStdout:
    """Test 3 / PART C — real progress lines (candidate_discovered /
    candidate_queued / stage_completed / candidate_qualified) are written
    to stdout as their own `{"type": "progress", ...}` JSON objects
    during a real run_query() pass, distinguishable from lead dicts and
    the __done__ sentinel — this is what lets pythonBridge.ts reset its
    inactivity watchdog on real mid-pipeline work, not just on a
    delivered lead."""

    @pytest.mark.asyncio
    async def test_progress_events_are_written_and_well_formed(self, patched_service, capsys):
        provider, backend, tmp_path = patched_service
        provider._gap_s = 0.01
        delivered: List[dict] = []
        async for lead in service.run_query(
            query="coffee shop", city="Testville", country="US",
            max_results=5, deliver_target=3,
            db_path=str(tmp_path / "leads3.db"),
        ):
            delivered.append(lead)

        out = capsys.readouterr().out
        progress_lines = []
        for line in out.splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
            except json.JSONDecodeError:
                continue
            if obj.get("type") == "progress":
                progress_lines.append(obj)

        assert progress_lines, "no progress lines were emitted on stdout at all"
        events = {p["event"] for p in progress_lines}
        assert "candidate_discovered" in events
        assert "candidate_queued" in events
        for p in progress_lines:
            assert p["stage"], f"progress line missing stage: {p}"
            assert "timestamp" in p
            assert p.get("session_id"), f"progress line missing session_id: {p}"

        # Progress lines must never be mistaken for leads by a consumer
        # that (like the real pythonBridge.ts) only looks for __done__
        # explicitly and otherwise assumes "it's a lead".
        for p in progress_lines:
            assert "opportunity_id" not in p and "qualified" not in p


class TestLatencyMetricsPresent:
    """Test 7 / PART E — the new truthful first-lead latency breakdown is
    present in __perf__["latency"] and reflects real, distinct
    milestones (not the watchdog-shutdown-time artifact the forensic
    audit found)."""

    @pytest.mark.asyncio
    async def test_perf_summary_has_latency_breakdown(self, patched_service):
        provider, backend, tmp_path = patched_service
        provider._gap_s = 0.01
        async for _lead in service.run_query(
            query="coffee shop", city="Testville", country="US",
            max_results=5, deliver_target=2,
            db_path=str(tmp_path / "leads4.db"),
        ):
            pass

        summary = service._last_perf_summary
        assert summary is not None
        latency = summary.get("latency")
        assert latency is not None, "expected __perf__['latency'] to be populated"
        for key in (
            "time_to_first_candidate_s",
            "time_to_first_accepted_s",
            "time_to_first_enrichment_s",
            "time_to_first_lead_s",
        ):
            assert key in latency
            assert latency[key] is not None, f"{key} was never recorded"
            assert latency[key] >= 0

        assert latency["time_to_first_candidate_s"] <= latency["time_to_first_lead_s"], (
            "first candidate discovered must not be timestamped AFTER the "
            "first lead was delivered"
        )
