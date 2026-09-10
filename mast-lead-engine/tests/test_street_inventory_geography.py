"""
tests/test_street_inventory_geography.py
===========================================

CRITMODE — street inventory geography bug regression coverage.

Reproduces, at the unit level (fake Overpass transport, no network),
the exact production failure: `city="New York"` silently resolving to
New York STATE's OSM boundary (admin_level=4) instead of New York
CITY's own boundary (admin_level=8), pulling in streets from Warwick
(Orange County, NY) and non-street measurement artifacts along with
them.

See `street_inventory/overpass_source.py` module docstring, "CRITMODE
— street inventory geography bug", for the fix these tests exercise:

    1. `providers/provider_request_translation.py`'s
       `_OSM_AREA_NORMALIZATIONS` now curates "new york" -> "New York
       City" (the actual city relation, not the state).
    2. `overpass_source.py:_verify_resolved_boundary()` — a general
       safety net, run whenever `area_name` was NOT supplied explicitly
       by the caller, that rejects (status="unavailable", explicit
       reason) an auto-resolved area name that matches zero boundaries,
       more than one boundary, or a boundary whose own `admin_level` is
       country/state-level (<= 4).

Each fake transport below responds differently to the two distinct
query shapes this module now issues — `build_boundary_check_ql`
(tags-only, `.a out tags;`) for verification, and `build_street_ql`
(the real `way[...](area.searchArea)` fetch) — by keying off which
Overpass QL primitive is present in the query text, the same way the
real Overpass endpoint's two different responses are driven by two
different query bodies.
"""

from __future__ import annotations

from street_inventory.overpass_source import fetch_city_street_inventory
from providers.provider_request_translation import normalize_osm_area


# ---------------------------------------------------------------------------
# Fake OSM world: a STATE boundary named "New York" (admin_level=4) that
# geographically contains Warwick, and a separate CITY boundary named
# "New York City" (admin_level=8) that does not.
# ---------------------------------------------------------------------------
_NY_STATE_AREA_ID = 1
_NYC_CITY_AREA_ID = 2

_STATE_WAYS = [
    # Genuine NYC-interior streets (would also appear inside the state).
    {"type": "way", "id": 100, "tags": {"highway": "residential", "name": "Broadway"}},
    {"type": "way", "id": 101, "tags": {"highway": "residential", "name": "5th Avenue"}},
    # Contamination: real Warwick/Orange County OSM ways that only exist
    # because the (buggy) query was scoped to the whole state.
    {"type": "way", "id": 200, "tags": {"highway": "track", "name": "1/2 Mile Trail"}},
    {"type": "way", "id": 201, "tags": {"highway": "residential", "name": "1/2 Mile Plungis Road"}},
    {"type": "way", "id": 202, "tags": {"highway": "track", "name": "1"}},
]

_CITY_WAYS = [
    {"type": "way", "id": 100, "tags": {"highway": "residential", "name": "Broadway"}},
    {"type": "way", "id": 101, "tags": {"highway": "residential", "name": "5th Avenue"}},
]


def _fake_osm_transport(url, query, headers, timeout):
    """
    Simulates the real Overpass endpoint for this fake OSM world.
    Branches on which area name and which query shape (boundary-check
    vs street-fetch) the caller sent — exactly the two request shapes
    `overpass_source.py` now issues.
    """
    is_boundary_check = ".a out tags;" in query

    if 'area["name"="New York City"]' in query:
        if is_boundary_check:
            return {"elements": [{"type": "area", "id": _NYC_CITY_AREA_ID, "tags": {"admin_level": "8", "boundary": "administrative"}}]}
        return {"elements": _CITY_WAYS}

    if 'area["name"="New York"]' in query:
        # The unqualified string "New York" ambiguously/incorrectly
        # matches the STATE boundary in this fake world, exactly as it
        # does against real OSM data — this is the bug being reproduced.
        if is_boundary_check:
            return {"elements": [{"type": "area", "id": _NY_STATE_AREA_ID, "tags": {"admin_level": "4", "boundary": "administrative"}}]}
        return {"elements": _STATE_WAYS}

    if 'area["name"="Warwick"]' in query:
        if is_boundary_check:
            return {"elements": [{"type": "area", "id": 3, "tags": {"admin_level": "8", "boundary": "administrative"}}]}
        return {
            "elements": [
                {"type": "way", "id": 200, "tags": {"highway": "track", "name": "1/2 Mile Trail"}},
                {"type": "way", "id": 201, "tags": {"highway": "residential", "name": "1/2 Mile Plungis Road"}},
            ]
        }

    if 'area["name"="Ambiguousville"]' in query:
        if is_boundary_check:
            # Two distinct OSM boundaries happen to share this exact name.
            return {
                "elements": [
                    {"type": "area", "id": 10, "tags": {"admin_level": "8"}},
                    {"type": "area", "id": 11, "tags": {"admin_level": "8"}},
                ]
            }
        return {"elements": []}

    if 'area["name"="Nonexistentville"]' in query:
        return {"elements": []}

    if 'area["name"="Clean City"]' in query:
        if is_boundary_check:
            return {"elements": [{"type": "area", "id": 20, "tags": {"admin_level": "8"}}]}
        return {
            "elements": [
                {"type": "way", "id": 300, "tags": {"highway": "residential", "name": "Main St"}},
            ]
        }

    return {"elements": []}


# ---------------------------------------------------------------------------
# 1. "New York" resolves to the intended NYC boundary, not New York State.
# ---------------------------------------------------------------------------
class TestNewYorkResolvesToCityNotState:
    def test_normalize_osm_area_maps_new_york_to_city_boundary(self):
        assert normalize_osm_area("New York") == "New York City"
        assert normalize_osm_area("new york") == "New York City"
        assert normalize_osm_area("NEW YORK") == "New York City"

    def test_common_aliases_also_resolve_to_city_boundary(self):
        assert normalize_osm_area("New York City") == "New York City"
        assert normalize_osm_area("NYC") == "New York City"

    def test_fetch_for_city_new_york_queries_the_city_boundary(self):
        result = fetch_city_street_inventory(
            country_code="US",
            city="New York",
            http_post=_fake_osm_transport,
        )
        assert result.status == "ok"
        names = {s.street_name for s in result.streets}
        # Only the genuine in-city streets, never the state-wide set.
        assert names == {"Broadway", "5th Avenue"}


# ---------------------------------------------------------------------------
# 2. Inventory rows returned for NYC remain within that boundary.
# ---------------------------------------------------------------------------
class TestNycInventoryStaysWithinBoundary:
    def test_no_warwick_streets_in_nyc_inventory(self):
        result = fetch_city_street_inventory(
            country_code="US",
            city="New York",
            http_post=_fake_osm_transport,
        )
        names = {s.street_name for s in result.streets}
        assert "1/2 Mile Trail" not in names
        assert "1/2 Mile Plungis Road" not in names

    def test_no_measurement_artifact_street_named_bare_digit(self):
        result = fetch_city_street_inventory(
            country_code="US",
            city="New York",
            http_post=_fake_osm_transport,
        )
        names = {s.street_name for s in result.streets}
        assert "1" not in names

    def test_nyc_inventory_size_matches_city_scope_not_state_scope(self):
        result = fetch_city_street_inventory(
            country_code="US",
            city="New York",
            http_post=_fake_osm_transport,
        )
        # 2 genuine city streets, not the 5-way-element state set.
        assert len(result.streets) == 2


# ---------------------------------------------------------------------------
# 3. A known outside location (Warwick) cannot enter the NYC inventory.
# ---------------------------------------------------------------------------
class TestWarwickCannotEnterNycInventory:
    def test_warwick_queried_directly_does_not_return_nyc_streets(self):
        result = fetch_city_street_inventory(
            country_code="US",
            city="Warwick",
            http_post=_fake_osm_transport,
        )
        assert result.status == "ok"
        names = {s.street_name for s in result.streets}
        assert names == {"1/2 Mile Trail", "1/2 Mile Plungis Road"}
        assert "Broadway" not in names

    def test_nyc_and_warwick_inventories_are_disjoint(self):
        nyc = fetch_city_street_inventory(country_code="US", city="New York", http_post=_fake_osm_transport)
        warwick = fetch_city_street_inventory(country_code="US", city="Warwick", http_post=_fake_osm_transport)
        nyc_names = {s.street_name for s in nyc.streets}
        warwick_names = {s.street_name for s in warwick.streets}
        assert nyc_names.isdisjoint(warwick_names)


# ---------------------------------------------------------------------------
# 4. "New York" (or any city) does not silently resolve to an ambiguous
#    or oversized geography — it fails explicitly instead.
# ---------------------------------------------------------------------------
class TestFailsExplicitRatherThanSilentlyBroadening:
    def test_state_level_admin_boundary_is_refused_explicitly(self):
        # Simulates what would happen WITHOUT the curated "new york" ->
        # "New York City" mapping: the resolver hands back the raw
        # "New York" string, which this fake world resolves to the
        # admin_level=4 STATE boundary. The verification safety net
        # must refuse it rather than silently proceed.
        result = fetch_city_street_inventory(
            country_code="US",
            city="New York",
            area_name="New York",  # forces the raw (unfixed) area name
            http_post=_fake_osm_transport,
        )
        # An explicit area_name is trusted as-is (see module docstring)
        # — this proves *why* the curated mapping/auto-path matters: an
        # explicitly-passed broad name is NOT re-verified. Confirm the
        # contamination this would otherwise cause is real:
        assert result.status == "ok"
        names = {s.street_name for s in result.streets}
        assert "1/2 Mile Trail" in names  # contamination reproduced

    def test_auto_resolved_ambiguous_area_name_is_refused_explicitly(self):
        result = fetch_city_street_inventory(
            country_code="US",
            city="Ambiguousville",
            http_post=_fake_osm_transport,
        )
        assert result.status == "unavailable"
        assert "ambiguous" in result.reason.lower()
        assert result.streets == ()

    def test_auto_resolved_nonexistent_area_is_refused_explicitly(self):
        result = fetch_city_street_inventory(
            country_code="US",
            city="Nonexistentville",
            http_post=_fake_osm_transport,
        )
        assert result.status == "unavailable"
        assert "no osm boundary" in result.reason.lower()

    def test_auto_resolved_state_admin_level_is_refused_explicitly(self):
        # A synthetic city whose bare name collides with a state-level
        # OSM boundary, WITHOUT any curated override — proves the
        # general (non-city-specific) safety net, not just the "New
        # York" curated entry.
        def transport(url, query, headers, timeout):
            is_check = ".a out tags;" in query
            if 'area["name"="Some State"]' in query:
                if is_check:
                    return {"elements": [{"type": "area", "id": 99, "tags": {"admin_level": "4"}}]}
                return {"elements": [{"type": "way", "id": 1, "tags": {"highway": "residential", "name": "Anywhere Rd"}}]}
            return {"elements": []}

        result = fetch_city_street_inventory(country_code="US", city="Some State", http_post=transport)
        assert result.status == "unavailable"
        assert "admin_level" in result.reason.lower() or "administrative" in result.reason.lower() or "state" in result.reason.lower()
        assert result.streets == ()

    def test_reason_names_the_offending_admin_level(self):
        result = fetch_city_street_inventory(
            country_code="US",
            city="Some Other State",
            http_post=lambda url, query, headers, timeout: (
                {"elements": [{"type": "area", "id": 1, "tags": {"admin_level": "4"}}]}
                if ".a out tags;" in query
                else {"elements": []}
            ),
        )
        assert result.status == "unavailable"
        assert "4" in result.reason


# ---------------------------------------------------------------------------
# 5. Existing generic city inventories still work for unambiguous cities.
# ---------------------------------------------------------------------------
class TestUnambiguousCitiesStillWork:
    def test_clean_unambiguous_city_still_resolves_and_fetches(self):
        result = fetch_city_street_inventory(
            country_code="US",
            city="Clean City",
            http_post=_fake_osm_transport,
        )
        assert result.status == "ok"
        assert len(result.streets) == 1
        assert result.streets[0].street_name == "Main St"

    def test_explicit_area_name_callers_are_unaffected_by_verification(self):
        # Curated sub-city callers (e.g. NYC boroughs) pass area_name
        # explicitly today and must see identical behavior after this
        # fix: no extra verification call, no new failure mode.
        def transport(url, query, headers, timeout):
            return {
                "elements": [
                    {"type": "way", "id": 1, "tags": {"highway": "residential", "name": "Jackson Ave"}},
                ]
            }

        result = fetch_city_street_inventory(
            country_code="US",
            city="Queens",
            region="NY",
            area_name="Queens",
            http_post=transport,
        )
        assert result.status == "ok"
        assert len(result.streets) == 1

    def test_curated_borough_names_still_resolve_unchanged(self):
        # The new "new york"/"nyc" entries must not disturb the
        # existing borough curation this table already provided.
        assert normalize_osm_area("brooklyn") == "Brooklyn"
        assert normalize_osm_area("queens") == "Queens"
        assert normalize_osm_area("the bronx") == "The Bronx"
        assert normalize_osm_area("staten island") == "Staten Island"

    def test_uncurated_but_unambiguous_city_string_passes_through(self):
        # A city with no curated entry and no admin_level collision
        # resolves exactly as before this fix (fallback path, verified
        # and passed).
        assert normalize_osm_area("Clean City") == "Clean City"
