"""
provider_execution/state.py
===========================

Domain states and legal transition definitions for Provider Execution.

Design Rules
------------
- Pure state definitions and transition validation logic.
- Performs no execution or runtime state mutation.
- Does not depend on external services or execution engine.
"""

from __future__ import annotations

from enum import Enum


class ProviderExecutionState(str, Enum):
    """
    Lifecycle states for an individual ProviderExecution.
    """
    CREATED = "created"
    PENDING = "pending"
    RUNNING = "running"
    COMPLETED = "completed"
    FAILED = "failed"
    CANCELLED = "cancelled"


# Terminal states from which no further transitions are allowed
TERMINAL_STATES: tuple[ProviderExecutionState, ...] = (
    ProviderExecutionState.COMPLETED,
    ProviderExecutionState.FAILED,
    ProviderExecutionState.CANCELLED,
)

# Graph of allowed state transitions
_VALID_TRANSITIONS: dict[ProviderExecutionState, tuple[ProviderExecutionState, ...]] = {
    ProviderExecutionState.CREATED: (
        ProviderExecutionState.PENDING,
        ProviderExecutionState.RUNNING,
        ProviderExecutionState.CANCELLED,
    ),
    ProviderExecutionState.PENDING: (
        ProviderExecutionState.RUNNING,
        ProviderExecutionState.CANCELLED,
        ProviderExecutionState.FAILED,
    ),
    ProviderExecutionState.RUNNING: (
        ProviderExecutionState.COMPLETED,
        ProviderExecutionState.FAILED,
        ProviderExecutionState.CANCELLED,
    ),
    ProviderExecutionState.COMPLETED: (),
    ProviderExecutionState.FAILED: (),
    ProviderExecutionState.CANCELLED: (),
}


def is_valid_execution_transition(
    from_state: ProviderExecutionState | str,
    to_state: ProviderExecutionState | str,
) -> bool:
    """
    Return True if transitioning from *from_state* to *to_state* is legal.
    """
    try:
        source = ProviderExecutionState(from_state)
        target = ProviderExecutionState(to_state)
    except ValueError:
        return False

    return target in _VALID_TRANSITIONS.get(source, ())
