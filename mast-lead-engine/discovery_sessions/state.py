"""
discovery_sessions/state.py
============================

Domain states and legal transition definitions for Discovery Sessions.

Design Rules
------------
- Pure state definitions and transition validation logic.
- Performs no execution or runtime state mutation.
- Does not depend on external services or execution engine.
"""

from __future__ import annotations

from enum import Enum


class DiscoverySessionState(str, Enum):
    """
    Lifecycle states for a DiscoverySession.
    """
    CREATED = "created"
    PENDING = "pending"
    RUNNING = "running"
    PAUSED = "paused"
    COMPLETED = "completed"
    CANCELLED = "cancelled"
    FAILED = "failed"


# Terminal states from which no further transitions are allowed
TERMINAL_STATES: tuple[DiscoverySessionState, ...] = (
    DiscoverySessionState.COMPLETED,
    DiscoverySessionState.CANCELLED,
    DiscoverySessionState.FAILED,
)

# Graph of allowed state transitions
_VALID_TRANSITIONS: dict[DiscoverySessionState, tuple[DiscoverySessionState, ...]] = {
    DiscoverySessionState.CREATED: (
        DiscoverySessionState.PENDING,
        DiscoverySessionState.RUNNING,
        DiscoverySessionState.CANCELLED,
    ),
    DiscoverySessionState.PENDING: (
        DiscoverySessionState.RUNNING,
        DiscoverySessionState.PAUSED,
        DiscoverySessionState.CANCELLED,
        DiscoverySessionState.FAILED,
    ),
    DiscoverySessionState.RUNNING: (
        DiscoverySessionState.PAUSED,
        DiscoverySessionState.COMPLETED,
        DiscoverySessionState.FAILED,
        DiscoverySessionState.CANCELLED,
    ),
    DiscoverySessionState.PAUSED: (
        DiscoverySessionState.RUNNING,
        DiscoverySessionState.CANCELLED,
        DiscoverySessionState.FAILED,
    ),
    DiscoverySessionState.COMPLETED: (),
    DiscoverySessionState.CANCELLED: (),
    DiscoverySessionState.FAILED: (),
}


def is_valid_session_transition(
    from_state: DiscoverySessionState | str,
    to_state: DiscoverySessionState | str,
) -> bool:
    """
    Return True if transitioning from *from_state* to *to_state* is legal.
    """
    try:
        source = DiscoverySessionState(from_state)
        target = DiscoverySessionState(to_state)
    except ValueError:
        return False

    return target in _VALID_TRANSITIONS.get(source, ())
