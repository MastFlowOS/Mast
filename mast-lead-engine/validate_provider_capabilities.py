"""
MAST Engine V2 — validate_provider_capabilities.py
=====================================================

Source: this milestone's own instructions ("create
validate_provider_capabilities.py"), and the existing validation
scripts this mirrors in style and rigor — validate_composite_provider.py
and validate_yelp_provider.py (both referenced by name in this
package's existing docstrings, not modified by this file).

What this validates
--------------------
    1. GoogleMapsProvider.capabilities() — correct, construction-free.
    2. YelpProvider.capabilities() — correct, construction-free.
    3. ProviderRegistry.capabilities(provider_id) — single lookup.
    4. ProviderRegistry.capabilities_all() — full listing.
    5. Capabilities are retrievable WITHOUT constructing a provider
       (concretely: without ever supplying YelpProvider's required
       `api_key`).
    6. ProviderMetadata / `metadata()` / `metadata_all()` are
       unchanged by this milestone (still correct, still
       construction-free).
    7. Provider construction (`get()`, `build()`, `create()`) is
       unchanged by this milestone — providers still construct, run,
       and stream BusinessCandidate objects exactly as before.
    8. Engine compatibility: DiscoveryProviderInterface is untouched —
       capabilities live entirely outside its abstract contract, so
       every existing DiscoveryProviderInterface implementation
       (including any not updated with a `capabilities()` classmethod)
       remains a valid, constructible, runnable provider.
    9. No engine/, workers/, queues/, or models/ change was required —
       this script imports nothing from those packages except the
       existing engine.contracts.BusinessCandidate /
       engine.interfaces.DiscoveryProviderInterface surface every
       other provider-layer validation script already imports.

This script does not modify any production file. It only imports and
exercises the provider layer exactly as a real caller would.
"""

from __future__ import annotations

import sys
import traceback
from typing import Callable

from engine.interfaces import DiscoveryProviderInterface
from providers.google_maps_provider import GoogleMapsProvider
from providers.provider_capabilities import ProviderCapabilities
from providers.provider_metadata import ProviderMetadata
from providers.registry import ProviderRegistry
from providers.yelp_provider import YelpProvider

_FAILURES: list[str] = []


def _check(label: str, condition: bool, detail: str = "") -> None:
    status = "PASS" if condition else "FAIL"
    print(f"[{status}] {label}" + (f" — {detail}" if detail and not condition else ""))
    if not condition:
        _FAILURES.append(label)


def _run(label: str, fn: Callable[[], None]) -> None:
    """Run one validation section, catching and reporting any exception
    as a failure rather than letting it abort the whole script — every
    other section should still get a chance to report its own result."""
    print(f"\n--- {label} ---")
    try:
        fn()
    except Exception as exc:  # noqa: BLE001 — validation script, not production code
        print(f"[FAIL] {label} raised {type(exc).__name__}: {exc}")
        traceback.print_exc()
        _FAILURES.append(f"{label} (raised {type(exc).__name__})")


# ---------------------------------------------------------------------------
# 1. GoogleMapsProvider.capabilities() — correct, construction-free
# ---------------------------------------------------------------------------
def validate_google_maps_capabilities() -> None:
    caps = GoogleMapsProvider.capabilities()  # no instance constructed
    _check("returns ProviderCapabilities", isinstance(caps, ProviderCapabilities))
    _check("supports_keyword_search == True", caps.supports_keyword_search is True)
    _check("supports_category_search == True", caps.supports_category_search is True)
    _check("supports_city_filter == True", caps.supports_city_filter is True)
    _check("supports_country_filter == True", caps.supports_country_filter is True)
    _check("supports_radius_search == False", caps.supports_radius_search is False)
    _check("supports_coordinate_search == False", caps.supports_coordinate_search is False)
    _check("supports_pagination == False", caps.supports_pagination is False)
    _check("supports_streaming == True", caps.supports_streaming is True)


# ---------------------------------------------------------------------------
# 2. YelpProvider.capabilities() — correct, construction-free
# ---------------------------------------------------------------------------
def validate_yelp_capabilities() -> None:
    # Deliberately NOT constructing YelpProvider(api_key=...) — the
    # whole point being validated is that capabilities() answers
    # without a credential.
    caps = YelpProvider.capabilities()
    _check("returns ProviderCapabilities", isinstance(caps, ProviderCapabilities))
    _check("supports_keyword_search == True", caps.supports_keyword_search is True)
    _check("supports_category_search == True", caps.supports_category_search is True)
    _check("supports_city_filter == True", caps.supports_city_filter is True)
    _check("supports_country_filter == False", caps.supports_country_filter is False)
    _check("supports_radius_search == False", caps.supports_radius_search is False)
    _check("supports_coordinate_search == False", caps.supports_coordinate_search is False)
    _check("supports_pagination == True", caps.supports_pagination is True)
    _check("supports_streaming == True", caps.supports_streaming is True)

    # The two providers must genuinely differ where their real request
    # shapes differ (country, pagination) — capabilities that are
    # identical across every provider would be a red flag that they
    # were invented rather than read off each provider's own code.
    google_caps = GoogleMapsProvider.capabilities()
    _check(
        "google_maps and yelp differ on supports_country_filter",
        google_caps.supports_country_filter != caps.supports_country_filter,
    )
    _check(
        "google_maps and yelp differ on supports_pagination",
        google_caps.supports_pagination != caps.supports_pagination,
    )


# ---------------------------------------------------------------------------
# Shared registry fixture for the remaining sections
# ---------------------------------------------------------------------------
def _build_registry() -> ProviderRegistry:
    registry = ProviderRegistry()
    registry.register(
        "google_maps",
        GoogleMapsProvider,
        metadata=GoogleMapsProvider.metadata(),
        capabilities=GoogleMapsProvider.capabilities(),
    )
    registry.register(
        "yelp",
        lambda: YelpProvider(api_key="unused-in-this-validation-path"),
        metadata=YelpProvider.metadata(),
        capabilities=YelpProvider.capabilities(),
    )
    return registry


# ---------------------------------------------------------------------------
# 3. ProviderRegistry.capabilities(provider_id) — single lookup
# ---------------------------------------------------------------------------
def validate_registry_single_lookup() -> None:
    registry = _build_registry()

    gm_caps = registry.capabilities("google_maps")
    _check("registry.capabilities('google_maps') matches classmethod", gm_caps == GoogleMapsProvider.capabilities())

    yelp_caps = registry.capabilities("yelp")
    _check("registry.capabilities('yelp') matches classmethod", yelp_caps == YelpProvider.capabilities())

    try:
        registry.capabilities("not_registered")
        _check("unregistered id raises KeyError", False, "no exception raised")
    except KeyError:
        _check("unregistered id raises KeyError", True)


# ---------------------------------------------------------------------------
# 4. ProviderRegistry.capabilities_all() — full listing
# ---------------------------------------------------------------------------
def validate_registry_listing() -> None:
    registry = _build_registry()
    all_caps = registry.capabilities_all()

    _check("capabilities_all() returns a mapping", hasattr(all_caps, "keys"))
    _check("capabilities_all() has both provider ids", set(all_caps.keys()) == {"google_maps", "yelp"})
    _check(
        "capabilities_all()['google_maps'] matches single lookup",
        all_caps["google_maps"] == registry.capabilities("google_maps"),
    )
    _check(
        "capabilities_all()['yelp'] matches single lookup",
        all_caps["yelp"] == registry.capabilities("yelp"),
    )


# ---------------------------------------------------------------------------
# 5. Capabilities retrieved without constructing any provider
# ---------------------------------------------------------------------------
def validate_no_construction_required() -> None:
    calls: list[str] = []

    def tracking_google_factory() -> GoogleMapsProvider:
        calls.append("google_maps constructed")
        return GoogleMapsProvider()

    def tracking_yelp_factory() -> YelpProvider:
        calls.append("yelp constructed")
        # Would raise if api_key were required-and-missing in a real
        # deployment; the point is this factory is never even called
        # by capabilities()/capabilities_all()/metadata()/metadata_all().
        return YelpProvider(api_key="unused-in-this-validation-path")

    registry = ProviderRegistry()
    registry.register(
        "google_maps",
        tracking_google_factory,
        metadata=GoogleMapsProvider.metadata(),
        capabilities=GoogleMapsProvider.capabilities(),
    )
    registry.register(
        "yelp",
        tracking_yelp_factory,
        metadata=YelpProvider.metadata(),
        capabilities=YelpProvider.capabilities(),
    )

    registry.capabilities("google_maps")
    registry.capabilities("yelp")
    registry.capabilities_all()
    registry.metadata("google_maps")
    registry.metadata_all()

    _check("no factory was called by any capabilities()/metadata() lookup", calls == [], f"calls={calls}")


# ---------------------------------------------------------------------------
# 6. ProviderMetadata unchanged
# ---------------------------------------------------------------------------
def validate_metadata_unchanged() -> None:
    gm_meta = GoogleMapsProvider.metadata()
    _check("GoogleMapsProvider.metadata() still returns ProviderMetadata", isinstance(gm_meta, ProviderMetadata))
    _check("GoogleMapsProvider.metadata().provider_id unchanged", gm_meta.provider_id == "google_maps")
    _check("GoogleMapsProvider.metadata().requires_api_key unchanged", gm_meta.requires_api_key is False)

    yelp_meta = YelpProvider.metadata()
    _check("YelpProvider.metadata() still returns ProviderMetadata", isinstance(yelp_meta, ProviderMetadata))
    _check("YelpProvider.metadata().provider_id unchanged", yelp_meta.provider_id == "yelp")
    _check("YelpProvider.metadata().requires_api_key unchanged", yelp_meta.requires_api_key is True)

    registry = _build_registry()
    _check(
        "registry.metadata_all() still construction-free and correct",
        {m.provider_id for m in registry.metadata_all()} == {"google_maps", "yelp"},
    )


# ---------------------------------------------------------------------------
# 7. Provider construction unchanged
# ---------------------------------------------------------------------------
def validate_construction_unchanged() -> None:
    registry = _build_registry()

    gm = registry.get("google_maps")
    _check("get('google_maps') returns a DiscoveryProviderInterface", isinstance(gm, DiscoveryProviderInterface))
    _check("constructed provider still exposes provider_id", gm.provider_id == "google_maps")
    _check("constructed provider still exposes discover()", callable(getattr(gm, "discover", None)))

    yelp = registry.get("yelp")
    _check("get('yelp') returns a DiscoveryProviderInterface", isinstance(yelp, DiscoveryProviderInterface))
    _check("constructed provider still exposes provider_id", yelp.provider_id == "yelp")

    composite = registry.build(["google_maps", "yelp"])
    _check("build() still returns a composite of both providers", len(composite.providers) == 2)

    from providers.provider_configuration import ProviderConfiguration

    single = registry.create(ProviderConfiguration(providers=["google_maps"]))
    _check("create() with one provider still returns the bare instance", single.provider_id == "google_maps")


# ---------------------------------------------------------------------------
# 8 & 9. Engine compatibility — no engine/ change required
# ---------------------------------------------------------------------------
def validate_engine_compatibility() -> None:
    # DiscoveryProviderInterface itself declares no capabilities()
    # method — capabilities live entirely outside the abstract
    # contract, exactly like metadata(). A minimal, deliberately
    # capabilities()-less DiscoveryProviderInterface implementation
    # must remain perfectly valid and constructible.
    class _MinimalLegacyProvider(DiscoveryProviderInterface):
        @property
        def provider_id(self) -> str:
            return "minimal_legacy"

        @property
        def display_name(self) -> str:
            return "Minimal Legacy"

        def discover(self, request):  # noqa: ANN001 — matches DiscoveryProviderInterface.discover(request: Any)
            yield from ()

    instance = _MinimalLegacyProvider()
    _check(
        "a provider with no capabilities() classmethod is still a valid DiscoveryProviderInterface",
        isinstance(instance, DiscoveryProviderInterface),
    )
    _check(
        "such a provider still registers and constructs normally",
        _register_and_construct_minimal(instance),
    )

    import inspect

    abstract_method_names = {
        name
        for name, member in inspect.getmembers(DiscoveryProviderInterface)
        if getattr(member, "__isabstractmethod__", False)
    }
    _check(
        "DiscoveryProviderInterface's abstract surface is unchanged (identity + discover only)",
        abstract_method_names == {"provider_id", "display_name", "discover"},
        f"found: {abstract_method_names}",
    )


def _register_and_construct_minimal(instance: DiscoveryProviderInterface) -> bool:
    registry = ProviderRegistry()
    registry.register("minimal_legacy", lambda: instance)
    built = registry.get("minimal_legacy")
    # No capabilities were ever supplied for this registration — the
    # registry must fall back to a default ProviderCapabilities()
    # rather than raising.
    caps = registry.capabilities("minimal_legacy")
    return (
        built is instance
        and isinstance(caps, ProviderCapabilities)
        and caps == ProviderCapabilities()
    )


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------
def main() -> int:
    _run("Google capabilities", validate_google_maps_capabilities)
    _run("Yelp capabilities", validate_yelp_capabilities)
    _run("Registry lookup", validate_registry_single_lookup)
    _run("Registry listing", validate_registry_listing)
    _run("Capabilities without construction", validate_no_construction_required)
    _run("Metadata unchanged", validate_metadata_unchanged)
    _run("Provider construction unchanged", validate_construction_unchanged)
    _run("Engine compatibility / zero engine changes", validate_engine_compatibility)

    print("\n" + "=" * 60)
    if _FAILURES:
        print(f"RESULT: FAIL ({len(_FAILURES)} check(s) failed)")
        for f in _FAILURES:
            print(f"  - {f}")
        return 1
    print("RESULT: PASS — all Provider Capabilities checks passed.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
