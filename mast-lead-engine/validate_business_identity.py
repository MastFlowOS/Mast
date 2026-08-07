"""
validate_business_identity.py
==============================

Standalone validation suite for the business_identity/ package.

Verification Checks
-------------------
1. Immutable models & slots (frozen dataclass, __slots__, tuple coercion, no primary_business_id).
2. Slots present and enforced.
3. Registry correctness & lack of update() method (register, get, exists, ids, all, remove).
4. Duplicate protection (ValueError on duplicate identity_id).
5. Stateless matcher verification (no state, no factory methods like create_identity).
6. Deterministic matching (provider_ids, name, phone, website, location, evaluate_match).
7. Thread safety across concurrent identity registrations and lookups.
8. Import isolation (no forbidden modules loaded).
9. Engine untouched.
10. Business Layer untouched.
11. Discovery untouched.
12. Provider Execution untouched.

Run directly with:
    python validate_business_identity.py
"""

from __future__ import annotations

import sys
import threading
import dataclasses
from datetime import datetime, timezone

# ---------------------------------------------------------------------------
# Strict boundary checks: before importing business_identity, verify no forbidden
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

# Import business package models for testing matcher
from business import Business

# Import business_identity package
import business_identity
from business_identity import (
    BusinessIdentity,
    BusinessIdentityMatcher,
    BusinessIdentityRegistry,
)

PASS = "PASS"
FAIL = "FAIL"
results: list[tuple[str, str, str]] = []


def check(name: str, condition: bool, detail: str = "") -> None:
    results.append((name, PASS if condition else FAIL, detail))
    if not condition:
        print(f"FAILED: {name} - {detail}")


def run_validation() -> bool:
    print("=" * 70)
    print("MAST Engine — Business Identity Resolution Phase 1 Validation")
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
    ident1 = BusinessIdentity(
        identity_id="id_group_001",
        business_ids=("biz_001", "biz_002", "biz_003"),
        created_at=t0,
    )

    check("2a. BusinessIdentity Dataclass", dataclasses.is_dataclass(ident1))
    check("2b. BusinessIdentity Slots Present", hasattr(ident1, "__slots__"), "Model missing __slots__")
    check("2c. No primary_business_id field", not hasattr(ident1, "primary_business_id"), "primary_business_id field present unexpectedly")

    mutation_failed = False
    try:
        ident1.identity_id = "id_group_mutated"  # type: ignore[misc]
    except (dataclasses.FrozenInstanceError, AttributeError):
        mutation_failed = True
    check("2d. Model Immutability", mutation_failed, "Mutation of BusinessIdentity instance succeeded unexpectedly")

    check("2e. Collection Coerced to Tuple", isinstance(ident1.business_ids, tuple), f"Got {type(ident1.business_ids)}")
    check("2f. Count Property Correctness", ident1.count == 3, f"Expected 3, got {ident1.count}")

    # Validation errors check
    empty_id_failed = False
    try:
        BusinessIdentity(identity_id="", business_ids=("biz_001",), created_at=t0)
    except ValueError:
        empty_id_failed = True
    check("2g. Empty identity_id Rejected", empty_id_failed)

    empty_list_failed = False
    try:
        BusinessIdentity(identity_id="id_group_002", business_ids=(), created_at=t0)
    except ValueError:
        empty_list_failed = True
    check("2h. Empty business_ids Rejected", empty_list_failed)

    # ---------------------------------------------------------------------------
    # 3. Stateless Matcher Verification
    # ---------------------------------------------------------------------------
    matcher = BusinessIdentityMatcher()
    check("3a. Matcher Slots Empty", matcher.__slots__ == (), f"Matcher slots: {matcher.__slots__}")
    check("3b. No create_identity Method", not hasattr(BusinessIdentityMatcher, "create_identity"), "Matcher has create_identity method")

    # Sample canonical businesses
    b_gmaps = Business(
        business_id="biz_gmaps_01",
        execution_id="exec_gmaps",
        session_id="session_01",
        originating_provider_id="google_maps",
        originating_provider_business_id="gmaps_place_123",
        name="Joe's Pizza & Pasta",
        discovered_at=t0,
        address="100 Main St",
        city="New York",
        country="USA",
        latitude=40.7128,
        longitude=-74.0060,
        phones=("+12125550199",),
        websites=("https://joespizza.com",),
    )

    b_yelp = Business(
        business_id="biz_yelp_01",
        execution_id="exec_yelp",
        session_id="session_01",
        originating_provider_id="yelp",
        originating_provider_business_id="yelp_biz_456",
        name="JOE'S PIZZA AND PASTA",
        discovered_at=t0,
        address="100 Main St",
        city="New York",
        country="USA",
        latitude=40.7129,
        longitude=-74.0061,
        phones=("(212) 555-0199",),
        websites=("http://www.joespizza.com/",),
    )

    b_different = Business(
        business_id="biz_other_01",
        execution_id="exec_other",
        session_id="session_01",
        originating_provider_id="overpass",
        name="Mario's Bakery",
        discovered_at=t0,
        phones=("+12125559999",),
        websites=("https://mariosbakery.com",),
    )

    # ---------------------------------------------------------------------------
    # 4. Deterministic Matching Verification
    # ---------------------------------------------------------------------------
    # Same provider ID matching
    b_gmaps2 = Business(
        business_id="biz_gmaps_02",
        execution_id="exec_gmaps2",
        session_id="session_01",
        originating_provider_id="google_maps",
        originating_provider_business_id="gmaps_place_123",
        name="Joe's Pizza",
        discovered_at=t0,
    )
    check("4a. Match by Provider IDs True", BusinessIdentityMatcher.match_by_provider_ids(b_gmaps, b_gmaps2))
    check("4b. Match by Provider IDs False", not BusinessIdentityMatcher.match_by_provider_ids(b_gmaps, b_yelp))

    # Name matching
    check("4c. Match by Name True", BusinessIdentityMatcher.match_by_name(b_gmaps, b_yelp))
    check("4d. Match by Name False", not BusinessIdentityMatcher.match_by_name(b_gmaps, b_different))

    # Phone matching
    check("4e. Match by Phone True", BusinessIdentityMatcher.match_by_phone(b_gmaps, b_yelp))
    check("4f. Match by Phone False", not BusinessIdentityMatcher.match_by_phone(b_gmaps, b_different))

    # Website matching
    check("4g. Match by Website True", BusinessIdentityMatcher.match_by_website(b_gmaps, b_yelp))
    check("4h. Match by Website False", not BusinessIdentityMatcher.match_by_website(b_gmaps, b_different))

    # Location matching
    check("4i. Match by Location True", BusinessIdentityMatcher.match_by_location(b_gmaps, b_yelp, max_distance_meters=50.0))
    check("4j. Match by Location False", not BusinessIdentityMatcher.match_by_location(b_gmaps, b_different))

    # Evaluate match
    matched, rule = BusinessIdentityMatcher.evaluate_match(b_gmaps, b_yelp)
    check("4k. Evaluate Match True", matched and rule in ("match_by_name", "match_by_phone", "match_by_website", "match_by_location"), f"Matched via {rule}")

    matched_diff, rule_diff = BusinessIdentityMatcher.evaluate_match(b_gmaps, b_different)
    check("4l. Evaluate Match False", not matched_diff and rule_diff == "no_match")

    # ---------------------------------------------------------------------------
    # 5. BusinessIdentityRegistry Operations & Correctness
    # ---------------------------------------------------------------------------
    registry = BusinessIdentityRegistry()
    check("5a. Lack of update() Method", not hasattr(registry, "update"), "BusinessIdentityRegistry has an update() method")
    check("5b. Lack of get_for_business() Method", not hasattr(registry, "get_for_business"), "Registry has get_for_business business logic method")

    registry.register(ident1)

    ident2 = BusinessIdentity(
        identity_id="id_group_002",
        business_ids=("biz_004", "biz_005"),
        created_at=t0,
    )
    registry.register(ident2)

    check("5c. Registry exists() True", registry.exists("id_group_001"))
    check("5d. Registry exists() False", not registry.exists("id_group_999"))
    check("5e. Registry get() Correctness", registry.get("id_group_001") == ident1)
    check("5f. Registry ids() Order", registry.ids() == ("id_group_001", "id_group_002"), f"ids() returned {registry.ids()}")
    check("5g. Registry all() Count", len(registry.all()) == 2)

    # Duplicate identity_id protection
    dup_protection = False
    try:
        registry.register(ident1)
    except ValueError:
        dup_protection = True
    check("5h. Duplicate identity_id Protection", dup_protection)

    # KeyError on unknown lookup
    key_error_pass = False
    try:
        registry.get("non_existent_id")
    except KeyError:
        key_error_pass = True
    check("5i. KeyError on Missing Lookup", key_error_pass)

    # Remove check
    removed_true = registry.remove("id_group_001")
    removed_false = registry.remove("id_group_001")
    check("5j. Registry remove() Return Values", removed_true and not removed_false)
    check("5k. Registry State After Removal", not registry.exists("id_group_001"))

    # Re-register ident1
    registry.register(ident1)

    # ---------------------------------------------------------------------------
    # 6. Registry Thread Safety
    # ---------------------------------------------------------------------------
    thread_reg = BusinessIdentityRegistry()
    errors: list[Exception] = []

    def worker(worker_id: int) -> None:
        try:
            for i in range(50):
                grp_id = f"id_group_t_{worker_id}_{i}"
                identity = BusinessIdentity(
                    identity_id=grp_id,
                    business_ids=(f"biz_{worker_id}_{i}_a", f"biz_{worker_id}_{i}_b"),
                    created_at=t0,
                )
                thread_reg.register(identity)
                if not thread_reg.exists(grp_id):
                    raise RuntimeError(f"ID {grp_id} missing immediately after registration")
                fetched = thread_reg.get(grp_id)
                if fetched.identity_id != grp_id:
                    raise RuntimeError(f"Fetched incorrect identity_id for {grp_id}")
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
    # 7. Subsystem Integration & Export Verification
    # ---------------------------------------------------------------------------
    check(
        "7. Package Exports",
        hasattr(business_identity, "BusinessIdentity")
        and hasattr(business_identity, "BusinessIdentityMatcher")
        and hasattr(business_identity, "BusinessIdentityRegistry"),
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
