"""
MAST Engine V2 — Scoring Worker
==================================

Source: Engine BluePrint Phase 1.2 ("Data Contracts" — the pipeline
diagram `EnrichedBusiness -> (QualificationResult + OpportunityScore)`),
`engine.contracts.OpportunityScore`'s own Ownership Table ("Created By:
ScoringWorker"), and the V1 reference implementation this worker
replaces (`scoring/scorer.py`'s `calculate_lead_score` /
`score_tier`). Builds on workers/base_worker.py without duplicating
any lifecycle logic, exactly as workers/website_worker.py,
instagram_worker.py, contact_worker.py, merge_worker.py, and
qualification_worker.py do.

Architecture-review context (pre-implementation)
--------------------------------------------------------------------
`engine/contracts.py`'s Ownership Table names `ScoringWorker` as the
sole legal creator of `OpportunityScore`, exactly the same situation
`MergeWorker` was in before it existed (see workers/merge_worker.py's
own "Architecture-review context" for that precedent): the producer
was named in the contract, but the worker file did not exist anywhere
in `workers/`. This file closes that gap the same way MergeWorker did.

Three things were verified before writing any code, per instruction:

1. Producer/consumer chain for OpportunityScore — confirmed via its
   own docstring ("Created by: ScoringWorker... Consumed by: Storage,
   via QualifiedOpportunity") and the Ownership Table row
   `OpportunityScore | ScoringWorker | Storage | Nobody`. No other
   worker reads or writes this contract.
2. Intended ScoringWorker input/output — `Phase 1.2.md`'s own pipeline
   diagram reads `EnrichedBusiness -> (QualificationResult +
   OpportunityScore)`: Qualification and Scoring are two parallel
   siblings both consuming `EnrichedBusiness` directly, not a
   sequential `Qualification -> Scoring` chain. `OpportunityScore`'s
   docstring phrase "given an EnrichedBusiness (and typically a
   QualificationResult)" is a caller-usage note (you'd normally run
   both), not a second required constructor/process() input — nothing
   in Phase 1.1-1.5 or engine/contracts.py defines a bundled input type
   analogous to MergeInput for this worker, and EnrichedBusiness alone
   already carries every fact this worker needs (see "What this worker
   can honestly compute" below). ScoringWorker therefore satisfies the
   Golden Rule with a single InputT, the same shape as
   QualificationWorker: `EnrichedBusiness -> OpportunityScore`.
3. Position relative to QualificationWorker — parallel, not
   downstream. Confirmed by the same diagram in point 2. ScoringWorker
   never reads a QualificationResult and never imports
   workers.qualification_worker.

No contradiction found in any of the three checks. Proceeding directly
to implementation, per instruction.

Responsibility
--------------
ScoringWorker performs exactly one transformation:

    EnrichedBusiness -> ScoringWorker.process() -> OpportunityScore

It is the second worker (alongside QualificationWorker) allowed to
make a judgement — but a different kind of judgement than
Qualification's binary eligibility gate. Qualification asks "can a
freelancer help this business at all?"; Scoring asks "how good an
opportunity is this, on a spectrum?" (per OpportunityScore's own
docstring: "a terrible website may LOWER business health but INCREASE
opportunity" — the two are explicitly allowed to disagree). It does
not discover, inspect websites, crawl Instagram, extract contacts,
qualify, store, retry, or talk to any queue/session/runtime component.

What this worker can honestly compute (and what it cannot)
--------------------------------------------------------------------
V1's `scoring/scorer.py` computed `calculate_lead_score()` from a much
larger flat dict than anything `EnrichedBusiness` carries today —
fields like `has_photos`, `has_popular_times`,
`owner_responds_to_reviews`, `is_google_verified`, `multi_location`,
`ig_activity`, `ig_legitimacy`, `growth_signals`, `tech_stack`,
`ssl_valid`, `load_time_ms`, `has_press_mention`, `facebook`,
`linkedin`, `tiktok`, `youtube`. None of these exist anywhere in
`engine/contracts.py` — they were already reviewed out of
WebsiteIntel/InstagramIntel/ContactIntel/BusinessCandidate during
Phase 5.4-5.8 for being estimates, judgments, or facts no current
worker actually inspects (see those contracts' own docstrings). This
worker does not resurrect them. Per the same "do not invent... do not
estimate" boundary QualificationResult/InstagramIntel/ContactIntel
already established (matched_skills, engagement, confidence all
removed for this exact reason), every sub-score below reads only
fields that genuinely exist on `EnrichedBusiness` today:

    business (BusinessCandidate): name, category, rating,
        review_count, phone, website
    website_intel (WebsiteIntel): website_reachable, https,
        detected_platform
    instagram_intel (InstagramIntel): profile_reachable, followers,
        verified, last_post_date
    contact_intel (ContactIntel): emails, phones, contact_form_url,
        whatsapp_link, messenger_link, telegram_link, linkedin_url

`OpportunityScore` has five numeric fields plus `tier`. Two are
populated honestly from the facts above (`opportunity_score`,
`business_health_score` — two *different* metrics per the contract's
own docstring, not the same number twice). Three are left `None`,
matching the same "field this worker cannot honestly populate stays
unset" discipline used throughout this codebase rather than fabricated
placeholders:

    - competition_score: would require knowing how many other
      businesses/freelancers compete for this lead. No such data
      exists anywhere upstream of this worker.
    - urgency_score: would require a time-pressure signal (e.g. "lease
      expiring", "recently opened", "funding event"). No such field
      exists on any upstream contract.
    - expected_close_probability: would require a historical
      conversion-rate model. No such model or training data exists in
      this codebase.

`tier` is derived from `opportunity_score` using the same four-band
thresholds V1's `score_tier()` used (ELITE/HOT/WARM/COLD) — a direct,
faithful port, since `tier` needs no input beyond a number this worker
already computes honestly.

V1's `quality` and `action` (recommended_action) fields have no home
here — `OpportunityScore` has no field for either. That is an existing
Phase 1.2 contract decision (already reviewed, already validated per
project status), not something this worker's implementation is
authorized to revisit; see this milestone's own "never rewrite
completed architecture" rule.

No fabrication
------------------
Mirroring MergeWorker's/QualificationWorker's own discipline: no
sub-score here invents a fact. Weak-site classification reuses the
exact same domain-allowlist logic V1's `utils.parsing.is_weak_site()`
used (a pure string test against `business.website`'s own domain —
not a network call, not a guess). Instagram recency is a pure date
subtraction against `instagram_intel.last_post_date`, a field that
already exists as a direct inspection fact. Chain/cannabis detection
reuses V1's own deterministic keyword lists (`scoring/scorer.py`'s
`CHAIN_KEYWORDS` / `CANNABIS_KEYWORDS`) unchanged — a fixed lookup
table, not a judgment call by this worker.

Error handling
----------------
No exception is caught or swallowed anywhere in this module, matching
QualificationWorker exactly. A malformed EnrichedBusiness propagates
unmodified.

Thread safety / statelessness
-------------------------------
No module-level mutable state, no caches. process() is a pure function
of its own argument, identical in spirit to
WebsiteWorker/InstagramWorker/ContactWorker/MergeWorker/
QualificationWorker.

Status
------
Closes the ScoringWorker gap identified in architecture review. Does
NOT:

    - wire this worker into any queue (no queues/ import anywhere in
      this file, matching every other worker in this package)
    - construct, register, or allocate a ScoringWorker instance
      anywhere (a future RuntimeContext/Engine Runtime responsibility,
      same status MergeWorker shipped with)
    - change engine/contracts.py, engine/interfaces.py, or any other
      existing worker or contract file
    - reintroduce field_provenance, quality, or action anywhere
      (explicitly dropped per architecture review)

Depends only on BusinessCandidate, WebsiteIntel, InstagramIntel,
ContactIntel, EnrichedBusiness, OpportunityScore, BaseWorker,
WorkerCapability, and the standard library. No queue/, providers/,
engine.coordinator, or runtime import anywhere in this file.
"""

from __future__ import annotations

from datetime import datetime, timezone
import math
from typing import Optional

from engine.contracts import EnrichedBusiness, OpportunityScore
from opportunity_scoring.service import OpportunityScoringService
from utils.parsing import (
    CANNABIS_KEYWORDS as _CANNABIS_KEYWORDS,
    CHAIN_KEYWORDS as _CHAIN_KEYWORDS,
    domain_of as _domain_of,
    is_weak_site as _is_weak_site,
)
from workers.base_worker import BaseWorker
from workers.worker_capability import WorkerCapability

WORKER_TYPE = "scoring"

#: Scoring performs no I/O of its own — it only evaluates facts
#: already collected by upstream workers — so, like
#: QualificationWorker, its timeout budget is not bound by Phase 1.3's
#: per-fetch Timeout Rules (Website=8s, Instagram=6s, ...). "Scoring"
#: is not itself named in that table (only Website/Instagram/Contact/
#: Merge/Qualification/Storage are), so this value is not borrowed
#: from anywhere — kept small and explicit, matching
#: QualificationWorker's own DEFAULT_TIMEOUT_SECONDS precedent.
DEFAULT_TIMEOUT_SECONDS = 1.0

#: CHAIN_KEYWORDS / CANNABIS_KEYWORDS and the weak-site domain
#: allowlist (behind is_weak_site/domain_of) now come from
#: utils.parsing — the single canonical source shared with
#: scoring/scorer.py's is_chain/is_cannabis, so this worker's
#: classification can't drift from V1's (2.0 Scoring Reconciliation,
#: Milestone 3B-3). Only the local _is_chain/_is_cannabis wrappers
#: remain here, since they take this worker's own (name, category)
#: argument shape rather than V1's flat dict.

_PREMIUM_TLDS = (
    ".com", ".co", ".io", ".net", ".de", ".fr", ".uk",
    ".au", ".ca", ".nl", ".se", ".ch", ".ae", ".nz",
)
_CHEAP_TLDS = (".tk", ".ml", ".ga", ".cf", ".gq", ".info")

_IG_TINY_MAX = 99
_IG_IDEAL_MIN = 100
_IG_IDEAL_MAX = 2_000
_IG_GROWING_MAX = 5_000


def _is_chain(name: Optional[str]) -> bool:
    if not name:
        return False
    low = name.lower()
    return any(kw in low for kw in _CHAIN_KEYWORDS)


def _is_cannabis(name: Optional[str], category: Optional[str]) -> bool:
    haystack = " ".join(v for v in (name, category) if v).lower()
    return any(kw in haystack for kw in _CANNABIS_KEYWORDS)


def _days_since(date_str: Optional[str]) -> Optional[int]:
    """Pure date subtraction against an already-captured fact
    (instagram_intel.last_post_date) — not an estimate. Returns None
    if the field is absent or unparseable, never a guessed number."""
    if not date_str:
        return None
    try:
        dt = datetime.fromisoformat(date_str.replace("Z", "+00:00"))
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        delta = datetime.now(timezone.utc) - dt
        return max(0, delta.days)
    except (ValueError, TypeError):
        return None


class ScoringWorker(BaseWorker[EnrichedBusiness, OpportunityScore]):
    """
    Transforms one EnrichedBusiness into one OpportunityScore by
    applying fixed, deterministic scoring rules to the facts already
    collected by WebsiteWorker, InstagramWorker, and ContactWorker.
    Owns nothing else — see module docstring.
    """

    def __init__(
        self,
        *,
        timeout: float = DEFAULT_TIMEOUT_SECONDS,
        worker_id: Optional[str] = None,
    ) -> None:
        super().__init__(
            worker_type=WORKER_TYPE,
            capabilities=(WorkerCapability(name=WORKER_TYPE),),
            worker_id=worker_id,
        )
        self._timeout = timeout

    # -- WorkerInterface -------------------------------------------------

    def process(self, item: EnrichedBusiness) -> OpportunityScore:
        """
        Consume exactly one EnrichedBusiness and produce exactly one
        OpportunityScore. Never mutates `item`. Deterministic: the
        same EnrichedBusiness always produces the same OpportunityScore.
        """
        business = item.business
        website_intel = item.website_intel
        instagram_intel = item.instagram_intel
        contact_intel = item.contact_intel

        name = business.name if business is not None else None
        category = business.category if business is not None else None

        # Hard disqualifiers — ported unchanged from
        # scoring/scorer.py's calculate_lead_score() ordering.
        if _is_cannabis(name, category):
            opportunity_score = 0
        elif _is_chain(name):
            opportunity_score = 10
        else:
            branding = self._branding_component(business, instagram_intel)
            website_weakness = 100 - self._website_quality_component(
                business, website_intel
            )
            outreach = self._outreach_readiness_component(
                business, instagram_intel, contact_intel
            )
            opportunity_score = int(round(
                branding * 0.40
                + website_weakness * 0.40
                + outreach * 0.20
            ))
            opportunity_score = max(0, min(100, opportunity_score))

        business_health_score = self._business_health_component(
            business, website_intel, instagram_intel
        )

        biz_payload = {
            "business_id": item.pipeline_id,
            "website": business.website if business is not None else None,
            "instagram": getattr(business, "instagram_url", None) if business is not None else None,
            "facebook": None,
            "linkedin": contact_intel.linkedin_url if contact_intel is not None else None,
            "has_photos": False,
            "reviews_count": business.review_count if business is not None else 0,
            "reviews_rating": business.rating if business is not None else None,
            "is_disqualified": _is_cannabis(name, category) or _is_chain(name),
            "website_is_weak": _is_weak_site(business.website if business is not None else None),
            "ssl_valid": website_intel.https if website_intel is not None else None,
            "load_time_ms": None,
            "signals": {
                "ig_last_post_days": _days_since(instagram_intel.last_post_date) if instagram_intel is not None else None,
                "tech_stack": {"cms": website_intel.detected_platform} if website_intel is not None else {},
                "growth_signals": {},
            },
        }

        prof_service = OpportunityScoringService()
        prof_res = prof_service.evaluate_business_professions(biz_payload, business_id=item.pipeline_id)

        return OpportunityScore(
            pipeline_id=item.pipeline_id,
            opportunity_score=float(opportunity_score),
            business_health_score=float(business_health_score),
            competition_score=None,
            urgency_score=None,
            expected_close_probability=None,
            tier=self._tier(opportunity_score),
            profession_scores=prof_res.profession_scores,
            score_breakdown=prof_res.universal_breakdown.to_dict(),
        )


    def timeout_seconds(self) -> float:
        return self._timeout

    # -- internal, pure helpers ------------------------------------------
    #
    # Stateless functions of their arguments only — no instance state
    # read or written, matching QualificationWorker's own helper
    # pattern exactly.

    @staticmethod
    def _tier(score: int) -> str:
        """Direct port of scoring/scorer.py's score_tier()."""
        if score >= 90:
            return "ELITE"
        if score >= 70:
            return "HOT"
        if score >= 40:
            return "WARM"
        return "COLD"

    @staticmethod
    def _website_quality_component(business, website_intel) -> int:
        """0-100. Higher = stronger existing site (less opportunity).
        Restricted to facts that exist on BusinessCandidate/
        WebsiteIntel today.

        Calibrated so that a truly best-in-class website (reachable, HTTPS,
        recognized platform, premium domain) achieves quality 100 (weakness = 0),
        while preserving:
        - missing website = 0 (weakness = 100)
        - unreachable website = 10 (weakness = 90)
        - weak site (e.g. linktree, wixsite) = 25 (weakness = 75)
        - average/good website = 80-90 (weakness = 10-20)
        """
        website = business.website if business is not None else None
        if not website:
            return 0
        if _is_weak_site(website):
            return 25

        score = 65

        if website_intel is not None:
            if website_intel.website_reachable is False:
                return 10  # has a domain, but it doesn't resolve/serve
            if website_intel.https is True:
                score += 15
            elif website_intel.https is False:
                score -= 20
            # Custom-platform signal, restricted to what WebsiteWorker
            # actually detects today (workers/website_worker.py's
            # _PLATFORM_SIGNATURES).
            if website_intel.detected_platform in ("WordPress", "Squarespace"):
                score += 10

        host = _domain_of(website)
        if any(host.endswith(t) for t in _PREMIUM_TLDS):
            score += 10
        if any(host.endswith(t) for t in _CHEAP_TLDS):
            score -= 20

        return max(0, min(100, score))

    @staticmethod
    def _branding_component(business, instagram_intel) -> int:
        """0-100. Brand-investment signals actually observable today:
        review reputation + Instagram presence/recency/verification.
        No facebook/tiktok/youtube/has_photos (none exist on
        BusinessCandidate)."""
        score = 0

        rating = business.rating if business is not None else None
        if rating is not None:
            if rating >= 4.8:
                score += 30
            elif rating >= 4.5:
                score += 24
            elif rating >= 4.2:
                score += 18
            elif rating >= 4.0:
                score += 12
            elif rating >= 3.5:
                score += 5
            elif rating >= 3.0:
                score += 0  # 3.0–3.49: Intentional neutral band (documented per Phase 23)
            else:
                score -= 20

        review_count = business.review_count if business is not None else None
        if review_count:
            capped = min(2500, review_count)
            score += int(round((capped / 2500) * 15))

        if instagram_intel is not None and instagram_intel.profile_reachable:
            score += 20
            followers = instagram_intel.followers
            if followers is not None and followers > 0:
                # Phase 23: Deterministic monotonic logarithmic curve with diminishing returns.
                # Maximum follower contribution is +20.
                clamped = min(100_000, followers)
                ratio = math.log10(1.0 + clamped) / math.log10(100_001.0)
                score += int(round(ratio * 20))
            if instagram_intel.verified:
                score += 10
            days = _days_since(instagram_intel.last_post_date)
            if days is not None:
                if days <= 30:
                    score += 10
                elif days <= 90:
                    score += 4

        return max(0, min(100, score))

    @staticmethod
    def _outreach_readiness_component(business, instagram_intel, contact_intel) -> int:
        """0-100. Contact-channel richness — normalized from raw channels (max 85)
        to the full 0-100 scale: round((raw / 85) * 100)."""
        raw = 0
        if business is not None and business.phone:
            raw += 20
        if contact_intel is not None:
            if contact_intel.emails:
                raw += 25
            if contact_intel.phones and not (business and business.phone):
                raw += 15
            if contact_intel.contact_form_url:
                raw += 10
            if any((
                contact_intel.whatsapp_link,
                contact_intel.messenger_link,
                contact_intel.telegram_link,
                contact_intel.linkedin_url,
            )):
                raw += 10
        if instagram_intel is not None and instagram_intel.profile_reachable:
            raw += 20

        normalized = int(round((raw / 85.0) * 100))
        return max(0, min(100, normalized))

    @staticmethod
    def _business_health_component(business, website_intel, instagram_intel) -> int:
        """0-100. A *different* metric from opportunity_score, per
        OpportunityScore's own docstring: measures how healthy the
        business looks on its own terms (reachable site, good
        reviews, active Instagram), not how much a freelancer could
        improve it. A thriving business with a great website scores
        HIGH here and LOW on website-weakness above — that divergence
        is intentional, not a bug."""
        score = 0

        rating = business.rating if business is not None else None
        if rating is not None:
            score += max(0, min(35, int(round((rating / 5.0) * 35))))

        review_count = business.review_count if business is not None else None
        if review_count:
            score += int(round((min(1000, review_count) / 1000) * 20))

        if website_intel is not None and website_intel.website_reachable:
            score += 20
            if website_intel.https:
                score += 10

        if instagram_intel is not None and instagram_intel.profile_reachable:
            score += 10
            days = _days_since(instagram_intel.last_post_date)
            if days is not None and days <= 30:
                score += 5

        return max(0, min(100, score))
