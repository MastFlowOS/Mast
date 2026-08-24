"""
tests/test_phase40_discovery_dedup_waste.py
=============================================

PHASE 40 — Discovery Duplicate Waste Reduction.

Regression coverage for the real path audited this phase:

    Maps candidate -> BusinessCandidate -> fingerprint -> early dedup
    -> fan-in / enrichment

Two confirmed waste sources were fixed (see providers/provider_deduplicator.py
and providers/discovery_composition.py for the full rationale):

  1. `_fingerprint_keys()` never derived an identity key from
     `BusinessCandidate.maps_url` — the single strongest, cheapest
     signal for "same exact Maps place" duplicates (class 1) — even
     though `storage/dedup.py` already has the exact normalizers
     (`norm_maps_place_id` / `norm_maps_link`) needed to do it, and
     `storage/early_persistent_dedup.py` already relies on those same
     normalizers for the persistent side of the same check.

  2. `compose_discovery()` skipped wrapping in `ProviderDeduplicator`
     entirely whenever only one provider was selected — the common
     case whenever a niche has no Overpass OSM-tag mapping (or other
     providers are unconfigured) — leaving zero in-stream dedup for
     Google Maps' own grid/tile-overlap repeats within a single run.

This file exercises every duplicate class named in the Phase 40 audit
brief against the ACTUAL fingerprinting function/wrapper (not a
reimplementation), plus the compose_discovery wiring fix, plus the
existing false-positive guardrails (classes that must NOT collapse).
No fuzzy matching, no merging, no scoring/qualification changes are
exercised or required by any of these tests.
"""

from __future__ import annotations

import itertools
import uuid
from typing import Any, Iterable, Iterator, List

import pytest

from engine.contracts import BusinessCandidate
from engine.interfaces import DiscoveryProviderInterface
from providers.composite_provider import (
    CompositeDiscoveryProvider,
    CompositeDiscoveryRequest,
)
from providers.discovery_composition import compose_discovery
from providers.provider_deduplicator import ProviderDeduplicator
from providers.target_aware_provider import TargetAwareDiscoveryProvider

_pipeline_ids = (f"pl-{i}" for i in itertools.count(1))


def _candidate(**overrides: Any) -> BusinessCandidate:
    fields = dict(
        pipeline_id=next(_pipeline_ids),
        session_id="session-1",
        provider="test_provider",
        provider_business_id=None,
        maps_url=None,
        name=None,
        category=None,
        address=None,
        city=None,
        country=None,
        website=None,
        phone=None,
        rating=None,
        review_count=None,
        coordinates=None,
        discovered_at=None,
    )
    fields.update(overrides)
    return BusinessCandidate(**fields)


class _FakeProvider(DiscoveryProviderInterface):
    """Yields a fixed, pre-built list of BusinessCandidate objects from
    a real generator — genuine streaming, matching the pattern
    validate_provider_deduplicator.py already established."""

    def __init__(self, provider_id: str, candidates: Iterable[BusinessCandidate]):
        self._provider_id = provider_id
        self._candidates = list(candidates)

    @property
    def provider_id(self) -> str:
        return self._provider_id

    @property
    def display_name(self) -> str:
        return self._provider_id

    def discover(self, request: Any) -> Iterator[BusinessCandidate]:
        yield from self._candidates


def _dedup_names(candidates: List[BusinessCandidate]) -> List[str]:
    fake = _FakeProvider("multi", candidates)
    out = list(ProviderDeduplicator(fake).discover(None))
    return [c.name for c in out]


# ---------------------------------------------------------------------------
# Class 1 — same exact Maps place.
#
# The realistic production shape: Google Maps' own grid/tile sub-area
# coverage (or paginated traversal crossing a boundary) yields the
# SAME place twice within one discover() call. GoogleMapsProvider
# never populates provider_business_id or coordinates (see that
# module's docstring), and a repeat Maps listing frequently has no
# phone or website either — so the ONLY thing two such records
# reliably share is the Maps URL/place id. This is exactly the gap
# Phase 40 closed.
# ---------------------------------------------------------------------------
class TestClass1SameExactMapsPlace:
    def test_same_place_id_embedded_in_different_maps_urls_is_deduplicated(self):
        # Two different raw URL shapes Google Maps can hand back for the
        # identical place (different query params / path), both
        # embedding the same ChIJ... place id.
        first = _candidate(
            provider="google_maps",
            name="Rosa's Bakery",
            maps_url="https://www.google.com/maps/place/?q=place_id:ChIJunrelated999",
        )
        # Simulate the same place resurfacing via a grid/tile overlap:
        # identical ChIJ token, different surrounding URL noise, and —
        # realistically — no phone/website on this second sighting.
        second = _candidate(
            provider="google_maps",
            name="Rosa's Bakery",
            maps_url="https://maps.google.com/?cid=999&q=ChIJN1t_tDeuEmsRUsoyG83frY4",
        )
        third = _candidate(
            provider="google_maps",
            name="Rosa's Bakery",
            maps_url="https://www.google.com/maps/search/?api=1&query=ChIJN1t_tDeuEmsRUsoyG83frY4",
        )
        # `first` has no extractable ChIJ.../hex place id in its URL
        # (a synthetic @lat,lng data-block shape), so it stays
        # distinct; `second` and `third` both embed the identical
        # place id ChIJN1t_tDeuEmsRUsoyG83frY4 and must collapse to
        # one — first occurrence wins.
        deduped = list(
            ProviderDeduplicator(_FakeProvider("gm", [first, second, third])).discover(None)
        )
        assert len(deduped) == 2, [c.pipeline_id for c in deduped]
        assert deduped[0].pipeline_id == first.pipeline_id
        assert deduped[1].pipeline_id == second.pipeline_id  # first occurrence wins

    def test_repeated_place_within_single_provider_stream_is_dropped(self):
        """The specific waste pattern the audit named: the SAME
        provider re-yields the SAME Maps place more than once in one
        run (grid/tile overlap), with no phone/website on the repeat —
        i.e. the only signal available is the Maps place id."""
        a = _candidate(
            provider="google_maps", name="Nova Fitness",
            maps_url="https://www.google.com/maps/place/?q=place_id:ChIJabc123XYZ",
        )
        b = _candidate(
            provider="google_maps", name="Nova Fitness",
            maps_url="https://www.google.com/maps/place/?q=place_id:ChIJabc123XYZ",
        )
        out = list(ProviderDeduplicator(_FakeProvider("google_maps", [a, b])).discover(None))
        assert len(out) == 1
        assert out[0].pipeline_id == a.pipeline_id

    def test_maps_link_without_extractable_place_id_still_dedupes(self):
        """Fallback key: when no ChIJ/hex place id is embedded, the
        cleaned whole link is still used as identity (mirrors
        storage/early_persistent_dedup.py's own map: fallback)."""
        a = _candidate(
            provider="google_maps", name="Echo Studio",
            maps_url="https://www.google.com/maps/place/Echo+Studio/@1,2,3z?extra=1",
        )
        b = _candidate(
            provider="google_maps", name="Echo Studio",
            maps_url="https://www.google.com/maps/place/Echo+Studio/@1,2,3z?extra=2",
        )
        out = list(ProviderDeduplicator(_FakeProvider("google_maps", [a, b])).discover(None))
        assert len(out) == 1
        assert out[0].pipeline_id == a.pipeline_id

    def test_different_maps_places_are_not_collapsed(self):
        a = _candidate(
            provider="google_maps", name="Store A",
            maps_url="https://www.google.com/maps/place/?q=place_id:ChIJaaaa111",
        )
        b = _candidate(
            provider="google_maps", name="Store B",
            maps_url="https://www.google.com/maps/place/?q=place_id:ChIJbbbb222",
        )
        out = _dedup_names([a, b])
        assert out == ["Store A", "Store B"]


# ---------------------------------------------------------------------------
# Class 2 — URL-normalization duplicates (scheme/www/path/query noise
# around an otherwise identical website).
# ---------------------------------------------------------------------------
class TestClass2UrlNormalizationDuplicates:
    def test_website_variants_normalize_to_the_same_identity(self):
        a = _candidate(name="Nova Fitness", address="9 Loop Rd",
                        website="https://www.novafitness.com/home")
        b = _candidate(name="Nova Fitness", address="9 Loop Rd",
                        website="novafitness.com")
        c = _candidate(name="Nova Fitness", address="9 Loop Rd",
                        website="http://novafitness.com/")
        out = _dedup_names([a, b, c])
        assert out == ["Nova Fitness"]

    def test_different_domains_are_not_collapsed(self):
        a = _candidate(name="Nova Fitness", address="9 Loop Rd", website="novafitness.com")
        b = _candidate(name="Nova Fitness East", address="9 Loop Rd", website="novafitness-east.com")
        out = _dedup_names([a, b])
        assert len(out) == 2


# ---------------------------------------------------------------------------
# Class 3 — phone duplicates (punctuation/formatting/country-code noise).
# ---------------------------------------------------------------------------
class TestClass3PhoneDuplicates:
    def test_phone_formatting_variants_normalize_to_the_same_identity(self):
        a = _candidate(name="Rosa's Bakery", address="100 Main St", phone="(555) 123-4567")
        b = _candidate(name="Rosa's Bakery", address="100 Main St", phone="555-123-4567")
        c = _candidate(name="Rosa's Bakery", address="100 Main St", phone="+1 555.123.4567")
        out = _dedup_names([a, b, c])
        assert out == ["Rosa's Bakery"]

    def test_different_phone_numbers_are_not_collapsed(self):
        a = _candidate(name="Rosa's Bakery", address="100 Main St", phone="555-123-4567")
        b = _candidate(name="Rosa's Diner", address="200 Main St", phone="555-999-0000")
        out = _dedup_names([a, b])
        assert len(out) == 2


# ---------------------------------------------------------------------------
# Class 4 — name/address normalization duplicates (case, punctuation,
# whitespace, "&" vs "and").
# ---------------------------------------------------------------------------
class TestClass4NameAddressNormalizationDuplicates:
    def test_case_and_punctuation_variants_normalize_to_the_same_identity(self):
        # Case, trailing punctuation, and whitespace-collapsing noise
        # only — `_normalize_text` deliberately does not stem or
        # rewrite words (e.g. "&" vs "and" are NOT treated as
        # equivalent; see that helper's own docstring), so this test
        # sticks to noise that genuinely is punctuation/whitespace.
        a = _candidate(name="Rosa's Bakery", address="100 Main St.")
        b = _candidate(name="ROSA'S   BAKERY", address="100  Main St")
        out = _dedup_names([a, b])
        assert out == ["Rosa's Bakery"]

    def test_same_name_different_address_is_not_collapsed(self):
        """Different physical locations of a name-alike business
        (or two unrelated businesses that happen to share a name)
        must remain distinct — name alone is never a match key."""
        a = _candidate(name="Joe's Pizza", address="200 Broadway")
        b = _candidate(name="Joe's Pizza", address="4500 Park Ave")
        out = _dedup_names([a, b])
        assert len(out) == 2


# ---------------------------------------------------------------------------
# Class 5 — provider cross-duplicates (same real business surfaced by
# two or more different discovery providers).
# ---------------------------------------------------------------------------
class TestClass5ProviderCrossDuplicates:
    def test_duplicate_across_two_providers_matched_by_phone(self):
        first = _candidate(provider="google_maps", name="Rosa's Bakery",
                            address="100 Main St", phone="(555) 123-4567")
        second = _candidate(provider="yelp", name="Rosa's Bakery",
                             address="100 Main St", phone="555-123-4567")
        composite = CompositeDiscoveryProvider(
            [_FakeProvider("google_maps", [first]), _FakeProvider("yelp", [second])]
        )
        out = list(
            ProviderDeduplicator(composite).discover(
                CompositeDiscoveryRequest(requests={"google_maps": None, "yelp": None})
            )
        )
        assert len(out) == 1
        assert out[0].pipeline_id == first.pipeline_id  # first occurrence wins

    def test_provider_specific_maps_url_shape_does_not_bypass_dedup(self):
        """PHASE 40 requirement: 'provider-specific differences must
        not bypass canonical dedup.' Two providers describing the same
        real place, one via a Maps place id, the other via matching
        name+address, must still collapse to one."""
        gmaps = _candidate(
            provider="google_maps", name="Blue Harbor Seafood", address="55 Dock Ln",
            maps_url="https://www.google.com/maps/place/?q=place_id:ChIJharbor000",
        )
        other = _candidate(
            provider="yelp", name="Blue Harbor Seafood", address="55 Dock Ln",
        )
        composite = CompositeDiscoveryProvider(
            [_FakeProvider("google_maps", [gmaps]), _FakeProvider("yelp", [other])]
        )
        out = list(
            ProviderDeduplicator(composite).discover(
                CompositeDiscoveryRequest(requests={"google_maps": None, "yelp": None})
            )
        )
        assert len(out) == 1
        assert out[0].pipeline_id == gmaps.pipeline_id


# ---------------------------------------------------------------------------
# Class 6 — legitimate separate businesses must NOT be collapsed
# (multi-location chains, coincidental name collisions, insufficient
# shared data).
# ---------------------------------------------------------------------------
class TestClass6LegitimateSeparateBusinessesRemainDistinct:
    def test_multi_location_chain_with_distinct_addresses_stays_distinct(self):
        loc_a = _candidate(name="Coffee Co", address="1 First Ave", city="Austin",
                            maps_url="https://www.google.com/maps/place/?q=place_id:ChIJaustin1")
        loc_b = _candidate(name="Coffee Co", address="2 Second Ave", city="Austin",
                            maps_url="https://www.google.com/maps/place/?q=place_id:ChIJaustin2")
        loc_c = _candidate(name="Coffee Co", address="99 Riverwalk", city="San Antonio",
                            maps_url="https://www.google.com/maps/place/?q=place_id:ChIJsatx1")
        out = _dedup_names([loc_a, loc_b, loc_c])
        assert out == ["Coffee Co", "Coffee Co", "Coffee Co"]

    def test_insufficient_data_candidate_is_kept_not_dropped(self):
        """A candidate with only a bare name (no phone/website/
        address/maps_url/coordinates) produces an empty key set and
        must never be treated as anyone's duplicate."""
        bare = _candidate(name="Joe's Pizza")
        other = _candidate(name="Joe's Pizza", address="200 Broadway")
        out = _dedup_names([bare, other])
        assert len(out) == 2

    def test_first_occurrence_wins_without_merging_fields(self):
        sparse_first = _candidate(name="Blue Harbor Seafood", address="55 Dock Ln", phone="555-7777")
        richer_second = _candidate(
            name="Blue Harbor Seafood", address="55 Dock Ln", phone="555-7777",
            rating=4.7, review_count=812, category="Seafood",
        )
        out = list(
            ProviderDeduplicator(_FakeProvider("multi", [sparse_first, richer_second])).discover(None)
        )
        assert len(out) == 1
        assert out[0] is sparse_first
        assert out[0].rating is None  # no enrichment/merging from the dropped duplicate


# ---------------------------------------------------------------------------
# compose_discovery() wiring — PHASE 40 fix 2: a single selected
# provider must now also be wrapped in ProviderDeduplicator (the
# earlier "no cross-provider, so skip" reasoning missed that a single
# provider's own repeated rows are a real duplicate source).
# ---------------------------------------------------------------------------
class TestComposeDiscoverySingleProviderIsNowDeduplicated:
    def test_single_selected_provider_is_wrapped_in_provider_deduplicator(self, monkeypatch):
        for env_var in (
            "YELP_API_KEY", "APPLE_MAPS_ACCESS_TOKEN", "FOURSQUARE_API_KEY",
            "AZURE_MAPS_SUBSCRIPTION_KEY", "CRUNCHBASE_API_KEY", "APOLLO_API_KEY",
        ):
            monkeypatch.delenv(env_var, raising=False)

        # No niche => no Overpass OSM-tag match => google_maps alone
        # (the exact single-provider shape this fix targets).
        composed = compose_discovery(
            session_id="s1", query="anything", city="Austin",
            country="US", max_results=10,
        )
        assert composed.selected_provider_ids == ("google_maps",)
        assert isinstance(composed.provider, TargetAwareDiscoveryProvider)

        # Walk through the TargetAwareDiscoveryProvider wrapper to
        # confirm ProviderDeduplicator is present in the chain.
        inner = composed.provider.wrapped
        assert isinstance(inner, ProviderDeduplicator), (
            "single-provider composition must still be wrapped in "
            "ProviderDeduplicator (Phase 40) — got "
            f"{type(inner).__name__ if inner is not None else None}"
        )

    def test_single_provider_repeated_candidates_are_still_deduplicated_end_to_end(self, monkeypatch):
        """End-to-end proof: with only google_maps selected, a
        repeated Maps place (the realistic grid/tile overlap shape)
        is dropped before it would ever reach enrichment."""
        for env_var in (
            "YELP_API_KEY", "APPLE_MAPS_ACCESS_TOKEN", "FOURSQUARE_API_KEY",
            "AZURE_MAPS_SUBSCRIPTION_KEY", "CRUNCHBASE_API_KEY", "APOLLO_API_KEY",
        ):
            monkeypatch.delenv(env_var, raising=False)

        repeat_a = _candidate(
            provider="google_maps", name="Nova Fitness",
            maps_url="https://www.google.com/maps/place/?q=place_id:ChIJrepeat1",
        )
        repeat_b = _candidate(
            provider="google_maps", name="Nova Fitness",
            maps_url="https://www.google.com/maps/place/?q=place_id:ChIJrepeat1",
        )

        composed = compose_discovery(
            session_id="s1", query="anything", city="Austin", country="US",
            max_results=10,
            google_maps_factory=lambda: _FakeProvider("google_maps", [repeat_a, repeat_b]),
        )
        assert composed.selected_provider_ids == ("google_maps",)
        out = list(composed.provider.discover(composed.request))
        assert len(out) == 1
        assert out[0].pipeline_id == repeat_a.pipeline_id
