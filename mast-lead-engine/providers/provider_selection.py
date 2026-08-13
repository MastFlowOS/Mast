"""
providers/provider_selection.py
================================

MAST — Provider Parallelism v1: Provider Relevance Selection (Step 2).

Responsibility
--------------
Given a discovery request's target entity type(s), decide which
*registered* providers are actually relevant, using each provider's
own declared `ProviderCapabilities.supported_entity_types` (see
providers/provider_capabilities.py) — never a hardcoded provider name
list.

This module does not construct providers, does not call `discover()`,
does not know about parallelism, composites, or deduplication. It
answers exactly one question — "which provider_ids are relevant to
this request?" — as a pure, deterministic function of data already on
hand (a mapping of provider_id -> ProviderCapabilities, typically
`ProviderRegistry.capabilities_all()`).

Why entity type, not a hardcoded per-niche provider list
----------------------------------------------------------------------
The instructions for this phase are explicit: "The exact relevance
decision MUST be based on the provider capabilities and actual
request/source semantics, not hardcoded 'all providers.'" Every
concrete provider already declares its own
`supported_entity_types` in its `capabilities()` classmethod:

    google_maps, yelp, apple_maps, foursquare, azure_maps, overpass
        -> ("local_business",)
    crunchbase
        -> ("corporate_entity",)
    apollo
        -> ("corporate_entity", "executive_contact")

Selecting on the intersection of "entity types this request wants"
and "entity types this provider supports" is therefore already fully
data-driven: adding a ninth provider that declares
`supported_entity_types=("local_business",)` makes it eligible for
every local-business request with zero changes to this file, and a
provider that supports neither local-business nor corporate lookups
(a future review-scraping provider, say) is naturally excluded without
this module needing to know it exists.

Where "entity type" comes from
----------------------------------------------------------------------
Per-request entity type is not something the existing niche taxonomy
(niches/models.py, niches/taxonomy.py) currently records — no `Niche`
field distinguishes "local business" from "company/organization"
niches today, and this milestone's own instructions forbid inventing
speculative classification ("do not blindly exclude/include without
examining the actual request domain"). Rather than guess from niche
text, the caller (providers/discovery_composition.py, ultimately
service.py) states its intent explicitly via `entity_types`, defaulting
to `("local_business",)` — the correct default for every niche this
codebase currently drives through discovery (coffee shops, dental
clinics, plumbers, restaurants, bakeries, ...). A caller building a
company/organization discovery request passes
`entity_types=("corporate_entity",)` (optionally also
`"executive_contact"`) instead. This keeps the decision explicit,
testable, and honest about what is actually known at the call site,
rather than encoding a guess inside this module.

Status
------
Provider Parallelism v1 milestone. Pure selection logic; does not
modify ProviderRegistry, ProviderCapabilities, or any provider.
"""

from __future__ import annotations

from typing import Mapping, Sequence

from providers.provider_capabilities import ProviderCapabilities

# The default target entity type for every discovery request this
# codebase issues today (local-business niches: coffee shops, dental
# clinics, plumbers, restaurants, bakeries, ...). See module docstring,
# "Where 'entity type' comes from."
DEFAULT_ENTITY_TYPES: tuple[str, ...] = ("local_business",)


def select_relevant_providers(
    capabilities_by_id: Mapping[str, ProviderCapabilities],
    *,
    entity_types: Sequence[str] = DEFAULT_ENTITY_TYPES,
) -> tuple[str, ...]:
    """
    Return the provider_ids from `capabilities_by_id` whose own
    declared `supported_entity_types` intersects `entity_types`, in
    the iteration order of `capabilities_by_id` (stable, deterministic
    for a dict — matches `ProviderRegistry.capabilities_all()`'s own
    registration-derived ordering).

    A provider whose `supported_entity_types` is empty (unset,
    unknown) is never selected — an unspecified capability means
    "unknown," not "matches everything" (mirrors
    `ProviderRegistry.register()`'s own documented default: "an
    omitted value means 'unknown/unspecified,' never 'assumed to
    support everything'").

    Raises ValueError if `entity_types` is empty — a caller with no
    target entity type at all has not stated a real request; there is
    no honest default for "relevant to nothing in particular."
    """
    if not entity_types:
        raise ValueError(
            "entity_types must be non-empty — provider relevance cannot "
            "be decided against an empty target entity type set."
        )

    wanted = frozenset(entity_types)
    selected: list[str] = []
    for provider_id, capabilities in capabilities_by_id.items():
        supported = frozenset(capabilities.supported_entity_types)
        if supported & wanted:
            selected.append(provider_id)
    return tuple(selected)
