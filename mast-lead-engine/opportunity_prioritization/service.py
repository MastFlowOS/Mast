"""
opportunity_prioritization/service.py
======================================

Stateless evaluation service for computing Opportunity Priority in the MAST Lead Engine.

Design Rules
------------
- Pure stateless execution — no instance state, mutable globals, caches, or registries.
- Zero hidden clocks — relies entirely on policy.evaluation_at for temporal decay.
- Strict isolation — consumes standard library and completed domain models only.
"""

from __future__ import annotations

from opportunities.models import Opportunity
from opportunity_qualification.models import OpportunityQualification, QualificationStatus
from opportunity_scoring.models import OpportunityScore

from .models import OpportunityPriority, PrioritizationPolicy


class OpportunityPrioritizationService:
    """
    Stateless calculation service evaluating continuous priority scores for Opportunities.
    """

    @staticmethod
    def evaluate_priority(
        opportunity: Opportunity,
        qualification: OpportunityQualification,
        score: OpportunityScore,
        policy: PrioritizationPolicy,
    ) -> OpportunityPriority:
        """
        Evaluate the continuous priority of an Opportunity given its qualification status,
        quality score, and prioritization policy.

        Parameters
        ----------
        opportunity
            Canonical Opportunity model.
        qualification
            Opportunity qualification evaluation result.
        score
            Opportunity quality score evaluation result.
        policy
            Prioritization policy containing strategy weights and explicit evaluation timestamp.

        Returns
        -------
        OpportunityPriority
            Immutable evaluation value object containing priority score and contribution breakdown.
        """
        if not isinstance(opportunity, Opportunity):
            raise TypeError(
                f"opportunity must be an Opportunity instance; got {type(opportunity)!r}"
            )

        if not isinstance(qualification, OpportunityQualification):
            raise TypeError(
                f"qualification must be an OpportunityQualification instance; got {type(qualification)!r}"
            )

        if not isinstance(score, OpportunityScore):
            raise TypeError(
                f"score must be an OpportunityScore instance; got {type(score)!r}"
            )

        if not isinstance(policy, PrioritizationPolicy):
            raise TypeError(
                f"policy must be a PrioritizationPolicy instance; got {type(policy)!r}"
            )

        # Enforce cross-input identity alignment
        if not (
            opportunity.opportunity_id == qualification.opportunity_id == score.opportunity_id
        ):
            raise ValueError(
                f"Opportunity ID mismatch across evaluation inputs: "
                f"opportunity.id={opportunity.opportunity_id!r}, "
                f"qualification.id={qualification.opportunity_id!r}, "
                f"score.id={score.opportunity_id!r}"
            )

        # Check qualification eligibility
        is_eligible = (
            qualification.status == QualificationStatus.QUALIFIED
            if policy.require_qualification
            else True
        )

        if not is_eligible:
            return OpportunityPriority(
                opportunity_id=opportunity.opportunity_id,
                priority_score=0.0,
                score_contribution=0.0,
                recency_contribution=0.0,
                is_eligible=False,
            )

        # Calculate recency decay factor using explicit policy.evaluation_at (no hidden clocks)
        elapsed_seconds = (policy.evaluation_at - opportunity.discovered_at).total_seconds()
        # Clamp negative elapsed time if opportunity was discovered in the future relative to evaluation_at
        elapsed_seconds = max(0.0, float(elapsed_seconds))

        half_life_seconds = policy.recency_half_life_days * 86400.0
        recency_decay_factor = 0.5 ** (elapsed_seconds / half_life_seconds)
        recency_raw_score = recency_decay_factor * 100.0

        # Intrinsic quality score
        score_raw_score = score.overall_score

        # Composite priority calculation with normalized weighting
        total_weight = policy.score_weight + policy.recency_weight
        score_contrib = (policy.score_weight * score_raw_score) / total_weight
        recency_contrib = (policy.recency_weight * recency_raw_score) / total_weight
        total_priority = score_contrib + recency_contrib

        return OpportunityPriority(
            opportunity_id=opportunity.opportunity_id,
            priority_score=round(total_priority, 4),
            score_contribution=round(score_contrib, 4),
            recency_contribution=round(recency_contrib, 4),
            is_eligible=True,
        )
