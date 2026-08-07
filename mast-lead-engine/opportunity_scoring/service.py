"""
opportunity_scoring/service.py
===============================

Stateless evaluation engine for Opportunity Quality Scoring in the MAST Lead Engine.

Design Rules
------------
- Pure stateless execution engine — zero instance state, zero caches, zero singletons.
- Evaluates immutable Opportunity, Business, or dictionary scorable business payloads.
- Single canonical implementation of universal business breakdown & profession-aware opportunity scoring.
- Does NOT perform AI network calls, database storage, CRM mutation, or provider execution.
"""

from __future__ import annotations

import math
from typing import TYPE_CHECKING, Any

from opportunities import Opportunity

from .explain import explain_opportunity
from .models import (
    BusinessOpportunityResult,
    OpportunityScore,
    ProfessionOpportunityScore,
    ScoreContribution,
    UniversalBreakdown,
)
from .policy import DEFAULT_SCORING_POLICY, ScoringPolicy
from .professions import PROFESSION_SLUGS, PROFESSION_WEIGHTS, WeightVector

if TYPE_CHECKING:
    from business import Business
    from business_enrichment import BusinessEnriched


def _clamp(val: float, lo: float = 0.0, hi: float = 100.0) -> float:
    return max(lo, min(hi, float(val)))


def compute_website_opportunity(biz: dict[str, Any]) -> float:
    site = str(biz.get("website") or "").strip().lower()
    if not site:
        return 100.0

    website_is_weak = biz.get("website_is_weak")
    if website_is_weak is True:
        return 70.0

    if website_is_weak is False:
        score = 40.0
        if site.startswith("https://"):
            score -= 10.0
        if biz.get("ssl_valid") is False:
            score += 20.0
        load_ms = biz.get("load_time_ms")
        if isinstance(load_ms, (int, float)) and load_ms > 4000:
            score += 10.0
        return _clamp(score)

    weak_patterns = (
        "linktr.ee",
        "wixsite.com",
        "weebly.com",
        "godaddysites.com",
        "business.site",
        "sites.google.com",
        "facebook.com/",
        "instagram.com/",
        "square.site",
    )
    if any(p in site for p in weak_patterns):
        return 70.0

    score = 40.0
    if site.startswith("https://"):
        score -= 10.0
    cheap_tlds = (".tk", ".ml", ".ga", ".cf", ".gq", ".info")
    if any(t in site for t in cheap_tlds):
        score += 25.0

    return _clamp(score)


def compute_branding_opportunity(biz: dict[str, Any]) -> float:
    has_photos = bool(biz.get("has_photos"))
    has_instagram = bool(str(biz.get("instagram") or "").strip())

    signals = biz.get("signals") or {}
    days = None
    if isinstance(signals, dict):
        days = signals.get("ig_last_post_days")
    if days is None:
        days = biz.get("ig_last_post_days")

    recent_activity = (days is not None and isinstance(days, (int, float)) and days <= 30)

    rating = biz.get("reviews_rating")
    if rating is None:
        rating = biz.get("rating")
    try:
        rating_val = float(rating) if rating is not None else 0.0
    except (ValueError, TypeError):
        rating_val = 0.0

    strong_rating = (rating_val >= 4.3)

    seo = biz.get("seo")
    if not seo and isinstance(signals, dict):
        seo = signals.get("seo")

    if isinstance(seo, dict) and seo:
        good_seo = bool(seo.get("has_title") and seo.get("has_meta_description"))
    else:
        good_seo = True

    signal_list = [has_photos, has_instagram, recent_activity, strong_rating, good_seo]
    strength = sum(1 for s in signal_list if s) / len(signal_list)
    return _clamp(100.0 * (1.0 - strength))


def compute_social_opportunity(biz: dict[str, Any]) -> float:
    has_any_social = bool(
        str(biz.get("instagram") or "").strip()
        or str(biz.get("facebook") or "").strip()
        or str(biz.get("linkedin") or "").strip()
    )
    if not has_any_social:
        return 100.0

    signals = biz.get("signals") or {}
    days = None
    if isinstance(signals, dict):
        days = signals.get("ig_last_post_days")
    if days is None:
        days = biz.get("ig_last_post_days")

    if days is None or not isinstance(days, (int, float)):
        return 40.0
    if days <= 14:
        return 10.0
    if days <= 30:
        return 25.0
    if days <= 60:
        return 45.0
    if days <= 90:
        return 65.0
    return 85.0


def compute_growth_opportunity(biz: dict[str, Any]) -> float:
    signals = biz.get("signals") or {}
    g = signals.get("growth_signals") if isinstance(signals, dict) else None
    if not g and isinstance(biz.get("growth_signals"), dict):
        g = biz.get("growth_signals")

    if not isinstance(g, dict):
        return 0.0

    score = 0.0
    if g.get("hiring"):
        score += 45.0
    if g.get("new_location"):
        score += 45.0
    return _clamp(score)


def compute_newness_opportunity(biz: dict[str, Any]) -> float:
    reviews = biz.get("reviews_count")
    if reviews is None:
        reviews = biz.get("reviews")
    try:
        count = int(reviews) if reviews is not None else 0
    except (ValueError, TypeError):
        count = 0

    count = max(0, min(500, count))
    if count == 0:
        return 100.0
    log_ratio = math.log10(count + 1) / math.log10(501)
    return _clamp(100.0 * (1.0 - log_ratio))


def compute_tech_opportunity(biz: dict[str, Any]) -> float:
    if not str(biz.get("website") or "").strip():
        return 50.0

    signals = biz.get("signals") or {}
    stack = signals.get("tech_stack") if isinstance(signals, dict) else None
    if not stack and isinstance(biz.get("tech_stack"), dict):
        stack = biz.get("tech_stack")

    if not isinstance(stack, dict):
        stack = {}

    has_chat = bool(stack.get("chat"))
    has_booking = bool(stack.get("booking"))

    analytics = stack.get("analytics")
    if isinstance(analytics, dict):
        has_analytics = bool(analytics.get("has_analytics"))
    elif isinstance(analytics, list):
        has_analytics = len(analytics) > 0
    else:
        has_analytics = bool(analytics)

    present = sum(1 for item in (has_chat, has_booking, has_analytics) if item)
    return _clamp(100.0 - present * 30.0)


def compute_universal_breakdown(biz: dict[str, Any]) -> UniversalBreakdown:
    return UniversalBreakdown(
        website=compute_website_opportunity(biz),
        branding=compute_branding_opportunity(biz),
        social=compute_social_opportunity(biz),
        growth=compute_growth_opportunity(biz),
        newness=compute_newness_opportunity(biz),
        tech=compute_tech_opportunity(biz),
    )


class OpportunityScoringService:
    """
    Stateless evaluation service for calculating the quality score of an Opportunity
    and profession-aware opportunity scores across all canonical professions.
    """

    def evaluate(
        self,
        opportunity: Opportunity,
        business: Business | None = None,
        enrichment: Any | None = None,
        policy: ScoringPolicy | None = None,
    ) -> OpportunityScore:
        if not isinstance(opportunity, Opportunity):
            raise TypeError(
                f"opportunity must be an Opportunity instance; got {type(opportunity)!r}"
            )

        scoring_policy = policy if policy is not None else DEFAULT_SCORING_POLICY
        if not isinstance(scoring_policy, ScoringPolicy):
            raise TypeError(
                f"policy must be a ScoringPolicy instance; got {type(scoring_policy)!r}"
            )

        contributions: list[ScoreContribution] = []
        total_score = scoring_policy.base_score

        for rule in scoring_policy.rules:
            contribution = rule(opportunity, business, enrichment)
            if contribution is not None:
                if not isinstance(contribution, ScoreContribution):
                    raise TypeError(
                        f"rule returned non-ScoreContribution value; got {type(contribution)!r}"
                    )
                contributions.append(contribution)
                total_score += contribution.delta

        return OpportunityScore(
            opportunity_id=opportunity.opportunity_id,
            overall_score=total_score,
            contributions=tuple(contributions),
        )

    def evaluate_business_professions(
        self,
        biz_data: dict[str, Any],
        business_id: str = "",
    ) -> BusinessOpportunityResult:
        if not isinstance(biz_data, dict):
            raise TypeError(f"biz_data must be a dict; got {type(biz_data)!r}")

        biz_id = str(business_id or biz_data.get("id") or biz_data.get("business_id") or "biz_unknown")
        is_disqualified = bool(biz_data.get("is_disqualified"))

        breakdown = compute_universal_breakdown(biz_data)
        profession_scores: list[ProfessionOpportunityScore] = []

        for slug in PROFESSION_SLUGS:
            if is_disqualified:
                score_val = 0.0
                reasons: tuple[str, ...] = ("Business is hard disqualified.",)
                summary = "Disqualified business."
            else:
                w = PROFESSION_WEIGHTS[slug]
                raw_score = (
                    breakdown.website * w.website
                    + breakdown.branding * w.branding
                    + breakdown.social * w.social
                    + breakdown.growth * w.growth
                    + breakdown.newness * w.newness
                    + breakdown.tech * w.tech
                )
                score_val = _clamp(raw_score)
                exp = explain_opportunity(biz_data, round(score_val, 2), breakdown.to_dict(), slug)
                reasons = tuple(r.detail for r in exp.reasons)
                summary = exp.summary

            profession_scores.append(
                ProfessionOpportunityScore(
                    profession_slug=slug,
                    score=score_val,
                    breakdown=breakdown,
                    summary=summary,
                    reasons=reasons,
                )
            )

        return BusinessOpportunityResult(
            business_id=biz_id,
            is_disqualified=is_disqualified,
            universal_breakdown=breakdown,
            profession_scores=tuple(profession_scores),
        )
