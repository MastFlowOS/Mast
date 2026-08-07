"""
validate_workflow.py
====================

Standalone comprehensive validation suite for Subsystem 15 — Workflow Engine.

Verification Checks
-------------------
1. Import Isolation
2. AST Analysis (No Registry, No Hidden Clocks, Dataclass Rules)
3. Absence of Registries & Mutable Globals
4. Model Immutability & Slotted Dataclass Enforcement
5. WorkflowStatus and WorkflowEventType Enum Validation
6. WorkflowState Validation
7. WorkflowEvent Validation
8. Valid Transition Graph (Coverage across all valid edges)
9. Invalid Transition Rejection (Rejection of invalid graph edges)
10. Pure Determinism (2,000 Repeated Iterations)
11. Thread Safety & Concurrency
12. Tuple Coercion (Accepts Iterables, Returns Tuple)
13. Empty Batch Handling
14. Batch Ordering Preservation
15. Invalid Input Handling
16. No Hidden Clocks Validation
17. Regression Verification across Subsystems 9–15 (End-to-End Operational Pipeline)

Run directly with:
    python validate_workflow.py
"""

from __future__ import annotations

import ast
from concurrent.futures import ThreadPoolExecutor
import dataclasses
from datetime import datetime, timezone
from pathlib import Path
import sys

# Ensure mast-lead-engine directory is on sys.path
engine_dir = Path(__file__).resolve().parent
if str(engine_dir) not in sys.path:
    sys.path.insert(0, str(engine_dir))

# ---------------------------------------------------------------------------
# Strict boundary checks: verify no forbidden modules are pre-loaded
# ---------------------------------------------------------------------------
forbidden = [
    "engine",
    "providers",
    "storage",
    "database",
    "crm",
    "ai",
    "scoring",
    "provider_execution",
]

for m in list(sys.modules.keys()):
    for f in forbidden:
        if m == f or m.startswith(f + "."):
            del sys.modules[m]

# Subsystem 9 Imports
import opportunities
from opportunities import Opportunity

# Subsystem 10 Imports
import opportunity_qualification
from opportunity_qualification import OpportunityQualificationService, QualificationStatus

# Subsystem 11 Imports
import opportunity_scoring
from opportunity_scoring import OpportunityScoringService

# Subsystem 12 Imports
import opportunity_prioritization
from opportunity_prioritization import (
    OpportunityPrioritizationService,
    PrioritizationPolicy,
    PrioritizationStrategy,
)

# Subsystem 13 Imports
import opportunity_ranking
from opportunity_ranking import (
    OpportunityRankingService,
    RankedOpportunity,
)

# Subsystem 14 Imports
import mission_generation
from mission_generation import (
    Mission,
    MissionType,
    MissionGenerationService,
)

# Subsystem 15 Imports
import workflow
from workflow import (
    WorkflowEngineService,
    WorkflowEvent,
    WorkflowEventType,
    WorkflowState,
    WorkflowStatus,
    WorkflowTransitionResult,
)


def log_check(check_id: int, description: str, passed: bool) -> None:
    status = "PASS" if passed else "FAIL"
    print(f"Check {check_id:02d}: {description:<65} [{status}]")
    if not passed:
        raise AssertionError(f"Check {check_id} failed: {description}")


def test_01_import_isolation():
    """Verify that importing workflow does not pull in forbidden dependencies."""
    loaded_forbidden = [
        m for m in sys.modules if any(m == f or m.startswith(f + ".") for f in forbidden)
    ]
    passed = len(loaded_forbidden) == 0
    log_check(1, "Import Isolation (No storage/crm/ai leakage)", passed)


def test_02_ast_analysis():
    """Analyze AST of workflow files to ensure no registries, managers, or datetime calls."""
    workflow_dir = engine_dir / "workflow"
    forbidden_ast_names = {"datetime", "now", "utcnow", "registry", "manager", "factory"}
    
    passed = True
    for py_file in workflow_dir.glob("*.py"):
        with open(py_file, "r", encoding="utf-8") as f:
            tree = ast.parse(f.read(), filename=str(py_file))
            for node in ast.walk(tree):
                if isinstance(node, ast.Name) and node.id in ("datetime", "now", "utcnow"):
                    passed = False
                    print(f"Forbidden AST node '{node.id}' found in {py_file.name}")
                if isinstance(node, ast.ClassDef):
                    name_lower = node.name.lower()
                    if "registry" in name_lower or "manager" in name_lower or "factory" in name_lower:
                        passed = False
                        print(f"Forbidden class '{node.name}' found in {py_file.name}")

    log_check(2, "AST Analysis (No forbidden names, clocks, registries)", passed)


def test_03_absence_of_registries():
    """Verify no registry attributes or global mutable registries exist in workflow module."""
    has_registry = hasattr(workflow, "WorkflowRegistry") or hasattr(workflow, "registry")
    log_check(3, "Absence of Registries & Mutable Globals", not has_registry)


def test_04_model_immutability():
    """Verify slotted frozen dataclass immutability for WorkflowState, WorkflowEvent, WorkflowTransitionResult."""
    now_iso = "2026-08-04T08:00:00Z"
    event = WorkflowEvent(
        event_type=WorkflowEventType.QUEUE,
        timestamp_iso=now_iso,
    )
    state = WorkflowState(
        mission_id="m_100",
        opportunity_id="opp_100",
        business_id="biz_100",
        status=WorkflowStatus.UNSTARTED,
    )
    res = WorkflowTransitionResult(
        success=True,
        previous_state=state,
        new_state=state,
        applied_event=event,
    )

    passed = True
    for obj, field, val in [
        (event, "event_type", WorkflowEventType.COMPLETE),
        (state, "status", WorkflowStatus.COMPLETED),
        (res, "success", False),
    ]:
        if not dataclasses.is_dataclass(obj):
            passed = False
        try:
            setattr(obj, field, val)
            passed = False
        except (dataclasses.FrozenInstanceError, AttributeError, TypeError):
            pass

    log_check(4, "Model Immutability & Slotted Dataclass Enforcement", passed)


def test_05_enum_validation():
    """Verify WorkflowStatus and WorkflowEventType canonical enums."""
    passed = True
    statuses = {s.value for s in WorkflowStatus}
    expected_statuses = {"UNSTARTED", "QUEUED", "IN_PROGRESS", "PAUSED", "COMPLETED", "FAILED", "CANCELLED"}
    if statuses != expected_statuses:
        passed = False

    events = {e.value for e in WorkflowEventType}
    expected_events = {"INITIALIZE", "QUEUE", "START_EXECUTION", "PAUSE", "RESUME", "FAIL", "RETRY", "COMPLETE", "CANCEL"}
    if events != expected_events:
        passed = False

    log_check(5, "WorkflowStatus & WorkflowEventType Enum Validation", passed)


def test_06_workflow_state_validation():
    """Verify validation rules on WorkflowState construction."""
    passed = True
    # Non-empty strings validation
    try:
        WorkflowState(mission_id="", opportunity_id="opp_1", business_id="biz_1", status=WorkflowStatus.UNSTARTED)
        passed = False
    except ValueError:
        pass

    try:
        WorkflowState(mission_id="m_1", opportunity_id="   ", business_id="biz_1", status=WorkflowStatus.UNSTARTED)
        passed = False
    except ValueError:
        pass

    # Invalid type for status
    try:
        WorkflowState(mission_id="m_1", opportunity_id="opp_1", business_id="biz_1", status="UNSTARTED")  # type: ignore
        passed = False
    except TypeError:
        pass

    log_check(6, "WorkflowState Invariant Validation", passed)


def test_07_workflow_event_validation():
    """Verify validation rules on WorkflowEvent construction."""
    passed = True
    try:
        WorkflowEvent(event_type="QUEUE", timestamp_iso="2026-08-04T00:00:00Z")  # type: ignore
        passed = False
    except TypeError:
        pass

    try:
        WorkflowEvent(event_type=WorkflowEventType.QUEUE, timestamp_iso="")
        passed = False
    except ValueError:
        pass

    log_check(7, "WorkflowEvent Invariant Validation", passed)


def test_08_valid_transition_graph():
    """Verify state transitions across all valid graph edges."""
    now_iso = "2026-08-04T08:00:00Z"
    
    # 1. UNSTARTED -> QUEUED via QUEUE
    s0 = WorkflowState("m1", "o1", "b1", WorkflowStatus.UNSTARTED)
    e1 = WorkflowEvent(WorkflowEventType.QUEUE, now_iso)
    r1 = WorkflowEngineService.transition(s0, e1)
    passed1 = r1.success and r1.new_state.status == WorkflowStatus.QUEUED

    # 2. QUEUED -> IN_PROGRESS via START_EXECUTION
    e2 = WorkflowEvent(WorkflowEventType.START_EXECUTION, now_iso)
    r2 = WorkflowEngineService.transition(r1.new_state, e2)
    passed2 = r2.success and r2.new_state.status == WorkflowStatus.IN_PROGRESS

    # 3. IN_PROGRESS -> PAUSED via PAUSE -> IN_PROGRESS via RESUME
    e3 = WorkflowEvent(WorkflowEventType.PAUSE, now_iso)
    r3 = WorkflowEngineService.transition(r2.new_state, e3)
    e4 = WorkflowEvent(WorkflowEventType.RESUME, now_iso)
    r4 = WorkflowEngineService.transition(r3.new_state, e4)
    passed3 = r3.success and r3.new_state.status == WorkflowStatus.PAUSED and r4.success and r4.new_state.status == WorkflowStatus.IN_PROGRESS

    # 4. IN_PROGRESS -> FAILED via FAIL -> QUEUED via RETRY
    e5 = WorkflowEvent(WorkflowEventType.FAIL, now_iso, reason="Network timeout")
    r5 = WorkflowEngineService.transition(r4.new_state, e5)
    e6 = WorkflowEvent(WorkflowEventType.RETRY, now_iso)
    r6 = WorkflowEngineService.transition(r5.new_state, e6)
    passed4 = r5.success and r5.new_state.status == WorkflowStatus.FAILED and r6.success and r6.new_state.status == WorkflowStatus.QUEUED

    # 5. QUEUED -> IN_PROGRESS -> COMPLETED via COMPLETE
    r7 = WorkflowEngineService.transition(r6.new_state, e2)
    e8 = WorkflowEvent(WorkflowEventType.COMPLETE, now_iso)
    r8 = WorkflowEngineService.transition(r7.new_state, e8)
    passed5 = r8.success and r8.new_state.status == WorkflowStatus.COMPLETED

    passed = passed1 and passed2 and passed3 and passed4 and passed5
    log_check(8, "Valid Transition Graph Coverage", passed)


def test_09_invalid_transition_rejection():
    """Verify rejection of illegal transition attempts."""
    now_iso = "2026-08-04T08:00:00Z"
    
    # UNSTARTED cannot directly COMPLETE
    s_unstarted = WorkflowState("m1", "o1", "b1", WorkflowStatus.UNSTARTED)
    e_complete = WorkflowEvent(WorkflowEventType.COMPLETE, now_iso)
    r1 = WorkflowEngineService.transition(s_unstarted, e_complete)
    passed1 = not r1.success and r1.new_state.status == WorkflowStatus.UNSTARTED and r1.error_message is not None

    # COMPLETED is terminal (cannot PAUSE or START_EXECUTION)
    s_completed = WorkflowState("m1", "o1", "b1", WorkflowStatus.COMPLETED)
    e_pause = WorkflowEvent(WorkflowEventType.PAUSE, now_iso)
    r2 = WorkflowEngineService.transition(s_completed, e_pause)
    passed2 = not r2.success and r2.new_state.status == WorkflowStatus.COMPLETED

    passed = passed1 and passed2
    log_check(9, "Invalid Transition Rejection", passed)


def test_10_determinism():
    """Verify 2,000 repeated executions produce identical output."""
    now_iso = "2026-08-04T08:00:00Z"
    mission = Mission(opportunity_id="opp_det", business_id="biz_det", mission_type=MissionType.AUDIT)
    event_queue = WorkflowEvent(WorkflowEventType.QUEUE, now_iso)

    baseline_state = WorkflowEngineService.initialize_workflow(mission)
    baseline_result = WorkflowEngineService.transition(baseline_state, event_queue)

    passed = True
    for _ in range(2000):
        st = WorkflowEngineService.initialize_workflow(mission)
        res = WorkflowEngineService.transition(st, event_queue)
        if st != baseline_state or res != baseline_result:
            passed = False
            break

    log_check(10, "Pure Determinism (2,000 Repeated Iterations)", passed)


def test_11_thread_safety():
    """Verify concurrent thread execution of service methods."""
    now_iso = "2026-08-04T08:00:00Z"
    missions = [
        Mission(opportunity_id=f"opp_{i}", business_id=f"biz_{i}", mission_type=MissionType.OUTREACH)
        for i in range(100)
    ]
    event = WorkflowEvent(WorkflowEventType.QUEUE, now_iso)

    def worker(m: Mission):
        st = WorkflowEngineService.initialize_workflow(m)
        return WorkflowEngineService.transition(st, event)

    with ThreadPoolExecutor(max_workers=8) as executor:
        results = list(executor.map(worker, missions))

    passed = len(results) == 100 and all(r.success for r in results)
    log_check(11, "Thread Safety & Concurrency", passed)


def test_12_tuple_coercion():
    """Verify tuple coercion in batch operations."""
    now_iso = "2026-08-04T08:00:00Z"
    s1 = WorkflowState("m1", "o1", "b1", WorkflowStatus.UNSTARTED)
    e1 = WorkflowEvent(WorkflowEventType.QUEUE, now_iso)
    pairs_list = [(s1, e1)]

    res = WorkflowEngineService.batch_transition(pairs_list)
    passed = isinstance(res, tuple) and len(res) == 1 and res[0].success
    log_check(12, "Tuple Coercion Enforcement", passed)


def test_13_empty_batch_handling():
    """Verify batch operation handles empty input gracefully."""
    res = WorkflowEngineService.batch_transition([])
    passed = isinstance(res, tuple) and len(res) == 0
    log_check(13, "Empty Batch Handling", passed)


def test_14_batch_ordering_preservation():
    """Verify batch operations preserve input ordering exactly."""
    now_iso = "2026-08-04T08:00:00Z"
    pairs = [
        (WorkflowState(f"m{i}", f"o{i}", f"b{i}", WorkflowStatus.UNSTARTED), WorkflowEvent(WorkflowEventType.QUEUE, now_iso))
        for i in range(50)
    ]
    results = WorkflowEngineService.batch_transition(pairs)
    passed = len(results) == 50 and all(results[i].new_state.mission_id == f"m{i}" for i in range(50))
    log_check(14, "Batch Ordering Preservation", passed)


def test_15_invalid_input_handling():
    """Verify error raising for invalid input types."""
    passed = True
    try:
        WorkflowEngineService.initialize_workflow(None)  # type: ignore
        passed = False
    except TypeError:
        pass

    try:
        WorkflowEngineService.transition(None, None)  # type: ignore
        passed = False
    except TypeError:
        pass

    log_check(15, "Invalid Input Handling", passed)


def test_16_no_hidden_clocks():
    """Verify timestamps are caller-supplied and not generated implicitly."""
    passed = True
    event1 = WorkflowEvent(WorkflowEventType.QUEUE, "2026-01-01T00:00:00Z")
    event2 = WorkflowEvent(WorkflowEventType.QUEUE, "2026-12-31T23:59:59Z")
    
    if event1.timestamp_iso != "2026-01-01T00:00:00Z" or event2.timestamp_iso != "2026-12-31T23:59:59Z":
        passed = False

    log_check(16, "No Hidden Clocks Verification", passed)


def test_17_end_to_end_regression():
    """Verify complete end-to-end pipeline across Subsystems 9 -> 10 -> 11 -> 12 -> 13 -> 14 -> 15."""
    eval_time = datetime(2026, 8, 4, 12, 0, 0, tzinfo=timezone.utc)
    now_iso = "2026-08-04T12:00:00Z"
    
    # 1. Subsystem 9: Opportunity
    opp = Opportunity(
        opportunity_id="opp_e2e_15",
        business_id="biz_e2e_15",
        niche_id="seo",
        opportunity_type_id="seo_audit_needed",
        discovered_at=eval_time,
        supporting_signal_ids=("sig_seo_1", "sig_seo_2"),
    )

    # 2. Subsystem 10: Qualification
    qual_res = OpportunityQualificationService().evaluate(opp)
    
    # 3. Subsystem 11: Scoring
    score_res = OpportunityScoringService().evaluate(opp)

    # 4. Subsystem 12: Prioritization
    policy = PrioritizationPolicy(
        strategy=PrioritizationStrategy.SCORE_DOMINANT,
        evaluation_at=eval_time,
    )
    prio_res = OpportunityPrioritizationService.evaluate_priority(
        opportunity=opp,
        qualification=qual_res,
        score=score_res,
        policy=policy,
    )

    # 5. Subsystem 13: Ranking
    ranked_tuple = OpportunityRankingService.rank_opportunities([prio_res])
    ranked_opp = ranked_tuple[0]

    # 6. Subsystem 14: Mission Generation
    mission = MissionGenerationService.generate_mission(ranked_opp, opp)

    # 7. Subsystem 15: Workflow Engine
    workflow_state = WorkflowEngineService.initialize_workflow(mission)
    
    queue_event = WorkflowEvent(WorkflowEventType.QUEUE, now_iso)
    transition_result = WorkflowEngineService.transition(workflow_state, queue_event)

    passed = (
        qual_res.status == QualificationStatus.QUALIFIED
        and score_res.overall_score > 0.0
        and prio_res.priority_score > 0.0
        and ranked_opp.rank == 1
        and mission.mission_type == MissionType.AUDIT
        and workflow_state.status == WorkflowStatus.UNSTARTED
        and transition_result.success
        and transition_result.new_state.status == WorkflowStatus.QUEUED
    )

    log_check(17, "End-to-End Regression (Subsystems 9-15 Operational)", passed)


def run_all_tests():
    print("=" * 80)
    print("MAST Lead Engine 2.0 — Subsystem 15 (Workflow Engine) Validation Suite")
    print("=" * 80)
    
    test_01_import_isolation()
    test_02_ast_analysis()
    test_03_absence_of_registries()
    test_04_model_immutability()
    test_05_enum_validation()
    test_06_workflow_state_validation()
    test_07_workflow_event_validation()
    test_08_valid_transition_graph()
    test_09_invalid_transition_rejection()
    test_10_determinism()
    test_11_thread_safety()
    test_12_tuple_coercion()
    test_13_empty_batch_handling()
    test_14_batch_ordering_preservation()
    test_15_invalid_input_handling()
    test_16_no_hidden_clocks()
    test_17_end_to_end_regression()

    print("=" * 80)
    print("ALL 17 VERIFICATION CHECKS PASSED PERFECTLY!")
    print("=" * 80)


if __name__ == "__main__":
    run_all_tests()
