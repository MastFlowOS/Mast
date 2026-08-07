"""
Ad-hoc validation for the Persistence Integration milestone
(batch intelligence chain: OpportunityPriority, RankedOpportunity,
Mission, WorkflowState, FeedbackRecord), run directly:

    python3 validate_batch_intelligence_backend.py

Same convention as validate_storage_backend.py (its closest precedent):
a standalone script, no pytest, plain asserts, printed checkpoints. No
live Supabase project is reachable from this environment, so every
check here monkeypatches `urllib.request.urlopen` and asserts on the
HTTP requests SupabaseBatchIntelligenceBackend *would* have sent (method,
URL, headers, body) and on the domain objects it maps responses back
into — the same posture validate_storage_backend.py already takes
toward the same limitation.

Covers
------
1. persist_batch_result() writes all four tables, in dependency order,
   with upsert (`Prefer: resolution=merge-duplicates`) semantics.
2. Each fetch_*() method maps a PostgREST row back into the exact
   domain dataclass it was built from (round-trip fidelity — Part 2's
   canonical mapping requirement).
3. persist_feedback() is a plain (non-upsert) insert.
4. service.py's new read-path wiring (evaluate_workflow_v2's persisted-
   state fallback, evaluate_mission_intelligence_v2,
   capture_feedback_v2, evaluate_analytics_v2's optional session_id
   branch, build_ai_coach_context_v2's optional opportunity_id branch)
   all correctly delegate to the backend instead of recomputing.
"""

from __future__ import annotations

import asyncio
import json
import urllib.request
from io import BytesIO

from feedback.models import FeedbackEvidence, FeedbackOutcomeType, FeedbackRecord, FeedbackTargetType
from mission_generation.models import Mission, MissionType
from opportunity_prioritization.models import OpportunityPriority
from opportunity_ranking.models import RankedOpportunity
from storage_backends.batch_intelligence_backend import SupabaseBatchIntelligenceBackend
from workflow.models import WorkflowState, WorkflowStatus


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


def _backend() -> SupabaseBatchIntelligenceBackend:
    return SupabaseBatchIntelligenceBackend(
        supabase_url="https://example.supabase.co",
        supabase_key="test-service-role-key",
    )


# ---------------------------------------------------------------------------
# 1. persist_batch_result(): four upserts, strict dependency order
# ---------------------------------------------------------------------------

def test_persist_batch_result_writes_all_four_tables_in_order(monkeypatch):
    backend = _backend()
    captured = []

    def fake_urlopen(request, timeout=None):
        captured.append(request)
        return _FakeResponse(json.dumps(json.loads(request.data)).encode("utf-8"))

    monkeypatch.setattr(urllib.request, "urlopen", fake_urlopen)

    priorities = (
        OpportunityPriority(
            opportunity_id="opp1", priority_score=0.9,
            score_contribution=0.6, recency_contribution=0.3, is_eligible=True,
        ),
    )
    ranked = (RankedOpportunity(opportunity_id="opp1", rank=1, priority_score=0.9),)
    missions = (Mission(opportunity_id="opp1", business_id="biz1", mission_type=MissionType.OUTREACH),)
    workflow_states = (
        WorkflowState(mission_id="opp1", opportunity_id="opp1", business_id="biz1", status=WorkflowStatus.UNSTARTED),
    )

    backend.persist_batch_result(
        "session-1",
        priorities=priorities,
        ranked_opportunities=ranked,
        missions=missions,
        workflow_states=workflow_states,
    )

    assert len(captured) == 4, f"expected 4 requests (one per table), got {len(captured)}"

    tables_in_order = [req.full_url.split("/rest/v1/")[1].split("?")[0] for req in captured]
    assert tables_in_order == [
        "opportunity_priorities",
        "ranked_opportunities",
        "missions",
        "workflow_states",
    ], f"unexpected write order: {tables_in_order}"

    for req in captured:
        assert req.get_method() == "POST"
        assert "merge-duplicates" in req.get_header("Prefer")
        assert req.get_header("Apikey") == "test-service-role-key"

    priorities_body = json.loads(captured[0].data)
    assert priorities_body == [{
        "opportunity_id": "opp1", "session_id": "session-1",
        "priority_score": 0.9, "score_contribution": 0.6,
        "recency_contribution": 0.3, "is_eligible": True,
    }]

    ranks_body = json.loads(captured[1].data)
    assert ranks_body == [{"session_id": "session-1", "opportunity_id": "opp1", "rank": 1, "priority_score": 0.9}]
    assert "on_conflict=session_id%2Copportunity_id" in captured[1].full_url or "on_conflict=session_id,opportunity_id" in captured[1].full_url

    missions_body = json.loads(captured[2].data)
    assert missions_body == [{
        "opportunity_id": "opp1", "business_id": "biz1",
        "mission_type": "OUTREACH", "session_id": "session-1",
    }]

    workflow_body = json.loads(captured[3].data)
    assert workflow_body == [{
        "opportunity_id": "opp1", "mission_id": "opp1",
        "business_id": "biz1", "status": "UNSTARTED", "session_id": "session-1",
    }]

    print("PASS: persist_batch_result() writes all four tables, in dependency order, with upsert semantics")


def test_persist_batch_result_skips_empty_sequences(monkeypatch):
    backend = _backend()
    captured = []
    monkeypatch.setattr(
        urllib.request, "urlopen",
        lambda request, timeout=None: (captured.append(request), _FakeResponse(b"[]"))[1],
    )
    backend.persist_batch_result("session-2")
    assert captured == [], "no rows to write -> zero HTTP requests"
    print("PASS: persist_batch_result() makes no request for an empty batch result")


# ---------------------------------------------------------------------------
# 2. fetch_*() round-trip fidelity
# ---------------------------------------------------------------------------

def test_fetch_priority_round_trips(monkeypatch):
    backend = _backend()

    def fake_urlopen(request, timeout=None):
        assert request.get_method() == "GET"
        row = {
            "opportunity_id": "opp1", "priority_score": 0.75,
            "score_contribution": 0.5, "recency_contribution": 0.25, "is_eligible": True,
        }
        return _FakeResponse(json.dumps([row]).encode("utf-8"))

    monkeypatch.setattr(urllib.request, "urlopen", fake_urlopen)
    priority = backend.fetch_priority("opp1")
    assert isinstance(priority, OpportunityPriority)
    assert priority.opportunity_id == "opp1"
    assert priority.priority_score == 0.75
    assert priority.is_eligible is True
    print("PASS: fetch_priority() maps a row back into OpportunityPriority")


def test_fetch_ranked_opportunities_ordered_by_rank(monkeypatch):
    backend = _backend()

    def fake_urlopen(request, timeout=None):
        assert "order=rank.asc" in request.full_url
        rows = [
            {"opportunity_id": "opp1", "rank": 1, "priority_score": 0.9},
            {"opportunity_id": "opp2", "rank": 2, "priority_score": 0.7},
        ]
        return _FakeResponse(json.dumps(rows).encode("utf-8"))

    monkeypatch.setattr(urllib.request, "urlopen", fake_urlopen)
    ranks = backend.fetch_ranked_opportunities("session-1")
    assert [r.opportunity_id for r in ranks] == ["opp1", "opp2"]
    assert all(isinstance(r, RankedOpportunity) for r in ranks)
    print("PASS: fetch_ranked_opportunities() maps rows back into RankedOpportunity, ordered by rank")


def test_fetch_mission_round_trips(monkeypatch):
    backend = _backend()
    monkeypatch.setattr(
        urllib.request, "urlopen",
        lambda request, timeout=None: _FakeResponse(json.dumps(
            [{"opportunity_id": "opp1", "business_id": "biz1", "mission_type": "AUDIT"}]
        ).encode("utf-8")),
    )
    mission = backend.fetch_mission("opp1")
    assert isinstance(mission, Mission)
    assert mission.mission_type == MissionType.AUDIT
    print("PASS: fetch_mission() maps a row back into Mission")


def test_fetch_mission_returns_none_when_absent(monkeypatch):
    backend = _backend()
    monkeypatch.setattr(urllib.request, "urlopen", lambda request, timeout=None: _FakeResponse(b"[]"))
    assert backend.fetch_mission("opp-nonexistent") is None
    print("PASS: fetch_mission() returns None for an opportunity with no persisted Mission")


def test_fetch_workflow_state_round_trips(monkeypatch):
    backend = _backend()
    monkeypatch.setattr(
        urllib.request, "urlopen",
        lambda request, timeout=None: _FakeResponse(json.dumps(
            [{"opportunity_id": "opp1", "mission_id": "opp1", "business_id": "biz1", "status": "IN_PROGRESS"}]
        ).encode("utf-8")),
    )
    state = backend.fetch_workflow_state("opp1")
    assert isinstance(state, WorkflowState)
    assert state.status == WorkflowStatus.IN_PROGRESS
    print("PASS: fetch_workflow_state() maps a row back into WorkflowState")


def test_update_workflow_state_upserts_without_session_id(monkeypatch):
    backend = _backend()
    captured = []

    def fake_urlopen(request, timeout=None):
        captured.append(request)
        return _FakeResponse(request.data)

    monkeypatch.setattr(urllib.request, "urlopen", fake_urlopen)
    state = WorkflowState(mission_id="opp1", opportunity_id="opp1", business_id="biz1", status=WorkflowStatus.COMPLETED)
    backend.update_workflow_state(state)
    body = json.loads(captured[0].data)
    assert "session_id" not in body[0], "on-demand transition update must not fabricate a session_id"
    assert body[0]["status"] == "COMPLETED"
    print("PASS: update_workflow_state() upserts an on-demand transition without a session_id")


def test_persist_feedback_is_plain_insert(monkeypatch):
    backend = _backend()
    captured = []

    def fake_urlopen(request, timeout=None):
        captured.append(request)
        return _FakeResponse(request.data)

    monkeypatch.setattr(urllib.request, "urlopen", fake_urlopen)
    record = FeedbackRecord(
        target_type=FeedbackTargetType.OPPORTUNITY, target_id="opp1",
        outcome=FeedbackOutcomeType.MISSION_ACCEPTED,
        evidence=FeedbackEvidence(notes="looks good", metadata=(("source", "manual"),)),
    )
    result = backend.persist_feedback(record)
    assert result is record
    assert captured[0].full_url.endswith("/rest/v1/feedback_records")
    assert "resolution=merge-duplicates" not in (captured[0].get_header("Prefer") or "")
    body = json.loads(captured[0].data)
    assert body == [{
        "target_type": "opportunity", "target_id": "opp1",
        "outcome": "mission_accepted", "notes": "looks good",
        "metadata": [["source", "manual"]],
    }]
    print("PASS: persist_feedback() is a plain (non-upsert) insert into feedback_records")


def test_fetch_feedback_for_target_round_trips(monkeypatch):
    backend = _backend()

    def fake_urlopen(request, timeout=None):
        assert "target_type=eq.opportunity" in request.full_url
        assert "target_id=eq.opp1" in request.full_url
        assert "order=created_at.desc" in request.full_url
        rows = [{
            "target_type": "opportunity", "target_id": "opp1",
            "outcome": "mission_dismissed", "notes": None, "metadata": [],
        }]
        return _FakeResponse(json.dumps(rows).encode("utf-8"))

    monkeypatch.setattr(urllib.request, "urlopen", fake_urlopen)
    records = backend.fetch_feedback_for_target(FeedbackTargetType.OPPORTUNITY, "opp1")
    assert len(records) == 1
    assert records[0].outcome == FeedbackOutcomeType.MISSION_DISMISSED
    print("PASS: fetch_feedback_for_target() maps rows back into FeedbackRecord, most-recent-first")


# ---------------------------------------------------------------------------
# 3. service.py read/write path wiring
# ---------------------------------------------------------------------------

class _FakeBatchBackend:
    """In-memory stand-in for SupabaseBatchIntelligenceBackend, injected via service._build_batch_intelligence_backend."""

    def __init__(self):
        self.missions = {}
        self.workflow_states = {}
        self.priorities = {}
        self.ranks = {}
        self.feedback = []
        self.updated_states = []

    def fetch_workflow_state(self, opportunity_id):
        return self.workflow_states.get(opportunity_id)

    def update_workflow_state(self, state):
        self.updated_states.append(state)
        self.workflow_states[state.opportunity_id] = state

    def fetch_mission(self, opportunity_id):
        return self.missions.get(opportunity_id)

    def fetch_feedback_for_target(self, target_type, target_id):
        return tuple(
            r for r in self.feedback
            if r.target_type == target_type and r.target_id == target_id
        )

    def persist_feedback(self, record):
        self.feedback.insert(0, record)
        return record

    def fetch_priorities_for_session(self, session_id):
        return self.priorities.get(session_id, ())

    def fetch_ranked_opportunities(self, session_id):
        return self.ranks.get(session_id, ())

    def fetch_missions_for_session(self, session_id):
        return tuple(m for m in self.missions.values())

    def fetch_workflow_states_for_session(self, session_id):
        return tuple(w for w in self.workflow_states.values())


def test_evaluate_workflow_v2_reads_persisted_state(monkeypatch):
    import service

    fake_backend = _FakeBatchBackend()
    fake_backend.workflow_states["opp1"] = WorkflowState(
        mission_id="opp1", opportunity_id="opp1", business_id="biz1", status=WorkflowStatus.UNSTARTED,
    )
    monkeypatch.setattr(service, "_build_batch_intelligence_backend", lambda: fake_backend)

    result = asyncio.run(service.evaluate_workflow_v2({
        "action": "transition",
        "opportunity_id": "opp1",
        "event": {"event_type": "QUEUE"},
    }))

    assert result["success"] is True
    assert result["previous_state"]["status"] == "UNSTARTED"
    assert result["new_state"]["status"] == "QUEUED"
    assert len(fake_backend.updated_states) == 1
    assert fake_backend.updated_states[0].status == WorkflowStatus.QUEUED
    print("PASS: evaluate_workflow_v2() loads persisted WorkflowState by opportunity_id and persists the transition result")


def test_evaluate_workflow_v2_raises_when_nothing_persisted(monkeypatch):
    import service

    fake_backend = _FakeBatchBackend()
    monkeypatch.setattr(service, "_build_batch_intelligence_backend", lambda: fake_backend)

    try:
        asyncio.run(service.evaluate_workflow_v2({
            "action": "transition", "opportunity_id": "opp-missing", "event": {"event_type": "QUEUE"},
        }))
        raise AssertionError("expected ValueError for an opportunity with no persisted WorkflowState")
    except ValueError:
        pass
    print("PASS: evaluate_workflow_v2() raises rather than fabricating a WorkflowState when nothing is persisted")


def test_evaluate_mission_intelligence_v2_reads_persisted_state(monkeypatch):
    import service

    fake_backend = _FakeBatchBackend()
    fake_backend.missions["opp1"] = Mission(opportunity_id="opp1", business_id="biz1", mission_type=MissionType.OUTREACH)
    fake_backend.workflow_states["opp1"] = WorkflowState(
        mission_id="opp1", opportunity_id="opp1", business_id="biz1", status=WorkflowStatus.COMPLETED,
    )
    monkeypatch.setattr(service, "_build_batch_intelligence_backend", lambda: fake_backend)

    result = asyncio.run(service.evaluate_mission_intelligence_v2({"opportunity_id": "opp1"}))
    assert result["current_mission"]["opportunity_id"] == "opp1"
    assert result["workflow_state"]["status"] == "COMPLETED"
    assert "rule_applied" in result
    print("PASS: evaluate_mission_intelligence_v2() derives progression from persisted Mission + WorkflowState (no recompute of batch intelligence)")


def test_capture_feedback_v2_persists_via_backend(monkeypatch):
    import service

    fake_backend = _FakeBatchBackend()
    monkeypatch.setattr(service, "_build_batch_intelligence_backend", lambda: fake_backend)

    result = asyncio.run(service.capture_feedback_v2({
        "target_type": "opportunity", "target_id": "opp1", "outcome": "mission_accepted",
    }))
    assert result["outcome"] == "mission_accepted"
    assert len(fake_backend.feedback) == 1
    print("PASS: capture_feedback_v2() persists the captured FeedbackRecord via the batch intelligence backend")


def test_evaluate_analytics_v2_is_unchanged_without_session_id():
    import service

    result = asyncio.run(service.evaluate_analytics_v2({
        "total_discovered": 10, "total_qualified": 5, "total_contacted": 2, "total_won": 1,
    }))
    assert "batch_intelligence" not in result, "must be byte-identical to pre-milestone behavior when session_id is absent"
    assert result["qualification_rate_pct"] == 50.0
    print("PASS: evaluate_analytics_v2() is unchanged for callers that don't pass session_id")


def test_evaluate_analytics_v2_includes_persisted_batch_intelligence(monkeypatch):
    import service

    fake_backend = _FakeBatchBackend()
    fake_backend.priorities["session-1"] = (
        OpportunityPriority(opportunity_id="opp1", priority_score=0.8, score_contribution=0.5, recency_contribution=0.3, is_eligible=True),
    )
    fake_backend.missions["opp1"] = Mission(opportunity_id="opp1", business_id="biz1", mission_type=MissionType.OUTREACH)
    fake_backend.workflow_states["opp1"] = WorkflowState(mission_id="opp1", opportunity_id="opp1", business_id="biz1", status=WorkflowStatus.QUEUED)
    monkeypatch.setattr(service, "_build_batch_intelligence_backend", lambda: fake_backend)

    result = asyncio.run(service.evaluate_analytics_v2({"total_discovered": 1, "session_id": "session-1"}))
    assert "batch_intelligence" in result
    assert result["batch_intelligence"]["priorities"]["eligibility_ratio"]["count"] == 1
    print("PASS: evaluate_analytics_v2() additively includes a persisted-state AnalyticsReport when session_id is supplied")


def test_build_ai_coach_context_v2_includes_persisted_mission_context(monkeypatch):
    import service

    fake_backend = _FakeBatchBackend()
    fake_backend.missions["opp1"] = Mission(opportunity_id="opp1", business_id="biz1", mission_type=MissionType.NURTURE)
    fake_backend.workflow_states["opp1"] = WorkflowState(mission_id="opp1", opportunity_id="opp1", business_id="biz1", status=WorkflowStatus.PAUSED)
    monkeypatch.setattr(service, "_build_batch_intelligence_backend", lambda: fake_backend)

    result = asyncio.run(service.build_ai_coach_context_v2({"opportunity_id": "opp1"}))
    assert result["mission_context"]["mission"]["mission_type"] == "NURTURE"
    assert result["mission_context"]["workflow_state"]["status"] == "PAUSED"
    print("PASS: build_ai_coach_context_v2() additively includes persisted mission context when opportunity_id is supplied")


if __name__ == "__main__":
    mp = _MonkeyPatch()
    try:
        test_persist_batch_result_writes_all_four_tables_in_order(mp)
    finally:
        mp.undo()

    mp = _MonkeyPatch()
    try:
        test_persist_batch_result_skips_empty_sequences(mp)
    finally:
        mp.undo()

    mp = _MonkeyPatch()
    try:
        test_fetch_priority_round_trips(mp)
    finally:
        mp.undo()

    mp = _MonkeyPatch()
    try:
        test_fetch_ranked_opportunities_ordered_by_rank(mp)
    finally:
        mp.undo()

    mp = _MonkeyPatch()
    try:
        test_fetch_mission_round_trips(mp)
    finally:
        mp.undo()

    mp = _MonkeyPatch()
    try:
        test_fetch_mission_returns_none_when_absent(mp)
    finally:
        mp.undo()

    mp = _MonkeyPatch()
    try:
        test_fetch_workflow_state_round_trips(mp)
    finally:
        mp.undo()

    mp = _MonkeyPatch()
    try:
        test_update_workflow_state_upserts_without_session_id(mp)
    finally:
        mp.undo()

    mp = _MonkeyPatch()
    try:
        test_persist_feedback_is_plain_insert(mp)
    finally:
        mp.undo()

    mp = _MonkeyPatch()
    try:
        test_fetch_feedback_for_target_round_trips(mp)
    finally:
        mp.undo()

    mp = _MonkeyPatch()
    try:
        test_evaluate_workflow_v2_reads_persisted_state(mp)
    finally:
        mp.undo()

    mp = _MonkeyPatch()
    try:
        test_evaluate_workflow_v2_raises_when_nothing_persisted(mp)
    finally:
        mp.undo()

    mp = _MonkeyPatch()
    try:
        test_evaluate_mission_intelligence_v2_reads_persisted_state(mp)
    finally:
        mp.undo()

    mp = _MonkeyPatch()
    try:
        test_capture_feedback_v2_persists_via_backend(mp)
    finally:
        mp.undo()

    test_evaluate_analytics_v2_is_unchanged_without_session_id()

    mp = _MonkeyPatch()
    try:
        test_evaluate_analytics_v2_includes_persisted_batch_intelligence(mp)
    finally:
        mp.undo()

    mp = _MonkeyPatch()
    try:
        test_build_ai_coach_context_v2_includes_persisted_mission_context(mp)
    finally:
        mp.undo()

    print("\nAll Persistence Integration milestone validation checks passed.")
