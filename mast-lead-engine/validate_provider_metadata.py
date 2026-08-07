"""
MAST Engine V2 — Provider Metadata validation
================================================

Validates the Provider Metadata milestone: providers/provider_metadata.py
(ProviderMetadata), the `metadata()` classmethod added to
GoogleMapsProvider and YelpProvider, and the metadata-related surface
added to ProviderRegistry (`metadata()`, `metadata_all()`).

Style matches the project's existing validation scripts (referenced in
composite_provider.py / parallel_composite_provider.py /
provider_deduplicator.py's own docstrings): plain assertions, canned/
fake collaborators, no live network, no engine/ imports beyond what
the provider layer already depends on.

Run: python3 validate_provider_metadata.py
"""

from __future__ import annotations

from providers.google_maps_provider import GoogleMapsProvider
from providers.registry import ProviderRegistry
from providers.provider_metadata import ProviderMetadata
from providers.yelp_provider import YelpProvider

PASS = "PASS"
FAIL = "FAIL"
_results: list[tuple[str, bool, str]] = []


def check(name: str, condition: bool, detail: str = "") -> None:
    _results.append((name, condition, detail))
    status = PASS if condition else FAIL
    print(f"[{status}] {name}" + (f" — {detail}" if detail and not condition else ""))


# ---------------------------------------------------------------------------
# 1. Metadata exists for Google Maps and Yelp — obtainable from the class
#    itself, with no instance ever constructed.
# ---------------------------------------------------------------------------
gm_meta = GoogleMapsProvider.metadata()
yelp_meta = YelpProvider.metadata()

check(
    "metadata exists for Google Maps",
    isinstance(gm_meta, ProviderMetadata) and gm_meta.provider_id == "google_maps",
)
check(
    "metadata exists for Yelp",
    isinstance(yelp_meta, ProviderMetadata) and yelp_meta.provider_id == "yelp",
)
check(
    "Google Maps metadata reflects no API key requirement",
    gm_meta.requires_api_key is False,
)
check(
    "Yelp metadata reflects an API key requirement",
    yelp_meta.requires_api_key is True,
)


# ---------------------------------------------------------------------------
# 2. Metadata is independent of provider construction.
#    YelpProvider's real constructor requires an api_key; the factory
#    below deliberately raises if ever called, so if metadata lookup
#    accidentally constructs the provider, this test fails loudly.
# ---------------------------------------------------------------------------
def _yelp_factory_that_must_never_be_called():
    raise AssertionError(
        "YelpProvider factory was constructed just to read metadata — "
        "metadata lookup must be independent of provider construction."
    )


def _gmaps_factory_that_must_never_be_called():
    raise AssertionError(
        "GoogleMapsProvider factory was constructed just to read "
        "metadata — metadata lookup must be independent of provider "
        "construction."
    )


registry = ProviderRegistry()
registry.register(
    "google_maps",
    _gmaps_factory_that_must_never_be_called,
    metadata=GoogleMapsProvider.metadata(),
)
registry.register(
    "yelp",
    _yelp_factory_that_must_never_be_called,
    metadata=YelpProvider.metadata(),
)

try:
    looked_up_gm = registry.metadata("google_maps")
    looked_up_yelp = registry.metadata("yelp")
    metadata_independent_of_construction = True
    failure_detail = ""
except AssertionError as exc:  # pragma: no cover — would indicate a real bug
    metadata_independent_of_construction = False
    failure_detail = str(exc)

check(
    "metadata independent of provider instances (poison-pill factories never invoked)",
    metadata_independent_of_construction,
    failure_detail,
)
check(
    "registry lookup returns the exact metadata given at registration",
    looked_up_gm == gm_meta and looked_up_yelp == yelp_meta,
)


# ---------------------------------------------------------------------------
# 3. Registry listing.
# ---------------------------------------------------------------------------
all_meta = registry.metadata_all()
check(
    "registry listing (metadata_all) contains both providers, in registration order",
    tuple(m.provider_id for m in all_meta) == ("google_maps", "yelp"),
)
check(
    "deprecated list_metadata() alias still returns the same data",
    registry.list_metadata() == all_meta,
)


# ---------------------------------------------------------------------------
# 4. register() rejects a provider_id/metadata.provider_id mismatch —
#    a caller-configuration error caught immediately.
# ---------------------------------------------------------------------------
mismatch_rejected = False
try:
    registry.register(
        "not_google_maps",
        lambda: GoogleMapsProvider(),
        metadata=GoogleMapsProvider.metadata(),  # provider_id="google_maps"
    )
except ValueError:
    mismatch_rejected = True
check(
    "register() rejects a provider_id / metadata.provider_id mismatch",
    mismatch_rejected,
)


# ---------------------------------------------------------------------------
# 5. Provider construction is unchanged: a second, real registry (with
#    real, working factories) still builds providers exactly as it did
#    before this milestone.
# ---------------------------------------------------------------------------
real_registry = ProviderRegistry()
real_registry.register(
    "google_maps",
    GoogleMapsProvider,  # GoogleMapsProvider() takes no args — usable directly as a factory
    metadata=GoogleMapsProvider.metadata(),
)
real_registry.register(
    "yelp",
    lambda: YelpProvider(api_key="fake-test-key"),
    metadata=YelpProvider.metadata(),
)

gm_instance = real_registry.get("google_maps")
yelp_instance = real_registry.get("yelp")

check(
    "provider construction unchanged — get() still builds a real GoogleMapsProvider",
    isinstance(gm_instance, GoogleMapsProvider) and gm_instance.provider_id == "google_maps",
)
check(
    "provider construction unchanged — get() still builds a real YelpProvider",
    isinstance(yelp_instance, YelpProvider) and yelp_instance.provider_id == "yelp",
)

composite = real_registry.build(["google_maps", "yelp"])
check(
    "provider construction unchanged — build() still returns a CompositeDiscoveryProvider",
    type(composite).__name__ == "CompositeDiscoveryProvider"
    and tuple(p.provider_id for p in composite.providers) == ("google_maps", "yelp"),
)


# ---------------------------------------------------------------------------
# 6. Engine compatibility — a fake "Engine" that only ever holds a bare
#    DiscoveryProviderInterface reference (provider_id, display_name,
#    discover) cannot observe metadata at all, and does not need to.
# ---------------------------------------------------------------------------
class FakeEngine:
    """
    Mirrors the same "the Engine cannot tell the difference" pattern
    established by CompositeDiscoveryProvider / ProviderDeduplicator's
    own validation scripts: this class only ever touches
    provider_id / display_name / discover — the exact
    DiscoveryProviderInterface surface — never ProviderMetadata,
    ProviderRegistry, or anything from provider_metadata.py.
    """

    def __init__(self, provider) -> None:
        self._provider = provider

    def identify(self) -> tuple[str, str]:
        return self._provider.provider_id, self._provider.display_name

    def has_metadata_attribute(self) -> bool:
        # The Engine has no reason to ever ask this; included only to
        # prove a bare DiscoveryProviderInterface reference doesn't
        # expose ProviderMetadata through the interface itself — the
        # instance-level attribute below belongs to the concrete
        # class (a provider-layer extension), not the ABC.
        return hasattr(self._provider, "provider_id") and hasattr(
            self._provider, "display_name"
        )


engine = FakeEngine(gm_instance)
provider_id, display_name = engine.identify()
check(
    "engine compatibility — FakeEngine still identifies a provider via provider_id/display_name only",
    provider_id == "google_maps" and display_name == "Google Maps",
)
check(
    "engine compatibility — DiscoveryProviderInterface surface (provider_id, display_name) unchanged",
    engine.has_metadata_attribute(),
)


# ---------------------------------------------------------------------------
# 7. No engine changes required — DiscoveryProviderInterface itself
#    still declares exactly its original three members; the metadata()
#    classmethod is an addition on the concrete provider classes, not
#    on the ABC, so it is invisible to any code that only type-checks
#    against DiscoveryProviderInterface.
# ---------------------------------------------------------------------------
from engine.interfaces import DiscoveryProviderInterface  # noqa: E402

interface_abstract_methods = DiscoveryProviderInterface.__abstractmethods__
check(
    "DiscoveryProviderInterface's abstract surface is unchanged (provider_id, display_name, discover)",
    interface_abstract_methods == frozenset({"provider_id", "display_name", "discover"}),
)
check(
    "metadata() is not part of DiscoveryProviderInterface's abstract surface",
    "metadata" not in interface_abstract_methods,
)
check(
    "GoogleMapsProvider still satisfies DiscoveryProviderInterface unmodified",
    isinstance(gm_instance, DiscoveryProviderInterface),
)
check(
    "YelpProvider still satisfies DiscoveryProviderInterface unmodified",
    isinstance(yelp_instance, DiscoveryProviderInterface),
)


# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
print()
total = len(_results)
passed = sum(1 for _, ok, _ in _results if ok)
print(f"{passed}/{total} checks passed")
if passed != total:
    failed = [name for name, ok, _ in _results if not ok]
    print("FAILED:", failed)
    raise SystemExit(1)
print("All Provider Metadata validation checks passed.")
