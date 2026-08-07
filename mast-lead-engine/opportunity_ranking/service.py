"""
opportunity_ranking/service.py
===============================

Stateless domain service for Opportunity Ranking in the MAST Lead Engine.

Design Rules
------------
- Pure derived evaluation output — zero mutable state, zero side effects.
- Canonical tie-breaking comparator: (-priority_score, opportunity_id).
- Tuple coercion on inputs and outputs.
"""

from __future__ import annotations

from typing import Iterable

from opportunity_prioritization.models import OpportunityPriority
from opportunity_ranking.models import RankedOpportunity


class OpportunityRankingService:
    """
    Stateless domain service for transforming continuous opportunity priorities
    into an ordered sequence of 1-based ranked opportunities.
    """

    @staticmethod
    def rank_opportunities(
        priorities: Iterable[OpportunityPriority],
    ) -> tuple[RankedOpportunity, ...]:
        """
        Rank a collection of OpportunityPriority instances deterministically.

        Ordering Rules
        --------------
        1. Primary: Priority Score (descending — highest priority first).
        2. Secondary Tie-Breaker: Opportunity ID (ascending lexicographical order).

        Parameters
        ----------
        priorities
            Iterable of OpportunityPriority objects to be ranked.

        Returns
        -------
        tuple[RankedOpportunity, ...]
            Immutable tuple of RankedOpportunity objects assigned 1-based ranks.
        """
        if priorities is None:
            raise TypeError("priorities must not be None")

        # Coerce iterable to tuple and validate item types
        priority_tuple: tuple[OpportunityPriority, ...] = tuple(priorities)

        for item in priority_tuple:
            if not isinstance(item, OpportunityPriority):
                raise TypeError(
                    f"All items in priorities must be OpportunityPriority instances; got {type(item)!r}"
                )

        # Deterministic sorting using canonical key: (-priority_score, opportunity_id)
        sorted_priorities = sorted(
            priority_tuple,
            key=lambda p: (-p.priority_score, p.opportunity_id),
        )

        # Map to RankedOpportunity with 1-based ordinal rank
        ranked_items = tuple(
            RankedOpportunity(
                opportunity_id=item.opportunity_id,
                rank=idx + 1,
                priority_score=item.priority_score,
            )
            for idx, item in enumerate(sorted_priorities)
        )

        return ranked_items
