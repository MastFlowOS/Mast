"""
MAST Engine V2 — ProviderMetadata
====================================

Source: this milestone's own instructions ("implement Provider
Metadata"), engine/interfaces.py:DiscoveryProviderInterface (read for
precedent, not modified — see that class's own docstring: "Provider
runtime status and descriptive metadata... are deliberately deferred,
not part of this interface yet... they belong to the future Provider
Registry milestone"), and providers/registry.py, which already
anticipated this exact milestone by name in its own docstring
("Provider Registry milestone") and already carried a small,
identity-only `ProviderMetadata` (provider_id + display_name) as a
placeholder for it.

Responsibility
--------------
ProviderMetadata has exactly one job: describe a provider's static
*characteristics* — the kind of thing a caller, a config UI, or a
future CLI would want to know before ever constructing or running the
provider. It is pure data, exactly like ProviderConfiguration
(provider_configuration.py) and BusinessCandidate
(engine/contracts.py) are pure data. It describes; it does not do.

Explicitly NOT covered here (see "Out of scope" in this milestone's
own instructions, and DiscoveryProviderInterface's own docstring on
why health/capabilities are deferred):

    - Runtime status / health checks (is the provider currently
      reachable, rate-limited, degraded).
    - Capabilities (supported countries/languages/rate limits).
    - Metrics (call counts, latencies).
    - Plugin discovery.

Those remain out of scope for this milestone, same as they were
explicitly deferred by every provider-layer milestone before it.

Field selection
----------------
Only fields that are genuinely answerable, today, by the two existing
concrete providers (GoogleMapsProvider, YelpProvider) are included —
nothing speculative:

    provider_id       — mirrors DiscoveryProviderInterface.provider_id
                         exactly (same stable machine identifier); not
                         a new concept, just the existing identity
                         surfaced as data.
    display_name       — mirrors DiscoveryProviderInterface.display_name
                         exactly, for the same reason.
    description         — a short human-readable sentence describing
                         what the provider does and where its data
                         comes from. Genuinely answerable per-provider
                         from that provider's own module docstring
                         ("Responsibility" section).
    provider_type       — a short machine-readable category string
                         (e.g. "maps_scraper", "business_directory_api").
                         Genuinely distinguishes GoogleMapsProvider
                         (browser-automation scraper) from YelpProvider
                         (REST API client) — a real, observable
                         difference between the two existing providers,
                         not an invented one.
    requires_api_key    — whether constructing this provider requires a
                         caller-supplied credential. Directly answerable:
                         GoogleMapsProvider() takes no credentials;
                         YelpProvider(api_key=...) requires one — see
                         each provider's own __init__.
    default_enabled     — whether this provider should be selected by
                         default when a caller hasn't explicitly opted
                         in or out. A simple, genuinely useful boolean
                         a configuration UI needs; not a runtime
                         health signal (a provider can be
                         default_enabled=True and still be temporarily
                         unreachable — that's a health question, out
                         of scope here).
    homepage            — a URL for the underlying data source, for
                         human reference (e.g. in a config UI). Purely
                         descriptive, never fetched or validated by
                         this codebase.
    version             — a free-form string identifying this
                         provider *implementation's* own version
                         (this file, not the upstream API's version).
                         Lets a future caller distinguish "which
                         version of GoogleMapsProvider's mapping logic
                         produced this data" without inventing a
                         schema-versioning system this milestone has
                         no authority to design.

Deliberately excluded, per this milestone's "do not invent speculative
metadata" instruction: rate limits, supported regions/languages,
pricing, SLA/uptime figures, and anything else no existing provider
can honestly answer today.

Immutability
-------------
Frozen and slotted, matching every other provider-layer data shape
(BusinessCandidate, ProviderConfiguration) — the Golden Rule
(engine/contracts.py) extends naturally to this: a provider's own
description of itself should not be mutable by a caller holding a
reference to it.

Status
------
Provider Metadata milestone. Pure data addition. Does not modify
DiscoveryProviderInterface, GoogleMapsProvider, YelpProvider,
CompositeDiscoveryProvider, ParallelCompositeDiscoveryProvider,
ProviderDeduplicator, or ProviderConfiguration's own shape — see
google_maps_provider.py / yelp_provider.py for the one small,
additive change each makes (a `metadata()` classmethod that returns an
instance of this class), and registry.py for how ProviderRegistry
reads that classmethod's output rather than inventing its own
description of a provider.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Optional


@dataclass(frozen=True, slots=True)
class ProviderMetadata:
    """
    Declarative description of a single provider's static
    characteristics. See module docstring for full field-by-field
    rationale and for what is deliberately excluded.

    Describes provider characteristics, not runtime behavior:
    everything on this class is knowable without constructing the
    provider, calling discover(), or making any network request.
    """

    provider_id: str
    display_name: str
    description: str = ""
    provider_type: str = "unknown"
    requires_api_key: bool = False
    default_enabled: bool = True
    homepage: Optional[str] = None
    version: str = "unknown"
