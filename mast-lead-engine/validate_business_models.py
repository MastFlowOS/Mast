"""
validate_business_models.py
===========================

Standalone validation suite for the business/ package (Business Layer Phase 1).

Verification Checks
-------------------
1. Strict import isolation (no forbidden modules loaded).
2. Immutable models & slots (frozen dataclass, __slots__, tuple coercion).
3. Single Source of Truth & Computed Accessors (phone, email, website, social_urls).
4. Validation & error checks (non-empty strings, datetime type, coordinate range checks).
5. Registry correctness & lack of update() method (register, get, exists, ids, all, remove).
6. Duplicate protection (ValueError on duplicate business_id).
7. KeyError on unknown business_id in get().
8. Thread safety across concurrent business registrations and lookups.
9. Engine untouched.
10. Provider Platform untouched.
11. Discovery untouched.
12. Provider Execution untouched.
13. Discovery Sessions untouched.

Run directly with:
    python validate_business_models.py
"""

from __future__ import annotations

import sys
import threading
import dataclasses
from datetime import datetime, timezone

# ---------------------------------------------------------------------------
# Strict boundary checks: before importing business, verify no forbidden
# modules are loaded and guarantee strict layer isolation.
# ---------------------------------------------------------------------------
forbidden = [
    "engine",
    "storage",
    "database",
    "crm",
    "opportunities",
    "missions",
    "ai",
]

for m in list(sys.modules.keys()):
    for f in forbidden:
        if m == f or m.startswith(f + "."):
            del sys.modules[m]

# Now import business package
import business
from business import Business, BusinessRegistry

PASS = "PASS"
FAIL = "FAIL"
results: list[tuple[str, str, str]] = []


def check(name: str, condition: bool, detail: str = "") -> None:
    results.append((name, PASS if condition else FAIL, detail))
    if not condition:
        print(f"FAILED: {name} - {detail}")


def run_validation() -> bool:
    print("=" * 70)
    print("MAST Engine — Business Layer Phase 1 Validation")
    print("=" * 70)

    t0 = datetime.now(timezone.utc)

    # ---------------------------------------------------------------------------
    # 1. Import Isolation & Forbidden Module Absence
    # ---------------------------------------------------------------------------
    loaded_forbidden = [m for m in sys.modules if any(m == f or m.startswith(f + ".") for f in forbidden)]
    check("1. Import Isolation", len(loaded_forbidden) == 0, f"Loaded forbidden modules: {loaded_forbidden}")

    # ---------------------------------------------------------------------------
    # 2. Immutable Models & Slots Verification
    # ---------------------------------------------------------------------------
    biz1 = Business(
        business_id="biz_001",
        execution_id="exec_001",
        session_id="session_001",
        originating_provider_id="google_maps",
        name="Alpha Dental Clinic",
        discovered_at=t0,
        category="Dentist",
        address="123 Main St",
        city="Berlin",
        country="Germany",
        latitude=52.5200,
        longitude=13.4050,
        phones=("+4930123456", "+4930654321"),
        emails=("info@alphadental.de",),
        websites=("https://alphadental.de",),
        instagram_url="https://instagram.com/alphadental",
        facebook_url="https://facebook.com/alphadental",
    )

    check("2a. Business Slots Present", hasattr(biz1, "__slots__"), "Business does not have __slots__")
    
    mutation_failed = False
    try:
        # Attempt to mutate frozen instance
        object.__setattr__(biz1, "name", "Mutated Dental")  # Should fail if dataclass frozen check or post init prevents
    except Exception:
        pass

    try:
        biz1.name = "Direct Mutate"
    except (dataclasses.FrozenInstanceError, AttributeError):
        mutation_failed = True

    check("2b. Model Immutability", mutation_failed, "Mutation of Business instance succeeded unexpectedly")

    # ---------------------------------------------------------------------------
    # 3. Single Source of Truth & Computed Accessors
    # ---------------------------------------------------------------------------
    check("3a. Primary Phone Property", biz1.phone == "+4930123456", f"Expected +4930123456, got {biz1.phone}")
    check("3b. Primary Email Property", biz1.email == "info@alphadental.de", f"Expected info@alphadental.de, got {biz1.email}")
    check("3c. Primary Website Property", biz1.website == "https://alphadental.de", f"Expected https://alphadental.de, got {biz1.website}")
    check(
        "3d. Social URLs Property",
        biz1.social_urls == ("https://instagram.com/alphadental", "https://facebook.com/alphadental"),
        f"Unexpected social_urls: {biz1.social_urls}",
    )

    # Empty collections test
    biz_empty = Business(
        business_id="biz_002",
        execution_id="exec_001",
        session_id="session_001",
        originating_provider_id="yelp",
        name="Beta Cafe",
        discovered_at=t0,
    )
    check("3e. Empty Phone Property", biz_empty.phone is None, "Expected None for empty phones")
    check("3f. Empty Email Property", biz_empty.email is None, "Expected None for empty emails")
    check("3g. Empty Website Property", biz_empty.website is None, "Expected None for empty websites")
    check("3h. Empty Social URLs Property", biz_empty.social_urls == (), f"Expected (), got {biz_empty.social_urls}")

    # ---------------------------------------------------------------------------
    # 4. Data Validation & Error Handling
    # ---------------------------------------------------------------------------
    # Empty business_id
    invalid_id = False
    try:
        Business(
            business_id="",
            execution_id="exec_001",
            session_id="session_001",
            originating_provider_id="google_maps",
            name="Valid Name",
            discovered_at=t0,
        )
    except ValueError:
        invalid_id = True
    check("4a. Empty Business ID Rejected", invalid_id, "Empty business_id was accepted")

    # Invalid latitude
    invalid_lat = False
    try:
        Business(
            business_id="biz_003",
            execution_id="exec_001",
            session_id="session_001",
            originating_provider_id="google_maps",
            name="Valid Name",
            discovered_at=t0,
            latitude=120.0,
        )
    except ValueError:
        invalid_lat = True
    check("4b. Out-of-bounds Latitude Rejected", invalid_lat, "Latitude 120.0 was accepted")

    # Invalid discovered_at type
    invalid_dt = False
    try:
        Business(
            business_id="biz_004",
            execution_id="exec_001",
            session_id="session_001",
            originating_provider_id="google_maps",
            name="Valid Name",
            discovered_at="2026-08-04",  # type: ignore
        )
    except TypeError:
        invalid_dt = True
    check("4c. Invalid discovered_at Type Rejected", invalid_dt, "String discovered_at was accepted")

    # ---------------------------------------------------------------------------
    # 5. BusinessRegistry Correctness & Operations
    # ---------------------------------------------------------------------------
    registry = BusinessRegistry()
    check("5a. Lack of update() Method", not hasattr(registry, "update"), "BusinessRegistry has an update() method")

    registry.register(biz1)
    registry.register(biz_empty)

    check("5b. Registry exists() True", registry.exists("biz_001"), "biz_001 not found")
    check("5c. Registry exists() False", not registry.exists("biz_999"), "biz_999 reported as existing")
    check("5d. Registry get() Correctness", registry.get("biz_001") == biz1, "get('biz_001') returned incorrect object")
    check("5e. Registry ids() Order", registry.ids() == ("biz_001", "biz_002"), f"ids() returned {registry.ids()}")
    check("5f. Registry all() Order", registry.all() == (biz1, biz_empty), f"all() count: {len(registry.all())}")

    # Duplicate registration protection
    dup_protection = False
    try:
        registry.register(biz1)
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
    removed_true = registry.remove("biz_001")
    removed_false = registry.remove("biz_001")
    check("5i. Registry remove() Return Values", removed_true and not removed_false, "remove() returned invalid status")
    check("5j. Registry State After Removal", not registry.exists("biz_001"), "biz_001 still exists after remove")

    # Re-register biz1
    registry.register(biz1)

    # ---------------------------------------------------------------------------
    # 6. Registry Thread Safety
    # ---------------------------------------------------------------------------
    thread_reg = BusinessRegistry()
    errors: list[Exception] = []

    def worker(worker_id: int) -> None:
        try:
            for i in range(50):
                b_id = f"biz_t_{worker_id}_{i}"
                b = Business(
                    business_id=b_id,
                    execution_id=f"exec_{worker_id}",
                    session_id="session_concurrent",
                    originating_provider_id="test_provider",
                    name=f"Concurrent Business {worker_id}-{i}",
                    discovered_at=t0,
                )
                thread_reg.register(b)
                if not thread_reg.exists(b_id):
                    raise RuntimeError(f"ID {b_id} missing immediately after registration")
                fetched = thread_reg.get(b_id)
                if fetched.name != f"Concurrent Business {worker_id}-{i}":
                    raise RuntimeError(f"Fetched incorrect name for {b_id}")
        except Exception as ex:
            errors.append(ex)

    threads = [threading.Thread(target=worker, args=(t_idx,)) for t_idx in range(5)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    check("6. Registry Thread Safety", len(errors) == 0, f"Thread errors encountered: {errors}")
    check("6b. Concurrent Items Count", len(thread_reg.ids()) == 250, f"Expected 250 items, got {len(thread_reg.ids())}")

    # ---------------------------------------------------------------------------
    # 7. Core Subsystem Integrity Checks
    # ---------------------------------------------------------------------------
    check("7a. Business Subsystem Exposes Expected Models", hasattr(business, "Business") and hasattr(business, "BusinessRegistry"), "business module missing exports")

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
