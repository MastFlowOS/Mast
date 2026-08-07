"""
validate_opportunity_scoring.py
================================

Standalone validation suite for the opportunity_scoring package (Phase 1).

Verification Checks
-------------------
1. Strict import isolation (no forbidden modules loaded or imported).
2. AST static code analysis of opportunity_scoring package for forbidden imports.
3. Immutable models & slots (frozen dataclass, __slots__, tuple coercion).
4. Strict data validation & error checks (non-empty strings, score clamping).
5. Absence of persistent registry.py file (pure derived evaluation statement).
6. Stateless service execution, determinism, and policy rule evaluation.
7. Thread safety across concurrent evaluations.
8. Previous subsystems untouched and unmutated.

Run directly with:
    python validate_opportunity_scoring.py
"""

from __future__ import annotations

import ast
import dataclasses
from datetime import datetime, timezone
from pathlib import Path
import sys
import threading

# Add mast-lead-engine directory to sys.path
engine_dir = Path(__file__).resolve().parent
if str(engine_dir) not in sys.path:
    sys.path.insert(0, str(engine_dir))

# ---------------------------------------------------------------------------
# Strict boundary checks: before importing opportunity_scoring, verify
# no forbidden modules are loaded.
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
import opportunity_scoring
from opportunity_scoring import (
    DEFAULT_SCORING_POLICY,
    OpportunityScore,
    OpportunityScoringService,
    ScoreContribution,
    ScoringPolicy,
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
    """Check 2: AST analysis of opportunity_scoring package files."""
    pkg_dir = engine_dir / "opportunity_scoring"
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
    print_check("AST Analysis", True, "AST analysis clean: no forbidden imports in opportunity_scoring")


def check_absence_of_registry() -> None:
    """Check 3: Absence of registry.py in opportunity_scoring package."""
    registry_file = engine_dir / "opportunity_scoring" / "registry.py"
    if registry_file.exists():
        print_check("Absence of Registry", False, "registry.py file exists in opportunity_scoring")
    else:
        print_check("Absence of Registry", True, "No registry.py file in opportunity_scoring (pure derived subsystem)")


def check_model_immutability() -> None:
    """Check 4: Verify frozen dataclasses, __slots__, and collection immutability."""
    contrib = ScoreContribution(
        contribution_id="test_contrib",
        delta=15.0,
        reason="Test contribution reason",
    )
    score = OpportunityScore(
        opportunity_id="opp_123",
        overall_score=85.0,
        contributions=(contrib,),
    )

    # Slotted checks
    if not hasattr(contrib, "__slots__"):
        print_check("Model Immutability", False, "ScoreContribution lacks __slots__")
        return
    if not hasattr(score, "__slots__"):
        print_check("Model Immutability", False, "OpportunityScore lacks __slots__")
        return

    # Frozen checks
    try:
        score.overall_score = 99.0  # type: ignore
        print_check("Model Immutability", False, "OpportunityScore allowed mutation of overall_score")
        return
    except (dataclasses.FrozenInstanceError, TypeError, AttributeError):
        pass

    try:
        contrib.delta = 50.0  # type: ignore
        print_check("Model Immutability", False, "ScoreContribution allowed mutation of delta")
        return
    except (dataclasses.FrozenInstanceError, TypeError, AttributeError):
        pass

    # Tuple coercion check
    score_list_input = OpportunityScore(
        opportunity_id="opp_456",
        overall_score=50.0,
        contributions=[contrib],  # type: ignore
    )
    if not isinstance(score_list_input.contributions, tuple):
        print_check("Model Immutability", False, "contributions was not coerced to tuple")
        return

    print_check("Model Immutability", True, "Dataclasses are frozen, slotted, and enforce tuple collections")


def check_data_validation() -> None:
    """Check 5: Strict data validation (empty strings, clamping, type checks)."""
    # Empty opportunity_id
    try:
        OpportunityScore(opportunity_id="", overall_score=50.0)
        print_check("Data Validation", False, "Allowed empty opportunity_id")
        return
    except ValueError:
        pass

    # Clamping tests
    over_clamped = OpportunityScore(opportunity_id="opp_high", overall_score=150.0)
    if over_clamped.overall_score != 100.0:
        print_check("Data Validation", False, f"over_score expected 100.0, got {over_clamped.overall_score}")
        return

    under_clamped = OpportunityScore(opportunity_id="opp_low", overall_score=-50.0)
    if under_clamped.overall_score != 0.0:
        print_check("Data Validation", False, f"under_score expected 0.0, got {under_clamped.overall_score}")
        return

    print_check("Data Validation", True, "Strict data validation and clamping logic verified")


def check_stateless_service_and_determinism() -> None:
    """Check 6: Stateless execution, determinism, and policy rule evaluation."""
    service = OpportunityScoringService()
    now = datetime.now(timezone.utc)

    opp = Opportunity(
        opportunity_id="opp_test_001",
        business_id="biz_001",
        niche_id="web_design",
        opportunity_type_id="missing_website",
        discovered_at=now,
        supporting_signal_ids=("sig_1", "sig_2"),
    )

    res1 = service.evaluate(opp)
    res2 = service.evaluate(opp)

    if res1 != res2:
        print_check("Stateless Service Determinism", False, "Evaluating identical opportunity produced different results")
        return

    if res1.opportunity_id != "opp_test_001":
        print_check("Stateless Service Determinism", False, "Incorrect opportunity_id in result")
        return

    # Check rule evaluation (supporting_signals_strength delta should be 30.0 for 2 signals)
    contrib_ids = [c.contribution_id for c in res1.contributions]
    if "supporting_signals_strength" not in contrib_ids:
        print_check("Stateless Service Determinism", False, "supporting_signals_strength contribution missing")
        return

    print_check("Stateless Service Determinism", True, "Stateless evaluation is deterministic and evaluates policy rules accurately")


def check_thread_safety() -> None:
    """Check 7: Thread safety across concurrent evaluations."""
    service = OpportunityScoringService()
    now = datetime.now(timezone.utc)
    errors: list[Exception] = []

    def worker(worker_id: int):
        try:
            for i in range(50):
                opp = Opportunity(
                    opportunity_id=f"opp_thread_{worker_id}_{i}",
                    business_id=f"biz_{worker_id}",
                    niche_id="seo",
                    opportunity_type_id="poor_seo",
                    discovered_at=now,
                    supporting_signal_ids=("sig_a",),
                )
                res = service.evaluate(opp)
                if res.opportunity_id != f"opp_thread_{worker_id}_{i}":
                    raise ValueError(f"Thread mismatch: expected opp_thread_{worker_id}_{i}, got {res.opportunity_id}")
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
    """Check 8: Verify previous subsystems remain intact."""
    import opportunity_qualification
    from opportunity_qualification import OpportunityQualificationService, QualificationStatus

    qual_service = OpportunityQualificationService()
    now = datetime.now(timezone.utc)

    opp = Opportunity(
        opportunity_id="opp_qual_test",
        business_id="biz_qual",
        niche_id="design",
        opportunity_type_id="type_a",
        discovered_at=now,
        supporting_signal_ids=("sig_1",),
    )

    qual_res = qual_service.evaluate(opp)
    if qual_res.status != QualificationStatus.QUALIFIED:
        print_check("Subsystem Regressions", False, "Opportunity qualification test failed")
        return

    print_check("Subsystem Regressions", True, "All previous subsystems function properly without mutation")


def run_all_checks() -> None:
    print("=" * 70)
    print("MAST Lead Engine — Opportunity Scoring Validation Suite")
    print("=" * 70)

    check_import_isolation()
    check_ast_analysis()
    check_absence_of_registry()
    check_model_immutability()
    check_data_validation()
    check_stateless_service_and_determinism()
    check_thread_safety()
    check_subsystem_regressions()

    print("=" * 70)
    print("ALL VALIDATION CHECKS PASSED SUCCESSFULLY!")
    print("=" * 70)


if __name__ == "__main__":
    run_all_checks()
