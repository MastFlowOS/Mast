"""
engine_context/service.py
=========================

Pure, stateless projection service for Subsystem 16 (Engine Context Projection).

Design Rules
------------
- Pure functions only — zero side effects, zero I/O, zero state.
- Transforms exactly what it receives into immutable tuple projections.
- Keeps private helpers strictly 1:1 mapped to canonical upstream domain models.
- Immutable frozenset for internal component membership checks.
"""

from __future__ import annotations

from typing import Sequence

from business.models import Business
from opportunities.models import Opportunity
from opportunity_qualification.models import OpportunityQualification
from opportunity_scoring.models import OpportunityScore
from opportunity_prioritization.models import OpportunityPriority
from opportunity_ranking.models import RankedOpportunity
from mission_generation.models import Mission
from workflow.models import WorkflowState

from .models import (
    BusinessContext,
    ContextComponent,
    ContextProjectionRequest,
    EngineContext,
    MissionContext,
    OpportunityContext,
    PriorityContext,
    QualificationContext,
    RankContext,
    ScoreContext,
    WorkflowContext,
)


class ContextProjectionService:
    """Pure, stateless projection service for canonical engine state."""

    @staticmethod
    def project(
        request: ContextProjectionRequest,
        business: Business | None = None,
        opportunities: Sequence[Opportunity] | None = None,
        qualifications: Sequence[OpportunityQualification] | None = None,
        scores: Sequence[OpportunityScore] | None = None,
        priorities: Sequence[OpportunityPriority] | None = None,
        ranks: Sequence[RankedOpportunity] | None = None,
        missions: Sequence[Mission] | None = None,
        workflows: Sequence[WorkflowState] | None = None,
    ) -> EngineContext:
        """
        Projects canonical domain entity instances into an EngineContext snapshot.

        Transforms exactly the entities provided without filtering or selection.
        """
        if not isinstance(request, ContextProjectionRequest):
            raise TypeError(
                f"request must be a ContextProjectionRequest instance; got {type(request)!r}"
            )

        req_components = frozenset(request.requested_components)

        projected_business: BusinessContext | None = None
        projected_opportunities: tuple[OpportunityContext, ...] = ()
        projected_qualifications: tuple[QualificationContext, ...] = ()
        projected_scores: tuple[ScoreContext, ...] = ()
        projected_priorities: tuple[PriorityContext, ...] = ()
        projected_ranks: tuple[RankContext, ...] = ()
        projected_missions: tuple[MissionContext, ...] = ()
        projected_workflows: tuple[WorkflowContext, ...] = ()

        if ContextComponent.BUSINESS in req_components and business is not None:
            if not isinstance(business, Business):
                raise TypeError(f"business must be a Business instance; got {type(business)!r}")
            projected_business = ContextProjectionService._project_business(business)

        if ContextComponent.OPPORTUNITY in req_components and opportunities:
            projected_opportunities = tuple(
                ContextProjectionService._project_opportunity(o) for o in opportunities
            )

        if ContextComponent.QUALIFICATION in req_components and qualifications:
            projected_qualifications = tuple(
                ContextProjectionService._project_qualification(q) for q in qualifications
            )

        if ContextComponent.SCORE in req_components and scores:
            projected_scores = tuple(
                ContextProjectionService._project_score(s) for s in scores
            )

        if ContextComponent.PRIORITY in req_components and priorities:
            projected_priorities = tuple(
                ContextProjectionService._project_priority(p) for p in priorities
            )

        if ContextComponent.RANK in req_components and ranks:
            projected_ranks = tuple(
                ContextProjectionService._project_rank(r) for r in ranks
            )

        if ContextComponent.MISSION in req_components and missions:
            projected_missions = tuple(
                ContextProjectionService._project_mission(m) for m in missions
            )

        if ContextComponent.WORKFLOW in req_components and workflows:
            projected_workflows = tuple(
                ContextProjectionService._project_workflow(w) for w in workflows
            )

        return EngineContext(
            subject=request.subject,
            business=projected_business,
            opportunities=projected_opportunities,
            qualifications=projected_qualifications,
            scores=projected_scores,
            priorities=projected_priorities,
            ranks=projected_ranks,
            missions=projected_missions,
            workflows=projected_workflows,
        )

    # Private 1:1 projection helpers

    @staticmethod
    def _project_business(business: Business) -> BusinessContext:
        if not isinstance(business, Business):
            raise TypeError(f"business must be a Business instance; got {type(business)!r}")
        return BusinessContext(
            business_id=business.business_id,
            name=business.name,
            category=business.category,
            address=business.address,
            city=business.city,
            region=business.region,
            country=business.country,
            description=business.description,
            phones=business.phones,
            emails=business.emails,
            websites=business.websites,
        )

    @staticmethod
    def _project_opportunity(opp: Opportunity) -> OpportunityContext:
        if not isinstance(opp, Opportunity):
            raise TypeError(f"opp must be an Opportunity instance; got {type(opp)!r}")
        return OpportunityContext(
            opportunity_id=opp.opportunity_id,
            business_id=opp.business_id,
            niche_id=opp.niche_id,
            opportunity_type_id=opp.opportunity_type_id,
            supporting_signal_ids=opp.supporting_signal_ids,
        )

    @staticmethod
    def _project_qualification(qual: OpportunityQualification) -> QualificationContext:
        if not isinstance(qual, OpportunityQualification):
            raise TypeError(
                f"qual must be an OpportunityQualification instance; got {type(qual)!r}"
            )
        status_str = qual.status.value if hasattr(qual.status, "value") else str(qual.status)
        return QualificationContext(
            opportunity_id=qual.opportunity_id,
            status=status_str,
            passed_rule_ids=qual.passed_rule_ids,
            failed_rule_ids=qual.failed_rule_ids,
        )

    @staticmethod
    def _project_score(score: OpportunityScore) -> ScoreContext:
        if not isinstance(score, OpportunityScore):
            raise TypeError(f"score must be an OpportunityScore instance; got {type(score)!r}")
        return ScoreContext(
            opportunity_id=score.opportunity_id,
            overall_score=score.overall_score,
        )

    @staticmethod
    def _project_priority(pri: OpportunityPriority) -> PriorityContext:
        if not isinstance(pri, OpportunityPriority):
            raise TypeError(f"pri must be an OpportunityPriority instance; got {type(pri)!r}")
        return PriorityContext(
            opportunity_id=pri.opportunity_id,
            priority_score=pri.priority_score,
            score_contribution=pri.score_contribution,
            recency_contribution=pri.recency_contribution,
            is_eligible=pri.is_eligible,
        )

    @staticmethod
    def _project_rank(rank: RankedOpportunity) -> RankContext:
        if not isinstance(rank, RankedOpportunity):
            raise TypeError(f"rank must be a RankedOpportunity instance; got {type(rank)!r}")
        return RankContext(
            opportunity_id=rank.opportunity_id,
            rank=rank.rank,
            priority_score=rank.priority_score,
        )

    @staticmethod
    def _project_mission(mission: Mission) -> MissionContext:
        if not isinstance(mission, Mission):
            raise TypeError(f"mission must be a Mission instance; got {type(mission)!r}")
        mission_type_str = (
            mission.mission_type.value
            if hasattr(mission.mission_type, "value")
            else str(mission.mission_type)
        )
        return MissionContext(
            opportunity_id=mission.opportunity_id,
            business_id=mission.business_id,
            mission_type=mission_type_str,
        )

    @staticmethod
    def _project_workflow(wf: WorkflowState) -> WorkflowContext:
        if not isinstance(wf, WorkflowState):
            raise TypeError(f"wf must be a WorkflowState instance; got {type(wf)!r}")
        status_str = wf.status.value if hasattr(wf.status, "value") else str(wf.status)
        return WorkflowContext(
            mission_id=wf.mission_id,
            opportunity_id=wf.opportunity_id,
            business_id=wf.business_id,
            status=status_str,
        )
