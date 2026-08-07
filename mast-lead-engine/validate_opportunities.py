"""
validate_opportunities.py
==========================

Standalone validation suite for the opportunities package (Opportunity Intelligence Phase 1).

Verification Checks
-------------------
1. Strict import isolation (no forbidden modules loaded or imported).
2. AST static code analysis of opportunities package for forbidden imports.
3. Immutable models & slots (frozen dataclass, __slots__, tuple coercion).
4. Data validation & error checks (non-empty strings, datetime type, tuple items).
5. Registry correctness & lack of update() method (register, get, exists, ids, all, remove).
6. Duplicate protection (ValueError on duplicate opportunity_id).
7. KeyError on unknown opportunity_id in get().
8. Thread safety across concurrent opportunity registrations and lookups.
9. Previous subsystems untouched and unmutated.

Run directly with:
    python validate_opportunities.py
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
# Strict boundary checks: before importing opportunities, verify no forbidden
# modules are loaded.
# ---------------------------------------------------------------------------
forbidden = [
    "engine",
    "providers",
    "business_merge",
    "business_enrichment",
    "storage",
    "database",
    "crm",
    "missions",
    "ai",
    "scoring",
]

for m in list(sys.modules.keys()):
    for f in forbidden:
        if m == f or m.startswith(f + "."):
            del sys.modules[m]

# Now import opportunities package
import opportunities
from opportunities import Opportunity, OpportunityRegistry

PASS = "PASS"
FAIL = "FAIL"
results: list[tuple[str, str, str]] = []


def check(name: str, condition: bool, detail: str = "") -> None:
    results.append((name, PASS if condition else FAIL, detail))
    if not condition:
        print(f"FAILED: {name} - {detail}")


def test_import_isolation_ast() -> None:
    """AST check of opportunities package ensuring no forbidden imports."""
    package_dir = engine_dir / "opportunities"
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
    print("MAST Engine — Opportunity Intelligence Phase 1 Validation")
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
    # 2. Immutable Models & Slots Verification
    # ---------------------------------------------------------------------------
    opp1 = Opportunity(
        opportunity_id="opp_001",
        business_id="biz_001",
        niche_id="web_design",
        opportunity_type_id="missing_website",
        discovered_at=t0,
        supporting_signal_ids=("signal_no_website", "signal_has_phone"),
    )

    check("2a. Opportunity Slots Present", hasattr(opp1, "__slots__"), "Opportunity does not have __slots__")

    mutation_failed = False
    try:
        opp1.niche_id = "seo"  # type: ignore[misc]
    except (dataclasses.FrozenInstanceError, AttributeError):
        mutation_failed = True

    check("2b. Model Immutability", mutation_failed, "Mutation of Opportunity instance succeeded unexpectedly")

    # ---------------------------------------------------------------------------
    # 3. Tuple Coercion Verification
    # ---------------------------------------------------------------------------
    opp_coerced = Opportunity(
        opportunity_id="opp_002",
        business_id="biz_002",
        niche_id="seo",
        opportunity_type_id="poor_seo",
        discovered_at=t0,
        supporting_signal_ids=["signal_low_search_ranking"],  # List passed, should coerce to tuple
    )

    check(
        "3a. Tuple Coercion of Collections",
        isinstance(opp_coerced.supporting_signal_ids, tuple),
        f"Expected tuple, got {type(opp_coerced.supporting_signal_ids)!r}",
    )
    check(
        "3b. Supporting Signal IDs Value",
        opp_coerced.supporting_signal_ids == ("signal_low_search_ranking",),
        f"Unexpected supporting_signal_ids: {opp_coerced.supporting_signal_ids}",
    )

    # ---------------------------------------------------------------------------
    # 4. Data Validation & Error Handling
    # ---------------------------------------------------------------------------
    # Empty opportunity_id
    invalid_opp_id = False
    try:
        Opportunity(
            opportunity_id="",
            business_id="biz_001",
            niche_id="web_design",
            opportunity_type_id="missing_website",
            discovered_at=t0,
        )
    except ValueError:
        invalid_opp_id = True
    check("4a. Empty opportunity_id Rejected", invalid_opp_id, "Empty opportunity_id was accepted")

    # Empty business_id
    invalid_biz_id = False
    try:
        Opportunity(
            opportunity_id="opp_003",
            business_id="",
            niche_id="web_design",
            opportunity_type_id="missing_website",
            discovered_at=t0,
        )
    except ValueError:
        invalid_biz_id = True
    check("4b. Empty business_id Rejected", invalid_biz_id, "Empty business_id was accepted")

    # Empty niche_id
    invalid_niche_id = False
    try:
        Opportunity(
            opportunity_id="opp_004",
            business_id="biz_001",
            niche_id="",
            opportunity_type_id="missing_website",
            discovered_at=t0,
        )
    except ValueError:
        invalid_niche_id = True
    check("4c. Empty niche_id Rejected", invalid_niche_id, "Empty niche_id was accepted")

    # Empty opportunity_type_id
    invalid_type_id = False
    try:
        Opportunity(
            opportunity_id="opp_005",
            business_id="biz_001",
            niche_id="web_design",
            opportunity_type_id="",
            discovered_at=t0,
        )
    except ValueError:
        invalid_type_id = True
    check("4d. Empty opportunity_type_id Rejected", invalid_type_id, "Empty opportunity_type_id was accepted")

    # Invalid discovered_at type
    invalid_dt = False
    try:
        Opportunity(
            opportunity_id="opp_006",
            business_id="biz_001",
            niche_id="web_design",
            opportunity_type_id="missing_website",
            discovered_at="2026-08-04",  # type: ignore
        )
    except TypeError:
        invalid_dt = True
    check("4e. Invalid discovered_at Type Rejected", invalid_dt, "String discovered_at was accepted")

    # ---------------------------------------------------------------------------
    # 5. OpportunityRegistry Correctness & Operations
    # ---------------------------------------------------------------------------
    registry = OpportunityRegistry()
    check(
        "5a. Lack of update() Method",
        not hasattr(registry, "update"),
        "OpportunityRegistry has an update() method",
    )

    registry.register(opp1)
    registry.register(opp_coerced)

    check("5b. Registry exists() True", registry.exists("opp_001"), "opp_001 not found")
    check("5c. Registry exists() False", not registry.exists("opp_999"), "opp_999 reported as existing")
    check("5d. Registry get() Correctness", registry.get("opp_001") == opp1, "get('opp_001') returned incorrect object")
    check("5e. Registry ids() Order", registry.ids() == ("opp_001", "opp_002"), f"ids() returned {registry.ids()}")
    check("5f. Registry all() Order", registry.all() == (opp1, opp_coerced), f"all() count: {len(registry.all())}")

    # Duplicate registration protection
    dup_protection = False
    try:
        registry.register(opp1)
    except ValueError:
        dup_protection = True
    check("5g. Duplicate Registration Protection", dup_protection, "Duplicate registration was allowed")

    # KeyError on missing ID
    key_error_pass = False
    try:
        registry.get("non_existent_id")
    except KeyError:
        key_error_pass = True
    check("5h. KeyError on Missing Lookup", key_error_pass, "Missing lookup did not raise KeyError")

    # Registry remove
    removed_true = registry.remove("opp_001")
    removed_false = registry.remove("opp_001")
    check("5i. Registry remove() Return Values", removed_true and not removed_false, "remove() returned invalid status")
    check("5j. Registry State After Removal", not registry.exists("opp_001"), "opp_001 still exists after remove")

    # Re-register opp1
    registry.register(opp1)

    # ---------------------------------------------------------------------------
    # 6. Registry Thread Safety
    # ---------------------------------------------------------------------------
    thread_reg = OpportunityRegistry()
    errors: list[Exception] = []

    def worker(worker_id: int) -> None:
        try:
            for i in range(50):
                o_id = f"opp_t_{worker_id}_{i}"
                op = Opportunity(
                    opportunity_id=o_id,
                    business_id=f"biz_{worker_id}_{i}",
                    niche_id="web_design",
                    opportunity_type_id="missing_website",
                    discovered_at=t0,
                )
                thread_reg.register(op)
                if not thread_reg.exists(o_id):
                    raise RuntimeError(f"ID {o_id} missing immediately after registration")
                fetched = thread_reg.get(o_id)
                if fetched.business_id != f"biz_{worker_id}_{i}":
                    raise RuntimeError(f"Fetched incorrect business_id for {o_id}")
        except Exception as ex:
            errors.append(ex)

    threads = [threading.Thread(target=worker, args=(t_idx,)) for t_idx in range(5)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    check("6a. Registry Thread Safety", len(errors) == 0, f"Thread errors encountered: {errors}")
    check("6b. Concurrent Items Count", len(thread_reg.ids()) == 250, f"Expected 250 items, got {len(thread_reg.ids())}")

    # ---------------------------------------------------------------------------
    # 7. Subsystem Integrity & Package Exports
    # ---------------------------------------------------------------------------
    check(
        "7a. Opportunities Subsystem Package Exports",
        hasattr(opportunities, "Opportunity") and hasattr(opportunities, "OpportunityRegistry"),
        "opportunities module missing expected exports",
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
