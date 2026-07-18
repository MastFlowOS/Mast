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
    rank_emails_by_role,
    extract_ig_urls,
    is_weak_site,
    domain_of,
)
from utils.runtime import get_logger, ScraperConfig, RunStats
from utils.perf import NullProfiler

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
    linkedin: str = ""
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

    # ── Contact intelligence (C5 / Priority 4 — preserve ALL contacts found,
    # not just one "winner") ──────────────────────────────────────────────────
    emails: list = field(default_factory=list)   # [{email, role}], role-ranked
    phones: list = field(default_factory=list)   # all distinct numbers found

    # ── Growth / opportunity intelligence (C3 fix — only real, verified
    # signals; keys are simply absent when not detected, never a fabricated
    # confident negative) ─────────────────────────────────────────────────────
    growth_signals: dict = field(default_factory=dict)
    seo: dict = field(default_factory=dict)
    blog: dict = field(default_factory=dict)
    ssl_valid: bool | None = None
    load_time_ms: int | None = None

    # ── Field-level trust (Priority 2/3 — source attribution architecture) ──
    # field_name -> {value, source, method, verified_at}. Built in _merge()
    # from every layer's own field_sources/attribution, not re-derived.
    field_provenance: dict = field(default_factory=dict)

    # Single source of truth for "is this a weak/templated site" — computed
    # here from utils.parsing.is_weak_site() (O2 fix: the TS layer used to
    # keep its own separately hand-written, already-drifted copy of this
    # domain list; it now just reads this boolean instead of reimplementing
    # the check).
    website_is_weak: bool = False

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
            "linkedin": self.linkedin,
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
            "emails": self.emails,
            "phones": self.phones,
            "growth_signals": self.growth_signals,
            "seo": self.seo,
            "blog": self.blog,
            "ssl_valid": self.ssl_valid,
            "load_time_ms": self.load_time_ms,
            "field_provenance": self.field_provenance,
            "website_is_weak": self.website_is_weak,
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
        profiler=None,
    ) -> None:
        self.config = config
        self._site_crawler = SiteCrawler(config, browser, profiler=profiler)
        self._ig_intel = IGIntelligence(config, browser, profiler=profiler)
        self._store = store or LeadStore()
        self._stats = stats or RunStats()
        self._profiler = profiler or NullProfiler()

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
        # RELIABILITY FIX (balanced filtering): max_ig/max_rev above are now
        # SOFT thresholds — they no longer reject here, they just tell
        # scoring where the "ideal" band ends so it can apply a graduated
        # penalty instead (see scoring/scorer.py). Only a business beyond
        # the HARD ceiling below — genuinely enterprise-scale, not a normal
        # SMB with an unusually large following — is rejected outright.
        hard_max_ig = self.config.hard_max_ig_followers
        hard_max_rev = self.config.hard_max_reviews

        # ── TRACE: every business that enters the pipeline is counted as
        # "discovered" exactly once, here, regardless of what happens next.
        # This is the number the final rejection summary is built against.
        self._stats.discovered += 1
        name = raw.name or "<unnamed>"
        log.info(f"[trace] {name!r} ↓ discovered (yielded from Maps)")

        # Phase 2: begin per-business timing
        self._profiler.begin_business(name)

        # ── Pre-flight filters (fast checks before any network I/O) ──────────

        with self._profiler.timer("preflight"):
            if is_chain(raw.name):
                self._stats.skip("chain_business")
                log.info(f"[trace] {name!r} ↓ REJECTED — chain business (keyword match)")
                self._profiler.record_rejection("chain_business", self._profiler.elapsed_since_business_start_ms())
                self._profiler.end_business("rejected:chain_business")
                return None

            if is_cannabis(raw_dict):
                self._stats.skip("cannabis_business")
                log.info(f"[trace] {name!r} ↓ REJECTED — cannabis business (keyword match)")
                self._profiler.record_rejection("cannabis_business", self._profiler.elapsed_since_business_start_ms())
                self._profiler.end_business("rejected:cannabis_business")
                return None

            if raw.reviews > hard_max_rev:
                self._stats.skip(f"reviews_>{hard_max_rev}_hard_cap")
                log.info(
                    f"[trace] {name!r} ↓ REJECTED — review count {raw.reviews} exceeds "
                    f"hard_max_reviews={hard_max_rev} (obviously overgrown/enterprise scale)"
                )
                self._profiler.record_rejection(f"reviews>{hard_max_rev}_hard_cap", self._profiler.elapsed_since_business_start_ms())
                self._profiler.end_business(f"rejected:reviews>{hard_max_rev}_hard_cap")
                return None

            if raw.closed:
                self._stats.skip("permanently_closed")
                log.info(f"[trace] {name!r} ↓ REJECTED — marked permanently closed on Maps")
                self._profiler.record_rejection("permanently_closed", self._profiler.elapsed_since_business_start_ms())
                self._profiler.end_business("rejected:permanently_closed")
                return None

        # ── Dedup check (fast, in-memory) ────────────────────────────────────
        with self._profiler.timer("dedup"):
            is_dup, keys, matched = self._store.is_duplicate(raw_dict)
        if is_dup:
            self._stats.duplicates += 1
            log.info(f"[trace] {name!r} ↓ REJECTED — duplicate (matched existing fingerprint {matched!r})")
            self._profiler.record_rejection("duplicate", self._profiler.elapsed_since_business_start_ms())
            self._profiler.end_business("rejected:duplicate")
            return None

        log.info(f"[trace] {name!r} ↓ PASSED pre-flight + duplicate check — entering enrichment")

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

        with self._profiler.timer("crawl_and_ig_concurrent"):
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
            with self._profiler.timer("ig_fetch_sequential"):
                ig_data_from_site = await self._fetch_ig(ig_url_from_site)

        # ── Merge all data into a Lead ─────────────────────────────────────────
        with self._profiler.timer("merge"):
            lead = self._merge(raw, site_data, ig_data_from_map, ig_data_from_site)

        log.info(
            f"[trace] {name!r} ↓ PASSED enrichment "
            f"(email={'✓' if lead.email else '✗'} phone={'✓' if lead.phone else '✗'} "
            f"website={'✓' if lead.website else '✗'} "
            f"website_unreachable={site_data.get('reachable') is False} "
            f"instagram={'✓' if lead.instagram else '✗'} "
            f"ig_followers={lead.ig_followers})"
        )

        # ── Post-enrichment IG follower filter ────────────────────────────────
        # RELIABILITY FIX: an account slightly above max_ig (the "ideal"
        # sweet spot) used to be discarded outright here. It now only gets
        # rejected once it's past hard_max_ig — genuinely too big to be a
        # realistic SMB prospect; anything between max_ig and hard_max_ig
        # flows through to scoring, where ig_follower_score() penalizes it
        # proportionally instead of throwing the lead away.
        if lead.ig_followers is not None and lead.ig_followers > hard_max_ig:
            self._stats.skip(f"ig_followers_>{hard_max_ig}_hard_cap")
            log.info(
                f"[trace] {name!r} ↓ REJECTED — ig_followers={lead.ig_followers} "
                f"exceeds hard_max_ig_followers={hard_max_ig} (obviously overgrown/enterprise scale)"
            )
            self._profiler.record_rejection(f"ig_followers>{hard_max_ig}_hard_cap", self._profiler.elapsed_since_business_start_ms())
            self._profiler.end_business(f"rejected:ig_followers>{hard_max_ig}_hard_cap")
            return None

        # ── Additional IG-based dedup (now that we have the IG handle) ────────
        if lead.instagram:
            extra_keys = {f"ig:{lead.instagram.rstrip('/').split('/')[-1].lower()}"}
            is_dup2, _, matched2 = self._store.is_duplicate(lead.to_dict())
            if is_dup2:
                self._stats.duplicates += 1
                log.info(
                    f"[trace] {name!r} ↓ REJECTED — duplicate after enrichment "
                    f"(matched existing fingerprint {matched2!r} via Instagram handle)"
                )
                self._profiler.record_rejection("duplicate_post_enrichment", self._profiler.elapsed_since_business_start_ms())
                self._profiler.end_business("rejected:duplicate_post_enrichment")
                return None

        log.info(f"[trace] {name!r} ↓ PASSED duplicate check")

        # ── Outreach viability gate (a.k.a. "validation" / channel-coverage
        # requirement — must have >= min_channels of {phone,email,website,ig},
        # and (per config) a digital presence channel) ───────────────────────
        if require_viability:
            with self._profiler.timer("viability"):
                ok, reason = passes_outreach_viability(
                    lead.to_dict(),
                    min_channels=2,
                    require_direct_contact=False,   # allow IG-only
                    require_digital_presence=True,
                )
            if not ok:
                self._stats.skip(f"viability:{reason}")
                channels_present = {
                    "phone": bool((lead.phone or "").strip()),
                    "email": bool((lead.email or "").strip()),
                    "website": bool((lead.website or "").strip()),
                    "instagram": bool((lead.instagram or "").strip()),
                }
                log.info(
                    f"[trace] {name!r} ↓ REJECTED — validation/viability failed "
                    f"reason={reason!r} channels_present={channels_present}"
                )
                self._profiler.record_rejection(f"viability:{reason}", self._profiler.elapsed_since_business_start_ms())
                self._profiler.end_business(f"rejected:viability:{reason}")
                return None

        log.info(f"[trace] {name!r} ↓ PASSED validation (outreach viability)")

        # ── Scoring ───────────────────────────────────────────────────────────
        with self._profiler.timer("scoring"):
            lead.score = calculate_lead_score(lead.to_dict())
            lead.quality = lead_quality(lead.score)
            lead.tier = score_tier(lead.score)
            lead.action = recommended_action(lead.quality)

        log.info(f"[trace] {name!r} ↓ PASSED scoring — score={lead.score} tier={lead.tier}")

        # ── Persist to store ──────────────────────────────────────────────────
        with self._profiler.timer("db_write"):
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
        log.info(f"[trace] {name!r} ↓ PASSED delivery — persisted to store, yielded to caller")

        # Phase 2: close the business timing record as delivered
        self._profiler.end_business("delivered")

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

        # Q1 fix: `bio_contact_hints()` (ig_intel.py) has always been able to
        # pull phone/website hints out of an IG bio ("link in bio" URLs,
        # phone numbers) but was imported into this module and never
        # called — only the email half happened, inline inside ig_intel's
        # own extraction. Wiring it in here is a same-crawl, zero-extra-
        # request improvement: it only ever *fills gaps*, never overrides
        # a real Maps/site-crawl value.
        ig_bio_hints = bio_contact_hints(ig.get("bio") or "")

        # C5 fix: preserve every email/phone actually found instead of
        # collapsing to one. `pick_best_email`/`pick_best_phone` remain the
        # *display default* selector; the full deduplicated, role-ranked
        # list travels alongside it so a founder's personal address next to
        # a generic info@ is never silently discarded.
        all_email_candidates = [
            e for e in (
                ig.get("email_from_bio") or "",
                ig_bio_hints.get("email") or "",
                site.get("email") or "",
                *[e.get("email", "") for e in (site.get("emails") or [])],
            ) if e
        ]
        email = pick_best_email(all_email_candidates, preferred_domain=domain_of(raw.website))
        emails = rank_emails_by_role(all_email_candidates)

        all_phone_candidates = [
            p for p in (
                raw.phone,
                site.get("phone") or "",
                ig_bio_hints.get("phone") or "",
                *(site.get("phones") or []),
            ) if p
        ]
        phone = pick_best_phone(all_phone_candidates)
        phones = sorted(set(all_phone_candidates))

        # IG URL: prefer Maps → site → IG external URL
        ig_url = (
            raw.extra.get("instagram")
            or site.get("instagram")
            or ig.get("external_url") or ""
        )
        if ig_url and not ig_url.startswith("http"):
            ig_url = f"https://www.instagram.com/{ig_url.strip('@')}/"

        # Website: prefer non-weak, reachable site; try IG external as fallback.
        # ROOT CAUSE fix: this used to trust raw.website unconditionally
        # (only swapping it out when is_weak_site() flagged it), so a
        # website that SiteCrawler.crawl() actually tried and failed to
        # reach (dead domain, expired site, DNS failure, timeout) was still
        # returned as a live "website channel" — nothing ever inspected it.
        # `site.get("reachable")` is only False when a crawl was attempted
        # and explicitly failed (None means "never attempted", e.g.
        # skip_site_crawl or no website at all — in that case we still
        # trust the Maps-sourced value rather than discarding it).
        website = raw.website
        website_unreachable = site.get("reachable") is False
        if is_weak_site(website) or website_unreachable:
            alt = ig.get("external_url") or ""
            if alt and not is_weak_site(alt):
                website = alt
            elif website_unreachable:
                website = ""

        website_is_weak = is_weak_site(website)

        # Priority 2/3 fix (field-level trust / source attribution): build
        # one consolidated provenance map from every layer's own
        # attribution instead of leaving confidence as a single
        # whole-record number. Each entry can be traced back to exactly
        # where a value came from and how it was checked.
        field_provenance: dict = {}
        site_sources = site.get("field_sources") or {}
        for field_name, src in site_sources.items():
            field_provenance[field_name] = {
                "value": {
                    "instagram": ig_url, "facebook": site.get("facebook"),
                    "linkedin": site.get("linkedin"), "email": email,
                    "contact_form": site.get("contact_form"), "phone": phone,
                }.get(field_name),
                "source": src.get("source_url"),
                "method": src.get("method", "website_crawl"),
            }
        if not field_provenance.get("email") and (ig.get("email_from_bio") or ig_bio_hints.get("email")):
            field_provenance["email"] = {
                "value": email, "source": ig_url or "instagram_bio", "method": "instagram_bio",
            }
        if raw.phone and not field_provenance.get("phone"):
            field_provenance["phone"] = {"value": raw.phone, "source": raw.maps_link, "method": "google_maps"}
        if raw.website and not field_provenance.get("website"):
            field_provenance["website"] = {"value": website, "source": raw.maps_link, "method": "google_maps"}
        if ig_url and not field_provenance.get("instagram"):
            field_provenance["instagram"] = {"value": ig_url, "source": raw.maps_link, "method": "google_maps"}

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
            linkedin=site.get("linkedin") or "",
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

            # Contact intelligence (C5 / Priority 4)
            emails=emails,
            phones=phones,

            # Growth / opportunity intelligence (C3)
            growth_signals=site.get("growth_signals") or {},
            seo=site.get("seo") or {},
            blog=site.get("blog") or {},
            ssl_valid=site.get("ssl_valid"),
            load_time_ms=site.get("load_time_ms"),

            # Field-level trust (Priority 2/3)
            field_provenance=field_provenance,
            website_is_weak=website_is_weak,
        )

    async def _crawl_site(self, url: str) -> dict:
        """Site crawl with error isolation."""
        try:
            with self._profiler.timer("site_crawl"):
                return await self._site_crawler.crawl(url)
        except Exception as exc:
            log.debug(f"[pipeline] site crawl error: {exc}")
            return {}

    async def _fetch_ig(self, ig_url: str) -> dict:
        """IG fetch with error isolation."""
        try:
            with self._profiler.timer("ig_fetch"):
                return await self._ig_intel.fetch_profile(ig_url)
        except Exception as exc:
            log.debug(f"[pipeline] IG fetch error: {exc}")
            return {}


async def _noop() -> dict:
    return {}
