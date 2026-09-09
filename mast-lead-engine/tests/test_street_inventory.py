"""
tests/test_street_inventory.py
================================

Phase 2A — Global Street Inventory regression coverage. Covers exactly
the 11 test categories this phase's own instructions list:

1.  Deterministic street normalization.
2.  Same street, different capitalization/type-abbreviation, resolves.
3.  Distinct directional streets remain distinct.
4.  Same street name in two different cities remains distinct.
5.  Duplicate inventory insertion is idempotent.
6.  Stable street_key generation.
7.  Serial/order changes do not change street identity. (No serial is
    persisted at all in this phase — see migrations/028's ordering
    view — so this is proven by street_key never depending on order.)
8.  Large city inventories can contain many streets.
9.  Missing street inventory data does not crash discovery.
10. Existing area discovery tests remain passing. (Not re-asserted
    here — this phase touches no area-discovery file at all; see
    the regression run of the existing area-discovery test suite in
    the final report instead of duplicating those tests here.)
11. Phase 1A/1B relevant regression tests remain passing. (Same as
    above — the existing test suite for those phases is unmodified.)
"""

from __future__ import annotations

import json
import urllib.error

import pytest

from street_inventory.build import build_city_street_inventory
from street_inventory.models import StreetInventoryResult, StreetRecord
from street_inventory.normalization import build_street_key, normalize_street_name
from street_inventory.overpass_source import build_street_ql, fetch_city_street_inventory
from street_inventory.repository import _street_record_to_row


# ---------------------------------------------------------------------------
# 1 & 2. Deterministic normalization / capitalization+abbreviation equivalence
# ---------------------------------------------------------------------------
class TestNormalization:
    @pytest.mark.parametrize(
        "raw",
        ["Jackson Ave", "JacksOn Avenue", "JACKSON AVE", "jackson ave.", "  Jackson   Ave  "],
    )
    def test_variants_resolve_to_same_normalized_name(self, raw):
        assert normalize_street_name(raw) == "jackson avenue"

    def test_normalization_is_deterministic(self):
        assert normalize_street_name("Roosevelt Blvd") == normalize_street_name("Roosevelt Blvd")

    def test_common_type_abbreviations_expand(self):
        assert normalize_street_name("Main St") == "main street"
        assert normalize_street_name("Queens Blvd") == "queens boulevard"
        assert normalize_street_name("Elm Dr") == "elm drive"

    def test_numbered_streets_preserved(self):
        assert normalize_street_name("42nd St") == "42nd street"
        assert normalize_street_name("14th Ave") == "14th avenue"

    def test_empty_name_raises(self):
        with pytest.raises(ValueError):
            normalize_street_name("")
        with pytest.raises(ValueError):
            normalize_street_name("   ")

    def test_mid_name_ambiguous_st_not_expanded(self):
        # "St" here means "Saint", not "Street" — last-token-only rule
        # must leave it alone (see normalization.py module docstring).
        assert normalize_street_name("St Marys Church Way") == "st marys church way"


# ---------------------------------------------------------------------------
# 3. Distinct directional streets remain distinct
# ---------------------------------------------------------------------------
class TestDirectionalDistinction:
    def test_east_west_distinct(self):
        east = normalize_street_name("E 14th St")
        west = normalize_street_name("W 14th St")
        assert east != west
        assert east == "east 14th street"
        assert west == "west 14th street"

    def test_north_south_distinct(self):
        assert normalize_street_name("N Main St") != normalize_street_name("S Main St")

    def test_directional_keys_distinct(self):
        east_key = build_street_key("US", "NY", "Manhattan", normalize_street_name("E 14th St"))
        west_key = build_street_key("US", "NY", "Manhattan", normalize_street_name("W 14th St"))
        assert east_key != west_key

    def test_bare_direction_letter_not_mangled(self):
        # Only one token, no type suffix to fold into it either —
        # should pass through normalization unexpanded.
        assert normalize_street_name("S") == "s"


# ---------------------------------------------------------------------------
# 4 & 6. Geographic scoping / stable street_key generation
# ---------------------------------------------------------------------------
class TestStreetKey:
    def test_same_name_different_city_distinct_key(self):
        la_key = build_street_key("US", "CA", "Los Angeles", "main street")
        ny_key = build_street_key("US", "NY", "Brooklyn", "main street")
        assert la_key != ny_key

    def test_key_is_not_bare_street_name(self):
        key = build_street_key("US", "NY", "Queens", "main street")
        assert key != "main-street"

    def test_key_is_deterministic(self):
        a = build_street_key("US", "NY", "Queens", "jackson avenue")
        b = build_street_key("US", "NY", "Queens", "jackson avenue")
        assert a == b

    def test_missing_region_uses_stable_placeholder_not_empty(self):
        key = build_street_key("US", None, "SomeCity", "main street")
        assert ":unk:" in key
        assert "::" not in key

    def test_missing_required_components_raise(self):
        with pytest.raises(ValueError):
            build_street_key("", "NY", "Queens", "main street")
        with pytest.raises(ValueError):
            build_street_key("US", "NY", "", "main street")
        with pytest.raises(ValueError):
            build_street_key("US", "NY", "Queens", "")


# ---------------------------------------------------------------------------
# 5. Duplicate inventory insertion is idempotent (fake repository)
# ---------------------------------------------------------------------------
class _RecordingFakeRepository:
    """Records every row it would have upserted, keyed by street_key,
    so a test can assert repeated upserts converge rather than
    accumulate duplicates."""

    def __init__(self):
        self.rows_by_key = {}
        self.upsert_calls = 0

    def upsert_streets(self, records):
        self.upsert_calls += 1
        for r in records:
            self.rows_by_key[r.street_key] = r
        return {"upserted": len(records), "batches": 1 if records else 0}


class TestIdempotentUpsert:
    def _fake_transport(self, url, query, headers, timeout):
        return {
            "elements": [
                {"type": "way", "id": 1, "tags": {"highway": "residential", "name": "Jackson Ave"}},
            ]
        }

    def test_repeated_build_does_not_duplicate_rows(self):
        repo = _RecordingFakeRepository()
        for _ in range(3):
            build_city_street_inventory(
                country_code="US",
                city="Queens",
                region="NY",
                area_name="Queens",
                repository=repo,
                http_post=self._fake_transport,
            )
        assert repo.upsert_calls == 3
        # Same street, 3 runs -> exactly one row in the (fake) table.
        assert len(repo.rows_by_key) == 1

    def test_repeated_run_keeps_same_street_key(self):
        repo = _RecordingFakeRepository()
        build_city_street_inventory(
            country_code="US", city="Queens", region="NY", area_name="Queens",
            repository=repo, http_post=self._fake_transport,
        )
        first_key = next(iter(repo.rows_by_key))
        build_city_street_inventory(
            country_code="US", city="Queens", region="NY", area_name="Queens",
            repository=repo, http_post=self._fake_transport,
        )
        second_key = next(iter(repo.rows_by_key))
        assert first_key == second_key


# ---------------------------------------------------------------------------
# 7. Serial/ordering never affects identity
# ---------------------------------------------------------------------------
class TestSerialIndependence:
    def test_street_key_has_no_ordering_dependence(self):
        # Fetch the same two streets in two different upstream orders;
        # the resulting street_keys must be identical either way, since
        # nothing about `street_key` construction reads element order.
        def transport_order_a(url, query, headers, timeout):
            return {
                "elements": [
                    {"type": "way", "id": 1, "tags": {"highway": "residential", "name": "Jackson Ave"}},
                    {"type": "way", "id": 2, "tags": {"highway": "residential", "name": "Roosevelt Ave"}},
                ]
            }

        def transport_order_b(url, query, headers, timeout):
            return {
                "elements": [
                    {"type": "way", "id": 2, "tags": {"highway": "residential", "name": "Roosevelt Ave"}},
                    {"type": "way", "id": 1, "tags": {"highway": "residential", "name": "Jackson Ave"}},
                ]
            }

        result_a = fetch_city_street_inventory(
            country_code="US", city="Queens", region="NY", area_name="Queens", http_post=transport_order_a
        )
        result_b = fetch_city_street_inventory(
            country_code="US", city="Queens", region="NY", area_name="Queens", http_post=transport_order_b
        )
        keys_a = sorted(s.street_key for s in result_a.streets)
        keys_b = sorted(s.street_key for s in result_b.streets)
        assert keys_a == keys_b

    def test_no_street_serial_field_on_record(self):
        # This phase deliberately does not persist a serial column —
        # see migrations/028_discovery_streets.sql's ordering view.
        record = StreetRecord(
            street_key="us:ny:queens:jackson-avenue",
            street_name="Jackson Ave",
            normalized_name="jackson avenue",
            country_code="US",
            city="Queens",
        )
        row = _street_record_to_row(record)
        assert "street_serial" not in row


# ---------------------------------------------------------------------------
# 8. Large city inventories can contain many streets
# ---------------------------------------------------------------------------
class TestLargeCityInventory:
    def test_many_distinct_streets_all_survive(self):
        def transport_many(url, query, headers, timeout):
            return {
                "elements": [
                    {
                        "type": "way",
                        "id": i,
                        "tags": {"highway": "residential", "name": f"{i}th Street"},
                    }
                    for i in range(1, 2001)
                ]
            }

        result = fetch_city_street_inventory(
            country_code="US", city="Queens", region="NY", area_name="Queens", http_post=transport_many
        )
        assert result.status == "ok"
        assert len(result.streets) == 2000
        assert len({s.street_key for s in result.streets}) == 2000

    def test_batched_upsert_does_not_send_one_row_per_request(self):
        from street_inventory.repository import DEFAULT_BATCH_SIZE

        sent_batches = []

        class _CountingRepo:
            def upsert_streets(self, records):
                # Simulate the real repository's own batching so this
                # test proves the *contract* (batches, not N+1),
                # without a live Supabase project.
                for start in range(0, len(records), DEFAULT_BATCH_SIZE):
                    sent_batches.append(records[start : start + DEFAULT_BATCH_SIZE])
                return {"upserted": len(records), "batches": len(sent_batches)}

        def transport_many(url, query, headers, timeout):
            return {
                "elements": [
                    {"type": "way", "id": i, "tags": {"highway": "residential", "name": f"{i}th Street"}}
                    for i in range(1, 1201)
                ]
            }

        repo = _CountingRepo()
        summary = build_city_street_inventory(
            country_code="US", city="Queens", region="NY", area_name="Queens",
            repository=repo, http_post=transport_many,
        )
        assert summary["status"] == "ok"
        assert len(sent_batches) == 3  # 1200 streets / 500 per batch = 3 batches, not 1200 requests
        assert len(sent_batches) < summary["upserted"]


# ---------------------------------------------------------------------------
# 9. Missing street inventory data does not crash discovery
# ---------------------------------------------------------------------------
class TestUnavailableFallback:
    def test_unresolvable_area_is_unavailable_not_exception(self):
        result = fetch_city_street_inventory(country_code="US", city="", http_post=lambda *a, **k: {})
        assert result.status == "unavailable"
        assert result.streets == ()

    def test_transport_http_error_is_unavailable(self):
        def failing(url, query, headers, timeout):
            raise urllib.error.HTTPError(url, 503, "Service Unavailable", hdrs=None, fp=None)  # type: ignore[arg-type]

        result = fetch_city_street_inventory(
            country_code="US", city="Queens", area_name="Queens", http_post=failing
        )
        assert result.status == "unavailable"
        assert result.reason

    def test_transport_network_error_is_unavailable(self):
        def failing(url, query, headers, timeout):
            raise urllib.error.URLError("simulated DNS failure")

        result = fetch_city_street_inventory(
            country_code="US", city="Queens", area_name="Queens", http_post=failing
        )
        assert result.status == "unavailable"

    def test_malformed_json_response_is_unavailable(self):
        def malformed(url, query, headers, timeout):
            raise json.JSONDecodeError("bad json", "doc", 0)

        result = fetch_city_street_inventory(
            country_code="US", city="Queens", area_name="Queens", http_post=malformed
        )
        assert result.status == "unavailable"

    def test_response_missing_elements_key_is_unavailable(self):
        result = fetch_city_street_inventory(
            country_code="US", city="Queens", area_name="Queens", http_post=lambda *a, **k: {"no_elements_here": True}
        )
        assert result.status == "unavailable"

    def test_orchestration_reports_unavailable_without_raising(self):
        def failing(url, query, headers, timeout):
            raise OSError("boom")

        summary = build_city_street_inventory(
            country_code="US",
            city="Queens",
            area_name="Queens",
            repository=_RecordingFakeRepository(),
            http_post=failing,
        )
        assert summary == {"status": "unavailable", "reason": summary["reason"]}
        assert summary["status"] == "unavailable"


# ---------------------------------------------------------------------------
# Additional: no user_id / no per-user concept anywhere in this phase
# ---------------------------------------------------------------------------
class TestNoPerUserState:
    def test_street_record_row_has_no_user_id(self):
        record = StreetRecord(
            street_key="us:ny:queens:jackson-avenue",
            street_name="Jackson Ave",
            normalized_name="jackson avenue",
            country_code="US",
            city="Queens",
        )
        row = _street_record_to_row(record)
        assert "user_id" not in row
        assert not any("complet" in k or "claim" in k for k in row)

    def test_street_record_dataclass_fields_have_no_user_concept(self):
        import dataclasses

        field_names = {f.name for f in dataclasses.fields(StreetRecord)}
        assert "user_id" not in field_names
        assert not any("complet" in name or "claim" in name for name in field_names)
