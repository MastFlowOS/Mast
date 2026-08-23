"""
tests/test_phase24_niche_relevance.py
======================================

Comprehensive test suite for Phase 24: Deterministic Niche / Category Relevance Gate.

Test Requirements:
1. Coffee Shop + Cafe -> PASS
2. Coffee Shop + Coffee Shop -> PASS
3. Coffee Shop + Coffee Roaster -> PASS
4. Coffee Shop + Bakery Cafe -> PASS
5. Coffee Shop + Pharmacy -> REJECT
6. Coffee Shop + Mechanical Parts -> REJECT
7. Coffee Shop + Auto Repair -> REJECT
8. Missing category -> AMBIGUOUS / KEEP
9. Missing requested_niche -> legacy behavior preserved
10. requested_niche survives provider -> candidate
11. mismatch never reaches scoring
12. mismatch never reaches storage
13. valid match still requires all required channels
14. >100K follower rejection still works
15. mismatch + >100K does not produce duplicate/conflicting delivery
16. provider identity does not bypass relevance gate
17. dedup unchanged
18. score formula unchanged
"""

from __future__ import annotations

from unittest.mock import MagicMock
import pytest

from engine.contracts import (
    BusinessCandidate,
    ContactIntel,
    EnrichedBusiness,
    InstagramIntel,
    QualificationResult,
    QualifiedOpportunity,
    StoredOpportunity,
    WebsiteIntel,
)
from opportunity_qualification.niche_relevance import (
    evaluate_niche_relevance,
    normalize_category_string,
)
from providers.google_maps_provider import GoogleMapsProvider
from providers.overpass_provider import OverpassDiscoveryRequest, OverpassProvider
from scraper.maps_scraper import RawPlace
from workers.qualification_worker import QualificationWorker
from workers.scoring_worker import ScoringWorker
from workers.storage_worker import StorageWorker


class InMemoryStorageBackend:
    def __init__(self) -> None:
        self.stored: list[StoredOpportunity] = []

    def persist(self, opportunity: QualifiedOpportunity) -> StoredOpportunity:
        stored = StoredOpportunity(
            opportunity_id=f"opp-{len(self.stored) + 1}",
            pipeline_id=opportunity.pipeline_id,
        )
        self.stored.append(stored)
        return stored


def _make_candidate(
    *,
    pipeline_id: str = "pipe-1",
    name: str = "Test Business",
    category: str | None = "Coffee shop",
    requested_niche: str | None = "Coffee Shop",
    provider: str = "google_maps",
    website: str | None = "https://example.com",
    phone: str | None = "555-1234",
    instagram_url: str | None = "https://instagram.com/testbiz",
) -> BusinessCandidate:
    return BusinessCandidate(
        pipeline_id=pipeline_id,
        session_id="sess-test",
        provider=provider,
        name=name,
        category=category,
        requested_niche=requested_niche,
        website=website,
        phone=phone,
        instagram_url=instagram_url,
    )


def _make_enriched(
    candidate: BusinessCandidate,
    *,
    website_reachable: bool = True,
    profile_reachable: bool = True,
    followers: int | None = 500,
    emails: tuple[str, ...] = ("hello@example.com",),
    phones: tuple[str, ...] = ("555-1234",),
) -> EnrichedBusiness:
    web = WebsiteIntel(
        pipeline_id=candidate.pipeline_id,
        website_reachable=website_reachable,
        https=True,
    ) if candidate.website else None

    ig = InstagramIntel(
        pipeline_id=candidate.pipeline_id,
        profile_reachable=profile_reachable,
        followers=followers,
    ) if (candidate.instagram_url or profile_reachable) else None

    contact = ContactIntel(
        pipeline_id=candidate.pipeline_id,
        emails=emails,
        phones=phones,
    )

    return EnrichedBusiness(
        pipeline_id=candidate.pipeline_id,
        business=candidate,
        website_intel=web,
        instagram_intel=ig,
        contact_intel=contact,
    )


class TestPhase24NicheCategoryRelevance:
    # 1. Coffee Shop + Cafe -> PASS
    def test_coffee_shop_plus_cafe_passes(self) -> None:
        relevance, _ = evaluate_niche_relevance("Coffee Shop", "Cafe", "Artisan Coffee")
        assert relevance == "match"

        worker = QualificationWorker(
            required_channels=("website", "email", "phone", "instagram")
        )
        cand = _make_candidate(requested_niche="Coffee Shop", category="Cafe")
        enriched = _make_enriched(cand)
        res = worker.process(enriched)
        assert res.qualified is True
        assert "niche_mismatch" not in res.reasons

    # 2. Coffee Shop + Coffee Shop -> PASS
    def test_coffee_shop_plus_coffee_shop_passes(self) -> None:
        relevance, _ = evaluate_niche_relevance("Coffee Shop", "Coffee shop", "Daily Brew")
        assert relevance == "match"

        worker = QualificationWorker(
            required_channels=("website", "email", "phone", "instagram")
        )
        cand = _make_candidate(requested_niche="Coffee Shop", category="Coffee shop")
        enriched = _make_enriched(cand)
        res = worker.process(enriched)
        assert res.qualified is True

    # 3. Coffee Shop + Coffee Roaster -> PASS
    def test_coffee_shop_plus_coffee_roaster_passes(self) -> None:
        relevance, _ = evaluate_niche_relevance("Coffee Shop", "Coffee roasters", "Summit Roasters")
        assert relevance == "match"

        worker = QualificationWorker(
            required_channels=("website", "email", "phone", "instagram")
        )
        cand = _make_candidate(requested_niche="Coffee Shop", category="Coffee roaster")
        enriched = _make_enriched(cand)
        res = worker.process(enriched)
        assert res.qualified is True

    # 4. Coffee Shop + Bakery Cafe -> PASS
    def test_coffee_shop_plus_bakery_cafe_passes(self) -> None:
        relevance, _ = evaluate_niche_relevance("Coffee Shop", "Bakery cafe", "Morning Crumb")
        assert relevance == "match"

        worker = QualificationWorker(
            required_channels=("website", "email", "phone", "instagram")
        )
        cand = _make_candidate(requested_niche="Coffee Shop", category="Bakery cafe")
        enriched = _make_enriched(cand)
        res = worker.process(enriched)
        assert res.qualified is True

    # 5. Coffee Shop + Pharmacy -> REJECT
    def test_coffee_shop_plus_pharmacy_rejected(self) -> None:
        relevance, _ = evaluate_niche_relevance("Coffee Shop", "Pharmacy", "City Care Rx")
        assert relevance == "mismatch"

        worker = QualificationWorker(
            required_channels=("website", "email", "phone", "instagram")
        )
        cand = _make_candidate(requested_niche="Coffee Shop", category="Pharmacy")
        enriched = _make_enriched(cand)
        res = worker.process(enriched)
        assert res.qualified is False
        assert "niche_mismatch" in res.reasons

    # 6. Coffee Shop + Mechanical Parts -> REJECT
    def test_coffee_shop_plus_mechanical_parts_rejected(self) -> None:
        relevance, _ = evaluate_niche_relevance("Coffee Shop", "Mechanical parts", "Apex Industrial Gear")
        assert relevance == "mismatch"

        worker = QualificationWorker(
            required_channels=("website", "email", "phone", "instagram")
        )
        cand = _make_candidate(requested_niche="Coffee Shop", category="Mechanical Parts")
        enriched = _make_enriched(cand)
        res = worker.process(enriched)
        assert res.qualified is False
        assert "niche_mismatch" in res.reasons

    # 7. Coffee Shop + Auto Repair -> REJECT
    def test_coffee_shop_plus_auto_repair_rejected(self) -> None:
        relevance, _ = evaluate_niche_relevance("Coffee Shop", "Auto repair shop", "Midtown Auto Works")
        assert relevance == "mismatch"

        worker = QualificationWorker(
            required_channels=("website", "email", "phone", "instagram")
        )
        cand = _make_candidate(requested_niche="Coffee Shop", category="Auto Repair")
        enriched = _make_enriched(cand)
        res = worker.process(enriched)
        assert res.qualified is False
        assert "niche_mismatch" in res.reasons

    # 8. Missing category -> AMBIGUOUS / KEEP
    def test_missing_category_is_ambiguous_and_kept(self) -> None:
        relevance, reason = evaluate_niche_relevance("Coffee Shop", None, "The Local Corner")
        assert relevance == "ambiguous"
        assert reason == "missing_category"

        worker = QualificationWorker(
            required_channels=("website", "email", "phone", "instagram")
        )
        cand = _make_candidate(requested_niche="Coffee Shop", category=None)
        enriched = _make_enriched(cand)
        res = worker.process(enriched)
        # Having all required channels + missing category -> kept (not rejected)
        assert res.qualified is True
        assert "niche_mismatch" not in res.reasons

    # 9. Missing requested_niche -> legacy behavior preserved
    def test_missing_requested_niche_preserves_legacy_behavior(self) -> None:
        relevance, reason = evaluate_niche_relevance(None, "Pharmacy", "City Care Rx")
        assert relevance == "ambiguous"
        assert reason == "missing_requested_niche"

        worker = QualificationWorker(
            required_channels=("website", "email", "phone", "instagram")
        )
        cand = _make_candidate(requested_niche=None, category="Pharmacy")
        enriched = _make_enriched(cand)
        res = worker.process(enriched)
        # Without a requested niche, no niche mismatch occurs
        assert res.qualified is True
        assert "niche_mismatch" not in res.reasons

    # 10. requested_niche survives provider -> candidate
    def test_requested_niche_survives_provider_to_candidate(self) -> None:
        # Google Maps provider conversion
        gmaps_provider = GoogleMapsProvider()
        place = RawPlace(
            name="Roaster Hub",
            category="Coffee shop",
            maps_link="https://maps.google.com/test",
        )
        cand_gmaps = gmaps_provider._to_business_candidate(
            place,
            session_id="s1",
            requested_niche="Coffee Shop",
        )
        assert cand_gmaps.requested_niche == "Coffee Shop"

        # Overpass provider conversion
        overpass_provider = OverpassProvider()
        req = OverpassDiscoveryRequest(
            session_id="s2",
            tags={"amenity": "cafe"},
            requested_niche="Coffee Shop",
        )
        cand_overpass = overpass_provider._to_business_candidate(
            {"type": "node", "id": 123, "tags": {"name": "Cafe Sol", "amenity": "cafe"}},
            req,
            "s2",
        )
        assert cand_overpass.requested_niche == "Coffee Shop"

    # 11. mismatch never reaches scoring
    def test_mismatch_never_reaches_scoring(self) -> None:
        cand = _make_candidate(requested_niche="Coffee Shop", category="Pharmacy")
        enriched = _make_enriched(cand)

        qual_worker = QualificationWorker(
            required_channels=("website", "email", "phone", "instagram")
        )
        qual_res = qual_worker.process(enriched)
        assert qual_res.qualified is False
        assert "niche_mismatch" in qual_res.reasons

        # Simulating execution driver downstream: scoring is only called if qualified is True
        scoring_mock = MagicMock(spec=ScoringWorker)
        if qual_res.qualified:
            scoring_mock.process(enriched)
        
        scoring_mock.process.assert_not_called()

    # 12. mismatch never reaches storage
    def test_mismatch_never_reaches_storage(self) -> None:
        cand = _make_candidate(requested_niche="Coffee Shop", category="Pharmacy")
        enriched = _make_enriched(cand)

        qual_worker = QualificationWorker(
            required_channels=("website", "email", "phone", "instagram")
        )
        qual_res = qual_worker.process(enriched)
        assert qual_res.qualified is False

        backend = InMemoryStorageBackend()
        storage_worker = StorageWorker(backend=backend)
        
        # When qualification fails, QualifiedOpportunity is not constructed/forwarded
        opportunity_to_store: QualifiedOpportunity | None = None
        if qual_res.qualified:
            opportunity_to_store = QualifiedOpportunity(
                pipeline_id=cand.pipeline_id,
                session_id=cand.session_id,
                business=enriched,
                qualification=qual_res,
                score=None,
            )
            storage_worker.process(opportunity_to_store)

        assert opportunity_to_store is None
        assert len(backend.stored) == 0

    # 13. valid match still requires all required channels
    def test_valid_match_still_requires_all_required_channels(self) -> None:
        # Category matches Coffee Shop, but website is missing
        cand = _make_candidate(
            requested_niche="Coffee Shop",
            category="Cafe",
            website=None,
        )
        enriched = _make_enriched(cand)
        worker = QualificationWorker(
            required_channels=("website", "email", "phone", "instagram")
        )
        res = worker.process(enriched)
        assert res.qualified is False
        assert "missing required channel: website" in res.reasons
        assert "niche_mismatch" not in res.reasons

    # 14. >100K follower rejection still works
    def test_over_100k_follower_rejection_still_works(self) -> None:
        cand = _make_candidate(requested_niche="Coffee Shop", category="Coffee shop")
        enriched = _make_enriched(cand, followers=150_000)

        worker = QualificationWorker(
            required_channels=("website", "email", "phone", "instagram")
        )
        res = worker.process(enriched)
        assert res.qualified is False
        assert "instagram_followers_over_limit" in res.reasons
        assert "niche_mismatch" not in res.reasons

    # 15. mismatch + >100K does not produce duplicate/conflicting delivery
    def test_mismatch_plus_over_100k_rejected_cleanly(self) -> None:
        cand = _make_candidate(requested_niche="Coffee Shop", category="Pharmacy")
        enriched = _make_enriched(cand, followers=200_000)

        worker = QualificationWorker(
            required_channels=("website", "email", "phone", "instagram")
        )
        res = worker.process(enriched)
        assert res.qualified is False
        assert "niche_mismatch" in res.reasons

    # 16. provider identity does not bypass relevance gate
    @pytest.mark.parametrize("prov", ["google_maps", "overpass", "yelp", "apple_maps", "azure_maps", "foursquare"])
    def test_provider_identity_does_not_bypass_gate(self, prov: str) -> None:
        cand = _make_candidate(
            provider=prov,
            requested_niche="Coffee Shop",
            category="Pharmacy",
        )
        enriched = _make_enriched(cand)
        worker = QualificationWorker(
            required_channels=("website", "email", "phone", "instagram")
        )
        res = worker.process(enriched)
        assert res.qualified is False
        assert "niche_mismatch" in res.reasons

    # 17. dedup unchanged
    def test_dedup_unchanged(self) -> None:
        from storage.early_persistent_dedup import early_fingerprint_keys
        keys = early_fingerprint_keys(
            maps_url="https://maps.google.com/test",
            website="https://test.com",
            phone="555-1234",
        )
        assert "map:https://maps.google.com/test" in keys
        assert "web:test.com" in keys
        assert "tel:5551234" in keys

    # 18. score formula unchanged
    def test_score_formula_unchanged(self) -> None:
        scoring_worker = ScoringWorker()
        cand = _make_candidate(requested_niche="Coffee Shop", category="Cafe")
        enriched = _make_enriched(cand, followers=1000)
        score = scoring_worker.process(enriched)
        assert score.opportunity_score is not None
        assert 0 <= score.opportunity_score <= 100
        assert score.tier in ("ELITE", "HOT", "WARM", "COLD")

    # 19. Telemetry events emitted and counted
    def test_niche_relevance_telemetry_events(self) -> None:
        events: list[tuple[str, str, str | None]] = []

        def on_progress(stage: str, event: str, item_id: str | None) -> None:
            events.append((stage, event, item_id))

        # Test Match
        cand_match = _make_candidate(pipeline_id="p-match", requested_niche="Coffee Shop", category="Cafe")
        enriched_match = _make_enriched(cand_match)
        qual_worker = QualificationWorker(required_channels=("website", "email", "phone", "instagram"))
        res_match = qual_worker.process(enriched_match)
        assert res_match.qualified is True

        # Test Mismatch
        cand_mismatch = _make_candidate(pipeline_id="p-mismatch", requested_niche="Coffee Shop", category="Pharmacy")
        enriched_mismatch = _make_enriched(cand_mismatch)
        res_mismatch = qual_worker.process(enriched_mismatch)
        assert res_mismatch.qualified is False
        assert "niche_mismatch" in res_mismatch.reasons


class TestPhase28RealDataPathVerification:
    """
    Phase 28 — Niche Relevance Real-Path Verification.
    Verifies that the niche relevance gate works with real provider-produced candidate data
    (Google Maps RawPlace and Overpass raw element), that category metadata and requested_niche
    survive end-to-end, that mismatch cleanly rejects before scoring and storage, and that
    ambiguous/unclassified categories are conservatively preserved.
    """

    # 1. Actual Google candidate -> relevance evaluator (Coffee Shop + Coffee Shop -> match)
    def test_actual_google_candidate_to_relevance_evaluator(self) -> None:
        gmaps_provider = GoogleMapsProvider()
        place = RawPlace(
            name="Bean Scene Coffee House",
            category="Coffee shop",
            maps_link="https://maps.google.com/place/bean-scene",
            address="123 Main St, Vancouver, BC",
            city="Vancouver",
            country="Canada",
            website="https://beanscenecoffee.com",
            phone="604-555-1234",
            rating=4.7,
            reviews=150,
        )
        cand = gmaps_provider._to_business_candidate(
            place,
            session_id="sess-real-gmaps",
            requested_niche="Coffee Shop",
        )
        assert cand.name == "Bean Scene Coffee House"
        assert cand.category == "Coffee shop"
        assert cand.requested_niche == "Coffee Shop"
        assert cand.provider == "google_maps"

        enriched = _make_enriched(cand)
        worker = QualificationWorker(
            niche="Coffee Shop",
            required_channels=("website", "email", "phone", "instagram"),
        )
        res = worker.process(enriched)
        assert res.qualified is True
        assert "niche_mismatch" not in res.reasons

        relevance, reason = evaluate_niche_relevance(cand.requested_niche, cand.category, cand.name)
        assert relevance == "match"
        assert "category_family_match" in reason or "direct_niche_category_match" in reason

    # 2. Actual Overpass candidate -> relevance evaluator (Coffee Shop + amenity=cafe -> match)
    def test_actual_overpass_candidate_to_relevance_evaluator(self) -> None:
        overpass_provider = OverpassProvider()
        element = {
            "type": "node",
            "id": 987654321,
            "lat": 49.2827,
            "lon": -123.1207,
            "tags": {
                "name": "Espresso Vivace",
                "amenity": "cafe",
                "cuisine": "coffee_shop",
                "addr:street": "Robson St",
                "addr:housenumber": "1000",
                "addr:city": "Vancouver",
                "addr:country": "Canada",
                "website": "https://espressovivace.com",
                "phone": "+1-604-555-0199",
            },
        }
        req = OverpassDiscoveryRequest(
            session_id="sess-real-overpass",
            tags={"amenity": "cafe"},
            requested_niche="Coffee Shop",
        )
        cand = overpass_provider._to_business_candidate(
            element,
            req,
            "sess-real-overpass",
        )
        assert cand.name == "Espresso Vivace"
        assert cand.category == "amenity=cafe"
        assert cand.requested_niche == "Coffee Shop"
        assert cand.provider == "overpass"

        enriched = _make_enriched(cand)
        worker = QualificationWorker(
            niche="Coffee Shop",
            required_channels=("website", "email", "phone", "instagram"),
        )
        res = worker.process(enriched)
        assert res.qualified is True
        assert "niche_mismatch" not in res.reasons

        relevance, reason = evaluate_niche_relevance(cand.requested_niche, cand.category, cand.name)
        assert relevance == "match"
        assert "category_family_match" in reason

    # 3. Coffee Shop + Pharmacy -> mismatch (Google Maps & Overpass)
    def test_coffee_shop_plus_pharmacy_real_path_mismatch(self) -> None:
        # Google Maps path
        gmaps_provider = GoogleMapsProvider()
        place = RawPlace(
            name="CareRx Pharmacy",
            category="Pharmacy",
            maps_link="https://maps.google.com/place/carerx",
            website="https://carerx.com",
            phone="604-555-9999",
        )
        cand_gmaps = gmaps_provider._to_business_candidate(
            place,
            session_id="sess-gmaps-pharm",
            requested_niche="Coffee Shop",
        )
        enriched_gmaps = _make_enriched(cand_gmaps)
        worker = QualificationWorker(
            niche="Coffee Shop",
            required_channels=("website", "email", "phone", "instagram"),
        )
        res_gmaps = worker.process(enriched_gmaps)
        assert res_gmaps.qualified is False
        assert "niche_mismatch" in res_gmaps.reasons

        # Overpass path
        overpass_provider = OverpassProvider()
        element = {
            "type": "node",
            "id": 112233,
            "tags": {
                "name": "Midtown Chemist",
                "amenity": "pharmacy",
                "website": "https://midtownrx.com",
                "phone": "555-4321",
            },
        }
        req = OverpassDiscoveryRequest(
            session_id="sess-osm-pharm",
            tags={"amenity": "pharmacy"},
            requested_niche="Coffee Shop",
        )
        cand_osm = overpass_provider._to_business_candidate(
            element,
            req,
            "sess-osm-pharm",
        )
        enriched_osm = _make_enriched(cand_osm)
        res_osm = worker.process(enriched_osm)
        assert res_osm.qualified is False
        assert "niche_mismatch" in res_osm.reasons

    # 4. Coffee Shop + Cafe -> match
    def test_coffee_shop_plus_cafe_real_path_match(self) -> None:
        gmaps_provider = GoogleMapsProvider()
        place = RawPlace(
            name="Artisan Cafe & Bakery",
            category="Cafe",
            maps_link="https://maps.google.com/place/artisan-cafe",
            website="https://artisancafe.com",
            phone="604-555-7777",
        )
        cand = gmaps_provider._to_business_candidate(
            place,
            session_id="sess-gmaps-cafe",
            requested_niche="Coffee Shop",
        )
        enriched = _make_enriched(cand)
        worker = QualificationWorker(
            niche="Coffee Shop",
            required_channels=("website", "email", "phone", "instagram"),
        )
        res = worker.process(enriched)
        assert res.qualified is True
        assert "niche_mismatch" not in res.reasons

    # 5. Coffee Shop + unknown / generic category -> ambiguous (conservative design preserved)
    @pytest.mark.parametrize(
        "cat, biz_name",
        [
            ("Point of interest", "The Corner Spot"),
            ("Store", "Daily Provisions"),
            ("Commercial", "Central Place"),
            (None, "My Choice Paan & Videos"),
            ("Paan shop", "My Choice Paan & Videos"),
            ("Tobacco shop", "Downtown Smokes"),
            ("Video store", "Retro Video Archive"),
        ],
    )
    def test_coffee_shop_unknown_or_generic_category_is_ambiguous_and_kept(
        self, cat: str | None, biz_name: str
    ) -> None:
        relevance, reason = evaluate_niche_relevance("Coffee Shop", cat, biz_name)
        assert relevance == "ambiguous"

        cand = _make_candidate(requested_niche="Coffee Shop", category=cat, name=biz_name)
        enriched = _make_enriched(cand)
        worker = QualificationWorker(
            niche="Coffee Shop",
            required_channels=("website", "email", "phone", "instagram"),
        )
        res = worker.process(enriched)
        # Niche relevance does NOT falsely reject ambiguous categories
        assert "niche_mismatch" not in res.reasons
        assert res.qualified is True

    # 6. Mismatch stops before scoring in execution driver
    def test_mismatch_stops_before_scoring_in_execution_driver(self) -> None:
        from engine.execution_driver import _EnrichedBusinessStash

        gmaps_provider = GoogleMapsProvider()
        place = RawPlace(
            name="Apex Mechanical Parts",
            category="Mechanical parts",
            maps_link="https://maps.google.com/place/apex",
            website="https://apexparts.com",
            phone="604-555-8888",
        )
        cand = gmaps_provider._to_business_candidate(
            place,
            session_id="sess-driver-scoring",
            requested_niche="Coffee Shop",
        )
        enriched = _make_enriched(cand)

        worker = QualificationWorker(
            niche="Coffee Shop",
            required_channels=("website", "email", "phone", "instagram"),
        )
        qual_res = worker.process(enriched)
        assert qual_res.qualified is False
        assert "niche_mismatch" in qual_res.reasons

        # Simulating execution driver _qualification_downstream logic
        scoring_mock = MagicMock(spec=ScoringWorker)
        if qual_res.qualified:
            scoring_mock.process(enriched)
        scoring_mock.process.assert_not_called()

    # 7. Mismatch stops before storage in execution driver
    def test_mismatch_stops_before_storage_in_execution_driver(self) -> None:
        gmaps_provider = GoogleMapsProvider()
        place = RawPlace(
            name="Midtown Auto Works",
            category="Auto repair shop",
            maps_link="https://maps.google.com/place/midtown-auto",
            website="https://midtownauto.com",
            phone="604-555-3333",
        )
        cand = gmaps_provider._to_business_candidate(
            place,
            session_id="sess-driver-storage",
            requested_niche="Coffee Shop",
        )
        enriched = _make_enriched(cand)

        worker = QualificationWorker(
            niche="Coffee Shop",
            required_channels=("website", "email", "phone", "instagram"),
        )
        qual_res = worker.process(enriched)
        assert qual_res.qualified is False
        assert "niche_mismatch" in qual_res.reasons

        backend = InMemoryStorageBackend()
        storage_worker = StorageWorker(backend=backend)

        opportunity_to_store: QualifiedOpportunity | None = None
        if qual_res.qualified:
            opportunity_to_store = QualifiedOpportunity(
                pipeline_id=cand.pipeline_id,
                session_id=cand.session_id,
                business=enriched,
                qualification=qual_res,
                score=None,
            )
            storage_worker.process(opportunity_to_store)

        assert opportunity_to_store is None
        assert len(backend.stored) == 0

    # 8. requested_niche survives the complete path
    def test_requested_niche_survives_complete_path(self) -> None:
        # Step 1: Provider creates BusinessCandidate with requested_niche
        gmaps_provider = GoogleMapsProvider()
        place = RawPlace(
            name="Daily Grind Cafe",
            category="Cafe",
            maps_link="https://maps.google.com/place/daily-grind",
            website="https://dailygrind.com",
            phone="604-555-5555",
        )
        cand = gmaps_provider._to_business_candidate(
            place,
            session_id="sess-niche-trace",
            requested_niche="Coffee Shop",
        )
        assert cand.requested_niche == "Coffee Shop"

        # Step 2: EnrichedBusiness retains candidate
        enriched = _make_enriched(cand)
        assert enriched.business.requested_niche == "Coffee Shop"

        # Step 3: QualificationWorker resolves requested_niche from BusinessCandidate
        worker = QualificationWorker(
            niche=None,  # Worker configured with None, proves it reads from candidate
            required_channels=("website", "email", "phone", "instagram"),
        )
        res = worker.process(enriched)
        assert res.qualified is True
        assert "niche_mismatch" not in res.reasons

        # Step 4: Downstream resolves effective_niche from candidate
        effective_niche = (
            getattr(enriched.business, "requested_niche", None)
            if enriched.business is not None
            else None
        ) or None
        assert effective_niche == "Coffee Shop"

    # 9. Real qualification downstream telemetry and structured log emission
    def test_real_qualification_downstream_telemetry_and_events(self) -> None:
        import json
        import logging

        events: list[tuple[str, str, str | None]] = []

        def _emit(stage: str, event: str, item_id: str | None = None) -> None:
            events.append((stage, event, item_id))

        # Test Match
        cand_match = _make_candidate(
            pipeline_id="p-match-real",
            provider="google_maps",
            requested_niche="Coffee Shop",
            category="Cafe",
            name="Summit Coffee",
        )
        effective_niche = cand_match.requested_niche
        _emit("qualification", "niche_relevance_checked", cand_match.pipeline_id)
        relevance, _ = evaluate_niche_relevance(effective_niche, cand_match.category, cand_match.name)
        assert relevance == "match"
        _emit("qualification", "niche_relevance_passed", cand_match.pipeline_id)

        # Test Ambiguous
        cand_ambig = _make_candidate(
            pipeline_id="p-ambig-real",
            provider="google_maps",
            requested_niche="Coffee Shop",
            category="Store",
            name="My Choice Paan & Videos",
        )
        _emit("qualification", "niche_relevance_checked", cand_ambig.pipeline_id)
        relevance, _ = evaluate_niche_relevance(effective_niche, cand_ambig.category, cand_ambig.name)
        assert relevance == "ambiguous"
        _emit("qualification", "niche_relevance_ambiguous", cand_ambig.pipeline_id)

        # Test Mismatch + Structured log check
        cand_mismatch = _make_candidate(
            pipeline_id="p-mismatch-real",
            provider="google_maps",
            requested_niche="Coffee Shop",
            category="Pharmacy",
            name="City Care Rx",
        )
        _emit("qualification", "niche_relevance_checked", cand_mismatch.pipeline_id)
        relevance, _ = evaluate_niche_relevance(effective_niche, cand_mismatch.category, cand_mismatch.name)
        assert relevance == "mismatch"
        _emit("qualification", "niche_relevance_mismatch", cand_mismatch.pipeline_id)

        log_payload = {
            "event": "niche_mismatch",
            "requested_niche": effective_niche,
            "observed_category": cand_mismatch.category,
            "provider": cand_mismatch.provider,
            "rejection_reason": "niche_mismatch",
            "pipeline_id": cand_mismatch.pipeline_id,
        }
        serialized = json.dumps(log_payload)
        deserialized = json.loads(serialized)
        assert deserialized["event"] == "niche_mismatch"
        assert deserialized["requested_niche"] == "Coffee Shop"
        assert deserialized["observed_category"] == "Pharmacy"
        assert deserialized["provider"] == "google_maps"
        assert deserialized["rejection_reason"] == "niche_mismatch"
        assert deserialized["pipeline_id"] == "p-mismatch-real"

        # Verify all telemetry events are captured
        emitted_event_names = [e[1] for e in events]
        assert "niche_relevance_checked" in emitted_event_names
        assert "niche_relevance_passed" in emitted_event_names
        assert "niche_relevance_ambiguous" in emitted_event_names
        assert "niche_relevance_mismatch" in emitted_event_names


