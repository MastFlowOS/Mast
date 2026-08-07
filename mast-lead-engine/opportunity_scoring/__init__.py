"""
opportunity_scoring package
============================

Subsystem for evaluating the quality of an already-qualified Opportunity.
Exposes pure, immutable domain models, scoring policy strategies, and stateless evaluation service.
"""

from __future__ import annotations

from .models import OpportunityScore, ScoreContribution
from .policy import (
    DEFAULT_SCORING_POLICY,
    ScoringPolicy,
    ScoringRule,
    rule_contact_reachability,
    rule_opportunity_freshness,
    rule_supporting_signals,
    rule_website_presence,
)
from .service import OpportunityScoringService

__all__ = [
    "OpportunityScore",
    "ScoreContribution",
    "ScoringPolicy",
    "ScoringRule",
    "DEFAULT_SCORING_POLICY",
    "rule_supporting_signals",
    "rule_website_presence",
    "rule_contact_reachability",
    "rule_opportunity_freshness",
    "OpportunityScoringService",
]
