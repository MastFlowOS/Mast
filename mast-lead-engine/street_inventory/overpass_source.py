"""
street_inventory/overpass_source.py
=====================================

The chosen street inventory source for Phase 2A: OpenStreetMap, via the
same public Overpass interpreter endpoint `providers/overpass_provider.py`
already calls for business discovery.

Why Overpass, and why a new small module instead of reusing
OverpassProvider itself
------------------------------------------------------------------------
Per this phase's own instructions ("prefer existing OSM/Overpass
capability if it can provide reliable street identities... the existing
system already understands OSM address information... may already have
reusable primitives" / "do not create a massive business-derived street
list"):

    - OSM tags every real road/street as a `way` with `highway=*` and
      (when named) a `name` tag — this is a genuine, independent,
      geographic enumeration of streets, not a byproduct of scraping
      businesses. It is the strongest available source in this
      repository for the objective ("a geographic inventory, not a
      side effect of lead discovery").
    - `providers/overpass_provider.py:OverpassProvider` is NOT reused
      directly, deliberately: its `discover()` always yields
      `BusinessCandidate` (see `_to_business_candidate`), a shape this
      package has no reason to produce (a street is not a business),
      and its `OverpassDiscoveryRequest.tags` is documented as "the
      sole 'what am I searching for' field" for *tag-filtered element*
      queries (e.g. `amenity=restaurant`) — querying `highway=*`
      through it would technically run, but every downstream line of
      that provider (candidate mapping, address composition, maps_url
      construction) exists for businesses and would need to be ignored
      or worked around, which is a worse coupling than a small,
      independent, single-purpose module. This mirrors the precedent
      OverpassProvider's own docstring already sets for YelpProvider/
      AppleMapsProvider: each provider is "a fourth, independent
      answer to the same interface", not a shared base class other
      code reaches into.
    - What IS reused: `providers/provider_request_translation.py:
      normalize_osm_area`, the existing city/area-name -> OSM boundary
      `name` resolver business discovery's Overpass scoping already
      depends on (see that module and `test_area_scope_overpass.py`).
      Reusing it here means a city that already resolves to a valid
      OSM area for business discovery resolves the same way for street
      discovery, and a city this codebase doesn't know how to scope
      (this function returns the caller's cleaned-but-unrecognized
      string, never `None`, for a non-empty input — see that function's
      own body) is handled once, not reimplemented.
    - The actual HTTP transport is a NEW, deliberately minimal
      stdlib-`urllib` POST helper (`_http_post_urllib` below), not an
      import of `overpass_provider.py`'s private, underscore-prefixed
      `_http_post_urllib` / `_http_post` machinery. That machinery
      implements multi-mirror failover, retry/backoff, and cooperative
      `should_stop` cancellation for a *live, per-user discovery
      request* latency budget — none of which this phase's background,
      one-time-per-city inventory build needs (see this phase's own
      "DO NOT WIRE WORKERS YET" section: this is not a live discovery
      path). Importing a private helper across modules for a much
      simpler use case would be the same "hidden coupling" this
      codebase's own docstrings warn against (see also
      `normalization.py`'s "Why this is a NEW, small normalizer"
      section for the identical reasoning applied to text
      normalization instead of HTTP transport). On failure, this
      module's transport simply raises — the caller
      (`fetch_city_street_inventory` below) converts that into the
      "unavailable" result this phase's instructions require, rather
      than retrying/failing-over.

Query shape
-----------
    area["name"="<area_name>"]->.searchArea;
    way["highway"]["name"](area.searchArea);
    out tags;

This mirrors `overpass_provider.py:_build_ql`'s own
`area["name"="..."]->.searchArea;` / `(area.searchArea)` scoping syntax
exactly (same Overpass QL primitive, same reason to use it: the
caller-resolved OSM area name is the scope). It deliberately requests
`out tags;` — NOT `out center;` / `out geom;` — because street identity
needs only the `name` tag (and the way id, for `source_id`
traceability); geometry/coordinates would multiply the response
payload for no benefit this phase's objective (a name/identity
inventory, not a mapping product) needs. See this phase's own
"Performance" section: no unnecessary network payload.

`["highway"]["name"]` (two chained tag-presence filters, no `=value`)
requests every OSM way tagged with any `highway=*` value AND a `name`
tag — i.e. every named road regardless of its specific class
(residential, primary, tertiary, ...). This deliberately does not
filter to a fixed subset of highway values: doing so would silently
drop real streets whose class this codebase's authors didn't happen to
enumerate, which is exactly the kind of "hard-coded street list"
this phase's instructions rule out — just phrased as OSM highway
classes instead of a Queens street list.

CRITMODE — street inventory geography bug (114,103-row New York run)
----------------------------------------------------------------------
Root cause: `area["name"="<area_name>"]` is an EXACT STRING match
against every OSM area's `name` tag — it has no concept of "the city
the caller meant". When `area_name` is resolved automatically from a
bare `city` string that has no curated entry in
`provider_request_translation.py:_OSM_AREA_NORMALIZATIONS`, that
resolver's own "Fallback to exact cleaned string" branch returns the
city string unchanged. For city="New York" this produced the literal
area name "New York" — which in OSM is the boundary relation for New
York STATE (`admin_level=4`), NOT the city (whose own, separately-
named relation is "New York City", `admin_level=8`). The resulting
query silently enumerated every named road in the entire state,
including Warwick/Orange County ("1/2 Mile Trail", "1/2 Mile Plungis
Road", the bare-digit "1") — none of which are wrong data, they are
simply not New York City.

This is fixed in two layers, per this phase's own "fail explicit
rather than silently generate a broad inventory" instruction:

    1. A curated `_OSM_AREA_NORMALIZATIONS["new york"] = "New York
       City"` entry (the actual, correct fix for this specific city —
       see that module).
    2. `_verify_resolved_boundary()` below: a lightweight safety net
       that ALSO catches the general shape of this bug for any city
       whose auto-resolved area name happens to collide with a
       broader OSM boundary, WITHOUT hard-coding a per-city list. It
       runs a second, tiny Overpass query (`.a out tags;` on the
       matched area(s), no ways) whenever `area_name` was NOT supplied
       explicitly by the caller — an explicit `area_name` means a
       human already curated/vetted that exact OSM boundary name (the
       same trust this codebase already places in the curated borough/
       neighborhood table), so re-verifying it would be redundant, not
       safer. It rejects (returns `status="unavailable"` with an
       explicit reason, never silently proceeds) when:
         - zero areas match the resolved name (the boundary doesn't
           exist — currently un-checked before this fix; the old code
           would silently run the ways query against a non-existent
           `.searchArea` and just get zero streets back),
         - more than one area matches (an ambiguous name — which OSM
           area was actually queried would depend on Overpass's
           internal union-of-matches behavior, not on caller intent),
         - or the single matched area's own `admin_level` tag is `<=
           4` — the OSM convention for country (`2`) or first-level
           subdivision / state / province (`4`), i.e. an order of
           magnitude broader than any single city, regardless of
           country. `<= 4` is deliberately conservative (not `<= 6`,
           `<= 7`, etc.): city-level admin_level varies by country (US
           city ~8, but some countries legitimately use 6 for a city/
           district), so this only refuses the boundary levels that
           are unambiguously "not a city" everywhere OSM is used —
           see this function's own docstring for that trade-off.
"""

from __future__ import annotations

import json
import logging
import time
import urllib.error
import urllib.request
from typing import Any, Callable, Optional

from providers.provider_request_translation import normalize_osm_area
from street_inventory._deadline import call_with_hard_deadline
from street_inventory.models import StreetInventoryResult, StreetRecord
from street_inventory.normalization import build_street_key, normalize_street_name

log = logging.getLogger(__name__)

DEFAULT_ENDPOINT_URL = "https://overpass-api.de/api/interpreter"
DEFAULT_TIMEOUT_SECONDS = 60

# CRITMODE — street-inventory hang investigation: a HARD wall-clock
# ceiling on the whole Overpass POST call, on top of (not instead of)
# `timeout_seconds`'s own per-socket-operation bound — see
# `_deadline.py` module docstring for exactly which hang this closes
# (DNS stall / slow-trickle response) that `timeout_seconds` alone does
# not. Deliberately generous headroom over `DEFAULT_TIMEOUT_SECONDS` so
# a normal, slightly-slow-but-healthy request is never cut off early.
HARD_DEADLINE_BUFFER_SECONDS = 30

#: Same discipline as overpass_provider.py's own
#: `_DEFAULT_TRANSPORT_HEADERS` — a real, identifying User-Agent and an
#: explicit Accept header, because overpass-api.de's front end rejects
#: requests that arrive with urllib's bare default User-Agent.
_HEADERS = {
    "Content-Type": "application/x-www-form-urlencoded",
    "Accept": "application/json",
    "User-Agent": "mast-lead-engine-street-inventory/1.0",
}

HttpPost = Callable[[str, str, dict[str, str], float], dict[str, Any]]


def _http_post_urllib(url: str, query: str, headers: dict[str, str], timeout: float) -> dict[str, Any]:
    """
    Default transport: one plain stdlib POST of the Overpass QL query
    text as the request body. See module docstring, "why a new small
    module instead of reusing OverpassProvider", for why this does not
    retry, fail over across mirrors, or catch anything — it raises
    `urllib.error.HTTPError` / `URLError` unmodified on failure, same
    "provider failures stay isolated to the provider, but are never
    hidden from the caller" convention `overpass_provider.py`'s own
    default transport follows before its own retry loop wraps it.
    """
    data = query.encode("utf-8")
    request = urllib.request.Request(url, data=data, headers=headers, method="POST")
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.loads(response.read().decode("utf-8"))


def build_street_ql(area_name: str, timeout_seconds: int = DEFAULT_TIMEOUT_SECONDS) -> str:
    """
    Builds the Overpass QL query text for enumerating named streets
    inside `area_name`. See module docstring, "Query shape".
    """
    escaped_area = area_name.replace('"', '\\"')
    return (
        f"[out:json][timeout:{timeout_seconds}];\n"
        f'area["name"="{escaped_area}"]->.searchArea;\n'
        f'way["highway"]["name"](area.searchArea);\n'
        f"out tags;"
    )


#: OSM admin_level values at or below this are unambiguously broader
#: than any single city, in every country OSM covers (2 = country,
#: 4 = state/province/first-level subdivision). See module docstring,
#: "CRITMODE — street inventory geography bug", for why this is `<= 4`
#: and not a higher, country-varying "city" cutoff.
_MAX_BROAD_ADMIN_LEVEL = 4


def build_boundary_check_ql(area_name: str, timeout_seconds: int = DEFAULT_TIMEOUT_SECONDS) -> str:
    """
    Builds the (tiny, tags-only, no ways) Overpass QL query text used
    by `_verify_resolved_boundary()` to inspect exactly which OSM
    area(s) `area_name` matches before trusting it to scope the real
    street query. See module docstring for why this exists.
    """
    escaped_area = area_name.replace('"', '\\"')
    return (
        f"[out:json][timeout:{timeout_seconds}];\n"
        f'area["name"="{escaped_area}"]->.a;\n'
        f".a out tags;"
    )


def _verify_resolved_boundary(
    poster: HttpPost,
    endpoint_url: str,
    resolved_area: str,
    city: str,
    timeout_seconds: int,
    hard_deadline: float,
) -> Optional[StreetInventoryResult]:
    """
    Confirms `resolved_area` names exactly one OSM boundary, and that
    boundary is not itself a country/state-level administrative area
    (see module docstring). Returns `None` when the boundary checks
    out (caller proceeds with the real street query); returns a
    populated `StreetInventoryResult(status="unavailable", ...)` when
    it does not — the caller returns that result directly rather than
    silently running the street query against an unverified area.

    Only called for the auto-resolved-from-`city` path (see
    `fetch_city_street_inventory`'s own `area_name` handling) — an
    `area_name` the caller supplied explicitly is treated as already
    vetted, exactly like the existing curated borough/neighborhood
    table.
    """
    query = build_boundary_check_ql(resolved_area, timeout_seconds=timeout_seconds)
    try:
        payload = call_with_hard_deadline(
            poster, endpoint_url, query, _HEADERS, float(timeout_seconds),
            deadline_seconds=hard_deadline,
        )
    except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError, OSError) as exc:
        log.warning(
            "[street-inventory] boundary verification transport error for city=%r area=%r: %s",
            city, resolved_area, exc,
        )
        return StreetInventoryResult(
            status="unavailable", reason=f"boundary verification failed: {exc}"
        )
    except (ValueError, json.JSONDecodeError) as exc:
        log.warning(
            "[street-inventory] malformed boundary verification response for city=%r area=%r: %s",
            city, resolved_area, exc,
        )
        return StreetInventoryResult(
            status="unavailable", reason=f"malformed boundary verification response: {exc}"
        )

    elements = payload.get("elements") if isinstance(payload, dict) else None
    if not elements:
        log.warning(
            "[street-inventory] no OSM boundary named %r for city=%r — refusing to query an "
            "unverified/nonexistent area",
            resolved_area, city,
        )
        return StreetInventoryResult(
            status="unavailable",
            reason=f"no OSM boundary found named {resolved_area!r} for city={city!r}",
        )
    if len(elements) > 1:
        log.warning(
            "[street-inventory] ambiguous OSM area name %r for city=%r matched %d distinct "
            "boundaries — refusing to silently pick one",
            resolved_area, city, len(elements),
        )
        return StreetInventoryResult(
            status="unavailable",
            reason=(
                f"ambiguous OSM area name {resolved_area!r} for city={city!r} matched "
                f"{len(elements)} distinct boundaries"
            ),
        )

    tags = elements[0].get("tags") or {}
    admin_level_raw = tags.get("admin_level")
    if admin_level_raw is not None:
        try:
            admin_level = int(admin_level_raw)
        except (TypeError, ValueError):
            admin_level = None
        if admin_level is not None and admin_level <= _MAX_BROAD_ADMIN_LEVEL:
            log.warning(
                "[street-inventory] OSM area %r for city=%r resolved to a country/state-level "
                "boundary (admin_level=%s) — refusing to generate a city street inventory from it",
                resolved_area, city, admin_level_raw,
            )
            return StreetInventoryResult(
                status="unavailable",
                reason=(
                    f"OSM area {resolved_area!r} for city={city!r} resolved to a "
                    f"country/state-level boundary (admin_level={admin_level_raw}), "
                    f"not a city"
                ),
            )

    return None


def fetch_city_street_inventory(
    *,
    country_code: str,
    city: str,
    country_name: Optional[str] = None,
    region: Optional[str] = None,
    area_name: Optional[str] = None,
    endpoint_url: str = DEFAULT_ENDPOINT_URL,
    timeout_seconds: int = DEFAULT_TIMEOUT_SECONDS,
    http_post: Optional[HttpPost] = None,
) -> StreetInventoryResult:
    """
    Attempts to build a `StreetInventoryResult` for one city from OSM/
    Overpass. Never raises for an expected "we couldn't get streets for
    this place" outcome (unresolved area, transport failure/timeout,
    malformed response, empty result) — every one of those becomes
    `status="unavailable"` with a `reason`, per this phase's own
    instruction that missing street inventory data must not crash
    discovery.

    `area_name`, if given, is used as-is (the caller already knows the
    exact OSM boundary name). If omitted, this function resolves one
    from `city` via `normalize_osm_area` — the SAME resolver
    `provider_request_translation.py` already uses for business
    discovery's Overpass area scoping (see module docstring, "What IS
    reused").

    `http_post` defaults to `_http_post_urllib` (a real network call).
    Signature: `(url, query_text, headers, timeout_seconds) -> dict`
    (the parsed Overpass JSON response). Injecting a fake makes this
    function testable without network access — see
    `validate_street_inventory.py` and `tests/test_street_inventory.py`.
    """
    poster = http_post or _http_post_urllib

    # STAGE 1/4: boundary resolution — pure in-memory lookup
    # (`normalize_osm_area`), no network involved, so it cannot hang; the
    # timestamps below still bracket it for diagnostic completeness so a
    # future reader of the logs never has to guess whether this stage was
    # the slow one.
    _t_boundary_start = time.monotonic()
    area_name_was_explicit = bool(area_name and area_name.strip())
    resolved_area = area_name if area_name else normalize_osm_area(city)
    log.info(
        "[street-inventory] boundary resolved city=%r area=%r explicit=%s elapsed=%.3fs",
        city, resolved_area, area_name_was_explicit, time.monotonic() - _t_boundary_start,
    )
    if not resolved_area:
        return StreetInventoryResult(
            status="unavailable",
            reason=f"no resolvable OSM area name for city={city!r}",
        )

    hard_deadline = float(timeout_seconds) + HARD_DEADLINE_BUFFER_SECONDS

    # STAGE 1b/4: boundary VERIFICATION — see module docstring, "CRITMODE
    # — street inventory geography bug". Only for the auto-resolved-from-
    # `city` path: an explicit `area_name` is caller-vetted (same trust
    # already placed in the curated borough/neighborhood table) and is
    # used as-is, exactly as before this fix.
    if not area_name_was_explicit:
        _t_verify_start = time.monotonic()
        verification_failure = _verify_resolved_boundary(
            poster, endpoint_url, resolved_area, city, timeout_seconds, hard_deadline,
        )
        log.info(
            "[street-inventory] boundary verification city=%r area=%r ok=%s elapsed=%.3fs",
            city, resolved_area, verification_failure is None, time.monotonic() - _t_verify_start,
        )
        if verification_failure is not None:
            return verification_failure

    query = build_street_ql(resolved_area, timeout_seconds=timeout_seconds)

    # STAGE 2/4: the actual Overpass network call. Bounded twice: (a) the
    # per-socket-operation `timeout_seconds` urllib itself enforces, and
    # (b) the hard wall-clock deadline below, which is what actually
    # guarantees this call returns (or raises) in bounded time — see
    # `_deadline.py` for why (a) alone is not sufficient.
    log.info(
        "[street-inventory] overpass request start city=%r area=%r endpoint=%s timeout=%ss hard_deadline=%ss",
        city, resolved_area, endpoint_url, timeout_seconds, hard_deadline,
    )
    _t_overpass_start = time.monotonic()
    try:
        payload = call_with_hard_deadline(
            poster, endpoint_url, query, _HEADERS, float(timeout_seconds),
            deadline_seconds=hard_deadline,
        )
    except urllib.error.HTTPError as exc:
        log.warning(
            "[street-inventory] Overpass HTTP error for city=%r area=%r after %.1fs: %s",
            city, resolved_area, time.monotonic() - _t_overpass_start, exc,
        )
        return StreetInventoryResult(status="unavailable", reason=f"overpass http error: {exc}")
    except urllib.error.URLError as exc:
        log.warning(
            "[street-inventory] Overpass network error for city=%r area=%r after %.1fs: %s",
            city, resolved_area, time.monotonic() - _t_overpass_start, exc,
        )
        return StreetInventoryResult(status="unavailable", reason=f"overpass network error: {exc}")
    except (TimeoutError, OSError) as exc:
        log.warning(
            "[street-inventory] Overpass timeout/OS error for city=%r area=%r after %.1fs (hard_deadline=%ss): %s",
            city, resolved_area, time.monotonic() - _t_overpass_start, hard_deadline, exc,
        )
        return StreetInventoryResult(status="unavailable", reason=f"overpass timeout/error: {exc}")
    except (ValueError, json.JSONDecodeError) as exc:
        log.warning(
            "[street-inventory] malformed Overpass response for city=%r area=%r after %.1fs: %s",
            city, resolved_area, time.monotonic() - _t_overpass_start, exc,
        )
        return StreetInventoryResult(status="unavailable", reason=f"malformed overpass response: {exc}")
    _overpass_elapsed = time.monotonic() - _t_overpass_start
    log.info(
        "[street-inventory] overpass request done city=%r area=%r elapsed=%.1fs",
        city, resolved_area, _overpass_elapsed,
    )

    # STAGE 3/4: parsing the response.
    _t_parse_start = time.monotonic()
    elements = payload.get("elements") if isinstance(payload, dict) else None
    if elements is None:
        return StreetInventoryResult(status="unavailable", reason="overpass response missing 'elements'")

    # Group by normalized name: one real street is frequently split
    # across several OSM `way` segments sharing one `name` tag. Keep
    # the FIRST raw name seen as the display `street_name`, and the
    # lowest way id as the representative `source_id` — both arbitrary-
    # but-deterministic tie-breaks (sorted by way id) so repeated runs
    # over the same OSM data pick the same representative every time
    # (see this phase's own "Data refresh / upsert" requirement that
    # repeated generation must not create duplicate/drifting rows).
    by_normalized: dict[str, dict[str, Any]] = {}
    for element in sorted(elements, key=lambda e: e.get("id") or 0):
        tags = element.get("tags") or {}
        raw_name = tags.get("name")
        if not raw_name or not raw_name.strip():
            continue
        try:
            normalized = normalize_street_name(raw_name)
        except ValueError:
            continue

        way_id = element.get("id")
        entry = by_normalized.get(normalized)
        if entry is None:
            by_normalized[normalized] = {
                "raw_name": raw_name.strip(),
                "way_ids": [way_id] if way_id is not None else [],
            }
        elif way_id is not None:
            entry["way_ids"].append(way_id)

    streets: list[StreetRecord] = []
    for normalized, entry in sorted(by_normalized.items()):
        street_key = build_street_key(country_code, region, city, normalized)
        way_ids = entry["way_ids"]
        streets.append(
            StreetRecord(
                street_key=street_key,
                street_name=entry["raw_name"],
                normalized_name=normalized,
                country_code=country_code,
                country_name=country_name,
                region=region,
                city=city,
                source="overpass",
                source_id=(f"way/{way_ids[0]}" if way_ids else None),
                metadata={"osm_way_ids": way_ids, "osm_area_name": resolved_area},
            )
        )

    log.info(
        "[street-inventory] parsed city=%r elements=%d streets=%d elapsed=%.3fs",
        city, len(elements), len(streets), time.monotonic() - _t_parse_start,
    )
    return StreetInventoryResult(status="ok", streets=tuple(streets))
