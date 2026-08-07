"""
workflow/service.py
===================

Stateless domain service for Workflow Engine (Subsystem 15) in the MAST Lead Engine 2.0.

Design Rules
------------
- Pure derived evaluation output — zero mutable state, zero side effects.
- Accepts canonical Mission contract from Subsystem 14 to initialize workflow.
- Evaluates transition rules deterministically via transitions.py.
- Tuple coercion on inputs and outputs for batch operations.
- Zero hidden clocks, zero registries, zero managers, zero thread synchronization issues.
"""

from __future__ import annotations

from typing import Iterable

from mission_generation.models import Mission
from workflow.models import (
    WorkflowEvent,
    WorkflowState,
    WorkflowStatus,
    WorkflowTransitionResult,
)
from workflow.transitions import get_next_status


class WorkflowEngineService:
    """
    Stateless domain service governing Workflow lifecycle initialization and transitions.
    """

    @staticmethod
    def initialize_workflow(mission: Mission) -> WorkflowState:
        """
        Pure, deterministic initialization of a WorkflowState from a derived Mission contract.

        Parameters
        ----------
        mission
            Immutable Mission contract derived from Subsystem 14 (mission_generation).

        Returns
        -------
        WorkflowState
            Initial WorkflowState contract in UNSTARTED status.
        """
        if mission is None:
            raise TypeError("mission must not be None")

        if not isinstance(mission, Mission):
            raise TypeError(
                f"mission must be a Mission instance; got {type(mission)!r}"
            )

        return WorkflowState(
            mission_id=mission.opportunity_id,
            opportunity_id=mission.opportunity_id,
            business_id=mission.business_id,
            status=WorkflowStatus.UNSTARTED,
        )

    @staticmethod
    def transition(
        current_state: WorkflowState,
        event: WorkflowEvent,
    ) -> WorkflowTransitionResult:
        """
        Pure, deterministic transition evaluation for a single WorkflowState and WorkflowEvent.

        Parameters
        ----------
        current_state
            Current WorkflowState instance.
        event
            WorkflowEvent instance representing the transition trigger.

        Returns
        -------
        WorkflowTransitionResult
            Immutable result indicating transition outcome, previous state, and new state.
        """
        if current_state is None:
            raise TypeError("current_state must not be None")
        if event is None:
            raise TypeError("event must not be None")

        if not isinstance(current_state, WorkflowState):
            raise TypeError(
                f"current_state must be a WorkflowState instance; got {type(current_state)!r}"
            )

        if not isinstance(event, WorkflowEvent):
            raise TypeError(
                f"event must be a WorkflowEvent instance; got {type(event)!r}"
            )

        next_status = get_next_status(current_state.status, event.event_type)

        if next_status is None:
            return WorkflowTransitionResult(
                success=False,
                previous_state=current_state,
                new_state=current_state,
                applied_event=event,
                error_message=(
                    f"Invalid status transition from {current_state.status.value!r} "
                    f"via event {event.event_type.value!r}"
                ),
            )

        new_state = WorkflowState(
            mission_id=current_state.mission_id,
            opportunity_id=current_state.opportunity_id,
            business_id=current_state.business_id,
            status=next_status,
        )

        return WorkflowTransitionResult(
            success=True,
            previous_state=current_state,
            new_state=new_state,
            applied_event=event,
            error_message=None,
        )

    @staticmethod
    def batch_transition(
        pairs: Iterable[tuple[WorkflowState, WorkflowEvent]],
    ) -> tuple[WorkflowTransitionResult, ...]:
        """
        Pure, deterministic bulk evaluation of (WorkflowState, WorkflowEvent) transition pairs.

        Parameters
        ----------
        pairs
            Iterable of (WorkflowState, WorkflowEvent) 2-tuples.

        Returns
        -------
        tuple[WorkflowTransitionResult, ...]
            Immutable tuple of transition results, preserving input order.
        """
        if pairs is None:
            raise TypeError("pairs must not be None")

        pairs_tuple = tuple(pairs)

        results = []
        for idx, item in enumerate(pairs_tuple):
            if not isinstance(item, tuple) or len(item) != 2:
                raise TypeError(
                    f"Item at index {idx} in pairs must be a 2-tuple of (WorkflowState, WorkflowEvent); got {item!r}"
                )
            state, event = item
            results.append(WorkflowEngineService.transition(state, event))

        return tuple(results)
