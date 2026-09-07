"""
Regression test for the qualification stash-miss observability fix
(Phase 1 audit §3 / recommended action §5).

Prior to this fix, `_qualification_downstream` silently returned `None`
when `stash.pop(result.pipeline_id)` came back empty — no `_emit` call
at all, meaning the candidate never appeared in the progress event
stream and was only ever swept up as a generic, indistinguishable
cancellation at end-of-run.

This test proves ONLY the observability fix: that this branch now emits
exactly one terminal progress event with
`terminal_reason == "qualification_stash_miss"`, that no
`QualifiedOpportunity` is produced, and that no exception is raised.
It does not exercise or assert anything about the stash miss's root
cause (queue ordering, FanIn, retries, etc.) — that is explicitly out
of scope per the Phase 1 recommendation.

Reuses the same fixture pattern as
`tests/test_phase5b2_lifecycle_accounting.py` (`build_seven_stage_pipeline`,
driving `_qualification_downstream` directly via
`stage_map["qualification"].build_downstream(...)`).
"""

from __future__ import annotations

import pytest

from engine.contracts import BusinessCandidate, QualificationResult
from engine.coordinator import EngineCoordinator
from engine.execution_driver import build_seven_stage_pipeline
from engine.interfaces import DiscoveryProviderInterface


class DummyDiscoveryProvider(DiscoveryProviderInterface):
    @property
    def provider_id(self) -> str:
        return "dummy"

    @property
    def display_name(self) -> str:
        return "Dummy"

    def discover(self, request):
        return iter([])


class DummyStorageBackend:
    def __init__(self):
        self.persisted = []

    def persist(self, opportunity):
        self.persisted.append(opportunity)
        return opportunity


def _make_candidate(pipeline_id: str) -> BusinessCandidate:
    return BusinessCandidate(
        pipeline_id=pipeline_id,
        session_id="session-test",
        provider="google_maps",
        name=f"Business {pipeline_id}",
        address="123 Street",
        city="Mexico City",
        country="MX",
        category="Restaurant",
        website="https://example.com",
        phone="+1234567890",
    )


@pytest.fixture()
def pipeline():
    coordinator = EngineCoordinator()
    ctx = coordinator.create_session(user_id="test-user", provider="dummy", requested_count=10)
    session_id = ctx.session.id
    coordinator.start_session(session_id)
    provider = DummyDiscoveryProvider()
    backend = DummyStorageBackend()

    events: list[dict] = []

    def on_progress(stage, event, item_id, *, terminal=False, dead_lettered=False, pipeline_id=None, terminal_reason=None):
        events.append({
            "stage": stage,
            "event": event,
            "item_id": item_id,
            "terminal": terminal,
            "dead_lettered": dead_lettered,
            "pipeline_id": pipeline_id,
            "terminal_reason": terminal_reason,
        })

    stages, queue_ids, fan_in, on_stage_outcome = build_seven_stage_pipeline(
        coordinator,
        session_id,
        discovery_provider=provider,
        discovery_request=type("Req", (), {"session_id": session_id})(),
        storage_backend=backend,
        required_channels=["email"],
        on_progress=on_progress,
    )
    stage_map = {s.name: s for s in stages}
    return stage_map, fan_in, events, backend


class TestQualificationStashMissObservability:
    def test_stash_miss_emits_exactly_one_terminal_event_with_expected_reason(self, pipeline):
        stage_map, fan_in, events, backend = pipeline
        pid = "p-stash-miss"

        # Deliberately do NOT stash an EnrichedBusiness for this
        # pipeline_id (i.e. skip the `_merge_downstream` step that
        # `test_phase5b2_lifecycle_accounting.py`'s `_stash_enriched`
        # helper performs) — this reproduces the stash-miss branch.
        fan_in.register_business(_make_candidate(pid))
        result = QualificationResult(pipeline_id=pid, qualified=True, reasons=())

        out = stage_map["qualification"].build_downstream(result)

        assert out is None, "no QualifiedOpportunity should be produced on a stash miss"
        assert backend.persisted == [], "nothing should reach storage on a stash miss"

        matching = [e for e in events if e["pipeline_id"] == pid]
        terminal = [e for e in matching if e["terminal"]]

        assert len(terminal) == 1, f"expected exactly one terminal event; got {terminal}"
        assert terminal[0]["terminal_reason"] == "qualification_stash_miss"
        assert terminal[0]["dead_lettered"] is False
        assert terminal[0]["stage"] == "qualification"

    def test_stash_miss_does_not_raise(self, pipeline):
        stage_map, fan_in, events, backend = pipeline
        pid = "p-stash-miss-no-raise"
        fan_in.register_business(_make_candidate(pid))
        result = QualificationResult(pipeline_id=pid, qualified=False, reasons=("some_reason",))

        # Should complete without raising regardless of result.qualified —
        # the stash-miss check happens before the qualified/rejected branch.
        out = stage_map["qualification"].build_downstream(result)
        assert out is None
