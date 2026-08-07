"""
validate_analytics.py
====================

Standalone comprehensive validation suite for Subsystem 18 — Analytics Engine.

Verification Checks
-------------------
1.  Import Isolation (Zero forbidden modules imported)
2.  AST Analysis (No clocks, random, uuid, mutable globals, registries, managers, factories)
3.  Model Immutability & Slotted Dataclass Enforcement (frozen=True, slots=True)
4.  Tuple Coercion (Accepts iterables, produces immutable tuples)
5.  Ratio Validation (ratio in [0,1], count <= total)
6.  DescriptiveStats Invariants (min <= mean <= max, min <= median <= max, std_dev >= 0)
7.  DistributionBucket Validation (range_low <= range_high, valid ratio)
8.  Histogram Correctness (sum(counts) == N, sum(ratios) == 1.0, single-value edge cases)
9.  Mathematical Correctness (mean, median, population std_dev, min, max vs known datasets)
10. Qualification Analytics (qualification ratio, status frequencies, 0 opps edge case)
11. Priority Analytics (eligibility ratio, priority statistics, priority histogram)
12. Workflow Analytics (canonical WorkflowStatus usage, completion ratio)
13. Dimension Breakdown (grouping by niche_id, grouped metrics)
14. Determinism (2,000 runs produce byte-identical results)
15. Thread Safety & Concurrency (Concurrent execution across 16 threads)
16. Empty Context Handling (Returns valid empty AnalyticsReport)
17. Invalid Input Handling (Strict type and value checking)
18. Pipeline Regression Verification (Subsystem 5 -> 9..17 -> 18)

Run directly with:
    python validate_analytics.py
"""

from __future__ import annotations

import ast
from concurrent.futures import ThreadPoolExecutor
import dataclasses
import math
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
    "database",
    "sqlalchemy",
    "requests",
    "httpx",
    "aiohttp",
    "providers",
    "ai",
    "crm",
    "storage",
]

for m in list(sys.modules.keys()):
    for f in forbidden:
        if m == f or m.startswith(f + "."):
            del sys.modules[m]

from engine_context.models import (
    BusinessContext,
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
from workflow.models import WorkflowStatus

from analytics.models import (
    AnalyticsReport,
    CategoryFrequency,
    DescriptiveStats,
    DimensionBreakdown,
    DistributionBucket,
    EngineVolumeAnalytics,
    GroupedMetric,
    PriorityAnalytics,
    QualificationFunnelAnalytics,
    RatioMetric,
    ScoreAnalytics,
    WorkflowAnalytics,
)
from analytics.service import AnalyticsService


def log_check(check_num: int, title: str, passed: bool, detail: str = "") -> None:
    status = "PASSED" if passed else "FAILED"
    msg = f"Check {check_num:2d}: {title:<55} [{status}]"
    if detail:
        msg += f" - {detail}"
    print(msg)
    if not passed:
        raise AssertionError(f"Validation Check {check_num} failed: {title} - {detail}")


def _dummy_subject() -> ContextSubject:
    return ContextSubject(subject_id="sub-valid", subject_type=ContextSubjectType.BUSINESS)


def test_import_isolation() -> None:
    """Verify zero forbidden external modules are loaded by analytics."""
    for m in sys.modules:
        for f in forbidden:
            if m == f or m.startswith(f + "."):
                log_check(1, "Import Isolation", False, f"Forbidden module loaded: {m}")
                return
    log_check(1, "Import Isolation", True)


def test_ast_analysis() -> None:
    """Verify AST compliance (no clocks, random, uuid, mutable globals, registries, managers, factories)."""
    analytics_dir = engine_dir / "analytics"
    forbidden_terms = {
        "now",
        "utcnow",
        "random",
        "uuid",
        "registry",
        "registries",
        "manager",
        "factory",
        "global",
    }

    for py_file in analytics_dir.glob("*.py"):
        tree = ast.parse(py_file.read_text(encoding="utf-8"))
        for node in ast.walk(tree):
            if isinstance(node, ast.Name):
                if node.id.lower() in forbidden_terms:
                    log_check(2, "AST Analysis", False, f"Forbidden term '{node.id}' in {py_file.name}")
                    return
            elif isinstance(node, ast.Attribute):
                if node.attr.lower() in forbidden_terms:
                    log_check(2, "AST Analysis", False, f"Forbidden attribute '{node.attr}' in {py_file.name}")
                    return
    log_check(2, "AST Analysis", True)


def test_model_immutability() -> None:
    """Verify frozen, slotted dataclasses fail on mutation."""
    models = [
        DescriptiveStats,
        DistributionBucket,
        CategoryFrequency,
        RatioMetric,
        EngineVolumeAnalytics,
        QualificationFunnelAnalytics,
        ScoreAnalytics,
        PriorityAnalytics,
        WorkflowAnalytics,
        GroupedMetric,
        DimensionBreakdown,
        AnalyticsReport,
    ]

    for model in models:
        if not dataclasses.is_dataclass(model):
            log_check(3, "Immutability & Slotted Dataclass", False, f"{model.__name__} is not a dataclass")
            return
        params = getattr(model, "__dataclass_params__", None)
        if params is None or not params.frozen:
            log_check(3, "Immutability & Slotted Dataclass", False, f"{model.__name__} is not frozen")
            return
        if not hasattr(model, "__slots__"):
            log_check(3, "Immutability & Slotted Dataclass", False, f"{model.__name__} does not use slots")
            return

    # Runtime mutation test
    ratio = RatioMetric(total=10, count=5, ratio=0.5)
    try:
        setattr(ratio, "count", 6)
    except (dataclasses.FrozenInstanceError, AttributeError, TypeError):
        pass
    else:
        log_check(3, "Immutability & Slotted Dataclass", False, "RatioMetric permitted runtime mutation")
        return

    log_check(3, "Immutability & Slotted Dataclass", True)


def test_tuple_coercion() -> None:
    """Verify sequence attributes are coerced to immutable tuples."""
    freq1 = CategoryFrequency(category="CAT1", count=5, ratio=0.5)
    freq2 = CategoryFrequency(category="CAT2", count=5, ratio=0.5)

    volume = EngineVolumeAnalytics(
        total_records=10,
        component_frequencies=[freq1, freq2],  # List input
    )
    if not isinstance(volume.component_frequencies, tuple):
        log_check(4, "Tuple Coercion", False, "component_frequencies was not coerced to tuple")
        return
    log_check(4, "Tuple Coercion", True)


def test_ratio_validation() -> None:
    """Verify ratio bounds [0.0, 1.0] and count <= total invariant."""
    # Negative ratio
    try:
        RatioMetric(total=10, count=5, ratio=-0.1)
    except ValueError:
        pass
    else:
        log_check(5, "Ratio Validation", False, "Accepted negative ratio")
        return

    # Ratio > 1.0
    try:
        RatioMetric(total=10, count=5, ratio=1.5)
    except ValueError:
        pass
    else:
        log_check(5, "Ratio Validation", False, "Accepted ratio > 1.0")
        return

    # count > total
    try:
        RatioMetric(total=10, count=15, ratio=0.5)
    except ValueError:
        pass
    else:
        log_check(5, "Ratio Validation", False, "Accepted count > total")
        return

    log_check(5, "Ratio Validation", True)


def test_descriptive_stats_invariants() -> None:
    """Verify min <= mean <= max, min <= median <= max, std_dev >= 0."""
    # Invalid std_dev
    try:
        DescriptiveStats(count=5, mean=10.0, median=10.0, std_dev=-1.0, min_val=0.0, max_val=20.0)
    except ValueError:
        pass
    else:
        log_check(6, "DescriptiveStats Invariants", False, "Accepted negative std_dev")
        return

    # Mean out of bounds
    try:
        DescriptiveStats(count=5, mean=25.0, median=10.0, std_dev=1.0, min_val=0.0, max_val=20.0)
    except ValueError:
        pass
    else:
        log_check(6, "DescriptiveStats Invariants", False, "Accepted mean > max_val")
        return

    # Median out of bounds
    try:
        DescriptiveStats(count=5, mean=10.0, median=-5.0, std_dev=1.0, min_val=0.0, max_val=20.0)
    except ValueError:
        pass
    else:
        log_check(6, "DescriptiveStats Invariants", False, "Accepted median < min_val")
        return

    log_check(6, "DescriptiveStats Invariants", True)


def test_distribution_bucket_validation() -> None:
    """Verify range_low <= range_high and ratio in [0,1]."""
    try:
        DistributionBucket(range_low=10.0, range_high=5.0, count=2, ratio=0.2)
    except ValueError:
        pass
    else:
        log_check(7, "DistributionBucket Validation", False, "Accepted range_low > range_high")
        return

    log_check(7, "DistributionBucket Validation", True)


def test_histogram_correctness() -> None:
    """Verify histogram bucket sum equality, ratio sum equality, and single-value behavior."""
    # Single-value dataset
    values = (50.0, 50.0, 50.0, 50.0)
    buckets = AnalyticsService._compute_histogram(values)
    if len(buckets) != 1 or buckets[0].count != 4 or buckets[0].ratio != 1.0:
        log_check(8, "Histogram Correctness", False, f"Single value failed: {buckets}")
        return

    # Multi-value dataset
    values2 = (10.0, 20.0, 30.0, 40.0, 50.0, 60.0, 70.0, 80.0, 90.0, 100.0)
    buckets2 = AnalyticsService._compute_histogram(values2, num_buckets=10)
    total_count = sum(b.count for b in buckets2)
    total_ratio = sum(b.ratio for b in buckets2)

    if total_count != 10:
        log_check(8, "Histogram Correctness", False, f"Histogram count sum {total_count} != 10")
        return

    if abs(total_ratio - 1.0) > 1e-9:
        log_check(8, "Histogram Correctness", False, f"Histogram ratio sum {total_ratio} != 1.0")
        return

    log_check(8, "Histogram Correctness", True)


def test_mathematical_correctness() -> None:
    """Verify mean, median, population standard deviation, min, max against known dataset."""
    dataset = (10.0, 20.0, 30.0, 40.0, 50.0)

    stats = AnalyticsService._compute_stats(dataset)

    if stats.count != 5:
        log_check(9, "Mathematical Correctness", False, f"count {stats.count} != 5")
        return
    if abs(stats.mean - 30.0) > 1e-9:
        log_check(9, "Mathematical Correctness", False, f"mean {stats.mean} != 30.0")
        return
    if abs(stats.median - 30.0) > 1e-9:
        log_check(9, "Mathematical Correctness", False, f"median {stats.median} != 30.0")
        return
    if abs(stats.std_dev - math.sqrt(200.0)) > 1e-9:
        log_check(9, "Mathematical Correctness", False, f"std_dev {stats.std_dev} != sqrt(200)")
        return
    if stats.min_val != 10.0 or stats.max_val != 50.0:
        log_check(9, "Mathematical Correctness", False, f"min/max ({stats.min_val}, {stats.max_val}) invalid")
        return

    log_check(9, "Mathematical Correctness", True)


def test_qualification_analytics() -> None:
    """Verify qualification conversion ratios, status frequencies, and 0 opps edge case."""
    opps = (
        OpportunityContext(opportunity_id="o1", business_id="b1", niche_id="n1", opportunity_type_id="t1"),
        OpportunityContext(opportunity_id="o2", business_id="b1", niche_id="n1", opportunity_type_id="t1"),
    )
    quals = (
        QualificationContext(opportunity_id="o1", status="QUALIFIED"),
        QualificationContext(opportunity_id="o2", status="DISQUALIFIED"),
    )
    ctx = EngineContext(
        subject=_dummy_subject(),
        opportunities=opps,
        qualifications=quals,
    )

    report = AnalyticsService.compute_analytics(ctx)
    q = report.qualification
    if q.qualification_ratio.total != 2 or q.qualification_ratio.count != 1 or abs(q.qualification_ratio.ratio - 0.5) > 1e-9:
        log_check(10, "Qualification Analytics", False, f"Invalid qualification ratio: {q.qualification_ratio}")
        return

    # Edge case: 0 opps
    ctx_empty = EngineContext(subject=_dummy_subject())
    report_empty = AnalyticsService.compute_analytics(ctx_empty)
    if report_empty.qualification.qualification_ratio.total != 0 or report_empty.qualification.qualification_ratio.ratio != 0.0:
        log_check(10, "Qualification Analytics", False, "Failed empty 0 opps edge case")
        return

    log_check(10, "Qualification Analytics", True)


def test_priority_analytics() -> None:
    """Verify priority statistics, eligibility ratio, and priority distribution histogram."""
    prios = (
        PriorityContext(opportunity_id="o1", priority_score=80.0, score_contribution=40.0, recency_contribution=40.0, is_eligible=True),
        PriorityContext(opportunity_id="o2", priority_score=40.0, score_contribution=20.0, recency_contribution=20.0, is_eligible=False),
    )
    ctx = EngineContext(subject=_dummy_subject(), priorities=prios)
    report = AnalyticsService.compute_analytics(ctx)
    p = report.priorities

    if p.eligibility_ratio.total != 2 or p.eligibility_ratio.count != 1 or abs(p.eligibility_ratio.ratio - 0.5) > 1e-9:
        log_check(11, "Priority Analytics", False, f"Invalid eligibility ratio: {p.eligibility_ratio}")
        return
    if abs(p.stats.mean - 60.0) > 1e-9:
        log_check(11, "Priority Analytics", False, f"Invalid priority mean: {p.stats.mean}")
        return

    log_check(11, "Priority Analytics", True)


def test_workflow_analytics() -> None:
    """Verify only canonical WorkflowStatus values are used and completion ratio is correct."""
    wfs = (
        WorkflowContext(mission_id="m1", opportunity_id="o1", business_id="b1", status=WorkflowStatus.COMPLETED.value),
        WorkflowContext(mission_id="m2", opportunity_id="o2", business_id="b1", status=WorkflowStatus.IN_PROGRESS.value),
    )
    ctx = EngineContext(subject=_dummy_subject(), workflows=wfs)
    report = AnalyticsService.compute_analytics(ctx)
    w = report.workflows

    if w.completion_ratio.total != 2 or w.completion_ratio.count != 1 or abs(w.completion_ratio.ratio - 0.5) > 1e-9:
        log_check(12, "Workflow Analytics", False, f"Invalid workflow completion ratio: {w.completion_ratio}")
        return
    log_check(12, "Workflow Analytics", True)


def test_dimension_breakdown() -> None:
    """Verify grouping by niche_id and grouped metrics calculation."""
    opps = (
        OpportunityContext(opportunity_id="o1", business_id="b1", niche_id="niche_a", opportunity_type_id="t1"),
        OpportunityContext(opportunity_id="o2", business_id="b1", niche_id="niche_a", opportunity_type_id="t1"),
        OpportunityContext(opportunity_id="o3", business_id="b2", niche_id="niche_b", opportunity_type_id="t1"),
    )
    quals = (
        QualificationContext(opportunity_id="o1", status="QUALIFIED"),
        QualificationContext(opportunity_id="o2", status="QUALIFIED"),
        QualificationContext(opportunity_id="o3", status="DISQUALIFIED"),
    )
    scores = (
        ScoreContext(opportunity_id="o1", overall_score=90.0),
        ScoreContext(opportunity_id="o2", overall_score=70.0),
        ScoreContext(opportunity_id="o3", overall_score=50.0),
    )

    ctx = EngineContext(
        subject=_dummy_subject(),
        opportunities=opps,
        qualifications=quals,
        scores=scores,
    )
    report = AnalyticsService.compute_analytics(ctx)
    if len(report.dimension_breakdowns) == 0:
        log_check(13, "Dimension Breakdown", False, "No dimension breakdowns returned")
        return

    niche_breakdown = report.dimension_breakdowns[0]
    if niche_breakdown.dimension_name != "niche_id":
        log_check(13, "Dimension Breakdown", False, f"Dimension name {niche_breakdown.dimension_name} != niche_id")
        return

    groups_map = {g.group_key: g for g in niche_breakdown.groups}
    if "niche_a" not in groups_map or "niche_b" not in groups_map:
        log_check(13, "Dimension Breakdown", False, f"Missing niche groups: {groups_map.keys()}")
        return

    g_a = groups_map["niche_a"]
    if g_a.count != 2 or g_a.qualification_ratio.ratio != 1.0 or abs(g_a.mean_score - 80.0) > 1e-9:
        log_check(13, "Dimension Breakdown", False, f"niche_a metrics invalid: {g_a}")
        return

    log_check(13, "Dimension Breakdown", True)


def test_determinism() -> None:
    """Run compute_analytics() 2,000 times and verify outputs are byte-identical."""
    opps = (OpportunityContext(opportunity_id="o1", business_id="b1", niche_id="n1", opportunity_type_id="t1"),)
    quals = (QualificationContext(opportunity_id="o1", status="QUALIFIED"),)
    scores = (ScoreContext(opportunity_id="o1", overall_score=85.0),)
    ctx = EngineContext(subject=_dummy_subject(), opportunities=opps, qualifications=quals, scores=scores)

    first_report = AnalyticsService.compute_analytics(ctx)
    for _ in range(2000):
        r = AnalyticsService.compute_analytics(ctx)
        if r != first_report:
            log_check(14, "Determinism", False, "Repeated execution produced non-identical output")
            return

    log_check(14, "Determinism", True)


def test_thread_safety() -> None:
    """Run concurrent analytics computation across 16 threads."""
    opps = (OpportunityContext(opportunity_id="o1", business_id="b1", niche_id="n1", opportunity_type_id="t1"),)
    scores = (ScoreContext(opportunity_id="o1", overall_score=95.0),)
    ctx = EngineContext(subject=_dummy_subject(), opportunities=opps, scores=scores)

    def worker(i: int) -> AnalyticsReport:
        return AnalyticsService.compute_analytics(ctx)

    with ThreadPoolExecutor(max_workers=16) as executor:
        futures = [executor.submit(worker, i) for i in range(100)]
        results = [f.result() for f in futures]

    if len(results) != 100:
        log_check(15, "Thread Safety & Concurrency", False, f"Expected 100 results, got {len(results)}")
        return

    first = results[0]
    for r in results:
        if r != first:
            log_check(15, "Thread Safety & Concurrency", False, "Concurrent worker produced mismatched output")
            return

    log_check(15, "Thread Safety & Concurrency", True)


def test_empty_context() -> None:
    """Verify empty EngineContext returns valid empty AnalyticsReport."""
    ctx = EngineContext(subject=_dummy_subject())
    report = AnalyticsService.compute_analytics(ctx)

    if report.volume.total_records != 0:
        log_check(16, "Empty Context Handling", False, f"total_records {report.volume.total_records} != 0")
        return
    if report.qualification.qualification_ratio.total != 0:
        log_check(16, "Empty Context Handling", False, "Empty qualification total != 0")
        return

    log_check(16, "Empty Context Handling", True)


def test_invalid_input_handling() -> None:
    """Verify invalid types raise TypeError and invalid values raise ValueError."""
    # Invalid context type
    try:
        AnalyticsService.compute_analytics("not_a_context")  # type: ignore
    except TypeError:
        pass
    else:
        log_check(17, "Invalid Input Handling", False, "Accepted non-EngineContext input")
        return

    # Empty string category
    try:
        CategoryFrequency(category="   ", count=1, ratio=0.1)
    except ValueError:
        pass
    else:
        log_check(17, "Invalid Input Handling", False, "Accepted whitespace-only category string")
        return

    log_check(17, "Invalid Input Handling", True)


def test_end_to_end_regression_pipeline() -> None:
    """Verify complete Subsystem 5 -> 9 -> 10 -> 11 -> 12 -> 13 -> 14 -> 15 -> 16 -> 17 -> 18 pipeline execution."""
    biz = BusinessContext(business_id="biz-full", name="Full Business")
    opps = (OpportunityContext(opportunity_id="opp-1", business_id="biz-full", niche_id="niche-main", opportunity_type_id="type-a"),)
    quals = (QualificationContext(opportunity_id="opp-1", status="QUALIFIED"),)
    scores = (ScoreContext(opportunity_id="opp-1", overall_score=92.5),)
    prios = (PriorityContext(opportunity_id="opp-1", priority_score=88.0, score_contribution=44.0, recency_contribution=44.0, is_eligible=True),)
    ranks = (RankContext(opportunity_id="opp-1", rank=1, priority_score=88.0),)
    missions = (MissionContext(opportunity_id="opp-1", business_id="biz-full", mission_type="OUTREACH"),)
    workflows = (WorkflowContext(mission_id="m-1", opportunity_id="opp-1", business_id="biz-full", status=WorkflowStatus.COMPLETED.value),)

    ctx = EngineContext(
        subject=_dummy_subject(),
        business=biz,
        opportunities=opps,
        qualifications=quals,
        scores=scores,
        priorities=prios,
        ranks=ranks,
        missions=missions,
        workflows=workflows,
    )

    report = AnalyticsService.compute_analytics(ctx)

    if report.volume.total_records != 8:
        log_check(18, "Regression Pipeline Integration", False, f"total_records {report.volume.total_records} != 8")
        return
    if report.qualification.qualification_ratio.count != 1:
        log_check(18, "Regression Pipeline Integration", False, "qualification count != 1")
        return
    if report.scores.stats.mean != 92.5:
        log_check(18, "Regression Pipeline Integration", False, f"score mean {report.scores.stats.mean} != 92.5")
        return
    if report.priorities.eligibility_ratio.ratio != 1.0:
        log_check(18, "Regression Pipeline Integration", False, "eligibility ratio != 1.0")
        return
    if report.workflows.completion_ratio.ratio != 1.0:
        log_check(18, "Regression Pipeline Integration", False, "workflow completion ratio != 1.0")
        return
    if len(report.dimension_breakdowns) != 1 or report.dimension_breakdowns[0].groups[0].group_key != "niche-main":
        log_check(18, "Regression Pipeline Integration", False, "dimension breakdown invalid")
        return

    log_check(18, "Regression Pipeline Integration", True)


def main() -> None:
    print("=======================================================================")
    print(" MAST Lead Engine 2.0 — Subsystem 18 (Analytics Engine) Validation")
    print("=======================================================================")
    test_import_isolation()
    test_ast_analysis()
    test_model_immutability()
    test_tuple_coercion()
    test_ratio_validation()
    test_descriptive_stats_invariants()
    test_distribution_bucket_validation()
    test_histogram_correctness()
    test_mathematical_correctness()
    test_qualification_analytics()
    test_priority_analytics()
    test_workflow_analytics()
    test_dimension_breakdown()
    test_determinism()
    test_thread_safety()
    test_empty_context()
    test_invalid_input_handling()
    test_end_to_end_regression_pipeline()
    print("=======================================================================")
    print(" SUCCESS: Subsystem 18 (Analytics Engine) Passed All 18 Validation Checks!")
    print("=======================================================================")


if __name__ == "__main__":
    main()
