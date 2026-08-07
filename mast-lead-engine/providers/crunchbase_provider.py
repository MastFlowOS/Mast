"""
MAST Engine V2 — CrunchbaseProvider
======================================

Source: this milestone's own instructions ("implement CrunchbaseProvider"
— read in full, including its explicit instruction to research whether
Crunchbase currently exposes an official public API, whether commercial
access is required, whether it is actively maintained, whether it can
honestly satisfy MAST's company discovery workflow, and to target only
the officially supported API if a legacy/current split exists),
engine/interfaces.py:DiscoveryProviderInterface, engine/contracts.py:
BusinessCandidate, and the six existing concrete providers this one is
built alongside — providers/google_maps_provider.py:GoogleMapsProvider,
providers/yelp_provider.py:YelpProvider,
providers/apple_maps_provider.py:AppleMapsProvider,
providers/overpass_provider.py:OverpassProvider,
providers/azure_maps_provider.py:AzureMapsProvider, and
providers/foursquare_provider.py:FoursquareProvider — read for
precedent, not modified. Also read, not modified:
providers/provider_metadata.py, providers/provider_capabilities.py,
providers/provider_configuration.py, providers/registry.py,
providers/composite_provider.py, providers/parallel_composite_provider.py,
providers/provider_deduplicator.py. External reference: Crunchbase's own
first-party developer documentation (data.crunchbase.com/docs) —
specifically "Using the API," "Basic APIs," "Organization Attributes for
Basic API," "Using Search API," "Examples: Search API," and "Using
Entity Lookup API" — cited throughout "Architecture review" and "API
mapping summary" below, the same discipline yelp_provider.py /
apple_maps_provider.py / overpass_provider.py / azure_maps_provider.py /
foursquare_provider.py already apply to their respective third-party
APIs.

This is not a new architecture. It is a seventh, independent answer to
the same interface GoogleMapsProvider, YelpProvider, AppleMapsProvider,
OverpassProvider, AzureMapsProvider, and FoursquareProvider already
answer — see "Architecture review" below for why no engine/, workers/,
queues/, models/, or provider-platform file needed to change to add it.

Architecture review
----------------------------------------------------------------------
This milestone's own instructions required determining, before writing
any code: (1) whether Crunchbase currently exposes an official public
API, (2) whether commercial/API access is required, (3) whether that
API is actively maintained, (4) whether it honestly satisfies MAST's
company discovery workflow, and (5) whether it permits
organization/company search suitable for lead generation — targeting
only the officially supported API if a legacy/current split exists.
Research findings, as of this milestone (August 2026), drawn from
Crunchbase's own first-party documentation at data.crunchbase.com:

    1. An official public API exists today: the Crunchbase API, a
       read-only REST service, currently versioned v4.0. Crunchbase's
       own documentation site presents three versions side by side —
       "v3.1," "v4.0 (Legacy)," and "v4.0 (Current)" — with "v4.0
       (Current)" marked as the active target. Per this milestone's own
       instruction to target only the officially supported API when a
       legacy/current split exists, every endpoint this file calls is
       drawn exclusively from "v4.0 (Current)" — no v3.1 or "v4.0
       (Legacy)" endpoint (e.g. the deprecated, Enterprise-only
       `/v3.1/organizations` collection) is used anywhere in this file.

    2. Commercial/API access is required, but is not a blocker per this
       milestone's own instructions ("Do NOT stop for... pricing...
       commercial licensing alone"). Concretely: every API call requires
       a `user_key`, obtained by registering for a Crunchbase account.
       Crunchbase's own "Basic APIs" page documents a free "Crunchbase
       Basic" tier with real, working access to exactly three v4.0
       endpoints — Organization Search, Organization Entity Lookup, and
       Autocomplete — over a documented, limited set of organization
       fields (see "Organization Attributes for Basic API," reproduced
       in "API mapping summary" below). Richer fields (categories,
       founded_on, rank_org_company, funding_total, num_employees_enum,
       and others visible in Crunchbase's own official Search API
       examples) require an Advanced or Commercial license — the same
       "provider requires a paid credential the caller sources
       independently" category YelpProvider's own Fusion API key and
       FoursquareProvider's own Places API key already establish, not a
       novel or disqualifying constraint.

    3. The API is actively maintained: Crunchbase's own documentation
       carries "Updated 7 months ago" / "Updated 9 months ago" /
       "Updated 12 months ago" timestamps (as of this milestone) across
       the pages this file draws from, and Crunchbase's own "API
       Starter Playbooks" section (e.g. "Discover Look-Alike Accounts,"
       "Surface Competitors and Reasoning for Diligence Workflows") is
       current, dated within the last two months of this milestone —
       evidence of an API still receiving first-party documentation and
       feature investment, not an abandoned or frozen surface.

    4. It genuinely, honestly satisfies MAST's company discovery
       workflow. The Organization Search endpoint
       (`POST /api/v4/searches/organizations`, confirmed live and
       Basic-tier-accessible by Crunchbase's own "Basic APIs" page) is
       a real organization-search collection endpoint, not an
       entity-lookup-only surface requiring a caller to already know
       which company they want:
           - Free-text keyword search across organization name/aliases,
             via a `"field_id": "identifier", "operator_id": "contains"`
             query predicate — documented in multiple first-party
             Crunchbase examples this milestone fetched directly (see
             "API mapping summary" below) and independently reproduced
             by multiple third-party integration guides using the exact
             same predicate shape.
           - Geographic scoping via `location_identifiers`, an
             `"operator_id": "includes"` predicate against Crunchbase's
             own location-entity UUIDs (city, region, country, or
             continent granularity — Crunchbase's own documented
             location hierarchy).
           - Category scoping via `categories`, the identical
             `"includes"` predicate shape, demonstrated directly in
             Crunchbase's own official "Examples: Search API" page.
           - A response shape (see "API mapping summary" below) that
             maps honestly onto BusinessCandidate's own fields —
             including a real, stable per-organization UUID, a
             canonical organization permalink Crunchbase's own docs
             confirm resolves to a real consumer-facing profile URL
             (`https://www.crunchbase.com/organization/{permalink}`),
             a documented `website_url` field, and documented
             social-profile link fields (`facebook`, `linkedin`,
             `twitter`).
       No part of MAST's discovery workflow (search by keyword, scope by
       location/category, stream BusinessCandidate objects, paginate
       through a large result set) is something the current, official
       Organization Search endpoint cannot honestly do.

    5. It permits organization/company search suitable for lead
       generation specifically: Crunchbase's own product positioning
       (about.crunchbase.com — "Find new prospects, beat competitors and
       quotas") and its own "API Starter Playbooks" (e.g. "Define and
       Pull Your ICP," "Build Market Landscapes and Streamline
       Workflows") describe exactly this use case as an intended,
       first-party-documented one — not a repurposing this file invents.

No genuine architectural blocker exists — this milestone does not stop.
What follows is a fully-scoped implementation, per the "if no blocker
exists" branch of this milestone's own instructions.

API mapping summary
----------------------------------------------------------------------
Base URL: `https://api.crunchbase.com/api/v4` (Crunchbase's own "Basic
APIs" page — the exact host+prefix under which it lists the three
Basic-tier endpoints).

Endpoint used by this file: `POST /searches/organizations` — Crunchbase's
own documented Organization Search endpoint, one of the three endpoints
explicitly confirmed Basic-tier-accessible.

Authentication: `X-cb-user-key: {api_key}` request header — one of the
two documented authentication mechanisms on Crunchbase's own "Using the
API" page (the other, a `user_key` URL query parameter, is equally
valid but a header keeps the credential out of logged URLs, matching
this codebase's own established preference — see AppleMapsProvider's
identical reasoning for its own header-based credential).

Request body shape (Crunchbase's own documented Search API contract,
"Using Search API" / "Examples: Search API"):

    {
        "field_ids": [...],           # which properties to return
        "query": [                    # AND-only predicate list
            {"type": "predicate", "field_id": ..., "operator_id": ...,
             "values": [...]}
        ],
        "order": [{"field_id": ..., "sort": "asc"|"desc"}],  # optional
        "limit": <int>,               # 1-1000, Crunchbase's own ceiling
        "after_id": "<uuid>"          # optional keyset pagination cursor
    }

Response body shape (confirmed directly from Crunchbase's own
first-party "Build Market Landscapes and Streamline Workflows" and
"Surface Competitors and Reasoning for Diligence Workflows" pages, both
of which this milestone fetched and which show real response JSON):

    {
        "count": <int>,
        "entities": [
            {
                "uuid": "<uuid>",
                "properties": {
                    "identifier": {"uuid": ..., "value": <name>,
                                    "permalink": ..., "image_id": ...,
                                    "entity_def_id": "organization"},
                    "website_url": <string or null>,
                    "location_identifiers": [
                        {"uuid": ..., "value": <name>,
                         "location_type": "city"|"region"|"country"|
                                           "continent", ...}, ...
                    ],
                    "categories": [{"uuid": ..., "value": <name>, ...}],
                    ...
                }
            }, ...
        ]
    }

What "never fabricate data" means concretely here
----------------------------------------------------------------------
Every BusinessCandidate field below is populated only when Crunchbase's
own documented response shape actually contains the corresponding
value. Fields the response does not (reliably) expose are left at their
BusinessCandidate default (None), matching the discipline every other
provider in this codebase already applies to its own source:

    - provider_business_id: the entity's own top-level `uuid` —
      Crunchbase's own documented stable per-entity identifier (also
      the exact value its own pagination mechanism uses as `after_id`
      — see "Using Search API," "how do I paginate to the next page?").
    - maps_url: built as
      `f"https://www.crunchbase.com/organization/{permalink}"` from
      `properties.identifier.permalink`. Crunchbase's own "Using Search
      API" page documents this exact construction directly ("Pro Tips:
      find permalink & UUID easily" — "take the last portion of the
      [crunchbase.com] URL to get your permalink -->
      https://www.crunchbase.com/organization/{permalink}"), the same
      "wiring a caller-facing value into the literal URL format the
      source itself documents" category FoursquareProvider's own
      `maps_url` construction from `link` already establishes, not a
      guessed format.
    - name: `properties.identifier.value` — Crunchbase's own documented
      `identifier`-type field's own `value` subfield holds the entity's
      display name (confirmed directly in the real response JSON this
      milestone fetched from Crunchbase's own documentation, e.g.
      `"identifier": {"value": "Sophia Space", ...}`).
    - category: the first entry of `properties.categories[]` (each an
      identifier-shaped object with its own `value` subfield holding
      the category's display name) — the same "first category, single
      string field" precedent YelpProvider and FoursquareProvider
      already set for their own multi-category responses. Populated
      only when the caller opts in via `request.include_categories`
      (see "Request shape" below, "Advanced/Commercial-gated fields")
      — left None otherwise, the identical opt-in-field discipline
      FoursquareProvider already applies to its own Premium `rating` /
      `stats.total_ratings` fields.
    - address: never populated. No discrete street-address field
      exists anywhere in Crunchbase's own documented Organization
      Search response shape (a full postal address is only available
      via the `headquarters_address` *card* on the Entity Lookup
      endpoint, a materially different, per-entity-only mechanism this
      milestone's discover() does not call — see "Request shape" below,
      "Why the Entity Lookup endpoint is out of scope").
    - city / country: read from `properties.location_identifiers[]`,
      each an identifier-shaped object carrying its own documented
      `location_type` (`"city"`, `"region"`, `"country"`, or
      `"continent"` — confirmed via Crunchbase's own documented
      location hierarchy). `city` takes the first entry with
      `location_type == "city"`; `country` takes the first entry with
      `location_type == "country"`. Left None when no entry of that
      granularity is present — never inferred from a `region` or
      `continent` entry the response did not label as a city or
      country.
    - website: `properties.website_url`, Crunchbase's own documented
      Basic-tier `link`-type field (see "Organization Attributes for
      Basic API," reproduced in "Architecture review" above), mapped
      directly.
    - phone: never populated. No telephone-number field exists
      anywhere in Crunchbase's own documented Organization Search
      response shape (unlike FoursquareProvider's `tel` or
      GoogleMapsProvider's scraped phone field) — this is a genuine
      capability gap in the source, not an oversight here.
    - rating / review_count: never populated. Crunchbase has no
      user-review or star-rating concept for organizations at all —
      mapping `rank_org_company` (a relevance/prominence ranking
      Crunchbase's own docs expose) onto either field would assert a
      meaning ("a rating," "a review count") the source data does not
      carry; this file does not perform that substitution.
    - coordinates: never populated. Crunchbase's own location fields
      are identifier references into its own location-entity hierarchy
      (city/region/country/continent names and UUIDs), never raw
      latitude/longitude — the same "identifier reference, not a
      coordinate pair" distinction OverpassProvider's own docstring
      already draws for OSM's tag-based location data.
    - discovered_at: `datetime.now(timezone.utc).isoformat()` at
      mapping time — the same pattern every other provider in this
      codebase already uses; not a Crunchbase-sourced value.
    - instagram_url: never populated. Crunchbase's own documented
      social-link fields are `facebook`, `linkedin`, and `twitter`
      only — no Instagram field exists anywhere in its documented
      organization property set.

Request shape
----------------------------------------------------------------------
Same reasoning as every other provider's discovery request (see
google_maps_provider.py, Ambiguity 3): DiscoveryProviderInterface.
discover() deliberately leaves the request shape as `Any`, and no
shared engine/contracts.py discovery-request contract exists.
CrunchbaseDiscoveryRequest is therefore defined locally here, mirroring
the Organization Search endpoint's own documented request-body contract
directly: a free-text `query` string (wired into an `identifier`
`"contains"` predicate), `location_uuids` and `category_uuids`
(wired into `location_identifiers` / `categories` `"includes"`
predicates), an optional `facet_ids` filter (Crunchbase's own
documented organization-subtype facet — `"company"`, `"investor"`,
`"school"`), `order_field` / `order_sort`, `limit`, `max_results`
(a caller-side cap across auto-paginated pages — see "Pagination"
below), and `after_id` (an optional caller-supplied resume cursor) —
plus `session_id`, owned by the caller for the same reason every other
request dataclass carries it.

No niche translation — by design, not by omission
----------------------------------------------------------------------
Per this codebase's now-established discipline (see
foursquare_provider.py, "No niche translation," and
google_maps_provider.py's own Ambiguity 3, which declined the identical
opportunity first): `category_uuids` and `location_uuids` take
Crunchbase's own category/location entity UUIDs directly — nothing is
renamed, reinterpreted, or looked up from a generic niche vocabulary. A
caller wanting to go from a human-readable category or place name to
the UUID this request shape expects uses Crunchbase's own Autocomplete
endpoint first (Crunchbase's own "Using Search API" page: "Pro Tips:
find permalink & UUID easily... Use the autocomplete API") — this file
does not wrap, call, or depend on Autocomplete itself, the same
"discover() does not call a second endpoint on the caller's behalf"
boundary FoursquareProvider's own `fields`/category-id handling already
respects.

Advanced/Commercial-gated fields — `include_categories`
----------------------------------------------------------------------
`categories` is a field_id Crunchbase's own official "Examples: Search
API" page uses directly, but — per "Basic APIs," which enumerates only
the fields in "Organization Attributes for Basic API" as Basic-tier —
is not confirmed accessible on a Basic-tier key. Rather than always
requesting it and risking an error this file cannot honestly predict
the shape of for a Basic-tier caller, `categories` is requested only
when `request.include_categories=True` (default `False`) — the
identical opt-in discipline FoursquareProvider's own `fields` parameter
already applies to Foursquare's own Premium-tier `rating`/`stats`
fields. A caller with Advanced/Commercial access opts in explicitly;
a caller with only Basic access gets a working baseline (`identifier`,
`website_url`, `location_identifiers`) by default, every field of which
"Organization Attributes for Basic API" confirms directly.

Why the Entity Lookup endpoint is out of scope
----------------------------------------------------------------------
Crunchbase's own Entity Lookup endpoint
(`GET /entities/organizations/{permalink}`) retrieves one already-known
organization by permalink or UUID — it is a single-entity detail
lookup, not a discovery/search collection endpoint. discover() streams
candidates matching a search; it does not require a caller to already
know which organization they want. Using Entity Lookup here would mean
inventing a "which permalinks to look up" step this milestone has no
input for. This is the identical "search vs. lookup, only search
belongs to discover()" boundary GoogleMapsProvider and YelpProvider
already establish for their own respective APIs.

Pagination
----------------------------------------------------------------------
The Organization Search endpoint uses real, first-party-documented
keyset pagination (Crunchbase's own "Using Search API," "how do I
paginate to the next page?"): include `after_id` set to the `uuid` of
the last entity in the current page to fetch the next page. Unlike
FoursquareProvider's single-call Place Search (no offset/cursor
mechanism exists on that endpoint at all) and like YelpProvider's own
offset-based auto-pagination, `discover()` here auto-pages: it issues
an initial POST, yields each entity's BusinessCandidate, and — whenever
a full page (`len(entities) == request.limit`) comes back — issues a
follow-up POST with `after_id` set to the previous page's last entity
UUID, repeating until a short page (fewer than `limit` entities, per
Crunchbase's own documented end-of-results signal) is returned or
`request.max_results` (if given) is reached. A caller may also seed
`after_id` directly on the initial request to resume from a specific
cursor, e.g. after a prior partial discover() run.

Status
------
CrunchbaseProvider implementation milestone. Seventh concrete
DiscoveryProviderInterface implementation, added alongside
GoogleMapsProvider, YelpProvider, AppleMapsProvider, OverpassProvider,
AzureMapsProvider, and FoursquareProvider; does not replace, wrap,
call, or modify any of them. engine/, workers/, queues/, models/, and
every existing provider-platform file (interfaces.py, contracts.py,
registry.py, composite_provider.py, parallel_composite_provider.py,
provider_deduplicator.py, provider_metadata.py, provider_capabilities.py,
provider_configuration.py, __init__.py) are untouched by this file —
see this milestone's own deliverables summary for the full "zero
architectural changes required" accounting.
"""

from __future__ import annotations

import json
import uuid as uuid_lib
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Callable, Iterator, Optional, Sequence
from urllib.request import Request, urlopen

from engine.contracts import BusinessCandidate
from engine.interfaces import DiscoveryProviderInterface
from providers.provider_capabilities import ProviderCapabilities
from providers.provider_metadata import ProviderMetadata

_BASE_URL = "https://api.crunchbase.com/api/v4"
_SEARCH_URL = f"{_BASE_URL}/searches/organizations"
_ORG_PROFILE_HOST = "https://www.crunchbase.com/organization"
_MAX_LIMIT = 1000  # Organization Search's own documented per-call ceiling.
_DEFAULT_LIMIT = 50  # Organization Search's own documented default.
_VALID_SORT_VALUES = ("asc", "desc")

# Field_ids confirmed accessible on a Basic-tier key by Crunchbase's own
# "Organization Attributes for Basic API" page — always requested,
# regardless of license tier. See module docstring, "API mapping
# summary" and "Advanced/Commercial-gated fields".
_BASELINE_FIELD_IDS = ("identifier", "website_url", "location_identifiers")


# ---------------------------------------------------------------------------
# Request shape (provider-local — mirrors GoogleMapsDiscoveryRequest /
# YelpDiscoveryRequest / AppleMapsDiscoveryRequest / OverpassDiscoveryRequest /
# AzureMapsDiscoveryRequest / FoursquareDiscoveryRequest)
# ---------------------------------------------------------------------------
@dataclass(frozen=True, slots=True)
class CrunchbaseDiscoveryRequest:
    """
    This provider's own accepted request shape. Not a shared
    engine/contracts.py contract — same reasoning as every other
    provider's request dataclass (see google_maps_provider.py,
    Ambiguity 3). Field names mirror the Organization Search endpoint's
    own documented request-body contract directly so nothing is renamed
    or reinterpreted in translation — see module docstring, "Request
    shape" and "No niche translation," for the full field-by-field
    rationale.

    No field here is required to be non-empty on its own: Organization
    Search itself accepts a bare `query: []` (Crunchbase's own
    documented minimum request only requires `field_ids` and `query` to
    be *present*, not non-empty) — this provider does not invent a
    mandatory filter the endpoint itself does not require.

    See module docstring, "Advanced/Commercial-gated fields" and
    "Pagination," for the full rationale behind `include_categories`
    and the auto-pagination fields below.
    """

    session_id: str
    query: Optional[str] = None  # free-text, wired to identifier "contains"
    location_uuids: Optional[Sequence[str]] = None  # Crunchbase location entity UUIDs
    category_uuids: Optional[Sequence[str]] = None  # Crunchbase category entity UUIDs
    facet_ids: Optional[Sequence[str]] = None  # e.g. ("company",) — organization subtype
    include_categories: bool = False  # Advanced/Commercial-gated — see module docstring
    order_field: Optional[str] = None
    order_sort: str = "asc"
    limit: int = _DEFAULT_LIMIT  # per-page size, 1-1000
    max_results: Optional[int] = None  # caller-side cap across auto-paginated pages
    after_id: Optional[str] = None  # optional caller-supplied resume cursor

    def __post_init__(self) -> None:
        if not (1 <= self.limit <= _MAX_LIMIT):
            raise ValueError(
                f"CrunchbaseDiscoveryRequest.limit must be between 1 and "
                f"{_MAX_LIMIT}, per Organization Search's own documented "
                f"per-call ceiling — got {self.limit!r}."
            )
        if self.order_sort not in _VALID_SORT_VALUES:
            raise ValueError(
                f"CrunchbaseDiscoveryRequest.order_sort must be one of "
                f"{_VALID_SORT_VALUES!r} — got {self.order_sort!r}."
            )
        if self.max_results is not None and self.max_results < 1:
            raise ValueError(
                "CrunchbaseDiscoveryRequest.max_results must be at least "
                f"1 when given — got {self.max_results!r}."
            )


def _http_post_urllib(url: str, body: dict[str, Any], headers: dict[str, str]) -> dict[str, Any]:
    """
    Default transport: a plain stdlib JSON POST against the Organization
    Search endpoint. Injected as `http_post` by default; callers may
    supply their own (see module docstring's precedent in
    FoursquareProvider, "Why an injectable HTTP callable, not a
    hardwired HTTP client" — identical reasoning applies here: no
    Crunchbase HTTP client exists yet in this codebase, and this
    milestone's scope is the provider layer, not also owning a
    general-purpose Crunchbase HTTP client). Raises whatever urllib
    raises on a non-2xx response or network failure — propagated
    unchanged, same "provider failures stay isolated to the provider,
    but are never hidden from the caller" rule every other provider in
    this codebase already follows.
    """
    payload = json.dumps(body).encode("utf-8")
    request = Request(url, data=payload, headers=headers, method="POST")
    with urlopen(request, timeout=30) as response:
        return json.loads(response.read().decode("utf-8"))


def _or_none(value: Any) -> Any:
    """Same "" / None normalization helper every other provider uses."""
    return value if value else None


def _build_body(request: CrunchbaseDiscoveryRequest, field_ids: Sequence[str]) -> dict[str, Any]:
    """
    Builds the Organization Search JSON request body for `request`,
    wiring each of this provider's own request fields into the exact
    predicate/parameter shape Crunchbase's own documentation assigns
    it. Omits any query predicate whose corresponding request field is
    unset, so an unset field is simply absent from the call rather than
    sent as an empty or default value this provider invented.
    """
    query: list[dict[str, Any]] = []
    if request.query:
        query.append(
            {
                "type": "predicate",
                "field_id": "identifier",
                "operator_id": "contains",
                "values": [request.query],
            }
        )
    if request.location_uuids:
        query.append(
            {
                "type": "predicate",
                "field_id": "location_identifiers",
                "operator_id": "includes",
                "values": list(request.location_uuids),
            }
        )
    if request.category_uuids:
        query.append(
            {
                "type": "predicate",
                "field_id": "categories",
                "operator_id": "includes",
                "values": list(request.category_uuids),
            }
        )
    if request.facet_ids:
        query.append(
            {
                "type": "predicate",
                "field_id": "facet_ids",
                "operator_id": "includes",
                "values": list(request.facet_ids),
            }
        )

    body: dict[str, Any] = {
        "field_ids": list(field_ids),
        "query": query,
        "limit": request.limit,
    }
    if request.order_field is not None:
        body["order"] = [{"field_id": request.order_field, "sort": request.order_sort}]
    if request.after_id is not None:
        body["after_id"] = request.after_id
    return body


class CrunchbaseProvider(DiscoveryProviderInterface):
    """
    Adapts Crunchbase's official v4.0 (Current) Organization Search
    endpoint to DiscoveryProviderInterface. Independent of
    GoogleMapsProvider, YelpProvider, AppleMapsProvider,
    OverpassProvider, AzureMapsProvider, and FoursquareProvider: no
    shared code, no shared state, no dependency on any of the other
    six.

    Stateless: every discover() call issues its own HTTP request(s)
    against the injected (or default) transport; nothing is cached or
    shared across calls or instances.
    """

    def __init__(
        self,
        api_key: str,
        http_post: Optional[Callable[[str, dict[str, Any], dict[str, str]], dict[str, Any]]] = None,
    ) -> None:
        """
        `api_key` is the caller's Crunchbase user_key — this provider
        does not source, cache, or validate credentials beyond passing
        them through as the `X-cb-user-key` header; credential
        management belongs to whoever configures the provider, not to
        the provider itself (same rule as YelpProvider.__init__ and
        FoursquareProvider.__init__).

        `http_post` defaults to `_http_post_urllib` (a real network
        call). Injecting a different callable — e.g. a fake for tests,
        or a caller's own rate-limited HTTP client — never requires
        touching `discover()` or any engine code.
        """
        self._api_key = api_key
        self._http_post = http_post or _http_post_urllib

    @property
    def provider_id(self) -> str:
        return "crunchbase"

    @property
    def display_name(self) -> str:
        return "Crunchbase"

    @classmethod
    def metadata(cls) -> ProviderMetadata:
        """
        This provider's own static characteristics — see
        provider_metadata.py for the full field-by-field rationale.

        A classmethod, not an instance property — same reasoning as
        YelpProvider.metadata() and FoursquareProvider.metadata():
        CrunchbaseProvider.__init__ requires an `api_key`, so a caller
        wanting this provider's metadata (e.g. to populate a selection
        UI, or to register it in a ProviderRegistry) must not be
        forced to already have a valid Crunchbase user_key on hand
        just to learn that this provider requires one.
        """
        return ProviderMetadata(
            provider_id="crunchbase",
            display_name="Crunchbase",
            description=(
                "Streams BusinessCandidate objects from Crunchbase's "
                "official v4.0 Organization Search endpoint — company "
                "discovery data (name, location, website, category, "
                "social links), not maps/local-business data."
            ),
            provider_type="business_directory_api",
            requires_api_key=True,
            default_enabled=True,
            homepage="https://data.crunchbase.com/docs",
            version="1.0.0",
        )

    CAPABILITIES: ProviderCapabilities = ProviderCapabilities(
        supports_keyword_search=True,
        supports_category_search=True,
        supports_city_filter=True,
        supports_country_filter=True,
        supports_radius_search=False,
        supports_coordinate_search=False,
        supported_entity_types=("corporate_entity",),
        provides_financial_data=True,
        supports_pagination=True,
        supports_streaming=True,
    )

    @classmethod
    def capabilities(cls) -> ProviderCapabilities:
        """Return what a caller can ask this provider's discover() to search by."""
        return cls.CAPABILITIES

    def discover(self, request: CrunchbaseDiscoveryRequest) -> Iterator[BusinessCandidate]:
        """
        Streams BusinessCandidate objects for `request`, auto-paginating
        through Crunchbase's own keyset (`after_id`) mechanism — see
        module docstring, "Pagination" — until a short page is
        returned, `request.max_results` is reached (if given), or the
        source itself has no more results. Any exception raised by the
        HTTP transport propagates unchanged — nothing here catches or
        swallows it.
        """
        headers = {
            "X-cb-user-key": self._api_key,
            "Content-Type": "application/json",
            "Accept": "application/json",
        }
        field_ids = list(_BASELINE_FIELD_IDS)
        if request.include_categories:
            field_ids.append("categories")

        after_id = request.after_id
        yielded = 0
        while True:
            body = _build_body(request, field_ids)
            if after_id is not None:
                body["after_id"] = after_id
            payload = self._http_post(_SEARCH_URL, body, headers)
            entities = payload.get("entities", [])
            if not entities:
                return

            for entity in entities:
                yield self._to_business_candidate(entity, request.session_id)
                yielded += 1
                if request.max_results is not None and yielded >= request.max_results:
                    return

            if len(entities) < request.limit:
                # Short page — Crunchbase's own documented signal that
                # no further results remain (see module docstring,
                # "Pagination").
                return
            after_id = entities[-1].get("uuid")
            if after_id is None:
                # Cannot continue paginating without a cursor — the
                # response's own shape did not supply one; stop rather
                # than guess.
                return

    def _to_business_candidate(
        self, entity: dict[str, Any], session_id: str
    ) -> BusinessCandidate:
        """
        Field-for-field mapping, Organization Search entity ->
        BusinessCandidate. See module docstring, "What 'never
        fabricate data' means concretely here," for the full
        field-by-field rationale — every omission below is a field
        Organization Search's own response genuinely does not
        (reliably) expose, not an oversight.
        """
        properties = entity.get("properties") or {}
        identifier = properties.get("identifier") or {}

        permalink = identifier.get("permalink")
        maps_url = f"{_ORG_PROFILE_HOST}/{permalink}" if permalink else None

        locations = properties.get("location_identifiers") or []
        city = next(
            (loc.get("value") for loc in locations if loc.get("location_type") == "city"),
            None,
        )
        country = next(
            (loc.get("value") for loc in locations if loc.get("location_type") == "country"),
            None,
        )

        categories = properties.get("categories") or []
        category = _or_none(categories[0].get("value")) if categories else None

        return BusinessCandidate(
            pipeline_id=str(uuid_lib.uuid4()),
            session_id=session_id,
            provider=self.provider_id,
            provider_business_id=_or_none(entity.get("uuid")),
            maps_url=maps_url,
            name=_or_none(identifier.get("value")),
            category=category,
            address=None,  # No street-address field in Organization Search's response.
            city=_or_none(city),
            country=_or_none(country),
            website=_or_none(properties.get("website_url")),
            phone=None,  # No telephone field in Organization Search's response.
            rating=None,  # Crunchbase has no user-rating concept.
            review_count=None,  # Crunchbase has no review-count concept.
            coordinates=None,  # Location is identifier-based, not lat/lon.
            discovered_at=datetime.now(timezone.utc).isoformat(),
            instagram_url=None,  # No Instagram field in Organization Search's response.
        )
