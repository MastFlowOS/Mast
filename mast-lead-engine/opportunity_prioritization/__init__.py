"""
opportunity_prioritization
==========================

Subsystem 12 — Opportunity Prioritization for the MAST Lead Engine 2.0.

Provides pure, immutable domain models and a stateless calculation service that computes
continuous, deterministic priority scores for Opportunities based on quality score and
explicit recency decay.
"""

from __future__ import annotations

from .models import (
    OpportunityPriority,
    PrioritizationPolicy,
    PrioritizationStrategy,
)
from .service import OpportunityPrioritizationService

__all__ = [
    "OpportunityPriority",
    "PrioritizationPolicy",
    "PrioritizationStrategy",
    "OpportunityPrioritizationService",
]
