"""
Tests for Priority 5: Evidence-based provider composition in street mode vs area mode.
Street-mode spawns must compose providers = google_maps only and exclude Overpass.
Area-mode spawns must still include Overpass when configured.
"""

from __future__ import annotations

import os
import sys
import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

from providers.discovery_composition import compose_discovery
from providers.production_registry import build_production_registry


def test_street_mode_excludes_overpass(monkeypatch):
    """In street mode, Overpass must not be instantiated or included in the composed providers."""
    # Ensure Overpass is enabled in env
    monkeypatch.setenv("DISCOVERY_ENABLE_OVERPASS", "true")

    overpass_instantiated = False

    def fake_overpass_factory():
        nonlocal overpass_instantiated
        overpass_instantiated = True
        raise AssertionError("Overpass factory should not be called in street mode")

    fake_maps_provider = object()

    def fake_maps_factory():
        return fake_maps_provider

    composed = compose_discovery(
        session_id="test-session-street",
        query="Coffee Shop on 35th St, Chicago",
        city="Chicago",
        street_mode=True,
        google_maps_factory=fake_maps_factory,
        overpass_factory=fake_overpass_factory,
    )

    assert not overpass_instantiated
    assert composed.selected_provider_ids == ("google_maps",)
    from providers.google_maps_provider import GoogleMapsDiscoveryRequest
    assert isinstance(composed.request, GoogleMapsDiscoveryRequest)


def test_named_area_excludes_overpass(monkeypatch):
    """When a specific commercial area is targeted, Overpass must be excluded (Google Maps only)."""
    monkeypatch.setenv("DISCOVERY_ENABLE_OVERPASS", "true")

    overpass_instantiated = False

    def fake_overpass_factory():
        nonlocal overpass_instantiated
        overpass_instantiated = True
        raise AssertionError("Overpass factory should not be called when area is specified")

    fake_maps_provider = object()

    def fake_maps_factory():
        return fake_maps_provider

    composed = compose_discovery(
        session_id="test-session-named-area",
        query="Coffee Shop in Ballard, Seattle",
        city="Seattle",
        area="Ballard",
        street_mode=False,
        google_maps_factory=fake_maps_factory,
        overpass_factory=fake_overpass_factory,
    )

    assert not overpass_instantiated
    assert composed.selected_provider_ids == ("google_maps",)


def test_area_mode_includes_overpass(monkeypatch):
    """In area mode, Overpass should be composed when enabled and relevant."""
    monkeypatch.setenv("DISCOVERY_ENABLE_OVERPASS", "true")

    overpass_instantiated = False

    class _FakeOverpass:
        provider_id = "overpass"
        capabilities = build_production_registry().get("overpass").capabilities

    def fake_overpass_factory():
        nonlocal overpass_instantiated
        overpass_instantiated = True
        return _FakeOverpass()

    class _FakeMaps:
        provider_id = "google_maps"
        capabilities = build_production_registry().get("google_maps").capabilities

    def fake_maps_factory():
        return _FakeMaps()

    composed = compose_discovery(
        session_id="test-session-area",
        query="Coffee Shop in Chicago",
        niche="coffee",
        city="Chicago",
        street_mode=False,
        google_maps_factory=fake_maps_factory,
        overpass_factory=fake_overpass_factory,
    )

    assert overpass_instantiated
    assert "overpass" in composed.selected_provider_ids
    assert "google_maps" in composed.selected_provider_ids
