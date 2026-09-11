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
      normalization instead of HTTP transport). On failure, this raw
      transport simply raises — retry/backoff and mirror-fallover for
      TRANSIENT failures now happen one layer above it
      (`_post_with_retry_and_fallback`, added for the 429-handling fix
      below), reusing that provider's already-configured mirror list
      and retryable-status-code set as DATA, still without importing
      its transport machinery. A non-transient failure (a genuine,
      non-retryable error, or every retry/mirror attempt exhausted)
      still simply propagates to the caller
      (`fetch_city_street_inventory` below), which converts it into
      the "unavailable" result this phase's instructions require.

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

CRITMODE follow-up — `region="NY"` alone did not fix the NYC case
----------------------------------------------------------------------
The layer 2 safety net above (v1) treated ANY multi-match as simply
ambiguous and refused it — correct for a truly ambiguous name, but it
turned out "New York City" itself is `area["name"="New York City"]`
against 2 distinct real-world OSM boundaries (not the state; the
curated mapping already prevents that collision). The caller
(`rebuildNewYorkStreetInventory.ts`) already supplied `region="NY"`
expecting it to disambiguate this — but v1 never read `region` at
all; it reached `fetch_city_street_inventory()` and was used only for
`StreetRecord.region` / `street_key` construction, never for boundary
resolution or verification. Passing `region` did nothing to fix the
ambiguity because nothing downstream looked at it.

The fix (`_resolve_area_scope()`, v2, this section) is generic — no
per-city table: when a name match is ambiguous AND the caller supplied
both `region` and `country_code`, it builds a real, standard OSM
`ISO3166-2` subdivision code (e.g. "US" + "NY" -> "US-NY" — the exact
tag OSM already puts on the New York STATE boundary relation, and on
every other country's first-level-subdivision relations) and retries
the same name match narrowed to boundaries contained within that
subdivision (`area["ISO3166-2"="US-NY"]->.searchRegion; area["name"=
"New York City"](area.searchRegion)->.a;`). If that narrows the match
to exactly one boundary, THAT boundary is used — for both the
(re-verified) admin_level check and, critically, the real street
query, which is built with the identical `ISO3166-2`-narrowed shape
(see `build_street_ql()`'s own `iso3166_2` parameter) so the ways
fetch cannot re-introduce the same collision the flat name would.
Region-based narrowing to anything other than exactly one boundary
(zero, or still more than one) falls back to the original "reject as
ambiguous" outcome — this is a resolution path, not a new way to
suppress a genuine ambiguity.

CRITMODE — Overpass 429 handling
----------------------------------------------------------------------
Root cause: with the geography bug above fixed and boundary
verification working, a real street query now reaches Overpass
successfully — and can now receive Overpass's own `HTTP Error 429: Too
Many Requests` when the shared public `overpass-api.de` endpoint is
rate-limiting. Before this fix, `_http_post_urllib` made exactly ONE
POST attempt and raised immediately on any failure, transient or not
— so a single 429 sent an otherwise-valid, already-boundary-verified
city straight to `status="unavailable"` on the very first rate-limit
response, no differently than a genuinely nonexistent city or a dead
endpoint. This module's own transport was doing exactly what its
docstring said it would ("why a new small module ... does not retry,
fail over across mirrors, or catch anything") — this was a correct
description of a real gap, not a bug in that description.

Fix: `_post_with_retry_and_fallback()` (see its own docstring) wraps
the transport with a small, BOUNDED retry-with-backoff loop for
transient failures (429/502/503/504, network/timeout errors), and
falls over to the next mirror in `providers/overpass_provider.py`'s
already-configured `_DEFAULT_MIRRORS` list once one endpoint's retries
are exhausted — reusing that list and `_RETRYABLE_STATUS_CODES` as
DATA (see this module's import section), not importing that provider's
retry/mirror transport itself, for the same "hidden coupling" reason
the module docstring above already gives for not reusing its HTTP
machinery wholesale. Both call sites that hit the network
(`_run_boundary_check_query`'s boundary-verification query, and the
real street query in `fetch_city_street_inventory`) route through this
wrapper — not just the street query the original incident report
named — because boundary verification hits the exact same rate-limited
endpoint, usually first (it runs before the street query, see STAGE
1b/4 below): leaving it unretried would still send a valid city to
"unavailable" on a 429 raised one stage earlier than before.

Explicitly NOT changed by this fix: geography resolution
(`normalize_osm_area`) and boundary verification (`_resolve_area_scope`
/ `_verify_resolved_boundary`) are untouched — this fix is purely
about how many times, and against how many endpoints, this module is
willing to ask Overpass the same already-correct question before
giving up. The existing hard wall-clock deadline
(`call_with_hard_deadline` / `hard_deadline`) still bounds the ENTIRE
retry-and-fallback attempt as a single call, so retries never make a
slow city hang longer than before — they make a rate-limited-but-
otherwise-healthy city more likely to succeed within the SAME existing
deadline instead of giving up after one HTTP response. Retries are
bounded (never infinite — see `_MAX_RETRIES_PER_ENDPOINT`), and the
"unavailable" result for a city that fails every attempt against every
endpoint is byte-for-byte the same shape it was before this fix.

CRITMODE — NYC region-disambiguated fetch returning 0 streets
----------------------------------------------------------------------
Root cause: with geography resolution AND boundary verification both
succeeding (`boundary resolved ... area='New York City'`, `narrowed to
subdivision 'US-NY'`, `boundary verification ... ok=True
iso3166_2='US-NY'`), the real street fetch still came back with
`elements=0 streets=0`. The verification query and the street query
used the IDENTICAL name+region filter chain
(`area["ISO3166-2"="US-NY"]->.searchRegion;
area["name"="New York City"](area.searchRegion)->.<set>;`) — but as
two SEPARATE Overpass requests. The verification request only ever
does `.a out tags;` on the result, which needs just that area's id/
tags and succeeds regardless of whether Overpass has the area's full
polygon geometry materialized; the street request's
`way["highway"]["name"](area.searchArea);` additionally needs that
real geometry to do spatial containment, and re-deriving the same
name+region match a second time, in a fresh request, is not guaranteed
to attach it — which is exactly what happened for New York City. This
is a mismatched-boundary-identifier bug in the narrow sense that the
street query was scoping to "whatever `area["name"=...](area.<region>)`
happens to resolve to this time", not to the specific, concrete
boundary verification had already confirmed.

Fix: `_resolve_area_scope()` now also returns the concrete Overpass
numeric area id of the boundary the narrowed match identified
(`area_id_used`, read from the verification response's own `"id"`
field), and `fetch_city_street_inventory()` passes it to
`build_street_ql(area_id=...)`, which — when given — scopes the street
fetch directly by that id (`area(<id>)->.searchArea;`) instead of
re-deriving the boundary via `area["name"=...](area["ISO3166-2"=...])`
a second time. This applies ONLY to the region-narrowed disambiguation
path (`iso3166_2_used` set); the flat, unambiguous `area["name"=...]`
case (the overwhelming majority of cities) and the explicit-`area_name`
case are both untouched — see `build_street_ql()`'s own docstring.
Geography resolution, verification's ambiguity/admin_level checks, and
retry/fallback behavior are all unchanged by this fix.
"""

from __future__ import annotations

import json
import logging
import random
import time
import urllib.error
import urllib.request
from typing import Any, Callable, Optional

from providers.provider_request_translation import normalize_osm_area

# CRITMODE — Overpass 429 handling. Reused here: ONLY the already-
# configured, already-vetted list of known-good public Overpass
# mirrors (`_DEFAULT_MIRRORS`) and the retryable-status-code set
# (`_RETRYABLE_STATUS_CODES`) `providers/overpass_provider.py` already
# defines and uses for its own (unrelated, live-discovery-path) retry/
# mirror-failover transport. This is data, not behavior — the same
# "what IS reused" precedent this module's own docstring already
# establishes for `normalize_osm_area` below, not a new coupling to
# that provider's retry machinery (see this module's docstring, "why a
# new small module instead of reusing OverpassProvider", for why this
# module still does not import that provider's HTTP transport itself).
# `tests/test_phase42_overpass_wall_clock.py` already imports
# `_DEFAULT_MIRRORS` the same way, so this is an established pattern,
# not a new one.
from providers.overpass_provider import _DEFAULT_MIRRORS, _RETRYABLE_STATUS_CODES
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


#: CRITMODE — Overpass 429 handling.
#:
#: Bounded number of attempts against any ONE Overpass endpoint before
#: `_post_with_retry_and_fallback` moves on to the next configured
#: mirror. Deliberately small — the outer `call_with_hard_deadline`
#: (both call sites below) is what actually bounds worst-case total
#: time; this only avoids treating a single transient 429/5xx as fatal
#: after exactly one attempt. Same value `overpass_provider.py`'s own
#: `_http_post_urllib` defaults to (`max_retries_per_endpoint=2`) —
#: not copied for its own sake, just no reason to pick a different
#: number for the same kind of transient failure.
_MAX_RETRIES_PER_ENDPOINT = 2

#: Same base backoff factor `overpass_provider.py`'s own transport
#: uses (`backoff_factor=0.5`) for `delay = factor * (2 ** attempt) +
#: jitter` — exponential backoff with a small random jitter, applied
#: only when Overpass did not tell us how long to wait itself (see
#: `_retry_delay` below).
_RETRY_BACKOFF_FACTOR_SECONDS = 0.5


def _retry_delay(attempt: int, retry_after: Optional[str] = None) -> float:
    """
    Seconds to wait before the next attempt. Prefers Overpass's own
    `Retry-After` response header when present (the server telling us
    exactly how long it wants us to back off, which is more accurate
    than any guess this module could make) — otherwise falls back to
    exponential backoff with jitter, same shape as
    `overpass_provider.py`'s own retry loop.
    """
    if retry_after:
        try:
            return float(retry_after)
        except ValueError:
            pass
    return _RETRY_BACKOFF_FACTOR_SECONDS * (2 ** attempt) + random.uniform(0, 0.25)


def _post_with_retry_and_fallback(
    poster: HttpPost,
    endpoint_url: str,
    query: str,
    headers: dict[str, str],
    timeout_seconds: float,
    deadline: Optional[float] = None,
) -> dict[str, Any]:
    """
    CRITMODE — Overpass 429 handling.

    Root cause this closes: `poster` (by default `_http_post_urllib`
    above) previously made exactly one POST and raised immediately on
    ANY failure — correct for a genuine, permanent failure, but it
    meant a single transient 429 from the primary public mirror
    (`overpass-api.de`) sent an otherwise-valid, boundary-verified city
    straight to `status="unavailable"` (and, one layer up, whatever
    caller-side area-mode fallback treats "unavailable" as its signal)
    on the very first rate-limit response, with no attempt to wait it
    out or try another known-good mirror. The geography fix (module
    docstring, "CRITMODE — street inventory geography bug") was
    already correct and is untouched by this change; this closes a
    separate, purely transport-level failure mode that only became
    reachable once that fix let real street queries actually reach
    Overpass.

    Wraps `poster` with a small, BOUNDED retry-with-backoff loop for
    transient failures — HTTP 429/502/503/504
    (`_RETRYABLE_STATUS_CODES`, imported from
    `providers/overpass_provider.py` — see this module's import
    section for why reusing that set specifically is safe) plus
    network/timeout errors — and, once `endpoint_url`'s own retries
    are exhausted, fails over to the next candidate drawn from that
    SAME provider's already-configured, already-vetted mirror list
    (`_DEFAULT_MIRRORS`). A non-retryable HTTP error (any code NOT in
    `_RETRYABLE_STATUS_CODES` — e.g. a malformed query, a genuine 4xx)
    is raised immediately, with no retry and no fallover: a different
    attempt or a different mirror would not succeed where the query
    itself is the problem. This is the exact same distinction
    `overpass_provider.py`'s own transport already makes.

    CRITMODE — retry/fallback deadline interaction fix:

    `deadline` (an absolute `time.monotonic()` timestamp) makes this
    function deadline-aware. Before every attempt, the remaining wall-
    clock budget is checked; if exhausted, a `TimeoutError` is raised
    immediately instead of starting another attempt. The per-attempt
    urllib timeout passed to `poster` is `min(timeout_seconds,
    remaining)` — so a late attempt never outlives the overall budget.
    Backoff sleeps are capped at the remaining budget. No new endpoint
    is started if the budget is exhausted.

    This closes the gap where the outer `call_with_hard_deadline`
    (both call sites below) would fire its `Future.result(timeout=...)`
    while the worker thread was still inside a retry/backoff/fallback
    cycle — producing log lines and socket activity AFTER the caller
    had already returned "deadline exceeded". With `deadline` set, the
    worker thread self-terminates within budget, so the
    `Future.result(timeout=...)` should never fire under normal
    operation — but if it does (e.g. a DNS stall that
    `time.monotonic()` cannot interrupt), the hard deadline still
    catches it. This is defense-in-depth, not a redesign.

    `deadline=None` (the default) preserves the original behavior:
    no budget checks, the full `timeout_seconds` on every attempt.
    This keeps backward compatibility for direct callers and existing
    tests that exercise the retry loop without a deadline.

    One deliberate difference from `overpass_provider.py`'s own loop:
    this one does not sleep after an endpoint's LAST attempt (only
    between same-endpoint retries) — there is no reason to pay a
    backoff delay for a mirror hop, only for retrying the same,
    possibly-still-limited server.

    Bounded on purpose, never infinite: at most
    `_MAX_RETRIES_PER_ENDPOINT` attempts per candidate URL, across at
    most `len(candidate_urls)` candidates (`endpoint_url` plus any of
    `_DEFAULT_MIRRORS` not already equal to it — never a fresh,
    unbounded list; see this phase's own "do not hardcode a giant
    endpoint list" instruction).

    Exhausting every attempt against every candidate re-raises the
    LAST exception seen, unmodified. Both call sites below already
    convert that into `status="unavailable"` with a `reason` — this
    change does not touch that conversion, only how much genuine
    effort happens before it's reached.
    """
    candidate_urls = [endpoint_url]
    for mirror in _DEFAULT_MIRRORS:
        if mirror not in candidate_urls:
            candidate_urls.append(mirror)

    last_exception: BaseException | None = None
    for target_url in candidate_urls:
        # ── Budget check 4: before starting a new endpoint ──
        if deadline is not None:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                log.warning(
                    "[street-inventory] deadline expired before starting endpoint %s — stopping",
                    target_url,
                )
                break

        for attempt in range(_MAX_RETRIES_PER_ENDPOINT):
            # ── Budget check 1: before every attempt ──
            if deadline is not None:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    log.warning(
                        "[street-inventory] deadline expired before attempt %d/%d against %s — stopping",
                        attempt + 1, _MAX_RETRIES_PER_ENDPOINT, target_url,
                    )
                    break

            # ── Budget check 2: cap per-attempt timeout ──
            effective_timeout = timeout_seconds
            if deadline is not None:
                remaining = deadline - time.monotonic()
                effective_timeout = min(timeout_seconds, max(remaining, 0.1))

            try:
                return poster(target_url, query, headers, effective_timeout)
            except urllib.error.HTTPError as exc:
                last_exception = exc
                if exc.code not in _RETRYABLE_STATUS_CODES:
                    raise
                if attempt < _MAX_RETRIES_PER_ENDPOINT - 1:
                    retry_after = exc.headers.get("Retry-After") if exc.headers else None
                    delay = _retry_delay(attempt, retry_after)
                    # ── Budget check 3: cap backoff sleep ──
                    if deadline is not None:
                        remaining = deadline - time.monotonic()
                        if remaining <= 0:
                            log.warning(
                                "[street-inventory] deadline expired after HTTP %d from %s "
                                "(attempt %d/%d) — not retrying",
                                exc.code, target_url, attempt + 1, _MAX_RETRIES_PER_ENDPOINT,
                            )
                            break
                        delay = min(delay, remaining)
                    log.warning(
                        "[street-inventory] HTTP %d from %s (attempt %d/%d) — "
                        "retrying in %.2fs",
                        exc.code, target_url, attempt + 1, _MAX_RETRIES_PER_ENDPOINT, delay,
                    )
                    time.sleep(delay)
            except (urllib.error.URLError, TimeoutError, OSError) as exc:
                last_exception = exc
                if attempt < _MAX_RETRIES_PER_ENDPOINT - 1:
                    delay = _retry_delay(attempt)
                    # ── Budget check 3 (network errors): cap backoff sleep ──
                    if deadline is not None:
                        remaining = deadline - time.monotonic()
                        if remaining <= 0:
                            log.warning(
                                "[street-inventory] deadline expired after network error from %s "
                                "(attempt %d/%d) — not retrying",
                                target_url, attempt + 1, _MAX_RETRIES_PER_ENDPOINT,
                            )
                            break
                        delay = min(delay, remaining)
                    log.warning(
                        "[street-inventory] network error (%s) connecting to %s "
                        "(attempt %d/%d) — retrying in %.2fs",
                        exc, target_url, attempt + 1, _MAX_RETRIES_PER_ENDPOINT, delay,
                    )
                    time.sleep(delay)
        else:
            # Inner loop completed without break — all attempts for this
            # endpoint exhausted normally (not by deadline).
            log.warning(
                "[street-inventory] exhausted %d attempt(s) against %s — trying next "
                "Overpass endpoint if one remains",
                _MAX_RETRIES_PER_ENDPOINT, target_url,
            )
            continue
        # Inner loop broke (deadline expired) — stop the outer loop too.
        break

    # When breaking due to a deadline, raise TimeoutError so the caller
    # sees the same exception shape `call_with_hard_deadline` would have
    # produced — not the last transient 429/network error.
    if deadline is not None and time.monotonic() >= deadline:
        raise TimeoutError(
            f"_post_with_retry_and_fallback deadline expired "
            f"(budget exhausted across {len(candidate_urls)} endpoint(s))"
        )

    # candidate_urls always has at least one entry (endpoint_url), and
    # every loop iteration that reaches the bottom without returning
    # has already assigned last_exception — so this is always bound by
    # the time every candidate is exhausted, never raised as unset.
    if last_exception is not None:
        raise last_exception
    # Should be unreachable — candidate_urls is never empty and every
    # iteration either returns or sets last_exception — but satisfy the
    # type checker.
    raise RuntimeError("_post_with_retry_and_fallback: no attempts made")


def build_street_ql(
    area_name: str,
    timeout_seconds: int = DEFAULT_TIMEOUT_SECONDS,
    iso3166_2: Optional[str] = None,
    area_id: Optional[int] = None,
) -> str:
    """
    Builds the Overpass QL query text for enumerating named streets
    inside `area_name`. See module docstring, "Query shape".

    CRITMODE — NYC region-disambiguated fetch returning 0 streets:
    when `area_id` is given (the concrete Overpass numeric area
    pseudo-id — e.g. `3600175905` — that `_resolve_area_scope()`
    already confirmed, via a SEPARATE verification request, to be the
    single correct boundary), the street fetch targets that exact area
    by id (`area(<id>)->.searchArea;`) instead of re-deriving it a
    second time from `area_name`/`iso3166_2`. This is used ONLY for the
    region-narrowed disambiguation path (see `iso3166_2` below): asking
    Overpass to re-resolve `area["name"=...](area["ISO3166-2"=...])`
    from scratch, in a brand-new independent request, does not
    reliably reproduce the exact same fully-materialized boundary the
    verification request found (`out tags;` on an "area" match needs
    only that area's tags/id and succeeds regardless; the follow-on
    `way[...](area.searchArea)` spatial fetch additionally needs that
    area's real polygon geometry, which is not guaranteed to be
    identically available when the same name+region filter chain is
    re-evaluated a second time) — this was confirmed in production:
    `overpass request ... elements=0 streets=0` for New York, with
    boundary verification (`ok=True iso3166_2='US-NY'`) having already
    succeeded. Passing the concrete, already-verified id removes this
    re-derivation entirely for the one path that needs it.

    When `iso3166_2` is given (e.g. "US-NY") and `area_id` is NOT, the
    area lookup is constrained to the boundary carrying that
    `ISO3166-2` tag before matching `area_name` inside it — this shape
    is kept for callers/tests that still want it, but
    `fetch_city_street_inventory` itself always supplies `area_id`
    whenever `_resolve_area_scope()` narrowed via `iso3166_2`, so this
    branch is not reached on that path anymore. When neither is given
    (the common, unambiguous case), this is byte-for-byte the original
    flat `area["name"=...]` query.
    """
    escaped_area = area_name.replace('"', '\\"')
    if area_id is not None:
        return (
            f"[out:json][timeout:{timeout_seconds}];\n"
            f"area({area_id})->.searchArea;\n"
            f'way["highway"]["name"](area.searchArea);\n'
            f"out tags;"
        )
    if iso3166_2:
        escaped_iso = iso3166_2.replace('"', '\\"')
        return (
            f"[out:json][timeout:{timeout_seconds}];\n"
            f'area["ISO3166-2"="{escaped_iso}"]->.searchRegion;\n'
            f'area["name"="{escaped_area}"](area.searchRegion)->.searchArea;\n'
            f'way["highway"]["name"](area.searchArea);\n'
            f"out tags;"
        )
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

#: CRITMODE — way-derived area ID fix.
#:
#: Overpass computes area pseudo-IDs for OSM relations as:
#:     area_id = 3600000000 + relation_id
#: Way-derived areas use a lower offset range and — critically — their
#: area pseudo-elements lack the closed polygon geometry that Overpass's
#: `way[...](area.searchArea)` spatial containment operator requires.
#: An `area["name"="..."]` query can return BOTH relation-derived AND
#: way-derived areas; only the former are usable for city-level street
#: containment. See forensic diagnosis: area_id 1107357380 (a way-derived
#: area for a small polygon tagged "New York City") returned 0 streets;
#: area_id 3600175905 (the relation-derived area for the real NYC
#: administrative boundary, relation/175905) returned tens of thousands.
_OVERPASS_RELATION_AREA_ID_OFFSET = 3_600_000_000

#: CRITMODE — contaminated New York inventory follow-up.
#:
#: A durable identifier for "the boundary-resolution/verification logic
#: that produced this row", stamped onto every `StreetRecord` this
#: module returns (see bottom of `fetch_city_street_inventory`).
#: Persisted as `discovery_streets.boundary_version` (migration 032).
#:
#: Bump this string — to a new, never-reused value — every time this
#: module's boundary resolution or verification behavior changes in any
#: way that could change which streets a city's inventory contains
#: (e.g. a new curated `_OSM_AREA_NORMALIZATIONS` entry, a change to
#: `_verify_resolved_boundary()`'s admin_level cutoff, a new safety
#: check). The Node-side freshness check
#: (`streetDiscovery.ts:CURRENT_STREET_BOUNDARY_VERSION`) MUST be bumped
#: to the same value in the same change — the two constants are one
#: logical version, kept in two files only because the two runtimes
#: don't share a module.
#:
#: This value specifically marks the fix described in this module's own
#: "CRITMODE — street inventory geography bug" section: the curated
#: "New York" -> "New York City" mapping plus `_resolve_area_scope()`
#: (formerly `_verify_resolved_boundary()`), including its region-based
#: same-name-collision disambiguation (see that function's docstring —
#: "New York City" itself turned out to match 2 distinct real-world OSM
#: boundaries by name alone, which the v1 admin_level-only check could
#: only reject, not resolve). Any row still carrying an older value (or
#: the `StreetRecord` default, `"unversioned"` — real for every row
#: inserted before this constant existed) was produced before that fix
#: existed and must not be trusted as proof a city's inventory is
#: current, no matter its row count.
#: CRITMODE — NYC region-disambiguated fetch returning 0 streets: the
#: region-narrowed disambiguation path (`iso3166_2_used` set) now fetches
#: via the verified boundary's concrete `area_id` instead of re-deriving
#: the same name+region filter chain a second time for the real street
#: query — see `build_street_ql()`'s docstring. This can change the
#: resulting street set for any city that previously fell into that
#: narrowed path (previously: silently 0 streets), so the version is
#: bumped again.
BOUNDARY_VERSION = "admin-level-verified-v4-relation-area-id"


def build_boundary_check_ql(
    area_name: str,
    timeout_seconds: int = DEFAULT_TIMEOUT_SECONDS,
    iso3166_2: Optional[str] = None,
) -> str:
    """
    Builds the (tiny, tags-only, no ways) Overpass QL query text used
    by `_resolve_area_scope()` to inspect exactly which OSM area(s)
    `area_name` matches before trusting it to scope the real street
    query. See module docstring for why this exists, and
    `build_street_ql()` for what `iso3166_2` narrows the match to.
    """
    escaped_area = area_name.replace('"', '\\"')
    if iso3166_2:
        escaped_iso = iso3166_2.replace('"', '\\"')
        return (
            f"[out:json][timeout:{timeout_seconds}];\n"
            f'area["ISO3166-2"="{escaped_iso}"]->.searchRegion;\n'
            f'area["name"="{escaped_area}"](area.searchRegion)->.a;\n'
            f".a out tags;"
        )
    return (
        f"[out:json][timeout:{timeout_seconds}];\n"
        f'area["name"="{escaped_area}"]->.a;\n'
        f".a out tags;"
    )


def build_relation_boundary_ql(
    area_name: str,
    timeout_seconds: int = DEFAULT_TIMEOUT_SECONDS,
    iso3166_2: Optional[str] = None,
) -> str:
    """
    CRITMODE — way-derived area ID fix.

    Builds an Overpass QL query to find the actual administrative boundary
    RELATION for `area_name`, as opposed to `build_boundary_check_ql()`
    which searches Overpass's `area` pseudo-elements (and may return
    way-derived areas that lack polygon geometry for spatial containment).

    Used by `_resolve_area_scope()` as a fallback when the area-based
    boundary check returns only way-derived IDs (< 3600000000). The
    returned relation's OSM id is converted to an Overpass area id via
    `_OVERPASS_RELATION_AREA_ID_OFFSET + relation_id`.

    CRITMODE — alt_name fix: matches on `name` OR `alt_name`, not `name`
    alone. Root cause this closes: a city's `area_name` (e.g. "New York
    City", the value `_OSM_AREA_NORMALIZATIONS`/`normalize_osm_area`
    resolve to and that `area["name"=...]` therefore matched a way-
    derived area under) is not always the SAME string the real
    administrative boundary RELATION carries in its own `name` tag —
    that relation's `name` can instead hold the more formal/official
    value (e.g. "New York", with "New York City" only present as
    `alt_name`), a real, common OSM tagging pattern, not specific to any
    one city. A `name`-only relation filter silently matched 0 relations
    for exactly this reason, live in production, even though the correct
    administrative relation genuinely exists in OSM with the expected
    `admin_level`/`boundary=administrative` tags. Querying `name` OR
    `alt_name` against `area_name` catches both tagging shapes generically
    — no per-city table, no hardcoded city name — while every existing
    constraint (the `boundary=administrative` filter, and the
    `ISO3166-2` subdivision containment when `iso3166_2` is given) still
    applies to both branches identically.
    """
    escaped_area = area_name.replace('"', '\\"')
    if iso3166_2:
        escaped_iso = iso3166_2.replace('"', '\\"')
        return (
            f"[out:json][timeout:{timeout_seconds}];\n"
            f'area["ISO3166-2"="{escaped_iso}"]->.searchRegion;\n'
            f"(\n"
            f'  relation["name"="{escaped_area}"]["boundary"="administrative"](area.searchRegion);\n'
            f'  relation["alt_name"="{escaped_area}"]["boundary"="administrative"](area.searchRegion);\n'
            f");\n"
            f"out tags;"
        )
    return (
        f"[out:json][timeout:{timeout_seconds}];\n"
        f"(\n"
        f'  relation["name"="{escaped_area}"]["boundary"="administrative"];\n'
        f'  relation["alt_name"="{escaped_area}"]["boundary"="administrative"];\n'
        f");\n"
        f"out tags;"
    )


#: ISO 3166-2 subdivision codes ("US-NY", "CA-ON", "GB-LND", ...) are
#: short — almost always 2-3 characters after the country prefix — and
#: alphanumeric, never containing a space. A `region` value that is
#: longer than this or contains whitespace is almost certainly a full
#: subdivision NAME ("New York", "Ontario"), not the CODE the OSM
#: `ISO3166-2` tag actually stores, and guessing a code out of a name
#: would silently fabricate a filter that matches nothing (or, worse,
#: something unrelated) rather than degrading safely.
_MAX_ISO3166_2_SUBDIVISION_CODE_LENGTH = 3


def _resolve_iso3166_2(country_code: Optional[str], region: Optional[str]) -> Optional[str]:
    """
    Builds a best-effort ISO 3166-2 subdivision code (e.g. "US" + "NY"
    -> "US-NY") from the caller-supplied `country_code` + `region`,
    for use as a *disambiguating* containment filter — see
    `_resolve_area_scope()`.

    This is deliberately generic (no per-country/per-city table): ISO
    3166-2 is the real, standard tag OSM already puts on first-level-
    subdivision (state/province) boundary relations, and `region` is
    already the same kind of short subdivision code this codebase
    passes to every other provider (see `DiscoveryQueryContext.region`
    and `GoogleMapsDiscoveryRequest.region`) — so no new caller-facing
    concept is introduced, only a new consumer of the existing one.

    Returns `None` — meaning "don't attempt containment-based
    disambiguation" — when either piece is missing, or `region`
    doesn't look like a code (see
    `_MAX_ISO3166_2_SUBDIVISION_CODE_LENGTH`). A skipped disambiguation
    degrades to the pre-existing "reject as ambiguous" behavior; it
    never fabricates a guessed code.
    """
    if not country_code or not region:
        return None
    cc = country_code.strip().upper()
    rc = region.strip().upper()
    if not cc or not rc:
        return None
    if " " in rc or len(rc) > _MAX_ISO3166_2_SUBDIVISION_CODE_LENGTH:
        return None
    return f"{cc}-{rc}"


def _run_boundary_check_query(
    poster: HttpPost,
    endpoint_url: str,
    query: str,
    timeout_seconds: int,
    hard_deadline: float,
    city: str,
    resolved_area: str,
) -> tuple[Optional[list], Optional[StreetInventoryResult]]:
    """
    Runs one boundary-check query (either the flat `build_boundary_check_ql`
    shape or its `iso3166_2`-narrowed variant) and returns
    `(elements, None)` on a well-formed transport response — `elements`
    may legitimately be an empty list, meaning zero OSM boundaries
    matched — or `(None, failure_result)` on a transport/parse error,
    which the caller must return as-is. Factored out of
    `_resolve_area_scope()` because that function now runs this same
    request/error-handling shape up to twice (an initial flat check,
    and — only when that one comes back ambiguous and a region is
    available — a second, region-narrowed retry).
    """
    try:
        _deadline_abs = time.monotonic() + hard_deadline
        payload = call_with_hard_deadline(
            _post_with_retry_and_fallback, poster, endpoint_url, query, _HEADERS, float(timeout_seconds),
            _deadline_abs,
            deadline_seconds=hard_deadline,
        )
    except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError, OSError) as exc:
        log.warning(
            "[street-inventory] boundary verification transport error for city=%r area=%r: %s",
            city, resolved_area, exc,
        )
        return None, StreetInventoryResult(
            status="unavailable", reason=f"boundary verification failed: {exc}"
        )
    except (ValueError, json.JSONDecodeError) as exc:
        log.warning(
            "[street-inventory] malformed boundary verification response for city=%r area=%r: %s",
            city, resolved_area, exc,
        )
        return None, StreetInventoryResult(
            status="unavailable", reason=f"malformed boundary verification response: {exc}"
        )

    elements = payload.get("elements") if isinstance(payload, dict) else None
    return (elements or []), None


def _resolve_area_scope(
    poster: HttpPost,
    endpoint_url: str,
    resolved_area: str,
    city: str,
    timeout_seconds: int,
    hard_deadline: float,
    region: Optional[str] = None,
    country_code: Optional[str] = None,
) -> tuple[Optional[StreetInventoryResult], Optional[str], Optional[int]]:
    """
    Confirms `resolved_area` names exactly one OSM boundary — resolving
    a same-named collision generically via `region`/`country_code` when
    one exists — and that the (single, resolved) boundary is not
    itself a country/state-level administrative area (see module
    docstring). Returns `(None, iso3166_2_used, area_id)` when the
    boundary checks out, where `iso3166_2_used` tells the caller which
    query shape actually identified a unique boundary — `None` for the
    plain `area["name"=...]` match, or e.g. `"US-NY"` when
    disambiguation via `region` was needed — and `area_id` is the
    concrete Overpass numeric area id of that single matched boundary
    (from the verification response's own `"id"` field) whenever
    `iso3166_2_used` is set, `None` otherwise. `build_street_ql()` is
    called with `area_id` (when set) so the real street fetch targets
    the EXACT boundary verification already confirmed, rather than
    re-deriving `area["name"=...](area["ISO3166-2"=...])` a second time
    — see `build_street_ql()`'s own docstring, "CRITMODE — NYC
    region-disambiguated fetch returning 0 streets", for why
    re-deriving it a second time is not reliable. Returns
    `(populated_result, None, None)` when the boundary does not check
    out — the caller returns that result directly.

    Only called for the auto-resolved-from-`city` path (see
    `fetch_city_street_inventory`'s own `area_name` handling) — an
    `area_name` the caller supplied explicitly is treated as already
    vetted, exactly like the existing curated borough/neighborhood
    table.

    Disambiguation strategy (why `region=NY` alone didn't fix the NYC
    case before this function existed): the ORIGINAL verification only
    ever asked Overpass "how many boundaries are named X" — `region`
    was collected from the caller but never reached the Overpass query
    at all, so two distinct real-world OSM boundaries sharing the exact
    name "New York City" (a genuine same-name collision, the same
    *shape* of bug as the state/city collision this safety net already
    catches, just between two same-level names instead of a state and
    a city) still triggered the ambiguity rejection. Given a `region` +
    `country_code`, this function builds a real, standard OSM
    `ISO3166-2` code (e.g. "US-NY") and retries the SAME name match
    narrowed to boundaries contained within that subdivision. This is
    generic — it uses no per-city table — so it applies equally to any
    other city whose name happens to collide nationwide but not within
    its own state/province.
    """
    elements, failure = _run_boundary_check_query(
        poster, endpoint_url, build_boundary_check_ql(resolved_area, timeout_seconds=timeout_seconds),
        timeout_seconds, hard_deadline, city, resolved_area,
    )
    if failure is not None:
        return failure, None, None

    iso3166_2_used: Optional[str] = None
    area_id_used: Optional[int] = None

    if not elements:
        log.warning(
            "[street-inventory] no OSM boundary named %r for city=%r — refusing to query an "
            "unverified/nonexistent area",
            resolved_area, city,
        )
        return StreetInventoryResult(
            status="unavailable",
            reason=f"no OSM boundary found named {resolved_area!r} for city={city!r}",
        ), None, None

    # CRITMODE — way-derived area ID fix, single-match gap.
    #
    # Root cause of "geography/relation/area all verified correct, real
    # Overpass control queries return 69k+ ways, yet production still
    # gets elements=0": this fallback (originally written, and tested,
    # only for the len(elements) > 1 narrowing path below) was never
    # reached when the FLAT, unqualified `area["name"=resolved_area]`
    # check matches exactly one boundary and that one match is itself
    # way-derived. In that shape, `area_id_used` was left `None` all the
    # way through this function, `build_street_ql()` was called without
    # `area_id`, and it silently re-derived `area["name"=...]` a SECOND
    # time inside the real street-fetch query — which can (and, for the
    # NYC case, does) resolve to the same way-derived pseudo-area again,
    # so `way[...](area.searchArea)` has no polygon to test containment
    # against and returns 0 elements. No geography, retry, or deadline
    # logic is touched: this only widens the SAME existing way-derived
    # check + relation-lookup fallback to run whenever exactly one
    # candidate area remains — whether that's because the flat query was
    # never ambiguous in the first place, or because region-narrowing
    # below reduced it to one.
    def _use_relation_fallback_if_way_derived(
        candidate_elements: list, iso3166_2_for_lookup: Optional[str],
    ) -> tuple[Optional[int], Optional[list], Optional[StreetInventoryResult]]:
        """
        Returns `(None, None, None)` when `candidate_elements[0]` is NOT
        way-derived (id missing, or >= the relation-area-id offset) —
        callers must decide for themselves what to do in that case,
        exactly as they did before this helper existed for their own
        path (the narrowed-ambiguity path already set `area_id_used =
        raw_area_id` itself in that case; the flat/unambiguous path
        left it `None` and let `build_street_ql()` re-derive by name,
        which is untouched, already-working behavior this fix does not
        change). This helper's only job is the way-derived case.
        """
        raw_area_id = candidate_elements[0].get("id")
        if raw_area_id is None or raw_area_id >= _OVERPASS_RELATION_AREA_ID_OFFSET:
            return None, None, None
        log.info(
            "[street-inventory] area_id %d for %r is way-derived (not a relation "
            "boundary) — querying for the actual administrative boundary relation",
            raw_area_id, resolved_area,
        )
        rel_elements, rel_failure = _run_boundary_check_query(
            poster, endpoint_url,
            build_relation_boundary_ql(
                resolved_area, timeout_seconds=timeout_seconds, iso3166_2=iso3166_2_for_lookup,
            ),
            timeout_seconds, hard_deadline, city, resolved_area,
        )
        if rel_failure is None and rel_elements and len(rel_elements) == 1:
            rel_id = rel_elements[0].get("id")
            if rel_id is not None:
                resolved_id = _OVERPASS_RELATION_AREA_ID_OFFSET + rel_id
                log.info(
                    "[street-inventory] found administrative boundary "
                    "relation %d for %r — using area_id %d",
                    rel_id, resolved_area, resolved_id,
                )
                # Use the relation's tags for the admin_level check below —
                # relations carry admin_level, way-derived areas typically
                # do not.
                return resolved_id, rel_elements, None
            return raw_area_id, None, None
        matched = len(rel_elements) if rel_elements is not None else 0
        log.warning(
            "[street-inventory] could not find a unique administrative "
            "boundary relation for %r (iso3166_2=%r, matched=%d) — "
            "way-derived area_id %d will not support spatial containment",
            resolved_area, iso3166_2_for_lookup, matched, raw_area_id,
        )
        return None, None, StreetInventoryResult(
            status="unavailable",
            reason=(
                f"area name {resolved_area!r} for city={city!r} matched only "
                f"way-derived areas (area_id={raw_area_id}), not an "
                f"administrative boundary relation usable for spatial containment"
            ),
        )

    if len(elements) > 1:
        iso3166_2 = _resolve_iso3166_2(country_code, region)
        if iso3166_2:
            log.info(
                "[street-inventory] area name %r for city=%r matched %d boundaries — retrying "
                "narrowed to subdivision %r before rejecting as ambiguous",
                resolved_area, city, len(elements), iso3166_2,
            )
            narrowed_elements, failure = _run_boundary_check_query(
                poster, endpoint_url,
                build_boundary_check_ql(resolved_area, timeout_seconds=timeout_seconds, iso3166_2=iso3166_2),
                timeout_seconds, hard_deadline, city, resolved_area,
            )
            if failure is not None:
                return failure, None, None
            if narrowed_elements and len(narrowed_elements) == 1:
                elements = narrowed_elements
                iso3166_2_used = iso3166_2
                fallback_area_id, replaced_elements, fallback_failure = (
                    _use_relation_fallback_if_way_derived(elements, iso3166_2)
                )
                if fallback_failure is not None:
                    return fallback_failure, None, None
                if replaced_elements is not None:
                    # Way-derived: relation fallback found the real
                    # boundary relation and its computed area id.
                    area_id_used = fallback_area_id
                    elements = replaced_elements
                else:
                    # Not way-derived (the common case for this
                    # narrowed-to-one path) — same as before this fix,
                    # use the matched area's own id directly.
                    area_id_used = elements[0].get("id")
            else:
                log.warning(
                    "[street-inventory] ambiguous OSM area name %r for city=%r matched %d distinct "
                    "boundaries and narrowing to subdivision %r matched %d — refusing to silently "
                    "pick one",
                    resolved_area, city, len(elements), iso3166_2, len(narrowed_elements),
                )
                return StreetInventoryResult(
                    status="unavailable",
                    reason=(
                        f"ambiguous OSM area name {resolved_area!r} for city={city!r} matched "
                        f"{len(elements)} distinct boundaries (narrowing to subdivision "
                        f"{iso3166_2!r} matched {len(narrowed_elements)})"
                    ),
                ), None, None
        else:
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
            ), None, None

    # CRITMODE — way-derived area ID fix, single-match gap (see above):
    # this is the flat, never-ambiguous case — `elements` still has its
    # original single entry from the very first boundary check, and
    # `area_id_used` has not been touched yet. Apply the SAME way-derived
    # check here so a way-derived single match falls back to the
    # relation lookup too, instead of silently proceeding to
    # `build_street_ql()` with no `area_id`, which then re-derives the
    # (possibly still way-derived) area by name a second time. When the
    # match is NOT way-derived, this changes nothing — `area_id_used`
    # stays `None` and the existing, already-working flat re-derivation
    # is used exactly as before this fix.
    if area_id_used is None:
        fallback_area_id, replaced_elements, fallback_failure = (
            _use_relation_fallback_if_way_derived(elements, iso3166_2_used)
        )
        if fallback_failure is not None:
            return fallback_failure, None, None
        if replaced_elements is not None:
            area_id_used = fallback_area_id
            elements = replaced_elements

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
            ), None, None

    return None, iso3166_2_used, area_id_used


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
    resolved_iso3166_2: Optional[str] = None
    resolved_area_id: Optional[int] = None
    if not area_name_was_explicit:
        _t_verify_start = time.monotonic()
        verification_failure, resolved_iso3166_2, resolved_area_id = _resolve_area_scope(
            poster, endpoint_url, resolved_area, city, timeout_seconds, hard_deadline,
            region=region, country_code=country_code,
        )
        log.info(
            "[street-inventory] boundary verification city=%r area=%r ok=%s iso3166_2=%r "
            "area_id=%r elapsed=%.3fs",
            city, resolved_area, verification_failure is None, resolved_iso3166_2,
            resolved_area_id, time.monotonic() - _t_verify_start,
        )
        if verification_failure is not None:
            return verification_failure

    query = build_street_ql(
        resolved_area,
        timeout_seconds=timeout_seconds,
        iso3166_2=resolved_iso3166_2,
        area_id=resolved_area_id,
    )

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
        _deadline_abs = time.monotonic() + hard_deadline
        payload = call_with_hard_deadline(
            _post_with_retry_and_fallback, poster, endpoint_url, query, _HEADERS, float(timeout_seconds),
            _deadline_abs,
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
                boundary_version=BOUNDARY_VERSION,
            )
        )

    log.info(
        "[street-inventory] parsed city=%r elements=%d streets=%d elapsed=%.3fs",
        city, len(elements), len(streets), time.monotonic() - _t_parse_start,
    )
    return StreetInventoryResult(status="ok", streets=tuple(streets))
