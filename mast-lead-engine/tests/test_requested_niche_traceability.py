"""
tests/test_requested_niche_traceability.py
===========================================

Regression test suite verifying requested_niche traceability:

1. BusinessCandidate.requested_niche defaults to None for backward compatibility.
2. OverpassDiscoveryRequest.requested_niche defaults to None.
3. translate_request for overpass sets requested_niche from context.niche.
4. OverpassProvider._to_business_candidate threads requested_niche to BusinessCandidate.
5. GoogleMapsProvider._to_business_candidate threads requested_niche to BusinessCandidate.
6. "Coffee Shop" request produces requested_niche="Coffee Shop" on candidate.
7. Area remains preserved alongside requested_niche.
8. Legacy callers with empty or unset niche get requested_niche=None.
"""

from __future__ import annotations

import pytest

from engine.contracts import BusinessCandidate
from providers.google_maps_provider import GoogleMapsDiscoveryRequest, GoogleMapsProvider
from providers.overpass_provider import OverpassDiscoveryRequest, OverpassProvider
from providers.provider_request_translation import DiscoveryQueryContext, translate_request
from scraper.maps_scraper import RawPlace


class TestRequestedNicheTraceability:
    def test_business_candidate_default_requested_niche_none(self) -> None:
        cand = BusinessCandidate(
            pipeline_id="p1",
            session_id="s1",
            provider="test_provider",
        )
        assert cand.requested_niche is None

    def test_overpass_discovery_request_default_requested_niche_none(self) -> None:
        req = OverpassDiscoveryRequest(
            session_id="s1",
            tags={"amenity": "cafe"},
        )
        assert req.requested_niche is None

    def test_translate_overpass_sets_requested_niche_and_preserves_area(self) -> None:
        ctx = DiscoveryQueryContext(
            session_id="sess-coffee-123",
            query="Coffee Shop in Brooklyn",
            city="New York",
            niche="Coffee Shop",
            area="Brooklyn",
        )
        req = translate_request("overpass", ctx)
        assert isinstance(req, OverpassDiscoveryRequest)
        assert req.requested_niche == "Coffee Shop"
        assert req.area == "Brooklyn"
        assert req.area_name == "Brooklyn"
        assert req.city == "New York"
        assert req.tags == {"amenity": "cafe"}

    def test_translate_overpass_legacy_no_niche_compatible(self) -> None:
        # Caller supplies explicit osm_tags and no niche
        ctx = DiscoveryQueryContext(
            session_id="sess-legacy-1",
            query="Cafe",
            city="Boston",
            niche="",
            osm_tags={"amenity": "cafe"},
        )
        req = translate_request("overpass", ctx)
        assert isinstance(req, OverpassDiscoveryRequest)
        assert req.requested_niche is None

    def test_overpass_candidate_construction_receives_requested_niche(self) -> None:
        provider = OverpassProvider()
        req = OverpassDiscoveryRequest(
            session_id="sess-op-1",
            tags={"amenity": "cafe"},
            requested_niche="Coffee Shop",
        )
        element = {
            "type": "node",
            "id": 123456,
            "lat": 40.7128,
            "lon": -74.0060,
            "tags": {
                "name": "Artisan Coffee",
                "amenity": "cafe",
                "addr:city": "New York",
            },
        }
        cand = provider._to_business_candidate(element, req, "sess-op-1")
        assert cand.name == "Artisan Coffee"
        assert cand.requested_niche == "Coffee Shop"
        assert cand.provider == "overpass"

    def test_overpass_candidate_construction_legacy_no_niche(self) -> None:
        provider = OverpassProvider()
        req = OverpassDiscoveryRequest(
            session_id="sess-op-legacy",
            tags={"amenity": "cafe"},
        )
        element = {
            "type": "node",
            "id": 789,
            "tags": {"name": "Old Cafe", "amenity": "cafe"},
        }
        cand = provider._to_business_candidate(element, req, "sess-op-legacy")
        assert cand.requested_niche is None

    def test_google_maps_candidate_construction_receives_requested_niche(self) -> None:
        provider = GoogleMapsProvider()
        place = RawPlace(
            name="Roast & Brew",
            category="Coffee shop",
            city="The Bronx",
            maps_link="https://maps.google.com/test",
        )
        cand = provider._to_business_candidate(
            place,
            session_id="sess-gmaps-1",
            requested_niche="Coffee Shop",
        )
        assert cand.name == "Roast & Brew"
        assert cand.city == "The Bronx"
        assert cand.requested_niche == "Coffee Shop"
        assert cand.provider == "google_maps"

    def test_google_maps_candidate_construction_legacy_no_niche(self) -> None:
        provider = GoogleMapsProvider()
        place = RawPlace(
            name="Generic Shop",
            category="Shop",
        )
        # 2-arg legacy call
        cand = provider._to_business_candidate(place, "sess-gmaps-legacy")
        assert cand.requested_niche is None
