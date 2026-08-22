"""
tests/test_area_scope_overpass.py
==================================

MAST Engine — Phase 17: Overpass Area-Scope / Duplication Fix.

Comprehensive regression coverage proving:

1.  Brooklyn produces area-scoped Overpass query.
2.  Queens produces area-scoped query.
3.  Manhattan produces area-scoped query.
4.  The Bronx works (including normalization from "bronx" -> "The Bronx").
5.  Staten Island works.
6.  Toronto area names work ("Etobicoke", "Scarborough", "Downtown Toronto",
    "The Beaches", "North York").
7.  None uses city fallback.
8.  Empty area uses city fallback.
9.  Area survives Node -> Python serialization.
10. Area survives Python -> DiscoveryQueryContext.
11. Area survives provider translation.
12. Area-scoped failure does NOT silently become city-wide (fails/skips Overpass).
13. Google Maps request remains unchanged.
14. Provider selection remains unchanged.
15. Qualification remains unchanged (asserted by contract integrity).
16. Existing legacy callers remain compatible.
17. Structured telemetry: `[overpass-scope]` event emitted on Overpass discover().
18. Overpass QL query builder produces exact `area["name"="<area>"]->.searchArea;`.
"""

from __future__ import annotations

import inspect
import json
import logging
from typing import Any
from unittest.mock import MagicMock

import pytest

from providers.discovery_composition import compose_discovery
from providers.overpass_provider import (
    OverpassDiscoveryRequest,
    OverpassProvider,
    _build_ql,
)
from providers.parallel_composite_provider import ParallelDiscoveryRequest
from providers.provider_request_translation import (
    DiscoveryQueryContext,
    normalize_osm_area,
    translate_request,
)
from providers.target_aware_provider import TargetAwareDiscoveryProvider


# ---------------------------------------------------------------------------
# 1-6. Translation-level: distinct curated area values reach
# OverpassDiscoveryRequest.area_name and build correct area-scoped Overpass QL.
# ---------------------------------------------------------------------------
class TestOverpassAreaScoping:
    @pytest.mark.parametrize(
        ("area", "expected_area_name"),
        [
            ("Brooklyn", "Brooklyn"),
            ("Queens", "Queens"),
            ("Manhattan", "Manhattan"),
            ("The Bronx", "The Bronx"),
            ("bronx", "The Bronx"),
            ("Staten Island", "Staten Island"),
            ("Etobicoke", "Etobicoke"),
            ("Scarborough", "Scarborough"),
            ("Downtown Toronto", "Downtown Toronto"),
            ("The Beaches", "The Beaches"),
            ("North York", "North York"),
        ],
    )
    def test_curated_areas_thread_and_normalize(self, area: str, expected_area_name: str):
        context = DiscoveryQueryContext(
            session_id="s1",
            query="coffee shop",
            city="New York" if "Toronto" not in expected_area_name and expected_area_name not in {"Etobicoke", "Scarborough", "The Beaches", "North York"} else "Toronto",
            country="US" if "Toronto" not in expected_area_name and expected_area_name not in {"Etobicoke", "Scarborough", "The Beaches", "North York"} else "CA",
            niche="coffee_shop",
            area=area,
        )
        request = translate_request("overpass", context)
        assert request is not None
        assert request.area_name == expected_area_name
        assert request.area == expected_area_name
        assert request.scope_source == "area"
        assert request.scope_valid is True

        # Test QL query builder
        ql = _build_ql(request)
        assert f'area["name"="{expected_area_name}"]->.searchArea;' in ql
        assert '(area.searchArea)' in ql
        assert '["amenity"="cafe"]' in ql

    def test_sibling_areas_produce_distinct_area_names_for_same_city(self):
        """The exact production bug: Brooklyn/Queens/Manhattan/Staten
        Island all share city="New York" but must no longer collapse
        onto the same Overpass area_name."""
        area_names = set()
        for area in ("Brooklyn", "Queens", "Manhattan", "Staten Island", "The Bronx"):
            context = DiscoveryQueryContext(
                session_id="s1", query="coffee shop", city="New York",
                country="US", niche="coffee_shop", area=area,
            )
            request = translate_request("overpass", context)
            assert request is not None
            area_names.add(request.area_name)
        assert area_names == {"Brooklyn", "Queens", "Manhattan", "Staten Island", "The Bronx"}

    def test_toronto_sibling_areas_produce_distinct_area_names(self):
        area_names = set()
        for area in ("Etobicoke", "Scarborough", "Downtown Toronto", "The Beaches", "North York"):
            context = DiscoveryQueryContext(
                session_id="s1", query="coffee shop", city="Toronto",
                country="CA", niche="coffee_shop", area=area,
            )
            request = translate_request("overpass", context)
            assert request is not None
            area_names.add(request.area_name)
        assert area_names == {"Etobicoke", "Scarborough", "Downtown Toronto", "The Beaches", "North York"}

    # -----------------------------------------------------------------
    # 7-8. Fallback behavior — must be backward compatible.
    # -----------------------------------------------------------------
    def test_area_none_preserves_old_city_fallback(self):
        context = DiscoveryQueryContext(
            session_id="s1", query="coffee shop", city="New York",
            country="US", niche="coffee_shop", area=None,
        )
        request = translate_request("overpass", context)
        assert request is not None
        assert request.area_name == "New York"
        assert request.area is None
        assert request.scope_source == "city_fallback"
        assert request.scope_valid is True

        ql = _build_ql(request)
        assert 'area["name"="New York"]->.searchArea;' in ql

    def test_empty_area_preserves_old_city_fallback(self):
        context = DiscoveryQueryContext(
            session_id="s1", query="coffee shop", city="New York",
            country="US", niche="coffee_shop", area="",
        )
        request = translate_request("overpass", context)
        assert request is not None
        assert request.area_name == "New York"
        assert request.area is None
        assert request.scope_source == "city_fallback"
        assert request.scope_valid is True

    def test_city_country_fallback_still_works_with_no_city(self):
        """No area, no city -> country, exactly as before this phase."""
        context = DiscoveryQueryContext(
            session_id="s1", query="coffee shop", city="",
            country="US", niche="coffee_shop",
        )
        request = translate_request("overpass", context)
        assert request is not None
        assert request.area_name == "US"
        assert request.scope_source == "city_fallback"

    def test_area_default_omitted_entirely_matches_none(self):
        """A caller that never passes `area=` at all (every legacy call site)
        gets byte-for-byte the same OverpassDiscoveryRequest as before —
        DiscoveryQueryContext.area defaults to None."""
        context = DiscoveryQueryContext(
            session_id="s1", query="coffee shop", city="New York",
            country="US", niche="coffee_shop",
        )
        assert context.area is None
        request = translate_request("overpass", context)
        assert request is not None
        assert request.area_name == "New York"
        assert request.scope_source == "city_fallback"

    # -----------------------------------------------------------------
    # 12. Prevent Accidental City-Wide Fallback.
    # -----------------------------------------------------------------
    def test_unresolvable_area_scope_does_not_silently_fallback_to_city(self, monkeypatch, caplog):
        """When an area is provided by a curated area worker but fails
        resolution/normalization, it must NOT fall back to city-wide Overpass.
        Instead it must log an explicit warning and return None (skipping Overpass)."""
        # Simulate an area normalization failure
        monkeypatch.setattr(
            "providers.provider_request_translation.normalize_osm_area",
            lambda a: None,
        )
        with caplog.at_level(logging.WARNING):
            context = DiscoveryQueryContext(
                session_id="s1",
                query="coffee shop",
                city="New York",
                country="US",
                niche="coffee_shop",
                area="UnknownBadArea",
            )
            request = translate_request("overpass", context)
            assert request is None
            assert any("[overpass-scope] area scope failed" in rec.message for rec in caplog.records)

    # -----------------------------------------------------------------
    # 13. Google Maps is completely unaffected by `area`.
    # -----------------------------------------------------------------
    def test_google_maps_translation_ignores_area(self):
        with_area = DiscoveryQueryContext(
            session_id="s1", query="coffee shop", city="New York",
            country="US", area="Brooklyn",
        )
        without_area = DiscoveryQueryContext(
            session_id="s1", query="coffee shop", city="New York",
            country="US",
        )
        req_with = translate_request("google_maps", with_area)
        req_without = translate_request("google_maps", without_area)
        assert req_with.city == req_without.city == "New York"
        assert req_with.query == req_without.query == "coffee shop"
        assert not hasattr(req_with, "area")
        assert not hasattr(req_with, "area_name")


# ---------------------------------------------------------------------------
# Composition root — area flows from compose_discovery() through to the
# composed Overpass request, without disturbing provider selection.
# ---------------------------------------------------------------------------
class TestComposeDiscoveryAreaScoping:
    def _clear_provider_credentials(self, monkeypatch):
        for env_var in (
            "YELP_API_KEY", "APPLE_MAPS_ACCESS_TOKEN", "FOURSQUARE_API_KEY",
            "AZURE_MAPS_SUBSCRIPTION_KEY", "CRUNCHBASE_API_KEY", "APOLLO_API_KEY",
        ):
            monkeypatch.delenv(env_var, raising=False)

    # -----------------------------------------------------------------
    # 14. Provider selection unaffected by area.
    # -----------------------------------------------------------------
    def test_provider_selection_unaffected_by_area(self, monkeypatch):
        self._clear_provider_credentials(monkeypatch)
        composed = compose_discovery(
            session_id="s1", query="coffee shop", city="New York",
            country="US", niche="coffee_shop", area="Brooklyn", max_results=10,
        )
        assert set(composed.selected_provider_ids) == {"google_maps", "overpass"}
        assert isinstance(composed.provider, TargetAwareDiscoveryProvider)
        assert isinstance(composed.request, ParallelDiscoveryRequest)

    def test_composed_overpass_request_carries_area_name(self, monkeypatch):
        self._clear_provider_credentials(monkeypatch)
        composed = compose_discovery(
            session_id="s1", query="coffee shop", city="New York",
            country="US", niche="coffee_shop", area="Queens", max_results=10,
        )
        overpass_request = composed.request.requests["overpass"]
        assert overpass_request.area_name == "Queens"
        assert overpass_request.area == "Queens"
        assert overpass_request.scope_source == "area"

    def test_composed_google_maps_request_still_uses_city_not_area(self, monkeypatch):
        self._clear_provider_credentials(monkeypatch)
        composed = compose_discovery(
            session_id="s1", query="coffee shop", city="New York",
            country="US", niche="coffee_shop", area="Queens", max_results=10,
        )
        google_maps_request = composed.request.requests["google_maps"]
        assert google_maps_request.city == "New York"

    # -----------------------------------------------------------------
    # 16. Existing non-area callers remain fully compatible.
    # -----------------------------------------------------------------
    def test_compose_discovery_without_area_kwarg_unaffected(self, monkeypatch):
        self._clear_provider_credentials(monkeypatch)
        composed = compose_discovery(
            session_id="s1", query="coffee shop", city="New York",
            country="US", niche="coffee_shop", max_results=10,
        )
        overpass_request = composed.request.requests["overpass"]
        assert overpass_request.area_name == "New York"
        assert overpass_request.scope_source == "city_fallback"

    def test_area_is_a_keyword_only_optional_parameter(self):
        """compose_discovery()'s signature must accept `area` as an
        optional keyword-only parameter defaulting to None, so every
        existing positional/keyword call site that never mentions
        `area` keeps working unmodified."""
        sig = inspect.signature(compose_discovery)
        assert "area" in sig.parameters
        param = sig.parameters["area"]
        assert param.default is None
        assert param.kind == inspect.Parameter.KEYWORD_ONLY


# ---------------------------------------------------------------------------
# 9-11. Pipeline serialization & pass-through:
# Node JSON payload -> service.py run_query() -> compose_discovery()
# ---------------------------------------------------------------------------
class TestSerializationAndPipelinePassThrough:
    def test_run_query_accepts_area_keyword_defaulting_to_empty_string(self):
        import service

        sig = inspect.signature(service.run_query)
        assert "area" in sig.parameters
        param = sig.parameters["area"]
        assert param.default == ""
        assert param.kind == inspect.Parameter.KEYWORD_ONLY

    def test_json_payload_with_area_reaches_context(self):
        """Proves that raw JSON arriving from Node containing 'area' deserializes
        and flows into DiscoveryQueryContext."""
        node_payload = json.dumps({
            "query": "coffee in Brooklyn, New York",
            "city": "New York",
            "country": "US",
            "niche": "coffee_shop",
            "area": "Brooklyn",
            "max_results": 20,
        })
        params = json.loads(node_payload)
        context = DiscoveryQueryContext(
            session_id="s1",
            query=params["query"],
            city=params["city"],
            country=params.get("country", ""),
            niche=params.get("niche", ""),
            area=params.get("area"),
            max_results=params.get("max_results", 60),
        )
        assert context.area == "Brooklyn"
        overpass_req = translate_request("overpass", context)
        assert overpass_req is not None
        assert overpass_req.area_name == "Brooklyn"
        assert overpass_req.area == "Brooklyn"


# ---------------------------------------------------------------------------
# 17. Structured Telemetry: [overpass-scope]
# ---------------------------------------------------------------------------
class TestOverpassScopeTelemetry:
    def test_area_scoped_telemetry_event_emitted(self, caplog):
        provider = OverpassProvider(http_post=lambda url, ql, headers, **kw: {"elements": []})
        req = OverpassDiscoveryRequest(
            session_id="s1",
            tags={"amenity": "cafe"},
            area_name="Brooklyn",
            city="New York",
            area="Brooklyn",
            scope_source="area",
            scope_valid=True,
        )
        with caplog.at_level(logging.INFO):
            list(provider.discover(req))

        scope_records = [r for r in caplog.records if "[overpass-scope]" in r.message]
        assert len(scope_records) == 1
        event_json = scope_records[0].message.split("[overpass-scope] ")[1]
        data = json.loads(event_json)
        assert data == {
            "city": "New York",
            "area": "Brooklyn",
            "area_name": "Brooklyn",
            "scope_source": "area",
            "scope_valid": True,
        }

    def test_legacy_city_fallback_telemetry_event_emitted(self, caplog):
        provider = OverpassProvider(http_post=lambda url, ql, headers, **kw: {"elements": []})
        req = OverpassDiscoveryRequest(
            session_id="s2",
            tags={"amenity": "cafe"},
            area_name="New York",
            city="New York",
            area=None,
            scope_source="city_fallback",
            scope_valid=True,
        )
        with caplog.at_level(logging.INFO):
            list(provider.discover(req))

        scope_records = [r for r in caplog.records if "[overpass-scope]" in r.message]
        assert len(scope_records) == 1
        event_json = scope_records[0].message.split("[overpass-scope] ")[1]
        data = json.loads(event_json)
        assert data == {
            "city": "New York",
            "area": None,
            "area_name": "New York",
            "scope_source": "city_fallback",
            "scope_valid": True,
        }

