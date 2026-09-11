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

from street_inventory.overpass_source import fetch_city_street_inventory, build_relation_boundary_ql
from providers.provider_request_translation import normalize_osm_area


# ---------------------------------------------------------------------------
# Fake OSM world: a STATE boundary named "New York" (admin_level=4) that
# geographically contains Warwick, and a separate CITY boundary named
# "New York City" (admin_level=8) that does not.
# ---------------------------------------------------------------------------
# CRITMODE — way-derived area ID fix, single-match gap: these fixture IDs
# must be realistic Overpass relation-derived area ids (>= 3600000000),
# not small arbitrary integers — the way-derived check now runs on this
# flat/unambiguous path too (see overpass_source.py), and a small integer
# here would be (correctly) treated as a way-derived id lacking polygon
# geometry, not as the well-formed administrative boundary these fixtures
# intend to represent.
_NY_STATE_AREA_ID = 3_600_000_001
_NYC_CITY_AREA_ID = 3_600_000_002

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
            return {"elements": [{"type": "area", "id": 3_600_000_003, "tags": {"admin_level": "8", "boundary": "administrative"}}]}
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
            return {"elements": [{"type": "area", "id": 3_600_000_020, "tags": {"admin_level": "8"}}]}
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
                    return {"elements": [{"type": "area", "id": 3_600_000_099, "tags": {"admin_level": "4"}}]}
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
                {"elements": [{"type": "area", "id": 3_600_000_001, "tags": {"admin_level": "4"}}]}
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


# ---------------------------------------------------------------------------
# 6. CRITMODE follow-up -- region="NY" alone did not disambiguate the real
#    "New York City" name collision (2 distinct OSM boundaries share that
#    exact name). See overpass_source.py module docstring, "CRITMODE
#    follow-up", and _resolve_area_scope() for the fix these tests
#    exercise: region + country_code now build a real OSM ISO3166-2
#    subdivision code ("US-NY") used to narrow an ambiguous name match to
#    the boundary actually inside the caller's own state/province --
#    generically, with no per-city table.
# ---------------------------------------------------------------------------
def _fake_osm_transport_with_region_collision(url, query, headers, timeout):
    """
    A second fake OSM world: "New York City" (unlike the module's other
    fake world above) matches TWO distinct real boundaries by name alone
    -- id 2, a way-derived area pseudo-element (NOT the real
    administrative boundary relation), and id 9, another way-derived
    area. Narrowing the match to "US-NY" yields exactly area id 2 —
    but since id 2 < 3600000000 (way-derived), it lacks polygon geometry
    for spatial containment. The fix queries for the actual administrative
    boundary RELATION: id 175905, whose computed Overpass area id is
    3600000000 + 175905 = 3600175905. The street fetch targets that id.
    """
    is_check = ".a out tags;" in query
    has_ny_subdivision = 'ISO3166-2"="US-NY"' in query

    # --- Area-based boundary checks (existing behavior) ---
    if is_check and 'area["name"="New York City"]' in query:
        if has_ny_subdivision:
            # Narrowed to NY state: only one way-derived area lies inside.
            return {"elements": [{"type": "area", "id": 2, "tags": {"admin_level": "8", "boundary": "administrative"}}]}
        # Flat name match: genuinely 2 distinct boundaries share this name.
        return {
            "elements": [
                {"type": "area", "id": 2, "tags": {"admin_level": "8", "boundary": "administrative"}},
                {"type": "area", "id": 9, "tags": {"admin_level": "8", "boundary": "administrative"}},
            ]
        }

    # --- Relation-boundary fallback (way-derived area ID fix) ---
    # When the area check returns a way-derived id (< 3600000000), the
    # fix queries for the actual `relation["boundary"="administrative"]`.
    if 'relation["name"="New York City"]["boundary"="administrative"]' in query:
        if has_ny_subdivision:
            return {"elements": [{"type": "relation", "id": 175905, "tags": {"admin_level": "8", "boundary": "administrative", "name": "New York City"}}]}
        return {"elements": []}

    # --- Street fetch using the relation-derived area id ---
    # 3600000000 + 175905 = 3600175905
    if "area(3600175905)->.searchArea;" in query:
        return {"elements": [{"type": "way", "id": 100, "tags": {"highway": "residential", "name": "Broadway"}}]}

    return {"elements": []}


class TestRegionDisambiguatesGenuineNameCollision:
    def test_us_ny_new_york_resolves_to_correct_nyc_boundary(self):
        # The exact reported failure: country=US city="New York" region=NY
        # must no longer be rejected as ambiguous -- it must deterministically
        # select the NYC boundary contained in NY state.
        result = fetch_city_street_inventory(
            country_code="US",
            city="New York",
            region="NY",
            http_post=_fake_osm_transport_with_region_collision,
        )
        assert result.status == "ok"
        assert {s.street_name for s in result.streets} == {"Broadway"}

    def test_without_region_the_same_collision_is_still_rejected(self):
        # No region supplied -> no disambiguation is even attempted;
        # behavior must fall back to the pre-existing ambiguity rejection,
        # never silently pick one of the two boundaries.
        result = fetch_city_street_inventory(
            country_code="US",
            city="New York",
            http_post=_fake_osm_transport_with_region_collision,
        )
        assert result.status == "unavailable"
        assert "ambiguous" in result.reason.lower()
        assert result.streets == ()

    def test_genuinely_ambiguous_city_is_still_rejected_even_with_region(self):
        # A city whose two same-named boundaries are BOTH inside the
        # supplied region -- narrowing by subdivision cannot disambiguate
        # a real, unresolved ambiguity, and must not paper over it.
        def transport(url, query, headers, timeout):
            is_check = ".a out tags;" in query
            if 'area["name"="Twin City"]' in query:
                # Same 2-element response regardless of whether the
                # ISO3166-2 narrowing clause is present -- both boundaries
                # are genuinely inside the same state.
                if is_check:
                    return {
                        "elements": [
                            {"type": "area", "id": 30, "tags": {"admin_level": "8"}},
                            {"type": "area", "id": 31, "tags": {"admin_level": "8"}},
                        ]
                    }
                return {"elements": []}
            return {"elements": []}

        result = fetch_city_street_inventory(
            country_code="US",
            city="Twin City",
            region="MN",
            http_post=transport,
        )
        assert result.status == "unavailable"
        assert "ambiguous" in result.reason.lower()
        assert result.streets == ()

    def test_region_narrowed_match_still_rejects_state_level_boundary(self):
        # Even after region-based narrowing produces exactly one match,
        # the existing admin_level safety net still applies -- narrowing
        # must not become a way to bypass the state/country-level check.
        def transport(url, query, headers, timeout):
            is_check = ".a out tags;" in query
            has_subdivision = 'ISO3166-2"="US-NY"' in query
            if 'area["name"="Some Region City"]' in query:
                if has_subdivision:
                    if is_check:
                        # Narrowing "succeeds" (exactly one match) but that
                        # match is itself a state-level boundary.
                        return {"elements": [{"type": "area", "id": 40, "tags": {"admin_level": "4"}}]}
                    return {"elements": []}
                # Flat match: ambiguous, forcing the narrowing attempt.
                if is_check:
                    return {
                        "elements": [
                            {"type": "area", "id": 40, "tags": {"admin_level": "4"}},
                            {"type": "area", "id": 41, "tags": {"admin_level": "8"}},
                        ]
                    }
                return {"elements": []}
            return {"elements": []}

        result = fetch_city_street_inventory(
            country_code="US",
            city="Some Region City",
            region="NY",
            http_post=transport,
        )
        assert result.status == "unavailable"
        assert "4" in result.reason
        assert result.streets == ()

    def test_explicit_area_name_is_unaffected_by_region_disambiguation(self):
        # Explicit area_name still skips verification entirely, region or
        # not -- an explicit area_name is caller-vetted (unchanged from
        # before this fix). Confirm no ISO3166-2 narrowing query is ever
        # issued for this path.
        calls = []

        def transport(url, query, headers, timeout):
            calls.append(query)
            return {
                "elements": [
                    {"type": "way", "id": 1, "tags": {"highway": "residential", "name": "Main St"}},
                ]
            }

        result = fetch_city_street_inventory(
            country_code="US",
            city="New York",
            region="NY",
            area_name="New York City",
            http_post=transport,
        )
        assert result.status == "ok"
        assert len(result.streets) == 1
        assert len(calls) == 1  # only the real street fetch -- no verification call at all
        assert "ISO3166-2" not in calls[0]

    def test_region_that_is_a_full_name_not_a_code_skips_disambiguation(self):
        # A region value that looks like a full subdivision name rather
        # than a short code ("New York" instead of "NY") must not be
        # guessed into a bogus ISO3166-2 filter -- disambiguation is
        # skipped and the original ambiguity rejection still applies.
        result = fetch_city_street_inventory(
            country_code="US",
            city="New York",
            region="New York",  # full name, not a code
            http_post=_fake_osm_transport_with_region_collision,
        )
        assert result.status == "unavailable"
        assert "ambiguous" in result.reason.lower()


# ---------------------------------------------------------------------------
# 7. CRITMODE — NYC region-disambiguated fetch returning 0 streets.
#
# Reproduces, at the unit level, the exact production failure: geography
# resolution succeeds (city="New York" -> area="New York City"), boundary
# verification succeeds and narrows the name collision to subdivision
# "US-NY", and yet the real street-fetch query came back with
# `elements=0 streets=0`. See `overpass_source.py` module docstring,
# "CRITMODE — NYC region-disambiguated fetch returning 0 streets", and
# `build_street_ql()`'s own docstring for the fix these tests exercise:
# the street fetch now targets the verified boundary's concrete numeric
# `area_id` (`area(<id>)->.searchArea;`) instead of re-deriving the same
# name+region filter chain a second time.
# ---------------------------------------------------------------------------
class TestRegionDisambiguatedFetchUsesVerifiedAreaId:
    def test_us_ny_new_york_resolves_to_nyc(self):
        # 1. country=US + region=NY + city="New York" resolves to the
        #    NYC boundary, not the state, and not an ambiguity rejection.
        from providers.provider_request_translation import normalize_osm_area

        assert normalize_osm_area("New York") == "New York City"
        result = fetch_city_street_inventory(
            country_code="US",
            city="New York",
            region="NY",
            http_post=_fake_osm_transport_with_region_collision,
        )
        assert result.status == "ok"

    def test_street_fetch_query_targets_the_verified_nyc_area_id(self):
        # 2. The resulting street-fetch query targets the correct NYC
        #    boundary by its verified concrete area id, not a
        #    re-derived name/region filter chain (which is what
        #    silently produced 0 elements in production).
        calls = []

        def transport(url, query, headers, timeout):
            calls.append(query)
            return _fake_osm_transport_with_region_collision(url, query, headers, timeout)

        fetch_city_street_inventory(
            country_code="US",
            city="New York",
            region="NY",
            http_post=transport,
        )
        street_fetch_calls = [q for q in calls if 'way["highway"]' in q]
        assert len(street_fetch_calls) == 1
        street_query = street_fetch_calls[0]
        assert "area(3600175905)->.searchArea;" in street_query
        # Must not re-derive the boundary via name+region a second time.
        assert 'area["name"="New York City"]' not in street_query
        assert "ISO3166-2" not in street_query

    def test_successful_overpass_street_response_produces_nonzero_streets(self):
        # 3. A representative successful Overpass street response (keyed
        #    on the verified area id) produces >0 streets -- the exact
        #    condition that failed in production (elements=0 streets=0).
        result = fetch_city_street_inventory(
            country_code="US",
            city="New York",
            region="NY",
            http_post=_fake_osm_transport_with_region_collision,
        )
        assert result.status == "ok"
        assert len(result.streets) > 0
        assert {s.street_name for s in result.streets} == {"Broadway"}


# ---------------------------------------------------------------------------
# 8. CRITMODE — way-derived area ID fix, single-match gap.
#
# Reproduces the exact production failure from the follow-up investigation:
# unlike section 6/7 above (a genuine 2-way name collision, disambiguated
# via ISO3166-2 region narrowing), this is the FLAT, never-ambiguous case
# -- the `area["name"=resolved_area]` boundary check matches exactly ONE
# boundary on the very first try, no region narrowing ever runs, and that
# one match is itself way-derived (area id < 3600000000, no closed polygon
# geometry). Before this fix, the way-derived check + administrative-
# relation fallback only ever ran inside the `len(elements) > 1` narrowing
# branch, so this shape left `area_id_used=None` all the way through
# `_resolve_area_scope()`, `build_street_ql()` was called with no
# `area_id`, and the real street fetch re-derived `area["name"=...]` a
# SECOND time -- which resolves to the same way-derived pseudo-area again
# and returns 0 elements to `way[...](area.searchArea)`, even though the
# real administrative relation (and tens of thousands of real highway
# ways inside it) genuinely exists in OSM. This is "geography, relation,
# and area id are all correct; production still gets elements=0" in
# miniature, with no region collision involved at all.
# ---------------------------------------------------------------------------
def _fake_osm_transport_single_way_derived_match(url, query, headers, timeout):
    """
    A fake OSM world where "Example City" matches exactly ONE boundary by
    name -- no collision, no ambiguity -- but that one match is way-
    derived (id 555, well below the relation-area-id offset). The real
    administrative boundary is relation/999999, whose computed Overpass
    area id is 3_600_000_000 + 999999 = 3_600_999_999.
    """
    is_check = '.a out tags;' in query

    if 'area["name"="Example City"]' in query and is_check:
        # Exactly one match -- the flat query is NEVER ambiguous here.
        return {"elements": [{"type": "area", "id": 555, "tags": {"admin_level": "8", "boundary": "administrative"}}]}

    if 'relation["name"="Example City"]["boundary"="administrative"]' in query:
        return {"elements": [{"type": "relation", "id": 999999, "tags": {"admin_level": "8", "boundary": "administrative", "name": "Example City"}}]}

    # 3_600_000_000 + 999999 = 3_600_999_999
    if "area(3600999999)->.searchArea;" in query:
        return {"elements": [{"type": "way", "id": 700, "tags": {"highway": "residential", "name": "Main St"}}]}

    # The (buggy, pre-fix) re-derived-by-name query shape -- if this is
    # ever sent, it proves the fix regressed: same way-derived area,
    # which in real OSM has no polygon geometry and returns 0 elements.
    if 'area["name"="Example City"]->.searchArea;' in query and 'way["highway"]' in query:
        return {"elements": []}

    return {"elements": []}


class TestUnambiguousSingleMatchWayDerivedFallback:
    def test_unambiguous_way_derived_match_still_resolves_via_relation_fallback(self):
        # The exact reported gap: no region/collision needed at all --
        # a single, never-ambiguous match that happens to be way-derived
        # must still fall back to the administrative relation, not
        # silently produce elements=0.
        result = fetch_city_street_inventory(
            country_code="US",
            city="Example City",
            http_post=_fake_osm_transport_single_way_derived_match,
        )
        assert result.status == "ok"
        assert {s.street_name for s in result.streets} == {"Main St"}

    def test_street_fetch_targets_relation_derived_area_id_not_a_name_requery(self):
        # The street-fetch query actually sent must target the concrete,
        # relation-derived area id -- never re-derive by name a second
        # time (which is what silently produced elements=0 in production).
        calls = []

        def transport(url, query, headers, timeout):
            calls.append(query)
            return _fake_osm_transport_single_way_derived_match(url, query, headers, timeout)

        fetch_city_street_inventory(country_code="US", city="Example City", http_post=transport)

        street_fetch_calls = [q for q in calls if 'way["highway"]' in q]
        assert len(street_fetch_calls) == 1
        street_query = street_fetch_calls[0]
        assert "area(3600999999)->.searchArea;" in street_query
        assert 'area["name"="Example City"]->.searchArea;' not in street_query

    def test_unambiguous_way_derived_match_with_no_relation_found_is_refused_explicitly(self):
        # If the relation lookup itself comes back empty/ambiguous, this
        # must still fail loudly (status="unavailable") rather than
        # silently proceeding with a way-derived id that will return 0
        # streets.
        def transport(url, query, headers, timeout):
            is_check = '.a out tags;' in query
            if 'area["name"="Ghost City"]' in query and is_check:
                return {"elements": [{"type": "area", "id": 42, "tags": {"admin_level": "8"}}]}
            if 'relation["name"="Ghost City"]["boundary"="administrative"]' in query:
                return {"elements": []}
            return {"elements": []}

        result = fetch_city_street_inventory(country_code="US", city="Ghost City", http_post=transport)
        assert result.status == "unavailable"
        assert "way-derived" in result.reason.lower() or "administrative boundary relation" in result.reason.lower()
        assert result.streets == ()


# ---------------------------------------------------------------------------
# 9. CRITMODE — relation lookup alt_name fix.
#
# Reproduces the exact live production failure from the follow-up
# investigation: `build_relation_boundary_ql()` matched only the relation's
# `name` tag, but the real NYC administrative relation (175905) carries
# `name="New York"` and `alt_name="New York City"` -- so a lookup for
# "New York City" matched 0 relations even though the relation genuinely
# exists with `boundary=administrative` and the expected `admin_level`.
# This is a generic OSM tagging pattern (the formal/official name in
# `name`, the common name in `alt_name`), not specific to NYC -- these
# tests use a synthetic city so the fix isn't tied to any one place.
# ---------------------------------------------------------------------------
class TestRelationLookupMatchesAltNameToo:
    def test_build_relation_boundary_ql_contains_both_name_and_alt_name_branches(self):
        # B. Generated QL contains both name and alt_name branches.
        query = build_relation_boundary_ql("New York City", timeout_seconds=60, iso3166_2="US-NY")
        assert 'relation["name"="New York City"]["boundary"="administrative"](area.searchRegion);' in query
        assert 'relation["alt_name"="New York City"]["boundary"="administrative"](area.searchRegion);' in query

    def test_iso3166_2_scope_applies_to_both_branches(self):
        # C. ISO3166-2 scope is applied to both branches.
        query = build_relation_boundary_ql("New York City", timeout_seconds=60, iso3166_2="US-NY")
        assert query.count("(area.searchRegion);") == 2
        assert 'area["ISO3166-2"="US-NY"]->.searchRegion;' in query

    def test_no_iso3166_2_still_generates_both_branches_unscoped(self):
        query = build_relation_boundary_ql("New York City", timeout_seconds=60)
        assert 'relation["name"="New York City"]["boundary"="administrative"];' in query
        assert 'relation["alt_name"="New York City"]["boundary"="administrative"];' in query
        assert "ISO3166-2" not in query

    def test_relation_matching_only_alt_name_is_found(self):
        # A. Relation name differs from target but alt_name matches ->
        # finds the relation (the exact NYC 175905 shape, genericized).
        def transport(url, query, headers, timeout):
            is_check = '.a out tags;' in query
            if 'area["name"="Example City"]' in query and is_check:
                # Flat area check: one way-derived match, forcing the
                # relation-boundary fallback.
                return {"elements": [{"type": "area", "id": 321, "tags": {"admin_level": "8", "boundary": "administrative"}}]}
            if 'relation["alt_name"="Example City"]["boundary"="administrative"]' in query:
                # The real relation's own `name` is NOT "Example City" --
                # only its `alt_name` is -- and the fake transport only
                # responds to the alt_name-branch substring, proving the
                # match came from that branch specifically.
                return {"elements": [{"type": "relation", "id": 888888, "tags": {"admin_level": "8", "boundary": "administrative", "name": "Example", "alt_name": "Example City"}}]}
            # 3_600_000_000 + 888888 = 3_600_888_888
            if "area(3600888888)->.searchArea;" in query:
                return {"elements": [{"type": "way", "id": 900, "tags": {"highway": "residential", "name": "Elm St"}}]}
            return {"elements": []}

        result = fetch_city_street_inventory(
            country_code="US", city="Example City", http_post=transport,
        )
        assert result.status == "ok"
        assert {s.street_name for s in result.streets} == {"Elm St"}

    def test_existing_name_only_match_still_works(self):
        # D. Existing name-only match still works (no regression from
        # adding the alt_name branch).
        def transport(url, query, headers, timeout):
            is_check = '.a out tags;' in query
            if 'area["name"="Plain City"]' in query and is_check:
                return {"elements": [{"type": "area", "id": 654, "tags": {"admin_level": "8", "boundary": "administrative"}}]}
            if 'relation["name"="Plain City"]["boundary"="administrative"]' in query:
                return {"elements": [{"type": "relation", "id": 777777, "tags": {"admin_level": "8", "boundary": "administrative", "name": "Plain City"}}]}
            # 3_600_000_000 + 777777 = 3_600_777_777
            if "area(3600777777)->.searchArea;" in query:
                return {"elements": [{"type": "way", "id": 901, "tags": {"highway": "residential", "name": "Oak St"}}]}
            return {"elements": []}

        result = fetch_city_street_inventory(
            country_code="US", city="Plain City", http_post=transport,
        )
        assert result.status == "ok"
        assert {s.street_name for s in result.streets} == {"Oak St"}

    def test_neither_name_nor_alt_name_matches_still_returns_no_relation(self):
        # E. Negative case: neither name nor alt_name matches -> still
        # correctly reports no relation found (no false positive from
        # the broadened filter).
        def transport(url, query, headers, timeout):
            is_check = '.a out tags;' in query
            if 'area["name"="Nowhere City"]' in query and is_check:
                return {"elements": [{"type": "area", "id": 111, "tags": {"admin_level": "8", "boundary": "administrative"}}]}
            if 'relation["name"="Nowhere City"]' in query or 'relation["alt_name"="Nowhere City"]' in query:
                return {"elements": []}
            return {"elements": []}

        result = fetch_city_street_inventory(
            country_code="US", city="Nowhere City", http_post=transport,
        )
        assert result.status == "unavailable"
        assert "way-derived" in result.reason.lower() or "administrative boundary relation" in result.reason.lower()
        assert result.streets == ()
