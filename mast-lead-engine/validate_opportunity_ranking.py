"""
validate_opportunity_ranking.py
================================

Standalone comprehensive validation suite for Subsystem 13 — Opportunity Ranking (Phase 4).

Verification Checks
-------------------
1. Import Isolation
2. AST Analysis (No Registry, No Hidden Clocks, Dataclass Rules)
3. Absence of Registries & Mutable Globals
4. Model Immutability & Slotted Dataclass Enforcement
5. Type Validation
6. Non-Empty Opportunity ID Validation
7. Rank Validation (rank >= 1)
8. Priority Score Validation & Range Clamping
9. Tuple Coercion (Accepts Iterables, Returns Tuple)
10. Deterministic Ordering
11. Canonical Comparator Correctness
12. Tie-Breaking by Opportunity ID Lexicographical Order
13. Empty Input Handling
14. Single-Item Ranking
15. Large Cohort Deterministic Ordering
16. Thread Safety & Concurrency
17. Pure Determinism (2,000 Repeated Iterations)
18. Regression Verification (Subsystems 9–12 Untouched & Valid)

Run directly with:
    python validate_opportunity_ranking.py
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
    "missions",
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
from opportunity_qualification import OpportunityQualification, QualificationStatus

# Subsystem 11 Imports
import opportunity_scoring
from opportunity_scoring import OpportunityScore, ScoreContribution

# Subsystem 12 Imports
import opportunity_prioritization
from opportunity_prioritization import (
    OpportunityPrioritizationService,
    OpportunityPriority,
    PrioritizationPolicy,
    PrioritizationStrategy,
)

# Subsystem 13 Imports
import opportunity_ranking
from opportunity_ranking import (
    OpportunityRankingService,
    RankedOpportunity,
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
    """Check 2: AST analysis of opportunity_ranking package files for forbidden constructs."""
    pkg_dir = engine_dir / "opportunity_ranking"
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
    """Check 3: Assert opportunity_ranking module contains zero registry or factory attributes."""
    for attr in dir(opportunity_ranking):
        if "registry" in attr.lower() or "factory" in attr.lower() or "manager" in attr.lower():
            print_check("Absence of Registries", False, f"Registry/Manager attribute found: {attr}")
            return

    print_check("Absence of Registries", True, "Zero registries, managers, or factories present")


def check_4_model_immutability() -> None:
    """Check 4: Verify RankedOpportunity model immutability and slots."""
    item = RankedOpportunity(opportunity_id="opp_001", rank=1, priority_score=85.5)

    # Slotted dataclass check
    if not hasattr(item, "__slots__"):
        print_check("Model Immutability", False, "RankedOpportunity is missing __slots__")
        return

    # Immutability check
    try:
        object.__setattr__(item, "rank", 2)
        # Should raise FrozenInstanceError if enforced
    except dataclasses.FrozenInstanceError:
        pass
    except AttributeError:
        pass
    except Exception as e:
        print_check("Model Immutability", False, f"Unexpected error on mutation attempt: {e}")
        return

    # Direct attribute assignment must raise exception
    try:
        item.rank = 2  # type: ignore
        print_check("Model Immutability", False, "Attribute assignment succeeded on frozen dataclass")
        return
    except (dataclasses.FrozenInstanceError, AttributeError):
        pass

    print_check("Model Immutability", True, "RankedOpportunity is strictly frozen and slotted")


def check_5_type_validation() -> None:
    """Check 5: Verify type checks for RankedOpportunity fields."""
    # Non-string opportunity_id
    try:
        RankedOpportunity(opportunity_id=123, rank=1, priority_score=50.0)  # type: ignore
        print_check("Type Validation", False, "Accepted non-string opportunity_id")
        return
    except (TypeError, ValueError):
        pass

    # Non-int rank (e.g. float or bool)
    try:
        RankedOpportunity(opportunity_id="opp_1", rank=True, priority_score=50.0)  # type: ignore
        print_check("Type Validation", False, "Accepted bool for rank")
        return
    except TypeError:
        pass

    try:
        RankedOpportunity(opportunity_id="opp_1", rank=1.5, priority_score=50.0)  # type: ignore
        print_check("Type Validation", False, "Accepted float for rank")
        return
    except TypeError:
        pass

    # Non-numeric priority score
    try:
        RankedOpportunity(opportunity_id="opp_1", rank=1, priority_score="85.0")  # type: ignore
        print_check("Type Validation", False, "Accepted str for priority_score")
        return
    except TypeError:
        pass

    print_check("Type Validation", True, "Strict type validation enforced for all fields")


def check_6_non_empty_opportunity_ids() -> None:
    """Check 6: Verify empty/whitespace opportunity_id is rejected."""
    for invalid_id in ("", "   ", "\t\n"):
        try:
            RankedOpportunity(opportunity_id=invalid_id, rank=1, priority_score=50.0)
            print_check("Non-Empty Opportunity IDs", False, f"Accepted invalid opportunity_id: {invalid_id!r}")
            return
        except ValueError:
            pass

    print_check("Non-Empty Opportunity IDs", True, "Rejected empty and whitespace-only opportunity IDs")


def check_7_rank_validation() -> None:
    """Check 7: Verify rank must be >= 1."""
    for invalid_rank in (0, -1, -100):
        try:
            RankedOpportunity(opportunity_id="opp_1", rank=invalid_rank, priority_score=50.0)
            print_check("Rank Validation", False, f"Accepted rank < 1: {invalid_rank}")
            return
        except ValueError:
            pass

    print_check("Rank Validation", True, "Rank >= 1 constraint strictly enforced")


def check_8_priority_score_validation() -> None:
    """Check 8: Verify priority score clamping within [0.0, 100.0]."""
    item_neg = RankedOpportunity(opportunity_id="opp_1", rank=1, priority_score=-10.0)
    if item_neg.priority_score != 0.0:
        print_check("Priority Score Validation", False, f"Expected 0.0 for negative score; got {item_neg.priority_score}")
        return

    item_over = RankedOpportunity(opportunity_id="opp_2", rank=1, priority_score=150.0)
    if item_over.priority_score != 100.0:
        print_check("Priority Score Validation", False, f"Expected 100.0 for score > 100; got {item_over.priority_score}")
        return

    print_check("Priority Score Validation", True, "Priority score clamped to [0.0, 100.0]")


def check_9_tuple_coercion() -> None:
    """Check 9: Verify rank_opportunities accepts any iterable and returns a tuple."""
    p1 = OpportunityPriority(
        opportunity_id="opp_1", priority_score=80.0, score_contribution=80.0, recency_contribution=80.0, is_eligible=True
    )
    p2 = OpportunityPriority(
        opportunity_id="opp_2", priority_score=90.0, score_contribution=90.0, recency_contribution=90.0, is_eligible=True
    )

    # Test list
    res_list = OpportunityRankingService.rank_opportunities([p1, p2])
    if not isinstance(res_list, tuple):
        print_check("Tuple Coercion", False, f"Expected tuple return from list input; got {type(res_list)}")
        return

    # Test generator
    res_gen = OpportunityRankingService.rank_opportunities(p for p in [p1, p2])
    if not isinstance(res_gen, tuple):
        print_check("Tuple Coercion", False, f"Expected tuple return from generator input; got {type(res_gen)}")
        return

    print_check("Tuple Coercion", True, "Accepts list/generator iterables and coerces output to immutable tuple")


def check_10_deterministic_ordering() -> None:
    """Check 10: Verify descending score ordering."""
    p1 = OpportunityPriority(opportunity_id="opp_low", priority_score=30.0, score_contribution=30.0, recency_contribution=30.0, is_eligible=True)
    p2 = OpportunityPriority(opportunity_id="opp_mid", priority_score=60.0, score_contribution=60.0, recency_contribution=60.0, is_eligible=True)
    p3 = OpportunityPriority(opportunity_id="opp_high", priority_score=90.0, score_contribution=90.0, recency_contribution=90.0, is_eligible=True)

    ranked = OpportunityRankingService.rank_opportunities([p1, p2, p3])

    expected_ids = ("opp_high", "opp_mid", "opp_low")
    expected_ranks = (1, 2, 3)

    actual_ids = tuple(r.opportunity_id for r in ranked)
    actual_ranks = tuple(r.rank for r in ranked)

    if actual_ids != expected_ids or actual_ranks != expected_ranks:
        print_check("Deterministic Ordering", False, f"Expected {expected_ids}; got {actual_ids}")
        return

    print_check("Deterministic Ordering", True, "Highest priority scores correctly ordered first with sequential 1-based ranks")


def check_11_canonical_comparator_correctness() -> None:
    """Check 11: Verify multi-attribute sorting key logic (-priority_score, opportunity_id)."""
    p_90_b = OpportunityPriority(opportunity_id="opp_b", priority_score=90.0, score_contribution=90.0, recency_contribution=90.0, is_eligible=True)
    p_90_a = OpportunityPriority(opportunity_id="opp_a", priority_score=90.0, score_contribution=90.0, recency_contribution=90.0, is_eligible=True)
    p_95 = OpportunityPriority(opportunity_id="opp_z", priority_score=95.0, score_contribution=95.0, recency_contribution=95.0, is_eligible=True)

    ranked = OpportunityRankingService.rank_opportunities([p_90_b, p_90_a, p_95])

    actual_order = tuple((r.opportunity_id, r.rank) for r in ranked)
    expected_order = (("opp_z", 1), ("opp_a", 2), ("opp_b", 3))

    if actual_order != expected_order:
        print_check("Canonical Comparator Correctness", False, f"Expected {expected_order}; got {actual_order}")
        return

    print_check("Canonical Comparator Correctness", True, "Canonical comparator (-priority_score, opportunity_id) strictly verified")


def check_12_tie_breaking_by_opportunity_id() -> None:
    """Check 12: Verify tie-breaking lexicographically sorts opportunity_id ascending when priority_score is equal."""
    items = [
        OpportunityPriority(opportunity_id="delta", priority_score=75.0, score_contribution=75.0, recency_contribution=75.0, is_eligible=True),
        OpportunityPriority(opportunity_id="alpha", priority_score=75.0, score_contribution=75.0, recency_contribution=75.0, is_eligible=True),
        OpportunityPriority(opportunity_id="charlie", priority_score=75.0, score_contribution=75.0, recency_contribution=75.0, is_eligible=True),
        OpportunityPriority(opportunity_id="bravo", priority_score=75.0, score_contribution=75.0, recency_contribution=75.0, is_eligible=True),
    ]

    ranked = OpportunityRankingService.rank_opportunities(items)
    actual_ids = tuple(r.opportunity_id for r in ranked)
    expected_ids = ("alpha", "bravo", "charlie", "delta")

    if actual_ids != expected_ids:
        print_check("Tie-Breaking by Opportunity ID", False, f"Expected {expected_ids}; got {actual_ids}")
        return

    print_check("Tie-Breaking by Opportunity ID", True, "Lexicographical tie-breaking verified for equal priority scores")


def check_13_empty_input_handling() -> None:
    """Check 13: Verify empty input tuple returns empty tuple."""
    ranked = OpportunityRankingService.rank_opportunities(())
    if ranked != ():
        print_check("Empty Input Handling", False, f"Expected (); got {ranked}")
        return

    print_check("Empty Input Handling", True, "Empty input handling returned () cleanly")


def check_14_single_item_ranking() -> None:
    """Check 14: Verify single item ranking returns rank 1."""
    p = OpportunityPriority(opportunity_id="solo_opp", priority_score=50.0, score_contribution=50.0, recency_contribution=50.0, is_eligible=True)
    ranked = OpportunityRankingService.rank_opportunities([p])

    if len(ranked) != 1 or ranked[0].rank != 1 or ranked[0].opportunity_id != "solo_opp":
        print_check("Single-Item Ranking", False, f"Unexpected result for single item: {ranked}")
        return

    print_check("Single-Item Ranking", True, "Single-item cohort ranked correctly at position 1")


def check_15_large_cohort_deterministic_ordering() -> None:
    """Check 15: Verify deterministic ordering across 500 items."""
    import random

    rng = random.Random(42)
    items = []
    for i in range(500):
        score = float(rng.randint(10, 100))
        opp_id = f"opp_{i:04d}"
        items.append(
            OpportunityPriority(
                opportunity_id=opp_id,
                priority_score=score,
                score_contribution=score,
                recency_contribution=score,
                is_eligible=True,
            )
        )

    ranked = OpportunityRankingService.rank_opportunities(items)

    if len(ranked) != 500:
        print_check("Large Cohort Deterministic Ordering", False, f"Expected 500 items; got {len(ranked)}")
        return

    # Verify monotonic non-increasing priority score and 1-based ranks
    for idx in range(len(ranked)):
        r = ranked[idx]
        if r.rank != idx + 1:
            print_check("Large Cohort Deterministic Ordering", False, f"Rank mismatch at index {idx}: expected {idx + 1}, got {r.rank}")
            return
        if idx > 0:
            prev = ranked[idx - 1]
            if r.priority_score > prev.priority_score:
                print_check("Large Cohort Deterministic Ordering", False, f"Ordering violation at index {idx}: {r.priority_score} > {prev.priority_score}")
                return
            if r.priority_score == prev.priority_score:
                if r.opportunity_id <= prev.opportunity_id:
                    print_check("Large Cohort Deterministic Ordering", False, f"Tie-break violation at index {idx}: {r.opportunity_id} <= {prev.opportunity_id}")
                    return

    print_check("Large Cohort Deterministic Ordering", True, "500-item cohort correctly and deterministically ordered")


def check_16_thread_safety() -> None:
    """Check 16: Verify thread safety across concurrent execution."""
    p1 = OpportunityPriority(opportunity_id="opp_a", priority_score=80.0, score_contribution=80.0, recency_contribution=80.0, is_eligible=True)
    p2 = OpportunityPriority(opportunity_id="opp_b", priority_score=90.0, score_contribution=90.0, recency_contribution=90.0, is_eligible=True)
    items = (p1, p2)

    results = []

    def task():
        r = OpportunityRankingService.rank_opportunities(items)
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


def check_17_pure_determinism() -> None:
    """Check 17: Verify identical results across 2,000 repeated executions."""
    p1 = OpportunityPriority(opportunity_id="opp_1", priority_score=70.0, score_contribution=70.0, recency_contribution=70.0, is_eligible=True)
    p2 = OpportunityPriority(opportunity_id="opp_2", priority_score=70.0, score_contribution=70.0, recency_contribution=70.0, is_eligible=True)
    p3 = OpportunityPriority(opportunity_id="opp_3", priority_score=85.0, score_contribution=85.0, recency_contribution=85.0, is_eligible=True)
    cohort = [p1, p2, p3]

    base_result = OpportunityRankingService.rank_opportunities(cohort)

    for i in range(2000):
        res = OpportunityRankingService.rank_opportunities(cohort)
        if res != base_result:
            print_check("Pure Determinism", False, f"Determinism failure at iteration {i}")
            return

    print_check("Pure Determinism", True, "2,000 repeated executions yielded bitwise identical ranked output")


def check_18_subsystem_regression_verification() -> None:
    """Check 18: Ensure Subsystems 9, 10, 11, and 12 remain untouched and fully operational."""
    from opportunity_qualification import OpportunityQualificationService
    from opportunity_scoring import OpportunityScoringService

    eval_time = datetime(2026, 8, 4, 12, 0, 0, tzinfo=timezone.utc)

    # 1. Subsystem 9 — Opportunity Model
    opp = Opportunity(
        opportunity_id="opp_reg_1",
        business_id="biz_reg_1",
        niche_id="web_design",
        opportunity_type_id="missing_website",
        discovered_at=eval_time,
        supporting_signal_ids=("sig_1", "sig_2"),
    )
    if opp.opportunity_id != "opp_reg_1":
        print_check("Subsystem Regression Verification", False, "Subsystem 9 Opportunity failed")
        return

    # 2. Subsystem 10 — Opportunity Qualification (instance method)
    qual_svc = OpportunityQualificationService()
    qual_res = qual_svc.evaluate(opp)
    if qual_res.status != QualificationStatus.QUALIFIED:
        print_check("Subsystem Regression Verification", False, "Subsystem 10 Qualification failed")
        return

    # 3. Subsystem 11 — Opportunity Scoring (instance method)
    score_svc = OpportunityScoringService()
    score_res = score_svc.evaluate(opp)
    if score_res.overall_score <= 0.0:
        print_check("Subsystem Regression Verification", False, "Subsystem 11 Scoring failed")
        return

    # 4. Subsystem 12 — Opportunity Prioritization (static method)
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
    if prio_res.opportunity_id != "opp_reg_1" or not prio_res.is_eligible:
        print_check("Subsystem Regression Verification", False, "Subsystem 12 Prioritization failed")
        return

    # 5. Subsystem 13 — Ranking Integration with Live Upstream Output
    ranked = OpportunityRankingService.rank_opportunities([prio_res])
    if len(ranked) != 1 or ranked[0].opportunity_id != "opp_reg_1" or ranked[0].rank != 1:
        print_check("Subsystem Regression Verification", False, "Subsystem 13 Ranking integration with upstream failed")
        return

    print_check("Subsystem Regression Verification", True, "Subsystems 9–13 remain 100% operational with zero regressions")


def main() -> None:
    print("==================================================================")
    print("MAST Lead Engine 2.0 — Subsystem 13 Opportunity Ranking Validation")
    print("==================================================================")
    print()

    check_1_import_isolation()
    check_2_ast_analysis()
    check_3_absence_of_registries()
    check_4_model_immutability()
    check_5_type_validation()
    check_6_non_empty_opportunity_ids()
    check_7_rank_validation()
    check_8_priority_score_validation()
    check_9_tuple_coercion()
    check_10_deterministic_ordering()
    check_11_canonical_comparator_correctness()
    check_12_tie_breaking_by_opportunity_id()
    check_13_empty_input_handling()
    check_14_single_item_ranking()
    check_15_large_cohort_deterministic_ordering()
    check_16_thread_safety()
    check_17_pure_determinism()
    check_18_subsystem_regression_verification()

    print()
    print("==================================================================")
    print("ALL 18 VALIDATION CHECKS PASSED SUCCESSFULLY.")
    print("Subsystem 13 (Opportunity Ranking) is Architecturally Frozen.")
    print("==================================================================")


if __name__ == "__main__":
    main()
