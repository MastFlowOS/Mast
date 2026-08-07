"""
discovery_sessions/models.py
=============================

Immutable domain models for Discovery Sessions.

Design Rules
------------
- Frozen, slotted dataclass — runtime mutation is impossible.
- Collection fields are stored as immutable `tuple`.
- Represents session-level state only — no embedded provider execution state or computed statistics.
- Strict isolation: depends only on discovery.models (CompiledDiscovery) and discovery_sessions.state.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import datetime

from discovery.models import CompiledDiscovery
from discovery_sessions.state import DiscoverySessionState, TERMINAL_STATES

_ID_PATTERN: re.Pattern[str] = re.compile(r"^[a-zA-Z0-9_-]+$")


def _validate_non_empty_str(value: str, label: str) -> None:
    """
    Raise ValueError if value is not a non-empty string.
    """
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{label} must be a non-empty string; got {value!r}")


@dataclass(frozen=True, slots=True)
class DiscoverySession:
    """
    Immutable domain model representing the runtime state of a Discovery Session.

    Invariant
    ---------
    ``participating_provider_ids`` is immutable after session creation. If provider
    selection changes, a new session must be compiled and created.

    Fields
    ------
    session_id
        Unique session identifier (e.g., 'session_a1b2c3d4').
    workspace_id
        Owning workspace identifier.
    niche_id
        Target niche identifier.
    compiled_discovery
        The compiled discovery model representing intent and provider requests.
    created_at
        Timestamp when the session was created.
    started_at
        Optional timestamp when the session was started.
    completed_at
        Optional timestamp when the session reached a terminal state.
    current_state
        Current DiscoverySessionState (default: CREATED).
    participating_provider_ids
        Immutable tuple of participating provider IDs.
    """

    session_id: str
    workspace_id: str
    niche_id: str
    compiled_discovery: CompiledDiscovery
    created_at: datetime
    started_at: datetime | None = None
    completed_at: datetime | None = None
    current_state: DiscoverySessionState = DiscoverySessionState.CREATED
    participating_provider_ids: tuple[str, ...] = ()

    def __post_init__(self) -> None:
        _validate_non_empty_str(self.session_id, "session_id")
        _validate_non_empty_str(self.workspace_id, "workspace_id")
        _validate_non_empty_str(self.niche_id, "niche_id")

        if not isinstance(self.compiled_discovery, CompiledDiscovery):
            raise TypeError(
                f"compiled_discovery must be a CompiledDiscovery instance; got {type(self.compiled_discovery)!r}"
            )

        if not isinstance(self.created_at, datetime):
            raise TypeError(f"created_at must be a datetime instance; got {type(self.created_at)!r}")

        if self.started_at is not None and not isinstance(self.started_at, datetime):
            raise TypeError(f"started_at must be a datetime instance or None; got {type(self.started_at)!r}")

        if self.completed_at is not None and not isinstance(self.completed_at, datetime):
            raise TypeError(f"completed_at must be a datetime instance or None; got {type(self.completed_at)!r}")

        # Coerce current_state enum if string passed
        if isinstance(self.current_state, str) and not isinstance(self.current_state, DiscoverySessionState):
            object.__setattr__(self, "current_state", DiscoverySessionState(self.current_state))

        # Coerce participating_provider_ids to tuple
        providers: tuple[str, ...]
        if not isinstance(self.participating_provider_ids, tuple):
            providers = tuple(self.participating_provider_ids)
        else:
            providers = self.participating_provider_ids

        # If no participating_provider_ids explicitly provided, populate from compiled_discovery
        if not providers and self.compiled_discovery.requests:
            providers = tuple(req.provider_id for req in self.compiled_discovery.requests)

        for p_id in providers:
            _validate_non_empty_str(p_id, "participating_provider_id")

        object.__setattr__(self, "participating_provider_ids", providers)

    # ---------------------------------------------------------------------------
    # Helper Query Properties (Session-level state checks)
    # ---------------------------------------------------------------------------

    @property
    def can_pause(self) -> bool:
        """Return True if the session can be paused."""
        return self.current_state in (DiscoverySessionState.RUNNING, DiscoverySessionState.PENDING)

    @property
    def can_resume(self) -> bool:
        """Return True if the session can be resumed."""
        return self.current_state == DiscoverySessionState.PAUSED

    @property
    def can_cancel(self) -> bool:
        """Return True if the session can be cancelled."""
        return self.current_state not in TERMINAL_STATES

    @property
    def is_completed(self) -> bool:
        """Return True if the session is completed."""
        return self.current_state == DiscoverySessionState.COMPLETED

    @property
    def is_terminal(self) -> bool:
        """Return True if the session is in a terminal state."""
        return self.current_state in TERMINAL_STATES
