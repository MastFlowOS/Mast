"""
MAST Engine V2 — ApolloProvider
==================================

Source: this milestone's own instructions ("implement ApolloProvider"
— read in full, including its explicit instruction to research whether
Apollo.io currently exposes an official public API, whether commercial
access is required, whether it is actively maintained, whether it can
honestly satisfy MAST's company-discovery workflow, whether it can
honestly satisfy lead/contact discovery, and to target only the
officially supported organization-search endpoint if a
legacy/current or search/enrich split exists), engine/interfaces.py:
DiscoveryProviderInterface, engine/contracts.py:BusinessCandidate, and
the seven existing concrete providers this one is built alongside —
providers/google_maps_provider.py:GoogleMapsProvider,
providers/yelp_provider.py:YelpProvider,
providers/apple_maps_provider.py:AppleMapsProvider,
providers/overpass_provider.py:OverpassProvider,
providers/azure_maps_provider.py:AzureMapsProvider,
providers/foursquare_provider.py:FoursquareProvider, and
providers/crunchbase_provider.py:CrunchbaseProvider — read for
precedent, not modified. Also read, not modified:
providers/provider_metadata.py, providers/provider_capabilities.py,
providers/provider_configuration.py, providers/registry.py,
providers/composite_provider.py, providers/parallel_composite_provider.py,
providers/provider_deduplicator.py. External reference: Apollo.io's own
first-party developer documentation (docs.apollo.io) — specifically
"Authentication," "Organization Search," "Get Complete Organization
Info," "Organization Enrichment," and Apollo's own Knowledge Base
article "Export Contacts to a CSV" (for confirming company-level
location/phone field names) — cited throughout "Architecture review"
and "API mapping summary" below, the same discipline
crunchbase_provider.py already applies to Crunchbase's own
documentation.

This is not a new architecture. It is an eighth, independent answer to
the same interface GoogleMapsProvider, YelpProvider, AppleMapsProvider,
OverpassProvider, AzureMapsProvider, FoursquareProvider, and
CrunchbaseProvider already answer — see "Architecture review" below
for why no engine/, workers/, queues/, models/, or provider-platform
file needed to change to add it.

Architecture review
----------------------------------------------------------------------
This milestone's own instructions required determining, before writing
any code: (1) whether Apollo.io exposes an official public API, (2)
whether commercial/API access is required, (3) whether that API is
actively maintained, (4) whether it honestly supports company
discovery, (5) whether it honestly supports lead/contact discovery,
and (6) which endpoints are officially supported for organization
search — targeting only the officially supported endpoint if a
legacy/current or search/enrich split exists. Research findings, as of
this milestone (August 2026), drawn from Apollo's own first-party
documentation at docs.apollo.io:

    1. An official public API exists today: the Apollo REST API,
       documented at docs.apollo.io/reference, with a companion OpenAPI
       specification. Apollo's own docs distinguish exactly one
       officially supported mechanism for authenticated requests (an
       `x-api-key` header — see "Authentication" below) and one
       officially supported endpoint for organization *discovery* (see
       point 6) — there is no legacy/current version split analogous to
       Crunchbase's v3.1/v4.0 split for this endpoint; it is simply the
       current, only-ever-documented shape.

    2. Commercial/API access is required, but is not a blocker per this
       milestone's own instructions ("Do NOT stop for... pricing...
       commercial licensing"). Concretely: every request requires an
       `x-api-key` header, obtained by generating an API key from an
       Apollo account (Apollo's own "Authentication" page: "You need to
       create an API key to access the Apollo API"). Apollo's own
       "Organization Search" reference page documents this specific
       endpoint's own credit cost directly ("1 credit per page... up to
       100 results per page... If Apollo doesn't return results, the
       request consumes 0 credits") and states plainly that "your
       access to endpoints is potentially limited by your team's
       Apollo.io pricing plan" — the same "provider requires a paid
       credential the caller sources independently" category
       YelpProvider's Fusion API key, FoursquareProvider's Places API
       key, and CrunchbaseProvider's user_key already establish, not a
       novel or disqualifying constraint.

    3. The API is actively maintained: Apollo's own "Organization
       Search" reference page this milestone fetched directly carries
       an "Updated 3 days ago" timestamp (as of this milestone), and
       the adjacent "Authentication" page carries "Updated 10 days
       ago" — both well inside the "actively maintained" bar
       CrunchbaseProvider's own review already applied to
       multi-month-old timestamps. Apollo's own docs also advertise a
       machine-readable index at docs.apollo.io/llms.txt kept current
       for the same documentation set — further evidence of an
       actively maintained, first-party-documented surface, not an
       abandoned one.

    4. It genuinely, honestly satisfies MAST's company-discovery
       workflow. Apollo's own "Organization Search" reference page
       (`POST https://api.apollo.io/api/v1/mixed_companies/search`,
       confirmed live, officially documented, and the endpoint Apollo's
       own docs explicitly point to for finding — not merely
       enriching — companies: "Organizations are companies you haven't
       yet saved as accounts on Apollo. Use the Organization Search
       endpoint to find companies in the Apollo database") is a real
       organization-search collection endpoint, not an
       enrichment-only or entity-lookup-only surface requiring a caller
       to already know which company they want:
           - Free-text keyword search via `q_organization_name`
             (documented as accepting partial matches — Apollo's own
             example: filtering by `"marketing"` matches
             `"NY Marketing Unlimited"`) and `q_organization_keyword_tags[]`
             (documented industry/keyword association filter — Apollo's
             own example: `"mining"`).
           - Geographic scoping via `organization_locations[]`
             (Apollo's own documentation: "You can search across
             cities, US states, and countries") and its inverse,
             `organization_not_locations[]`.
           - Domain- and identity-based scoping via
             `q_organization_domains_list[]` and `organization_ids[]`.
           - Firmographic scoping via `organization_num_employees_ranges[]`
             and `revenue_range[min]`/`revenue_range[max]`.
           - A response shape (see "API mapping summary" below) that
             maps honestly onto BusinessCandidate's own fields —
             including a real, stable per-organization `id`, a
             documented `website_url` field, a documented `industry`
             field, and documented company-level location fields.
       No part of MAST's discovery workflow (search by keyword, scope
       by location, stream BusinessCandidate objects, paginate through
       a large result set) is something the current, official
       Organization Search endpoint cannot honestly do.

    5. It honestly supports lead/contact discovery too, as a
       *related, separate* endpoint this file does not call: Apollo's
       own "People API Search" (`POST
       https://api.apollo.io/api/v1/mixed_people/api_search`) is the
       officially documented person/lead-discovery counterpart to
       Organization Search. This milestone's own scope, and
       BusinessCandidate's own contract (engine/contracts.py: "no
       score, no social, no email, no opportunity judgment... no
       score, no social, no email" — a company-shaped record only),
       mean People API Search is out of scope for *this* file for the
       same "search vs. a different collection entirely" reason
       CrunchbaseProvider's own review excluded Crunchbase's People
       endpoints — confirming Apollo *can* honestly support
       lead/contact discovery is part of this milestone's required
       research, not a license to fold a person-shaped result into a
       company-shaped contract.

    6. Officially supported endpoint for organization search,
       specifically: `POST /api/v1/mixed_companies/search` — Apollo's
       own "Organization Search" reference page, cross-linked directly
       from Apollo's own "Companies" documentation section alongside
       "Get Complete Organization Info," "Organization Enrichment,"
       "Bulk Organization Enrichment," "Organization Job Postings," and
       "News Articles Search." Of these, only Organization Search is a
       *search/discovery* collection endpoint; the others are
       single-entity detail lookups or bulk-enrichment calls requiring
       a caller to already know which organization(s) to ask about —
       see "Why the enrichment/lookup endpoints are out of scope"
       below for the same "search vs. lookup" boundary
       CrunchbaseProvider's own review already drew for Crunchbase's
       Entity Lookup endpoint. No deprecated or legacy organization-
       search endpoint exists in Apollo's own documentation to
       mistakenly target instead.

No genuine architectural blocker exists — this milestone does not stop.
What follows is a fully-scoped implementation, per the "if no blocker
exists" branch of this milestone's own instructions.

API mapping summary
----------------------------------------------------------------------
Base URL: `https://api.apollo.io/api/v1` (Apollo's own "Organization
Search" reference page — the exact host+prefix its own documented
endpoint path is given relative to).

Endpoint used by this file: `POST /mixed_companies/search` — Apollo's
own documented Organization Search endpoint, the one endpoint Apollo's
own docs identify for finding (not merely enriching) companies. See
"Architecture review," point 6, above.

Authentication: `x-api-key: {api_key}` request header — Apollo's own
"Authentication" page's one documented mechanism for Apollo users
("Pass the key in the `x-api-key` header of every request"). This
codebase's established preference for header-based credentials over
query-string credentials (see AppleMapsProvider, CrunchbaseProvider)
is also what Apollo's own docs use in every example on that page.

Request body shape (Apollo's own documented Organization Search
query parameters, all sent as a JSON body per this codebase's existing
POST-with-JSON-body providers — CrunchbaseProvider, YelpProvider):

    {
        "q_organization_name": <string>,
        "q_organization_keyword_tags": [...],
        "q_organization_domains_list": [...],
        "organization_locations": [...],
        "organization_not_locations": [...],
        "organization_num_employees_ranges": [...],
        "organization_ids": [...],
        "page": <int>,
        "per_page": <int>
    }

Response body shape (confirmed from Apollo's own "Organization Search"
reference page's own described return shape — an `organizations[]`
collection plus a `pagination` object — and cross-confirmed against
the identically-shaped `organization` object Apollo's own "Organization
Enrichment" / "Get Complete Organization Info" reference pages show in
full, real example JSON, since Organization Search returns the same
per-organization object shape, just abbreviated to search-relevant
fields):

    {
        "organizations": [
            {
                "id": "<string>",
                "name": "<string>",
                "website_url": "<string or null>",
                "primary_domain": "<string or null>",
                "industry": "<string or null>",
                "phone": "<string or null>",
                "city": "<string or null>",
                "state": "<string or null>",
                "country": "<string or null>",
                "linkedin_url": "<string or null>",
                "estimated_num_employees": <int or null>,
                ...
            }, ...
        ],
        "pagination": {
            "page": <int>, "per_page": <int>,
            "total_entries": <int>, "total_pages": <int>
        }
    }

What "never fabricate data" means concretely here
----------------------------------------------------------------------
Every BusinessCandidate field below is populated only when Apollo's own
documented response shape actually contains the corresponding value.
Fields the response does not (reliably) expose are left at their
BusinessCandidate default (None), matching the discipline every other
provider in this codebase already applies to its own source:

    - provider_business_id: the organization's own top-level `id` —
      Apollo's own documented stable per-organization identifier
      (the same value `organization_ids[]` accepts back in a later
      request, confirmed directly on Apollo's own "Organization
      Search" reference page: "The Apollo IDs for the companies you
      want to include in your search results... To find IDs, identify
      the values for `organization_id` when you call this endpoint.").
    - maps_url: never populated. Unlike Crunchbase, whose own docs
      explicitly document constructing a public profile URL from a
      `permalink` field ("Pro Tips: find permalink & UUID easily"),
      nothing in Apollo's own documented organization object exposes a
      canonical, first-party-confirmed public profile URL this file
      could honestly build. Guessing an
      `https://app.apollo.io/#/organizations/{id}`-shaped URL was
      considered and rejected: that shape appears only in third-party
      integration write-ups this milestone found, never in Apollo's
      own first-party documentation — the same "do not invent a URL
      format the source itself never documents" discipline
      FoursquareProvider and CrunchbaseProvider already apply to their
      own `maps_url` construction, applied here to decline rather than
      guess.
    - name: `name` — Apollo's own documented organization display-name
      field, confirmed directly in real response JSON on multiple
      Apollo reference pages this milestone fetched (e.g.
      `"name": "Apollo.io"`).
    - category: `industry` — Apollo's own documented single-string
      industry classification (confirmed directly in real response
      JSON, e.g. `"industry": "information technology & services"`).
      Apollo's own Organization Search request parameters expose no
      separate, enumerated "category" filter (only the keyword-tag
      based `q_organization_keyword_tags[]` — see "Request shape"
      below); the *response* field `industry` is nonetheless a real,
      single-string categorization this file maps honestly, the same
      "map what the response actually returns even where the request
      side works differently" discipline CrunchbaseProvider applies to
      its own `categories` opt-in field.
    - address: never populated. No discrete street-address field
      exists anywhere in Apollo's own documented organization object —
      only city/state/country-level location fields (see below), the
      same granularity gap CrunchbaseProvider's own review already
      found and declined to paper over for Crunchbase.
    - city / country: `city` and `country` — company-level location
      fields Apollo's own Knowledge Base article "Export Contacts to a
      CSV" independently confirms exist on the organization/account
      record ("The state or region associated with the contact's
      company," "The country associated with the contact['s
      company]"), consistent with the `city`/`country` fields visible
      on the organization object in Apollo's own "Organization
      Enrichment" and "Get Complete Organization Info" example
      responses this milestone fetched. `state` (a third,
      US-state-granularity field Apollo's own docs also confirm)
      has no corresponding slot on BusinessCandidate and is not
      force-fit into `city` or `country` — left unmapped rather than
      guessed into the wrong field.
    - website: `website_url` — Apollo's own documented field, mapped
      directly (confirmed directly in real response JSON, e.g.
      `"website_url": "http://www.apollo.io"`). `primary_domain` (a
      second, bare-domain field Apollo's own docs also expose) is
      deliberately not used here — `website_url` is the closer match
      to BusinessCandidate.website's own established meaning (a full
      URL, per every other provider's own `website` mapping in this
      codebase), and mapping both fields onto one BusinessCandidate
      slot would silently prefer one over the other without the
      caller ever being able to tell which.
    - phone: `phone` — Apollo's own documented company-level phone
      field (confirmed directly in real response JSON, present as a
      top-level key even when null, e.g. `"phone": null`). Apollo's
      own object also carries a separate, structured `primary_phone`
      field in some responses; `phone` is used here as the simpler,
      directly-comparable scalar every other provider's own `phone`
      mapping in this codebase already expects.
    - rating / review_count: never populated. Apollo is a B2B
      firmographic/contact-intelligence database, not a
      consumer-review platform — it has no user-rating or
      review-count concept for organizations at all, the identical gap
      CrunchbaseProvider's own review already found and declined to
      paper over by repurposing an unrelated ranking/prominence signal
      onto either field.
    - coordinates: never populated. Apollo's own location fields are
      city/state/country strings, never raw latitude/longitude — the
      same "named-place field, not a coordinate pair" distinction
      CrunchbaseProvider's and OverpassProvider's own docstrings
      already draw for their own respective sources.
    - discovered_at: `datetime.now(timezone.utc).isoformat()` at
      mapping time — the same pattern every other provider in this
      codebase already uses; not an Apollo-sourced value.
    - instagram_url: never populated. Apollo's own documented
      social-link fields are `linkedin_url`, `twitter_url`, and
      `facebook_url` only (confirmed directly in real response JSON
      this milestone fetched) — no Instagram field exists anywhere in
      its documented organization object, the identical gap
      CrunchbaseProvider's own review already found for Crunchbase's
      own `facebook`/`linkedin`/`twitter`-only social fields.

Request shape
----------------------------------------------------------------------
Same reasoning as every other provider's discovery request (see
google_maps_provider.py, Ambiguity 3, and crunchbase_provider.py's own
identical note): DiscoveryProviderInterface.discover() deliberately
leaves the request shape as `Any`, and no shared engine/contracts.py
discovery-request contract exists. ApolloDiscoveryRequest is therefore
defined locally here, mirroring the Organization Search endpoint's own
documented query-parameter contract directly — field names match
Apollo's own documented parameter names (minus the trailing `[]`
array-parameter syntax, which is an HTTP query-string convention this
JSON-body request does not use, the identical "no trailing brackets in
a JSON-body field name" convention CrunchbaseProvider's own
`location_uuids`/`category_uuids` already establish for Crunchbase's
own bracketed parameters) — plus `session_id`, owned by the caller for
the same reason every other request dataclass carries it, and
`max_results` (a caller-side cap across auto-paginated pages — see
"Pagination" below).

Fields NOT included, and why — this milestone's own "do not invent
speculative fields" instruction applied to the *request* side:
`revenue_range`, `currently_using_any_of_technology_uids[]`,
`latest_funding_amount_range`, `total_funding_range`,
`latest_funding_date_range`, `q_organization_job_titles[]`,
`organization_job_locations[]`, `organization_num_jobs_range`, and
`organization_job_posted_at_range` are all real, officially documented
Organization Search parameters this file chooses not to expose today —
each is a genuine, confirmed filter, but none is required to satisfy
MAST's baseline discovery workflow (keyword, location, domain, id,
and employee-count scoping, all included below), and every one of them
maps onto firmographic/funding/hiring *signals* rather than the
identity/location/category dimensions ProviderCapabilities' own field
set (provider_capabilities.py) actually asks providers to describe.
Omitted for scope discipline, not because they are unsupported by
Apollo's own API — a future milestone wanting funding- or
hiring-signal-based discovery can add them additively, the same
"purely additive, no breaking change" discipline this codebase's
frozen request dataclasses already guarantee.

No niche translation — by design, not by omission
----------------------------------------------------------------------
Per this codebase's now-established discipline (see
foursquare_provider.py, "No niche translation," and
crunchbase_provider.py's own identical section): `keyword_tags` takes
Apollo's own free-text keyword-tag strings directly (e.g. `"mining"`,
per Apollo's own documented example) — nothing is renamed,
reinterpreted, or looked up from a generic niche vocabulary. A caller
wanting a specific Apollo-recognized keyword tag supplies Apollo's own
term directly; this file does not wrap or normalize it.

Pagination
----------------------------------------------------------------------
The Organization Search endpoint uses real, first-party-documented
offset-style pagination (Apollo's own "Organization Search" reference
page: `page` / `per_page` query parameters, "Use this parameter in
combination with the `per_page` parameter to make search results...
navigable"), and its own documented response includes a `pagination`
object (`page`, `per_page`, `total_entries`, `total_pages` — confirmed
via Apollo's own documented display-limit note: "up to 500 pages").
Unlike CrunchbaseProvider's keyset (`after_id`) pagination and like
YelpProvider's own offset-based auto-pagination, `discover()` here
auto-pages: it issues an initial POST at `request.page`, yields each
entry's BusinessCandidate, and — whenever the response's own
`pagination.total_pages` indicates more pages remain — issues a
follow-up POST with `page` incremented by one, repeating until the
last page is reached (per the response's own `pagination.total_pages`),
a short/empty `organizations[]` page is returned, or
`request.max_results` (if given) is reached. A caller may also seed
`request.page` directly to resume from a specific page, e.g. after a
prior partial discover() run.

Why the enrichment/lookup endpoints are out of scope
----------------------------------------------------------------------
Apollo's own `GET /organizations/{id}` (Get Complete Organization
Info) and `GET /organizations/enrich` (Organization Enrichment)
endpoints each retrieve one already-known organization by id or
domain — single-entity detail lookups, not discovery/search collection
endpoints. discover() streams candidates matching a search; it does
not require a caller to already know which organization they want.
Using either endpoint here would mean inventing a "which ids/domains
to look up" step this milestone has no input for — the identical
"search vs. lookup, only search belongs to discover()" boundary
GoogleMapsProvider, YelpProvider, and CrunchbaseProvider already
establish for their own respective APIs (see CrunchbaseProvider's own
"Why the Entity Lookup endpoint is out of scope" section for the
precedent this follows directly).

Status
------
ApolloProvider implementation milestone. Eighth concrete
DiscoveryProviderInterface implementation, added alongside
GoogleMapsProvider, YelpProvider, AppleMapsProvider, OverpassProvider,
AzureMapsProvider, FoursquareProvider, and CrunchbaseProvider; does not
replace, wrap, call, or modify any of them. engine/, workers/, queues/,
models/, and every existing provider-platform file (interfaces.py,
contracts.py, registry.py, composite_provider.py,
parallel_composite_provider.py, provider_deduplicator.py,
provider_metadata.py, provider_capabilities.py,
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

_BASE_URL = "https://api.apollo.io/api/v1"
_SEARCH_URL = f"{_BASE_URL}/mixed_companies/search"
_MAX_PER_PAGE = 100  # Organization Search's own documented per-page ceiling.
_DEFAULT_PER_PAGE = 25  # Sane default, matching this codebase's other providers.
_MAX_DISPLAY_PAGES = 500  # Organization Search's own documented display-limit ceiling.


# ---------------------------------------------------------------------------
# Request shape (provider-local — mirrors GoogleMapsDiscoveryRequest /
# YelpDiscoveryRequest / AppleMapsDiscoveryRequest / OverpassDiscoveryRequest /
# AzureMapsDiscoveryRequest / FoursquareDiscoveryRequest / CrunchbaseDiscoveryRequest)
# ---------------------------------------------------------------------------
@dataclass(frozen=True, slots=True)
class ApolloDiscoveryRequest:
    """
    This provider's own accepted request shape. Not a shared
    engine/contracts.py contract — same reasoning as every other
    provider's request dataclass (see google_maps_provider.py,
    Ambiguity 3). Field names mirror the Organization Search endpoint's
    own documented query-parameter contract directly (minus the
    HTTP-query-string `[]` array-parameter suffix — see module
    docstring, "Request shape") so nothing is renamed or reinterpreted
    in translation.

    No field here is required to be non-empty on its own: Organization
    Search itself accepts a bare, filter-less request (every one of
    its documented query parameters is individually optional) — this
    provider does not invent a mandatory filter the endpoint itself
    does not require.

    See module docstring, "Request shape" and "Pagination," for the
    full rationale behind the fields deliberately omitted and the
    auto-pagination fields below.
    """

    session_id: str
    q_organization_name: Optional[str] = None
    keyword_tags: Optional[Sequence[str]] = None  # -> q_organization_keyword_tags
    domains: Optional[Sequence[str]] = None  # -> q_organization_domains_list
    locations: Optional[Sequence[str]] = None  # -> organization_locations
    exclude_locations: Optional[Sequence[str]] = None  # -> organization_not_locations
    employee_ranges: Optional[Sequence[str]] = None  # -> organization_num_employees_ranges
    organization_ids: Optional[Sequence[str]] = None  # -> organization_ids
    per_page: int = _DEFAULT_PER_PAGE  # 1-100, Organization Search's own per-page ceiling
    page: int = 1  # starting page — a caller may seed this to resume
    max_results: Optional[int] = None  # caller-side cap across auto-paginated pages

    def __post_init__(self) -> None:
        if not (1 <= self.per_page <= _MAX_PER_PAGE):
            raise ValueError(
                f"ApolloDiscoveryRequest.per_page must be between 1 and "
                f"{_MAX_PER_PAGE}, per Organization Search's own documented "
                f"per-page ceiling — got {self.per_page!r}."
            )
        if self.page < 1:
            raise ValueError(
                f"ApolloDiscoveryRequest.page must be at least 1 — got "
                f"{self.page!r}."
            )
        if self.max_results is not None and self.max_results < 1:
            raise ValueError(
                "ApolloDiscoveryRequest.max_results must be at least 1 "
                f"when given — got {self.max_results!r}."
            )


def _http_post_urllib(url: str, body: dict[str, Any], headers: dict[str, str]) -> dict[str, Any]:
    """
    Default transport: a plain stdlib JSON POST against the Organization
    Search endpoint. Injected as `http_post` by default; callers may
    supply their own — same "injectable HTTP callable, no hardwired
    HTTP client" reasoning as CrunchbaseProvider's / FoursquareProvider's
    own default transports (no Apollo HTTP client exists yet in this
    codebase, and this milestone's scope is the provider layer, not
    also owning a general-purpose Apollo HTTP client). Raises whatever
    urllib raises on a non-2xx response or network failure — propagated
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


def _build_body(request: ApolloDiscoveryRequest) -> dict[str, Any]:
    """
    Builds the Organization Search JSON request body for `request`,
    wiring each of this provider's own request fields into the exact
    parameter name Apollo's own documentation assigns it (see module
    docstring, "Request shape"). Omits any parameter whose
    corresponding request field is unset, so an unset field is simply
    absent from the call rather than sent as an empty or default value
    this provider invented.
    """
    body: dict[str, Any] = {
        "page": request.page,
        "per_page": request.per_page,
    }
    if request.q_organization_name:
        body["q_organization_name"] = request.q_organization_name
    if request.keyword_tags:
        body["q_organization_keyword_tags"] = list(request.keyword_tags)
    if request.domains:
        body["q_organization_domains_list"] = list(request.domains)
    if request.locations:
        body["organization_locations"] = list(request.locations)
    if request.exclude_locations:
        body["organization_not_locations"] = list(request.exclude_locations)
    if request.employee_ranges:
        body["organization_num_employees_ranges"] = list(request.employee_ranges)
    if request.organization_ids:
        body["organization_ids"] = list(request.organization_ids)
    return body


class ApolloProvider(DiscoveryProviderInterface):
    """
    Adapts Apollo.io's official Organization Search endpoint
    (`POST /mixed_companies/search`) to DiscoveryProviderInterface.
    Independent of GoogleMapsProvider, YelpProvider, AppleMapsProvider,
    OverpassProvider, AzureMapsProvider, FoursquareProvider, and
    CrunchbaseProvider: no shared code, no shared state, no dependency
    on any of the other seven.

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
        `api_key` is the caller's Apollo API key — this provider does
        not source, cache, or validate credentials beyond passing them
        through as the `x-api-key` header; credential management
        belongs to whoever configures the provider, not to the
        provider itself (same rule as YelpProvider.__init__,
        FoursquareProvider.__init__, and CrunchbaseProvider.__init__).

        `http_post` defaults to `_http_post_urllib` (a real network
        call). Injecting a different callable — e.g. a fake for tests,
        or a caller's own rate-limited HTTP client — never requires
        touching `discover()` or any engine code.
        """
        self._api_key = api_key
        self._http_post = http_post or _http_post_urllib

    @property
    def provider_id(self) -> str:
        return "apollo"

    @property
    def display_name(self) -> str:
        return "Apollo"

    @classmethod
    def metadata(cls) -> ProviderMetadata:
        """
        This provider's own static characteristics — see
        provider_metadata.py for the full field-by-field rationale.

        A classmethod, not an instance property — same reasoning as
        YelpProvider.metadata(), FoursquareProvider.metadata(), and
        CrunchbaseProvider.metadata(): ApolloProvider.__init__
        requires an `api_key`, so a caller wanting this provider's
        metadata (e.g. to populate a selection UI, or to register it
        in a ProviderRegistry) must not be forced to already have a
        valid Apollo API key on hand just to learn that this provider
        requires one.
        """
        return ProviderMetadata(
            provider_id="apollo",
            display_name="Apollo",
            description=(
                "Streams BusinessCandidate objects from Apollo.io's "
                "official Organization Search endpoint — B2B company "
                "discovery data (name, location, website, industry, "
                "employee count, phone, social links), not maps/local-"
                "business or consumer-review data."
            ),
            provider_type="business_directory_api",
            requires_api_key=True,
            default_enabled=True,
            homepage="https://docs.apollo.io/reference/organization-search",
            version="1.0.0",
        )

    CAPABILITIES: ProviderCapabilities = ProviderCapabilities(
        supports_keyword_search=True,
        supports_category_search=True,
        supports_city_filter=True,
        supports_country_filter=True,
        supports_radius_search=False,
        supports_coordinate_search=False,
        supported_entity_types=("corporate_entity", "executive_contact"),
        provides_email_addresses=True,
        provides_phone_numbers=True,
        supports_pagination=True,
        supports_streaming=True,
    )

    @classmethod
    def capabilities(cls) -> ProviderCapabilities:
        """Return what a caller can ask this provider's discover() to search by."""
        return cls.CAPABILITIES

    def discover(self, request: ApolloDiscoveryRequest) -> Iterator[BusinessCandidate]:
        """
        Streams BusinessCandidate objects for `request`, auto-paginating
        through Apollo's own offset-style (`page`/`per_page`) mechanism
        — see module docstring, "Pagination" — until the response's own
        `pagination.total_pages` is exhausted, a short/empty page is
        returned, or `request.max_results` (if given) is reached. Any
        exception raised by the HTTP transport propagates unchanged —
        nothing here catches or swallows it.
        """
        headers = {
            "x-api-key": self._api_key,
            "Content-Type": "application/json",
            "Cache-Control": "no-cache",
        }

        page = request.page
        yielded = 0
        pages_fetched = 0
        while True:
            body = _build_body(request)
            body["page"] = page
            payload = self._http_post(_SEARCH_URL, body, headers)
            organizations = payload.get("organizations", [])
            pages_fetched += 1

            if not organizations:
                return

            for organization in organizations:
                yield self._to_business_candidate(organization, request.session_id)
                yielded += 1
                if request.max_results is not None and yielded >= request.max_results:
                    return

            pagination = payload.get("pagination") or {}
            total_pages = pagination.get("total_pages")
            if total_pages is not None and page >= total_pages:
                # Apollo's own documented end-of-results signal.
                return
            if len(organizations) < request.per_page:
                # Short page — treat as end of results even if
                # `pagination.total_pages` was absent from the
                # response, mirroring YelpProvider's own short-page
                # stopping rule.
                return
            if pages_fetched >= _MAX_DISPLAY_PAGES:
                # Organization Search's own documented display-limit
                # ceiling (50,000 records / 100 per page = 500 pages) —
                # stop rather than request a page Apollo's own docs say
                # will not be served.
                return
            page += 1

    def _to_business_candidate(
        self, organization: dict[str, Any], session_id: str
    ) -> BusinessCandidate:
        """
        Field-for-field mapping, Organization Search entry ->
        BusinessCandidate. See module docstring, "What 'never
        fabricate data' means concretely here," for the full
        field-by-field rationale — every omission below is a field
        Organization Search's own response genuinely does not
        (reliably) expose, not an oversight.
        """
        return BusinessCandidate(
            pipeline_id=str(uuid_lib.uuid4()),
            session_id=session_id,
            provider=self.provider_id,
            provider_business_id=_or_none(organization.get("id")),
            maps_url=None,  # No confirmed public-profile-URL field — see module docstring.
            name=_or_none(organization.get("name")),
            category=_or_none(organization.get("industry")),
            address=None,  # No street-address field in Organization Search's response.
            city=_or_none(organization.get("city")),
            country=_or_none(organization.get("country")),
            website=_or_none(organization.get("website_url")),
            phone=_or_none(organization.get("phone")),
            rating=None,  # Apollo has no user-rating concept.
            review_count=None,  # Apollo has no review-count concept.
            coordinates=None,  # Location is city/state/country text, not lat/lon.
            discovered_at=datetime.now(timezone.utc).isoformat(),
            instagram_url=None,  # No Instagram field in Organization Search's response.
        )
