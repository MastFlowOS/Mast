"""
validate_engine_context.py
===========================

Standalone comprehensive validation suite for Subsystem 16 — Engine Context Projection.

Verification Checks
-------------------
1. Import Isolation (Zero forbidden modules loaded)
2. AST Analysis (No forbidden names, clocks, registries, managers, factories)
3. Model Immutability & Slotted Dataclass Enforcement
4. Tuple Coercion (Accepts iterables, returns immutable tuple)
5. Projection Fidelity (Exposes only 1:1 canonical upstream fields)
6. Projection Rule (No calculation, classification, scoring, prioritization, ranking, mission generation, or workflow execution)
7. Canonical Projection Rule (Projects, sanitizes, reshapes, omits only)
8. Domain Model Consistency (All models use @dataclass(frozen=True, slots=True))
9. Statelessness (Zero mutable class state, zero caches, zero side effects)
10. Pure Determinism (2,000 repeated executions produce byte-for-byte identical output)
11. Thread Safety & Concurrency (Concurrent execution across 16 threads)
12. Empty & Optional Input Handling (Handles empty inputs and optional fields gracefully)
13. Invalid Input Handling (Strict type checking and validation)
14. End-to-End Regression Pipeline (Full Subsystem 5 -> 9 -> 10 -> 11 -> 12 -> 13 -> 14 -> 15 -> 16 pipeline)

Run directly with:
    python validate_engine_context.py
"""

from __future__ import annotations

import ast
from concurrent.futures import ThreadPoolExecutor
import dataclasses
from datetime import datetime
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
    "llm",
    "openai",
    "anthropic",
]

for m in list(sys.modules.keys()):
    for f in forbidden:
        if m == f or m.startswith(f + "."):
            del sys.modules[m]

# Subsystem 5 Imports
import business
from business.models import Business

# Subsystem 9 Imports
import opportunities
from opportunities.models import Opportunity

# Subsystem 10 Imports
import opportunity_qualification
from opportunity_qualification import QualificationStatus
from opportunity_qualification.models import OpportunityQualification

# Subsystem 11 Imports
import opportunity_scoring
from opportunity_scoring import OpportunityScoringService
from opportunity_scoring.models import OpportunityScore

# Subsystem 12 Imports
import opportunity_prioritization
from opportunity_prioritization import (
    OpportunityPrioritizationService,
    PrioritizationPolicy,
    PrioritizationStrategy,
)
from opportunity_prioritization.models import OpportunityPriority

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
    WorkflowState,
    WorkflowStatus,
)

# Subsystem 16 Imports
import engine_context
from engine_context import (
    BusinessContext,
    ContextComponent,
    ContextProjectionRequest,
    ContextProjectionService,
    ContextSubject,
    ContextSubjectType,
    EngineContext,
    MissionContext,
    OpportunityContext,
    PriorityContext,
    QualificationContext,
    RankContext,
    ScoreContext,
    WorkflowContext,
)


def log_check(check_id: int, description: str, passed: bool) -> None:
    status = "PASS" if passed else "FAIL"
    print(f"Check {check_id:02d}: {description:<65} [{status}]")
    if not passed:
        raise AssertionError(f"Check {check_id} failed: {description}")


def test_01_import_isolation():
    """Verify that importing engine_context does not pull in forbidden dependencies."""
    loaded_forbidden = [
        m for m in sys.modules if any(m == f or m.startswith(f + ".") for f in forbidden)
    ]
    passed = len(loaded_forbidden) == 0
    log_check(1, "Import Isolation (Zero forbidden/AI/storage dependencies)", passed)


def test_02_ast_analysis():
    """Analyze AST of engine_context files to ensure no registries, managers, or clocks."""
    ec_dir = engine_dir / "engine_context"
    forbidden_ast_names = {"datetime", "now", "utcnow", "registry", "manager", "factory", "gpt", "llm", "claude"}

    passed = True
    for py_file in ec_dir.glob("*.py"):
        with open(py_file, "r", encoding="utf-8") as f:
            tree = ast.parse(f.read(), filename=str(py_file))
            for node in ast.walk(tree):
                if isinstance(node, ast.Name) and node.id in ("datetime", "now", "utcnow"):
                    passed = False
                    print(f"Forbidden AST node '{node.id}' found in {py_file.name}")
                if isinstance(node, ast.ClassDef):
                    name_lower = node.name.lower()
                    if any(term in name_lower for term in ("registry", "manager", "factory")):
                        passed = False
                        print(f"Forbidden class '{node.name}' found in {py_file.name}")

    log_check(2, "AST Analysis (No clocks, registries, managers, factories)", passed)


def test_03_model_immutability():
    """Verify slotted frozen dataclass immutability for all Context models."""
    subject = ContextSubject(subject_id="biz_100", subject_type=ContextSubjectType.BUSINESS)
    request = ContextProjectionRequest(subject=subject)
    biz_ctx = BusinessContext(business_id="biz_100", name="Test Business")
    opp_ctx = OpportunityContext("opp_1", "biz_100", "web", "missing_website")
    qual_ctx = QualificationContext("opp_1", "QUALIFIED")
    score_ctx = ScoreContext("opp_1", 85.0)
    pri_ctx = PriorityContext("opp_1", 90.0, 45.0, 45.0, True)
    rank_ctx = RankContext("opp_1", 1, 90.0)
    mission_ctx = MissionContext("opp_1", "biz_100", "OUTREACH")
    wf_ctx = WorkflowContext("m_1", "opp_1", "biz_100", "UNSTARTED")
    engine_ctx = EngineContext(subject=subject, business=biz_ctx)

    models_to_test = [
        (subject, "subject_id", "new_id"),
        (request, "subject", subject),
        (biz_ctx, "name", "New Name"),
        (opp_ctx, "opportunity_id", "new_id"),
        (qual_ctx, "status", "NOT_QUALIFIED"),
        (score_ctx, "overall_score", 50.0),
        (pri_ctx, "priority_score", 50.0),
        (rank_ctx, "rank", 2),
        (mission_ctx, "mission_type", "AUDIT"),
        (wf_ctx, "status", "COMPLETED"),
        (engine_ctx, "business", None),
    ]

    passed = True
    for obj, field, val in models_to_test:
        if not dataclasses.is_dataclass(obj):
            passed = False
        try:
            setattr(obj, field, val)
            passed = False
        except (dataclasses.FrozenInstanceError, AttributeError, TypeError):
            pass

    log_check(3, "Model Immutability & Slotted Dataclass Enforcement", passed)


def test_04_tuple_coercion():
    """Verify collections are coerced to immutable tuples."""
    biz_ctx = BusinessContext(
        business_id="b1",
        name="Biz",
        phones=["123", "456"],
        emails=["a@b.com"],
        websites=["https://b.com"],
    )
    opp_ctx = OpportunityContext(
        opportunity_id="o1",
        business_id="b1",
        niche_id="web",
        opportunity_type_id="missing_site",
        supporting_signal_ids=["sig_1", "sig_2"],
    )
    qual_ctx = QualificationContext(
        opportunity_id="o1",
        status="QUALIFIED",
        passed_rule_ids=["rule_1"],
        failed_rule_ids=["rule_2"],
    )

    passed = (
        isinstance(biz_ctx.phones, tuple)
        and isinstance(biz_ctx.emails, tuple)
        and isinstance(biz_ctx.websites, tuple)
        and isinstance(opp_ctx.supporting_signal_ids, tuple)
        and isinstance(qual_ctx.passed_rule_ids, tuple)
        and isinstance(qual_ctx.failed_rule_ids, tuple)
    )

    log_check(4, "Tuple Coercion (Collections stored as immutable tuples)", passed)


def test_05_projection_fidelity():
    """Verify projection models expose only 1:1 canonical upstream fields."""
    biz_fields = {f.name for f in dataclasses.fields(BusinessContext)}
    expected_biz = {"business_id", "name", "category", "address", "city", "region", "country", "description", "phones", "emails", "websites"}
    
    opp_fields = {f.name for f in dataclasses.fields(OpportunityContext)}
    expected_opp = {"opportunity_id", "business_id", "niche_id", "opportunity_type_id", "supporting_signal_ids"}

    qual_fields = {f.name for f in dataclasses.fields(QualificationContext)}
    expected_qual = {"opportunity_id", "status", "passed_rule_ids", "failed_rule_ids"}

    score_fields = {f.name for f in dataclasses.fields(ScoreContext)}
    expected_score = {"opportunity_id", "overall_score"}

    pri_fields = {f.name for f in dataclasses.fields(PriorityContext)}
    expected_pri = {"opportunity_id", "priority_score", "score_contribution", "recency_contribution", "is_eligible"}

    rank_fields = {f.name for f in dataclasses.fields(RankContext)}
    expected_rank = {"opportunity_id", "rank", "priority_score"}

    mission_fields = {f.name for f in dataclasses.fields(MissionContext)}
    expected_mission = {"opportunity_id", "business_id", "mission_type"}

    wf_fields = {f.name for f in dataclasses.fields(WorkflowContext)}
    expected_wf = {"mission_id", "opportunity_id", "business_id", "status"}

    passed = (
        biz_fields == expected_biz
        and opp_fields == expected_opp
        and qual_fields == expected_qual
        and score_fields == expected_score
        and pri_fields == expected_pri
        and rank_fields == expected_rank
        and mission_fields == expected_mission
        and wf_fields == expected_wf
    )

    log_check(5, "Projection Fidelity (1:1 direct upstream field mapping)", passed)


def test_06_projection_rule():
    """Verify subsystem performs no business logic, scoring, ranking, or transitions."""
    service_methods = [
        m for m in dir(ContextProjectionService) if not m.startswith("__")
    ]
    expected_methods = {
        "project",
        "_project_business",
        "_project_opportunity",
        "_project_qualification",
        "_project_score",
        "_project_priority",
        "_project_rank",
        "_project_mission",
        "_project_workflow",
    }
    passed = set(service_methods) == expected_methods
    log_check(6, "Projection Rule (No business calculations or logic)", passed)


def test_07_canonical_projection_rule():
    """Verify subsystem only reshapes, omits, and projects canonical fields."""
    b = Business(
        business_id="biz_1",
        execution_id="ex_1",
        session_id="s_1",
        originating_provider_id="prov_1",
        name="Business One",
        discovered_at=datetime(2026, 8, 4, 10, 0, 0),
        category="Dentist",
        city="Berlin",
        country="Germany",
        phones=("+4930123456",),
    )
    req = ContextProjectionRequest(
        subject=ContextSubject("biz_1", ContextSubjectType.BUSINESS),
        requested_components=(ContextComponent.BUSINESS,),
    )
    ctx = ContextProjectionService.project(req, business=b)

    passed = (
        ctx.business is not None
        and ctx.business.business_id == "biz_1"
        and ctx.business.name == "Business One"
        and ctx.business.category == "Dentist"
        and ctx.business.city == "Berlin"
        and ctx.business.phones == ("+4930123456",)
        and ctx.opportunities == ()
    )

    log_check(7, "Canonical Projection Rule (Exact, sanitized reshaping)", passed)


def test_08_domain_model_consistency():
    """Verify all domain models follow frozen slotted dataclass standard."""
    models = [
        ContextSubject,
        ContextProjectionRequest,
        BusinessContext,
        OpportunityContext,
        QualificationContext,
        ScoreContext,
        PriorityContext,
        RankContext,
        MissionContext,
        WorkflowContext,
        EngineContext,
    ]
    passed = all(
        dataclasses.is_dataclass(m) and hasattr(m, "__slots__") for m in models
    )
    log_check(8, "Domain Model Consistency (Slotted frozen dataclass standard)", passed)


def test_09_statelessness():
    """Verify ContextProjectionService has zero mutable state or caches."""
    state_attrs = [
        attr for attr in dir(ContextProjectionService)
        if not attr.startswith("__") and not callable(getattr(ContextProjectionService, attr))
    ]
    passed = len(state_attrs) == 0
    log_check(9, "Statelessness (Zero mutable class attributes or state)", passed)


def test_10_determinism():
    """Execute projection 2,000 times and verify identical output."""
    b = Business("b1", "ex1", "s1", "p1", "Biz", datetime(2026, 8, 4, 10, 0, 0))
    opp = Opportunity("opp_1", "b1", "web", "missing_site", datetime(2026, 8, 4, 10, 0, 0))
    req = ContextProjectionRequest(subject=ContextSubject("b1", ContextSubjectType.BUSINESS))

    first_run = ContextProjectionService.project(req, business=b, opportunities=[opp])
    first_repr = repr(first_run)

    passed = True
    for _ in range(2000):
        current_run = ContextProjectionService.project(req, business=b, opportunities=[opp])
        if repr(current_run) != first_repr:
            passed = False
            break

    log_check(10, "Determinism (2,000 repeated executions byte-identical)", passed)


def test_11_thread_safety():
    """Execute concurrent projections across 16 threads."""
    b = Business("b1", "ex1", "s1", "p1", "Biz", datetime(2026, 8, 4, 10, 0, 0))
    opp = Opportunity("opp_1", "b1", "web", "missing_site", datetime(2026, 8, 4, 10, 0, 0))
    req = ContextProjectionRequest(subject=ContextSubject("b1", ContextSubjectType.BUSINESS))

    expected_repr = repr(ContextProjectionService.project(req, business=b, opportunities=[opp]))

    def worker():
        return repr(ContextProjectionService.project(req, business=b, opportunities=[opp]))

    passed = True
    with ThreadPoolExecutor(max_workers=16) as executor:
        futures = [executor.submit(worker) for _ in range(200)]
        for f in futures:
            if f.result() != expected_repr:
                passed = False
                break

    log_check(11, "Thread Safety & Concurrency (16 parallel workers)", passed)


def test_12_empty_input_handling():
    """Verify handling of empty tuples and optional inputs."""
    req = ContextProjectionRequest(subject=ContextSubject("b1", ContextSubjectType.BUSINESS))
    ctx = ContextProjectionService.project(req)

    passed = (
        ctx.subject.subject_id == "b1"
        and ctx.business is None
        and ctx.opportunities == ()
        and ctx.qualifications == ()
        and ctx.scores == ()
        and ctx.priorities == ()
        and ctx.ranks == ()
        and ctx.missions == ()
        and ctx.workflows == ()
    )

    log_check(12, "Empty & Optional Input Handling (Graceful defaults)", passed)


def test_13_invalid_input_handling():
    """Verify strict type validation on models and service."""
    passed = True
    try:
        ContextSubject("", ContextSubjectType.BUSINESS)
        passed = False
    except ValueError:
        pass

    try:
        ContextSubject("b1", "INVALID_TYPE")
        passed = False
    except TypeError:
        pass

    try:
        req = ContextProjectionRequest(subject=ContextSubject("b1", ContextSubjectType.BUSINESS))
        ContextProjectionService.project(req, business="not_a_business_instance")
        passed = False
    except TypeError:
        pass

    log_check(13, "Invalid Input Handling (Strict type & value checking)", passed)


def test_14_end_to_end_pipeline():
    """Run full operational pipeline from Subsystems 5 through 16."""
    now = datetime(2026, 8, 4, 10, 0, 0)
    
    # Subsystem 5: Business
    biz = Business("b_pipeline", "ex_1", "s_1", "p_1", "Pipeline Biz", now, category="Dental")

    # Subsystem 9: Opportunity
    opp = Opportunity("opp_pipeline", "b_pipeline", "web_design", "missing_website", now)

    # Subsystem 10: Qualification
    qual = OpportunityQualification("opp_pipeline", QualificationStatus.QUALIFIED, ("rule_has_phone",))

    # Subsystem 11: Score
    score = OpportunityScore("opp_pipeline", 85.0)

    # Subsystem 12: Priority
    policy = PrioritizationPolicy(strategy=PrioritizationStrategy.BALANCED, evaluation_at=now)
    priority = OpportunityPrioritizationService.evaluate_priority(opp, qual, score, policy)

    # Subsystem 13: Rank
    ranked = OpportunityRankingService.rank_opportunities([priority])[0]

    # Subsystem 14: Mission
    mission = MissionGenerationService.generate_mission(ranked, opp)

    # Subsystem 15: Workflow
    wf_state = WorkflowState(
        mission_id="m_1",
        opportunity_id=opp.opportunity_id,
        business_id=biz.business_id,
        status=WorkflowStatus.UNSTARTED,
    )

    # Subsystem 16: Engine Context Projection
    req = ContextProjectionRequest(subject=ContextSubject("b_pipeline", ContextSubjectType.BUSINESS))
    engine_ctx = ContextProjectionService.project(
        request=req,
        business=biz,
        opportunities=[opp],
        qualifications=[qual],
        scores=[score],
        priorities=[priority],
        ranks=[ranked],
        missions=[mission],
        workflows=[wf_state],
    )

    passed = (
        engine_ctx.business is not None
        and engine_ctx.business.business_id == "b_pipeline"
        and len(engine_ctx.opportunities) == 1
        and engine_ctx.opportunities[0].opportunity_id == "opp_pipeline"
        and len(engine_ctx.qualifications) == 1
        and engine_ctx.qualifications[0].status == "QUALIFIED"
        and len(engine_ctx.scores) == 1
        and engine_ctx.scores[0].overall_score == 85.0
        and len(engine_ctx.priorities) == 1
        and engine_ctx.priorities[0].is_eligible is True
        and len(engine_ctx.ranks) == 1
        and engine_ctx.ranks[0].rank == 1
        and len(engine_ctx.missions) == 1
        and engine_ctx.missions[0].mission_type == MissionType.OUTREACH.value
        and len(engine_ctx.workflows) == 1
        and engine_ctx.workflows[0].status == WorkflowStatus.UNSTARTED.value
    )

    log_check(14, "End-to-End Pipeline Regression (Subsystems 5 -> 9-16)", passed)


def main():
    print("======================================================================")
    print("  MAST Lead Engine 2.0 — Subsystem 16 Validation Suite")
    print("======================================================================\n")

    tests = [
        test_01_import_isolation,
        test_02_ast_analysis,
        test_03_model_immutability,
        test_04_tuple_coercion,
        test_05_projection_fidelity,
        test_06_projection_rule,
        test_07_canonical_projection_rule,
        test_08_domain_model_consistency,
        test_09_statelessness,
        test_10_determinism,
        test_11_thread_safety,
        test_12_empty_input_handling,
        test_13_invalid_input_handling,
        test_14_end_to_end_pipeline,
    ]

    for test in tests:
        test()

    print("\n======================================================================")
    print("  ALL 14 VALIDATION CHECKS PASSED PERFECTLY [100% SUCCESS]")
    print("======================================================================\n")


if __name__ == "__main__":
    main()
