"""
MAST Engine V2 — validate_discovery_intelligence.py
======================================================

Standalone validation suite for the discovery/ package.
Runs assertion-based checks for immutability, slot definitions, registry
correctness, duplicate protection, compiler determinism & statelessness,
thread safety, template correctness, and import isolation.

Run directly with:
    python validate_discovery_intelligence.py
"""

from __future__ import annotations

import sys
import threading
import dataclasses
from typing import Sequence

# ---------------------------------------------------------------------------
# Strict boundary checks: before importing discovery, verify no forbidden
# modules are loaded and guarantee strict layer isolation.
# ---------------------------------------------------------------------------
forbidden = [
    "engine",
    "intelligence",
    "storage",
    "database",
    "crm",
    "opportunities",
    "missions",
    "ai",
]
for m in list(sys.modules.keys()):
    for f in forbidden:
        if m == f or m.startswith(f + "."):
            del sys.modules[m]

# Now import the discovery package
import discovery
from discovery import (
    DiscoveryIntent,
    ProviderDiscoveryRequest,
    CompiledDiscovery,
    DiscoveryTemplate,
    register_default_templates,
    DiscoveryTemplateRegistry,
    DiscoveryCompiler,
)

PASS = "PASS"
FAIL = "FAIL"
results: list[tuple[str, str, str]] = []


def check(name: str, condition: bool, detail: str = "") -> None:
    results.append((name, PASS if condition else FAIL, detail))
    if not condition:
        print(f"FAILED: {name} - {detail}")


# ---------------------------------------------------------------------------
# 1-2. Immutability & Slots
# ---------------------------------------------------------------------------
intent = DiscoveryIntent(
    niche_id="web_design",
    city="London",
    country="UK",
    radius_km=25.0,
    keywords=("wordpress", "shopify"),
    requested_providers=("google_maps", "yelp"),
    max_results=50,
)

tmpl = DiscoveryTemplate(
    provider_id="google_maps",
    niche_id="web_design",
    search_phrases=("web design agency",),
)

p_req = ProviderDiscoveryRequest(
    provider_id="google_maps",
    niche_id="web_design",
    query="web design agency in London, UK",
    city="London",
    country="UK",
)

comp = CompiledDiscovery(intent=intent, requests=(p_req,))

# Test field mutation rejection
try:
    intent.city = "Manchester"  # type: ignore[misc]
    check("1a. DiscoveryIntent rejects mutation", False, "No FrozenInstanceError raised")
except dataclasses.FrozenInstanceError:
    check("1a. DiscoveryIntent rejects mutation", True)

try:
    tmpl.provider_id = "other"  # type: ignore[misc]
    check("1b. DiscoveryTemplate rejects mutation", False, "No FrozenInstanceError raised")
except dataclasses.FrozenInstanceError:
    check("1b. DiscoveryTemplate rejects mutation", True)

try:
    p_req.city = "Manchester"  # type: ignore[misc]
    check("1c. ProviderDiscoveryRequest rejects mutation", False, "No FrozenInstanceError raised")
except dataclasses.FrozenInstanceError:
    check("1c. ProviderDiscoveryRequest rejects mutation", True)

try:
    comp.intent = intent  # type: ignore[misc]
    check("1d. CompiledDiscovery rejects mutation", False, "No FrozenInstanceError raised")
except dataclasses.FrozenInstanceError:
    check("1d. CompiledDiscovery rejects mutation", True)

# Test slots (no __dict__)
check("2a. DiscoveryIntent has slots", not hasattr(intent, "__dict__"))
check("2b. DiscoveryTemplate has slots", not hasattr(tmpl, "__dict__"))
check("2c. ProviderDiscoveryRequest has slots", not hasattr(p_req, "__dict__"))
check("2d. CompiledDiscovery has slots", not hasattr(comp, "__dict__"))

# ---------------------------------------------------------------------------
# 3. Deep Immutability (Lists coerced to tuples)
# ---------------------------------------------------------------------------
intent_list = DiscoveryIntent(
    niche_id="web_design",
    keywords=["a", "b"],  # type: ignore[arg-type]
    requested_providers=["google_maps"],  # type: ignore[arg-type]
)
check("3a. DiscoveryIntent coerces keywords list to tuple", isinstance(intent_list.keywords, tuple))
check("3b. DiscoveryIntent coerces requested_providers list to tuple", isinstance(intent_list.requested_providers, tuple))

tmpl_list = DiscoveryTemplate(
    provider_id="yelp",
    niche_id="web_design",
    search_phrases=["phrase1", "phrase2"],  # type: ignore[arg-type]
    category_aliases=["cat1"],  # type: ignore[arg-type]
)
check("3c. DiscoveryTemplate coerces search_phrases list to tuple", isinstance(tmpl_list.search_phrases, tuple))
check("3d. DiscoveryTemplate coerces category_aliases list to tuple", isinstance(tmpl_list.category_aliases, tuple))

# ---------------------------------------------------------------------------
# 4. Registry Correctness & Duplicate Protection
# ---------------------------------------------------------------------------
reg = DiscoveryTemplateRegistry()
register_default_templates(reg)

check("4a. Default templates registered", len(reg.all()) > 0)
check("4b. Registry exists() check", reg.exists("google_maps:web_design"))
check("4c. Registry get() lookup", reg.get("google_maps:web_design").provider_id == "google_maps")

# Duplicate protection test
try:
    reg.register(tmpl)
    check("4d. Duplicate template registration rejected", False, "No ValueError raised")
except ValueError:
    check("4d. Duplicate template registration rejected", True)

# Missing key lookup test
try:
    reg.get("non_existent_id")
    check("4e. Missing key raises KeyError", False, "No KeyError raised")
except KeyError:
    check("4e. Missing key raises KeyError", True)

# ---------------------------------------------------------------------------
# 5. Registry Thread Safety
# ---------------------------------------------------------------------------
ts_reg = DiscoveryTemplateRegistry()
errors: list[Exception] = []


def worker(worker_id: int) -> None:
    try:
        t = DiscoveryTemplate(
            provider_id=f"provider_{worker_id}",
            niche_id="web_design",
            search_phrases=(f"phrase_{worker_id}",),
        )
        ts_reg.register(t)
        _ = ts_reg.get(t.template_id)
        _ = ts_reg.exists(t.template_id)
        _ = ts_reg.all()
    except Exception as e:
        errors.append(e)


threads = [threading.Thread(target=worker, args=(i,)) for i in range(20)]
for th in threads:
    th.start()
for th in threads:
    th.join()

check("5. DiscoveryTemplateRegistry thread safety", len(errors) == 0, f"Errors: {errors}")
check("5b. All threads registered successfully", len(ts_reg.all()) == 20)

# ---------------------------------------------------------------------------
# 6. Compiler Determinism & Statelessness
# ---------------------------------------------------------------------------
compiler = DiscoveryCompiler()

compiled1 = compiler.compile(intent, template_registry=reg)
compiled2 = compiler.compile(intent, template_registry=reg)

check("6a. Compiler produces CompiledDiscovery", isinstance(compiled1, CompiledDiscovery))
check("6b. Compiler is deterministic", compiled1 == compiled2)
check("6c. Compiler respects requested_providers", compiled1.provider_ids == ("google_maps", "yelp"))
check(
    "6d. Compiler produces native request objects",
    all(isinstance(r, ProviderDiscoveryRequest) for r in compiled1.requests),
)

# Test full multi-provider compilation without requested_providers constraint
full_intent = DiscoveryIntent(
    niche_id="web_design",
    city="London",
    radius_km=25.0,
)
compiled_full = compiler.compile(full_intent, template_registry=reg)
check(
    "6e. Default compilation targets all 8 providers",
    len(compiled_full.requests) == 8,
    f"Got providers: {compiled_full.provider_ids}",
)

expected_providers = {
    "google_maps",
    "yelp",
    "apple_maps",
    "overpass",
    "azure_maps",
    "foursquare",
    "crunchbase",
    "apollo",
}
check(
    "6f. All 8 required providers present in compilation",
    set(compiled_full.provider_ids) == expected_providers,
)

# Test provider lookup on CompiledDiscovery
gm_req = compiled_full.get_request("google_maps")
check("6g. CompiledDiscovery.get_request lookup", gm_req.provider_id == "google_maps")

try:
    compiled_full.get_request("unknown_provider")
    check("6h. CompiledDiscovery.get_request raises KeyError", False, "No KeyError raised")
except KeyError:
    check("6h. CompiledDiscovery.get_request raises KeyError", True)

# ---------------------------------------------------------------------------
# 7. Import Isolation & Boundary Verification
# ---------------------------------------------------------------------------
loaded_modules = set(sys.modules.keys())
forbidden_loaded = [
    m for m in loaded_modules if any(m == f or m.startswith(f + ".") for f in forbidden)
]
check("7. Import isolation (no forbidden modules loaded)", len(forbidden_loaded) == 0, f"Forbidden loaded: {forbidden_loaded}")

# Summary
print("\n" + "=" * 60)
print("DISCOVERY INTELLIGENCE PHASE 1 VALIDATION SUMMARY")
print("=" * 60)
passed_count = sum(1 for _, status, _ in results if status == PASS)
failed_count = sum(1 for _, status, _ in results if status == FAIL)

for name, status, detail in results:
    d = f" ({detail})" if detail else ""
    print(f"[{status}] {name}{d}")

print("-" * 60)
print(f"TOTAL: {len(results)} | PASSED: {passed_count} | FAILED: {failed_count}")
print("=" * 60)

if failed_count > 0:
    sys.exit(1)
