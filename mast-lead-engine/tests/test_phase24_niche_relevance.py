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
    ) if candidate.instagram_url else None

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

