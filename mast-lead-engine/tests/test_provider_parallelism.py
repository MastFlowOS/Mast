"""
tests/test_provider_parallelism.py
===================================

MAST — Provider Parallelism v1: deterministic tests for provider
relevance selection (Step 2), concurrent execution + streaming
(Step 4), cross-provider dedup / no-double-enrichment (Steps 5-6),
global target enforcement + cancellation (Step 7), and the
no-relevant-provider failure mode (Step 5 of the milestone's own
"TESTS" section, items A-I).

Uses controlled fake DiscoveryProviderInterface implementations
(threading.Event-gated, no real network/credentials) exactly the way
tests/test_parallel_composite_provider.py and
tests/test_provider_deduplicator.py already do — those two files are
read for precedent, not modified.
"""

from __future__ import annotations

import threading
import time
import uuid
from typing import Any, Iterator, Optional

import pytest

from engine.contracts import BusinessCandidate
from engine.interfaces import DiscoveryProviderInterface
from providers.discovery_composition import (
    NoRelevantProviderError,
    compose_discovery,
)
from providers.parallel_composite_provider import (
    ParallelCompositeDiscoveryProvider,
    ParallelDiscoveryRequest,
)
from providers.provider_capabilities import ProviderCapabilities
from providers.provider_deduplicator import ProviderDeduplicator
from providers.provider_request_translation import (
    DiscoveryQueryContext,
    translate_request,
)
from providers.provider_selection import select_relevant_providers
from providers.target_aware_provider import TargetAwareDiscoveryProvider


def _candidate(**overrides: Any) -> BusinessCandidate:
    defaults = dict(
        pipeline_id=str(uuid.uuid4()),
        session_id="s1",
        provider="fake",
        maps_url=f"https://maps.example.invalid/{uuid.uuid4()}",
        name="Business",
        city="Testville",
        country="US",
    )
    defaults.update(overrides)
    return BusinessCandidate(**defaults)


class _ListProvider(DiscoveryProviderInterface):
    """
    Yields a fixed list of candidates, one at a time, waiting on a
    threading.Event before each yield if `gate` is given — lets tests
    control interleaving deterministically (same pattern
    tests/test_parallel_composite_provider.py already uses).
    """

    def __init__(
        self,
        provider_id: str,
        candidates: list[BusinessCandidate],
        *,
        gate: Optional[threading.Event] = None,
        delay_s: float = 0.0,
        fail_after: Optional[int] = None,
    ) -> None:
        self._provider_id = provider_id
        self._candidates = candidates
        self._gate = gate
        self._delay_s = delay_s
        self._fail_after = fail_after
        self.started_at: Optional[float] = None
        self.finished_at: Optional[float] = None

    @property
    def provider_id(self) -> str:
        return self._provider_id

    @property
    def display_name(self) -> str:
        return self._provider_id

    def discover(self, request: Any) -> Iterator[BusinessCandidate]:
        self.started_at = time.monotonic()
        if self._gate is not None:
            self._gate.wait(timeout=5)
        for i, candidate in enumerate(self._candidates):
            if self._fail_after is not None and i >= self._fail_after:
                raise RuntimeError(f"{self._provider_id} simulated failure")
            if self._delay_s:
                time.sleep(self._delay_s)
            yield candidate
        self.finished_at = time.monotonic()


def _capabilities(*entity_types: str) -> ProviderCapabilities:
    return ProviderCapabilities(supported_entity_types=tuple(entity_types))


# ---------------------------------------------------------------------------
# Test A — Provider selection
# ---------------------------------------------------------------------------
class TestProviderSelection:
    def test_coffee_shop_does_not_select_apollo_or_crunchbase(self):
        capabilities_by_id = {
            "google_maps": _capabilities("local_business"),
            "yelp": _capabilities("local_business"),
            "apple_maps": _capabilities("local_business"),
            "foursquare": _capabilities("local_business"),
            "azure_maps": _capabilities("local_business"),
            "overpass": _capabilities("local_business"),
            "crunchbase": _capabilities("corporate_entity"),
            "apollo": _capabilities("corporate_entity", "executive_contact"),
        }
        selected = select_relevant_providers(
            capabilities_by_id, entity_types=("local_business",)
        )
        assert "crunchbase" not in selected
        assert "apollo" not in selected
        assert set(selected) == {
            "google_maps", "yelp", "apple_maps", "foursquare",
            "azure_maps", "overpass",
        }

    def test_corporate_search_can_select_apollo_and_crunchbase(self):
        capabilities_by_id = {
            "google_maps": _capabilities("local_business"),
            "crunchbase": _capabilities("corporate_entity"),
            "apollo": _capabilities("corporate_entity", "executive_contact"),
        }
        selected = select_relevant_providers(
            capabilities_by_id, entity_types=("corporate_entity",)
        )
        assert set(selected) == {"crunchbase", "apollo"}
        assert "google_maps" not in selected

    def test_provider_with_no_declared_entity_types_is_never_selected(self):
        capabilities_by_id = {"mystery": ProviderCapabilities()}
        selected = select_relevant_providers(
            capabilities_by_id, entity_types=("local_business",)
        )
        assert selected == ()

    def test_empty_entity_types_raises(self):
        with pytest.raises(ValueError):
            select_relevant_providers({}, entity_types=())


# ---------------------------------------------------------------------------
# Test B — Parallel start (two or more selected providers overlap)
# ---------------------------------------------------------------------------
class TestParallelStart:
    def test_two_providers_start_before_either_finishes(self):
        start_gate = threading.Event()
        provider_a = _ListProvider(
            "a", [_candidate(name="A1")], gate=start_gate, delay_s=0.05
        )
        provider_b = _ListProvider(
            "b", [_candidate(name="B1")], gate=start_gate, delay_s=0.05
        )
        composite = ParallelCompositeDiscoveryProvider([provider_a, provider_b])

        results = []

        def _drain():
            start_gate.set()
            for c in composite.discover(ParallelDiscoveryRequest(requests={"a": None, "b": None})):
                results.append(c)

        thread = threading.Thread(target=_drain)
        thread.start()
        # Give both providers a moment to reach their gate wait.
        time.sleep(0.05)
        thread.join(timeout=5)

        assert provider_a.started_at is not None
        assert provider_b.started_at is not None
        # Both were started (past the gate.wait()) close together —
        # neither blocked the other from starting.
        assert abs(provider_a.started_at - provider_b.started_at) < 0.2
        assert len(results) == 2


# ---------------------------------------------------------------------------
# Test C — Streaming: fast provider candidates emitted before a slow
# provider finishes.
# ---------------------------------------------------------------------------
class TestStreaming:
    def test_fast_candidates_emitted_before_slow_provider_finishes(self):
        fast = _ListProvider("fast", [_candidate(name="Fast1")], delay_s=0.0)
        slow = _ListProvider(
            "slow", [_candidate(name="Slow1")], delay_s=0.4
        )
        composite = ParallelCompositeDiscoveryProvider([fast, slow])

        received_order = []
        gen = composite.discover(ParallelDiscoveryRequest(requests={"fast": None, "slow": None}))
        first = next(gen)
        received_order.append(first)
        # The fast provider's candidate must arrive first, while slow
        # is still sleeping (has not finished yet).
        assert slow.finished_at is None
        for remaining in gen:
            received_order.append(remaining)
        assert received_order[0].name == "Fast1"


# ---------------------------------------------------------------------------
# Test D — Provider failure isolation
# ---------------------------------------------------------------------------
class TestProviderFailureIsolation:
    def test_one_provider_failing_does_not_stop_others_with_continue_on_error(self):
        good = _ListProvider("good", [_candidate(name="Good1"), _candidate(name="Good2")])
        bad = _ListProvider("bad", [_candidate(name="Bad1")], fail_after=0)
        composite = ParallelCompositeDiscoveryProvider(
            [good, bad], continue_on_provider_error=True
        )
        results = list(
            composite.discover(ParallelDiscoveryRequest(requests={"good": None, "bad": None}))
        )
        names = {c.name for c in results}
        assert "Good1" in names and "Good2" in names

    def test_on_provider_error_callback_fires_in_best_effort_mode(self):
        good = _ListProvider("good", [_candidate(name="Good1")])
        bad = _ListProvider("bad", [_candidate(name="Bad1")], fail_after=0)
        seen: list[tuple[str, BaseException]] = []
        composite = ParallelCompositeDiscoveryProvider(
            [good, bad],
            continue_on_provider_error=True,
            on_provider_error=lambda pid, exc: seen.append((pid, exc)),
        )
        list(composite.discover(ParallelDiscoveryRequest(requests={"good": None, "bad": None})))
        assert len(seen) == 1
        assert seen[0][0] == "bad"
        assert isinstance(seen[0][1], RuntimeError)

    def test_on_provider_error_callback_fires_in_strict_mode_before_raising(self):
        bad = _ListProvider("bad", [_candidate(name="Bad1")], fail_after=0)
        seen: list[str] = []
        composite = ParallelCompositeDiscoveryProvider(
            [bad], on_provider_error=lambda pid, exc: seen.append(pid)
        )
        with pytest.raises(RuntimeError):
            list(composite.discover(ParallelDiscoveryRequest(requests={"bad": None})))
        assert seen == ["bad"]

    def test_strict_mode_still_propagates_by_default(self):
        # Regression guard: continue_on_provider_error's default (False)
        # must remain unchanged by this phase.
        good = _ListProvider("good", [_candidate(name="Good1")])
        bad = _ListProvider("bad", [_candidate(name="Bad1")], fail_after=0)
        composite = ParallelCompositeDiscoveryProvider([good, bad])
        with pytest.raises(RuntimeError):
            list(
                composite.discover(
                    ParallelDiscoveryRequest(requests={"good": None, "bad": None})
                )
            )

    def test_healthy_candidates_already_emitted_remain_valid_after_later_failure(self):
        # Test B: a healthy provider emits candidates *before* another
        # provider fails; those already-yielded candidates must not be
        # retracted, and the healthy provider must keep streaming
        # afterward.
        started = threading.Event()
        good = _ListProvider(
            "good",
            [_candidate(name=f"Good{i}") for i in range(5)],
            delay_s=0.02,
        )
        bad = _ListProvider("bad", [_candidate(name="Bad1")], fail_after=0)
        composite = ParallelCompositeDiscoveryProvider(
            [good, bad], continue_on_provider_error=True
        )

        results = []
        for c in composite.discover(
            ParallelDiscoveryRequest(requests={"good": None, "bad": None})
        ):
            results.append(c)
        names = {c.name for c in results}
        assert names == {f"Good{i}" for i in range(5)}

    def test_all_providers_failing_yields_nothing_and_raises_nothing(self):
        # Test C: with continue_on_provider_error=True, if every
        # provider fails, the composite must degrade to an empty,
        # cleanly-exhausted stream (existing "no candidates" semantics)
        # rather than swallowing the failure into a false success or
        # deadlocking.
        bad_a = _ListProvider("a", [_candidate(name="A1")], fail_after=0)
        bad_b = _ListProvider("b", [_candidate(name="B1")], fail_after=0)
        composite = ParallelCompositeDiscoveryProvider(
            [bad_a, bad_b], continue_on_provider_error=True
        )
        results = list(
            composite.discover(ParallelDiscoveryRequest(requests={"a": None, "b": None}))
        )
        assert results == []

    def test_target_reached_cancels_remaining_after_one_provider_already_failed(self):
        # Test D: global target enforcement still works correctly when
        # one provider has already failed and only a healthy provider
        # remains active.
        bad = _ListProvider("bad", [_candidate(name="Bad1")], fail_after=0)
        good = _ListProvider(
            "good", [_candidate(name=f"G{i}") for i in range(50)], delay_s=0.005
        )
        composite = ParallelCompositeDiscoveryProvider(
            [bad, good], continue_on_provider_error=True
        )
        accepted = 0
        target = 5

        def _should_stop() -> bool:
            return accepted >= target

        wrapped = TargetAwareDiscoveryProvider(composite, should_stop=_should_stop)
        results = []
        for candidate in wrapped.discover(
            ParallelDiscoveryRequest(requests={"bad": None, "good": None})
        ):
            results.append(candidate)
            accepted += 1
            if accepted >= target:
                break
        assert accepted == target
        time.sleep(0.2)
        assert good.finished_at is None

    def test_cancellation_stops_remaining_after_one_provider_already_failed(self):
        # Test E: user cancellation (should_stop) still stops every
        # still-running provider even when another provider already
        # failed earlier.
        bad = _ListProvider("bad", [_candidate(name="Bad1")], fail_after=0)
        good = _ListProvider("good", [_candidate(name="G1")], delay_s=0.05)
        composite = ParallelCompositeDiscoveryProvider(
            [bad, good], continue_on_provider_error=True
        )
        wrapped = TargetAwareDiscoveryProvider(composite, should_stop=lambda: True)
        results = list(
            wrapped.discover(ParallelDiscoveryRequest(requests={"bad": None, "good": None}))
        )
        assert results == []

    def test_failure_isolation_does_not_bypass_deduplication(self):
        # Test G: a failing provider running alongside providers that
        # yield genuine cross-provider duplicates must not let those
        # duplicates slip past ProviderDeduplicator.
        joes_a = _candidate(
            provider="google_maps", name="Joe's Coffee",
            website="https://joescoffee.example.com", phone="555-0100",
        )
        joes_b = _candidate(
            provider="yelp", name="Joe's Coffee",
            website="https://joescoffee.example.com", phone="555-0100",
        )
        provider_a = _ListProvider("google_maps", [joes_a])
        provider_b = _ListProvider("yelp", [joes_b])
        bad = _ListProvider("bad", [_candidate(name="Bad1")], fail_after=0)
        composite = ParallelCompositeDiscoveryProvider(
            [provider_a, provider_b, bad], continue_on_provider_error=True
        )
        deduped = ProviderDeduplicator(composite)
        results = list(
            deduped.discover(
                ParallelDiscoveryRequest(
                    requests={"google_maps": None, "yelp": None, "bad": None}
                )
            )
        )
        assert len(results) == 1


# ---------------------------------------------------------------------------
# Test E — Cross-provider duplicate: one candidate, one accepted
# opportunity.
# ---------------------------------------------------------------------------
class TestCrossProviderDuplicate:
    def test_same_business_from_two_providers_yields_one_candidate(self):
        joes_a = _candidate(
            provider="google_maps", name="Joe's Coffee",
            website="https://joescoffee.example.com", phone="555-0100",
        )
        joes_b = _candidate(
            provider="yelp", name="Joe's Coffee",
            website="https://joescoffee.example.com", phone="555-0100",
        )
        provider_a = _ListProvider("google_maps", [joes_a])
        provider_b = _ListProvider("yelp", [joes_b])
        composite = ParallelCompositeDiscoveryProvider([provider_a, provider_b])
        deduped = ProviderDeduplicator(composite)

        results = list(
            deduped.discover(
                ParallelDiscoveryRequest(requests={"google_maps": None, "yelp": None})
            )
        )
        assert len(results) == 1


# ---------------------------------------------------------------------------
# Test F — Different businesses: two candidates.
# ---------------------------------------------------------------------------
class TestDifferentBusinesses:
    def test_different_businesses_from_two_providers_yield_two_candidates(self):
        a = _candidate(
            provider="google_maps", name="Joe's Coffee",
            website="https://joescoffee.example.com", phone="555-0100",
        )
        b = _candidate(
            provider="yelp", name="Sarah's Bakery",
            website="https://sarahsbakery.example.com", phone="555-0200",
        )
        provider_a = _ListProvider("google_maps", [a])
        provider_b = _ListProvider("yelp", [b])
        composite = ParallelCompositeDiscoveryProvider([provider_a, provider_b])
        deduped = ProviderDeduplicator(composite)

        results = list(
            deduped.discover(
                ParallelDiscoveryRequest(requests={"google_maps": None, "yelp": None})
            )
        )
        assert len(results) == 2


# ---------------------------------------------------------------------------
# Test G — Global target: accepted reaches N, all provider work is
# cancelled, no overshoot.
# ---------------------------------------------------------------------------
class TestGlobalTarget:
    def test_target_reached_cancels_all_active_providers(self):
        many_a = [_candidate(name=f"A{i}") for i in range(50)]
        many_b = [_candidate(name=f"B{i}") for i in range(50)]
        provider_a = _ListProvider("a", many_a, delay_s=0.005)
        provider_b = _ListProvider("b", many_b, delay_s=0.005)
        composite = ParallelCompositeDiscoveryProvider([provider_a, provider_b])

        accepted = 0
        target = 10

        def _should_stop() -> bool:
            return accepted >= target

        wrapped = TargetAwareDiscoveryProvider(composite, should_stop=_should_stop)

        results = []
        for candidate in wrapped.discover(
            ParallelDiscoveryRequest(requests={"a": None, "b": None})
        ):
            results.append(candidate)
            accepted += 1
            if accepted >= target:
                break

        assert accepted == target
        assert len(results) == target
        # Give both producer threads a moment to observe cancellation
        # and stop pulling further items from their own 50-item lists.
        time.sleep(0.3)
        # Overshoot check: the wrapper must have stopped pulling at (or
        # very close to) target — neither provider should have been
        # allowed to run all the way to its own 50-item exhaustion.
        assert provider_a.finished_at is None
        assert provider_b.finished_at is None


# ---------------------------------------------------------------------------
# Test H — Cancellation: an external should_stop stops every active
# provider.
# ---------------------------------------------------------------------------
class TestCancellation:
    def test_should_stop_true_from_the_start_yields_nothing(self):
        provider_a = _ListProvider("a", [_candidate()], delay_s=0.05)
        provider_b = _ListProvider("b", [_candidate()], delay_s=0.05)
        composite = ParallelCompositeDiscoveryProvider([provider_a, provider_b])
        wrapped = TargetAwareDiscoveryProvider(composite, should_stop=lambda: True)
        results = list(
            wrapped.discover(ParallelDiscoveryRequest(requests={"a": None, "b": None}))
        )
        assert results == []


# ---------------------------------------------------------------------------
# Test I — No relevant / unsupported provider configuration fails
# clearly rather than silently returning zero candidates.
# ---------------------------------------------------------------------------
class TestNoRelevantProviderFailsClearly:
    def test_corporate_search_without_organization_query_raises(self):
        with pytest.raises(NoRelevantProviderError):
            compose_discovery(
                session_id="s1", query="", city="", country="US",
                niche="tech_company", entity_types=("corporate_entity",),
            )

    def test_unknown_entity_type_raises(self):
        with pytest.raises(NoRelevantProviderError):
            compose_discovery(
                session_id="s1", query="widgets", city="Austin", country="US",
                niche="widgets", entity_types=("nonexistent_entity_type",),
            )


# ---------------------------------------------------------------------------
# Request translation — honesty rule (Step 3)
# ---------------------------------------------------------------------------
class TestRequestTranslation:
    def test_overpass_translates_when_niche_matches_known_osm_tag(self):
        context = DiscoveryQueryContext(
            session_id="s1", query="coffee shop", city="Austin",
            country="US", niche="coffee_shop",
        )
        request = translate_request("overpass", context)
        assert request is not None
        assert request.tags == {"amenity": "cafe"}

    def test_overpass_returns_none_for_unmapped_niche(self):
        context = DiscoveryQueryContext(
            session_id="s1", query="widgets", city="Austin",
            country="US", niche="industrial_widget_manufacturer",
        )
        assert translate_request("overpass", context) is None

    def test_overpass_honors_explicit_caller_supplied_tags(self):
        context = DiscoveryQueryContext(
            session_id="s1", query="widgets", city="Austin",
            country="US", niche="industrial_widget_manufacturer",
            osm_tags={"shop": "widgets"},
        )
        request = translate_request("overpass", context)
        assert request is not None
        assert request.tags == {"shop": "widgets"}

    def test_crunchbase_returns_none_without_organization_query(self):
        context = DiscoveryQueryContext(
            session_id="s1", query="coffee shop", city="Austin", country="US",
        )
        assert translate_request("crunchbase", context) is None

    def test_apollo_translates_with_organization_query(self):
        context = DiscoveryQueryContext(
            session_id="s1", query="", city="", country="US",
            organization_query="Acme Robotics",
        )
        request = translate_request("apollo", context)
        assert request is not None
        assert request.q_organization_name == "Acme Robotics"

    def test_google_maps_always_translates(self):
        context = DiscoveryQueryContext(
            session_id="s1", query="coffee shop", city="Austin", country="US",
        )
        request = translate_request("google_maps", context)
        assert request.city == "Austin"
        assert request.query == "coffee shop"

    def test_unknown_provider_id_raises_key_error(self):
        context = DiscoveryQueryContext(session_id="s1", query="x", city="y")
        with pytest.raises(KeyError):
            translate_request("not_a_real_provider", context)


# ---------------------------------------------------------------------------
# Composition root — end to end with no credentials configured (today's
# actual deployment state).
# ---------------------------------------------------------------------------
class TestComposeDiscoveryNoCredentials:
    def test_local_business_resolves_to_google_maps_and_overpass_only(self, monkeypatch):
        for env_var in (
            "YELP_API_KEY", "APPLE_MAPS_ACCESS_TOKEN", "FOURSQUARE_API_KEY",
            "AZURE_MAPS_SUBSCRIPTION_KEY", "CRUNCHBASE_API_KEY", "APOLLO_API_KEY",
        ):
            monkeypatch.delenv(env_var, raising=False)

        composed = compose_discovery(
            session_id="s1", query="coffee shop", city="Austin",
            country="US", niche="coffee_shop", max_results=10,
        )
        assert set(composed.selected_provider_ids) == {"google_maps", "overpass"}
        assert isinstance(composed.provider, TargetAwareDiscoveryProvider)
        assert isinstance(composed.request, ParallelDiscoveryRequest)

    def test_single_provider_case_returns_bare_request(self, monkeypatch):
        for env_var in (
            "YELP_API_KEY", "APPLE_MAPS_ACCESS_TOKEN", "FOURSQUARE_API_KEY",
            "AZURE_MAPS_SUBSCRIPTION_KEY", "CRUNCHBASE_API_KEY", "APOLLO_API_KEY",
        ):
            monkeypatch.delenv(env_var, raising=False)

        # No niche => no Overpass OSM-tag match => google_maps alone.
        composed = compose_discovery(
            session_id="s1", query="anything", city="Austin",
            country="US", max_results=10,
        )
        assert composed.selected_provider_ids == ("google_maps",)
        assert composed.request.city == "Austin"


# ---------------------------------------------------------------------------
# Provider Failure Isolation phase — composition-root wiring.
#
# Regression guard for the Railway production bug this phase fixes:
# Google Maps produced valid candidates, Overpass raised
# "HTTP Error 406: Not Acceptable", and that single auxiliary-provider
# failure previously propagated, uncaught, all the way out of
# `compose_discovery()`'s composed provider — turning a partial success
# (Google's candidates) into `delivered=0`. These tests confirm the
# composition root now wires `ParallelCompositeDiscoveryProvider` with
# `continue_on_provider_error=True` (and a logging hook) whenever more
# than one provider is selected, instead of asserting on live network
# behaviour.
# ---------------------------------------------------------------------------
class TestComposeDiscoveryFailureIsolationWiring:
    def test_multi_provider_composition_enables_continue_on_provider_error(
        self, monkeypatch
    ):
        for env_var in (
            "YELP_API_KEY", "APPLE_MAPS_ACCESS_TOKEN", "FOURSQUARE_API_KEY",
            "AZURE_MAPS_SUBSCRIPTION_KEY", "CRUNCHBASE_API_KEY", "APOLLO_API_KEY",
        ):
            monkeypatch.delenv(env_var, raising=False)

        captured: dict[str, Any] = {}
        import providers.discovery_composition as discovery_composition_module

        real_cls = discovery_composition_module.ParallelCompositeDiscoveryProvider

        class _CapturingParallelComposite(real_cls):
            def __init__(self, providers, **kwargs):
                captured.update(kwargs)
                super().__init__(providers, **kwargs)

        monkeypatch.setattr(
            discovery_composition_module,
            "ParallelCompositeDiscoveryProvider",
            _CapturingParallelComposite,
        )

        composed = compose_discovery(
            session_id="s1", query="coffee shop", city="Austin",
            country="US", niche="coffee_shop", max_results=10,
        )

        # Two providers selected (google_maps, overpass — see
        # TestComposeDiscoveryNoCredentials above) so the parallel
        # composite path, not the single-provider bare path, is taken.
        assert set(composed.selected_provider_ids) == {"google_maps", "overpass"}
        assert captured.get("continue_on_provider_error") is True
        assert callable(captured.get("on_provider_error"))

    def test_log_provider_error_helper_logs_a_warning(self, caplog):
        import logging

        from providers.discovery_composition import _log_provider_error

        with caplog.at_level(logging.WARNING, logger="providers.discovery_composition"):
            _log_provider_error("overpass", ValueError("HTTP Error 406: Not Acceptable"))
        assert any(
            "overpass" in record.getMessage() and "406" in record.getMessage()
            for record in caplog.records
        )
