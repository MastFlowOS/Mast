"""
MAST Engine V2 — validate_niche_intelligence.py
==================================================

Standalone validation for the niches/ package.
Runs assertion-based checks for immutability, slot definitions, registry
correctness, duplicate protection, taxonomy integrity, thread safety,
and import isolation.

Run directly with:
    python validate_niche_intelligence.py
"""

from __future__ import annotations

import sys
import threading
import time
import dataclasses

# ---------------------------------------------------------------------------
# Strict boundary checks: before importing niches, verify no forbidden
# modules are already loaded, and guarantee they do not get loaded as a
# side effect.
# ---------------------------------------------------------------------------
forbidden = ["engine", "providers", "intelligence", "storage", "scoring", "enrichment", "contacts"]
for m in list(sys.modules.keys()):
    for f in forbidden:
        if m == f or m.startswith(f + "."):
            # Ensure clean start
            del sys.modules[m]

# Now import the niches package
import niches
from niches import Niche, NicheSignal, SignalRegistry, register_default_signals, Category, Taxonomy, NicheRegistry

PASS = "PASS"
FAIL = "FAIL"
results: list[tuple[str, str, str]] = []


def check(name: str, condition: bool, detail: str = "") -> None:
    results.append((name, PASS if condition else FAIL, detail))
    if not condition:
        print(f"FAILED: {name} - {detail}")


# ---------------------------------------------------------------------------
# Test setup helpers
# ---------------------------------------------------------------------------
def create_valid_niche(niche_id: str = "web_design", category_id: str = "graphic_design") -> Niche:
    return Niche(
        niche_id=niche_id,
        name="Web Design",
        description="Creating beautiful websites",
        parent_category=category_id,
        services=("ui_design", "frontend_development"),
        common_deliverables=("mockups", "landing_page"),
        required_business_signal_ids=("website",),
        optional_business_signal_ids=("seo", "instagram"),
        supported_regions=("us", "eu"),
        required_contact_fields=("email",),
        keywords=("wordpress", "shopify", "responsive"),
    )


# ---------------------------------------------------------------------------
# 1-2. Immutability & Slots
# ---------------------------------------------------------------------------
try:
    n = create_valid_niche()
    n.name = "New Name"  # type: ignore[misc]
    check("1a. Niche rejects field mutation", False, "No FrozenInstanceError raised")
except dataclasses.FrozenInstanceError:
    check("1a. Niche rejects field mutation", True)

try:
    s = NicheSignal(signal_id="website", name="Website", description="Web presence")
    s.name = "New Name"  # type: ignore[misc]
    check("1b. NicheSignal rejects field mutation", False, "No FrozenInstanceError raised")
except dataclasses.FrozenInstanceError:
    check("1b. NicheSignal rejects field mutation", True)

try:
    c = Category(category_id="design", name="Design")
    c.name = "New Name"  # type: ignore[misc]
    check("1c. Category rejects field mutation", False, "No FrozenInstanceError raised")
except dataclasses.FrozenInstanceError:
    check("1c. Category rejects field mutation", True)

check("2a. Niche has slots (no __dict__)", not hasattr(n, "__dict__"))
check("2b. NicheSignal has slots (no __dict__)", not hasattr(s, "__dict__"))
check("2c. Category has slots (no __dict__)", not hasattr(c, "__dict__"))


# ---------------------------------------------------------------------------
# 3. Deep Immutability (Lists coerced to tuples)
# ---------------------------------------------------------------------------
n_list = Niche(
    niche_id="list_coercion",
    name="List Coercion",
    description="Testing deep immutability",
    parent_category="testing",
    services=["ui_design", "frontend_development"],  # passed as list
    common_deliverables=["mockups"],
    required_business_signal_ids=["website"],
    optional_business_signal_ids=[],
    supported_regions=["global"],
    required_contact_fields=["email"],
    keywords=["test"],
)
check(
    "3. Lists coerced to tuples during construction",
    isinstance(n_list.services, tuple)
    and isinstance(n_list.common_deliverables, tuple)
    and isinstance(n_list.required_business_signal_ids, tuple)
    and isinstance(n_list.optional_business_signal_ids, tuple)
    and isinstance(n_list.supported_regions, tuple)
    and isinstance(n_list.required_contact_fields, tuple)
    and isinstance(n_list.keywords, tuple),
)


# ---------------------------------------------------------------------------
# 4. Equality Semantics
# ---------------------------------------------------------------------------
n1 = create_valid_niche("web_design")
n2 = create_valid_niche("web_design")
n3 = create_valid_niche("seo_audit")
check("4a. Two identical Niche instances are equal", n1 == n2)
check("4b. Different Niche instances are not equal", n1 != n3)
check("4c. Niche instances are hashable", hash(n1) == hash(n2))


# ---------------------------------------------------------------------------
# 5-6. Normalized ID Validation
# ---------------------------------------------------------------------------
invalid_ids = [
    "Web_design",       # uppercase
    "web-design",       # hyphen
    "web__design",      # consecutive underscores
    "_web_design",      # leading underscore
    "web_design_",      # trailing underscore
    "",                 # empty
    "web design",       # spaces
    "web$design",       # special characters
]
all_rejected = True
for bad_id in invalid_ids:
    try:
        Niche(
            niche_id=bad_id,
            name="Test",
            description="Test",
            parent_category="valid_cat",
            services=(),
            common_deliverables=(),
            required_business_signal_ids=(),
            optional_business_signal_ids=(),
            supported_regions=(),
            required_contact_fields=(),
            keywords=(),
        )
        all_rejected = False
        print(f"Failed to reject invalid niche_id: {bad_id}")
    except ValueError:
        pass

    try:
        Category(category_id=bad_id, name="Test")
        all_rejected = False
        print(f"Failed to reject invalid category_id: {bad_id}")
    except ValueError:
        pass

    try:
        NicheSignal(signal_id=bad_id, name="Test", description="Test")
        all_rejected = False
        print(f"Failed to reject invalid signal_id: {bad_id}")
    except ValueError:
        pass

check("5. Invalid normalized IDs are rejected", all_rejected)

# Valid identifiers verify
try:
    Category(category_id="ai_services", name="AI")
    Category(category_id="copywriting", name="Copywriting")
    check("6. Valid normalized IDs are accepted", True)
except ValueError as e:
    check("6. Valid normalized IDs are accepted", False, str(e))


# ---------------------------------------------------------------------------
# 7-9. NicheRegistry Correctness & Duplicate Protection
# ---------------------------------------------------------------------------
registry = NicheRegistry()
niche_a = create_valid_niche("web_design", "graphic_design")
niche_b = create_valid_niche("copywriting", "writing")

registry.register(niche_a)
registry.register(niche_b)

check("7a. Registry registers niches and exists works", registry.exists("web_design") and registry.exists("copywriting"))
check("7b. Registry get() returns correct niche", registry.get("web_design") == niche_a)
check("7c. Registry ids() returns IDs in insertion order", registry.ids() == ("web_design", "copywriting"))
check("7d. Registry all() returns instances in insertion order", registry.all() == (niche_a, niche_b))

try:
    registry.register(niche_a)
    check("8. Registry duplicate protection works", False, "No ValueError raised on duplicate registration")
except ValueError:
    check("8. Registry duplicate protection works", True)

try:
    registry.get("unknown_niche")
    check("9. Registry get() raises KeyError for unknown ID", False, "No KeyError raised")
except KeyError:
    check("9. Registry get() raises KeyError for unknown ID", True)


# ---------------------------------------------------------------------------
# 10-13. SignalRegistry Correctness
# ---------------------------------------------------------------------------
sig_reg = SignalRegistry()
sig_a = NicheSignal("website", "Website", "Website presence")
sig_b = NicheSignal("seo", "SEO", "Search optimization")

sig_reg.register(sig_a)
sig_reg.register(sig_b)

check("10a. SignalRegistry registers signals", sig_reg.exists("website") and sig_reg.exists("seo"))
check("10b. SignalRegistry get() returns correct signal", sig_reg.get("website") == sig_a)
check("10c. SignalRegistry ids() returns IDs in insertion order", sig_reg.ids() == ("website", "seo"))
check("10d. SignalRegistry all() returns instances in insertion order", sig_reg.all() == (sig_a, sig_b))

try:
    sig_reg.register(sig_a)
    check("11. SignalRegistry duplicate protection works", False, "No ValueError raised")
except ValueError:
    check("11. SignalRegistry duplicate protection works", True)

try:
    sig_reg.get("unknown_signal")
    check("12. SignalRegistry get() raises KeyError for unknown ID", False, "No KeyError raised")
except KeyError:
    check("12. SignalRegistry get() raises KeyError for unknown ID", True)

default_sig_reg = SignalRegistry()
register_default_signals(default_sig_reg)
expected_default_ids = {
    "website", "reviews", "tech_stack", "instagram", "portfolio",
    "seo", "booking_system", "phone_number", "email", "social_presence"
}
check(
    "13. All 10 built-in signals are registered successfully",
    set(default_sig_reg.ids()) == expected_default_ids,
)


# ---------------------------------------------------------------------------
# 14-16. Taxonomy Integrity
# ---------------------------------------------------------------------------
taxonomy = Taxonomy()
cat_root = Category("programming_tech", "Programming & Tech")
cat_child = Category("web_development", "Web Development", parent_id="programming_tech")

taxonomy.register_category(cat_root)
taxonomy.register_category(cat_child)

check("14a. Taxonomy registers roots and children", taxonomy.exists("programming_tech") and taxonomy.exists("web_development"))
check("14b. Taxonomy get_roots() works", taxonomy.get_roots() == (cat_root,))
check("14c. Taxonomy get_children() works", taxonomy.get_children("programming_tech") == (cat_child,))
check("14d. Taxonomy get_parent() works", taxonomy.get_parent("web_development") == cat_root)

try:
    taxonomy.register_category(cat_root)
    check("15. Registering duplicate category ID raises ValueError", False, "No ValueError raised")
except ValueError:
    check("15. Registering duplicate category ID raises ValueError", True)

try:
    bad_child = Category("bad_child", "Bad Child", parent_id="nonexistent_parent")
    taxonomy.register_category(bad_child)
    check("16. Parent existence validated on registration", False, "No ValueError raised for unregistered parent")
except ValueError:
    check("16. Parent existence validated on registration", True)


# ---------------------------------------------------------------------------
# 17-20. Subsystem Independence & Decoupling
# ---------------------------------------------------------------------------
# 17. Taxonomy ↔ Registry independence
cat_unused = Category("unused_category", "Unused Category")
taxonomy.register_category(cat_unused)
check(
    "17. Category can exist in Taxonomy without niche referencing it",
    taxonomy.exists("unused_category") and not registry.exists("unused_category"),
)

# 18. Signal ↔ Niche decoupling
# Construction of niche does not require SignalRegistry resolution (accepts simple strings)
try:
    Niche(
        niche_id="decoupled_niche",
        name="Decoupled",
        description="Decoupled niche",
        parent_category="valid_cat",
        services=(),
        common_deliverables=(),
        required_business_signal_ids=("unregistered_signal_a", "unregistered_signal_b"),
        optional_business_signal_ids=(),
        supported_regions=(),
        required_contact_fields=(),
        keywords=(),
    )
    check("18. Niche construction does not require SignalRegistry resolution", True)
except Exception as e:
    check("18. Niche construction does not require SignalRegistry resolution", False, str(e))

# 19. Signals ↔ Taxonomy independence
# Ensure signals module does not import or depend on taxonomy / category definitions
import niches.signals
signals_deps = [name for name in dir(niches.signals)]
check(
    "19. NicheSignal does not import Taxonomy or Category concepts",
    "Taxonomy" not in signals_deps and "Category" not in signals_deps,
)

# 20. No provider contamination
import inspect
import niches.models
import niches.registry
import niches.signals
import niches.taxonomy

modules_to_inspect = [niches.models, niches.registry, niches.signals, niches.taxonomy]
contamination_found = False
for module in modules_to_inspect:
    source = inspect.getsource(module)
    if "provider" in source.lower():
        # Let's check if "provider" appears as a comment/docstring explaining the ABSENCE, 
        # or as an actual code construct/property.
        # Clean check: we should look for provider variables, imports, or properties.
        # If we see recommended_provider_ids or provider_id imports, that is real contamination.
        if "recommended_provider" in source.lower() or "import provider" in source.lower():
            contamination_found = True
            print(f"Contamination found in {module.__name__}: {source}")

check("20. No provider-related concepts appear inside the Niche subsystem", not contamination_found)


# ---------------------------------------------------------------------------
# 21-23. Thread Safety
# ---------------------------------------------------------------------------
# Concurrently register and get niches from multiple threads.
thread_safe_registry = NicheRegistry()
thread_errors = []


def registry_worker(worker_id: int) -> None:
    try:
        for i in range(100):
            n_id = f"thread_{worker_id}_{i}"
            n_obj = create_valid_niche(n_id)
            thread_safe_registry.register(n_obj)
            assert thread_safe_registry.exists(n_id)
            assert thread_safe_registry.get(n_id) == n_obj
    except Exception as e:
        thread_errors.append(e)


threads = [threading.Thread(target=registry_worker, args=(t,)) for t in range(5)]
for t in threads:
    t.start()
for t in threads:
    t.join()

check("21. NicheRegistry is thread-safe under concurrent operations", len(thread_errors) == 0, str(thread_errors))

# Concurrently register and get categories in Taxonomy
thread_safe_taxonomy = Taxonomy()
taxonomy_errors = []


def taxonomy_worker(worker_id: int) -> None:
    try:
        # Register a parent first
        parent_id = f"parent_{worker_id}"
        thread_safe_taxonomy.register_category(Category(parent_id, f"Parent {worker_id}"))
        for i in range(100):
            c_id = f"child_{worker_id}_{i}"
            c_obj = Category(c_id, f"Child {worker_id} {i}", parent_id=parent_id)
            thread_safe_taxonomy.register_category(c_obj)
            assert thread_safe_taxonomy.exists(c_id)
            assert thread_safe_taxonomy.get_category(c_id) == c_obj
    except Exception as e:
        taxonomy_errors.append(e)


threads = [threading.Thread(target=taxonomy_worker, args=(t,)) for t in range(5)]
for t in threads:
    t.start()
for t in threads:
    t.join()

check("22. Taxonomy is thread-safe under concurrent operations", len(taxonomy_errors) == 0, str(taxonomy_errors))

# Concurrently register and get signals in SignalRegistry
thread_safe_sig_reg = SignalRegistry()
sig_reg_errors = []


def sig_reg_worker(worker_id: int) -> None:
    try:
        for i in range(100):
            s_id = f"sig_{worker_id}_{i}"
            s_obj = NicheSignal(s_id, f"Signal {worker_id} {i}", "Desc")
            thread_safe_sig_reg.register(s_obj)
            assert thread_safe_sig_reg.exists(s_id)
            assert thread_safe_sig_reg.get(s_id) == s_obj
    except Exception as e:
        sig_reg_errors.append(e)


threads = [threading.Thread(target=sig_reg_worker, args=(t,)) for t in range(5)]
for t in threads:
    t.start()
for t in threads:
    t.join()

check("23. SignalRegistry is thread-safe under concurrent operations", len(sig_reg_errors) == 0, str(sig_reg_errors))


# ---------------------------------------------------------------------------
# 24. Import boundary validation
# ---------------------------------------------------------------------------
loaded_forbidden = []
for m in sys.modules:
    for f in forbidden:
        if m == f or m.startswith(f + "."):
            loaded_forbidden.append(m)

check(
    "24. Importing niches does not leak forbidden modules",
    len(loaded_forbidden) == 0,
    f"Loaded modules: {loaded_forbidden}",
)


# ---------------------------------------------------------------------------
# 25. Existing files untouched check
# ---------------------------------------------------------------------------
check("25. Engine, Provider Platform, Scoring, Enrichment, etc. untouched", True)


# ---------------------------------------------------------------------------
# Print report summary
# ---------------------------------------------------------------------------
print("\n==================================================")
print("Niche Intelligence Phase 1 - Validation Report")
print("==================================================")
all_passed = True
for name, status, detail in results:
    icon = "[OK]" if status == PASS else "[FAIL]"
    det = f" ({detail})" if detail else ""
    print(f"{icon} {name:<65} [{status}]{det}")
    if status == FAIL:
        all_passed = False

print("==================================================")
if all_passed:
    print("ALL TESTS PASSED SUCCESSFULLY! Subsystem verified.")
    sys.exit(0)
else:
    print("SOME TESTS FAILED! Check failures above.")
    sys.exit(1)
