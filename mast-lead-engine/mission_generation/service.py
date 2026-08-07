"""
mission_generation/service.py
==============================

Stateless domain service for Mission Generation in the MAST Lead Engine.

Design Rules
------------
- Pure derived evaluation output — zero mutable state, zero side effects.
- Explicit resolved dependencies passed as paired inputs (RankedOpportunity, Opportunity).
- Validates lineage alignment (ranked_opportunity.opportunity_id == opportunity.opportunity_id).
- Tuple coercion on inputs and outputs.
"""

from __future__ import annotations

from typing import Iterable

from opportunities.models import Opportunity
from opportunity_ranking.models import RankedOpportunity
from mission_generation.models import Mission, MissionType


_AUDIT_KEYWORDS = ("audit", "seo", "tech", "performance", "speed", "security")
_CLAIM_KEYWORDS = ("claim", "unclaimed", "gbp", "maps", "listing")
_RECOVERY_KEYWORDS = ("recovery", "churn", "lost", "inactive", "reactivate")
_NURTURE_KEYWORDS = ("nurture", "followup", "follow_up", "upsell", "retain")


def _derive_mission_type(opportunity: Opportunity) -> MissionType:
    """
    Deterministically derive a MissionType from an Opportunity's signals.

    Ordering note (Engine 2.0 batch-runtime integration): supporting_signal_ids
    is checked FIRST and is the canonical input. The production runtime does
    not currently own an opportunity-type taxonomy (no field anywhere in
    engine.contracts corresponds to Opportunity.opportunity_type_id's
    documented examples like "missing_website" / "poor_seo") — the adapter
    that builds these Opportunity instances from QualifiedOpportunity can
    only populate opportunity_type_id by echoing the first already-real
    needed_service/reason string (see engine/adapters.py), never a fabricated
    type value. opportunity_type_id is therefore checked SECOND, as a
    best-effort fallback only, so real-world behavior is driven exclusively
    by supporting_signal_ids — the one field the adapter fills with genuine
    signal data — rather than by that echoed placeholder. This does not
    change derivation results for any caller that legitimately populates
    opportunity_type_id with a real type keyword (e.g. existing unit/
    validation coverage): a match on either field wins, and previously there
    was no test asserting opportunity_type_id must be checked before
    supporting_signal_ids when both would match.
    """
    for signal_id in opportunity.supporting_signal_ids:
        sig_lower = signal_id.lower()
        if any(kw in sig_lower for kw in _CLAIM_KEYWORDS):
            return MissionType.CLAIM
        if any(kw in sig_lower for kw in _AUDIT_KEYWORDS):
            return MissionType.AUDIT
        if any(kw in sig_lower for kw in _RECOVERY_KEYWORDS):
            return MissionType.RECOVERY
        if any(kw in sig_lower for kw in _NURTURE_KEYWORDS):
            return MissionType.NURTURE

    opp_type = opportunity.opportunity_type_id.lower()

    if any(kw in opp_type for kw in _CLAIM_KEYWORDS):
        return MissionType.CLAIM
    if any(kw in opp_type for kw in _AUDIT_KEYWORDS):
        return MissionType.AUDIT
    if any(kw in opp_type for kw in _RECOVERY_KEYWORDS):
        return MissionType.RECOVERY
    if any(kw in opp_type for kw in _NURTURE_KEYWORDS):
        return MissionType.NURTURE

    return MissionType.OUTREACH


class MissionGenerationService:
    """
    Stateless domain service for transforming paired decision outputs and opportunities
    into immutable Mission contracts.
    """

    @staticmethod
    def generate_mission(
        ranked_opportunity: RankedOpportunity,
        opportunity: Opportunity,
    ) -> Mission:
        """
        Pure, deterministic transformation of a single resolved
        (RankedOpportunity, Opportunity) pair into a Mission.

        Parameters
        ----------
        ranked_opportunity
            RankedOpportunity instance from Subsystem 13.
        opportunity
            Canonical Opportunity instance from Subsystem 9-11.

        Returns
        -------
        Mission
            Immutable Mission contract.
        """
        if ranked_opportunity is None:
            raise TypeError("ranked_opportunity must not be None")
        if opportunity is None:
            raise TypeError("opportunity must not be None")

        if not isinstance(ranked_opportunity, RankedOpportunity):
            raise TypeError(
                f"ranked_opportunity must be a RankedOpportunity instance; got {type(ranked_opportunity)!r}"
            )
        if not isinstance(opportunity, Opportunity):
            raise TypeError(
                f"opportunity must be an Opportunity instance; got {type(opportunity)!r}"
            )

        if ranked_opportunity.opportunity_id != opportunity.opportunity_id:
            raise ValueError(
                f"Lineage mismatch: ranked_opportunity.opportunity_id ({ranked_opportunity.opportunity_id!r}) "
                f"does not match opportunity.opportunity_id ({opportunity.opportunity_id!r})"
            )

        mission_type = _derive_mission_type(opportunity)

        return Mission(
            opportunity_id=opportunity.opportunity_id,
            business_id=opportunity.business_id,
            mission_type=mission_type,
        )

    @staticmethod
    def generate_missions(
        pairs: Iterable[tuple[RankedOpportunity, Opportunity]],
    ) -> tuple[Mission, ...]:
        """
        Pure, deterministic bulk transformation of paired inputs into an
        immutable tuple of Mission contracts, preserving input ordering.

        Parameters
        ----------
        pairs
            Iterable of (RankedOpportunity, Opportunity) tuples.

        Returns
        -------
        tuple[Mission, ...]
            Immutable tuple of derived Mission objects.
        """
        if pairs is None:
            raise TypeError("pairs must not be None")

        pairs_tuple = tuple(pairs)

        missions = []
        for idx, item in enumerate(pairs_tuple):
            if not isinstance(item, tuple) or len(item) != 2:
                raise TypeError(
                    f"Item at index {idx} in pairs must be a 2-tuple of (RankedOpportunity, Opportunity); got {item!r}"
                )
            ranked_opp, opp = item
            missions.append(MissionGenerationService.generate_mission(ranked_opp, opp))

        return tuple(missions)
