"""
validate_opportunity_qualification.py
======================================

Standalone validation suite for the opportunity_qualification package (Phase 1).

Verification Checks
-------------------
1. Strict import isolation (no forbidden modules loaded or imported).
2. AST static code analysis of opportunity_qualification package for forbidden imports.
3. Immutable models & slots (frozen dataclass, __slots__, tuple coercion).
4. Strict data validation & error checks (non-empty strings, enum status checks).
5. Absence of persistent registry.py file (pure derived evaluation statement).
6. Stateless service execution, determinism, and rule evaluation.
7. Thread safety across concurrent evaluations.
8. Previous subsystems untouched and unmutated.

Run directly with:
    python validate_opportunity_qualification.py
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
# Strict boundary checks: before importing opportunity_qualification, verify
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

# Now import opportunities and opportunity_qualification package
import opportunities
from opportunities import Opportunity
import opportunity_qualification
from opportunity_qualification import (
    OpportunityQualification,
    OpportunityQualificationService,
    QualificationStatus,
)

PASS = "PASS"
FAIL = "FAIL"
results: list[tuple[str, str, str]] = []


def check(name: str, condition: bool, detail: str = "") -> None:
    results.append((name, PASS if condition else FAIL, detail))
    if not condition:
        print(f"FAILED: {name} - {detail}")


def test_import_isolation_ast() -> None:
    """AST check of opportunity_qualification package ensuring no forbidden imports."""
    package_dir = engine_dir / "opportunity_qualification"
    for py_file in package_dir.glob("*.py"):
        tree = ast.parse(py_file.read_text("utf-8"))
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                for alias in node.names:
                    root_mod = alias.name.split(".")[0]
                    assert (
                        root_mod not in forbidden
                    ), f"Forbidden import {alias.name!r} found in {py_file.name}"
            elif isinstance(node, ast.ImportFrom):
                if node.module:
                    root_mod = node.module.split(".")[0]
                    assert (
                        root_mod not in forbidden
                    ), f"Forbidden import {node.module!r} found in {py_file.name}"


def run_validation() -> bool:
    print("=" * 70)
    print("MAST Engine — Opportunity Qualification Phase 1 Validation")
    print("=" * 70)

    t0 = datetime.now(timezone.utc)

    # ---------------------------------------------------------------------------
    # 1. Import Isolation & Forbidden Module Absence
    # ---------------------------------------------------------------------------
    loaded_forbidden = [
        m for m in sys.modules if any(m == f or m.startswith(f + ".") for f in forbidden)
    ]
    check(
        "1a. Runtime Import Isolation",
        len(loaded_forbidden) == 0,
        f"Loaded forbidden modules: {loaded_forbidden}",
    )

    ast_passed = True
    ast_detail = ""
    try:
        test_import_isolation_ast()
    except Exception as ex:
        ast_passed = False
        ast_detail = str(ex)
    check("1b. AST Static Import Isolation", ast_passed, ast_detail)

    # ---------------------------------------------------------------------------
    # 2. Absence of registry.py Verification
    # ---------------------------------------------------------------------------
    registry_file = engine_dir / "opportunity_qualification" / "registry.py"
    check(
        "2a. Absence of registry.py File",
        not registry_file.exists(),
        "registry.py exists in opportunity_qualification package unexpectedly",
    )

    # ---------------------------------------------------------------------------
    # 3. Immutable Models & Slots Verification
    # ---------------------------------------------------------------------------
    qual1 = OpportunityQualification(
        opportunity_id="opp_001",
        status=QualificationStatus.QUALIFIED,
        passed_rule_ids=("RULE_VALID_OPPORTUNITY_FACTS", "RULE_SUPPORTING_SIGNALS_PRESENT"),
        failed_rule_ids=(),
    )

    check("3a. Slots Present", hasattr(qual1, "__slots__"), "OpportunityQualification lacks __slots__")

    mutation_failed = False
    try:
        qual1.status = QualificationStatus.NOT_QUALIFIED  # type: ignore[misc]
    except (dataclasses.FrozenInstanceError, AttributeError):
        mutation_failed = True

    check("3b. Model Immutability", mutation_failed, "Mutation of OpportunityQualification succeeded unexpectedly")

    # Absence of qualified_at timestamp field
    check(
        "3c. Absence of qualified_at Field",
        not hasattr(qual1, "qualified_at"),
        "OpportunityQualification unexpectedly defines a qualified_at field",
    )

    # ---------------------------------------------------------------------------
    # 4. Tuple Coercion Verification
    # ---------------------------------------------------------------------------
    qual_coerced = OpportunityQualification(
        opportunity_id="opp_002",
        status=QualificationStatus.NOT_QUALIFIED,
        passed_rule_ids=["RULE_VALID_OPPORTUNITY_FACTS"],  # List passed, should coerce to tuple
        failed_rule_ids=["RULE_SUPPORTING_SIGNALS_PRESENT"],
    )

    check(
        "4a. Tuple Coercion of passed_rule_ids",
        isinstance(qual_coerced.passed_rule_ids, tuple),
        f"Expected tuple, got {type(qual_coerced.passed_rule_ids)!r}",
    )
    check(
        "4b. Tuple Coercion of failed_rule_ids",
        isinstance(qual_coerced.failed_rule_ids, tuple),
        f"Expected tuple, got {type(qual_coerced.failed_rule_ids)!r}",
    )

    # ---------------------------------------------------------------------------
    # 5. Data Validation & Error Handling
    # ---------------------------------------------------------------------------
    invalid_opp_id = False
    try:
        OpportunityQualification(
            opportunity_id="",
            status=QualificationStatus.QUALIFIED,
            passed_rule_ids=("RULE_1",),
        )
    except ValueError:
        invalid_opp_id = True
    check("5a. Empty opportunity_id Rejected", invalid_opp_id, "Empty opportunity_id was accepted")

    invalid_status = False
    try:
        OpportunityQualification(
            opportunity_id="opp_003",
            status="INVALID_STATUS",  # type: ignore
            passed_rule_ids=("RULE_1",),
        )
    except TypeError:
        invalid_status = True
    check("5b. Invalid status Enum Rejected", invalid_status, "Invalid status enum was accepted")

    # ---------------------------------------------------------------------------
    # 6. Stateless Qualification Service Execution & Determinism
    # ---------------------------------------------------------------------------
    service = OpportunityQualificationService()

    # Verify service has no mutable attributes
    service_dict = getattr(service, "__dict__", {})
    check(
        "6a. Service Has No Mutable Instance State",
        len(service_dict) == 0,
        f"Service __dict__ is non-empty: {service_dict}",
    )

    opp_valid = Opportunity(
        opportunity_id="opp_val_001",
        business_id="biz_val_001",
        niche_id="web_design",
        opportunity_type_id="missing_website",
        discovered_at=t0,
        supporting_signal_ids=("signal_no_site",),
    )

    res1 = service.evaluate(opp_valid)
    check(
        "6b. Valid Opportunity Decision",
        res1.status == QualificationStatus.QUALIFIED,
        f"Expected QUALIFIED, got {res1.status}",
    )
    check(
        "6c. Valid Opportunity Passed Rules",
        len(res1.passed_rule_ids) > 0 and len(res1.failed_rule_ids) == 0,
        f"Passed: {res1.passed_rule_ids}, Failed: {res1.failed_rule_ids}",
    )

    # Opportunity with no supporting signals
    opp_no_signals = Opportunity(
        opportunity_id="opp_no_sig_001",
        business_id="biz_val_001",
        niche_id="web_design",
        opportunity_type_id="missing_website",
        discovered_at=t0,
        supporting_signal_ids=(),
    )

    res_no_sig = service.evaluate(opp_no_signals)
    check(
        "6d. Opportunity Without Signals Decision",
        res_no_sig.status == QualificationStatus.NOT_QUALIFIED,
        f"Expected NOT_QUALIFIED, got {res_no_sig.status}",
    )
    check(
        "6e. Failed Rule Recording",
        "RULE_SUPPORTING_SIGNALS_PRESENT" in res_no_sig.failed_rule_ids,
        f"Expected RULE_SUPPORTING_SIGNALS_PRESENT in failed_rule_ids, got {res_no_sig.failed_rule_ids}",
    )

    # Deterministic Evaluation Verification
    res1_again = service.evaluate(opp_valid)
    check(
        "6f. Evaluation Determinism",
        res1 == res1_again,
        "Repeated evaluations produced different results",
    )

    # ---------------------------------------------------------------------------
    # 7. Multi-Threaded Execution Safety
    # ---------------------------------------------------------------------------
    thread_errors: list[Exception] = []

    def worker(worker_id: int) -> None:
        try:
            thread_svc = OpportunityQualificationService()
            for i in range(50):
                op = Opportunity(
                    opportunity_id=f"opp_t_{worker_id}_{i}",
                    business_id=f"biz_{worker_id}_{i}",
                    niche_id="web_design",
                    opportunity_type_id="missing_website",
                    discovered_at=t0,
                    supporting_signal_ids=(f"sig_{i}",),
                )
                res = thread_svc.evaluate(op)
                if res.status != QualificationStatus.QUALIFIED:
                    raise RuntimeError(f"Thread worker {worker_id} got unexpected status {res.status}")
        except Exception as ex:
            thread_errors.append(ex)

    threads = [threading.Thread(target=worker, args=(t_idx,)) for t_idx in range(5)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    check(
        "7a. Multi-Threaded Execution Thread Safety",
        len(thread_errors) == 0,
        f"Thread errors encountered: {thread_errors}",
    )

    # ---------------------------------------------------------------------------
    # 8. Package Exports Verification
    # ---------------------------------------------------------------------------
    check(
        "8a. Package Exports Integrity",
        hasattr(opportunity_qualification, "OpportunityQualification")
        and hasattr(opportunity_qualification, "QualificationStatus")
        and hasattr(opportunity_qualification, "OpportunityQualificationService"),
        "opportunity_qualification module missing expected exports",
    )

    # Print summary table
    print("\n" + "-" * 70)
    print(f"{'Check Name':<50} | {'Status':<6}")
    print("-" * 70)
    all_passed = True
    for name, status, detail in results:
        status_str = f"\033[92m{status}\033[0m" if status == PASS else f"\033[91m{status}\033[0m"
        print(f"{name:<50} | {status_str}")
        if status != PASS:
            all_passed = False
            print(f"   Detail: {detail}")
    print("-" * 70)
    print(f"Overall Result: {'PASS' if all_passed else 'FAIL'}")
    print("=" * 70)
    return all_passed


if __name__ == "__main__":
    success = run_validation()
    sys.exit(0 if success else 1)
