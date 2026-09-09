"""
MAST Engine V2 — Global Street Inventory (Phase 2A) validation suite
=======================================================================

Same convention as validate_overpass_provider.py: no network access, a
fake transport injected in place of the real HTTP call, asserting on
identity/normalization/persistence behavior.

Run: python3 validate_street_inventory.py
"""

from __future__ import annotations

import sys

from street_inventory.build import build_city_street_inventory
from street_inventory.models import StreetRecord
from street_inventory.normalization import build_street_key, normalize_street_name
from street_inventory.overpass_source import build_street_ql, fetch_city_street_inventory
from street_inventory.repository import _street_record_to_row

_FAILURES: list[str] = []


def check(label: str, condition: bool) -> None:
    status = "PASS" if condition else "FAIL"
    print(f"[{status}] {label}")
    if not condition:
        _FAILURES.append(label)


# ---------------------------------------------------------------------------
# 1. Normalization
# ---------------------------------------------------------------------------
check("'Jackson Ave' normalizes", normalize_street_name("Jackson Ave") == "jackson avenue")
check("'JacksOn Avenue' normalizes the same", normalize_street_name("JacksOn Avenue") == "jackson avenue")
check("'JACKSON AVE' normalizes the same", normalize_street_name("JACKSON AVE") == "jackson avenue")
check(
    "'E 14th St' and 'W 14th St' remain distinct",
    normalize_street_name("E 14th St") != normalize_street_name("W 14th St"),
)
check("'E 14th St' -> 'east 14th street'", normalize_street_name("E 14th St") == "east 14th street")
check("numbered streets preserved", normalize_street_name("42nd St") == "42nd street")

try:
    normalize_street_name("   ")
    check("empty street name raises", False)
except ValueError:
    check("empty street name raises", True)

# ---------------------------------------------------------------------------
# 2. street_key — geographic scoping / no bare "main-street" collision
# ---------------------------------------------------------------------------
key_a = build_street_key("US", "NY", "Queens", "jackson avenue")
key_b = build_street_key("US", "CA", "Los Angeles", "main street")
key_c = build_street_key("US", "NY", "Brooklyn", "main street")
check("street_key is geographically scoped, not bare street name", "main-street" != key_b)
check("same street name, different city -> different key", key_b != key_c)
check("street_key is stable/deterministic for identical input", key_a == build_street_key("US", "NY", "Queens", "jackson avenue"))

key_no_region = build_street_key("US", None, "SomeCity", "main street")
check("missing region uses explicit placeholder, not empty segment", ":unk:" in key_no_region)

# ---------------------------------------------------------------------------
# 3. street_key does NOT contain user_id / no per-user concept anywhere
# ---------------------------------------------------------------------------
record = StreetRecord(
    street_key=key_a,
    street_name="Jackson Ave",
    normalized_name="jackson avenue",
    country_code="US",
    city="Queens",
)
row = _street_record_to_row(record)
check("StreetRecord/row has no user_id field", "user_id" not in row)
check("StreetRecord has no completion/claim field", not any("complet" in k or "claim" in k for k in row))

# ---------------------------------------------------------------------------
# 4. Overpass QL construction
# ---------------------------------------------------------------------------
ql = build_street_ql("Queens")
check("QL scopes to named area", 'area["name"="Queens"]->.searchArea;' in ql)
check("QL queries ways with highway+name tags", 'way["highway"]["name"](area.searchArea);' in ql)
check("QL requests tags only, not center/geom", "out tags;" in ql and "out center" not in ql)

# ---------------------------------------------------------------------------
# 5. fetch_city_street_inventory — fake transport, dedup across way segments
# ---------------------------------------------------------------------------
def _fake_http_post_ok(url, query, headers, timeout):
    return {
        "elements": [
            {"type": "way", "id": 10, "tags": {"highway": "residential", "name": "Jackson Ave"}},
            {"type": "way", "id": 11, "tags": {"highway": "residential", "name": "jackson ave"}},
            {"type": "way", "id": 5, "tags": {"highway": "primary", "name": "Roosevelt Ave"}},
            {"type": "way", "id": 99, "tags": {"highway": "residential"}},  # unnamed, skipped
        ]
    }


result = fetch_city_street_inventory(
    country_code="US",
    city="Queens",
    region="NY",
    area_name="Queens",
    http_post=_fake_http_post_ok,
)
check("fetch result status is ok", result.status == "ok")
check("distinct way segments sharing a name collapse to one street", len(result.streets) == 2)
jackson = next((s for s in result.streets if s.normalized_name == "jackson avenue"), None)
check("Jackson Ave street present", jackson is not None)
check("representative source_id uses lowest way id", jackson is not None and jackson.source_id == "way/10")
check("unnamed way does not produce a street", all(s.normalized_name != "" for s in result.streets))
check("no user_id anywhere on fetched records", all(not hasattr(s, "user_id") for s in result.streets))


def _fake_http_post_fail(url, query, headers, timeout):
    raise OSError("simulated network failure")


unavailable = fetch_city_street_inventory(
    country_code="US",
    city="Nowhereville",
    area_name="Nowhereville",
    http_post=_fake_http_post_fail,
)
check("transport failure yields 'unavailable', not an exception", unavailable.status == "unavailable")
check("'unavailable' result carries a reason", bool(unavailable.reason))
check("'unavailable' result has zero streets", len(unavailable.streets) == 0)

unresolvable = fetch_city_street_inventory(country_code="US", city="", http_post=_fake_http_post_ok)
check("empty city -> 'unavailable' (no crash)", unresolvable.status == "unavailable")

# ---------------------------------------------------------------------------
# 6. build_city_street_inventory orchestration — fake repository, no network
# ---------------------------------------------------------------------------
class _FakeRepository:
    def __init__(self):
        self.upserted_records = []

    def upsert_streets(self, records):
        self.upserted_records.extend(records)
        return {"upserted": len(records), "batches": 1 if records else 0}


fake_repo = _FakeRepository()
summary = build_city_street_inventory(
    country_code="US",
    city="Queens",
    region="NY",
    area_name="Queens",
    repository=fake_repo,
    http_post=_fake_http_post_ok,
)
check("build orchestration reports status ok", summary["status"] == "ok")
check("build orchestration upserts fetched streets", summary["upserted"] == 2)
check("fake repository actually received the records", len(fake_repo.upserted_records) == 2)

summary_unavailable = build_city_street_inventory(
    country_code="US",
    city="Nowhereville",
    area_name="Nowhereville",
    repository=fake_repo,
    http_post=_fake_http_post_fail,
)
check(
    "build orchestration surfaces 'unavailable' without touching the repository",
    summary_unavailable["status"] == "unavailable" and len(fake_repo.upserted_records) == 2,
)

# ---------------------------------------------------------------------------
print()
if _FAILURES:
    print(f"{len(_FAILURES)} check(s) FAILED:")
    for f in _FAILURES:
        print(f"  - {f}")
    sys.exit(1)
else:
    print("All checks passed.")
