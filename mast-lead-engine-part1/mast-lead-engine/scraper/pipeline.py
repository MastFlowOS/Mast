"""
Mast Lead Engine — Enrichment Pipeline (Orchestrator).

Connects all enrichment layers and produces final Lead objects ready
for the scoring engine and dedup store.

Pipeline layers (per architecture doc):
  Layer 1 — Maps Extraction       (MapsScraper → RawPlace)
  Layer 2 — Website Crawl         (SiteCrawler → email, social, form, tech)
  Layer 3 — Instagram Intelligence (IGIntelligence → followers, activity)
  Layer 4 — Tech Stack            (embedded in SiteCrawler)
  Layer 5 — Lead Scoring          (Scorer → score, quality, tier)
  Layer 6 — Dedup + Store         (LeadStore → persist)

The pipeline runs Layers 2 and 3 concurrently (asyncio.gather) to maximise
throughput. Layer 3 only runs when an Instagram handle is found in Layer 1
or Layer 2.

Final Lead schema (dict):
  # Identity
  name, address, city, country, query, niche, region

  # Contact channels
  phone, email, website, instagram, facebook, contact_form

  # Google Maps signals
  maps_link, rating, reviews, category, price_range,
  has_photos, has_popular_times, owner_responds_to_reviews,
  is_google_verified, multi_location, closed

  # Instagram enrichment
  ig_followers, ig_posts, ig_following, ig_verified,
  ig_private, ig_blocked, ig_bio, ig_category,
  ig_activity, ig_last_post_days, ig_post_frequency,
  ig_legitimacy, ig_is_business, ig_external_url, ig_email

  # Website enrichment
  tech_stack

  # Scoring (added after pipeline)
  score, quality, tier, action
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from typing import Any

from enrichment.ig_intel import IGIntelligence, bio_contact_hints
from enrichment.site_crawler import SiteCrawler
from scraper.maps_scraper import RawPlace
from scoring.scorer import (
    calculate_lead_score,
    lead_quality,
    score_tier,
    recommended_action,
    passes_outreach_viability,
    is_chain,
    is_cannabis,
)
from storage.dedup import LeadStore
from utils.parsing import (
    pick_best_email,
    pick_best_phone,
    extract_ig_urls,
    is_weak_site,
    domain_of,
)
from utils.runtime import get_logger, ScraperConfig, RunStats

log = get_logger("pipeline")


# ──────────────────────────────────────────────────────────────────────────────
# Lead (final output struct)
# ──────────────────────────────────────────────────────────────────────────────

@dataclass
class Lead:
    """Final, fully-enriched lead ready for scoring and storage."""

    # ── Identity ──────────────────────────────────────────────────────────────
    name: str = ""
    address: str = ""
    city: str = ""
    country: str = ""
    query: str = ""
    niche: str = ""
    region: str = ""

    # ── Contact channels ──────────────────────────────────────────────────────
    phone: str = ""
    email: str = ""
    website: str = ""
    instagram: str = ""
    facebook: str = ""
    contact_form: str = ""

    # ── Google Maps signals ───────────────────────────────────────────────────
    maps_link: str = ""
    rating: float | None = None
    reviews: int = 0
    category: str = ""
    price_range: str = ""
    has_photos: bool = False
    has_popular_times: bool = False
    owner_responds_to_reviews: bool = False
    is_google_verified: bool = False
    multi_location: bool = False
    closed: bool = False

    # ── Instagram enrichment ──────────────────────────────────────────────────
    ig_followers: int | None = None
    ig_posts: int | None = None
    ig_following: int | None = None
    ig_private: bool = False
    ig_blocked: bool = False
    ig_bio: str = ""
    ig_category: str = ""
    ig_activity: str = ""
    ig_last_post_days: int | None = None
    ig_post_frequency: str = ""
    ig_legitimacy: int = 0
    ig_is_business: bool = False
    ig_external_url: str = ""
    ig_email: str = ""

    # ── Website enrichment ────────────────────────────────────────────────────
    tech_stack: dict = field(default_factory=dict)

    # ── Scoring (applied after all enrichment) ────────────────────────────────
    score: int = 0
    quality: str = "COLD"
    tier: str = "COLD"
    action: str = ""

    def to_dict(self) -> dict:
        d = {
            "name": self.name,
            "address": self.address,
            "city": self.city,
            "country": self.country,
            "query": self.query,
            "niche": self.niche,
            "region": self.region,
            "phone": self.phone,
            "email": self.email,
            "website": self.website,
            "instagram": self.instagram,
            "facebook": self.facebook,
            "contact_form": self.contact_form,
            "maps_link": self.maps_link,
            "rating": self.rating,
            "reviews": self.reviews,
            "category": self.category,
            "price_range": self.price_range,
            "has_photos": self.has_photos,
            "has_popular_times": self.has_popular_times,
            "owner_responds_to_reviews": self.owner_responds_to_reviews,
            "is_google_verified": self.is_google_verified,
            "multi_location": self.multi_location,
            "closed": self.closed,
            "ig_followers": self.ig_followers,
            "ig_posts": self.ig_posts,
            "ig_following": self.ig_following,
            "ig_private": self.ig_private,
            "ig_blocked": self.ig_blocked,
            "ig_bio": self.ig_bio,
            "ig_category": self.ig_category,
            "ig_activity": self.ig_activity,
            "ig_last_post_days": self.ig_last_post_days,
            "ig_post_frequency": self.ig_post_frequency,
            "ig_legitimacy": self.ig_legitimacy,
            "ig_is_business": self.ig_is_business,
            "ig_external_url": self.ig_external_url,
            "ig_email": self.ig_email,
            "tech_stack": self.tech_stack,
            "score": self.score,
            "quality": self.quality,
            "tier": self.tier,
            "action": self.action,
        }
        return d


# ──────────────────────────────────────────────────────────────────────────────
# Enrichment pipeline
# ──────────────────────────────────────────────────────────────────────────────

class EnrichmentPipeline:
    """Orchestrates all enrichment layers and produces scored Lead objects.

    Designed to be created once and reused across all places in a run.
    """

    def __init__(
        self,
        config: ScraperConfig,
        browser,
        store: LeadStore | None = None,
        stats: RunStats | None = None,
    ) -> None:
        self.config = config
        self._site_crawler = SiteCrawler(config, browser)
        self._ig_intel = IGIntelligence(config, browser)
        self._store = store or LeadStore()
        self._stats = stats or RunStats()

    async def process(
        self,
        raw: RawPlace,
        *,
        require_viability: bool = True,
        max_ig_followers: int | None = None,
        max_reviews: int | None = None,
    ) -> Lead | None:
        """Run all enrichment layers on a RawPlace.

        Returns:
            A fully scored Lead, or None if:
              - duplicate
              - chain business
              - cannabis business
              - fails outreach viability gate
              - exceeds follower/review limits
        """
        raw_dict = raw.to_dict()
        max_ig = max_ig_followers or self.config.max_ig_followers
        max_rev = max_reviews or self.config.max_reviews

        # ── Pre-flight filters (fast checks before any network I/O) ──────────

        if is_chain(raw.name):
            self._stats.skip("chain_business")
            return None

        if is_cannabis(raw_dict):
            self._stats.skip("cannabis_business")
            return None

        if raw.reviews > max_rev:
            self._stats.skip(f"reviews_>{max_rev}")
            return None

        if raw.closed:
            self._stats.skip("permanently_closed")
            return None

        # ── Dedup check (fast, in-memory) ────────────────────────────────────
        is_dup, keys, matched = self._store.is_duplicate(raw_dict)
        if is_dup:
            self._stats.duplicates += 1
            log.debug(f"[pipeline] DUP {raw.name!r} — matched {matched}")
            return None

        # ── Layer 2 + 3: Website crawl + IG intel (concurrent) ───────────────
        site_data: dict = {}
        ig_data: dict = {}

        tasks: list[asyncio.Task] = []

        if raw.website and not self.config.skip_site_crawl:
            tasks.append(asyncio.create_task(
                self._crawl_site(raw.website),
                name="site_crawl",
            ))
        else:
            tasks.append(asyncio.create_task(
                _noop(),
                name="site_crawl_noop",
            ))

        # Determine IG URL: Maps may already have it, otherwise we'll find it
        # from the site crawl result — handled after merge below
        ig_url_from_maps = raw.extra.get("instagram", "")
        if ig_url_from_maps and not self.config.skip_ig:
            tasks.append(asyncio.create_task(
                self._fetch_ig(ig_url_from_maps),
                name="ig_fetch",
            ))
        else:
            tasks.append(asyncio.create_task(
                _noop(),
                name="ig_fetch_noop",
            ))

        results = await asyncio.gather(*tasks, return_exceptions=True)
        site_data = results[0] if isinstance(results[0], dict) else {}
        ig_data_from_map = results[1] if isinstance(results[1], dict) else {}

        # If site crawl found IG but maps didn't — fetch IG from site
        ig_url_from_site = site_data.get("instagram", "")
        ig_data_from_site: dict = {}
        if (
            ig_url_from_site
            and not ig_url_from_maps
            and not self.config.skip_ig
        ):
            ig_data_from_site = await self._fetch_ig(ig_url_from_site)

        # ── Merge all data into a Lead ─────────────────────────────────────────
        lead = self._merge(raw, site_data, ig_data_from_map, ig_data_from_site)

        # ── Post-enrichment IG follower filter ────────────────────────────────
        if lead.ig_followers is not None and lead.ig_followers > max_ig:
            self._stats.skip(f"ig_followers_>{max_ig}")
            return None

        # ── Additional IG-based dedup (now that we have the IG handle) ────────
        if lead.instagram:
            extra_keys = {f"ig:{lead.instagram.rstrip('/').split('/')[-1].lower()}"}
            is_dup2, _, matched2 = self._store.is_duplicate(lead.to_dict())
            if is_dup2:
                self._stats.duplicates += 1
                log.debug(f"[pipeline] DUP (post-IG) {lead.name!r} — matched {matched2}")
                return None

        # ── Outreach viability gate ───────────────────────────────────────────
        if require_viability:
            ok, reason = passes_outreach_viability(
                lead.to_dict(),
                min_channels=2,
                require_direct_contact=False,   # allow IG-only
                require_digital_presence=True,
            )
            if not ok:
                self._stats.skip(f"viability:{reason}")
                return None

        # ── Scoring ───────────────────────────────────────────────────────────
        lead.score = calculate_lead_score(lead.to_dict())
        lead.quality = lead_quality(lead.score)
        lead.tier = score_tier(lead.score)
        lead.action = recommended_action(lead.quality)

        # ── Persist to store ──────────────────────────────────────────────────
        self._store.add(
            lead.to_dict(),
            keys=keys,
            score=lead.score,
            quality=lead.quality,
            niche=lead.niche,
            region=lead.region,
        )
        self._stats.collected += 1

        log.info(
            f"[pipeline] ✅ {lead.name!r} | "
            f"{lead.city} | "
            f"score={lead.score} ({lead.tier}) | "
            f"ig_followers={lead.ig_followers} | "
            f"email={'✓' if lead.email else '✗'}"
        )

        return lead

    def _merge(
        self,
        raw: RawPlace,
        site: dict,
        ig_from_maps: dict,
        ig_from_site: dict,
    ) -> Lead:
        """Merge all enrichment layers into a final Lead object."""

        # Merge IG data: prefer maps version, fill gaps from site version
        ig: dict = {}
        for key in ("followers", "posts", "following", "bio", "category",
                    "is_business", "external_url", "email_from_bio",
                    "activity", "last_post_days", "post_frequency",
                    "legitimacy_score", "private", "blocked"):
            ig[key] = (
                ig_from_maps.get(key)
                if ig_from_maps.get(key) is not None and ig_from_maps.get(key) != ""
                else ig_from_site.get(key)
            )

        # Best email: prioritize IG bio email → site crawler email → nothing
        all_emails = [
            ig.get("email_from_bio") or "",
            site.get("email") or "",
        ]
        email = pick_best_email(
            [e for e in all_emails if e],
            preferred_domain=domain_of(raw.website),
        )

        # Best phone
        all_phones = [raw.phone, site.get("phone") or ""]
        phone = pick_best_phone([p for p in all_phones if p])

        # IG URL: prefer Maps → site → IG external URL
        ig_url = (
            raw.extra.get("instagram")
            or site.get("instagram")
            or ig.get("external_url") or ""
        )
        if ig_url and not ig_url.startswith("http"):
            ig_url = f"https://www.instagram.com/{ig_url.strip('@')}/"

        # Website: prefer non-weak site; try IG external as fallback
        website = raw.website
        if is_weak_site(website):
            alt = ig.get("external_url") or ""
            if alt and not is_weak_site(alt):
                website = alt

        return Lead(
            # Identity
            name=raw.name,
            address=raw.address,
            city=raw.city,
            country=raw.country,
            query=raw.query,
            niche=raw.niche,
            region=raw.region,

            # Contact
            phone=phone,
            email=email,
            website=website,
            instagram=ig_url,
            facebook=site.get("facebook") or "",
            contact_form=site.get("contact_form") or "",

            # Maps
            maps_link=raw.maps_link,
            rating=raw.rating,
            reviews=raw.reviews,
            category=raw.category,
            price_range=raw.price_range,
            has_photos=raw.has_photos,
            has_popular_times=raw.has_popular_times,
            owner_responds_to_reviews=raw.owner_responds_to_reviews,
            is_google_verified=raw.is_google_verified,
            multi_location=raw.multi_location,
            closed=raw.closed,

            # Instagram
            ig_followers=ig.get("followers"),
            ig_posts=ig.get("posts"),
            ig_following=ig.get("following"),
            ig_private=bool(ig.get("private")),
            ig_blocked=bool(ig.get("blocked")),
            ig_bio=ig.get("bio") or "",
            ig_category=ig.get("category") or "",
            ig_activity=ig.get("activity") or "",
            ig_last_post_days=ig.get("last_post_days"),
            ig_post_frequency=ig.get("post_frequency") or "",
            ig_legitimacy=ig.get("legitimacy_score") or 0,
            ig_is_business=bool(ig.get("is_business")),
            ig_external_url=ig.get("external_url") or "",
            ig_email=ig.get("email_from_bio") or "",

            # Tech stack
            tech_stack=site.get("tech_stack") or {},
        )

    async def _crawl_site(self, url: str) -> dict:
        """Site crawl with error isolation."""
        try:
            return await self._site_crawler.crawl(url)
        except Exception as exc:
            log.debug(f"[pipeline] site crawl error: {exc}")
            return {}

    async def _fetch_ig(self, ig_url: str) -> dict:
        """IG fetch with error isolation."""
        try:
            return await self._ig_intel.fetch_profile(ig_url)
        except Exception as exc:
            log.debug(f"[pipeline] IG fetch error: {exc}")
            return {}


async def _noop() -> dict:
    return {}
