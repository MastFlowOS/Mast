"""
opportunities
=============

Opportunity Intelligence Phase 1 — Canonical Opportunity Domain Model & Registry.
"""

from opportunities.models import Opportunity
from opportunities.registry import OpportunityRegistry

__all__ = [
    "Opportunity",
    "OpportunityRegistry",
]
