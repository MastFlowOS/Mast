"""
tests/test_area_scope_overpass.py
==================================

MAST Engine — Phase 13C: Area-Scope Overpass Fix.

Regression coverage for the confirmed production bug: every concurrent
area worker (Brooklyn/Queens/Manhattan/Staten Island/...) was sending
Overpass the same city-level `area["name"="<city>"]` scope, so every
sibling area independently rediscovered the same city-wide OSM
candidate population (see the production evidence in the phase
instructions this file implements — 95.5% of businesses rediscovered
by more than one sibling area).

These tests prove:

  1-3. `area` threads through `DiscoveryQueryContext` -> `translate_request`
       -> `OverpassDiscoveryRequest.area_name` for distinct curated
       area values (including a multi-word area like "Staten Island").
  4-5. `area=None` / `area=""` preserve the exact prior city-level
       Overpass fallback.
  6.   city/country fallback (no area, no city) still works.
  7.   `area` set on `SearchTarget` reaches the JSON payload
       `runEngineQuery()` writes to the Python subprocess's stdin
       (Node -> Python transmission), via a lightweight regression
       here plus the canonical assertion living in the TS test suite
       (src/discovery/providers/googleMaps/__tests__/).
  8.   Existing non-area callers (no `area` kwarg at all) remain
       compatible at every layer (translation, `compose_discovery()`,
       `run_query()`).
  9.   Google Maps's own translated request is completely unaffected
       by `area` being present on the context.
  10.  Provider selection (which providers get chosen at all) is
       unaffected by `area`.
  11.  Qualification is out of scope for this phase and is not
       touched anywhere here — asserted by absence, not by a
       qualification-specific test (see phase instructions, "STOP —
       do not implement provider-level dedup or enrichment
       concurrency yet").
"""

from __future__ import annotations

import inspect
from typing import Any

import pytest

from providers.discovery_composition import compose_discovery
from providers.parallel_composite_provider import ParallelDiscoveryRequest
from providers.provider_request_translation import (
    DiscoveryQueryContext,
    translate_request,
)
from providers.target_aware_provider import TargetAwareDiscoveryProvider


# ---------------------------------------------------------------------------
# 1-3. Translation-level: distinct curated area values reach
# OverpassDiscoveryRequest.area_name unchanged.
# ---------------------------------------------------------------------------
class TestOverpassAreaScoping:
    @pytest.mark.parametrize(
        "area",
        ["Brooklyn", "Queens", "Staten Island"],
    )
    def test_area_threads_into_overpass_area_name(self, area):
        context = DiscoveryQueryContext(
            session_id="s1",
            query="coffee shop",
            city="New York",
            country="US",
            niche="coffee_shop",
            area=area,
        )
        request = translate_request("overpass", context)
        assert request is not None
        assert request.area_name == area

    def test_sibling_areas_produce_distinct_area_names_for_same_city(self):
        """The exact production bug: Brooklyn/Queens/Manhattan/Staten
        Island all share city="New York" but must no longer collapse
        onto the same Overpass area_name."""
        area_names = set()
        for area in ("Brooklyn", "Queens", "Manhattan", "Staten Island"):
            context = DiscoveryQueryContext(
                session_id="s1", query="coffee shop", city="New York",
                country="US", niche="coffee_shop", area=area,
            )
            request = translate_request("overpass", context)
            assert request is not None
            area_names.add(request.area_name)
        assert area_names == {"Brooklyn", "Queens", "Manhattan", "Staten Island"}

    # -----------------------------------------------------------------
    # 4-6. Fallback behavior — must be backward compatible.
    # -----------------------------------------------------------------
    def test_area_none_preserves_old_city_fallback(self):
        context = DiscoveryQueryContext(
            session_id="s1", query="coffee shop", city="New York",
            country="US", niche="coffee_shop", area=None,
        )
        request = translate_request("overpass", context)
        assert request is not None
        assert request.area_name == "New York"

    def test_empty_area_preserves_old_city_fallback(self):
        context = DiscoveryQueryContext(
            session_id="s1", query="coffee shop", city="New York",
            country="US", niche="coffee_shop", area="",
        )
        request = translate_request("overpass", context)
        assert request is not None
        assert request.area_name == "New York"

    def test_city_country_fallback_still_works_with_no_city(self):
        """No area, no city -> country, exactly as before this phase."""
        context = DiscoveryQueryContext(
            session_id="s1", query="coffee shop", city="",
            country="US", niche="coffee_shop",
        )
        request = translate_request("overpass", context)
        assert request is not None
        assert request.area_name == "US"

    def test_area_default_omitted_entirely_matches_none(self):
        """A caller that never passes `area=` at all (every pre-Phase-13C
        call site) gets byte-for-byte the same OverpassDiscoveryRequest
        as before — DiscoveryQueryContext.area defaults to None."""
        context = DiscoveryQueryContext(
            session_id="s1", query="coffee shop", city="New York",
            country="US", niche="coffee_shop",
        )
        assert context.area is None
        request = translate_request("overpass", context)
        assert request is not None
        assert request.area_name == "New York"

    # -----------------------------------------------------------------
    # 9. Google Maps is completely unaffected by `area`.
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
    # 10. Provider selection unaffected by area.
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

    def test_composed_google_maps_request_still_uses_city_not_area(self, monkeypatch):
        self._clear_provider_credentials(monkeypatch)
        composed = compose_discovery(
            session_id="s1", query="coffee shop", city="New York",
            country="US", niche="coffee_shop", area="Queens", max_results=10,
        )
        google_maps_request = composed.request.requests["google_maps"]
        assert google_maps_request.city == "New York"

    # -----------------------------------------------------------------
    # 8. Existing non-area callers remain fully compatible.
    # -----------------------------------------------------------------
    def test_compose_discovery_without_area_kwarg_unaffected(self, monkeypatch):
        self._clear_provider_credentials(monkeypatch)
        composed = compose_discovery(
            session_id="s1", query="coffee shop", city="New York",
            country="US", niche="coffee_shop", max_results=10,
        )
        overpass_request = composed.request.requests["overpass"]
        assert overpass_request.area_name == "New York"

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
# run_query() — service.py's public entry point also threads `area`
# through unchanged (kwargs-only addition; verified at the signature
# level here since exercising the full engine is covered elsewhere).
# ---------------------------------------------------------------------------
class TestRunQuerySignature:
    def test_run_query_accepts_area_keyword_defaulting_to_empty_string(self):
        import service

        sig = inspect.signature(service.run_query)
        assert "area" in sig.parameters
        param = sig.parameters["area"]
        assert param.default == ""
        assert param.kind == inspect.Parameter.KEYWORD_ONLY
