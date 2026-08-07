"""
opportunity_scoring/policy.py
==============================

Scoring Policy and Rule definitions for Opportunity Quality Scoring in MAST Lead Engine.

Design Rules
------------
- Decoupled Strategy Pattern: Scoring algorithms and rules are encapsulated in policy objects.
- Rules are pure functions or callables operating on immutable domain context (Opportunity, Business, BusinessEnrichment).
- Returns `ScoreContribution` instances or `None`.
- Zero UI taxonomy leakage — rules output contribution_id, delta, and reason directly.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from typing import TYPE_CHECKING, Callable

from .models import ScoreContribution

if TYPE_CHECKING:
    from business import Business
    from business_enrichment import BusinessEnrichment
    from opportunities import Opportunity

ScoringRule = Callable[
    ["Opportunity", "Business | None", "BusinessEnrichment | None"],
    ScoreContribution | None,
]


def rule_supporting_signals(
    opportunity: Opportunity,
    business: Business | None = None,
    enrichment: BusinessEnrichment | None = None,
) -> ScoreContribution | None:
    """Evaluate quality contribution based on supporting signal strength."""
    signals_count = len(opportunity.supporting_signal_ids)
    if signals_count == 0:
        return ScoreContribution(
            contribution_id="no_supporting_signals",
            delta=-10.0,
            reason="Opportunity has no supporting evidence signals",
        )
    
    # Scale bonus based on number of supporting signals (+15 per signal up to max +45)
    points = min(45.0, signals_count * 15.0)
    return ScoreContribution(
        contribution_id="supporting_signals_strength",
        delta=points,
        reason=f"Opportunity is supported by {signals_count} evidence signal(s)",
    )


def rule_website_presence(
    opportunity: Opportunity,
    business: Business | None = None,
    enrichment: BusinessEnrichment | None = None,
) -> ScoreContribution | None:
    """Evaluate digital asset maturity based on website presence."""
    website = None
    if business is not None and getattr(business, "website", None):
        website = business.website
    elif enrichment is not None and getattr(enrichment, "website", None):
        website = enrichment.website

    if website and str(website).strip():
        return ScoreContribution(
            contribution_id="website_present",
            delta=20.0,
            reason="Target business has an identified web domain",
        )
    
    return ScoreContribution(
        contribution_id="website_missing",
        delta=0.0,
        reason="Target business has no confirmed website URL",
    )


def rule_contact_reachability(
    opportunity: Opportunity,
    business: Business | None = None,
    enrichment: BusinessEnrichment | None = None,
) -> ScoreContribution | None:
    """Evaluate reachability based on available validated contact points."""
    has_email = False
    has_phone = False

    if enrichment is not None:
        has_email = bool(getattr(enrichment, "email", None)) or bool(
            getattr(enrichment, "decision_maker_email", None)
        )
        has_phone = bool(getattr(enrichment, "phone", None))

    if has_email and has_phone:
        return ScoreContribution(
            contribution_id="email_and_phone_available",
            delta=25.0,
            reason="Direct email and phone contact details available",
        )
    elif has_email:
        return ScoreContribution(
            contribution_id="email_available",
            delta=18.0,
            reason="Direct email contact details available",
        )
    elif has_phone:
        return ScoreContribution(
            contribution_id="phone_available",
            delta=10.0,
            reason="Phone contact details available",
        )

    return ScoreContribution(
        contribution_id="contact_info_missing",
        delta=0.0,
        reason="No direct email or phone contact details confirmed",
    )


def rule_opportunity_freshness(
    opportunity: Opportunity,
    business: Business | None = None,
    enrichment: BusinessEnrichment | None = None,
) -> ScoreContribution | None:
    """Evaluate data recency and freshness of opportunity discovery."""
    discovered_at = getattr(opportunity, "discovered_at", None)
    if not isinstance(discovered_at, datetime):
        return None

    now = datetime.now(timezone.utc)
    if discovered_at.tzinfo is None:
        discovered_at = discovered_at.replace(tzinfo=timezone.utc)

    age_days = (now - discovered_at).days
    if age_days <= 7:
        return ScoreContribution(
            contribution_id="fresh_discovery",
            delta=10.0,
            reason=f"Opportunity was discovered recently ({age_days} day(s) ago)",
        )
    elif age_days > 90:
        return ScoreContribution(
            contribution_id="stale_discovery_penalty",
            delta=-15.0,
            reason=f"Opportunity discovery is old ({age_days} days ago)",
        )

    return ScoreContribution(
        contribution_id="standard_freshness",
        delta=5.0,
        reason=f"Opportunity was discovered {age_days} days ago",
    )


@dataclass(frozen=True, slots=True)
class ScoringPolicy:
    """
    Immutable policy container encapsulating scoring rules and base score settings.
    """

    rules: tuple[ScoringRule, ...]
    base_score: float = 0.0

    def __post_init__(self) -> None:
        if not isinstance(self.base_score, (int, float)):
            raise TypeError(f"base_score must be float or int; got {type(self.base_score)!r}")
        object.__setattr__(self, "base_score", float(self.base_score))

        if not isinstance(self.rules, tuple):
            rules_tuple = tuple(self.rules)
        else:
            rules_tuple = self.rules

        for rule in rules_tuple:
            if not callable(rule):
                raise TypeError(f"rules items must be callable; got {type(rule)!r}")

        object.__setattr__(self, "rules", rules_tuple)


# Default canonical scoring policy
DEFAULT_SCORING_POLICY = ScoringPolicy(
    base_score=0.0,
    rules=(
        rule_supporting_signals,
        rule_website_presence,
        rule_contact_reachability,
        rule_opportunity_freshness,
    ),
)
