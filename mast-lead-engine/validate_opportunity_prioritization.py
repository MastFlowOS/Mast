"""
validate_opportunity_prioritization.py
======================================

Standalone comprehensive validation suite for Subsystem 12 — Opportunity Prioritization (Phase 4).

Verification Checks
-------------------
1. Determinism
2. Immutability & Slotted Dataclasses
3. Type Validation & Boundary Constraints
4. Cross-Input Identity Mismatch Detection
5. Qualification Eligibility Handling
6. Recency Decay Mathematical Correctness
7. Weight Normalization Math
8. Predefined Strategy Behavior (SCORE_DOMINANT, BALANCED, RECENCY_DOMINANT)
9. CUSTOM_WEIGHTED Behavior & Single Source of Truth Enforcement
10. Temporal Boundary Conditions (No Hidden Clocks, Future Timestamps)
11. Invalid Policy Configuration Rejection
12. Import Isolation & AST Analysis (No Registry, No Forbidden Imports)
13. Thread Safety & Concurrency
14. Subsystem Regression Coverage (Opportunities, Qualification, Scoring)

Run directly with:
    python validate_opportunity_prioritization.py
"""

from __future__ import annotations

import ast
import dataclasses
from datetime import datetime, timedelta, timezone
from pathlib import Path
import sys
import threading

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
    "missions",
    "ai",
    "scoring",
    "provider_execution",
]

for m in list(sys.modules.keys()):
    for f in forbidden:
        if m == f or m.startswith(f + "."):
            del sys.modules[m]

import opportunities
from opportunities import Opportunity
import opportunity_qualification
from opportunity_qualification import OpportunityQualification, QualificationStatus
import opportunity_scoring
from opportunity_scoring import OpportunityScore, ScoreContribution
import opportunity_prioritization
from opportunity_prioritization import (
    OpportunityPrioritizationService,
    OpportunityPriority,
    PrioritizationPolicy,
    PrioritizationStrategy,
)


def print_check(name: str, passed: bool, detail: str = "") -> None:
    status = "PASSED" if passed else "FAILED"
    msg = f"[{status}] {name}"
    if detail:
        msg += f" — {detail}"
    print(msg)
    if not passed:
        raise AssertionError(f"Check failed: {name} ({detail})")


def check_import_isolation() -> None:
    """Check 1: Verify no forbidden modules are loaded into sys.modules."""
    for f in forbidden:
        for loaded in list(sys.modules.keys()):
            if loaded == f or loaded.startswith(f + "."):
                print_check("Import Isolation", False, f"Forbidden module loaded: {loaded}")
                return
    print_check("Import Isolation", True, "Zero forbidden modules loaded in sys.modules")


def check_ast_analysis() -> None:
    """Check 2: AST analysis of opportunity_prioritization package files for forbidden imports."""
    pkg_dir = engine_dir / "opportunity_prioritization"
    py_files = list(pkg_dir.glob("*.py"))

    for py_file in py_files:
        content = py_file.read_text(encoding="utf-8")
        tree = ast.parse(content, filename=str(py_file))
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                for alias in node.names:
                    for f in forbidden:
                        if alias.name == f or alias.name.startswith(f + "."):
                            print_check("AST Analysis", False, f"Forbidden import '{alias.name}' in {py_file.name}")
                            return
            elif isinstance(node, ast.ImportFrom):
                if node.module:
                    for f in forbidden:
                        if node.module == f or node.module.startswith(f + "."):
                            print_check("AST Analysis", False, f"Forbidden import from '{node.module}' in {py_file.name}")
                            return

            # Check that datetime.now() or datetime.utcnow() is nowhere in the package
            if isinstance(node, ast.Attribute):
                if node.attr in ("now", "utcnow"):
                    print_check("AST Analysis", False, f"Hidden clock '{node.attr}' detected in {py_file.name}")
                    return

    print_check("AST Analysis", True, "AST analysis clean: no forbidden imports or hidden clocks in opportunity_prioritization")


def check_absence_of_registry() -> None:
    """Check 3: Absence of registry.py in opportunity_prioritization package."""
    registry_file = engine_dir / "opportunity_prioritization" / "registry.py"
    if registry_file.exists():
        print_check("Absence of Registry", False, "registry.py file exists in opportunity_prioritization")
    else:
        print_check("Absence of Registry", True, "No registry.py file in opportunity_prioritization (pure derived subsystem)")


def check_model_immutability() -> None:
    """Check 4: Verify frozen dataclasses, __slots__, and attribute mutation errors."""
    eval_time = datetime(2026, 8, 4, 12, 0, 0, tzinfo=timezone.utc)
    policy = PrioritizationPolicy(
        strategy=PrioritizationStrategy.BALANCED,
        evaluation_at=eval_time,
    )
    priority = OpportunityPriority(
        opportunity_id="opp_immut_001",
        priority_score=75.0,
        score_contribution=40.0,
        recency_contribution=35.0,
        is_eligible=True,
    )

    # Slotted checks
    if not hasattr(policy, "__slots__"):
        print_check("Model Immutability", False, "PrioritizationPolicy lacks __slots__")
        return
    if not hasattr(priority, "__slots__"):
        print_check("Model Immutability", False, "OpportunityPriority lacks __slots__")
        return

    # Frozen checks
    try:
        policy.score_weight = 0.9  # type: ignore
        print_check("Model Immutability", False, "PrioritizationPolicy allowed mutation of score_weight")
        return
    except (dataclasses.FrozenInstanceError, TypeError, AttributeError):
        pass

    try:
        priority.priority_score = 99.0  # type: ignore
        print_check("Model Immutability", False, "OpportunityPriority allowed mutation of priority_score")
        return
    except (dataclasses.FrozenInstanceError, TypeError, AttributeError):
        pass

    print_check("Model Immutability", True, "Dataclasses are frozen, slotted, and strictly immutable")


def check_type_validation_and_clamping() -> None:
    """Check 5: Strict type validation, empty strings, and score clamping."""
    eval_time = datetime(2026, 8, 4, 12, 0, 0, tzinfo=timezone.utc)

    # Empty opportunity_id in OpportunityPriority
    try:
        OpportunityPriority(
            opportunity_id="",
            priority_score=50.0,
            score_contribution=25.0,
            recency_contribution=25.0,
            is_eligible=True,
        )
        print_check("Type Validation", False, "Allowed empty opportunity_id in OpportunityPriority")
        return
    except ValueError:
        pass

    # Score clamping checks
    over_clamped = OpportunityPriority(
        opportunity_id="opp_over",
        priority_score=120.0,
        score_contribution=110.0,
        recency_contribution=110.0,
        is_eligible=True,
    )
    if over_clamped.priority_score != 100.0 or over_clamped.score_contribution != 100.0:
        print_check("Type Validation", False, f"Upper clamping failed: {over_clamped}")
        return

    under_clamped = OpportunityPriority(
        opportunity_id="opp_under",
        priority_score=-20.0,
        score_contribution=-10.0,
        recency_contribution=-10.0,
        is_eligible=True,
    )
    if under_clamped.priority_score != 0.0 or under_clamped.score_contribution != 0.0:
        print_check("Type Validation", False, f"Lower clamping failed: {under_clamped}")
        return

    print_check("Type Validation", True, "Strict type validation and clamping verified")


def check_identity_mismatch() -> None:
    """Check 6: Verify identity mismatch across opportunity, qualification, and score inputs."""
    eval_time = datetime(2026, 8, 4, 12, 0, 0, tzinfo=timezone.utc)
    policy = PrioritizationPolicy(
        strategy=PrioritizationStrategy.BALANCED,
        evaluation_at=eval_time,
    )

    opp = Opportunity(
        opportunity_id="opp_A",
        business_id="biz_1",
        niche_id="web",
        opportunity_type_id="type_1",
        discovered_at=eval_time,
    )
    qual = OpportunityQualification(
        opportunity_id="opp_B",  # Mismatch!
        status=QualificationStatus.QUALIFIED,
        passed_rule_ids=("rule_1",),
    )
    score = OpportunityScore(
        opportunity_id="opp_A",
        overall_score=80.0,
    )

    try:
        OpportunityPrioritizationService.evaluate_priority(opp, qual, score, policy)
        print_check("Identity Mismatch Detection", False, "Service allowed mismatched opportunity IDs")
        return
    except ValueError as e:
        if "mismatch" not in str(e).lower():
            print_check("Identity Mismatch Detection", False, f"Unexpected error message: {e}")
            return

    print_check("Identity Mismatch Detection", True, "Cross-input opportunity ID mismatch correctly rejected")


def check_qualification_handling() -> None:
    """Check 7: Qualification eligibility handling."""
    eval_time = datetime(2026, 8, 4, 12, 0, 0, tzinfo=timezone.utc)
    policy_req = PrioritizationPolicy(
        strategy=PrioritizationStrategy.BALANCED,
        evaluation_at=eval_time,
        require_qualification=True,
    )
    policy_no_req = PrioritizationPolicy(
        strategy=PrioritizationStrategy.BALANCED,
        evaluation_at=eval_time,
        require_qualification=False,
    )

    opp = Opportunity(
        opportunity_id="opp_unqual",
        business_id="biz_1",
        niche_id="seo",
        opportunity_type_id="poor_seo",
        discovered_at=eval_time,
    )
    qual_unqualified = OpportunityQualification(
        opportunity_id="opp_unqual",
        status=QualificationStatus.NOT_QUALIFIED,
        passed_rule_ids=(),
        failed_rule_ids=("rule_fail",),
    )
    score = OpportunityScore(
        opportunity_id="opp_unqual",
        overall_score=90.0,
    )

    # With require_qualification=True -> Should be ineligible with zero score
    res_req = OpportunityPrioritizationService.evaluate_priority(opp, qual_unqualified, score, policy_req)
    if res_req.is_eligible or res_req.priority_score != 0.0:
        print_check("Qualification Handling", False, f"Expected ineligible zero score, got {res_req}")
        return

    # With require_qualification=False -> Should evaluate priority score normally
    res_no_req = OpportunityPrioritizationService.evaluate_priority(opp, qual_unqualified, score, policy_no_req)
    if not res_no_req.is_eligible or res_no_req.priority_score <= 0.0:
        print_check("Qualification Handling", False, f"Expected eligible positive score when require_qualification=False, got {res_no_req}")
        return

    print_check("Qualification Handling", True, "Qualification eligibility gating verified")


def check_recency_decay_math() -> None:
    """Check 8: Recency decay math correctness against analytical half-life formula."""
    eval_time = datetime(2026, 8, 4, 12, 0, 0, tzinfo=timezone.utc)
    policy = PrioritizationPolicy(
        strategy=PrioritizationStrategy.RECENCY_DOMINANT,  # 20% score, 80% recency
        evaluation_at=eval_time,
        recency_half_life_days=30.0,
    )

    qual = OpportunityQualification(
        opportunity_id="opp_recency",
        status=QualificationStatus.QUALIFIED,
        passed_rule_ids=("r1",),
    )
    score = OpportunityScore(
        opportunity_id="opp_recency",
        overall_score=100.0,  # 100 raw quality score
    )

    # 1. Zero elapsed time (discovered_at == evaluation_at) -> Recency raw score = 100.0
    opp_0 = Opportunity(
        opportunity_id="opp_recency",
        business_id="b1",
        niche_id="n1",
        opportunity_type_id="t1",
        discovered_at=eval_time,
    )
    res_0 = OpportunityPrioritizationService.evaluate_priority(opp_0, qual, score, policy)
    # Expected: 0.2*100 + 0.8*100 = 100.0
    if res_0.priority_score != 100.0 or res_0.recency_contribution != 80.0:
        print_check("Recency Decay Math", False, f"At t=0 expected priority=100.0, recency_contrib=80.0, got {res_0}")
        return

    # 2. 30 days elapsed time (exactly 1 half-life) -> Recency raw score = 50.0
    opp_30 = Opportunity(
        opportunity_id="opp_recency",
        business_id="b1",
        niche_id="n1",
        opportunity_type_id="t1",
        discovered_at=eval_time - timedelta(days=30),
    )
    res_30 = OpportunityPrioritizationService.evaluate_priority(opp_30, qual, score, policy)
    # Expected: 0.2*100 + 0.8*50 = 20.0 + 40.0 = 60.0
    if res_30.priority_score != 60.0 or res_30.recency_contribution != 40.0:
        print_check("Recency Decay Math", False, f"At t=30d expected priority=60.0, recency_contrib=40.0, got {res_30}")
        return

    # 3. 60 days elapsed time (2 half-lives) -> Recency raw score = 25.0
    opp_60 = Opportunity(
        opportunity_id="opp_recency",
        business_id="b1",
        niche_id="n1",
        opportunity_type_id="t1",
        discovered_at=eval_time - timedelta(days=60),
    )
    res_60 = OpportunityPrioritizationService.evaluate_priority(opp_60, qual, score, policy)
    # Expected: 0.2*100 + 0.8*25 = 20.0 + 20.0 = 40.0
    if res_60.priority_score != 40.0 or res_60.recency_contribution != 20.0:
        print_check("Recency Decay Math", False, f"At t=60d expected priority=40.0, recency_contrib=20.0, got {res_60}")
        return

    print_check("Recency Decay Math", True, "Exponential recency decay math verified across half-lives")


def check_single_source_of_truth_and_strategies() -> None:
    """Check 9: Single source of truth enforcement for predefined vs custom strategies."""
    eval_time = datetime(2026, 8, 4, 12, 0, 0, tzinfo=timezone.utc)

    # Predefined SCORE_DOMINANT -> (0.8, 0.2)
    p_score = PrioritizationPolicy(strategy=PrioritizationStrategy.SCORE_DOMINANT, evaluation_at=eval_time)
    if p_score.score_weight != 0.8 or p_score.recency_weight != 0.2:
        print_check("Single Source of Truth", False, f"SCORE_DOMINANT weights incorrect: {p_score}")
        return

    # Predefined BALANCED -> (0.5, 0.5)
    p_bal = PrioritizationPolicy(strategy=PrioritizationStrategy.BALANCED, evaluation_at=eval_time)
    if p_bal.score_weight != 0.5 or p_bal.recency_weight != 0.5:
        print_check("Single Source of Truth", False, f"BALANCED weights incorrect: {p_bal}")
        return

    # Predefined RECENCY_DOMINANT -> (0.2, 0.8)
    p_rec = PrioritizationPolicy(strategy=PrioritizationStrategy.RECENCY_DOMINANT, evaluation_at=eval_time)
    if p_rec.score_weight != 0.2 or p_rec.recency_weight != 0.8:
        print_check("Single Source of Truth", False, f"RECENCY_DOMINANT weights incorrect: {p_rec}")
        return

    # Attempting to supply explicit weights to predefined strategy -> MUST FAIL
    try:
        PrioritizationPolicy(
            strategy=PrioritizationStrategy.SCORE_DOMINANT,
            evaluation_at=eval_time,
            score_weight=0.95,
        )
        print_check("Single Source of Truth", False, "Allowed explicit score_weight on predefined SCORE_DOMINANT strategy")
        return
    except ValueError as e:
        if "explicit score_weight/recency_weight cannot be specified" not in str(e).lower():
            print_check("Single Source of Truth", False, f"Unexpected error message: {e}")
            return

    # CUSTOM_WEIGHTED with custom weights -> Allowed
    p_custom = PrioritizationPolicy(
        strategy=PrioritizationStrategy.CUSTOM_WEIGHTED,
        evaluation_at=eval_time,
        score_weight=0.9,
        recency_weight=0.1,
    )
    if p_custom.score_weight != 0.9 or p_custom.recency_weight != 0.1:
        print_check("Single Source of Truth", False, f"CUSTOM_WEIGHTED custom weights incorrect: {p_custom}")
        return

    print_check("Single Source of Truth", True, "Predefined strategies determine weights canonically; CUSTOM_WEIGHTED isolated")


def check_invalid_policy_rejection() -> None:
    """Check 10: Rejection of invalid policy configurations."""
    eval_time = datetime(2026, 8, 4, 12, 0, 0, tzinfo=timezone.utc)

    # Missing/invalid evaluation_at
    try:
        PrioritizationPolicy(strategy=PrioritizationStrategy.BALANCED, evaluation_at="2026-08-04")  # type: ignore
        print_check("Invalid Policy Rejection", False, "Allowed string evaluation_at")
        return
    except TypeError:
        pass

    # Zero half-life
    try:
        PrioritizationPolicy(strategy=PrioritizationStrategy.BALANCED, evaluation_at=eval_time, recency_half_life_days=0.0)
        print_check("Invalid Policy Rejection", False, "Allowed zero recency_half_life_days")
        return
    except ValueError:
        pass

    # Sum of weights <= 0.0 in CUSTOM_WEIGHTED
    try:
        PrioritizationPolicy(
            strategy=PrioritizationStrategy.CUSTOM_WEIGHTED,
            evaluation_at=eval_time,
            score_weight=0.0,
            recency_weight=0.0,
        )
        print_check("Invalid Policy Rejection", False, "Allowed zero sum of custom weights")
        return
    except ValueError:
        pass

    print_check("Invalid Policy Rejection", True, "Invalid policy configurations properly rejected")


def check_future_timestamp_clamping() -> None:
    """Check 11: Future timestamp handling (discovered_at in the future relative to evaluation_at)."""
    eval_time = datetime(2026, 8, 4, 12, 0, 0, tzinfo=timezone.utc)
    policy = PrioritizationPolicy(strategy=PrioritizationStrategy.BALANCED, evaluation_at=eval_time)

    opp_future = Opportunity(
        opportunity_id="opp_future",
        business_id="b1",
        niche_id="n1",
        opportunity_type_id="t1",
        discovered_at=eval_time + timedelta(hours=5),  # 5 hours in future!
    )
    qual = OpportunityQualification(opportunity_id="opp_future", status=QualificationStatus.QUALIFIED, passed_rule_ids=("r1",))
    score = OpportunityScore(opportunity_id="opp_future", overall_score=80.0)

    res = OpportunityPrioritizationService.evaluate_priority(opp_future, qual, score, policy)
    # Elapsed time clamped to 0.0 -> recency raw score = 100.0
    # Expected: 0.5*80 + 0.5*100 = 40 + 50 = 90.0
    if res.priority_score != 90.0 or res.recency_contribution != 50.0:
        print_check("Future Timestamp Clamping", False, f"Expected priority=90.0, recency_contrib=50.0, got {res}")
        return

    print_check("Future Timestamp Clamping", True, "Future discovery timestamps safely clamped to elapsed_seconds=0.0")


def check_determinism() -> None:
    """Check 12: Pure determinism across 1,000 evaluations."""
    eval_time = datetime(2026, 8, 4, 12, 0, 0, tzinfo=timezone.utc)
    policy = PrioritizationPolicy(strategy=PrioritizationStrategy.BALANCED, evaluation_at=eval_time)

    opp = Opportunity(
        opportunity_id="opp_det",
        business_id="b1",
        niche_id="n1",
        opportunity_type_id="t1",
        discovered_at=eval_time - timedelta(days=10),
    )
    qual = OpportunityQualification(opportunity_id="opp_det", status=QualificationStatus.QUALIFIED, passed_rule_ids=("r1",))
    score = OpportunityScore(opportunity_id="opp_det", overall_score=85.0)

    first_res = OpportunityPrioritizationService.evaluate_priority(opp, qual, score, policy)

    for _ in range(1000):
        next_res = OpportunityPrioritizationService.evaluate_priority(opp, qual, score, policy)
        if first_res != next_res:
            print_check("Pure Determinism", False, f"Determinism failure: {first_res} != {next_res}")
            return

    print_check("Pure Determinism", True, "1,000 evaluations produced 100% byte-for-byte identical priority outputs")


def check_thread_safety() -> None:
    """Check 13: Thread safety across concurrent evaluations."""
    eval_time = datetime(2026, 8, 4, 12, 0, 0, tzinfo=timezone.utc)
    policy = PrioritizationPolicy(strategy=PrioritizationStrategy.BALANCED, evaluation_at=eval_time)
    errors: list[Exception] = []

    def worker(worker_id: int):
        try:
            for i in range(50):
                opp_id = f"opp_th_{worker_id}_{i}"
                opp = Opportunity(
                    opportunity_id=opp_id,
                    business_id=f"biz_{worker_id}",
                    niche_id="niche",
                    opportunity_type_id="type",
                    discovered_at=eval_time - timedelta(days=i),
                )
                qual = OpportunityQualification(opportunity_id=opp_id, status=QualificationStatus.QUALIFIED, passed_rule_ids=("r1",))
                score = OpportunityScore(opportunity_id=opp_id, overall_score=50.0 + i)

                res = OpportunityPrioritizationService.evaluate_priority(opp, qual, score, policy)
                if res.opportunity_id != opp_id:
                    raise ValueError(f"Thread ID mismatch: expected {opp_id}, got {res.opportunity_id}")
        except Exception as e:
            errors.append(e)

    threads = [threading.Thread(target=worker, args=(t,)) for t in range(10)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    if errors:
        print_check("Thread Safety", False, f"Thread safety errors occurred: {errors[0]}")
    else:
        print_check("Thread Safety", True, "500 concurrent evaluations completed clean across 10 threads")


def check_subsystem_regressions() -> None:
    """Check 14: Verify previous subsystems (opportunities, qualification, scoring) remain intact."""
    from opportunities import OpportunityRegistry
    from opportunity_qualification import OpportunityQualificationService
    from opportunity_scoring import OpportunityScoringService

    eval_time = datetime(2026, 8, 4, 12, 0, 0, tzinfo=timezone.utc)

    opp = Opportunity(
        opportunity_id="opp_regr_001",
        business_id="biz_regr",
        niche_id="web_design",
        opportunity_type_id="missing_website",
        discovered_at=eval_time,
        supporting_signal_ids=("sig_1", "sig_2"),
    )

    # Test qualification
    qual_svc = OpportunityQualificationService()
    qual_res = qual_svc.evaluate(opp)
    if qual_res.status != QualificationStatus.QUALIFIED:
        print_check("Subsystem Regressions", False, "Opportunity qualification test failed")
        return

    # Test scoring
    score_svc = OpportunityScoringService()
    score_res = score_svc.evaluate(opp)
    if score_res.overall_score <= 0.0:
        print_check("Subsystem Regressions", False, "Opportunity scoring test failed")
        return

    # Test prioritization using upstream outputs
    policy = PrioritizationPolicy(strategy=PrioritizationStrategy.SCORE_DOMINANT, evaluation_at=eval_time)
    prio_res = OpportunityPrioritizationService.evaluate_priority(opp, qual_res, score_res, policy)

    if prio_res.opportunity_id != "opp_regr_001" or not prio_res.is_eligible:
        print_check("Subsystem Regressions", False, "Prioritization with upstream outputs failed")
        return

    print_check("Subsystem Regressions", True, "All previous subsystems function properly without mutation")


def run_all_checks() -> None:
    print("=" * 75)
    print("MAST Lead Engine — Subsystem 12 (Opportunity Prioritization) Validation Suite")
    print("=" * 75)

    check_import_isolation()
    check_ast_analysis()
    check_absence_of_registry()
    check_model_immutability()
    check_type_validation_and_clamping()
    check_identity_mismatch()
    check_qualification_handling()
    check_recency_decay_math()
    check_single_source_of_truth_and_strategies()
    check_invalid_policy_rejection()
    check_future_timestamp_clamping()
    check_determinism()
    check_thread_safety()
    check_subsystem_regressions()

    print("=" * 75)
    print("ALL 14 VALIDATION CHECKS PASSED SUCCESSFULLY!")
    print("=" * 75)


if __name__ == "__main__":
    run_all_checks()
