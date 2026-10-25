"""
mast-lead-engine/tests/test_chicago_boundary_resolution.py
==========================================================

Regression tests for Chicago street-inventory boundary resolution:
1. Chicago resolves to the intended city boundary (relation 122604 / area 3600122604)
   even when OSM has 16 distinct boundaries sharing the name "Chicago" globally.
2. Disambiguates within Illinois (US-IL) using administrative constraints (admin_level=8)
   and authoritative canonical boundary metadata.
3. An actually ambiguous city without sufficient context fails explicitly with
   status="unavailable" rather than guessing.
4. Unambiguous cities still resolve and fetch normally.
"""

from __future__ import annotations

import pytest
from street_inventory.overpass_source import fetch_city_street_inventory, get_canonical_city_boundary


def _fake_chicago_osm_transport_16_matches(url, query, headers, timeout):
    """
    Simulates the real production failure:
    - Unscoped query 'area["name"="Chicago"]' matches 16 distinct boundaries across OSM.
    - Narrowed query with 'ISO3166-2"="US-IL"' narrows to Illinois, where the real
      Chicago boundary relation is relation 122604 (area 3600122604).
    """
    is_boundary_check = ".a out tags;" in query
    has_il_subdivision = 'ISO3166-2"="US-IL"' in query

    # Boundary check query
    if is_boundary_check and 'area["name"="Chicago"]' in query:
        if has_il_subdivision:
            # Inside Illinois: two entities might match (e.g., city admin_level 8, and a way-derived area 999)
            return {
                "elements": [
                    {
                        "type": "area",
                        "id": 3_600_122_604,
                        "tags": {
                            "name": "Chicago",
                            "admin_level": "8",
                            "boundary": "administrative",
                            "place": "city",
                        },
                    },
                    {
                        "type": "area",
                        "id": 999,  # way-derived artifact
                        "tags": {
                            "name": "Chicago",
                            "admin_level": "7",
                        },
                    },
                ]
            }
        # Global query matches 16 boundaries (the exact reproduction from logs)
        sixteen_boundaries = [
            {"type": "area", "id": 100 + i, "tags": {"name": "Chicago", "admin_level": str(8 if i % 2 == 0 else 7)}}
            for i in range(16)
        ]
        return {"elements": sixteen_boundaries}

    # Administrative relation query
    if 'relation["name"="Chicago"]["boundary"="administrative"]' in query:
        return {
            "elements": [
                {
                    "type": "relation",
                    "id": 122604,
                    "tags": {
                        "name": "Chicago",
                        "admin_level": "8",
                        "boundary": "administrative",
                        "place": "city",
                    },
                }
            ]
        }

    # Street fetch query targeting verified area id 3600122604
    if "area(3600122604)->.searchArea;" in query and 'way["highway"]' in query:
        return {
            "elements": [
                {"type": "way", "id": 1, "tags": {"highway": "residential", "name": "Michigan Ave"}},
                {"type": "way", "id": 2, "tags": {"highway": "residential", "name": "State St"}},
            ]
        }

    return {"elements": []}


def test_canonical_chicago_boundary_metadata():
    canon = get_canonical_city_boundary("US", "Chicago")
    assert canon is not None
    assert canon["subdivision"] == "IL"
    assert canon["relation_id"] == 122604
    assert canon["admin_level"] == 8


def test_chicago_resolves_when_16_boundaries_exist_globally_with_region():
    # Caller provides region="IL" (e.g. from Node discoveryPlanJob via resolveCitySubdivision)
    result = fetch_city_street_inventory(
        country_code="US",
        city="Chicago",
        region="IL",
        http_post=_fake_chicago_osm_transport_16_matches,
    )
    assert result.status == "ok"
    street_names = {s.street_name for s in result.streets}
    assert "Michigan Ave" in street_names
    assert "State St" in street_names


def test_chicago_resolves_even_if_region_omitted_via_canonical_mapping():
    # If caller provided country_code="US" and city="Chicago" with no region,
    # canonical resolution identifies Illinois and relation 122604
    result = fetch_city_street_inventory(
        country_code="US",
        city="Chicago",
        http_post=_fake_chicago_osm_transport_16_matches,
    )
    assert result.status == "ok"
    street_names = {s.street_name for s in result.streets}
    assert "Michigan Ave" in street_names
    assert "State St" in street_names


def test_chicago_resolves_with_explicit_osm_relation_id():
    # Node can pass osm_relation_id explicitly
    result = fetch_city_street_inventory(
        country_code="US",
        city="Chicago",
        osm_relation_id=122604,
        http_post=_fake_chicago_osm_transport_16_matches,
    )
    assert result.status == "ok"
    assert len(result.streets) == 2


def test_ambiguous_city_without_context_fails_explicitly():
    # Synthetic city with 5 boundaries and no subdivision or canonical entry
    def transport(url, query, headers, timeout):
        if ".a out tags;" in query and 'area["name"="MultiCity"]' in query:
            return {
                "elements": [
                    {"type": "area", "id": 1, "tags": {"admin_level": "8", "boundary": "administrative"}},
                    {"type": "area", "id": 2, "tags": {"admin_level": "8", "boundary": "administrative"}},
                ]
            }
        return {"elements": []}

    result = fetch_city_street_inventory(
        country_code="US",
        city="MultiCity",
        http_post=transport,
    )
    assert result.status == "unavailable"
    assert "ambiguous" in result.reason.lower()
    assert result.streets == ()


def test_broad_region_name_does_not_break_chicago():
    # When caller passes broad region="United States" (the user's top-level scope),
    # canonical subdivision resolution still correctly maps Chicago to "US-IL"
    result = fetch_city_street_inventory(
        country_code="US",
        city="Chicago",
        region="United States",
        http_post=_fake_chicago_osm_transport_16_matches,
    )
    assert result.status == "ok"
    assert len(result.streets) == 2
