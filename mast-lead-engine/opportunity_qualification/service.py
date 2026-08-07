"""
opportunity_qualification/service.py
====================================

Stateless evaluation engine for Opportunity Qualification in the MAST Lead Engine.

Design Rules
------------
- Pure stateless execution engine — zero instance state, zero caches, zero singletons.
- Evaluates an immutable `Opportunity` (and optional `Business` / `BusinessEnrichment` context).
- Answers ONE binary question: "Should this opportunity continue through the pipeline?"
- Owns all qualification evaluation rules internally.
- Does NOT perform AI, scoring, ranking, CRM persistence, or provider execution.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from opportunities import Opportunity

from .models import OpportunityQualification, QualificationStatus

if TYPE_CHECKING:
    from business import Business
    from business_enrichment import BusinessEnrichment


RULE_VALID_OPPORTUNITY_FACTS = "RULE_VALID_OPPORTUNITY_FACTS"
RULE_BUSINESS_IDENTITY_MATCH = "RULE_BUSINESS_IDENTITY_MATCH"
RULE_SUPPORTING_SIGNALS_PRESENT = "RULE_SUPPORTING_SIGNALS_PRESENT"
RULE_NICHE_AND_TYPE_VALID = "RULE_NICHE_AND_TYPE_VALID"


class OpportunityQualificationService:
    """
    Stateless evaluation service for determining whether an Opportunity objectively satisfies
    the qualification rules required to continue through the pipeline.
    """

    def evaluate(
        self,
        opportunity: Opportunity,
        business: Business | None = None,
        enrichment: BusinessEnrichment | None = None,
    ) -> OpportunityQualification:
        """
        Evaluate an Opportunity against internal qualification rules and return a derived result.

        Parameters
        ----------
        opportunity
            The canonical Opportunity model instance to evaluate.
        business
            Optional canonical Business instance for identity matching.
        enrichment
            Optional BusinessEnrichment instance for context.

        Returns
        -------
        OpportunityQualification
            Immutable derived qualification result containing binary status and rule audit tuples.
        """
        if not isinstance(opportunity, Opportunity):
            raise TypeError(
                f"opportunity must be an Opportunity instance; got {type(opportunity)!r}"
            )

        passed_rules: list[str] = []
        failed_rules: list[str] = []

        # Rule 1: Canonical Opportunity facts validation
        if (
            isinstance(opportunity.opportunity_id, str)
            and opportunity.opportunity_id.strip()
            and isinstance(opportunity.business_id, str)
            and opportunity.business_id.strip()
        ):
            passed_rules.append(RULE_VALID_OPPORTUNITY_FACTS)
        else:
            failed_rules.append(RULE_VALID_OPPORTUNITY_FACTS)

        # Rule 2: Business identity match (if business provided)
        if business is not None:
            # Type check if business object is passed
            if hasattr(business, "business_id"):
                if business.business_id == opportunity.business_id:
                    passed_rules.append(RULE_BUSINESS_IDENTITY_MATCH)
                else:
                    failed_rules.append(RULE_BUSINESS_IDENTITY_MATCH)
            else:
                failed_rules.append(RULE_BUSINESS_IDENTITY_MATCH)
        else:
            # If no business passed, rule passes implicitly (optional context)
            passed_rules.append(RULE_BUSINESS_IDENTITY_MATCH)

        # Rule 3: Niche and opportunity type validity
        if (
            isinstance(opportunity.niche_id, str)
            and opportunity.niche_id.strip()
            and isinstance(opportunity.opportunity_type_id, str)
            and opportunity.opportunity_type_id.strip()
        ):
            passed_rules.append(RULE_NICHE_AND_TYPE_VALID)
        else:
            failed_rules.append(RULE_NICHE_AND_TYPE_VALID)

        # Rule 4: Supporting signals presence
        if (
            isinstance(opportunity.supporting_signal_ids, tuple)
            and len(opportunity.supporting_signal_ids) > 0
        ):
            passed_rules.append(RULE_SUPPORTING_SIGNALS_PRESENT)
        else:
            failed_rules.append(RULE_SUPPORTING_SIGNALS_PRESENT)

        # Binary decision: QUALIFIED if no rules failed, else NOT_QUALIFIED
        status = (
            QualificationStatus.QUALIFIED
            if len(failed_rules) == 0
            else QualificationStatus.NOT_QUALIFIED
        )

        return OpportunityQualification(
            opportunity_id=opportunity.opportunity_id,
            status=status,
            passed_rule_ids=tuple(passed_rules),
            failed_rule_ids=tuple(failed_rules),
        )
