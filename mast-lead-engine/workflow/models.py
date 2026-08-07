"""
workflow/models.py
==================

Immutable domain models for Workflow Engine (Subsystem 15) in the MAST Lead Engine 2.0.

Design Rules
------------
- Frozen, slotted dataclasses — runtime mutation is impossible.
- Canonical WorkflowStatus and WorkflowEventType string Enums.
- Strict validation of non-empty identifiers and enum types in __post_init__.
- Zero surrogate keys, zero persistence metadata, zero hidden clocks, zero unowned abstractions.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum


def _validate_non_empty_str(value: str, label: str) -> None:
    """Raise ValueError if value is not a non-empty string."""
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{label} must be a non-empty string; got {value!r}")


class WorkflowStatus(str, Enum):
    """
    Canonical enum representing the finite operational lifecycle statuses
    of a Mission within the MAST Lead Engine 2.0 architecture.
    """

    UNSTARTED = "UNSTARTED"
    QUEUED = "QUEUED"
    IN_PROGRESS = "IN_PROGRESS"
    PAUSED = "PAUSED"
    COMPLETED = "COMPLETED"
    FAILED = "FAILED"
    CANCELLED = "CANCELLED"


class WorkflowEventType(str, Enum):
    """
    Canonical enum representing valid lifecycle transition event triggers.
    """

    INITIALIZE = "INITIALIZE"
    QUEUE = "QUEUE"
    START_EXECUTION = "START_EXECUTION"
    PAUSE = "PAUSE"
    RESUME = "RESUME"
    FAIL = "FAIL"
    RETRY = "RETRY"
    COMPLETE = "COMPLETE"
    CANCEL = "CANCEL"


@dataclass(frozen=True, slots=True)
class WorkflowEvent:
    """
    Immutable domain model representing a lifecycle state transition trigger event.

    Fields
    ------
    event_type
        Canonical transition trigger event type (WorkflowEventType).
    timestamp_iso
        ISO 8601 string timestamp explicitly supplied by caller (no hidden clocks).
    reason
        Optional string explanation or error reason for the transition.
    """

    event_type: WorkflowEventType
    timestamp_iso: str
    reason: str | None = None

    def __post_init__(self) -> None:
        if not isinstance(self.event_type, WorkflowEventType):
            raise TypeError(
                f"event_type must be a WorkflowEventType enum instance; got {type(self.event_type)!r}"
            )

        _validate_non_empty_str(self.timestamp_iso, "timestamp_iso")

        if self.reason is not None and not isinstance(self.reason, str):
            raise TypeError(f"reason must be a str or None; got {type(self.reason)!r}")


@dataclass(frozen=True, slots=True)
class WorkflowState:
    """
    Immutable domain model representing the current operational lifecycle state
    of a derived Mission.

    Fields
    ------
    mission_id
        Canonical identifier of the target Mission (Subsystem 14).
    opportunity_id
        Canonical identifier of the target Opportunity (Subsystems 9-11).
    business_id
        Canonical identifier of the target Business entity (Subsystems 5-8).
    status
        Current operational status (WorkflowStatus enum).
    """

    mission_id: str
    opportunity_id: str
    business_id: str
    status: WorkflowStatus

    def __post_init__(self) -> None:
        _validate_non_empty_str(self.mission_id, "mission_id")
        _validate_non_empty_str(self.opportunity_id, "opportunity_id")
        _validate_non_empty_str(self.business_id, "business_id")

        if not isinstance(self.status, WorkflowStatus):
            raise TypeError(
                f"status must be a WorkflowStatus enum instance; got {type(self.status)!r}"
            )


@dataclass(frozen=True, slots=True)
class WorkflowTransitionResult:
    """
    Immutable domain model representing the result of evaluating a state transition event.

    Fields
    ------
    success
        Boolean flag indicating if the transition event was valid and successfully applied.
    previous_state
        WorkflowState instance prior to evaluating the transition event.
    new_state
        WorkflowState instance after applying the transition (identical to previous_state if failed).
    applied_event
        WorkflowEvent instance evaluated during the transition attempt.
    error_message
        Explanation of why the transition failed (None if success is True).
    """

    success: bool
    previous_state: WorkflowState
    new_state: WorkflowState
    applied_event: WorkflowEvent
    error_message: str | None = None

    def __post_init__(self) -> None:
        if not isinstance(self.success, bool):
            raise TypeError(f"success must be a bool; got {type(self.success)!r}")

        if not isinstance(self.previous_state, WorkflowState):
            raise TypeError(
                f"previous_state must be a WorkflowState instance; got {type(self.previous_state)!r}"
            )

        if not isinstance(self.new_state, WorkflowState):
            raise TypeError(
                f"new_state must be a WorkflowState instance; got {type(self.new_state)!r}"
            )

        if not isinstance(self.applied_event, WorkflowEvent):
            raise TypeError(
                f"applied_event must be a WorkflowEvent instance; got {type(self.applied_event)!r}"
            )

        if self.error_message is not None and not isinstance(self.error_message, str):
            raise TypeError(
                f"error_message must be a str or None; got {type(self.error_message)!r}"
            )
