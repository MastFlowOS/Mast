"""
Mast Lead Engine — Lead Scoring Engine.

Implements the full 0–100 composite scoring system from the architecture doc.

Score breakdown (100 pts total):
  Website Existence            +10
  Website Quality (AI 1–10)   +12   (rule-based proxy for now)
  Email Available + Validated  +15
  Phone Available + Validated  +8
  Review Count (log-capped)    +8
  Review Rating (4.0+)         +7
  Social Presence (1–3)        +8
  Social Activity (30-day)     +6
  Business Completeness        +6
  Contact Confidence           +5
  Growth Signals               +8
  Professionalism              +7

Deductions:
  Permanently closed           −50
  NXDOMAIN website             −15
  No reviews after 2+ years    −8
  Social inactive 90+ days     −5
  Email hard bounce history    −20
  Cannabis business            −120 (hard disqualify)
  Chain business               −50  (hard disqualify)

Bonuses:
  Popular times data           +3
  Owner responds to reviews    +4
  Recent press mention         +5
  Hiring signal                +6
  Multi-location               +4
  Verified Google profile      +3
"""

from __future__ import annotations

import math
import re
from typing import Any
from urllib.parse import urlparse

from utils.parsing import parse_review_count, is_weak_site, domain_of


# ──────────────────────────────────────────────────────────────────────────────
# Classifier data
# ──────────────────────────────────────────────────────────────────────────────

CHAIN_KEYWORDS = (
    "starbucks", "mcdonald", "burger king", "kfc", "subway",
    "taco bell", "pizza hut", "domino", "dunkin", "tim hortons",
    "costa coffee", "wendy", "chipotle", "panera", "walmart",
    "7-eleven", "circle k", "shell", "exxon", "carrefour", "tesco",
    "ikea", "sephora", "h&m", "zara", "uniqlo", "nike", "adidas",
    "pret a manger", "five guys", "popeyes", "chili's", "applebee",
    "olive garden", "ihop", "denny", "chick-fil-a", "shake shack",
    "krispy kreme", "baskin", "cinnabon", "auntie anne",
    "gloria jean", "coffee bean", "lavazza", "illy caffe",
    "paul bakery", "greggs", "le pain quotidien", "mcdonalds",
    "pizzahut", "pizzaexpress", "nandos", "wagamama",
)

CANNABIS_KEYWORDS = (
    "cannabis", "marijuana", "weed dispensary", "dispensary",
    "coffeeshop", "cannabis café", "cannabis cafe", "cannabis coffee",
    "hash bar", "hash café", "420 café", "420 cafe", "hemp café",
    "cbd café", "cbd cafe", "cbd shop",
)

PREMIUM_NICHES = (
    "café", "cafe", "coffee", "espresso", "roastery", "roaster",
    "specialty coffee", "third wave", "pour over", "cold brew",
    "matcha", "bubble tea", "boba", "tea room", "juice bar",
    "smoothie", "bakery", "patisserie", "boulangerie", "pastry",
    "dessert", "gelato", "ice cream", "brunch", "deli",
    "organic", "vegan", "wine bar", "cocktail", "speakeasy",
    "craft beer", "bistro", "fine dining", "salon", "barber",
    "nail", "lash", "brow", "skincare", "facial", "spa",
    "yoga", "pilates", "barre", "tattoo", "boutique", "atelier",
    "florist", "vintage", "artisan", "candle", "jewellery",
    "jewelry", "fashion", "gallery",
)

AESTHETIC_KEYWORDS = (
    "co.", "& co", "studio", "house", "collective", "workshop",
    "atelier", "lab", "space", "club", "bar", "roastery",
)

# IG follower bands
IG_TINY_MAX = 99
IG_IDEAL_MIN = 100
IG_IDEAL_MAX = 2_000
IG_GROWING_MAX = 5_000


# ──────────────────────────────────────────────────────────────────────────────
# Helper predicates
# ──────────────────────────────────────────────────────────────────────────────

def _safe_float(v: Any) -> float:
    if v is None:
        return 0.0
    try:
        return float(str(v).replace(",", "."))
    except Exception:
        return 0.0


def is_chain(name: str | None) -> bool:
    if not name:
        return False
    low = name.lower()
    return any(c in low for c in CHAIN_KEYWORDS)


def is_cannabis(biz: dict) -> bool:
    haystack = " ".join(
        str(biz.get(k, "")) for k in ("name", "query", "category")
    ).lower()
    return any(kw in haystack for kw in CANNABIS_KEYWORDS)


def is_premium_niche(biz: dict) -> bool:
    haystack = " ".join(
        str(biz.get(k, "")) for k in ("name", "query", "category")
    ).lower()
    return any(kw in haystack for kw in PREMIUM_NICHES)


def has_aesthetic_branding(biz: dict) -> bool:
    haystack = " ".join(
        str(biz.get(k, "")) for k in ("name",)
    ).lower()
    return any(kw in haystack for kw in AESTHETIC_KEYWORDS)


def is_dead_business(biz: dict) -> bool:
    """Return True when a business has zero presence on any channel."""
    return (
        not biz.get("has_photos")
        and not (biz.get("website") or "").strip()
        and not (biz.get("instagram") or "").strip()
        and not (biz.get("facebook") or "").strip()
        and parse_review_count(biz.get("reviews")) == 0
    )


# ──────────────────────────────────────────────────────────────────────────────
# Sub-scores
# ──────────────────────────────────────────────────────────────────────────────

def website_quality_score(biz: dict) -> int:
    """0–100. Higher = stronger site. Lower = more opportunity for us.

    0   → no website (maximum opportunity)
    25  → weak/template platform (wix, linktree, facebook, etc.)
    55+ → real own-domain site
    100 → modern, https, premium TLD, strong signals
    """
    website = (biz.get("website") or "").strip()
    if not website:
        return 0

    if is_weak_site(website):
        return 25

    score = 55

    # HTTPS bonus — ROOT CAUSE fix (I2): previously this was a bare
    # `startswith("https://")` string check, so a site with an expired or
    # self-signed cert, or one that silently downgrades to http, scored as
    # if SSL were fine. `ssl_valid` (set by SiteCrawler._check_ssl, a real
    # certificate probe) is used when we have it; the string check remains
    # only as a fallback for when no crawl was attempted.
    ssl_valid = biz.get("ssl_valid")
    if ssl_valid is True:
        score += 10
    elif ssl_valid is False:
        score -= 15
    elif website.lower().startswith("https://"):
        score += 10

    # Slow-site penalty (I3) — "slow site" is a literal Web Developer
    # opportunity example in the brief; page-load timing is captured for
    # free during the crawl's own goto().
    load_ms = biz.get("load_time_ms")
    if isinstance(load_ms, (int, float)) and load_ms > 4000:
        score -= 10

    # TLD quality
    host = domain_of(website)
    premium_tlds = (".com", ".co", ".io", ".net", ".de", ".fr", ".uk",
                    ".au", ".ca", ".nl", ".se", ".ch", ".ae", ".nz")
    cheap_tlds = (".tk", ".ml", ".ga", ".cf", ".gq", ".info")
    if any(host.endswith(t) for t in premium_tlds):
        score += 10
    if any(host.endswith(t) for t in cheap_tlds):
        score -= 20

    # Custom domain signals
    tech_stack = (biz.get("tech_stack") or {})
    if tech_stack.get("cms") in ("custom", "next.js", "nuxt", "gatsby"):
        score += 10
    elif tech_stack.get("cms") in ("squarespace", "wordpress"):
        score += 5

    return max(0, min(100, score))


def ig_follower_score(biz: dict) -> int:
    """Score contribution from IG follower count.

    None/0      →  0 (neutral)
    1–99        → +5 (brand new, just starting)
    100–2,000   → +25 (ideal sweet spot)
    2,001–5,000 → +15 (growing, still viable)
    5,001+      → +5  (popular but likely too big for us)
    """
    followers = biz.get("ig_followers")
    if followers is None or followers == 0:
        return 0
    if followers <= IG_TINY_MAX:
        return 5
    if followers <= IG_IDEAL_MAX:
        return 25
    if followers <= IG_GROWING_MAX:
        return 15
    # RELIABILITY FIX: accounts above the "growing" band used to be
    # rejected outright by pipeline.py's old hard cap at this same number.
    # They're not auto-discarded anymore — this modest, neutral-ish +5
    # keeps them competitive without pretending they're as ideal a fit as
    # the sweet-spot band above. Only past hard_max_ig_followers (pipeline.py)
    # does an account get rejected, for being genuinely too large for SMB outreach.
    return 5


def social_presence_score(biz: dict) -> int:
    """0–14. Points for number of active social platforms."""
    score = 0
    platforms = [
        bool((biz.get("instagram") or "").strip()),
        bool((biz.get("facebook") or "").strip()),
        bool((biz.get("linkedin") or "").strip()),
        bool((biz.get("tiktok") or "").strip()),
        bool((biz.get("youtube") or "").strip()),
    ]
    active_count = sum(platforms)
    if active_count >= 3:
        score = 14
    elif active_count == 2:
        score = 10
    elif active_count == 1:
        score = 6
    return score


def social_activity_score(biz: dict) -> int:
    """0–6. Points for recent social posting activity."""
    ig_activity = (biz.get("ig_activity") or "").upper()
    days = biz.get("ig_last_post_days")

    if ig_activity == "VERIFIED" and days is not None:
        if days <= 14:
            return 6
        if days <= 30:
            return 5
        if days <= 60:
            return 3
        return 1
    if ig_activity in ("VERIFIED", "ACTIVE"):
        return 3
    if ig_activity == "STALE":
        return 1
    return 0


def review_score(biz: dict) -> int:
    """0–15. Points for review count and rating."""
    score = 0

    # Count (log-scaled, capped at 2,500 — RELIABILITY FIX: this was
    # previously capped at 500, which is also where pipeline.py used to
    # hard-reject, so a business above 500 reviews never even got here.
    # Now that businesses with up to a few thousand reviews are allowed
    # through (see pipeline.py's hard_max_reviews), the cap is raised to
    # match so a legitimately well-reviewed SMB still earns credit here
    # instead of being scored as if it had exactly 500.
    count = min(2500, parse_review_count(biz.get("reviews")))
    if count > 0:
        log_score = math.log10(count + 1) / math.log10(2501)  # 0..1
        score += int(round(log_score * 8))  # 0..8 pts

    # Rating
    rating = _safe_float(biz.get("rating"))
    if rating >= 4.8:
        score += 7
    elif rating >= 4.5:
        score += 6
    elif rating >= 4.2:
        score += 5
    elif rating >= 4.0:
        score += 4
    elif rating >= 3.5:
        score += 2
    elif 0 < rating < 3.0:
        score -= 5  # low rating is a red flag

    return max(0, score)


def contact_confidence_score(biz: dict) -> int:
    """0–100. Measures outreach readiness across verified channels.

    Per the architecture: each channel contributes 25 pts.
    Active IG (+25), own-domain website (+25), domain email (+25), contact form (+25).
    """
    pts = 0

    ig_activity = (biz.get("ig_activity") or "").upper()
    if ig_activity in ("VERIFIED", "ACTIVE"):
        pts += 25
        days = biz.get("ig_last_post_days")
        if days is not None and days <= 30:
            pts += 10  # bonus for recent activity

    website = (biz.get("website") or "").strip()
    if website and not is_weak_site(website):
        pts += 25

    if (biz.get("email") or "").strip():
        pts += 25

    if (biz.get("contact_form") or "").strip():
        pts += 25

    return min(100, pts)


def branding_score(biz: dict) -> int:
    """0–100. Brand investment signals — higher = better outreach target."""
    score = 0

    # Instagram presence
    has_ig = bool((biz.get("instagram") or "").strip())
    if has_ig:
        score += 20
        followers = biz.get("ig_followers")
        if followers is not None:
            if IG_IDEAL_MIN <= followers <= IG_IDEAL_MAX:
                score += 20
            elif followers > IG_IDEAL_MAX:
                score += 10
            elif followers > 0:
                score += 5

        ig_activity = (biz.get("ig_activity") or "").upper()
        if ig_activity in ("VERIFIED", "ACTIVE"):
            score += 10
            days = biz.get("ig_last_post_days")
            if days is not None:
                if days <= 30:
                    score += 10
                elif days <= 60:
                    score += 5
        elif ig_activity == "STALE":
            score -= 10

        legit = biz.get("ig_legitimacy", 0)
        if isinstance(legit, (int, float)) and legit >= 60:
            score += 8

    # Facebook
    if (biz.get("facebook") or "").strip():
        score += 5

    # Photos
    if biz.get("has_photos"):
        score += 20

    # Review quality
    rating = _safe_float(biz.get("rating"))
    if rating >= 4.8:
        score += 20
    elif rating >= 4.5:
        score += 15
    elif rating >= 4.2:
        score += 10
    elif rating >= 4.0:
        score += 5
    elif 0 < rating < 3.5:
        score -= 15

    # Review volume — RELIABILITY FIX: the "still great" band now extends
    # to 2,500 (previously 500), matching pipeline.py's soft threshold; a
    # business with ~800-2,500 reviews is still a genuinely strong SMB
    # opportunity, not something to penalize. Only past 2,500 — approaching
    # the hard_max_reviews reject ceiling — does volume start working
    # against the score, and only mildly.
    reviews = parse_review_count(biz.get("reviews"))
    if 30 <= reviews <= 2500:
        score += 15
    elif 10 <= reviews < 30:
        score += 7
    elif reviews > 2500:
        score -= 5

    # Premium niche
    if is_premium_niche(biz):
        score += 10
    if has_aesthetic_branding(biz):
        score += 5

    return max(0, min(100, score))


def outreach_viability_score(biz: dict) -> int:
    """0–40. Bonus for rich contact coverage."""
    score = 0
    if biz.get("phone"):
        score += 15
    if biz.get("email"):
        score += 10
    if (biz.get("instagram") or "").strip():
        score += 8
    if (biz.get("website") or "").strip():
        score += 7
    if (biz.get("contact_form") or "").strip():
        score += 5
    return min(40, score)


def professionalism_score(biz: dict) -> int:
    """0–7. Professional signals: domain email, press, portfolio."""
    score = 0
    email = (biz.get("email") or "").lower()
    website = (biz.get("website") or "").lower()
    # Domain-matched email (not gmail/hotmail/yahoo)
    free_providers = ("gmail", "yahoo", "hotmail", "outlook", "icloud", "aol")
    if email and "@" in email:
        domain = email.split("@")[1]
        site_domain = domain_of(website)
        if site_domain and (domain == site_domain or domain.endswith("." + site_domain)):
            score += 4
        elif not any(p in domain for p in free_providers):
            score += 2

    # Has website (any)
    if website:
        score += 2

    # Portfolio or press mentions (signals from enrichment)
    if biz.get("has_press_mention"):
        score += 3

    return min(7, score)


def growth_signals_score(biz: dict) -> int:
    """0–8. Points for growth signals that are actually verifiable today.

    ROOT CAUSE fix (audit C3): this used to read `hiring`/`new_location`/
    `recently_rebranded`/`funding` from `growth_signals`, but nothing in the
    engine ever populated ANY of those keys — the score was always 0 and
    `explainOpportunity.ts` narrated that as a confident "no growth signals
    found", when the engine had never actually looked. `hiring` and
    `new_location` are now real, cheap detections from already-fetched HTML
    (see enrichment/site_crawler.py's `_detect_growth_signals`).
    `recently_rebranded` and `funding` are NOT scored here — detecting
    either reliably needs a historical snapshot or a news/press API this
    engine doesn't have; per the brief's "if a signal cannot exist, remove
    it," they're simply absent rather than always contributing zero.
    """
    score = 0
    signals = biz.get("growth_signals") or {}
    if signals.get("hiring"):
        score += 4
    if signals.get("new_location"):
        score += 4
    return min(8, score)


# ──────────────────────────────────────────────────────────────────────────────
# Main composite scorer
# ──────────────────────────────────────────────────────────────────────────────

def calculate_lead_score(biz: dict) -> int:
    """Compute 0–100 composite lead score.

    Formula (architecture doc):
      40% branding strength   (invested brand worth improving)
      40% website weakness    (opportunity = no/weak website)
      20% outreach readiness  (we can contact them)

    Hard disqualifiers are checked first — they return immediately.
    """
    # ── Hard disqualifiers (immediate exit) ──────────────────────────────────
    if is_cannabis(biz):
        return 0
    if is_chain(biz.get("name")):
        return max(0, 20 - 10)  # chains cap at 10

    brand  = branding_score(biz)
    site_q = website_quality_score(biz)
    conf   = contact_confidence_score(biz)

    # Core composite — unclamped to allow modifier headroom
    score = int(round(
        brand  * 0.40
        + (100 - site_q) * 0.40
        + conf  * 0.20
    ))

    # IG follower tier modifier
    score += ig_follower_score(biz)

    # Rating penalties/bonuses
    rating = _safe_float(biz.get("rating"))
    if 0 < rating < 3.0:
        score -= 20
    elif 0 < rating < 3.5:
        score -= 10

    # No photos penalty
    if not biz.get("has_photos"):
        score -= 15

    # Premium niche bonus
    if is_premium_niche(biz):
        score += 8

    # Outreach viability (contact richness)
    score += outreach_viability_score(biz)

    # Growth signals
    score += growth_signals_score(biz)

    # Professionalism
    score += professionalism_score(biz)

    # Google-specific bonuses
    if biz.get("has_popular_times"):
        score += 3
    if biz.get("owner_responds_to_reviews"):
        score += 4
    if biz.get("is_google_verified"):
        score += 3
    if biz.get("multi_location"):
        score += 4

    return max(0, min(100, score))


def score_tier(score: int) -> str:
    """Map numeric score to tier label per architecture spec."""
    if score >= 90:
        return "ELITE"
    if score >= 70:
        return "HOT"
    if score >= 40:
        return "WARM"
    return "COLD"


def lead_quality(score: int) -> str:
    """Legacy 3-tier label (used for output columns)."""
    if score >= 70:
        return "HOT"
    if score >= 50:
        return "WARM"
    return "COLD"


def recommended_action(quality: str) -> str:
    return {
        "HOT":  "PRIORITY — CONTACT FIRST",
        "WARM": "GOOD — CONTACT",
        "COLD": "LOW PRIORITY",
    }.get(quality, "LOW PRIORITY")


# ──────────────────────────────────────────────────────────────────────────────
# Outreach viability gate
# ──────────────────────────────────────────────────────────────────────────────

def passes_outreach_viability(
    biz: dict,
    *,
    min_channels: int = 2,
    require_direct_contact: bool = True,
    require_digital_presence: bool = True,
) -> tuple[bool, str]:
    """Strict outreach gate — must pass to enter the lead pipeline.

    Requires:
      - ≥ min_channels from {phone, email, website, instagram}
      - Phone OR email (direct contact channel)
      - Website OR instagram (digital presence)
    """
    channels = {
        "phone":    bool((biz.get("phone") or "").strip()),
        "email":    bool((biz.get("email") or "").strip() and "@" in (biz.get("email") or "")),
        "website":  bool((biz.get("website") or "").strip()),
        "instagram": bool((biz.get("instagram") or "").strip()),
    }
    core_count = sum(channels.values())

    if require_direct_contact and not (channels["phone"] or channels["email"]):
        return False, "no_direct_contact"

    if require_digital_presence and not (channels["website"] or channels["instagram"]):
        return False, "no_digital_presence"

    if core_count < min_channels:
        return False, f"only_{core_count}_channel"

    return True, ""


# ──────────────────────────────────────────────────────────────────────────────
# Niche keyword bonus
# ──────────────────────────────────────────────────────────────────────────────

def niche_bonus(biz: dict, niche_keywords: list[str]) -> int:
    """Return +12 when the business matches active niche keywords."""
    if not niche_keywords:
        return 0
    haystack = " ".join(
        str(biz.get(k, "")) for k in ("name", "query", "category")
    ).lower()
    return 12 if any(kw in haystack for kw in niche_keywords) else 0
