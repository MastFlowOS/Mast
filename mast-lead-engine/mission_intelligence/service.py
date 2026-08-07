"""
mission_intelligence/service.py
===============================

Stateless domain service for Mission Intelligence (Subsystem 22) in MAST Lead Engine 2.0.

Design Rules
------------
- Pure derived evaluation output — zero mutable state, zero side effects.
- Accepts canonical Mission (Subsystem 14), WorkflowState (Subsystem 15), and optional FeedbackRecord (Subsystem 19).
- Evaluates next mission progression deterministically based on mission lifecycle and feedback outcome rules.
- Tuple coercion on inputs and outputs for batch operations.
- Zero hidden clocks, zero registries, zero state coordinators, zero thread synchronization issues.
"""

from __future__ import annotations

from typing import Iterable

from feedback.models import FeedbackOutcomeType, FeedbackRecord
from mission_generation.models import Mission, MissionType
from mission_intelligence.models import (
    MissionProgressionEvaluation,
    NextMissionRule,
)
from workflow.models import WorkflowState, WorkflowStatus


class MissionIntelligenceService:
    """
    Stateless domain service governing next-mission lifecycle derivation.
    """

    @staticmethod
    def derive_next_mission(
        current_mission: Mission,
        workflow_state: WorkflowState,
        feedback_record: FeedbackRecord | None = None,
    ) -> MissionProgressionEvaluation:
        """
        Pure, deterministic derivation of the next Mission contract based on current mission lifecycle and feedback.

        Parameters
        ----------
        current_mission
            Immutable Mission instance (Subsystem 14).
        workflow_state
            Immutable WorkflowState instance (Subsystem 15).
        feedback_record
            Optional FeedbackRecord instance (Subsystem 19).

        Returns
        -------
        MissionProgressionEvaluation
            Immutable progression evaluation contract containing derived next Mission and rule explanation.
        """
        if current_mission is None:
            raise TypeError("current_mission must not be None")
        if workflow_state is None:
            raise TypeError("workflow_state must not be None")

        if not isinstance(current_mission, Mission):
            raise TypeError(
                f"current_mission must be a Mission instance; got {type(current_mission)!r}"
            )
        if not isinstance(workflow_state, WorkflowState):
            raise TypeError(
                f"workflow_state must be a WorkflowState instance; got {type(workflow_state)!r}"
            )

        if current_mission.opportunity_id != workflow_state.opportunity_id:
            raise ValueError(
                f"Lineage mismatch: current_mission.opportunity_id ({current_mission.opportunity_id!r}) "
                f"does not match workflow_state.opportunity_id ({workflow_state.opportunity_id!r})"
            )

        if current_mission.business_id != workflow_state.business_id:
            raise ValueError(
                f"Lineage mismatch: current_mission.business_id ({current_mission.business_id!r}) "
                f"does not match workflow_state.business_id ({workflow_state.business_id!r})"
            )

        if feedback_record is not None:
            if not isinstance(feedback_record, FeedbackRecord):
                raise TypeError(
                    f"feedback_record must be a FeedbackRecord instance or None; got {type(feedback_record)!r}"
                )
            if feedback_record.target_id not in (
                current_mission.opportunity_id,
                current_mission.business_id,
            ):
                raise ValueError(
                    f"Feedback target_id mismatch: {feedback_record.target_id!r} "
                    f"does not match opportunity_id ({current_mission.opportunity_id!r}) "
                    f"or business_id ({current_mission.business_id!r})"
                )

        # Active / non-terminal state check
        if workflow_state.status in (
            WorkflowStatus.UNSTARTED,
            WorkflowStatus.QUEUED,
            WorkflowStatus.IN_PROGRESS,
            WorkflowStatus.PAUSED,
        ):
            return MissionProgressionEvaluation(
                current_mission=current_mission,
                workflow_state=workflow_state,
                feedback_record=feedback_record,
                next_mission=None,
                rule_applied=NextMissionRule.TERMINATE,
                reason=f"Mission execution is active or non-terminal (status={workflow_state.status.value}); no next mission derived",
            )

        # Cancelled workflow state
        if workflow_state.status == WorkflowStatus.CANCELLED:
            return MissionProgressionEvaluation(
                current_mission=current_mission,
                workflow_state=workflow_state,
                feedback_record=feedback_record,
                next_mission=None,
                rule_applied=NextMissionRule.TERMINATE,
                reason="Mission workflow was cancelled; lifecycle terminated",
            )

        # Feedback outcome driven progression (feedback_record.outcome is the canonical field)
        if feedback_record is not None:
            outcome = feedback_record.outcome
            if outcome in (
                FeedbackOutcomeType.CLIENT_WON,
                FeedbackOutcomeType.OPPORTUNITY_CONVERTED,
            ):
                return MissionProgressionEvaluation(
                    current_mission=current_mission,
                    workflow_state=workflow_state,
                    feedback_record=feedback_record,
                    next_mission=None,
                    rule_applied=NextMissionRule.TERMINATE,
                    reason=f"Lifecycle completed successfully via outcome {outcome.value!r}",
                )

            if outcome in (
                FeedbackOutcomeType.FALSE_POSITIVE,
                FeedbackOutcomeType.DUPLICATE_OPPORTUNITY,
                FeedbackOutcomeType.OPPORTUNITY_IGNORED,
            ):
                return MissionProgressionEvaluation(
                    current_mission=current_mission,
                    workflow_state=workflow_state,
                    feedback_record=feedback_record,
                    next_mission=None,
                    rule_applied=NextMissionRule.TERMINATE,
                    reason=f"Lifecycle terminated via outcome {outcome.value!r}",
                )

            if outcome == FeedbackOutcomeType.MISSION_DISMISSED:
                next_m = Mission(
                    opportunity_id=current_mission.opportunity_id,
                    business_id=current_mission.business_id,
                    mission_type=MissionType.NURTURE,
                )
                return MissionProgressionEvaluation(
                    current_mission=current_mission,
                    workflow_state=workflow_state,
                    feedback_record=feedback_record,
                    next_mission=next_m,
                    rule_applied=NextMissionRule.NURTURE,
                    reason="Mission dismissed by user; transitioning opportunity to NURTURE pipeline",
                )

            if outcome in (
                FeedbackOutcomeType.MEETING_BOOKED,
                FeedbackOutcomeType.PROPOSAL_SENT,
            ):
                next_m = Mission(
                    opportunity_id=current_mission.opportunity_id,
                    business_id=current_mission.business_id,
                    mission_type=MissionType.AUDIT,
                )
                return MissionProgressionEvaluation(
                    current_mission=current_mission,
                    workflow_state=workflow_state,
                    feedback_record=feedback_record,
                    next_mission=next_m,
                    rule_applied=NextMissionRule.DEMO_PITCH,
                    reason=f"Outcome {outcome.value!r} recorded; progressing to AUDIT mission",
                )

            if outcome == FeedbackOutcomeType.MISSION_ACCEPTED:
                next_type = (
                    MissionType.AUDIT
                    if current_mission.mission_type == MissionType.OUTREACH
                    else MissionType.CLAIM
                )
                next_m = Mission(
                    opportunity_id=current_mission.opportunity_id,
                    business_id=current_mission.business_id,
                    mission_type=next_type,
                )
                return MissionProgressionEvaluation(
                    current_mission=current_mission,
                    workflow_state=workflow_state,
                    feedback_record=feedback_record,
                    next_mission=next_m,
                    rule_applied=NextMissionRule.FOLLOW_UP,
                    reason=f"Mission accepted; progressing to {next_type.value} mission",
                )

        # Default Workflow outcome progression (No explicit feedback or generic outcome)
        if workflow_state.status == WorkflowStatus.FAILED:
            next_m = Mission(
                opportunity_id=current_mission.opportunity_id,
                business_id=current_mission.business_id,
                mission_type=MissionType.RECOVERY,
            )
            return MissionProgressionEvaluation(
                current_mission=current_mission,
                workflow_state=workflow_state,
                feedback_record=feedback_record,
                next_mission=next_m,
                rule_applied=NextMissionRule.RETRY_OUTREACH,
                reason="Mission execution failed; deriving RECOVERY mission for execution retry",
            )

        # WorkflowStatus.COMPLETED — no feedback
        cur_type = current_mission.mission_type
        if cur_type == MissionType.OUTREACH:
            next_m = Mission(
                opportunity_id=current_mission.opportunity_id,
                business_id=current_mission.business_id,
                mission_type=MissionType.AUDIT,
            )
            return MissionProgressionEvaluation(
                current_mission=current_mission,
                workflow_state=workflow_state,
                feedback_record=feedback_record,
                next_mission=next_m,
                rule_applied=NextMissionRule.FOLLOW_UP,
                reason="OUTREACH mission completed; deriving AUDIT follow-up mission",
            )

        if cur_type == MissionType.AUDIT:
            next_m = Mission(
                opportunity_id=current_mission.opportunity_id,
                business_id=current_mission.business_id,
                mission_type=MissionType.CLAIM,
            )
            return MissionProgressionEvaluation(
                current_mission=current_mission,
                workflow_state=workflow_state,
                feedback_record=feedback_record,
                next_mission=next_m,
                rule_applied=NextMissionRule.FOLLOW_UP,
                reason="AUDIT mission completed; deriving CLAIM follow-up mission",
            )

        if cur_type == MissionType.RECOVERY:
            next_m = Mission(
                opportunity_id=current_mission.opportunity_id,
                business_id=current_mission.business_id,
                mission_type=MissionType.OUTREACH,
            )
            return MissionProgressionEvaluation(
                current_mission=current_mission,
                workflow_state=workflow_state,
                feedback_record=feedback_record,
                next_mission=next_m,
                rule_applied=NextMissionRule.RETRY_OUTREACH,
                reason="RECOVERY mission completed; resuming OUTREACH mission",
            )

        if cur_type == MissionType.CLAIM:
            next_m = Mission(
                opportunity_id=current_mission.opportunity_id,
                business_id=current_mission.business_id,
                mission_type=MissionType.NURTURE,
            )
            return MissionProgressionEvaluation(
                current_mission=current_mission,
                workflow_state=workflow_state,
                feedback_record=feedback_record,
                next_mission=next_m,
                rule_applied=NextMissionRule.NURTURE,
                reason="CLAIM mission completed; transitioning opportunity to NURTURE mission",
            )

        return MissionProgressionEvaluation(
            current_mission=current_mission,
            workflow_state=workflow_state,
            feedback_record=feedback_record,
            next_mission=None,
            rule_applied=NextMissionRule.TERMINATE,
            reason=f"{cur_type.value} mission completed; end of sequence reached",
        )

    @staticmethod
    def batch_derive_next_missions(
        items: Iterable[
            tuple[Mission, WorkflowState]
            | tuple[Mission, WorkflowState, FeedbackRecord | None]
        ],
    ) -> tuple[MissionProgressionEvaluation, ...]:
        """
        Pure, deterministic bulk derivation of next mission progressions.

        Parameters
        ----------
        items
            Iterable of 2-tuples (Mission, WorkflowState) or 3-tuples (Mission, WorkflowState, FeedbackRecord | None).

        Returns
        -------
        tuple[MissionProgressionEvaluation, ...]
            Immutable tuple of derived MissionProgressionEvaluation objects preserving input order.
        """
        if items is None:
            raise TypeError("items must not be None")

        items_tuple = tuple(items)

        evaluations = []
        for idx, item in enumerate(items_tuple):
            if not isinstance(item, tuple) or len(item) not in (2, 3):
                raise TypeError(
                    f"Item at index {idx} must be a 2-tuple or 3-tuple; got {item!r}"
                )
            if len(item) == 2:
                m, w = item
                fb = None
            else:
                m, w, fb = item

            evaluations.append(
                MissionIntelligenceService.derive_next_mission(m, w, fb)
            )

        return tuple(evaluations)
