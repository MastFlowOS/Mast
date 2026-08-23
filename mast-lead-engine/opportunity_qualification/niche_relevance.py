"""
opportunity_qualification/niche_relevance.py
============================================

MAST Engine V2 — Deterministic Niche & Category Relevance Evaluator.

Responsibility
--------------
Evaluates whether a candidate business matches the requested niche,
distinguishing between:
1. CLEAR MATCH      -> "match" (PASS)
2. CLEAR MISMATCH   -> "mismatch" (REJECT)
3. AMBIGUOUS/UNKNOWN -> "ambiguous" (KEEP)

Design Rules:
- Deterministic normalized matching (lowercase, trim whitespace, normalize separators).
- Uses allowed category families for known product niches.
- Conservative matching: ambiguous/missing categories or niches NEVER cause a rejection.
- Clear mismatch requires an observed category belonging to a known disjoint domain
  without any compensating niche signals in the business name.
- No external APIs, no LLMs, zero non-deterministic heuristics.
"""

from __future__ import annotations

import re
from typing import Dict, FrozenSet, Literal, Optional, Set, Tuple

NicheRelevanceResult = Literal["match", "mismatch", "ambiguous"]

# Separator and punctuation cleaner regex
_CLEAN_RE = re.compile(r"[_\-/,+&().'\"|\\]+")
_SPACE_RE = re.compile(r"\s+")


def normalize_category_string(text: Optional[str]) -> str:
    """
    Normalizes a category or niche string into a clean lowercase space-separated string.
    Handles OSM tag syntax like 'amenity=cafe' by converting '=' to space.
    """
    if not text:
        return ""
    # Convert '=' to space (e.g. amenity=cafe -> amenity cafe)
    cleaned = text.replace("=", " ")
    cleaned = _CLEAN_RE.sub(" ", cleaned)
    cleaned = _SPACE_RE.sub(" ", cleaned).strip().lower()
    return cleaned


# ---------------------------------------------------------------------------
# Allowed category families for standard MAST niches.
# Each entry contains normalized keywords/tokens that confirm a match.
# ---------------------------------------------------------------------------
NICHE_ALLOWED_FAMILIES: Dict[str, FrozenSet[str]] = {
    "coffee_shop": frozenset({
        "coffee", "cafe", "café", "espresso", "roaster", "roasters", "roastery",
        "coffee roaster", "coffee roasters", "coffee shop", "coffee store",
        "coffee stand", "bakery cafe", "tea", "tea room", "tea house",
        "tea coffee", "bistro", "donut", "doughnut", "bagel", "pastry",
        "breakfast", "internet cafe", "amenity cafe", "juice bar", "bubble tea",
    }),
    "bakery": frozenset({
        "bakery", "pastry", "bakehouse", "patisserie", "cake", "cupcake",
        "donut", "doughnut", "bread", "shop bakery", "bakery cafe",
        "dessert", "pie", "cookie", "confectionery",
    }),
    "restaurant": frozenset({
        "restaurant", "diner", "eatery", "bistro", "grill", "brasserie",
        "pizzeria", "steakhouse", "seafood", "taco", "burger", "noodle",
        "sushi", "ramen", "amenity restaurant", "food", "gastropub", "buffet",
        "cafe", "café", "bar & grill",
    }),
    "bar_lounge": frozenset({
        "bar", "pub", "lounge", "cocktail", "tavern", "brewery", "taproom",
        "speakeasy", "wine bar", "beer bar", "amenity bar", "amenity pub",
        "nightclub", "gastropub",
    }),
    "dental": frozenset({
        "dentist", "dental", "orthodontist", "periodontist", "endodontist",
        "oral surgeon", "teeth", "amenity dentist", "dental clinic", "dental office",
    }),
    "pharmacy": frozenset({
        "pharmacy", "chemist", "drugstore", "apothecary", "amenity pharmacy", "dispensary",
    }),
    "medical_clinic": frozenset({
        "medical", "clinic", "doctor", "physician", "health", "hospital",
        "pediatric", "urgent care", "amenity doctors", "amenity clinic", "healthcare",
    }),
    "chiropractic": frozenset({
        "chiropractor", "chiropractic", "spine", "physical therapy", "physiotherapy",
    }),
    "optometry": frozenset({
        "optometrist", "optometry", "eye care", "ophthalmologist", "optical", "eyewear",
    }),
    "veterinary": frozenset({
        "veterinarian", "veterinary", "animal hospital", "vet", "pet clinic",
        "amenity veterinary", "pet care",
    }),
    "hair_salon": frozenset({
        "hair salon", "hairdresser", "barbershop", "barber", "hair", "beauty salon",
        "hair stylist", "shop hairdresser", "salon", "hair care",
    }),
    "nail_salon": frozenset({
        "nail salon", "nails", "manicure", "pedicure", "beauty salon", "nail spa",
    }),
    "spa_wellness": frozenset({
        "spa", "day spa", "massage", "wellness", "massage therapist", "sauna",
        "facial", "beauty salon",
    }),
    "tattoo_studio": frozenset({
        "tattoo", "tattoo shop", "tattoo artist", "body piercing", "piercing",
    }),
    "fitness": frozenset({
        "gym", "fitness", "health club", "crossfit", "yoga", "pilates",
        "martial arts", "personal trainer", "boxing", "leisure fitness centre",
        "sports club", "training", "athletic club",
    }),
    "plumbing": frozenset({
        "plumber", "plumbing", "drain", "sewer", "trade plumber", "plumbing contractor",
        "shop trade", "leak", "pipe",
    }),
    "electrician": frozenset({
        "electrician", "electrical", "electrical contractor", "trade electrician",
    }),
    "hvac": frozenset({
        "hvac", "air conditioning", "heating", "cooling", "furnace", "trade hvac",
    }),
    "auto_repair": frozenset({
        "auto repair", "car repair", "mechanic", "auto service", "brake",
        "oil change", "transmission", "tire shop", "auto body", "car service",
        "amenity car repair", "shop car repair", "automotive",
    }),
    "landscaping": frozenset({
        "landscaping", "lawn care", "gardener", "tree service", "landscape",
    }),
    "cleaning_service": frozenset({
        "cleaning", "house cleaning", "janitorial", "maid service", "carpet cleaning",
    }),
    "construction": frozenset({
        "construction", "general contractor", "builder", "remodeling", "roofing", "carpenter",
    }),
    "law_firm": frozenset({
        "lawyer", "attorney", "law firm", "legal services", "office lawyer", "legal",
    }),
    "accounting": frozenset({
        "accountant", "accounting", "cpa", "tax preparation", "bookkeeping", "office accountant",
    }),
    "real_estate": frozenset({
        "real estate", "realtor", "real estate agency", "property management", "office estate agent",
    }),
    "florist": frozenset({
        "florist", "flower shop", "flowers", "shop florist", "floral",
    }),
    "bookshop": frozenset({
        "bookstore", "book shop", "books", "shop books",
    }),
    "photography": frozenset({
        "photographer", "photography", "photo studio", "portrait",
    }),
}


# Mapping alias requested niche names to the canonical niche key
NICHE_ALIASES: Dict[str, str] = {
    "coffee shop": "coffee_shop",
    "coffee": "coffee_shop",
    "cafe": "coffee_shop",
    "café": "coffee_shop",
    "bakery": "bakery",
    "restaurant": "restaurant",
    "bar": "bar_lounge",
    "bar & lounge": "bar_lounge",
    "bar_lounge": "bar_lounge",
    "pub": "bar_lounge",
    "dentist": "dental",
    "dental": "dental",
    "pharmacy": "pharmacy",
    "medical clinic": "medical_clinic",
    "medical": "medical_clinic",
    "doctor": "medical_clinic",
    "chiropractic": "chiropractic",
    "chiropractor": "chiropractic",
    "optometry": "optometry",
    "optometrist": "optometry",
    "veterinary": "veterinary",
    "vet": "veterinary",
    "hair salon": "hair_salon",
    "barbershop": "hair_salon",
    "hair": "hair_salon",
    "nail salon": "nail_salon",
    "spa": "spa_wellness",
    "spa & wellness": "spa_wellness",
    "tattoo": "tattoo_studio",
    "tattoo studio": "tattoo_studio",
    "gym": "fitness",
    "fitness": "fitness",
    "fitness studio": "fitness",
    "yoga studio": "fitness",
    "pilates studio": "fitness",
    "crossfit": "fitness",
    "personal trainer": "fitness",
    "plumbing": "plumbing",
    "plumber": "plumbing",
    "electrician": "electrician",
    "hvac": "hvac",
    "auto repair": "auto_repair",
    "mechanic": "auto_repair",
    "landscaping": "landscaping",
    "cleaning service": "cleaning_service",
    "construction": "construction",
    "law firm": "law_firm",
    "lawyer": "law_firm",
    "accounting": "accounting",
    "cpa": "accounting",
    "real estate": "real_estate",
    "florist": "florist",
    "bookshop": "bookshop",
    "photography": "photography",
}


# ---------------------------------------------------------------------------
# Disjoint Industry Domains
# Used to reliably detect CLEAR MISMATCHES without false rejections on ambiguous cases.
# ---------------------------------------------------------------------------
INDUSTRY_DOMAINS: Dict[str, FrozenSet[str]] = {
    "food_and_beverage": frozenset({
        "coffee", "cafe", "café", "espresso", "roaster", "bakery", "restaurant",
        "diner", "bistro", "pizzeria", "bar", "pub", "tavern", "brewery",
        "taproom", "eatery", "pastry", "donut", "bagel", "patisserie",
    }),
    "medical_and_health": frozenset({
        "pharmacy", "chemist", "drugstore", "dentist", "dental", "orthodontist",
        "doctor", "physician", "medical", "clinic", "hospital", "chiropractor",
        "optometrist", "optometry", "apothecary",
    }),
    "beauty_and_grooming": frozenset({
        "hair salon", "hairdresser", "barbershop", "barber", "nail salon",
        "nails", "spa", "day spa", "tattoo", "massage",
    }),
    "automotive_and_mechanical": frozenset({
        "auto repair", "car repair", "mechanic", "auto parts", "mechanical parts",
        "car dealer", "car wash", "auto body", "tire shop", "oil change",
        "brake shop", "transmission", "automotive",
    }),
    "construction_and_trades": frozenset({
        "plumber", "plumbing", "electrician", "hvac", "roofing", "general contractor",
        "carpenter", "landscaping", "masonry",
    }),
    "legal_and_financial": frozenset({
        "lawyer", "attorney", "law firm", "legal services", "accountant", "accounting",
        "cpa", "tax preparation", "bank", "mortgage broker", "insurance agency",
    }),
    "real_estate_and_housing": frozenset({
        "real estate agency", "real estate agent", "realtor", "property management",
    }),
    "veterinary_and_pets": frozenset({
        "veterinarian", "veterinary", "animal hospital", "pet store", "dog groomer",
    }),
}


def _get_niche_domain(canonical_niche: str) -> Optional[str]:
    """Identify which broad industry domain a canonical niche belongs to."""
    if canonical_niche in ("coffee_shop", "bakery", "restaurant", "bar_lounge"):
        return "food_and_beverage"
    if canonical_niche in ("dental", "pharmacy", "medical_clinic", "chiropractic", "optometry"):
        return "medical_and_health"
    if canonical_niche in ("hair_salon", "nail_salon", "spa_wellness", "tattoo_studio"):
        return "beauty_and_grooming"
    if canonical_niche in ("auto_repair",):
        return "automotive_and_mechanical"
    if canonical_niche in ("plumbing", "electrician", "hvac", "construction", "landscaping"):
        return "construction_and_trades"
    if canonical_niche in ("law_firm", "accounting"):
        return "legal_and_financial"
    if canonical_niche in ("real_estate",):
        return "real_estate_and_housing"
    if canonical_niche in ("veterinary",):
        return "veterinary_and_pets"
    return None


def _get_category_domain(normalized_category: str) -> Optional[str]:
    """Check if normalized category matches any known domain keywords."""
    for domain_name, keywords in INDUSTRY_DOMAINS.items():
        for kw in keywords:
            if kw in normalized_category:
                return domain_name
    return None


# Generic category terms that are not informative enough to reject on
_GENERIC_CATEGORIES = frozenset({
    "point of interest", "establishment", "store", "commercial", "business",
    "shop", "service", "office", "facility", "venue", "place", "location",
    "building", "organization", "company", "retail",
})


def evaluate_niche_relevance(
    requested_niche: Optional[str],
    category: Optional[str],
    name: Optional[str] = None,
) -> Tuple[NicheRelevanceResult, str]:
    """
    Evaluates whether a candidate business matches the requested niche.

    Returns
    -------
    (result, detail_reason)
        result: 'match' | 'mismatch' | 'ambiguous'
        detail_reason: explanation for the evaluation
    """
    # 1. Missing requested_niche -> Ambiguous / Keep (legacy compatibility)
    if not requested_niche or not requested_niche.strip():
        return "ambiguous", "missing_requested_niche"

    norm_niche = normalize_category_string(requested_niche)
    if not norm_niche:
        return "ambiguous", "empty_requested_niche"

    # Resolve canonical niche key
    canonical_niche = NICHE_ALIASES.get(norm_niche, norm_niche.replace(" ", "_"))

    norm_name = normalize_category_string(name)
    norm_category = normalize_category_string(category)

    # 2. Missing category -> Check name for positive match, otherwise Ambiguous (DO NOT reject)
    if not norm_category:
        allowed_family = NICHE_ALLOWED_FAMILIES.get(canonical_niche)
        if allowed_family and norm_name:
            if any(term in norm_name for term in allowed_family):
                return "match", "name_keyword_match_no_category"
        return "ambiguous", "missing_category"

    # 3. Generic category -> Ambiguous / Keep
    if norm_category in _GENERIC_CATEGORIES:
        return "ambiguous", "generic_category"

    # 4. Check Allowed Family (Clear Positive Match)
    allowed_family = NICHE_ALLOWED_FAMILIES.get(canonical_niche)
    if allowed_family:
        for allowed_term in allowed_family:
            if allowed_term in norm_category or norm_category in allowed_term:
                return "match", f"category_family_match:{allowed_term}"

    # Check direct substring matching between niche and category
    if norm_niche in norm_category or norm_category in norm_niche:
        return "match", "direct_niche_category_match"

    # 5. Check Name for Positive Keyword Fallback
    if allowed_family and norm_name:
        if any(term in norm_name for term in allowed_family):
            return "match", "name_keyword_fallback_match"

    # 6. Check for Clear Domain Disjointness (Clear Mismatch)
    niche_domain = _get_niche_domain(canonical_niche)
    category_domain = _get_category_domain(norm_category)

    if niche_domain is not None and category_domain is not None and niche_domain != category_domain:
        # Category belongs to a known distinct domain and name doesn't match
        return "mismatch", f"domain_mismatch:{niche_domain}_vs_{category_domain}"

    # Explicit known mismatch pairs for common disjoint terms (e.g. mechanical parts, auto repair vs coffee)
    if canonical_niche == "coffee_shop":
        disjoint_keywords = (
            "pharmacy", "chemist", "auto repair", "mechanic", "mechanical parts",
            "car repair", "plumber", "plumbing", "dentist", "dental", "lawyer",
            "attorney", "accountant", "cpa", "chiropractor", "optometrist",
            "veterinarian", "hardware store", "gas station", "locksmith",
        )
        if any(dk in norm_category for dk in disjoint_keywords):
            return "mismatch", f"explicit_disjoint_category:{norm_category}"

    # 7. Unclassified / Ambiguous Category -> AMBIGUOUS (DO NOT reject)
    return "ambiguous", f"unclassified_category:{norm_category}"
