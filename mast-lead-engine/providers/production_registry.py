"""
providers/production_registry.py
=================================

MAST — Provider Parallelism v1: Production Provider Registry (Step 1
fix — the registry framework existed but was never actually connected
to production; this is the minimal connection).

Responsibility
--------------
Build the one `ProviderRegistry` production actually uses: register
all eight existing providers (`google_maps`, `yelp`, `apple_maps`,
`foursquare`, `azure_maps`, `overpass`, `crunchbase`, `apollo`), each
with its own `metadata()` / `capabilities()` (read from the provider
class itself, never re-derived — see `ProviderRegistry.register()`'s
own "avoid duplicate sources of truth" rule), and a construction
factory that reads that provider's own required credential from the
environment at construction time, not at registration time (mirrors
`ProviderRegistry`'s own documented design: "registration is a
factory, not an instance" — a provider requiring an API key is never
constructed, and its credential never read, just to register it).

Which providers are actually usable in a given process depends on
which credential environment variables are set — see
`_CREDENTIAL_ENV_VARS` below. `google_maps` and `overpass` need no
credential (Google Maps drives the existing, unauthenticated
`MapsScraper`; Overpass queries a public OSM mirror) and are always
constructible. This module does not decide *whether* an unconfigured
provider should be used for a given request — that is
`providers/discovery_composition.py`'s job (Step 2's "is this relevant
provider actually configured" filter); this module only makes
construction fail loudly, with a clear `RuntimeError`, if something
downstream tries to actually build a provider whose credential is
missing, rather than failing confusingly deeper inside that
provider's own `__init__`.

No behavior change for existing single-provider production callers:
this module is purely additive. `service.py` continues to work exactly
as it does today for any caller that does not import or use it.

Status
------
Provider Parallelism v1 milestone.
"""

from __future__ import annotations

import os
from typing import Callable, Optional

from engine.interfaces import DiscoveryProviderInterface
from providers.apollo_provider import ApolloProvider
from providers.apple_maps_provider import AppleMapsProvider
from providers.azure_maps_provider import AzureMapsProvider
from providers.crunchbase_provider import CrunchbaseProvider
from providers.foursquare_provider import FoursquareProvider
from providers.google_maps_provider import GoogleMapsProvider
from providers.overpass_provider import OverpassProvider
from providers.registry import ProviderRegistry
from providers.yelp_provider import YelpProvider

# provider_id -> name of the environment variable holding its required
# credential. A provider absent from this mapping (google_maps,
# overpass) requires no credential at all.
_CREDENTIAL_ENV_VARS: dict[str, str] = {
    "yelp": "YELP_API_KEY",
    "apple_maps": "APPLE_MAPS_ACCESS_TOKEN",
    "foursquare": "FOURSQUARE_API_KEY",
    "azure_maps": "AZURE_MAPS_SUBSCRIPTION_KEY",
    "crunchbase": "CRUNCHBASE_API_KEY",
    "apollo": "APOLLO_API_KEY",
}


def credential_env_var(provider_id: str) -> Optional[str]:
    """
    Name of the environment variable `provider_id` needs to be
    constructed, or `None` if it requires no credential
    (`google_maps`, `overpass`). Raises KeyError for an unknown
    provider_id.
    """
    if provider_id not in _CREDENTIAL_ENV_VARS and provider_id not in (
        "google_maps",
        "overpass",
    ):
        raise KeyError(f"Unknown provider_id {provider_id!r}.")
    return _CREDENTIAL_ENV_VARS.get(provider_id)


def is_configured(provider_id: str) -> bool:
    """
    True if `provider_id` can actually be constructed in this process
    right now — either it needs no credential, or its required
    credential environment variable is set to a non-empty value.
    """
    env_var = credential_env_var(provider_id)
    if env_var is None:
        return True
    return bool(os.environ.get(env_var))


# PHASE 11.4 — Overpass A/B test. Name of the environment variable
# that gates whether `overpass` participates in provider composition
# at all, independent of `is_configured()` above (overpass needs no
# credential and stays fully implemented either way — see
# `is_overpass_enabled()`).
OVERPASS_ENABLE_ENV_VAR = "DISCOVERY_ENABLE_OVERPASS"


def is_overpass_enabled() -> bool:
    """
    Whether `overpass` should be included in provider composition,
    per the `DISCOVERY_ENABLE_OVERPASS` configuration flag (PHASE 11.4
    Overpass A/B test — see providers/discovery_composition.py for
    where this is consumed).

    Default MUST remain `True` to preserve existing behavior: unset,
    empty, or any value other than the literal (case-insensitive)
    string "false" is treated as enabled. Only "false" disables it.
    This is a pure configuration gate on *composition* — it does not
    touch `OverpassProvider`, its registration above, worker counts,
    resource capacity, qualification, scoring, or dedup.
    """
    return os.environ.get(OVERPASS_ENABLE_ENV_VAR, "true").strip().lower() != "false"


def _require_credential(provider_id: str) -> str:
    env_var = _CREDENTIAL_ENV_VARS[provider_id]
    value = os.environ.get(env_var)
    if not value:
        raise RuntimeError(
            f"Cannot construct provider {provider_id!r}: environment "
            f"variable {env_var!r} is not set. Check "
            f"is_configured({provider_id!r}) before selecting this "
            "provider for a request."
        )
    return value


def build_production_registry(
    *,
    google_maps_factory: Optional[Callable[[], DiscoveryProviderInterface]] = None,
    overpass_factory: Optional[Callable[[], DiscoveryProviderInterface]] = None,
) -> ProviderRegistry:
    """
    Build and return a fresh `ProviderRegistry` with all eight
    existing providers registered. Registration itself never reads a
    credential or constructs a provider (see module docstring) — only
    a later `get()` / `build()` / `create()` call on a *specific*
    provider_id does that, and only for that one provider_id.

    `google_maps_factory` — optional override for how `google_maps` is
    *constructed* (defaults to the real `GoogleMapsProvider` class
    itself, used as a zero-arg factory). This exists solely to
    preserve the pre-existing test seam
    tests/test_run_query_target_reached_lifecycle.py and others rely
    on: `service.py` looks up its own module-level `GoogleMapsProvider`
    name at call time and passes it through here, so
    `monkeypatch.setattr(service, "GoogleMapsProvider", fake_factory)`
    still substitutes what discovery actually constructs, exactly as
    it did before this provider ever went through a registry. This
    override changes construction only — registered `metadata()`/
    `capabilities()` always come from the real `GoogleMapsProvider`
    class (static, declared characteristics independent of which
    factory builds instances — the same "metadata/capabilities never
    require construction" rule `ProviderRegistry.register()` already
    documents).

    `overpass_factory` — PHASE 2B addition, same shape and identical
    reasoning to `google_maps_factory` above, added so service.py can
    construct an `OverpassProvider` carrying this run's real profiler
    (see `providers/overpass_provider.py`'s own docstring) the same
    way `google_maps_factory` already lets it do for
    `GoogleMapsProvider`. `None` (the default) preserves exact
    previous behavior — the bare `OverpassProvider` class, used
    directly as a zero-arg factory, exactly as before this addition.
    """
    registry = ProviderRegistry()

    registry.register(
        "google_maps",
        google_maps_factory or GoogleMapsProvider,
        metadata=GoogleMapsProvider.metadata(),
        capabilities=GoogleMapsProvider.capabilities(),
    )
    registry.register(
        "yelp",
        lambda: YelpProvider(api_key=_require_credential("yelp")),
        metadata=YelpProvider.metadata(),
        capabilities=YelpProvider.capabilities(),
    )
    registry.register(
        "apple_maps",
        lambda: AppleMapsProvider(access_token=_require_credential("apple_maps")),
        metadata=AppleMapsProvider.metadata(),
        capabilities=AppleMapsProvider.capabilities(),
    )
    registry.register(
        "foursquare",
        lambda: FoursquareProvider(api_key=_require_credential("foursquare")),
        metadata=FoursquareProvider.metadata(),
        capabilities=FoursquareProvider.capabilities(),
    )
    registry.register(
        "azure_maps",
        lambda: AzureMapsProvider(subscription_key=_require_credential("azure_maps")),
        metadata=AzureMapsProvider.metadata(),
        capabilities=AzureMapsProvider.capabilities(),
    )
    registry.register(
        "overpass",
        overpass_factory or OverpassProvider,
        metadata=OverpassProvider.metadata(),
        capabilities=OverpassProvider.capabilities(),
    )
    registry.register(
        "crunchbase",
        lambda: CrunchbaseProvider(api_key=_require_credential("crunchbase")),
        metadata=CrunchbaseProvider.metadata(),
        capabilities=CrunchbaseProvider.capabilities(),
    )
    registry.register(
        "apollo",
        lambda: ApolloProvider(api_key=_require_credential("apollo")),
        metadata=ApolloProvider.metadata(),
        capabilities=ApolloProvider.capabilities(),
    )

    return registry
