"""
validate_business_enrichment.py
================================

Validation script for the Business Enrichment Phase 1 Architecture Foundation.

Verifies:
1. Frozen/slotted dataclasses and immutability guarantees.
2. Self-contained BusinessEnrichmentDelta models with embedded EnrichmentSource.
3. Strongly typed candidate validation at construction time.
4. Pure, stateless BusinessEnrichmentService operation.
5. Absolute immutability of the source Business object.
6. Field provenance and confidence metadata tracking.
7. Discrepancy conflict auditing.
8. Strict import isolation (zero forbidden imports).
"""

from __future__ import annotations

import ast
from dataclasses import FrozenInstanceError
from datetime import datetime, timezone
import sys
from pathlib import Path

# Add project directory to sys.path
engine_dir = Path(__file__).resolve().parent
if str(engine_dir) not in sys.path:
    sys.path.insert(0, str(engine_dir))

from business.models import Business
from business_enrichment import (
    DEFAULT_ENRICHMENT_POLICY,
    BusinessEnrichmentDelta,
    BusinessEnrichmentResult,
    BusinessEnrichmentService,
    ConflictResolution,
    EnrichedField,
    EnrichmentConflict,
    EnrichmentPolicy,
    EnrichmentPolicyStrategy,
    EnrichmentSource,
    EnrichmentSourceType,
)


def test_frozen_slotted_models() -> None:
    """Verify all domain models are slotted and frozen."""
    now = datetime.now(timezone.utc)
    source = EnrichmentSource(
        source_id="src_01",
        source_type=EnrichmentSourceType.PROVIDER,
        timestamp=now,
        provider_id="apollo",
    )

    delta = BusinessEnrichmentDelta(
        source=source,
        description="Enriched Dental Practice",
        phones=("+15551234567",),
        confidence=0.9,
    )

    policy = EnrichmentPolicy()

    # Test slots existence
    assert hasattr(source, "__slots__"), "EnrichmentSource must have __slots__"
    assert hasattr(delta, "__slots__"), "BusinessEnrichmentDelta must have __slots__"
    assert hasattr(policy, "__slots__"), "EnrichmentPolicy must have __slots__"

    # Test frozen mutation restriction
    try:
        source.source_id = "mutated"  # type: ignore[misc]
        assert False, "EnrichmentSource mutation should have raised FrozenInstanceError"
    except FrozenInstanceError:
        pass

    try:
        delta.description = "Mutated description"  # type: ignore[misc]
        assert False, "BusinessEnrichmentDelta mutation should have raised FrozenInstanceError"
    except FrozenInstanceError:
        pass

    print("[PASS] test_frozen_slotted_models")


def test_delta_validation() -> None:
    """Verify construction-time validation of BusinessEnrichmentDelta."""
    now = datetime.now(timezone.utc)
    source = EnrichmentSource(
        source_id="src_01",
        source_type=EnrichmentSourceType.PROVIDER,
        timestamp=now,
    )

    # Invalid confidence
    try:
        BusinessEnrichmentDelta(source=source, confidence=1.5)
        assert False, "Should raise ValueError for confidence > 1.0"
    except ValueError:
        pass

    # Invalid latitude
    try:
        BusinessEnrichmentDelta(source=source, latitude=100.0)
        assert False, "Should raise ValueError for latitude > 90.0"
    except ValueError:
        pass

    print("[PASS] test_delta_validation")


def test_stateless_enrichment_service() -> None:
    """Verify stateless BusinessEnrichmentService operations and immutability."""
    now = datetime.now(timezone.utc)

    # Initial canonical Business
    biz = Business(
        business_id="biz_dentist_berlin_01",
        execution_id="exec_google_01",
        session_id="sess_01",
        originating_provider_id="google_maps",
        name="Berlin Dental Clinic",
        discovered_at=now,
        category="Dentist",
        city="Berlin",
        country="Germany",
        phones=("+4930123456",),
        websites=("https://berlindental.de",),
    )

    source_apollo = EnrichmentSource(
        source_id="src_apollo_01",
        source_type=EnrichmentSourceType.PROVIDER,
        timestamp=now,
        provider_id="apollo",
    )

    source_yelp = EnrichmentSource(
        source_id="src_yelp_01",
        source_type=EnrichmentSourceType.PROVIDER,
        timestamp=now,
        provider_id="yelp",
    )

    delta_apollo = BusinessEnrichmentDelta(
        source=source_apollo,
        description="Premium dental clinic in Berlin Mitte",
        instagram_url="https://instagram.com/berlindental",
        emails=("contact@berlindental.de",),
        confidence=0.95,
    )

    delta_yelp = BusinessEnrichmentDelta(
        source=source_yelp,
        category="Dental Surgery",  # Discrepant category
        phones=("+4930123456", "+4930987654"),  # Additional phone
        confidence=0.80,
    )

    # Perform enrichment
    result = BusinessEnrichmentService.enrich(
        business=biz,
        deltas=[delta_apollo, delta_yelp],
        policy=DEFAULT_ENRICHMENT_POLICY,
    )

    # 1. Verify original Business was NOT mutated
    assert biz.description is None, "Original business description must remain None"
    assert biz.instagram_url is None, "Original business instagram_url must remain None"
    assert biz.phones == ("+4930123456",), "Original business phones must remain untouched"
    assert biz.emails == (), "Original business emails must remain empty"

    # 2. Verify enriched Business has new values
    enriched_biz = result.enriched_business
    assert enriched_biz.business_id == "biz_dentist_berlin_01"
    assert enriched_biz.description == "Premium dental clinic in Berlin Mitte"
    assert enriched_biz.instagram_url == "https://instagram.com/berlindental"
    assert enriched_biz.emails == ("contact@berlindental.de",)
    assert enriched_biz.phones == ("+4930123456", "+4930987654")

    # 3. Verify Result container properties
    assert isinstance(result, BusinessEnrichmentResult)
    assert result.enrichment_id.startswith("enrich_biz_dentist_berlin_01_")
    assert isinstance(result.field_provenances, tuple)
    assert isinstance(result.conflicts, tuple)

    # 4. Verify Field Provenance
    desc_prov = [p for p in result.field_provenances if p.field_name == "description"]
    assert len(desc_prov) == 1
    assert desc_prov[0].source_id == "src_apollo_01"
    assert desc_prov[0].provider_id == "apollo"
    assert desc_prov[0].confidence == 0.95

    # 5. Verify Conflict Audit
    cat_conflicts = [c for c in result.conflicts if c.field_name == "category"]
    assert len(cat_conflicts) == 1
    assert cat_conflicts[0].existing_value == "Dentist"
    assert cat_conflicts[0].proposed_value == "Dental Surgery"
    assert cat_conflicts[0].source_id == "src_yelp_01"
    assert cat_conflicts[0].resolution == ConflictResolution.PRESERVED

    print("[PASS] test_stateless_enrichment_service")


def test_import_isolation() -> None:
    """Verify business_enrichment package does not import from forbidden subsystems."""
    package_dir = engine_dir / "business_enrichment"
    forbidden_modules = [
        "engine",
        "providers",
        "provider_execution",
        "discovery",
        "discovery_sessions",
        "scoring",
        "intelligence",
    ]

    for py_file in package_dir.glob("*.py"):
        tree = ast.parse(py_file.read_text("utf-8"))
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                for alias in node.names:
                    root_mod = alias.name.split(".")[0]
                    assert (
                        root_mod not in forbidden_modules
                    ), f"Forbidden import {alias.name!r} found in {py_file.name}"
            elif isinstance(node, ast.ImportFrom):
                if node.module:
                    root_mod = node.module.split(".")[0]
                    assert (
                        root_mod not in forbidden_modules
                    ), f"Forbidden import {node.module!r} found in {py_file.name}"

    print("[PASS] test_import_isolation")


def main() -> None:
    print("Beginning Business Enrichment Validation...")
    test_frozen_slotted_models()
    test_delta_validation()
    test_stateless_enrichment_service()
    test_import_isolation()
    print("\nALL BUSINESS ENRICHMENT VALIDATION TESTS PASSED SUCCESSFULLY!")


if __name__ == "__main__":
    main()
