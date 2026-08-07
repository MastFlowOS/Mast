"""
mission_intelligence/models.py
==============================

Immutable domain models for Mission Intelligence (Subsystem 22) in the MAST Lead Engine 2.0.

Design Rules
------------
- Frozen, slotted dataclasses — runtime mutation is impossible.
- Canonical NextMissionRule string Enum.
- Strict validation of non-empty identifiers and enum types in __post_init__.
- Pure derived evaluations — zero hidden clocks, zero registries, zero infrastructure state.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
from typing import Optional

from feedback.models import FeedbackRecord
from mission_generation.models import Mission
from workflow.models import WorkflowState


def _validate_non_empty_str(value: str, label: str) -> None:
    """Raise ValueError if value is not a non-empty string."""
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{label} must be a non-empty string; got {value!r}")


class NextMissionRule(str, Enum):
    """
    Canonical enum representing derived next-mission lifecycle transition rules.
    """

    FOLLOW_UP = "FOLLOW_UP"
    DEMO_PITCH = "DEMO_PITCH"
    OBJECTION_HANDLING = "OBJECTION_HANDLING"
    NURTURE = "NURTURE"
    RETRY_OUTREACH = "RETRY_OUTREACH"
    TERMINATE = "TERMINATE"


@dataclass(frozen=True, slots=True)
class MissionProgressionEvaluation:
    """
    Immutable domain model representing the derived next mission progression outcome.

    Fields
    ------
    current_mission
        The evaluated Mission contract (Subsystem 14).
    workflow_state
        The WorkflowState execution state contract (Subsystem 15).
    feedback_record
        Optional FeedbackRecord evidence contract (Subsystem 19).
    next_mission
        The derived next Mission contract, or None if the lifecycle is terminated.
    rule_applied
        Canonical NextMissionRule enum instance indicating the progression logic applied.
    reason
        Human-readable string explanation of the derived progression outcome.
    """

    current_mission: Mission
    workflow_state: WorkflowState
    feedback_record: Optional[FeedbackRecord]
    next_mission: Optional[Mission]
    rule_applied: NextMissionRule
    reason: str

    def __post_init__(self) -> None:
        if not isinstance(self.current_mission, Mission):
            raise TypeError(
                f"current_mission must be a Mission instance; got {type(self.current_mission)!r}"
            )

        if not isinstance(self.workflow_state, WorkflowState):
            raise TypeError(
                f"workflow_state must be a WorkflowState instance; got {type(self.workflow_state)!r}"
            )

        if (
            self.current_mission.opportunity_id != self.workflow_state.opportunity_id
        ):
            raise ValueError(
                f"Lineage mismatch between current_mission.opportunity_id ({self.current_mission.opportunity_id!r}) "
                f"and workflow_state.opportunity_id ({self.workflow_state.opportunity_id!r})"
            )

        if self.current_mission.business_id != self.workflow_state.business_id:
            raise ValueError(
                f"Lineage mismatch between current_mission.business_id ({self.current_mission.business_id!r}) "
                f"and workflow_state.business_id ({self.workflow_state.business_id!r})"
            )

        if self.feedback_record is not None and not isinstance(
            self.feedback_record, FeedbackRecord
        ):
            raise TypeError(
                f"feedback_record must be a FeedbackRecord or None; got {type(self.feedback_record)!r}"
            )

        if self.next_mission is not None and not isinstance(
            self.next_mission, Mission
        ):
            raise TypeError(
                f"next_mission must be a Mission or None; got {type(self.next_mission)!r}"
            )

        if not isinstance(self.rule_applied, NextMissionRule):
            raise TypeError(
                f"rule_applied must be a NextMissionRule enum instance; got {type(self.rule_applied)!r}"
            )

        _validate_non_empty_str(self.reason, "reason")
