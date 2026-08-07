"""
MAST Engine V2 — Providers Package (placeholder)
===================================================

Source: Engine BluePrint, Phase 1.1 Principle 9 ("Discovery providers
are plug-ins"), Phase 1.4 ("Multi-Provider Ready"), Phase 1.5
("V2 Folder Structure" / "Final Principle"), and Phase 5.1 ("Provider
Layer — the abstraction").

Future responsibility
----------------------
Discovery providers are plug-ins that all produce the same output —
BusinessCandidate (engine/contracts.py) — so the rest of the engine
never needs to know which provider found a given business. Per the
blueprint's target layout:

    providers/google_maps/
    providers/linkedin/
    providers/yelp/

Each will implement engine.interfaces.DiscoveryProviderInterface. As of
Phase 5.1, that interface covers identity and discovery only: a
`provider_id` and `display_name` identity, and a `discover(...)` method
that streams BusinessCandidate objects (an iterator, never a
materialized list, so very large result sets are naturally supported).
Provider runtime status (a health check) and descriptive metadata
(capabilities such as supported countries/languages/rate limits) are
deliberately not part of the interface yet — those will be introduced
alongside the future Provider Registry milestone, which is the right
place to decide their shape together with how providers get
registered and selected. The blueprint's final test for this
architecture: "If I remove Google Maps tomorrow and replace it with
LinkedIn, how many files change? The answer should be: One provider
implementation and its registration."

This package is created now, empty, as the home providers will live in.
The existing scraper/maps_scraper.py is NOT modified or moved by this
milestone — Google Maps becoming a GoogleMapsProvider is explicitly a
later Phase 5 milestone, not this one.

Status
------
Phase 5.2 update: this package is no longer an empty placeholder.
google_maps_provider.py now provides the first concrete
DiscoveryProviderInterface implementation — GoogleMapsProvider — a
thin wrapper around the existing, unmodified
scraper/maps_scraper.py:MapsScraper.search(). It produces
BusinessCandidate objects only: no enrichment, no storage, no scoring,
no qualification (see that module's docstring for the ambiguities
flagged while implementing it, including why chain/cannabis filtering
and fingerprinting were deliberately left out of this layer).
scraper/maps_scraper.py itself remains untouched and continues to run
exactly as it does today outside of this wrapper. No SearchGenerator
or ProviderRegistry exists yet — both remain out of scope, per the
Phase 5.2 milestone that introduced this file.

Provider Registry milestone update: providers/registry.py now provides
ProviderRegistry — the single source of truth for registering
providers, exposing their identity metadata, looking them up by id,
and building CompositeDiscoveryProvider instances (build() / build_all())
from registered providers. It owns registration and construction only;
health checks and capabilities metadata remain out of scope, per that
module's own docstring. The Engine remains completely unaware a
registry exists — it still only ever holds a bare
DiscoveryProviderInterface reference, exactly as before this milestone.
No other package (engine/, workers/, queues/, models/) is touched.

TODO(future milestones): plugin auto-discovery (scanning for provider
modules instead of explicit register() calls), provider-level
deduplication, and registry/provider runtime metrics are all
explicitly deferred — see providers/registry.py's own docstring.
"""

from __future__ import annotations
