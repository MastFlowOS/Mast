"""
validate_mission_generation.py
===============================

Standalone comprehensive validation suite for Subsystem 14 — Mission Generation (Phase 4).

Verification Checks
-------------------
1. Import Isolation
2. AST Analysis (No Registry, No Hidden Clocks, Dataclass Rules)
3. Absence of Registries & Mutable Globals
4. Model Immutability & Slotted Dataclass Enforcement
5. MissionType Enum Validation
6. Mission Model Validation
7. Non-Empty IDs Validation
8. Lineage Mismatch Detection
9. Mission Type Derivation Correctness
10. Tuple Coercion (Accepts Iterables, Returns Tuple)
11. Single Mission Generation
12. Bulk Mission Generation
13. Input Ordering Preservation
14. Pure Determinism (2,000 Repeated Iterations)
15. Thread Safety & Concurrency
16. Empty Input Handling
17. Invalid Input Handling
18. Regression Verification (Subsystems 9–14 End-to-End Operational)

Run directly with:
    python validate_mission_generation.py
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


def print_check(name: str, passed: bool, detail: str = "") -> None:
    status = "PASSED" if passed else "FAILED"
    msg = f"[{status}] {name}"
    if detail:
        msg += f" — {detail}"
    print(msg)
    if not passed:
        raise AssertionError(f"Check failed: {name} ({detail})")


def check_1_import_isolation() -> None:
    """Check 1: Verify no forbidden modules are loaded into sys.modules."""
    for f in forbidden:
        for loaded in list(sys.modules.keys()):
            if loaded == f or loaded.startswith(f + "."):
                print_check("Import Isolation", False, f"Forbidden module loaded: {loaded}")
                return
    print_check("Import Isolation", True, "Zero forbidden modules loaded in sys.modules")


def check_2_ast_analysis() -> None:
    """Check 2: AST analysis of mission_generation package files for forbidden constructs."""
    pkg_dir = engine_dir / "mission_generation"
    py_files = list(pkg_dir.glob("*.py"))

    forbidden_nodes = ("now", "utcnow", "Registry", "Manager", "Factory", "global")

    for py_file in py_files:
        with open(py_file, "r", encoding="utf-8") as f:
            tree = ast.parse(f.read(), filename=str(py_file))

        for node in ast.walk(tree):
            if isinstance(node, ast.Name):
                if node.id in forbidden_nodes and node.id != "global":
                    print_check("AST Analysis", False, f"Forbidden identifier '{node.id}' in {py_file.name}")
                    return
            elif isinstance(node, ast.Attribute):
                if node.attr in ("now", "utcnow"):
                    print_check("AST Analysis", False, f"Hidden clock attribute '{node.attr}' in {py_file.name}")
                    return
            elif isinstance(node, ast.Global):
                print_check("AST Analysis", False, f"Forbidden global statement in {py_file.name}")
                return

    print_check("AST Analysis", True, "AST analysis clean (No hidden clocks, registries, or globals)")


def check_3_absence_of_registries() -> None:
    """Check 3: Assert mission_generation module contains zero registry or factory attributes."""
    for attr in dir(mission_generation):
        if "registry" in attr.lower() or "factory" in attr.lower() or "manager" in attr.lower():
            print_check("Absence of Registries", False, f"Registry/Manager attribute found: {attr}")
            return

    print_check("Absence of Registries", True, "Zero registries, managers, or factories present")


def check_4_model_immutability() -> None:
    """Check 4: Verify Mission model immutability and slots."""
    m = Mission(
        opportunity_id="opp_001",
        business_id="biz_001",
        mission_type=MissionType.OUTREACH,
    )

    # Slotted dataclass check
    if not hasattr(m, "__slots__"):
        print_check("Model Immutability", False, "Mission is missing __slots__")
        return

    # Direct attribute assignment must raise exception
    try:
        m.opportunity_id = "opp_002"  # type: ignore
        print_check("Model Immutability", False, "Attribute assignment succeeded on frozen dataclass")
        return
    except (dataclasses.FrozenInstanceError, AttributeError):
        pass

    print_check("Model Immutability", True, "Mission is strictly frozen and slotted")


def check_5_mission_type_enum() -> None:
    """Check 5: Verify MissionType enum values and subtyping."""
    expected_values = {"OUTREACH", "AUDIT", "RECOVERY", "CLAIM", "NURTURE"}
    actual_values = {t.value for t in MissionType}

    if actual_values != expected_values:
        print_check("MissionType Enum", False, f"Expected enum values {expected_values}; got {actual_values}")
        return

    # Verify str subtyping
    for t in MissionType:
        if not isinstance(t, str):
            print_check("MissionType Enum", False, f"Enum member {t} is not a str subclass")
            return

    print_check("MissionType Enum", True, "MissionType enum values and str subtyping strictly verified")


def check_6_mission_model_validation() -> None:
    """Check 6: Verify Mission post-init type checks."""
    # Non-MissionType enum instance for mission_type
    try:
        Mission(opportunity_id="opp_1", business_id="biz_1", mission_type="OUTREACH")  # type: ignore
        print_check("Mission Model Validation", False, "Accepted raw string for mission_type instead of MissionType enum")
        return
    except TypeError:
        pass

    print_check("Mission Model Validation", True, "MissionType enum type check strictly enforced")


def check_7_non_empty_ids() -> None:
    """Check 7: Verify non-empty string validation for opportunity_id and business_id."""
    for invalid_id in ("", "   ", "\t\n"):
        try:
            Mission(opportunity_id=invalid_id, business_id="biz_1", mission_type=MissionType.OUTREACH)
            print_check("Non-Empty IDs Validation", False, f"Accepted invalid opportunity_id: {invalid_id!r}")
            return
        except ValueError:
            pass

        try:
            Mission(opportunity_id="opp_1", business_id=invalid_id, mission_type=MissionType.OUTREACH)
            print_check("Non-Empty IDs Validation", False, f"Accepted invalid business_id: {invalid_id!r}")
            return
        except ValueError:
            pass

    print_check("Non-Empty IDs Validation", True, "Non-empty string validation strictly enforced for IDs")


def check_8_lineage_mismatch_detection() -> None:
    """Check 8: Verify generate_mission detects opportunity_id mismatch between paired inputs."""
    eval_time = datetime(2026, 8, 4, 12, 0, 0, tzinfo=timezone.utc)
    ranked = RankedOpportunity(opportunity_id="opp_alpha", rank=1, priority_score=90.0)
    opp = Opportunity(
        opportunity_id="opp_beta",
        business_id="biz_1",
        niche_id="seo",
        opportunity_type_id="poor_seo",
        discovered_at=eval_time,
    )

    try:
        MissionGenerationService.generate_mission(ranked, opp)
        print_check("Lineage Mismatch Detection", False, "Accepted mismatched opportunity_id pair without raising ValueError")
        return
    except ValueError as e:
        if "Lineage mismatch" not in str(e):
            print_check("Lineage Mismatch Detection", False, f"Unexpected error message: {e}")
            return

    print_check("Lineage Mismatch Detection", True, "Lineage mismatch correctly detected and rejected with ValueError")


def check_9_mission_type_derivation_correctness() -> None:
    """Check 9: Verify keyword derivation logic for MissionType values."""
    eval_time = datetime(2026, 8, 4, 12, 0, 0, tzinfo=timezone.utc)

    test_cases = [
        ("unclaimed_gbp", (), MissionType.CLAIM),
        ("seo_audit_needed", (), MissionType.AUDIT),
        ("churn_recovery", (), MissionType.RECOVERY),
        ("nurture_campaign", (), MissionType.NURTURE),
        ("generic_lead", (), MissionType.OUTREACH),
        ("generic_lead", ("sig_maps_unclaimed",), MissionType.CLAIM),
        ("generic_lead", ("sig_tech_audit",), MissionType.AUDIT),
    ]

    for opp_type, signals, expected_type in test_cases:
        ranked = RankedOpportunity(opportunity_id="opp_test", rank=1, priority_score=80.0)
        opp = Opportunity(
            opportunity_id="opp_test",
            business_id="biz_test",
            niche_id="web",
            opportunity_type_id=opp_type,
            discovered_at=eval_time,
            supporting_signal_ids=signals,
        )
        mission = MissionGenerationService.generate_mission(ranked, opp)
        if mission.mission_type != expected_type:
            print_check(
                "Mission Type Derivation",
                False,
                f"Expected {expected_type} for opp_type={opp_type!r}, signals={signals!r}; got {mission.mission_type}",
            )
            return

    print_check("Mission Type Derivation", True, "MissionType derivation rules strictly verified across all keyword categories")


def check_10_tuple_coercion() -> None:
    """Check 10: Verify generate_missions accepts iterables and returns a tuple."""
    eval_time = datetime(2026, 8, 4, 12, 0, 0, tzinfo=timezone.utc)
    r1 = RankedOpportunity(opportunity_id="opp_1", rank=1, priority_score=90.0)
    o1 = Opportunity(opportunity_id="opp_1", business_id="biz_1", niche_id="web", opportunity_type_id="missing_site", discovered_at=eval_time)

    r2 = RankedOpportunity(opportunity_id="opp_2", rank=2, priority_score=80.0)
    o2 = Opportunity(opportunity_id="opp_2", business_id="biz_2", niche_id="web", opportunity_type_id="poor_seo", discovered_at=eval_time)

    pairs_list = [(r1, o1), (r2, o2)]

    # Test list input
    res_list = MissionGenerationService.generate_missions(pairs_list)
    if not isinstance(res_list, tuple):
        print_check("Tuple Coercion", False, f"Expected tuple from list input; got {type(res_list)}")
        return

    # Test generator input
    res_gen = MissionGenerationService.generate_missions(p for p in pairs_list)
    if not isinstance(res_gen, tuple):
        print_check("Tuple Coercion", False, f"Expected tuple from generator input; got {type(res_gen)}")
        return

    print_check("Tuple Coercion", True, "Accepts list/generator iterables and coerces output to immutable tuple")


def check_11_single_mission_generation() -> None:
    """Check 11: Verify generate_mission returns a valid Mission object."""
    eval_time = datetime(2026, 8, 4, 12, 0, 0, tzinfo=timezone.utc)
    r = RankedOpportunity(opportunity_id="opp_single", rank=1, priority_score=95.0)
    o = Opportunity(opportunity_id="opp_single", business_id="biz_single", niche_id="seo", opportunity_type_id="seo_audit", discovered_at=eval_time)

    m = MissionGenerationService.generate_mission(r, o)

    if m.opportunity_id != "opp_single" or m.business_id != "biz_single" or m.mission_type != MissionType.AUDIT:
        print_check("Single Mission Generation", False, f"Unexpected Mission fields: {m}")
        return

    print_check("Single Mission Generation", True, "Single mission generated cleanly with correct fields")


def check_12_bulk_mission_generation() -> None:
    """Check 12: Verify generate_missions handles bulk pairs cleanly."""
    eval_time = datetime(2026, 8, 4, 12, 0, 0, tzinfo=timezone.utc)
    pairs = []
    for i in range(50):
        opp_id = f"opp_{i:03d}"
        biz_id = f"biz_{i:03d}"
        r = RankedOpportunity(opportunity_id=opp_id, rank=i + 1, priority_score=100.0 - i)
        o = Opportunity(opportunity_id=opp_id, business_id=biz_id, niche_id="web", opportunity_type_id="general", discovered_at=eval_time)
        pairs.append((r, o))

    missions = MissionGenerationService.generate_missions(pairs)

    if len(missions) != 50:
        print_check("Bulk Mission Generation", False, f"Expected 50 missions; got {len(missions)}")
        return

    print_check("Bulk Mission Generation", True, "Bulk mission cohort generated cleanly (50 items)")


def check_13_input_ordering_preservation() -> None:
    """Check 13: Verify output tuple order strictly matches input pair order."""
    eval_time = datetime(2026, 8, 4, 12, 0, 0, tzinfo=timezone.utc)
    ids = ["opp_charlie", "opp_alpha", "opp_bravo", "opp_delta"]
    pairs = []
    for idx, opp_id in enumerate(ids):
        r = RankedOpportunity(opportunity_id=opp_id, rank=idx + 1, priority_score=50.0)
        o = Opportunity(opportunity_id=opp_id, business_id=f"biz_{opp_id}", niche_id="web", opportunity_type_id="type", discovered_at=eval_time)
        pairs.append((r, o))

    missions = MissionGenerationService.generate_missions(pairs)
    output_ids = [m.opportunity_id for m in missions]

    if output_ids != ids:
        print_check("Input Ordering Preservation", False, f"Expected output order {ids}; got {output_ids}")
        return

    print_check("Input Ordering Preservation", True, "Input ordering strictly preserved in output tuple")


def check_14_pure_determinism() -> None:
    """Check 14: Verify 2,000 repeated executions yield bitwise identical output tuples."""
    eval_time = datetime(2026, 8, 4, 12, 0, 0, tzinfo=timezone.utc)
    r1 = RankedOpportunity(opportunity_id="opp_1", rank=1, priority_score=90.0)
    o1 = Opportunity(opportunity_id="opp_1", business_id="biz_1", niche_id="web", opportunity_type_id="unclaimed_gbp", discovered_at=eval_time)
    r2 = RankedOpportunity(opportunity_id="opp_2", rank=2, priority_score=80.0)
    o2 = Opportunity(opportunity_id="opp_2", business_id="biz_2", niche_id="seo", opportunity_type_id="seo_audit", discovered_at=eval_time)

    pairs = ((r1, o1), (r2, o2))
    base_result = MissionGenerationService.generate_missions(pairs)

    for i in range(2000):
        res = MissionGenerationService.generate_missions(pairs)
        if res != base_result:
            print_check("Pure Determinism", False, f"Determinism failure at iteration {i}")
            return

    print_check("Pure Determinism", True, "2,000 repeated executions yielded bitwise identical Mission tuple outputs")


def check_15_thread_safety() -> None:
    """Check 15: Verify thread safety under multi-threaded concurrent execution."""
    eval_time = datetime(2026, 8, 4, 12, 0, 0, tzinfo=timezone.utc)
    r1 = RankedOpportunity(opportunity_id="opp_1", rank=1, priority_score=90.0)
    o1 = Opportunity(opportunity_id="opp_1", business_id="biz_1", niche_id="web", opportunity_type_id="seo_audit", discovered_at=eval_time)
    pairs = ((r1, o1),)

    results = []

    def task():
        r = MissionGenerationService.generate_missions(pairs)
        results.append(r)

    with ThreadPoolExecutor(max_workers=10) as executor:
        futures = [executor.submit(task) for _ in range(50)]
        for f in futures:
            f.result()

    if len(results) != 50:
        print_check("Thread Safety", False, f"Expected 50 execution results; got {len(results)}")
        return

    first_result = results[0]
    for r in results[1:]:
        if r != first_result:
            print_check("Thread Safety", False, "Thread concurrency output mismatch detected")
            return

    print_check("Thread Safety", True, "Thread safety verified under multi-threaded concurrency")


def check_16_empty_input_handling() -> None:
    """Check 16: Verify empty input tuple returns empty tuple."""
    missions = MissionGenerationService.generate_missions(())
    if missions != ():
        print_check("Empty Input Handling", False, f"Expected (); got {missions}")
        return

    print_check("Empty Input Handling", True, "Empty input handling returned () cleanly")


def check_17_invalid_input_handling() -> None:
    """Check 17: Verify invalid inputs (None, wrong item types, non-tuples) raise TypeError."""
    try:
        MissionGenerationService.generate_mission(None, None)  # type: ignore
        print_check("Invalid Input Handling", False, "Accepted None arguments in generate_mission")
        return
    except TypeError:
        pass

    try:
        MissionGenerationService.generate_missions(None)  # type: ignore
        print_check("Invalid Input Handling", False, "Accepted None argument in generate_missions")
        return
    except TypeError:
        pass

    try:
        # Item is not a 2-tuple
        MissionGenerationService.generate_missions(["invalid_pair"])  # type: ignore
        print_check("Invalid Input Handling", False, "Accepted invalid pair item in generate_missions")
        return
    except TypeError:
        pass

    print_check("Invalid Input Handling", True, "Invalid input arguments strictly rejected with TypeError")


def check_18_subsystem_regression_verification() -> None:
    """Check 18: Ensure Subsystems 9, 10, 11, 12, 13, and 14 remain fully operational end-to-end."""
    eval_time = datetime(2026, 8, 4, 12, 0, 0, tzinfo=timezone.utc)

    # 1. Subsystem 9 — Opportunity Model
    opp = Opportunity(
        opportunity_id="opp_pipeline_1",
        business_id="biz_pipeline_1",
        niche_id="web_design",
        opportunity_type_id="seo_audit_needed",
        discovered_at=eval_time,
        supporting_signal_ids=("sig_1", "sig_2"),
    )

    # 2. Subsystem 10 — Opportunity Qualification
    qual_svc = OpportunityQualificationService()
    qual_res = qual_svc.evaluate(opp)
    if qual_res.status != QualificationStatus.QUALIFIED:
        print_check("Subsystem Regression Verification", False, "Subsystem 10 Qualification failed")
        return

    # 3. Subsystem 11 — Opportunity Scoring
    score_svc = OpportunityScoringService()
    score_res = score_svc.evaluate(opp)
    if score_res.overall_score <= 0.0:
        print_check("Subsystem Regression Verification", False, "Subsystem 11 Scoring failed")
        return

    # 4. Subsystem 12 — Opportunity Prioritization
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

    # 5. Subsystem 13 — Opportunity Ranking
    ranked_tuple = OpportunityRankingService.rank_opportunities([prio_res])
    if len(ranked_tuple) != 1 or ranked_tuple[0].rank != 1:
        print_check("Subsystem Regression Verification", False, "Subsystem 13 Ranking failed")
        return

    # 6. Subsystem 14 — Mission Generation Integration
    ranked_opp = ranked_tuple[0]
    missions = MissionGenerationService.generate_missions([(ranked_opp, opp)])

    if len(missions) != 1:
        print_check("Subsystem Regression Verification", False, "Subsystem 14 Mission Generation failed")
        return

    mission = missions[0]
    if (
        mission.opportunity_id != "opp_pipeline_1"
        or mission.business_id != "biz_pipeline_1"
        or mission.mission_type != MissionType.AUDIT
    ):
        print_check("Subsystem Regression Verification", False, f"End-to-end pipeline produced invalid Mission: {mission}")
        return

    print_check("Subsystem Regression Verification", True, "Subsystems 9–14 end-to-end pipeline 100% operational with zero regressions")


def main() -> None:
    print("==================================================================")
    print("MAST Lead Engine 2.0 — Subsystem 14 Mission Generation Validation ")
    print("==================================================================")
    print()

    check_1_import_isolation()
    check_2_ast_analysis()
    check_3_absence_of_registries()
    check_4_model_immutability()
    check_5_mission_type_enum()
    check_6_mission_model_validation()
    check_7_non_empty_ids()
    check_8_lineage_mismatch_detection()
    check_9_mission_type_derivation_correctness()
    check_10_tuple_coercion()
    check_11_single_mission_generation()
    check_12_bulk_mission_generation()
    check_13_input_ordering_preservation()
    check_14_pure_determinism()
    check_15_thread_safety()
    check_16_empty_input_handling()
    check_17_invalid_input_handling()
    check_18_subsystem_regression_verification()

    print()
    print("==================================================================")
    print("ALL 18 VALIDATION CHECKS PASSED SUCCESSFULLY.")
    print("Subsystem 14 (Mission Generation) is Architecturally Frozen.")
    print("==================================================================")


if __name__ == "__main__":
    main()
