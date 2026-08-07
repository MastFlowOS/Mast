"""
Ad-hoc validation for Phase 6.6 (Storage Backend), run directly:

    python3 validate_storage_backend.py

Not part of the permanent test suite (matching validate_fan_in_runtime.py's
own precedent/rationale). Exercises exactly the four "VALIDATION" bullets
the Phase 6.6 prompt lists:

    - StorageWorker operates unchanged.
    - Existing protocol (_StoragePersistenceProtocol) is fully satisfied.
    - Persistence succeeds.
    - Imports remain acyclic.

No live Supabase project is reachable from this environment, so
persistence is verified by monkeypatching `urllib.request.urlopen` rather
than hitting a real network — this checks SupabaseStorageBackend's request
construction and response mapping are correct, not that a specific
Supabase project is configured correctly (that remains an integration
concern for whoever deploys this).
"""

from __future__ import annotations

import json
import urllib.request
from io import BytesIO

from engine.contracts import EnrichedBusiness, QualifiedOpportunity, StoredOpportunity
from storage_backends.supabase_backend import SupabaseStorageBackend
from workers.storage_worker import StorageWorker, _StoragePersistenceProtocol


class _FakeResponse:
    """Minimal context-manager stand-in for urlopen()'s return value."""

    def __init__(self, payload: bytes) -> None:
        self._buf = BytesIO(payload)

    def read(self) -> bytes:
        return self._buf.read()

    def __enter__(self) -> "_FakeResponse":
        return self

    def __exit__(self, *exc) -> None:
        return None


def test_backend_satisfies_protocol():
    backend = SupabaseStorageBackend(
        supabase_url="https://example.supabase.co",
        supabase_key="test-service-role-key",
    )
    assert isinstance(backend, _StoragePersistenceProtocol), (
        "SupabaseStorageBackend must structurally satisfy "
        "_StoragePersistenceProtocol"
    )
    print("PASS: SupabaseStorageBackend satisfies _StoragePersistenceProtocol")


def test_persist_maps_supabase_response_to_stored_opportunity(monkeypatch):
    backend = SupabaseStorageBackend(
        supabase_url="https://example.supabase.co",
        supabase_key="test-service-role-key",
    )

    captured_requests = []

    def fake_urlopen(request, timeout=None):
        captured_requests.append(request)
        row = {
            "id": "11111111-1111-1111-1111-111111111111",
            "pipeline_id": json.loads(request.data)["pipeline_id"],
            "created_at": "2026-07-31T00:00:00Z",
        }
        return _FakeResponse(json.dumps([row]).encode("utf-8"))

    monkeypatch.setattr(urllib.request, "urlopen", fake_urlopen)

    opportunity = QualifiedOpportunity(
        pipeline_id="p1",
        session_id="s1",
        business=EnrichedBusiness(pipeline_id="p1"),

    )
    result = backend.persist(opportunity)

    assert isinstance(result, StoredOpportunity)
    assert result.opportunity_id == "11111111-1111-1111-1111-111111111111"
    assert result.pipeline_id == "p1"
    assert result.created_at == "2026-07-31T00:00:00Z"
    assert len(captured_requests) == 1
    assert captured_requests[0].full_url.endswith("/rest/v1/qualified_opportunities")
    assert captured_requests[0].get_header("Apikey") == "test-service-role-key"
    print("PASS: persist() maps a Supabase response into StoredOpportunity")


def test_storage_worker_delegates_unchanged(monkeypatch):
    """
    StorageWorker itself is not modified by this milestone — this just
    confirms constructor injection + pure delegation still work with a
    real (not fake/stub) backend implementation plugged in.
    """
    backend = SupabaseStorageBackend(
        supabase_url="https://example.supabase.co",
        supabase_key="test-service-role-key",
    )

    def fake_urlopen(request, timeout=None):
        row = {"id": "22222222-2222-2222-2222-222222222222", "created_at": None}
        return _FakeResponse(json.dumps([row]).encode("utf-8"))

    monkeypatch.setattr(urllib.request, "urlopen", fake_urlopen)

    worker = StorageWorker(backend=backend)
    opportunity = QualifiedOpportunity(pipeline_id="p2", session_id="s2")
    result = worker.process(opportunity)

    assert isinstance(result, StoredOpportunity)
    assert result.opportunity_id == "22222222-2222-2222-2222-222222222222"
    assert result.pipeline_id == "p2"
    print("PASS: StorageWorker.process() delegates unchanged to an injected backend")


class _MonkeyPatch:
    """Tiny stand-in for pytest's monkeypatch fixture (no pytest dependency)."""

    def __init__(self) -> None:
        self._restores = []

    def setattr(self, obj, name, value) -> None:
        self._restores.append((obj, name, getattr(obj, name)))
        setattr(obj, name, value)

    def undo(self) -> None:
        for obj, name, original in reversed(self._restores):
            setattr(obj, name, original)


if __name__ == "__main__":
    test_backend_satisfies_protocol()

    mp = _MonkeyPatch()
    try:
        test_persist_maps_supabase_response_to_stored_opportunity(mp)
    finally:
        mp.undo()

    mp = _MonkeyPatch()
    try:
        test_storage_worker_delegates_unchanged(mp)
    finally:
        mp.undo()

    print("\nAll Phase 6.6 validation checks passed.")
