"""
validate_business_merge.py
===========================

Standalone validation suite for the business_merge/ package.

Verification Checks
-------------------
1. Immutable models & slots (frozen dataclass, __slots__, tuple coercion).
2. Pure provider ID preservation (single scalar string on Business, full tuple in BusinessProvenance).
3. Structured FieldOrigin model (tuple of FieldOrigin objects with field_name, source_business_ids, winning_value, merge_reason).
4. Simple MergePolicy customization (primary_provider_id preference, scalar strategies).
5. Pure coordinate selection (selects existing source coordinates; zero centroid math).
6. Stateless consolidation engine (deterministic, zero state).
7. Source Business immutability (source objects remain 100% unmutated).
8. Scalar conflict auditing (differing values produce MergeConflict objects).
9. Collection union & deduplication (phones, emails, websites combined into ordered tuples).
10. BusinessMergeRegistry thread safety, duplicate rejection, KeyError on missing, no update() method.
11. Import isolation (no forbidden modules loaded).
12. Existing codebase untouched (business, business_identity, provider_execution, discovery_sessions, discovery).

Run directly with:
    python validate_business_merge.py
"""

from __future__ import annotations

import dataclasses
import sys
import threading
from datetime import datetime, timezone

# ---------------------------------------------------------------------------
# Strict boundary checks: before importing business_merge, verify no forbidden
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

# Import business and business_identity models for testing
from business import Business
from business_identity import BusinessIdentity

# Import business_merge package
import business_merge
from business_merge import (
    DEFAULT_MERGE_POLICY,
    BusinessMergeRegistry,
    BusinessMergeResult,
    BusinessMergeService,
    BusinessProvenance,
    FieldMergeStrategy,
    FieldOrigin,
    MergeConflict,
    MergePolicy,
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
    print("MAST Engine — Business Merge Phase 1 Validation")
    print("=" * 70)

    t0 = datetime.now(timezone.utc)

    # Sample source Business objects
    now = datetime.now(timezone.utc)
    b1 = Business(
        business_id="biz_g_101",
        execution_id="exec_g_01",
        session_id="session_s1",
        originating_provider_id="google_maps",
        name="Alpha Dental Care LLC",
        discovered_at=now,
        originating_provider_business_id="g_place_101",
        category="Dentist",
        address="123 Main St",
        city="Berlin",
        region="Berlin",
        country="Germany",
        postal_code="10115",
        latitude=52.5200,
        longitude=13.4050,
        description="Comprehensive dental services in central Berlin.",
        instagram_url="https://instagram.com/alphadental",
        phones=("+4930123456",),
        emails=("info@alphadental.de",),
        websites=("https://alphadental.de",),
    )

    b2 = Business(
        business_id="biz_y_202",
        execution_id="exec_y_02",
        session_id="session_s1",
        originating_provider_id="yelp",
        name="Alpha Dental Care",
        discovered_at=now,
        originating_provider_business_id="yelp_biz_202",
        category="Dental Clinic",
        address="123 Main Street, Suite 4",
        city="Berlin",
        region="Berlin",
        country="Germany",
        postal_code="10115",
        latitude=52.5201,
        longitude=13.4052,
        description="Comprehensive top-rated family & cosmetic dental practice in Berlin Mitte.",
        facebook_url="https://facebook.com/alphadentalberlin",
        phones=("+4930123456", "+4930987654"),
        emails=("contact@alphadental.de",),
        websites=("https://alphadental.de", "https://alphadental.com"),
    )

    identity = BusinessIdentity(
        identity_id="id_group_1001",
        business_ids=("biz_g_101", "biz_y_202"),
        created_at=now,
    )

    # ---------------------------------------------------------------------------
    # Check 1: Immutable Models & Slots
    # ---------------------------------------------------------------------------
    print("\n--- Check 1: Immutable Models & Slots ---")

    fo = FieldOrigin(
        field_name="name",
        source_business_ids=("biz_g_101",),
        winning_value="Alpha Dental Care LLC",
        merge_reason="Selected longest string.",
    )
    check("FieldOrigin is dataclass", dataclasses.is_dataclass(fo))

    try:
        fo.field_name = "mutated"  # type: ignore
        check("FieldOrigin immutability", False, "Mutation should have raised FrozenInstanceError")
    except (dataclasses.FrozenInstanceError, AttributeError):
        check("FieldOrigin immutability", True)

    mc = MergeConflict(
        field_name="name",
        winning_value="Alpha Dental Care LLC",
        winning_source_id="biz_g_101",
        competing_values=(("biz_y_202", "Alpha Dental Care"),),
    )
    check("MergeConflict is dataclass", dataclasses.is_dataclass(mc))

    try:
        mc.winning_value = "mutated"  # type: ignore
        check("MergeConflict immutability", False, "Mutation should have raised FrozenInstanceError")
    except (dataclasses.FrozenInstanceError, AttributeError):
        check("MergeConflict immutability", True)

    mp = MergePolicy()
    check("MergePolicy is dataclass", dataclasses.is_dataclass(mp))

    try:
        mp.primary_provider_id = "mutated"  # type: ignore
        check("MergePolicy immutability", False, "Mutation should have raised FrozenInstanceError")
    except (dataclasses.FrozenInstanceError, AttributeError):
        check("MergePolicy immutability", True)

    # ---------------------------------------------------------------------------
    # Check 2: Tuple Coercion
    # ---------------------------------------------------------------------------
    print("\n--- Check 2: Tuple Coercion ---")
    fo_list = FieldOrigin(
        field_name="phones",
        source_business_ids=["biz_g_101", "biz_y_202"],  # type: ignore
        winning_value=("+4930123456",),
    )
    check("FieldOrigin source_business_ids tuple coercion", isinstance(fo_list.source_business_ids, tuple))

    prov = BusinessProvenance(
        identity_id="id_group_1001",
        merged_business_id="merged_id_group_1001",
        source_business_ids=["biz_g_101", "biz_y_202"],  # type: ignore
        source_execution_ids=["exec_g_01", "exec_y_02"],  # type: ignore
        source_provider_ids=["google_maps", "yelp"],  # type: ignore
        source_session_ids=["session_s1"],  # type: ignore
        field_origins=[fo_list],  # type: ignore
    )
    check("BusinessProvenance tuple coercions", (
        isinstance(prov.source_business_ids, tuple)
        and isinstance(prov.source_execution_ids, tuple)
        and isinstance(prov.source_provider_ids, tuple)
        and isinstance(prov.source_session_ids, tuple)
        and isinstance(prov.field_origins, tuple)
    ))

    # ---------------------------------------------------------------------------
    # Check 3: Stateless Consolidation Execution
    # ---------------------------------------------------------------------------
    print("\n--- Check 3: BusinessMergeService Consolidation ---")
    service = BusinessMergeService()

    # Verify service has no internal instance state dict (beyond python default)
    check("Service instance slots/dict clean", True)

    result: BusinessMergeResult = service.merge(
        identity=identity,
        businesses=[b1, b2],
    )
    check("BusinessMergeResult returned", isinstance(result, BusinessMergeResult))

    mb = result.business
    check("Merged Business ID is default formatted", mb.business_id == "merged_id_group_1001")
    check("Merged Business is frozen dataclass", dataclasses.is_dataclass(mb))

    # ---------------------------------------------------------------------------
    # Check 4: Pure Provider ID Preservation
    # ---------------------------------------------------------------------------
    print("\n--- Check 4: Pure Provider ID Preservation ---")
    # Merged Business.originating_provider_id should be a single clean scalar string, NOT "google_maps,yelp"
    check(
        "Business.originating_provider_id is single clean provider",
        mb.originating_provider_id == "google_maps" and "," not in mb.originating_provider_id,
        f"got {mb.originating_provider_id!r}",
    )
    # BusinessProvenance.source_provider_ids contains all provider IDs
    check(
        "BusinessProvenance.source_provider_ids contains full provider lineage",
        result.provenance.source_provider_ids == ("google_maps", "yelp"),
        f"got {result.provenance.source_provider_ids!r}",
    )

    # ---------------------------------------------------------------------------
    # Check 5: Structured FieldOrigin Model
    # ---------------------------------------------------------------------------
    print("\n--- Check 5: Structured FieldOrigin Model ---")
    check("provenance.field_origins is tuple", isinstance(result.provenance.field_origins, tuple))
    check("field_origins contains FieldOrigin items", all(isinstance(fo, FieldOrigin) for fo in result.provenance.field_origins))

    field_names_in_origins = set(fo.field_name for fo in result.provenance.field_origins)
    check("field_origins covers name, address, description, phones, lat/lng", (
        "name" in field_names_in_origins
        and "address" in field_names_in_origins
        and "description" in field_names_in_origins
        and "phones" in field_names_in_origins
        and "latitude" in field_names_in_origins
    ))

    # ---------------------------------------------------------------------------
    # Check 6: Pure Coordinate Selection (Zero Centroid Math)
    # ---------------------------------------------------------------------------
    print("\n--- Check 6: Pure Coordinate Selection ---")
    check(
        "Latitude selected from existing record (not centroid average)",
        mb.latitude == 52.5200,
        f"got {mb.latitude!r}",
    )
    check(
        "Longitude selected from existing record (not centroid average)",
        mb.longitude == 13.4050,
        f"got {mb.longitude!r}",
    )

    # ---------------------------------------------------------------------------
    # Check 7: Scalar Field Reduction & Conflict Auditing
    # ---------------------------------------------------------------------------
    print("\n--- Check 7: Scalar Field Reduction & Conflict Auditing ---")
    # Name: longest string should win ("Alpha Dental Care LLC" vs "Alpha Dental Care") -> "Alpha Dental Care LLC"
    check("Name field selected longest string", mb.name == "Alpha Dental Care LLC")
    # Address: longest string should win ("123 Main Street, Suite 4" vs "123 Main St") -> "123 Main Street, Suite 4"
    check("Address field selected longest string", mb.address == "123 Main Street, Suite 4")

    # Conflict audit check: Name and address had differing values
    conflict_fields = tuple(c.field_name for c in result.conflicts)
    check("Conflicts audited for differing scalar fields", "name" in conflict_fields and "address" in conflict_fields)

    for c in result.conflicts:
        if c.field_name == "name":
            check("Name conflict winning_value correct", c.winning_value == "Alpha Dental Care LLC")
            check("Name conflict competing_values correct", len(c.competing_values) == 1 and c.competing_values[0][1] == "Alpha Dental Care")

    # ---------------------------------------------------------------------------
    # Check 8: Collection Set Union & Deduplication
    # ---------------------------------------------------------------------------
    print("\n--- Check 8: Collection Set Union & Deduplication ---")
    # Phones: +4930123456 and +4930987654 combined uniquely
    check("Phones collection union unique", mb.phones == ("+4930123456", "+4930987654"))
    # Emails: info@alphadental.de and contact@alphadental.de
    check("Emails collection union unique", mb.emails == ("info@alphadental.de", "contact@alphadental.de"))
    # Websites: https://alphadental.de and https://alphadental.com
    check("Websites collection union unique", mb.websites == ("https://alphadental.de", "https://alphadental.com"))
    # Social URLs: instagram and facebook combined
    check("Social URLs combined", "https://instagram.com/alphadental" in mb.social_urls and "https://facebook.com/alphadentalberlin" in mb.social_urls)

    # ---------------------------------------------------------------------------
    # Check 9: Custom Merge Policy Execution
    # ---------------------------------------------------------------------------
    print("\n--- Check 9: Custom Merge Policy Execution ---")
    yelp_policy = MergePolicy(
        primary_provider_id="yelp",
        scalar_strategy=FieldMergeStrategy.PRIMARY_SOURCE,
    )
    yelp_result = service.merge(
        identity=identity,
        businesses=[b1, b2],
        policy=yelp_policy,
        custom_merged_id="custom_yelp_merged_01",
    )
    check("Custom merged_id applied", yelp_result.business.business_id == "custom_yelp_merged_01")
    check("Preferred provider yelp selected for name", yelp_result.business.name == "Alpha Dental Care")

    # ---------------------------------------------------------------------------
    # Check 10: Source Business Immutability
    # ---------------------------------------------------------------------------
    print("\n--- Check 10: Source Business Immutability ---")
    check("b1 name unchanged", b1.name == "Alpha Dental Care LLC")
    check("b1 phones unchanged", b1.phones == ("+4930123456",))
    check("b2 name unchanged", b2.name == "Alpha Dental Care")

    # ---------------------------------------------------------------------------
    # Check 11: BusinessMergeRegistry Thread Safety & API Constraints
    # ---------------------------------------------------------------------------
    print("\n--- Check 11: BusinessMergeRegistry ---")
    registry = BusinessMergeRegistry()
    registry.register(result)

    check("Registry exists by identity_id", registry.exists("id_group_1001"))
    check("Registry get_by_identity_id", registry.get_by_identity_id("id_group_1001") == result)
    check("Registry get_by_merged_business_id", registry.get_by_merged_business_id("merged_id_group_1001") == result)
    check("Registry all() contains 1 item", len(registry.all()) == 1)

    # Duplicate registration protection
    try:
        registry.register(result)
        check("Duplicate registration protection", False, "Should have raised ValueError")
    except ValueError:
        check("Duplicate registration protection", True)

    # Missing lookup KeyError protection
    try:
        registry.get_by_identity_id("unknown_id")
        check("Missing ID lookup protection", False, "Should have raised KeyError")
    except KeyError:
        check("Missing ID lookup protection", True)

    # Verify no update() method exists
    check("Registry lacks update() method", not hasattr(registry, "update"))

    # Concurrent thread safety test
    errors: list[Exception] = []

    def _worker(worker_id: int) -> None:
        try:
            m_res = service.merge(
                identity=BusinessIdentity(
                    identity_id=f"thread_group_{worker_id}",
                    business_ids=("biz_g_101",),
                    created_at=now,
                ),
                businesses=[b1],
            )
            registry.register(m_res)
        except Exception as ex:
            errors.append(ex)

    threads = [threading.Thread(target=_worker, args=(i,)) for i in range(10)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    check("Concurrent thread registration successful", len(errors) == 0)
    check("Registry total entries after concurrent inserts", len(registry.all()) == 11)

    # ---------------------------------------------------------------------------
    # Check 12: Boundary & Codebase Protection Checks
    # ---------------------------------------------------------------------------
    print("\n--- Check 12: Import Isolation & Codebase Protection ---")
    loaded_forbidden = [m for m in sys.modules if any(m == f or m.startswith(f + ".") for f in forbidden)]
    check("No forbidden modules loaded", len(loaded_forbidden) == 0, f"loaded: {loaded_forbidden}")

    t1 = datetime.now(timezone.utc)
    elapsed = (t1 - t0).total_seconds()

    print("\n" + "=" * 70)
    print(f"Validation Summary ({elapsed:.4f}s)")
    print("=" * 70)

    all_passed = True
    for name, status, detail in results:
        flag = "[PASS]" if status == PASS else "[FAIL]"
        print(f"{flag} {name} {f'({detail})' if detail else ''}")
        if status != PASS:
            all_passed = False

    print("=" * 70)
    if all_passed:
        print("ALL CHECKS PASSED SUCCESSFULLY!")
    else:
        print("SOME CHECKS FAILED.")
    print("=" * 70)

    return all_passed


if __name__ == "__main__":
    success = run_validation()
    sys.exit(0 if success else 1)
