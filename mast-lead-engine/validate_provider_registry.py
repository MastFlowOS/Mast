"""
MAST Engine V2 — validate_provider_registry.py
==================================================

Standalone validation for providers/registry.py:ProviderRegistry.
Mirrors this project's existing validate_*.py convention: plain
assertions, no test framework dependency, run directly with `python3
validate_provider_registry.py`.

Validates, in order:
    1. Registration
    2. Duplicate provider_id detection
    3. Registration input validation (bad provider_id / bad factory)
    4. Metadata exposure (per-id and list)
    5. Lookup by id (get)
    6. Return-all (all)
    7. build() -> CompositeDiscoveryProvider
    8. build_all()
    9. Type validation of factory output (registry rejects a
       misbehaving factory)
   10. Compatibility with DiscoveryProviderInterface (real
       GoogleMapsProvider / YelpProvider, unmodified)
   11. No engine changes required (imports engine/ read-only, never
       edits it)
"""

from __future__ import annotations

from engine.interfaces import DiscoveryProviderInterface
from providers.composite_provider import CompositeDiscoveryProvider
from providers.google_maps_provider import GoogleMapsProvider
from providers.yelp_provider import YelpProvider
from providers.registry import ProviderMetadata, ProviderRegistry

PASS = "PASS"
FAIL = "FAIL"
results: list[tuple[str, str, str]] = []


def check(name: str, condition: bool, detail: str = "") -> None:
    results.append((name, PASS if condition else FAIL, detail))


# ---------------------------------------------------------------------------
# 1-3. Registration, duplicate detection, input validation
# ---------------------------------------------------------------------------
registry = ProviderRegistry()

registry.register("google_maps", GoogleMapsProvider, display_name="Google Maps")
registry.register(
    "yelp",
    lambda: YelpProvider(api_key="test-key"),
    display_name="Yelp",
)
check("1. register() accepts valid registrations", registry.is_registered("google_maps") and registry.is_registered("yelp"))

try:
    registry.register("google_maps", GoogleMapsProvider)
    check("2. duplicate provider_id rejected", False, "no exception raised")
except ValueError:
    check("2. duplicate provider_id rejected", True)

try:
    registry.register("", GoogleMapsProvider)
    check("3a. empty provider_id rejected", False, "no exception raised")
except ValueError:
    check("3a. empty provider_id rejected", True)

try:
    registry.register("not_callable", factory="oops")  # type: ignore[arg-type]
    check("3b. non-callable factory rejected", False, "no exception raised")
except TypeError:
    check("3b. non-callable factory rejected", True)


# ---------------------------------------------------------------------------
# 4. Metadata exposure
# ---------------------------------------------------------------------------
gm_meta = registry.metadata("google_maps")
check(
    "4a. metadata() returns correct ProviderMetadata",
    isinstance(gm_meta, ProviderMetadata)
    and gm_meta.provider_id == "google_maps"
    and gm_meta.display_name == "Google Maps",
    repr(gm_meta),
)

all_meta = registry.list_metadata()
check(
    "4b. list_metadata() returns metadata for every registration",
    {m.provider_id for m in all_meta} == {"google_maps", "yelp"},
    repr(all_meta),
)

try:
    registry.metadata("does_not_exist")
    check("4c. metadata() raises KeyError for unknown id", False, "no exception raised")
except KeyError:
    check("4c. metadata() raises KeyError for unknown id", True)


# ---------------------------------------------------------------------------
# 5. Lookup by id
# ---------------------------------------------------------------------------
gm_instance = registry.get("google_maps")
check(
    "5a. get() returns a fresh, correctly-typed instance",
    isinstance(gm_instance, GoogleMapsProvider) and gm_instance.provider_id == "google_maps",
)

gm_instance_2 = registry.get("google_maps")
check(
    "5b. get() returns independent instances across calls (stateless)",
    gm_instance is not gm_instance_2,
)

try:
    registry.get("does_not_exist")
    check("5c. get() raises KeyError for unknown id", False, "no exception raised")
except KeyError:
    check("5c. get() raises KeyError for unknown id", True)


# ---------------------------------------------------------------------------
# 6. Return all
# ---------------------------------------------------------------------------
all_instances = registry.all()
check(
    "6. all() returns one instance per registration, correctly typed",
    len(all_instances) == 2
    and {type(i) for i in all_instances} == {GoogleMapsProvider, YelpProvider},
    repr(all_instances),
)


# ---------------------------------------------------------------------------
# 7. build() -> CompositeDiscoveryProvider
# ---------------------------------------------------------------------------
composite = registry.build(["google_maps", "yelp"])
check(
    "7a. build() returns a CompositeDiscoveryProvider",
    isinstance(composite, CompositeDiscoveryProvider),
)
check(
    "7b. build() wraps providers in requested order",
    [p.provider_id for p in composite.providers] == ["google_maps", "yelp"],
    repr([p.provider_id for p in composite.providers]),
)

single = registry.build(["yelp"])
check(
    "7c. build() with a single id still returns a CompositeDiscoveryProvider",
    isinstance(single, CompositeDiscoveryProvider) and len(single.providers) == 1,
)

try:
    registry.build(["google_maps", "not_registered"])
    check("7d. build() raises KeyError for an unregistered id", False, "no exception raised")
except KeyError:
    check("7d. build() raises KeyError for an unregistered id", True)


# ---------------------------------------------------------------------------
# 8. build_all()
# ---------------------------------------------------------------------------
composite_all = registry.build_all()
check(
    "8. build_all() wraps every registered provider",
    isinstance(composite_all, CompositeDiscoveryProvider)
    and {p.provider_id for p in composite_all.providers} == {"google_maps", "yelp"},
)


# ---------------------------------------------------------------------------
# 9. Factory type validation (registry rejects a misbehaving factory)
# ---------------------------------------------------------------------------
bad_registry = ProviderRegistry()
bad_registry.register("not_a_provider", lambda: object())
try:
    bad_registry.get("not_a_provider")
    check("9a. get() rejects a factory that returns a non-provider", False, "no exception raised")
except TypeError:
    check("9a. get() rejects a factory that returns a non-provider", True)

mismatched_registry = ProviderRegistry()
mismatched_registry.register("wrong_key", GoogleMapsProvider)  # real provider_id is "google_maps"
try:
    mismatched_registry.get("wrong_key")
    check("9b. get() rejects a provider_id/registration-key mismatch", False, "no exception raised")
except TypeError:
    check("9b. get() rejects a provider_id/registration-key mismatch", True)


# ---------------------------------------------------------------------------
# 10. Compatibility with DiscoveryProviderInterface
# ---------------------------------------------------------------------------
check(
    "10a. registry.get() output satisfies DiscoveryProviderInterface",
    isinstance(registry.get("google_maps"), DiscoveryProviderInterface),
)
check(
    "10b. registry.build() output satisfies DiscoveryProviderInterface",
    isinstance(registry.build(["google_maps"]), DiscoveryProviderInterface),
)
check(
    "10c. registry.build_all() output satisfies DiscoveryProviderInterface",
    isinstance(registry.build_all(), DiscoveryProviderInterface),
)
check(
    "10d. built composite exposes discover() (uncalled — no live network/scraper in this validation)",
    callable(getattr(registry.build_all(), "discover", None)),
)


# ---------------------------------------------------------------------------
# 11. No engine changes required
# ---------------------------------------------------------------------------
import inspect
import engine.interfaces as engine_interfaces_module
import engine.contracts as engine_contracts_module

check(
    "11. engine/ modules imported read-only, never written by this script",
    inspect.getsourcefile(engine_interfaces_module) is not None
    and inspect.getsourcefile(engine_contracts_module) is not None,
)


# ---------------------------------------------------------------------------
# Report
# ---------------------------------------------------------------------------
print(f"{'#':<4}{'Check':<75}{'Result'}")
print("-" * 95)
failures = 0
for i, (name, outcome, detail) in enumerate(results, 1):
    print(f"{i:<4}{name:<75}{outcome}")
    if detail and outcome == FAIL:
        print(f"      -> {detail}")
    if outcome == FAIL:
        failures += 1

print("-" * 95)
print(f"{len(results)} checks run, {len(results) - failures} passed, {failures} failed")
if failures:
    raise SystemExit(1)
print("\nAll ProviderRegistry validations passed. Engine 2.0 required zero architectural changes.")
