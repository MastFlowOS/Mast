"""
PHASE 5B-2 — regression tests for the widened progress protocol
(`terminal` / `dead_lettered` / `pipeline_id` / `terminal_reason`) that
Python now emits, fixing the PHASE 5B-1 audit's gaps:

  #1 / #3: every qualification rejection reason (not just niche_mismatch /
           instagram_followers_over_limit) now emits a terminal
           `candidate_rejected` event.
  #4:      a retryable stage failure (dead_lettered=False) is never
           terminal; only a dead-lettered one is.
  #5 / #6: merge and storage now participate in terminal accounting.

These exercise the SAME internal seams test_issue1_prune_stops_downstream.py
and test_engine_crash_regression.py already use: `build_seven_stage_pipeline`'s
returned `stage_map[...].build_downstream(...)` (drives `_qualification_downstream`
directly) and its returned `on_stage_outcome` callback (drives
`_emit_stage_outcome` directly with a synthetic `StageOutcome` — no real
worker/queue machinery needed to test the terminality decision itself).
"""

from __future__ import annotations

import pytest

from engine.contracts import BusinessCandidate, EnrichedBusiness, QualificationResult
from engine.coordinator import EngineCoordinator
from engine.execution_driver import build_seven_stage_pipeline
from engine.interfaces import DiscoveryProviderInterface
from engine.runtime import StageOutcome


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
    """Returns (stage_map, fan_in, events, backend). `events` accumulates
    every `on_progress(stage, event, item_id, **kwargs)` call as a dict —
    this is the fixture's captured wire-protocol view, exactly what
    pythonBridge.ts parses on the Node side."""
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
    return stage_map, fan_in, events, backend, on_stage_outcome


def _stash_enriched(stage_map, fan_in, pipeline_id: str) -> None:
    """Populate `_qualification_downstream`'s internal stash for
    pipeline_id, the same way MergeWorker's real output would (see
    `_merge_downstream`). Required before `_qualification_downstream` will
    emit anything for that pipeline_id."""
    fan_in.register_business(_make_candidate(pipeline_id))
    stage_map["merge"].build_downstream(EnrichedBusiness(pipeline_id=pipeline_id, business=_make_candidate(pipeline_id)))


def _terminal_events(events: list[dict], pipeline_id: str) -> list[dict]:
    return [e for e in events if e["pipeline_id"] == pipeline_id and e["terminal"]]


class TestGenericQualificationRejection:
    """5B-1 gaps #1 / #3."""

    @pytest.mark.parametrize(
        "reason",
        [
            "missing required website",
            "missing required channel: phone",
            "missing required channel: email",
            "missing required channel: instagram",
            "website unreachable",
            "no contact methods",
            "unsupported business type",
        ],
    )
    def test_every_rejection_reason_emits_a_terminal_candidate_rejected_event(self, pipeline, reason):
        stage_map, fan_in, events, backend, _ = pipeline
        pid = f"p-{reason[:8]}"
        _stash_enriched(stage_map, fan_in, pid)

        result = QualificationResult(pipeline_id=pid, qualified=False, reasons=(reason,))
        out = stage_map["qualification"].build_downstream(result)

        assert out is None
        terminal = _terminal_events(events, pid)
        assert any(e["event"] == "candidate_rejected" for e in terminal), (
            f"reason={reason!r} produced no terminal candidate_rejected event; events={events}"
        )
        rejected = [e for e in terminal if e["event"] == "candidate_rejected"][0]
        assert rejected["terminal_reason"] == reason
        assert rejected["dead_lettered"] is False

    def test_niche_mismatch_and_follower_limit_still_close_the_candidate(self, pipeline):
        stage_map, fan_in, events, backend, _ = pipeline
        pid = "p-niche"
        _stash_enriched(stage_map, fan_in, pid)
        result = QualificationResult(pipeline_id=pid, qualified=False, reasons=("niche_mismatch",))
        stage_map["qualification"].build_downstream(result)
        terminal = _terminal_events(events, pid)
        # Exactly one terminal event's worth of closes should be observed by
        # a pipeline_id-idempotent consumer (poolExpandJob.ts) even though
        # more than one terminal-flagged event may be ON THE WIRE — the
        # informational niche_relevance_mismatch emit is NOT terminal;
        # only the generic candidate_rejected is.
        assert [e["event"] for e in terminal] == ["candidate_rejected"]


class TestRetryVsDeadLetterTerminality:
    """5B-1 gap #4 — a retryable failure must never be terminal; only a
    dead-lettered one is. Exercised directly against `_emit_stage_outcome`
    (via the pipeline's returned `on_stage_outcome` callback) with synthetic
    `StageOutcome`s, matching this fixture's docstring."""

    @staticmethod
    def _stage_outcome_events(events, pipeline_id):
        # `_on_enrichment_failure_outcome` may ALSO fire a
        # `candidate_early_channel_pruned` event off the same StageOutcome
        # (a separate, unrelated concern from this class — see
        # TestMergeAndStorageParticipateInTerminalAccounting and the
        # discovery-stage prune tests for that path). Isolate the
        # `_emit_stage_outcome`-produced `stage_completed`/`stage_failed`
        # event specifically.
        return [
            e for e in events
            if e["pipeline_id"] == pipeline_id and e["event"] in ("stage_completed", "stage_failed")
        ]

    def test_retryable_website_failure_is_not_terminal(self, pipeline):
        stage_map, fan_in, events, backend, on_stage_outcome = pipeline
        fan_in.register_business(_make_candidate("p-retry"))
        outcome = StageOutcome(
            stage_name="website", ran=True, success=False, worker_id="w1",
            queue_item_id="q1", pipeline_id="p-retry", dead_lettered=False,
        )
        on_stage_outcome(outcome)
        matching = self._stage_outcome_events(events, "p-retry")
        assert matching, "expected a stage_failed progress event"
        assert matching[0]["event"] == "stage_failed"
        assert matching[0]["terminal"] is False
        assert matching[0]["dead_lettered"] is False

    def test_dead_lettered_website_failure_is_terminal(self, pipeline):
        stage_map, fan_in, events, backend, on_stage_outcome = pipeline
        fan_in.register_business(_make_candidate("p-dead"))
        outcome = StageOutcome(
            stage_name="website", ran=True, success=False, worker_id="w1",
            queue_item_id="q1", pipeline_id="p-dead", dead_lettered=True,
        )
        on_stage_outcome(outcome)
        matching = self._stage_outcome_events(events, "p-dead")
        assert matching[0]["terminal"] is True
        assert matching[0]["dead_lettered"] is True

    def test_website_success_is_not_terminal(self, pipeline):
        stage_map, fan_in, events, backend, on_stage_outcome = pipeline
        fan_in.register_business(_make_candidate("p-success"))
        outcome = StageOutcome(
            stage_name="website", ran=True, success=True, worker_id="w1",
            queue_item_id="q1", pipeline_id="p-success",
        )
        on_stage_outcome(outcome)
        matching = self._stage_outcome_events(events, "p-success")
        assert matching[0]["event"] == "stage_completed"
        assert matching[0]["terminal"] is False


class TestMergeAndStorageParticipateInTerminalAccounting:
    """5B-1 gaps #5 / #6."""

    def test_merge_dead_letter_is_terminal(self, pipeline):
        _, _, events, _, on_stage_outcome = pipeline
        outcome = StageOutcome(
            stage_name="merge", ran=True, success=False, worker_id="w1",
            queue_item_id="q1", pipeline_id="p-merge-dl", dead_lettered=True,
        )
        on_stage_outcome(outcome)
        matching = [e for e in events if e["pipeline_id"] == "p-merge-dl"]
        assert matching[0]["terminal"] is True

    def test_merge_success_is_not_terminal(self, pipeline):
        _, _, events, _, on_stage_outcome = pipeline
        outcome = StageOutcome(
            stage_name="merge", ran=True, success=True, worker_id="w1",
            queue_item_id="q1", pipeline_id="p-merge-ok",
        )
        on_stage_outcome(outcome)
        matching = [e for e in events if e["pipeline_id"] == "p-merge-ok"]
        assert matching[0]["terminal"] is False

    def test_storage_success_is_terminal(self, pipeline):
        _, _, events, _, on_stage_outcome = pipeline
        outcome = StageOutcome(
            stage_name="storage", ran=True, success=True, worker_id="w1",
            queue_item_id="q1", pipeline_id="p-storage-ok",
        )
        on_stage_outcome(outcome)
        matching = [e for e in events if e["pipeline_id"] == "p-storage-ok"]
        assert matching[0]["terminal"] is True
        assert matching[0]["terminal_reason"] == "delivered"

    def test_storage_dead_letter_is_terminal(self, pipeline):
        _, _, events, _, on_stage_outcome = pipeline
        outcome = StageOutcome(
            stage_name="storage", ran=True, success=False, worker_id="w1",
            queue_item_id="q1", pipeline_id="p-storage-dl", dead_lettered=True,
        )
        on_stage_outcome(outcome)
        matching = [e for e in events if e["pipeline_id"] == "p-storage-dl"]
        assert matching[0]["terminal"] is True
        assert matching[0]["terminal_reason"] == "storage_dead_letter"

    def test_storage_retryable_failure_is_not_terminal(self, pipeline):
        _, _, events, _, on_stage_outcome = pipeline
        outcome = StageOutcome(
            stage_name="storage", ran=True, success=False, worker_id="w1",
            queue_item_id="q1", pipeline_id="p-storage-retry", dead_lettered=False,
        )
        on_stage_outcome(outcome)
        matching = [e for e in events if e["pipeline_id"] == "p-storage-retry"]
        assert matching[0]["terminal"] is False


class TestQualifiedCandidateSingleTerminalTransition:
    """5B-1 gap #2 — `candidate_qualified` itself must not be terminal."""

    def test_candidate_qualified_event_is_not_terminal(self, pipeline):
        stage_map, fan_in, events, backend, _ = pipeline
        pid = "p-qualified"
        _stash_enriched(stage_map, fan_in, pid)
        result = QualificationResult(pipeline_id=pid, qualified=True, reasons=())
        out = stage_map["qualification"].build_downstream(result)
        assert out is not None
        matching = [e for e in events if e["pipeline_id"] == pid]
        # No event for this pipeline_id at the qualification stage may be
        # terminal — the candidate's one terminal transition is its later
        # storage outcome, not this one.
        assert all(not e["terminal"] for e in matching), matching


class TestBackwardCompatibleOldStyleCallback:
    """A 3-arg-only `on_progress` callback (the shape most pre-5B-2 tests
    and callers use) must keep receiving every event — the new keyword
    args must never be force-fed to it (and silently swallow the whole
    event if they were, since `_emit` wraps calls in a broad except)."""

    def test_three_arg_callback_still_receives_every_event(self):
        coordinator = EngineCoordinator()
        ctx = coordinator.create_session(user_id="test-user", provider="dummy", requested_count=10)
        session_id = ctx.session.id
        coordinator.start_session(session_id)
        provider = DummyDiscoveryProvider()
        backend = DummyStorageBackend()

        received: list[tuple] = []

        def old_style_on_progress(stage, event, item_id):
            received.append((stage, event, item_id))

        stages, queue_ids, fan_in, on_stage_outcome = build_seven_stage_pipeline(
            coordinator,
            session_id,
            discovery_provider=provider,
            discovery_request=type("Req", (), {"session_id": session_id})(),
            storage_backend=backend,
            required_channels=["email"],
            on_progress=old_style_on_progress,
        )
        outcome = StageOutcome(
            stage_name="website", ran=True, success=False, worker_id="w1",
            queue_item_id="q1", pipeline_id="p-compat", dead_lettered=True,
        )
        on_stage_outcome(outcome)
        assert ("website", "stage_failed", "q1") in received
