"""
Deterministic test verifying that a delayed stage hand-off does not trigger
premature pipeline draining or cause in-flight items to be dropped.
"""

from __future__ import annotations

import http.server
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
from workers.qualification_worker import QualificationWorker


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


class _SingleCandidateProvider:
    """Discovers exactly 1 candidate and then terminates (exhausted)."""

    def __init__(self, reachable_url: str) -> None:
        self._reachable_url = reachable_url

    def discover(self, request: Any) -> Iterator[BusinessCandidate]:
        yield BusinessCandidate(
            pipeline_id=str(uuid.uuid4()),
            session_id=request.session_id,
            provider="fake",
            maps_url="https://maps.example.invalid/single-candidate",
            name="Delayed Handoff Business",
            category="Restaurant",
            address="100 Hand-off Ave",
            city=request.city,
            country=request.country,
            website=f"{self._reachable_url}?b=handoff",
            phone="+1-555-0199",
            rating=4.8,
            review_count=120,
            discovered_at=datetime.now(timezone.utc).isoformat(),
        )


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


@pytest.mark.asyncio
async def test_delayed_stage_handoff_delivers_without_dropping(monkeypatch, loopback_server, tmp_path):
    """When an item is mid-stage (dequeued from qualification_in, computing in QualificationWorker
    before enqueueing to storage_in), all input queues are momentarily empty and discovery is finished.
    The production drain loop must check driver._stage_active and wait for consecutive quiescent polls
    so that the in-flight lead is never dropped or abandoned."""
    provider = _SingleCandidateProvider(loopback_server)
    backend = _FakeStorageBackend()
    monkeypatch.setattr(service, "GoogleMapsProvider", lambda: provider)
    monkeypatch.setattr(service, "_build_storage_backend", lambda: backend)

    original_process = QualificationWorker.process
    stage_delayed = False

    def _delayed_qualification_process(worker_self, worker_input):
        nonlocal stage_delayed
        stage_delayed = True
        # Simulate a delayed hand-off where the input queue has been dequeued
        # and is empty, but the worker is actively computing before enqueueing
        # to storage_in.
        time.sleep(0.08)
        return original_process(worker_self, worker_input)

    monkeypatch.setattr(QualificationWorker, "process", _delayed_qualification_process)

    delivered = []
    async for lead in service.run_query(
        query="coffee",
        city="Testville",
        country="US",
        max_results=5,
        deliver_target=1,
        db_path=str(tmp_path / "delayed_handoff.db"),
    ):
        delivered.append(lead)

    assert stage_delayed is True, "Delayed qualification worker must have executed"
    assert len(delivered) == 1, "The delayed in-flight lead must be delivered, not dropped"
    assert delivered[0]["name"] == "Delayed Handoff Business"
    assert len(backend.persisted) == 1
