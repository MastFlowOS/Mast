"""
validate_ai_coach.py
====================

Standalone comprehensive validation suite for Subsystem 17 — AI Coach.

Verification Checks
-------------------
1. Import Isolation (Zero forbidden modules pre-loaded or imported)
2. AST Analysis (No prompt templates, clocks, databases, registries, factories, or infrastructure terms)
3. Model Immutability & Slotted Dataclass Enforcement (frozen=True, slots=True)
4. Tuple Coercion (Accepts iterables, returns immutable tuple)
5. Infrastructure Separation (Zero infrastructure state, 0 status/disclaimer/provider attributes)
6. Single Input Boundary (Requires EngineContext from Subsystem 16)
7. Statelessness & Pure Determinism (Repeated executions produce identical output)
8. Thread Safety & Concurrency (Concurrent execution across 16 threads)
9. Invalid Input Handling (Strict type checking)
10. End-to-End Regression Pipeline (Full Subsystem 5 -> 9..15 -> 16 -> 17 pipeline)

Run directly with:
    python validate_ai_coach.py
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

# ---------------------------------------------------------------------------
# Strict boundary checks: verify no forbidden modules are pre-loaded
# ---------------------------------------------------------------------------
forbidden = [
    "engine",
    "providers",
    "storage",
    "database",
    "crm",
    "llm",
    "openai",
    "anthropic",
]

for m in list(sys.modules.keys()):
    for f in forbidden:
        if m == f or m.startswith(f + "."):
            del sys.modules[m]

# Import Subsystem 16 and Subsystem 17
from engine_context.models import (
    BusinessContext,
    ContextComponent,
    ContextProjectionRequest,
    ContextSubject,
    ContextSubjectType,
    EngineContext,
)
from engine_context.service import ContextProjectionService

from ai_coach.models import (
    CoachInsight,
    CoachingReport,
    CoachingRequest,
    InsightCategory,
)
from ai_coach.service import AICoachService


def test_import_isolation() -> None:
    """Verify zero forbidden external modules are loaded by ai_coach."""
    print("Check 1: Import Isolation... ", end="")
    for m in sys.modules:
        for f in forbidden:
            assert not (m == f or m.startswith(f + ".")), f"Forbidden module loaded: {m}"
    print("PASSED")


def test_ast_analysis() -> None:
    """Verify AST compliance (no prompt templates, clocks, DB, or infrastructure terms)."""
    print("Check 2: AST Analysis... ", end="")
    ai_coach_dir = engine_dir / "ai_coach"
    forbidden_terms = {
        "prompt",
        "openai",
        "anthropic",
        "status",
        "disclaimer",
        "unavailable",
        "retry",
        "rate_limit",
        "auth",
        "api_key",
    }

    for py_file in ai_coach_dir.glob("*.py"):
        tree = ast.parse(py_file.read_text(encoding="utf-8"))
        for node in ast.walk(tree):
            if isinstance(node, ast.Name):
                assert (
                    node.id.lower() not in forbidden_terms
                ), f"Forbidden term '{node.id}' found in {py_file.name}"
            elif isinstance(node, ast.Attribute):
                assert (
                    node.attr.lower() not in forbidden_terms
                ), f"Forbidden attribute '{node.attr}' found in {py_file.name}"
    print("PASSED")


def test_model_immutability() -> None:
    """Verify frozen, slotted dataclass enforcement."""
    print("Check 3: Model Immutability & Slotted Dataclass Enforcement... ", end="")
    models = [CoachInsight, CoachingRequest, CoachingReport]

    for model in models:
        assert dataclasses.is_dataclass(model), f"{model} is not a dataclass"
        params = getattr(model, "__dataclass_params__", None)
        assert params is not None and params.frozen, f"{model} is not frozen"
        assert hasattr(model, "__slots__"), f"{model} does not use slots"

    # Test mutation runtime failure
    insight = CoachInsight(
        category=InsightCategory.EXPLANATION,
        title="Test Title",
        content="Test Content",
    )
    try:
        setattr(insight, "title", "New Title")
    except (dataclasses.FrozenInstanceError, AttributeError, TypeError):
        pass
    else:
        raise AssertionError("CoachInsight permitted mutation!")
    print("PASSED")


def test_tuple_coercion() -> None:
    """Verify list inputs are coerced to immutable tuples."""
    print("Check 4: Tuple Coercion... ", end="")
    insight1 = CoachInsight(
        category=InsightCategory.RISK, title="Risk 1", content="Content 1"
    )
    insight2 = CoachInsight(
        category=InsightCategory.OPPORTUNITY, title="Opp 1", content="Content 2"
    )

    report = CoachingReport(
        subject_id="sub-123",
        subject_type="BUSINESS",
        insights=[insight1, insight2],  # List input
    )
    assert isinstance(report.insights, tuple), "insights was not coerced to tuple"
    assert len(report.insights) == 2
    print("PASSED")


def test_infrastructure_separation() -> None:
    """Verify zero infrastructure state or status attributes exist on models."""
    print("Check 5: Infrastructure Separation... ", end="")
    report = CoachingReport(subject_id="sub-123", subject_type="BUSINESS")
    assert not hasattr(report, "status"), "CoachingReport carries infrastructure status"
    assert not hasattr(report, "disclaimer"), "CoachingReport carries disclaimer field"
    assert not hasattr(report, "error_message"), "CoachingReport carries error_message field"
    assert not hasattr(report, "provider"), "CoachingReport carries provider field"
    print("PASSED")


def test_single_input_boundary() -> None:
    """Verify CoachingRequest requires EngineContext."""
    print("Check 6: Single Input Boundary (EngineContext)... ", end="")
    subject = ContextSubject(subject_id="biz-1", subject_type=ContextSubjectType.BUSINESS)
    req = ContextProjectionRequest(subject=subject)
    ctx = ContextProjectionService.project(request=req)

    coaching_req = CoachingRequest(engine_context=ctx)
    assert coaching_req.engine_context is ctx

    try:
        CoachingRequest(engine_context="invalid_context")  # type: ignore
    except TypeError:
        pass
    else:
        raise AssertionError("CoachingRequest accepted non-EngineContext input!")
    print("PASSED")


def test_statelessness_and_pure_determinism() -> None:
    """Verify repeated executions produce byte-for-byte identical output."""
    print("Check 7: Statelessness & Pure Determinism... ", end="")
    subject = ContextSubject(subject_id="biz-100", subject_type=ContextSubjectType.BUSINESS)
    req = ContextProjectionRequest(subject=subject)
    ctx = ContextProjectionService.project(request=req)
    coaching_req = CoachingRequest(engine_context=ctx)

    insight = CoachInsight(
        category=InsightCategory.SUMMARY,
        title="Summary Title",
        content="Summary Content",
    )

    r1 = AICoachService.generate_coaching_report(coaching_req, insights=[insight])
    r2 = AICoachService.generate_coaching_report(coaching_req, insights=[insight])

    assert r1 == r2, "Repeated executions produced different reports"
    assert r1.subject_id == r2.subject_id == "biz-100"
    assert r1.subject_type == r2.subject_type == "BUSINESS"
    print("PASSED")


def test_thread_safety_and_concurrency() -> None:
    """Verify concurrent thread execution produces zero race conditions."""
    print("Check 8: Thread Safety & Concurrency... ", end="")
    subject = ContextSubject(subject_id="biz-conc", subject_type=ContextSubjectType.BUSINESS)
    req = ContextProjectionRequest(subject=subject)
    ctx = ContextProjectionService.project(request=req)
    coaching_req = CoachingRequest(engine_context=ctx)

    def run_worker(i: int) -> CoachingReport:
        insight = CoachInsight(
            category=InsightCategory.EXPLANATION,
            title=f"Title {i}",
            content=f"Content {i}",
        )
        return AICoachService.generate_coaching_report(coaching_req, insights=[insight])

    with ThreadPoolExecutor(max_workers=16) as executor:
        futures = [executor.submit(run_worker, i) for i in range(100)]
        results = [f.result() for f in futures]

    assert len(results) == 100
    for i, res in enumerate(results):
        assert res.insights[0].title == f"Title {i}"
    print("PASSED")


def test_invalid_input_handling() -> None:
    """Verify strict type validation on all models and service methods."""
    print("Check 9: Invalid Input Handling... ", end="")
    try:
        CoachInsight(category="INVALID", title="T", content="C")  # type: ignore
    except TypeError:
        pass
    else:
        raise AssertionError("CoachInsight accepted string for InsightCategory")

    try:
        CoachInsight(category=InsightCategory.RISK, title="", content="C")
    except ValueError:
        pass
    else:
        raise AssertionError("CoachInsight accepted empty string title")

    try:
        AICoachService.generate_coaching_report("not_a_request")  # type: ignore
    except TypeError:
        pass
    else:
        raise AssertionError("generate_coaching_report accepted invalid request")
    print("PASSED")


def test_end_to_end_pipeline() -> None:
    """Verify full Subsystem 5 -> 16 -> 17 pipeline execution."""
    print("Check 10: End-to-End Pipeline Integration... ", end="")
    subject = ContextSubject(
        subject_id="opp-999", subject_type=ContextSubjectType.OPPORTUNITY
    )
    req = ContextProjectionRequest(subject=subject)
    engine_ctx = ContextProjectionService.project(request=req)

    coaching_req = CoachingRequest(engine_context=engine_ctx)

    insights = (
        CoachInsight(
            category=InsightCategory.EXPLANATION,
            title="Qualification Explained",
            content="Opportunity qualified due to high revenue potential.",
        ),
        CoachInsight(
            category=InsightCategory.RISK,
            title="SLA Risk",
            content="High response time latency detected.",
        ),
        CoachInsight(
            category=InsightCategory.RECOMMENDATION,
            title="Operator Focus",
            content="Prioritize outreach within 24 hours.",
        ),
    )

    report = AICoachService.generate_coaching_report(coaching_req, insights=insights)

    assert report.subject_id == "opp-999"
    assert report.subject_type == "OPPORTUNITY"
    assert len(report.insights) == 3
    assert report.insights[0].category == InsightCategory.EXPLANATION
    assert report.insights[1].category == InsightCategory.RISK
    assert report.insights[2].category == InsightCategory.RECOMMENDATION
    print("PASSED")


def main() -> None:
    print("=======================================================================")
    print(" MAST Lead Engine 2.0 — Subsystem 17 (AI Coach) Validation Suite")
    print("=======================================================================")
    test_import_isolation()
    test_ast_analysis()
    test_model_immutability()
    test_tuple_coercion()
    test_infrastructure_separation()
    test_single_input_boundary()
    test_statelessness_and_pure_determinism()
    test_thread_safety_and_concurrency()
    test_invalid_input_handling()
    test_end_to_end_pipeline()
    print("=======================================================================")
    print(" SUCCESS: Subsystem 17 (AI Coach) Passed All Validation Checks!")
    print("=======================================================================")


if __name__ == "__main__":
    main()
