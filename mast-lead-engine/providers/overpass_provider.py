"""
MAST Engine V2 — OverpassProvider
====================================

Source: this milestone's own instructions ("implement OverpassProvider"),
engine/interfaces.py:DiscoveryProviderInterface, engine/contracts.py:
BusinessCandidate, and the three existing concrete providers this one is
built alongside — providers/google_maps_provider.py:GoogleMapsProvider,
providers/yelp_provider.py:YelpProvider, and
providers/apple_maps_provider.py:AppleMapsProvider — read for precedent,
not modified. Also read, not modified: providers/provider_metadata.py,
providers/provider_capabilities.py, providers/provider_configuration.py,
providers/registry.py, providers/composite_provider.py,
providers/parallel_composite_provider.py, providers/provider_deduplicator.py.
External reference: the Overpass API's own documentation
(wiki.openstreetmap.org/wiki/Overpass_API, wiki.openstreetmap.org/wiki/
Overpass_API/Overpass_QL) for the query language and the Overpass JSON
response shape this file's own field-selection rationale below cites —
the same discipline yelp_provider.py and apple_maps_provider.py already
apply to their respective third-party APIs.

This is not a new architecture. It is a fourth, independent answer to
the same interface GoogleMapsProvider, YelpProvider, and
AppleMapsProvider already answer — see this milestone's own
architecture review (delivered alongside this file) for why no engine/,
workers/, queues/, models/, or provider-platform file needed to change
to add it, and for the full reasoning on where niche->OSM-tag
translation does (and does not) belong.

Responsibility
--------------
OverpassProvider has exactly one job: accept a discovery request, query
the Overpass API's own interpreter endpoint
(POST https://overpass-api.de/api/interpreter) with an Overpass QL
query built directly from that request's OSM-native fields, and stream
BusinessCandidate objects — nothing else. Like the three providers
before it, it does not enrich, qualify, score, store, deduplicate,
retry, cache, allocate workers, or own queues.

No niche translation — by design, not by omission
----------------------------------------------------------------------
Per this milestone's own architecture review: `OverpassDiscoveryRequest`
exposes OpenStreetMap's own tag vocabulary directly (`tags: Mapping[str,
str]`, e.g. `{"amenity": "restaurant"}`) — the exact same discipline
YelpDiscoveryRequest already applies to Yelp's `categories` and
AppleMapsDiscoveryRequest already applies to Apple's `PoiCategory`
strings: "nothing is renamed or reinterpreted in translation." This
provider contains no `"restaurant" -> {"amenity": "restaurant"}`-style
lookup table, and none should be added here. A caller wanting to go
from a generic, provider-agnostic niche term to this provider's
`tags` mapping (or to Yelp's `categories`, or Apple's
`include_poi_categories`) needs a translation layer that sits above all
four providers — that layer does not exist anywhere in this codebase
today (no SearchGenerator, no DiscoverySession, nothing under engine/),
and inventing it was explicitly out of scope for this milestone (see
the architecture review, and google_maps_provider.py's own Ambiguity 3,
which declined the identical opportunity when GoogleMapsDiscoveryRequest
was first defined).

Why an injectable HTTP callable, not a hardwired HTTP client
--------------------------------------------------------------
Same reasoning as YelpProvider and AppleMapsProvider (see either
module's own docstring, "Why an injectable HTTP callable, not a
hardwired HTTP client"): no Overpass HTTP client exists yet in this
codebase, and this milestone's scope is the provider layer, not "also
write and own a general-purpose Overpass HTTP client." Unlike the GET-
based Fusion/Search endpoints, Overpass's interpreter endpoint is a
POST-of-query-text endpoint (the query itself, not a set of named query
parameters, is the request body — see "Request shape" below), so the
injected callable here is `http_post: (url, data, headers) -> dict`
rather than Yelp/Apple's `http_get: (url, params, headers) -> dict`.
The shape differs because the transport genuinely differs (Overpass QL
is submitted as a single opaque string, not decomposed query
parameters); the provider's relationship to that transport — a thin,
injectable, defaulted-to-a-real-network-call wrapper — does not.
Defaults to a small private helper built on the standard library
(`urllib.request`). Callers with their own HTTP client, retry policy,
or rate limiter may inject it instead. This also makes the provider
testable without network access (see validate_overpass_provider.py,
which injects a fake `http_post` returning a canned Overpass JSON
response shape).

No credential required
------------------------
Unlike YelpProvider (`api_key`) and AppleMapsProvider (`access_token`),
the public Overpass API requires no authentication at all — this is a
genuine, documented difference in the underlying source, not an
oversight. OverpassProvider therefore needs no credential parameter,
matching GoogleMapsProvider's own no-credential `__init__()`. What it
does accept is an optional `endpoint_url` override: several
interchangeable public Overpass instances exist (the default
`overpass-api.de` mirror, plus others such as `overpass.kumi.systems`),
each with its own independent rate-limiting — a caller hitting the
default mirror's rate limit may want to point this provider at a
different one without subclassing or forking it. This is configuration
of *which* Overpass instance to call, not a credential, so it is a
plain constructor argument rather than something request-scoped.

Request shape
--------------
Same reasoning as GoogleMapsDiscoveryRequest / YelpDiscoveryRequest /
AppleMapsDiscoveryRequest (see google_maps_provider.py, Ambiguity 3):
DiscoveryProviderInterface.discover() deliberately leaves the request
shape as `Any`, and no shared engine/contracts.py discovery-request
contract exists. OverpassDiscoveryRequest is therefore defined locally
here, mirroring Overpass QL's own real, documented primitives — nothing
invented, nothing borrowed from a different provider's vocabulary:

    - `tags` (required, `Mapping[str, str]`) — OSM key=value pairs,
      ANDed together (Overpass QL's own `["key"="value"]["key2"="value2"]`
      chained-filter syntax). This is the sole "what am I searching
      for" field, and it is OSM-native end to end — see "No niche
      translation" above.
    - `element_types` (`Sequence[str]`, default `("node", "way",
      "relation")`) — which of OSM's three real element types to
      query. Overpass QL queries each type with its own statement
      (`node[...]`, `way[...]`, `rel[...]`); this field controls which
      statements `discover()` builds, nothing more.
    - `bbox` — `(south, west, north, east)`, Overpass QL's own
      documented bounding-box filter syntax
      (`(south,west,north,east)` appended to an element statement).
    - `around` — `(radius_meters, lat, lon)`, Overpass QL's own
      documented `(around:radius,lat,lon)` filter — real proximity
      search the query language itself defines, unlike the three
      existing providers, none of which had a native radius primitive
      to expose (see provider_capabilities.py, "supports_radius_search"
      field description, for why Yelp's and Google's own request shapes
      were marked False on this exact point — Overpass's own query
      language is the first of the four sources that actually has one).
    - `area_name` — an OSM `name` tag value (e.g. `"Berlin"`), used to
      build Overpass QL's own documented `area["name"="..."]->.searchArea;`
      statement, scoping subsequent element statements to
      `(area.searchArea)`. The caller supplies the exact OSM area name;
      this provider builds the corresponding, syntactically-required QL
      statement around it — assembling valid query syntax from a
      caller-supplied value, not reinterpreting what that value means
      (the same category of "wiring," not "translating," that
      YelpProvider already does when it drops `request.location`
      untouched into a Fusion API URL parameter).
    - `bbox`, `around`, and `area_name` are mutually exclusive
      geographic scopes — Overpass QL applies exactly one spatial
      filter per element statement in this provider's own query
      construction, so a request specifying more than one is a caller-
      configuration error (see `__post_init__` below, same validate-
      what-the-data-itself-can-tell-you discipline
      ProviderConfiguration.__post_init__ already applies to its own
      `providers` field). A request specifying none is valid — Overpass
      QL permits an unscoped element query (it will simply be slow /
      likely rejected by a public instance for exceeding its resource
      limits, exactly as issuing no bbox/area on a public Overpass
      mirror behaves today); this provider does not invent a mandatory
      default scope.
    - `limit` (`Optional[int]`) — Overpass QL's own `out` statement
      accepts a numeric cap (`out center {limit};`); when unset, no cap
      is passed and Overpass returns everything the query matches.
    - `timeout_seconds` (`int`, default 25) — Overpass QL's own
      documented `[timeout:N]` query-header setting, telling the
      Overpass *server* how long it may spend evaluating the query
      before aborting server-side. Passed straight into the query
      text, exactly as documented.
    - `session_id` — owned by the caller, for the same reason the other
      three requests carry it: BusinessCandidate.session_id is
      required, and a provider must not invent or own session identity
      itself.

No `query` free-text field exists here (unlike GoogleMaps' `query` /
Yelp's `term` / Apple's `q`) because Overpass QL has no analogous
"search this text anywhere" primitive — Overpass matches structured
tag filters, not free text, and this provider does not invent a
free-text search Overpass itself does not perform.

What "never fabricate data" means concretely here
-----------------------------------------------------
Every BusinessCandidate field below is populated only when the
Overpass JSON response's own documented element/tag shape actually
contains the corresponding value:

    - provider_business_id: built as `f"{element['type']}/{element['id']}"`
      (e.g. `"node/123456789"`) — OSM's own canonical, globally-used
      element reference format (the same `type/id` pairing
      openstreetmap.org itself uses in every element permalink,
      `https://www.openstreetmap.org/{type}/{id}`, and the same pairing
      Overpass QL's own `id_query`/`item` statements use to refer back
      to a specific element). Not synthesized from name+coordinate; it
      is the response's own `type` and `id` fields, verbatim, joined in
      OSM's own documented format.
    - maps_url: built as `f"https://www.openstreetmap.org/{type}/{id}"`
      from that same `type`/`id` pair. This is a deliberate, reasoned
      departure from AppleMapsProvider's decision to leave `maps_url`
      None rather than "constructing a maps.apple.com search-link
      guess" — flagging the distinction rather than silently picking a
      side: Apple's case had no stable per-place identifier at all
      (PlaceResult carries none), so any URL Apple's provider might
      build would have to guess at how to re-resolve name+coordinate
      into a matching Apple Maps listing — a genuine guess. Here, `type`
      and `id` together are the exact, stable, unambiguous identifier
      of the precise element the response returned, and
      `openstreetmap.org/{type}/{id}` is OSM's own public, documented,
      deterministic resolution of that identifier back to that same
      element — no re-matching, no ambiguity, no guessing involved. The
      same category of "canonical listing link," not "constructed
      search query," that Yelp's `url` and GoogleMapsProvider's
      `maps_link` already are.
    - name: `tags.get("name")`.
    - category: built from the caller's own `request.tags` keys, in
      the order the caller supplied them — for each requested tag key
      present on the response element's own `tags`, formatted as
      `"key=value"`, joined with `", "` if more than one requested key
      matched. This reports back exactly what the caller searched by
      and what the element actually carries, matching YelpProvider's
      "first category title" and AppleMapsProvider's "poiCategory"
      precedent of surfacing one *specific, queried-for* field rather
      than inventing a "primary category" heuristic across OSM's much
      larger, unbounded tag vocabulary. Left None if none of the
      requested keys are present on the returned element's tags (should
      not normally happen, since the query filtered on those keys, but
      handled rather than assumed).
    - address: composed from `addr:housenumber` + `addr:street` when
      both are present (OSM's own two-field street-address
      convention), falling back to `addr:full` alone when that
      combination is absent but `addr:full` is present. Never inferred
      from a sub-field the response didn't supply, matching
      YelpProvider's `display_address`-join and AppleMapsProvider's
      `formattedAddressLines`-join precedent of building the address
      only from fields the source actually returned.
    - city: `tags.get("addr:city")`.
    - country: `tags.get("addr:country")` — used verbatim (OSM's own
      convention is an ISO ALPHA-2 code here, e.g. `"DE"`), matching
      AppleMapsProvider's "use the field as given, no reinterpretation"
      rule for its own `country` field.
    - website: `tags.get("website")`, falling back to
      `tags.get("contact:website")` — both are OSM's own documented
      tag names for the same concept (contact:* is OSM's namespaced
      convention layered over the older bare `website` tag), never a
      constructed or guessed URL.
    - phone: `tags.get("phone")`, falling back to
      `tags.get("contact:phone")` — same reasoning as website.
    - rating / review_count: OSM has no native concept of either (it is
      map data, not a reviews/ratings source) — left None, the same
      permanently-absent treatment AppleMapsProvider already applies to
      these two fields for the same underlying reason (its source isn't
      a ratings API either).
    - coordinates: for a `node` element, the response's own top-level
      `lat`/`lon`. For `way`/`relation` elements, Overpass does not
      return `lat`/`lon` on the element itself — this provider's own
      query always requests `out center;` (see "Pagination" below),
      which makes Overpass compute and attach a `center.lat`/
      `center.lon` for every element regardless of type. Populated as
      a `(lat, lon)` tuple when the applicable field pair is present,
      None otherwise.
    - instagram_url: OSM does define a `contact:instagram` tag in
      practice, but — unlike `website`/`phone`, whose values are always
      plain URLs/numbers — contributors populate `contact:instagram`
      inconsistently (sometimes a full URL, sometimes a bare handle,
      sometimes an `@handle`), and Overpass returns whatever raw string
      was mapped, with no normalization. Turning a bare handle into a
      URL would be this provider constructing something OSM's own data
      didn't actually assert. Left None, matching all three existing
      providers' treatment of this same optional field, rather than
      guessing at a format.

Pagination
-----------
The Overpass interpreter endpoint has no offset/page mechanism the way
the Fusion API's Business Search endpoint does for YelpProvider — a
single query returns its full, single-shot result set (optionally
capped by the query's own `out {limit};` count, per "Request shape"
above). `discover()` therefore issues exactly one HTTP POST per call
and streams the response's `elements[]` one BusinessCandidate at a
time — the same "single-call, still-streaming" shape
AppleMapsProvider already has for the identical reason (one HTTP call,
no second offset-advanced call), and GoogleMapsProvider has for a
different one (one MapsScraper.search() call).

Status
------
OverpassProvider implementation milestone. Fourth concrete
DiscoveryProviderInterface implementation, added alongside
GoogleMapsProvider, YelpProvider, and AppleMapsProvider; does not
replace, wrap, call, or modify any of them. engine/, workers/, queues/,
models/, and every existing provider-platform file (interfaces.py,
contracts.py, registry.py, composite_provider.py,
parallel_composite_provider.py, provider_deduplicator.py,
provider_metadata.py, provider_capabilities.py, provider_configuration.py,
__init__.py) are untouched by this file — see this milestone's
architecture review for the full "zero architectural changes required"
accounting, and for why niche->OSM-tag translation is deliberately not
implemented anywhere in this file.
"""

from __future__ import annotations

import json
import logging
import random
import time
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Callable, Iterator, Mapping, Optional, Sequence
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen
from urllib.parse import urlencode

from engine.contracts import BusinessCandidate
from engine.interfaces import DiscoveryProviderInterface
from providers.provider_capabilities import ProviderCapabilities
from providers.provider_metadata import ProviderMetadata
from utils.perf import NullProfiler

log = logging.getLogger(__name__)

_DEFAULT_ENDPOINT = "https://overpass-api.de/api/interpreter"
_DEFAULT_MIRRORS: tuple[str, ...] = (
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
    "https://overpass.nchc.org.tw/api/interpreter",
)
_RETRYABLE_STATUS_CODES: set[int] = {429, 502, 503, 504}
_VALID_ELEMENT_TYPES = ("node", "way", "relation")
_ELEMENT_QL_KEYWORD = {"node": "node", "way": "way", "relation": "rel"}


# ---------------------------------------------------------------------------
# Request shape (provider-local — mirrors GoogleMapsDiscoveryRequest /
# YelpDiscoveryRequest / AppleMapsDiscoveryRequest)
# ---------------------------------------------------------------------------
@dataclass(frozen=True, slots=True)
class OverpassDiscoveryRequest:
    """
    This provider's own accepted request shape. Not a shared
    engine/contracts.py contract — same reasoning as
    GoogleMapsDiscoveryRequest / YelpDiscoveryRequest /
    AppleMapsDiscoveryRequest (see google_maps_provider.py, Ambiguity
    3). Field names mirror Overpass QL's own documented primitives
    directly so nothing is renamed or reinterpreted in translation —
    see module docstring, "Request shape" and "No niche translation",
    for the full field-by-field rationale.

    `tags` is the sole "what am I searching for" field and is required:
    a request with no tags at all would ask Overpass to enumerate every
    mapped element in the given scope, which is not a business-
    discovery query this provider will silently build.

    `bbox`, `around`, and `area_name` are mutually exclusive geographic
    scopes — see module docstring for why, and `__post_init__` below
    for the validation this class performs on its own data (no
    registry, no network call, and no query-construction logic
    required to check this).
    """

    session_id: str
    tags: Mapping[str, str]
    element_types: Sequence[str] = field(
        default_factory=lambda: _VALID_ELEMENT_TYPES
    )
    bbox: Optional[tuple[float, float, float, float]] = None  # (south, west, north, east)
    around: Optional[tuple[float, float, float]] = None  # (radius_m, lat, lon)
    area_name: Optional[str] = None
    limit: Optional[int] = None
    timeout_seconds: int = 25
    should_stop: Optional[Callable[[], bool]] = None
    """
    PHASE 1B parity fix — same cooperative checkpoint
    GoogleMapsDiscoveryRequest.should_stop already defines (see
    google_maps_provider.py), threaded through here for the identical
    reason: a composite/parallel discovery run that has already reached
    its target (or is otherwise winding down) must not pay for this
    provider's own internal HTTP retry/backoff/mirror-failover loop
    (`_http_post_urllib`) once that loop is not going to matter. `None`
    (the default) preserves exact previous behavior — a caller that
    doesn't pass one (existing tests, validate_overpass_provider.py)
    always gets the full retry/backoff/mirror behavior. See
    `OverpassProvider.discover()` and `_http_post_urllib()` for where
    this is actually consulted.
    """
    city: Optional[str] = None
    area: Optional[str] = None
    scope_source: Optional[str] = None
    scope_valid: bool = True

    def __post_init__(self) -> None:
        if not self.tags:
            raise ValueError(
                "OverpassDiscoveryRequest requires at least one OSM "
                "tag filter in `tags` — an untagged query is not a "
                "business-discovery request this provider will build."
            )
        scopes_set = sum(
            scope is not None for scope in (self.bbox, self.around, self.area_name)
        )
        if scopes_set > 1:
            raise ValueError(
                "OverpassDiscoveryRequest accepts at most one "
                "geographic scope — bbox, around, and area_name are "
                "mutually exclusive Overpass QL spatial filters, not "
                "combinable ones."
            )
        invalid_types = set(self.element_types) - set(_VALID_ELEMENT_TYPES)
        if invalid_types:
            raise ValueError(
                f"OverpassDiscoveryRequest.element_types contains "
                f"unrecognized OSM element type(s) {sorted(invalid_types)!r} "
                f"— valid values are {_VALID_ELEMENT_TYPES!r}."
            )


_DEFAULT_TRANSPORT_HEADERS: dict[str, str] = {
    # overpass-api.de's current front-end filtering rejects requests
    # that omit an explicit Accept header and/or arrive with urllib's
    # own bare default User-Agent ("Python-urllib/3.x") — both read as
    # "programmatic, non-negotiating client" and are answered with
    # HTTP 406 Not Acceptable before the query itself is ever
    # evaluated. Neither header changes the request body, the query,
    # or the endpoint; they only state, honestly, what this client is
    # and what response format it wants:
    #   - Accept: application/json — matches this provider's own
    #     `[out:json]` query header (see _build_ql) and the response
    #     shape discover() already parses via json.loads().
    #   - User-Agent: identifies this codebase's Overpass client by
    #     name, not a spoofed/borrowed browser string — Overpass's own
    #     documentation asks API consumers to send a real,
    #     identifying User-Agent rather than a generic/absent one.
    "Accept": "application/json",
    "User-Agent": "mast-lead-engine-overpass-provider/1.0",
}


class _StopRequested(Exception):
    """
    Internal-only signal: `should_stop()` reported true while
    `_http_post_urllib` was mid retry/backoff/mirror-failover loop.
    Never escapes this function — caught immediately below and turned
    into a `DiscoveryFailure`-free early return path exactly like a
    real (non-retryable) transport failure would look to `discover()`,
    except `discover()` itself checks `should_stop()` first (see
    `OverpassProvider.discover()`) and simply won't call this function
    at all in the common case. This exception only covers the case
    where a stop is requested *while already inside* the retry loop
    (e.g. between a 429 response and the next attempt), which a
    before-the-call check alone cannot catch.
    """


def _http_post_urllib(
    url: str,
    data: str,
    headers: dict[str, str],
    timeout: float = 35.0,
    max_retries_per_endpoint: int = 2,
    backoff_factor: float = 0.5,
    should_stop: Optional[Callable[[], bool]] = None,
    on_attempt: Optional[Callable[[], None]] = None,
) -> dict[str, Any]:
    """
    Default transport: stdlib POST of the Overpass QL query text against the
    interpreter endpoint with automatic retries, exponential backoff with jitter,
    `Retry-After` header handling, and mirror failover.

    Injected as `http_post` by default; callers/tests may supply their own custom
    callable (see module docstring for why).

    If the target endpoint experiences transient HTTP errors (429, 502, 503, 504)
    or network/timeout exceptions, this transport retrying on the primary endpoint
    and failing over to secondary public Overpass mirrors (`_DEFAULT_MIRRORS`).

    `should_stop`: PHASE 1B parity fix — optional cooperative checkpoint,
    consulted (a) before every backoff sleep and (b) before hopping to
    the next mirror. `None` (the default) preserves exact previous
    behavior — every existing caller (validate_overpass_provider.py,
    any caller that built its own `http_post` signature before this
    parameter existed) is unaffected: this function is called
    positionally/by-keyword the same way it always was, and callers
    that pass a custom `http_post` callable of their own to
    `OverpassProvider` are never affected by this parameter at all,
    since `discover()` only forwards `should_stop` to whichever
    callable was actually injected via a `try/except TypeError`
    backward-compatibility call (see `OverpassProvider.discover()`).

    `on_attempt`: PHASE 2B (discovery wall-clock instrumentation)
    addition — optional, called once per actual HTTP attempt made
    (i.e. once per `urlopen()` call, including every retry and every
    mirror hop), with no arguments. This is the ground-truth source
    for `overpass_requests`/`overpass_retries` (see
    `OverpassProvider.discover()`, which counts calls into this
    callback rather than trying to infer attempt count from the
    outside — the outside has no visibility into mirror failover or
    per-endpoint retries otherwise). `None` (the default) preserves
    exact previous behavior for every existing caller — same
    backward-compatibility shape as `should_stop` immediately above.
    """
    request_headers = {**_DEFAULT_TRANSPORT_HEADERS, **headers}
    body = urlencode({"data": data}).encode("utf-8")

    candidate_urls = [url]
    for mirror in _DEFAULT_MIRRORS:
        if mirror not in candidate_urls:
            candidate_urls.append(mirror)

    def _stop_requested() -> bool:
        return should_stop is not None and should_stop()

    last_exception: Optional[BaseException] = None

    try:
        for target_url in candidate_urls:
            if _stop_requested():
                log.info(
                    "[overpass] should_stop reported true before trying %s — "
                    "aborting further mirror failover.",
                    target_url,
                )
                raise _StopRequested()

            for attempt in range(max_retries_per_endpoint):
                if on_attempt is not None:
                    try:
                        on_attempt()
                    except Exception:
                        pass
                request = Request(target_url, data=body, headers=request_headers, method="POST")
                try:
                    with urlopen(request, timeout=timeout) as response:
                        return json.loads(response.read().decode("utf-8"))
                except HTTPError as exc:
                    last_exception = exc
                    if exc.code in _RETRYABLE_STATUS_CODES:
                        if _stop_requested():
                            log.info(
                                "[overpass] should_stop reported true after HTTP %d "
                                "from %s — aborting retry instead of sleeping.",
                                exc.code, target_url,
                            )
                            raise _StopRequested() from None
                        retry_after = exc.headers.get("Retry-After") if exc.headers else None
                        delay: Optional[float] = None
                        if retry_after:
                            try:
                                delay = float(retry_after)
                            except ValueError:
                                pass
                        if delay is None:
                            delay = (backoff_factor * (2 ** attempt)) + random.uniform(0, 0.25)
                        log.warning(
                            "[overpass] HTTP %d from %s (attempt %d/%d). Retrying in %.2fs...",
                            exc.code,
                            target_url,
                            attempt + 1,
                            max_retries_per_endpoint,
                            delay,
                        )
                        time.sleep(delay)
                    else:
                        raise
                except (URLError, TimeoutError, OSError) as exc:
                    last_exception = exc
                    if _stop_requested():
                        log.info(
                            "[overpass] should_stop reported true after a network "
                            "error connecting to %s — aborting retry instead of "
                            "sleeping.",
                            target_url,
                        )
                        raise _StopRequested() from None
                    delay = (backoff_factor * (2 ** attempt)) + random.uniform(0, 0.25)
                    log.warning(
                        "[overpass] Network error (%s) connecting to %s (attempt %d/%d). Retrying in %.2fs...",
                        exc,
                        target_url,
                        attempt + 1,
                        max_retries_per_endpoint,
                        delay,
                    )
                    time.sleep(delay)

            log.warning(
                "[overpass] Exhausted retries for %s. Attempting fallback mirror...",
                target_url,
            )
    except _StopRequested:
        # Same "no results, no exception" shape `discover()` already
        # tolerates from an empty-but-successful response — see
        # `discover()`, which returns early via its own should_stop()
        # check and never calls this function in the common case. This
        # branch only fires for a stop requested *mid*-retry, and — like
        # the pre-call check in discover() — simply yields zero
        # candidates rather than raising, so a cooperative shutdown is
        # never surfaced to callers as a transport failure.
        return {"elements": []}

    if last_exception is not None:
        raise last_exception
    raise RuntimeError("Overpass query failed with no response or exception recorded.")


def _or_none(value: Optional[str]) -> Optional[str]:
    """Same "" / None normalization helper as the other three providers."""
    return value if value else None


def _build_ql(request: OverpassDiscoveryRequest) -> str:
    """
    Builds the Overpass QL query text for `request`, wiring the
    caller's own OSM-native field values into real Overpass QL syntax
    — see module docstring, "Request shape", for why this is wiring,
    not translation: no field value here is renamed, reinterpreted, or
    mapped from one vocabulary to another.
    """
    tag_filters = "".join(f'["{k}"="{v}"]' for k, v in request.tags.items())

    if request.bbox is not None:
        south, west, north, east = request.bbox
        scope = f"({south},{west},{north},{east})"
        area_stmt = ""
    elif request.around is not None:
        radius_m, lat, lon = request.around
        scope = f"(around:{radius_m},{lat},{lon})"
        area_stmt = ""
    elif request.area_name is not None:
        scope = "(area.searchArea)"
        area_stmt = f'area["name"="{request.area_name}"]->.searchArea;\n'
    else:
        scope = ""
        area_stmt = ""

    statements = "\n  ".join(
        f"{_ELEMENT_QL_KEYWORD[element_type]}{tag_filters}{scope};"
        for element_type in request.element_types
    )

    out_clause = "out center;" if request.limit is None else f"out center {request.limit};"

    return (
        f"[out:json][timeout:{request.timeout_seconds}];\n"
        f"{area_stmt}"
        f"(\n  {statements}\n);\n"
        f"{out_clause}"
    )


class OverpassProvider(DiscoveryProviderInterface):
    """
    Adapts the Overpass API's interpreter endpoint to
    DiscoveryProviderInterface. Independent of GoogleMapsProvider,
    YelpProvider, and AppleMapsProvider: no shared code, no shared
    state, no dependency on any of the other three.

    Stateless: every discover() call issues its own HTTP request
    against the injected (or default) transport; nothing is cached or
    shared across calls or instances.

    PHASE 2B (discovery wall-clock instrumentation): `profiler`, if
    supplied, receives two counters per `discover()` call —
    `overpass_requests` (total HTTP attempts actually made, across
    every retry and mirror hop) and `overpass_retries` (attempts
    beyond the first, i.e. `overpass_requests - 1`, floored at 0) —
    via the default transport's new `on_attempt` hook (see
    `_http_post_urllib`'s own docstring). A caller-injected `http_post`
    that doesn't accept `on_attempt` is unaffected, same
    backward-compatibility shape `discover()` already uses for
    `should_stop`/`timeout` below.
    """

    def __init__(
        self,
        endpoint_url: str = _DEFAULT_ENDPOINT,
        http_post: Optional[Callable[[str, str, dict[str, str]], dict[str, Any]]] = None,
        *,
        profiler: Any = None,
    ) -> None:
        """
        `endpoint_url` defaults to the public overpass-api.de mirror —
        see module docstring, "No credential required", for why this
        is a plain constructor argument (choice of interchangeable
        public instance) rather than a credential.

        `http_post` defaults to `_http_post_urllib` (a real network
        call). Injecting a different callable — e.g. a fake for tests,
        or a caller's own rate-limited HTTP client — never requires
        touching `discover()` or any engine code.

        `profiler` — see class docstring's PHASE 2B paragraph. `None`
        (the default) preserves exact previous behavior: no counters
        recorded, no behavior change (`NullProfiler.incr()` is a no-op).
        """
        self._endpoint_url = endpoint_url
        self._http_post = http_post or _http_post_urllib
        self._profiler = profiler if profiler is not None else NullProfiler()

    @property
    def provider_id(self) -> str:
        return "overpass"

    @property
    def display_name(self) -> str:
        return "Overpass (OpenStreetMap)"

    @classmethod
    def metadata(cls) -> ProviderMetadata:
        """
        This provider's own static characteristics — see
        provider_metadata.py for the full field-by-field rationale.
        A classmethod, not an instance property, matching the other
        three providers — a caller must be able to learn what this
        provider is without constructing an instance first.
        """
        return ProviderMetadata(
            provider_id="overpass",
            display_name="Overpass (OpenStreetMap)",
            description=(
                "Streams BusinessCandidate objects from the Overpass "
                "API — a query interface over OpenStreetMap's own "
                "tagged element data (nodes/ways/relations)."
            ),
            provider_type="geodata_query_api",
            requires_api_key=False,
            default_enabled=True,
            homepage="https://wiki.openstreetmap.org/wiki/Overpass_API",
            version="1.0.0",
        )

    CAPABILITIES: ProviderCapabilities = ProviderCapabilities(
        supports_keyword_search=False,
        supports_category_search=True,
        supports_city_filter=False,
        supports_country_filter=False,
        supports_radius_search=True,
        supports_coordinate_search=True,
        supported_entity_types=("local_business",),
        requires_geo_center=True,
        supports_pagination=False,
        supports_streaming=True,
    )

    @classmethod
    def capabilities(cls) -> ProviderCapabilities:
        """Return what a caller can ask this provider's discover() to search by."""
        return cls.CAPABILITIES

    def discover(self, request: OverpassDiscoveryRequest) -> Iterator[BusinessCandidate]:
        """
        Streams BusinessCandidate objects for `request` — a single
        HTTP POST against the Overpass interpreter endpoint (see
        module docstring, "Pagination"), yielding one BusinessCandidate
        per entry in the response's `elements[]`. Any exception raised
        by the HTTP transport propagates unchanged — nothing here
        catches or swallows it.

        PHASE 1B parity fix — checks `request.should_stop()` before
        issuing the request at all (same "provider's one HTTP call is
        otherwise a single un-interruptible item" concern
        ParallelCompositeDiscoveryProvider's own docstring documents
        as an "honest limit"). If a stop has already been requested by
        the time this runs, nothing is sent and the iterator yields
        zero candidates, exactly like a genuinely empty Overpass
        response would. `request.should_stop` is also threaded into
        the default transport's own retry/backoff/mirror loop (see
        `_http_post_urllib`) so a stop requested *during* that loop
        aborts it too, rather than only being checked here at the
        very start.
        """
        if request.should_stop is not None and request.should_stop():
            log.info(
                "[overpass_provider] should_stop reported true before the "
                "request was issued — skipping this Overpass call entirely "
                "(session=%s)", request.session_id,
            )
            return

        scope_source = request.scope_source or ("area" if request.area else "city_fallback")
        scope_event = {
            "city": request.city,
            "area": request.area,
            "area_name": request.area_name,
            "scope_source": scope_source,
            "scope_valid": request.scope_valid,
        }
        log.info("[overpass-scope] %s", json.dumps(scope_event))

        query = _build_ql(request)
        headers = {"Content-Type": "application/x-www-form-urlencoded"}
        socket_timeout = float(request.timeout_seconds + 10)

        # PHASE 2B (discovery wall-clock instrumentation): counts every
        # actual HTTP attempt the default transport makes for THIS
        # discover() call (see `_http_post_urllib`'s `on_attempt` param).
        # A caller-injected `http_post` without `on_attempt` support
        # simply never calls this closure — `_attempts_made` stays 0,
        # and the `_attempts_made or 1` fallback below still records one
        # honest request (the call this method itself just made) rather
        # than silently reporting 0 requests for a call that plainly
        # happened.
        _attempts_made = 0

        def _count_attempt() -> None:
            nonlocal _attempts_made
            _attempts_made += 1

        try:
            payload = self._http_post(
                self._endpoint_url, query, headers,
                timeout=socket_timeout, should_stop=request.should_stop,
                on_attempt=_count_attempt,
            )
        except TypeError:
            # Backward compatibility: an injected `http_post` that predates
            # `should_stop` / `timeout` / `on_attempt` (e.g.
            # validate_overpass_provider.py's fakes, or a caller's own
            # custom transport) doesn't accept one or more of these
            # keywords — peel them off one at a time rather than assuming
            # which one was rejected.
            try:
                payload = self._http_post(
                    self._endpoint_url, query, headers,
                    timeout=socket_timeout, should_stop=request.should_stop,
                )
            except TypeError:
                try:
                    payload = self._http_post(self._endpoint_url, query, headers, timeout=socket_timeout)
                except TypeError:
                    payload = self._http_post(self._endpoint_url, query, headers)

        _requests = _attempts_made or 1
        self._profiler.incr("overpass_requests", by=_requests)
        self._profiler.incr("overpass_retries", by=max(0, _requests - 1))

        elements = payload.get("elements", [])
        for element in elements:
            yield self._to_business_candidate(element, request, request.session_id)

    def _to_business_candidate(
        self,
        element: dict[str, Any],
        request: OverpassDiscoveryRequest,
        session_id: str,
    ) -> BusinessCandidate:
        """
        Field-for-field mapping, Overpass element -> BusinessCandidate.
        See module docstring, "What 'never fabricate data' means
        concretely here", for the full field-by-field rationale — every
        omission below is a field the Overpass response genuinely does
        not (reliably) expose, not an oversight.
        """
        tags = element.get("tags") or {}
        element_type = element.get("type")
        element_id = element.get("id")

        provider_business_id = (
            f"{element_type}/{element_id}"
            if element_type is not None and element_id is not None
            else None
        )
        maps_url = (
            f"https://www.openstreetmap.org/{element_type}/{element_id}"
            if element_type is not None and element_id is not None
            else None
        )

        matched = [
            f"{key}={tags[key]}" for key in request.tags if key in tags
        ]
        category = ", ".join(matched) if matched else None

        housenumber = tags.get("addr:housenumber")
        street = tags.get("addr:street")
        if housenumber and street:
            address = f"{housenumber} {street}"
        else:
            address = _or_none(tags.get("addr:full"))

        lat, lon = element.get("lat"), element.get("lon")
        if lat is None or lon is None:
            center = element.get("center") or {}
            lat, lon = center.get("lat"), center.get("lon")
        coordinates = (lat, lon) if lat is not None and lon is not None else None

        website = tags.get("website") or tags.get("contact:website")
        phone = tags.get("phone") or tags.get("contact:phone")

        return BusinessCandidate(
            pipeline_id=str(uuid.uuid4()),
            session_id=session_id,
            provider=self.provider_id,
            provider_business_id=provider_business_id,
            maps_url=maps_url,
            name=_or_none(tags.get("name")),
            category=category,
            address=address,
            city=_or_none(tags.get("addr:city")),
            country=_or_none(tags.get("addr:country")),
            website=_or_none(website),
            phone=_or_none(phone),
            rating=None,  # OSM has no ratings concept — never fabricated.
            review_count=None,  # OSM has no reviews concept — never fabricated.
            coordinates=coordinates,
            discovered_at=datetime.now(timezone.utc).isoformat(),
            instagram_url=None,  # contact:instagram format is unnormalized — never guessed.
        )
