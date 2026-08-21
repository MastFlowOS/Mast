"""
tests/test_phase11_4_overpass_ab_flag.py
=========================================

MAST — PHASE 11.4: Overpass A/B test configuration gate.

Covers the milestone's own "TESTS" section:
    1. flag=true selects Overpass exactly as before
    2. flag=false excludes Overpass
    3. Google Maps remains selected when Overpass is disabled
    4. provider composition contains no Overpass provider when disabled
    5. existing provider composition tests remain green (see
       tests/test_provider_parallelism.py — deliberately not modified
       by this phase; run alongside this file, not replaced by it)

No network/credentials: same no-credential-env-var pattern already
used by tests/test_provider_parallelism.py's
TestComposeDiscoveryNoCredentials.
"""

from __future__ import annotations

import logging

import pytest

from providers.discovery_composition import compose_discovery
from providers.overpass_provider import OverpassProvider
from providers.parallel_composite_provider import ParallelDiscoveryRequest
from providers.production_registry import (
    OVERPASS_ENABLE_ENV_VAR,
    is_overpass_enabled,
)

_UNRELATED_CREDENTIAL_ENV_VARS = (
    "YELP_API_KEY",
    "APPLE_MAPS_ACCESS_TOKEN",
    "FOURSQUARE_API_KEY",
    "AZURE_MAPS_SUBSCRIPTION_KEY",
    "CRUNCHBASE_API_KEY",
    "APOLLO_API_KEY",
)


def _clear_unrelated_credentials(monkeypatch: pytest.MonkeyPatch) -> None:
    for env_var in _UNRELATED_CREDENTIAL_ENV_VARS:
        monkeypatch.delenv(env_var, raising=False)


def _compose_coffee_shop(monkeypatch: pytest.MonkeyPatch):
    _clear_unrelated_credentials(monkeypatch)
    return compose_discovery(
        session_id="s1",
        query="coffee shop",
        city="Austin",
        country="US",
        niche="coffee_shop",
        max_results=10,
    )


class TestIsOverpassEnabledDefault:
    def test_default_is_true_when_unset(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.delenv(OVERPASS_ENABLE_ENV_VAR, raising=False)
        assert is_overpass_enabled() is True

    def test_explicit_true(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv(OVERPASS_ENABLE_ENV_VAR, "true")
        assert is_overpass_enabled() is True

    def test_explicit_false(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv(OVERPASS_ENABLE_ENV_VAR, "false")
        assert is_overpass_enabled() is False

    def test_false_is_case_insensitive(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv(OVERPASS_ENABLE_ENV_VAR, "FALSE")
        assert is_overpass_enabled() is False

    def test_unrecognized_value_defaults_to_enabled(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # Anything other than the literal "false" preserves existing
        # (enabled) behavior — the milestone requires the default to
        # remain true, not to fail closed on a typo.
        monkeypatch.setenv(OVERPASS_ENABLE_ENV_VAR, "nope")
        assert is_overpass_enabled() is True


class TestFlagTrueSelectsOverpass:
    """1. flag=true selects Overpass exactly as before."""

    def test_overpass_selected_when_flag_true(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv(OVERPASS_ENABLE_ENV_VAR, "true")
        composed = _compose_coffee_shop(monkeypatch)
        assert set(composed.selected_provider_ids) == {"google_maps", "overpass"}

    def test_overpass_selected_when_flag_unset(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.delenv(OVERPASS_ENABLE_ENV_VAR, raising=False)
        composed = _compose_coffee_shop(monkeypatch)
        assert set(composed.selected_provider_ids) == {"google_maps", "overpass"}

    def test_selected_log_line_unchanged_when_enabled(
        self, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
    ) -> None:
        monkeypatch.setenv(OVERPASS_ENABLE_ENV_VAR, "true")
        with caplog.at_level(logging.INFO, logger="providers.discovery_composition"):
            _compose_coffee_shop(monkeypatch)
        assert any(
            record.getMessage() == "[provider] overpass selected"
            for record in caplog.records
        )


class TestFlagFalseExcludesOverpass:
    """2. flag=false excludes Overpass."""

    def test_overpass_not_selected_when_flag_false(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv(OVERPASS_ENABLE_ENV_VAR, "false")
        composed = _compose_coffee_shop(monkeypatch)
        assert "overpass" not in composed.selected_provider_ids

    def test_disabled_log_line_emitted(
        self, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
    ) -> None:
        monkeypatch.setenv(OVERPASS_ENABLE_ENV_VAR, "false")
        with caplog.at_level(logging.INFO, logger="providers.discovery_composition"):
            _compose_coffee_shop(monkeypatch)
        assert any(
            record.getMessage() == "[provider] overpass disabled by configuration"
            for record in caplog.records
        )
        assert not any(
            "overpass" in record.getMessage() and "selected" in record.getMessage()
            for record in caplog.records
        )


class TestGoogleMapsRemainsSelectedWhenOverpassDisabled:
    """3. Google Maps remains selected when Overpass is disabled."""

    def test_google_maps_still_selected(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv(OVERPASS_ENABLE_ENV_VAR, "false")
        composed = _compose_coffee_shop(monkeypatch)
        assert composed.selected_provider_ids == ("google_maps",)

    def test_bare_single_provider_request_shape_preserved(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # With Overpass excluded, coffee_shop now resolves to a single
        # provider — same "bare request, no ParallelDiscoveryRequest
        # wrapper" path already covered (for a different reason: no
        # niche) by
        # TestComposeDiscoveryNoCredentials.test_single_provider_case_returns_bare_request
        # in tests/test_provider_parallelism.py.
        monkeypatch.setenv(OVERPASS_ENABLE_ENV_VAR, "false")
        composed = _compose_coffee_shop(monkeypatch)
        assert not isinstance(composed.request, ParallelDiscoveryRequest)
        assert composed.request.city == "Austin"


class TestNoOverpassProviderInComposition:
    """4. provider composition contains no Overpass provider when disabled."""

    def test_composed_provider_is_not_overpass(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv(OVERPASS_ENABLE_ENV_VAR, "false")
        composed = _compose_coffee_shop(monkeypatch)
        # Single-provider case unwraps to the bare provider itself
        # (TargetAwareDiscoveryProvider around it) with no
        # ParallelCompositeDiscoveryProvider/ProviderDeduplicator in
        # between — walk to the innermost wrapped provider and assert
        # it is not an OverpassProvider anywhere in the chain.
        seen = composed.provider
        visited = []
        for attr in ("_provider", "_delegate", "provider"):
            visited.append(seen)
            inner = getattr(seen, attr, None)
            if inner is not None:
                seen = inner
        visited.append(seen)
        assert not any(isinstance(node, OverpassProvider) for node in visited)

    def test_overpass_factory_never_invoked_when_disabled(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        calls: list[str] = []

        def _tracking_overpass_factory():
            calls.append("constructed")
            return OverpassProvider()

        monkeypatch.setenv(OVERPASS_ENABLE_ENV_VAR, "false")
        _clear_unrelated_credentials(monkeypatch)
        compose_discovery(
            session_id="s1",
            query="coffee shop",
            city="Austin",
            country="US",
            niche="coffee_shop",
            max_results=10,
            overpass_factory=_tracking_overpass_factory,
        )
        assert calls == []


class TestUnaffectedBehaviorWhenDisabled:
    """
    Disabling Overpass changes only provider selection — no worker
    count, resource-capacity, qualification, scoring, dedup, or
    target-budget change. These fields are untouched by
    compose_discovery() itself either way, so this simply asserts
    max_results/request shape pass through unchanged.
    """

    def test_max_results_unaffected(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv(OVERPASS_ENABLE_ENV_VAR, "false")
        composed = _compose_coffee_shop(monkeypatch)
        assert composed.request.max_results == 10
