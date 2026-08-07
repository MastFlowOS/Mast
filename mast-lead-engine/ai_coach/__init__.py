"""
ai_coach
========

Canonical AI Coach Advisory Subsystem (Subsystem 17) in the MAST Lead Engine 2.0.

Design Rules
------------
- Pure, stateless advisory service for canonical engine context.
- Zero infrastructure awareness (no provider failure, authentication, rate limits, networking).
- 100% frozen, slotted dataclasses and immutable tuple collections.
- Single input boundary: EngineContext (Subsystem 16).
- Infrastructure Separation Rule: Lead Engine domain models must never represent infrastructure state.
"""

from .models import (
    CoachInsight,
    CoachingReport,
    CoachingRequest,
    InsightCategory,
)
from .service import AICoachService

__all__ = [
    "InsightCategory",
    "CoachInsight",
    "CoachingRequest",
    "CoachingReport",
    "AICoachService",
]
