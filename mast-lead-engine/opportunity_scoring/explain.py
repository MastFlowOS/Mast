"""
opportunity_scoring/explain.py
==============================

Human-readable explanation generator for Opportunity Scoring in Engine 2.0.

Design Rules
------------
- Pure deterministic explanation generation directly from breakdown values, business context, and profession weight vectors.
- Consumes standard library types and immutable dataclasses only.
- Zero external LLM dependencies — instant, consistent, and fully explainable.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from .professions import PROFESSION_WEIGHTS, WeightVector


@dataclass(frozen=True, slots=True)
class ExplanationReason:
    component: str
    label: str
    detail: str
    weight: float
    value: float


@dataclass(frozen=True, slots=True)
class OpportunityExplanation:
    score: float
    profession_slug: str
    profession_match: str
    reasons: tuple[ExplanationReason, ...]
    summary: str


COMPONENT_LABELS: dict[str, str] = {
    "website": "Website",
    "branding": "Branding",
    "social": "Social presence",
    "growth": "Growth signals",
    "newness": "Business maturity",
    "tech": "Automation & tooling",
}


def website_detail(biz: dict[str, Any], value: float) -> str:
    site = str(biz.get("website") or "").strip()
    if not site:
        return "No website found — a common gap this profession can close."
    if biz.get("ssl_valid") is False:
        return "Website exists but its SSL certificate is invalid or expired."
    load_ms = biz.get("load_time_ms")
    if isinstance(load_ms, (int, float)) and load_ms > 4000:
        return "Website exists but loads slowly."
    if value >= 60:
        return "Website exists but runs on a free/templated builder rather than a custom site."
    return "Has an established, custom-domain website."


def branding_detail(biz: dict[str, Any], value: float) -> str:
    seo = biz.get("seo") or {}
    if isinstance(seo, dict) and not (seo.get("has_title") and seo.get("has_meta_description")):
        return "Missing SEO basics (title tag or meta description) alongside weak brand presence."
    if value >= 70:
        return "Little visible brand investment: no photos, inactive or missing social, no rating signal."
    if value >= 40:
        return "Some brand presence, but inconsistent across channels."
    return "Already has a fairly consistent, professional brand presence."


def social_detail(biz: dict[str, Any], value: float) -> str:
    has_any = bool(
        str(biz.get("instagram") or "").strip()
        or str(biz.get("facebook") or "").strip()
        or str(biz.get("linkedin") or "").strip()
    )
    if not has_any:
        return "No social media presence detected on any channel."

    signals = biz.get("signals") or {}
    days = None
    if isinstance(signals, dict):
        days = signals.get("ig_last_post_days")
    if days is None:
        days = biz.get("ig_last_post_days")

    if days is None:
        return "Has social channels, but activity level is unknown."
    if days > 60:
        return f"Social presence exists but looks dormant (~{days} days since last activity)."
    return "Social presence is active and reasonably maintained."


def growth_detail(biz: dict[str, Any], value: float) -> str:
    signals = biz.get("signals") or {}
    g = signals.get("growth_signals") if isinstance(signals, dict) else None
    if not g and isinstance(biz.get("growth_signals"), dict):
        g = biz.get("growth_signals")

    if not g or value == 0:
        return "No hiring or new-location signals detected on the website."

    detected: list[str] = []
    if isinstance(g, dict):
        if g.get("hiring"):
            detected.append("hiring")
        if g.get("new_location"):
            detected.append("opening a new location")

    if not detected:
        return "No hiring or new-location signals detected on the website."

    return f"Showing growth signals: {', '.join(detected)} — likely has budget to spend."


def newness_detail(biz: dict[str, Any], value: float) -> str:
    count = biz.get("reviews_count") or biz.get("reviews") or 0
    try:
        count = int(count)
    except (ValueError, TypeError):
        count = 0

    if count == 0:
        return "No reviews yet — likely a newer or very small business."
    if value >= 60:
        return f"Relatively few reviews ({count}) suggest an earlier-stage business."
    return f"Established review history ({count} reviews) suggests a more mature business."


def tech_detail(biz: dict[str, Any], value: float) -> str:
    if not (biz.get("website") or "").strip():
        return "No website to evaluate for automation tooling."

    signals = biz.get("signals") or {}
    stack = signals.get("tech_stack") if isinstance(signals, dict) else None
    if not stack and isinstance(biz.get("tech_stack"), dict):
        stack = biz.get("tech_stack")

    if not isinstance(stack, dict):
        stack = {}

    missing: list[str] = []
    if not stack.get("chat"):
        missing.append("no chatbot")
    if not stack.get("booking"):
        missing.append("no online booking")
    
    analytics = stack.get("analytics")
    has_analytics = bool(analytics.get("has_analytics")) if isinstance(analytics, dict) else (
        len(analytics) > 0 if isinstance(analytics, list) else bool(analytics)
    )
    if not has_analytics:
        missing.append("no analytics detected")

    if not missing:
        return "Already has chat, booking, and analytics tooling in place."
    return f"Manual/missing tooling detected: {', '.join(missing)}."


DETAIL_FNS = {
    "website": website_detail,
    "branding": branding_detail,
    "social": social_detail,
    "growth": growth_detail,
    "newness": newness_detail,
    "tech": tech_detail,
}


def explain_opportunity(
    biz: dict[str, Any],
    score: float,
    breakdown: dict[str, float],
    profession_slug: str,
) -> OpportunityExplanation:
    weights = PROFESSION_WEIGHTS.get(profession_slug)
    if weights is None:
        raise ValueError(f"Unknown profession slug: {profession_slug}")

    weight_map = {
        "website": weights.website,
        "branding": weights.branding,
        "social": weights.social,
        "growth": weights.growth,
        "newness": weights.newness,
        "tech": weights.tech,
    }

    raw_contributions: list[dict[str, Any]] = []
    for comp, value in breakdown.items():
        w = weight_map.get(comp, 0.0)
        detail_fn = DETAIL_FNS.get(comp, lambda b, v: "")
        raw_contributions.append({
            "component": comp,
            "label": COMPONENT_LABELS.get(comp, comp),
            "detail": detail_fn(biz, value),
            "weight": w,
            "value": value,
            "contribution": value * w,
        })

    # Sort by contribution descending
    ranked = sorted(raw_contributions, key=lambda item: item["contribution"], reverse=True)
    top_weight = max(weight_map.values()) if weight_map else 0.0

    if ranked and ranked[0]["weight"] >= top_weight * 0.8:
        match_level = "strong"
    elif ranked and ranked[0]["weight"] >= top_weight * 0.4:
        match_level = "moderate"
    else:
        match_level = "weak"

    reasons: list[ExplanationReason] = []
    for item in ranked:
        if item["contribution"] > 5.0:
            reasons.append(
                ExplanationReason(
                    component=item["component"],
                    label=item["label"],
                    detail=item["detail"],
                    weight=item["weight"],
                    value=item["value"],
                )
            )
        if len(reasons) >= 3:
            break

    if not reasons:
        summary = "This business scored low for your profession — limited overlap with the signals that matter most here."
    else:
        labels_str = ", ".join(r.label.lower() for r in reasons)
        summary = f"Surfaced mainly for: {labels_str}."

    return OpportunityExplanation(
        score=score,
        profession_slug=profession_slug,
        profession_match=match_level,
        reasons=tuple(reasons),
        summary=summary,
    )
