"""
workflow/transitions.py
======================

Pure, deterministic state transition rules for Workflow Engine (Subsystem 15).

Design Rules
------------
- Immutable, explicit graph of valid (WorkflowStatus, WorkflowEventType) -> WorkflowStatus transitions.
- Terminal state protection (COMPLETED and CANCELLED cannot transition further).
- Pure stateless functions with zero side-effects.
"""

from __future__ import annotations

from typing import Final
from workflow.models import WorkflowEventType, WorkflowStatus


# Explicit transition map defining valid state machine edges
_TRANSITION_MAP: Final[
    dict[tuple[WorkflowStatus, WorkflowEventType], WorkflowStatus]
] = {
    # From UNSTARTED
    (WorkflowStatus.UNSTARTED, WorkflowEventType.QUEUE): WorkflowStatus.QUEUED,
    (WorkflowStatus.UNSTARTED, WorkflowEventType.CANCEL): WorkflowStatus.CANCELLED,
    # From QUEUED
    (WorkflowStatus.QUEUED, WorkflowEventType.START_EXECUTION): WorkflowStatus.IN_PROGRESS,
    (WorkflowStatus.QUEUED, WorkflowEventType.CANCEL): WorkflowStatus.CANCELLED,
    # From IN_PROGRESS
    (WorkflowStatus.IN_PROGRESS, WorkflowEventType.PAUSE): WorkflowStatus.PAUSED,
    (WorkflowStatus.IN_PROGRESS, WorkflowEventType.COMPLETE): WorkflowStatus.COMPLETED,
    (WorkflowStatus.IN_PROGRESS, WorkflowEventType.FAIL): WorkflowStatus.FAILED,
    (WorkflowStatus.IN_PROGRESS, WorkflowEventType.CANCEL): WorkflowStatus.CANCELLED,
    # From PAUSED
    (WorkflowStatus.PAUSED, WorkflowEventType.RESUME): WorkflowStatus.IN_PROGRESS,
    (WorkflowStatus.PAUSED, WorkflowEventType.CANCEL): WorkflowStatus.CANCELLED,
    # From FAILED
    (WorkflowStatus.FAILED, WorkflowEventType.RETRY): WorkflowStatus.QUEUED,
    (WorkflowStatus.FAILED, WorkflowEventType.CANCEL): WorkflowStatus.CANCELLED,
}


def get_next_status(
    current_status: WorkflowStatus, event_type: WorkflowEventType
) -> WorkflowStatus | None:
    """
    Deterministically retrieve the target WorkflowStatus given a current status and event.

    Parameters
    ----------
    current_status
        Current WorkflowStatus enum instance.
    event_type
        WorkflowEventType enum instance representing the transition trigger.

    Returns
    -------
    WorkflowStatus | None
        Target WorkflowStatus if the transition edge is valid; None otherwise.
    """
    if not isinstance(current_status, WorkflowStatus):
        raise TypeError(
            f"current_status must be a WorkflowStatus enum instance; got {type(current_status)!r}"
        )
    if not isinstance(event_type, WorkflowEventType):
        raise TypeError(
            f"event_type must be a WorkflowEventType enum instance; got {type(event_type)!r}"
        )

    return _TRANSITION_MAP.get((current_status, event_type))
