"""
opportunity_ranking
===================

Subsystem 13 — Opportunity Ranking for the MAST Lead Engine.
"""

from opportunity_ranking.models import RankedOpportunity
from opportunity_ranking.service import OpportunityRankingService

__all__ = [
    "RankedOpportunity",
    "OpportunityRankingService",
]
