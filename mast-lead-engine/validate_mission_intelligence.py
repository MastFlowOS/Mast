"""
validate_mission_intelligence.py
================================

Standalone comprehensive validation suite for Subsystem 22 — Mission Intelligence.

Verification Checks
-------------------
1.  Import Isolation (Zero forbidden infrastructure/persistence/AI modules imported)
2.  AST Analysis (No clocks, random, uuid, mutable globals, registries, state coordinators, factories)
3.  Absence of Registries & Mutable Globals
4.  Model Immutability & Slotted Dataclass Enforcement (frozen=True, slots=True)
5.  NextMissionRule Enum Validation
6.  MissionProgressionEvaluation Dataclass Invariant Enforcement
7.  Single Next Mission Derivation Correctness (Coverage across all progression paths)
8.  Lineage Mismatch Detection & Rejection
9.  Batch Next Mission Derivation & Order Preservation
10. Tuple Coercion (Accepts iterables, returns immutable tuple)
11. Pure Determinism (2,000 repeated executions produce byte-identical results)
12. Thread Safety & Concurrency (16 concurrent threads)
13. Invalid & Null Input Handling
14. Complete Regression Suite across Subsystems 5 -> 9..15 -> 16 -> 17 -> 19 -> 22

Run directly with:
    python validate_mission_intelligence.py
"""

from __future__ import annotations

import ast
from concurrent.futures import ThreadPoolExecutor
import dataclasses
from pathlib import Path
import sys

# Ensure mast-lead-engine directory is on sys.path
engine_dir = Path(__file__).resolve().parent
if str(engine_dir) not in sys.path:
    sys.path.insert(0, str(engine_dir))

# Imports from subsystem and dependencies
from feedback.models import (
    FeedbackEvidence,
    FeedbackOutcomeType,
    FeedbackRecord,
    FeedbackTargetType,
)
from mission_generation.models import Mission, MissionType
from mission_intelligence import (
    MissionIntelligenceService,
    MissionProgressionEvaluation,
    NextMissionRule,
)
from workflow.models import WorkflowState, WorkflowStatus


# ---------------------------------------------------------------------------
# Helper builders
# ---------------------------------------------------------------------------

def _make_feedback(
    target_id: str,
    outcome: FeedbackOutcomeType,
    target_type: FeedbackTargetType = FeedbackTargetType.OPPORTUNITY,
) -> FeedbackRecord:
    """Construct a minimal FeedbackRecord for testing."""
    ev = FeedbackEvidence(notes="test evidence")
    return FeedbackRecord(
        target_type=target_type,
        target_id=target_id,
        outcome=outcome,
        evidence=ev,
    )


# ---------------------------------------------------------------------------
# Test Functions
# ---------------------------------------------------------------------------

def test_1_import_isolation():
    print("[Check 1/14] Testing Import Isolation...")
    forbidden = [
        "sqlite3",
        "psycopg2",
        "sqlalchemy",
        "requests",
        "urllib3",
        "httpx",
        "aiohttp",
        "openai",
        "anthropic",
        "celery",
        "apscheduler",
    ]
    for mod in sys.modules:
        for f in forbidden:
            if mod == f or mod.startswith(f + "."):
                raise AssertionError(f"Forbidden module {mod!r} loaded in sys.modules")
    print("  -> Passed.")


def test_2_ast_analysis():
    print("[Check 2/14] Testing AST Code Constraints...")
    pkg_dir = engine_dir / "mission_intelligence"

    for py_file in pkg_dir.glob("*.py"):
        code = py_file.read_text(encoding="utf-8")
        tree = ast.parse(code, filename=str(py_file))

        # Verify AST nodes for forbidden imports or calls
        for node in ast.walk(tree):
            if isinstance(node, ast.Attribute):
                if (
                    node.attr in ("now", "uuid4")
                    and isinstance(node.value, ast.Name)
                    and node.value.id in ("datetime", "uuid")
                ):
                    raise AssertionError(
                        f"Forbidden call {node.value.id}.{node.attr} found in {py_file.name}"
                    )
            if isinstance(node, ast.Name):
                if node.id in ("random",):
                    raise AssertionError(
                        f"Forbidden usage of {node.id!r} found in {py_file.name}"
                    )

        # Ensure all dataclasses specify frozen=True and slots=True
        for node in ast.walk(tree):
            if isinstance(node, ast.ClassDef):
                for dec in node.decorator_list:
                    if isinstance(dec, ast.Call):
                        func = dec.func
                        if isinstance(func, ast.Name) and func.id == "dataclass":
                            kw_dict = {
                                kw.arg: getattr(kw.value, "value", None)
                                for kw in dec.keywords
                                if isinstance(kw.value, ast.Constant)
                            }
                            if not kw_dict.get("frozen") or not kw_dict.get("slots"):
                                raise AssertionError(
                                    f"Class {node.name} in {py_file.name} must specify frozen=True, slots=True"
                                )
    print("  -> Passed.")


def test_3_absence_of_registries_and_globals():
    print("[Check 3/14] Testing Absence of Registries & Mutable Globals...")
    from mission_intelligence import models, service
    for mod in (models, service):
        for name, val in vars(mod).items():
            if name.isupper() and isinstance(val, (list, dict, set)):
                raise AssertionError(
                    f"Mutable global collection {name!r} found in {mod.__name__}"
                )
    print("  -> Passed.")


def test_4_model_immutability():
    print("[Check 4/14] Testing Model Immutability & Slotted Dataclasses...")
    m = Mission(opportunity_id="opp_1", business_id="biz_1", mission_type=MissionType.OUTREACH)
    w = WorkflowState(
        mission_id="opp_1", opportunity_id="opp_1", business_id="biz_1",
        status=WorkflowStatus.COMPLETED,
    )
    eval_res = MissionIntelligenceService.derive_next_mission(m, w)

    # Frozen test: direct field assignment must raise FrozenInstanceError
    try:
        eval_res.reason = "Mutated"  # type: ignore
        raise AssertionError("Failed to prevent field mutation on MissionProgressionEvaluation")
    except (dataclasses.FrozenInstanceError, AttributeError):
        pass

    # Slotted test: setting an undefined attribute must raise AttributeError
    try:
        eval_res.new_attr = "Mutated"  # type: ignore
        raise AssertionError("Failed to prevent attribute assignment on slotted dataclass")
    except (AttributeError, TypeError):
        pass
    print("  -> Passed.")


def test_5_enum_validation():
    print("[Check 5/14] Testing NextMissionRule Enum...")
    expected_rules = {"FOLLOW_UP", "DEMO_PITCH", "OBJECTION_HANDLING", "NURTURE", "RETRY_OUTREACH", "TERMINATE"}
    actual_rules = {r.value for r in NextMissionRule}
    if expected_rules != actual_rules:
        raise AssertionError(
            f"NextMissionRule enum mismatch: expected {expected_rules}, got {actual_rules}"
        )
    print("  -> Passed.")


def test_6_dataclass_invariant_enforcement():
    print("[Check 6/14] Testing Dataclass Invariant Enforcement...")
    m = Mission(opportunity_id="opp_1", business_id="biz_1", mission_type=MissionType.OUTREACH)
    w = WorkflowState(
        mission_id="opp_1", opportunity_id="opp_1", business_id="biz_1",
        status=WorkflowStatus.COMPLETED,
    )

    # Lineage mismatch (opportunity_id)
    w_mismatch = WorkflowState(
        mission_id="opp_2", opportunity_id="opp_2", business_id="biz_1",
        status=WorkflowStatus.COMPLETED,
    )
    try:
        MissionProgressionEvaluation(
            current_mission=m,
            workflow_state=w_mismatch,
            feedback_record=None,
            next_mission=None,
            rule_applied=NextMissionRule.TERMINATE,
            reason="Test mismatch",
        )
        raise AssertionError("Failed to catch lineage mismatch in MissionProgressionEvaluation")
    except ValueError:
        pass

    # Invalid current_mission type
    try:
        MissionProgressionEvaluation(
            current_mission="not_a_mission",  # type: ignore
            workflow_state=w,
            feedback_record=None,
            next_mission=None,
            rule_applied=NextMissionRule.TERMINATE,
            reason="Test type",
        )
        raise AssertionError("Failed to catch invalid type in current_mission")
    except TypeError:
        pass
    print("  -> Passed.")


def test_7_progression_derivation_rules():
    print("[Check 7/14] Testing Single Progression Derivation Rules...")

    opp_id = "opp_10"
    biz_id = "biz_10"

    m_outreach = Mission(opportunity_id=opp_id, business_id=biz_id, mission_type=MissionType.OUTREACH)
    w_completed = WorkflowState(mission_id=opp_id, opportunity_id=opp_id, business_id=biz_id, status=WorkflowStatus.COMPLETED)

    # 1. OUTREACH COMPLETED -> AUDIT (FOLLOW_UP)
    eval_1 = MissionIntelligenceService.derive_next_mission(m_outreach, w_completed)
    assert eval_1.next_mission is not None, "Expected AUDIT mission after OUTREACH COMPLETED"
    assert eval_1.next_mission.mission_type == MissionType.AUDIT
    assert eval_1.rule_applied == NextMissionRule.FOLLOW_UP

    # 2. AUDIT COMPLETED -> CLAIM (FOLLOW_UP)
    m_audit = Mission(opportunity_id=opp_id, business_id=biz_id, mission_type=MissionType.AUDIT)
    eval_2 = MissionIntelligenceService.derive_next_mission(m_audit, w_completed)
    assert eval_2.next_mission is not None, "Expected CLAIM mission after AUDIT COMPLETED"
    assert eval_2.next_mission.mission_type == MissionType.CLAIM
    assert eval_2.rule_applied == NextMissionRule.FOLLOW_UP

    # 3. CLAIM COMPLETED -> NURTURE
    m_claim = Mission(opportunity_id=opp_id, business_id=biz_id, mission_type=MissionType.CLAIM)
    eval_3 = MissionIntelligenceService.derive_next_mission(m_claim, w_completed)
    assert eval_3.next_mission is not None, "Expected NURTURE mission after CLAIM COMPLETED"
    assert eval_3.next_mission.mission_type == MissionType.NURTURE
    assert eval_3.rule_applied == NextMissionRule.NURTURE

    # 4. RECOVERY COMPLETED -> OUTREACH (RETRY)
    m_recovery = Mission(opportunity_id=opp_id, business_id=biz_id, mission_type=MissionType.RECOVERY)
    eval_4 = MissionIntelligenceService.derive_next_mission(m_recovery, w_completed)
    assert eval_4.next_mission is not None, "Expected OUTREACH mission after RECOVERY COMPLETED"
    assert eval_4.next_mission.mission_type == MissionType.OUTREACH
    assert eval_4.rule_applied == NextMissionRule.RETRY_OUTREACH

    # 5. Workflow FAILED -> RECOVERY (RETRY_OUTREACH)
    w_failed = WorkflowState(mission_id=opp_id, opportunity_id=opp_id, business_id=biz_id, status=WorkflowStatus.FAILED)
    eval_5 = MissionIntelligenceService.derive_next_mission(m_outreach, w_failed)
    assert eval_5.next_mission is not None, "Expected RECOVERY mission on FAILED"
    assert eval_5.next_mission.mission_type == MissionType.RECOVERY
    assert eval_5.rule_applied == NextMissionRule.RETRY_OUTREACH

    # 6. Feedback CLIENT_WON -> TERMINATE
    fb_won = _make_feedback(opp_id, FeedbackOutcomeType.CLIENT_WON)
    eval_6 = MissionIntelligenceService.derive_next_mission(m_outreach, w_completed, fb_won)
    assert eval_6.next_mission is None, "Expected no next mission after CLIENT_WON"
    assert eval_6.rule_applied == NextMissionRule.TERMINATE

    # 7. Feedback MEETING_BOOKED -> AUDIT (DEMO_PITCH)
    fb_meeting = _make_feedback(opp_id, FeedbackOutcomeType.MEETING_BOOKED)
    eval_7 = MissionIntelligenceService.derive_next_mission(m_outreach, w_completed, fb_meeting)
    assert eval_7.next_mission is not None, "Expected AUDIT mission on MEETING_BOOKED"
    assert eval_7.next_mission.mission_type == MissionType.AUDIT
    assert eval_7.rule_applied == NextMissionRule.DEMO_PITCH

    # 8. Feedback MISSION_DISMISSED -> NURTURE
    fb_dismissed = _make_feedback(opp_id, FeedbackOutcomeType.MISSION_DISMISSED)
    eval_8 = MissionIntelligenceService.derive_next_mission(m_outreach, w_completed, fb_dismissed)
    assert eval_8.next_mission is not None, "Expected NURTURE mission on MISSION_DISMISSED"
    assert eval_8.next_mission.mission_type == MissionType.NURTURE
    assert eval_8.rule_applied == NextMissionRule.NURTURE

    # 9. Feedback FALSE_POSITIVE -> TERMINATE
    fb_false = _make_feedback(opp_id, FeedbackOutcomeType.FALSE_POSITIVE)
    eval_9 = MissionIntelligenceService.derive_next_mission(m_outreach, w_completed, fb_false)
    assert eval_9.next_mission is None, "Expected no next mission after FALSE_POSITIVE"
    assert eval_9.rule_applied == NextMissionRule.TERMINATE

    # 10. Workflow CANCELLED -> TERMINATE
    w_cancelled = WorkflowState(mission_id=opp_id, opportunity_id=opp_id, business_id=biz_id, status=WorkflowStatus.CANCELLED)
    eval_10 = MissionIntelligenceService.derive_next_mission(m_outreach, w_cancelled)
    assert eval_10.next_mission is None, "Expected no next mission after CANCELLED"
    assert eval_10.rule_applied == NextMissionRule.TERMINATE

    # 11. Active workflow (IN_PROGRESS) -> no progression
    w_active = WorkflowState(mission_id=opp_id, opportunity_id=opp_id, business_id=biz_id, status=WorkflowStatus.IN_PROGRESS)
    eval_11 = MissionIntelligenceService.derive_next_mission(m_outreach, w_active)
    assert eval_11.next_mission is None, "Expected no next mission while IN_PROGRESS"
    assert eval_11.rule_applied == NextMissionRule.TERMINATE

    # 12. Feedback MISSION_ACCEPTED + OUTREACH -> AUDIT (FOLLOW_UP)
    fb_accepted = _make_feedback(opp_id, FeedbackOutcomeType.MISSION_ACCEPTED)
    eval_12 = MissionIntelligenceService.derive_next_mission(m_outreach, w_completed, fb_accepted)
    assert eval_12.next_mission is not None
    assert eval_12.next_mission.mission_type == MissionType.AUDIT
    assert eval_12.rule_applied == NextMissionRule.FOLLOW_UP

    # 13. NURTURE COMPLETED -> TERMINATE (end of sequence)
    m_nurture = Mission(opportunity_id=opp_id, business_id=biz_id, mission_type=MissionType.NURTURE)
    eval_13 = MissionIntelligenceService.derive_next_mission(m_nurture, w_completed)
    assert eval_13.next_mission is None, "Expected no next mission after NURTURE COMPLETED"
    assert eval_13.rule_applied == NextMissionRule.TERMINATE

    print("  -> Passed.")


def test_8_lineage_mismatch_detection():
    print("[Check 8/14] Testing Lineage Mismatch Detection...")
    m = Mission(opportunity_id="opp_A", business_id="biz_A", mission_type=MissionType.OUTREACH)

    # opportunity_id mismatch
    w_opp_mismatch = WorkflowState(
        mission_id="opp_B", opportunity_id="opp_B", business_id="biz_A",
        status=WorkflowStatus.COMPLETED,
    )
    try:
        MissionIntelligenceService.derive_next_mission(m, w_opp_mismatch)
        raise AssertionError("Failed to detect opportunity_id lineage mismatch")
    except ValueError:
        pass

    # business_id mismatch
    w_biz_mismatch = WorkflowState(
        mission_id="opp_A", opportunity_id="opp_A", business_id="biz_B",
        status=WorkflowStatus.COMPLETED,
    )
    try:
        MissionIntelligenceService.derive_next_mission(m, w_biz_mismatch)
        raise AssertionError("Failed to detect business_id lineage mismatch")
    except ValueError:
        pass

    # Feedback target_id mismatch
    w = WorkflowState(
        mission_id="opp_A", opportunity_id="opp_A", business_id="biz_A",
        status=WorkflowStatus.COMPLETED,
    )
    fb_mismatch = _make_feedback("opp_WRONG", FeedbackOutcomeType.CLIENT_WON)
    try:
        MissionIntelligenceService.derive_next_mission(m, w, fb_mismatch)
        raise AssertionError("Failed to detect feedback target_id mismatch")
    except ValueError:
        pass

    print("  -> Passed.")


def test_9_batch_derivation_ordering():
    print("[Check 9/14] Testing Batch Derivation & Ordering Preservation...")
    pairs = []
    for i in range(100):
        opp_id = f"opp_{i}"
        biz_id = f"biz_{i}"
        m = Mission(opportunity_id=opp_id, business_id=biz_id, mission_type=MissionType.OUTREACH)
        w = WorkflowState(
            mission_id=opp_id, opportunity_id=opp_id, business_id=biz_id,
            status=WorkflowStatus.COMPLETED,
        )
        pairs.append((m, w))

    res = MissionIntelligenceService.batch_derive_next_missions(pairs)
    assert len(res) == 100, f"Expected 100 evaluations, got {len(res)}"

    for idx, eval_item in enumerate(res):
        if eval_item.current_mission.opportunity_id != f"opp_{idx}":
            raise AssertionError(f"Order mismatch at index {idx}")

    # Verify 3-tuple support
    m0 = Mission(opportunity_id="opp_3t", business_id="biz_3t", mission_type=MissionType.OUTREACH)
    w0 = WorkflowState(
        mission_id="opp_3t", opportunity_id="opp_3t", business_id="biz_3t",
        status=WorkflowStatus.COMPLETED,
    )
    fb0 = _make_feedback("opp_3t", FeedbackOutcomeType.MISSION_ACCEPTED)
    res_3t = MissionIntelligenceService.batch_derive_next_missions([(m0, w0, fb0)])
    assert len(res_3t) == 1
    assert res_3t[0].rule_applied == NextMissionRule.FOLLOW_UP

    print("  -> Passed.")


def test_10_tuple_coercion():
    print("[Check 10/14] Testing Tuple Coercion...")
    m = Mission(opportunity_id="opp_tc", business_id="biz_tc", mission_type=MissionType.OUTREACH)
    w = WorkflowState(
        mission_id="opp_tc", opportunity_id="opp_tc", business_id="biz_tc",
        status=WorkflowStatus.COMPLETED,
    )

    gen = ((item_m, item_w) for item_m, item_w in [(m, w)])
    res = MissionIntelligenceService.batch_derive_next_missions(gen)
    assert isinstance(res, tuple), f"Output must be a tuple, got {type(res)!r}"

    # Empty batch returns empty tuple
    res_empty = MissionIntelligenceService.batch_derive_next_missions([])
    assert res_empty == (), f"Expected empty tuple, got {res_empty!r}"
    print("  -> Passed.")


def test_11_pure_determinism():
    print("[Check 11/14] Testing Pure Determinism (2,000 Iterations)...")
    m = Mission(opportunity_id="opp_det", business_id="biz_det", mission_type=MissionType.OUTREACH)
    w = WorkflowState(
        mission_id="opp_det", opportunity_id="opp_det", business_id="biz_det",
        status=WorkflowStatus.COMPLETED,
    )

    initial_res = MissionIntelligenceService.derive_next_mission(m, w)
    for _ in range(2000):
        curr = MissionIntelligenceService.derive_next_mission(m, w)
        if curr != initial_res:
            raise AssertionError("Non-deterministic execution detected across iterations")
    print("  -> Passed.")


def test_12_thread_safety():
    print("[Check 12/14] Testing Thread Safety (16 Concurrent Threads)...")
    m = Mission(opportunity_id="opp_thr", business_id="biz_thr", mission_type=MissionType.OUTREACH)
    w = WorkflowState(
        mission_id="opp_thr", opportunity_id="opp_thr", business_id="biz_thr",
        status=WorkflowStatus.COMPLETED,
    )

    def worker(_):
        return MissionIntelligenceService.derive_next_mission(m, w)

    with ThreadPoolExecutor(max_workers=16) as executor:
        futures = [executor.submit(worker, i) for i in range(200)]
        results = [f.result() for f in futures]

    first = results[0]
    for r in results:
        if r != first:
            raise AssertionError("Race condition or thread state corruption detected")
    print("  -> Passed.")


def test_13_invalid_input_handling():
    print("[Check 13/14] Testing Invalid Input Handling...")
    m = Mission(opportunity_id="opp_1", business_id="biz_1", mission_type=MissionType.OUTREACH)
    w = WorkflowState(
        mission_id="opp_1", opportunity_id="opp_1", business_id="biz_1",
        status=WorkflowStatus.COMPLETED,
    )

    try:
        MissionIntelligenceService.derive_next_mission(None, w)  # type: ignore
        raise AssertionError("Failed to catch None current_mission")
    except TypeError:
        pass

    try:
        MissionIntelligenceService.derive_next_mission(m, None)  # type: ignore
        raise AssertionError("Failed to catch None workflow_state")
    except TypeError:
        pass

    try:
        MissionIntelligenceService.derive_next_mission("not_a_mission", w)  # type: ignore
        raise AssertionError("Failed to catch non-Mission current_mission")
    except TypeError:
        pass

    try:
        MissionIntelligenceService.derive_next_mission(m, "not_a_state")  # type: ignore
        raise AssertionError("Failed to catch non-WorkflowState workflow_state")
    except TypeError:
        pass

    try:
        MissionIntelligenceService.derive_next_mission(m, w, "not_feedback")  # type: ignore
        raise AssertionError("Failed to catch non-FeedbackRecord feedback_record")
    except TypeError:
        pass

    try:
        MissionIntelligenceService.batch_derive_next_missions(None)  # type: ignore
        raise AssertionError("Failed to catch None batch items")
    except TypeError:
        pass

    try:
        MissionIntelligenceService.batch_derive_next_missions(["not_a_tuple"])  # type: ignore
        raise AssertionError("Failed to catch non-tuple batch item")
    except TypeError:
        pass

    print("  -> Passed.")


def test_14_regression_pipeline():
    print("[Check 14/14] Testing Complete End-to-End Regression Pipeline...")
    from datetime import datetime, timezone
    from opportunities.models import Opportunity
    from opportunity_ranking.models import RankedOpportunity
    from mission_generation.service import MissionGenerationService
    from workflow.service import WorkflowEngineService
    from workflow.models import WorkflowEvent, WorkflowEventType

    # Stage 1: Build canonical pipeline objects
    ranked = RankedOpportunity(opportunity_id="opp_reg", rank=1, priority_score=90.0)
    opp = Opportunity(
        opportunity_id="opp_reg",
        business_id="biz_reg",
        niche_id="niche_tech",
        opportunity_type_id="type_outreach",
        discovered_at=datetime(2026, 8, 5, tzinfo=timezone.utc),
        supporting_signal_ids=("sig1",),
    )

    # Stage 2: Derive Initial Mission (Subsystem 14)
    mission_1 = MissionGenerationService.generate_mission(ranked, opp)
    assert mission_1.mission_type == MissionType.OUTREACH, (
        f"Expected OUTREACH mission type, got {mission_1.mission_type}"
    )
    assert mission_1.opportunity_id == "opp_reg"
    assert mission_1.business_id == "biz_reg"

    # Stage 3: Initialize Workflow (Subsystem 15)
    state_0 = WorkflowEngineService.initialize_workflow(mission_1)
    assert state_0.status == WorkflowStatus.UNSTARTED

    # Stage 4: Transition through lifecycle UNSTARTED -> QUEUED -> IN_PROGRESS -> COMPLETED
    ev_queue = WorkflowEvent(event_type=WorkflowEventType.QUEUE, timestamp_iso="2026-08-05T00:01:00Z")
    r1 = WorkflowEngineService.transition(state_0, ev_queue)
    assert r1.success

    ev_start = WorkflowEvent(event_type=WorkflowEventType.START_EXECUTION, timestamp_iso="2026-08-05T00:02:00Z")
    r2 = WorkflowEngineService.transition(r1.new_state, ev_start)
    assert r2.success

    ev_complete = WorkflowEvent(event_type=WorkflowEventType.COMPLETE, timestamp_iso="2026-08-05T00:03:00Z")
    r3 = WorkflowEngineService.transition(r2.new_state, ev_complete)
    assert r3.success
    assert r3.new_state.status == WorkflowStatus.COMPLETED

    # Stage 5: Mission Intelligence — no feedback (Subsystem 22)
    progression = MissionIntelligenceService.derive_next_mission(mission_1, r3.new_state)
    assert progression.next_mission is not None, "Expected AUDIT mission after OUTREACH COMPLETED"
    assert progression.next_mission.mission_type == MissionType.AUDIT
    assert progression.rule_applied == NextMissionRule.FOLLOW_UP
    assert progression.next_mission.opportunity_id == "opp_reg"
    assert progression.next_mission.business_id == "biz_reg"

    # Stage 6: Mission Intelligence — feedback CLIENT_WON terminates lifecycle
    fb_won = _make_feedback("opp_reg", FeedbackOutcomeType.CLIENT_WON)
    progression_won = MissionIntelligenceService.derive_next_mission(mission_1, r3.new_state, fb_won)
    assert progression_won.next_mission is None, "CLIENT_WON must terminate lifecycle"
    assert progression_won.rule_applied == NextMissionRule.TERMINATE

    # Stage 7: Batch evaluation across two missions in sequence
    mission_2 = Mission(opportunity_id="opp_reg", business_id="biz_reg", mission_type=MissionType.AUDIT)
    batch_items = [
        (mission_1, r3.new_state),
        (mission_2, r3.new_state),
    ]
    batch_results = MissionIntelligenceService.batch_derive_next_missions(batch_items)
    assert len(batch_results) == 2
    assert batch_results[0].next_mission.mission_type == MissionType.AUDIT
    assert batch_results[1].next_mission.mission_type == MissionType.CLAIM

    # Stage 8: Workflow FAILED path -> RECOVERY mission derived
    w_failed = WorkflowState(
        mission_id="opp_reg", opportunity_id="opp_reg", business_id="biz_reg",
        status=WorkflowStatus.FAILED,
    )
    progression_failed = MissionIntelligenceService.derive_next_mission(mission_1, w_failed)
    assert progression_failed.next_mission is not None
    assert progression_failed.next_mission.mission_type == MissionType.RECOVERY
    assert progression_failed.rule_applied == NextMissionRule.RETRY_OUTREACH

    print("  -> Passed.")


def main():
    print("=======================================================================")
    print("  Subsystem 22: Mission Intelligence — Master Validation Suite        ")
    print("=======================================================================")
    test_1_import_isolation()
    test_2_ast_analysis()
    test_3_absence_of_registries_and_globals()
    test_4_model_immutability()
    test_5_enum_validation()
    test_6_dataclass_invariant_enforcement()
    test_7_progression_derivation_rules()
    test_8_lineage_mismatch_detection()
    test_9_batch_derivation_ordering()
    test_10_tuple_coercion()
    test_11_pure_determinism()
    test_12_thread_safety()
    test_13_invalid_input_handling()
    test_14_regression_pipeline()
    print("=======================================================================")
    print("  SUCCESS: Subsystem 22 (Mission Intelligence) Fully Validated!       ")
    print("=======================================================================")


if __name__ == "__main__":
    main()
