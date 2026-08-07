"""
provider_execution/models.py
============================

Immutable domain models for Provider Execution.

Design Rules
------------
- Frozen, slotted dataclass — runtime mutation is impossible.
- Collection fields are stored as immutable `tuple`.
- Represents execution-level state only — no engine, scheduler, or persistence logic.
- Strict isolation: may consume immutable models from `discovery.models` (ProviderDiscoveryRequest) and `provider_execution.state`.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import datetime

from discovery.models import ProviderDiscoveryRequest
from provider_execution.state import ProviderExecutionState, TERMINAL_STATES

_ID_PATTERN: re.Pattern[str] = re.compile(r"^[a-zA-Z0-9_-]+$")


def _validate_non_empty_str(value: str, label: str) -> None:
    """
    Raise ValueError if value is not a non-empty string.
    """
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{label} must be a non-empty string; got {value!r}")


@dataclass(frozen=True, slots=True)
class ProviderExecution:
    """
    Immutable domain model representing the runtime execution state of an
    individual provider execution within a Discovery Session.

    Fields
    ------
    execution_id
        Unique execution identifier (e.g. 'exec_google_maps_01').
    session_id
        Owning Discovery Session identifier (e.g. 'session_a1b2c3d4').
    provider_id
        Target provider identifier (e.g. 'google_maps').
    created_at
        Timestamp when the execution was created.
    started_at
        Optional timestamp when the execution actually started running.
    completed_at
        Optional timestamp when the execution completed, failed, or was cancelled.
    current_state
        Current ProviderExecutionState (default: CREATED).
    attempt_number
        Execution attempt index (1-based, default: 1).
    request
        Optional reference to the immutable ProviderDiscoveryRequest being executed.
    provider_request_id
        Optional explicit identifier for the associated provider discovery request.
    """

    execution_id: str
    session_id: str
    provider_id: str
    created_at: datetime
    started_at: datetime | None = None
    completed_at: datetime | None = None
    current_state: ProviderExecutionState = ProviderExecutionState.CREATED
    attempt_number: int = 1
    request: ProviderDiscoveryRequest | None = None
    provider_request_id: str = ""

    def __post_init__(self) -> None:
        _validate_non_empty_str(self.execution_id, "execution_id")
        _validate_non_empty_str(self.session_id, "session_id")
        _validate_non_empty_str(self.provider_id, "provider_id")

        if not isinstance(self.created_at, datetime):
            raise TypeError(f"created_at must be a datetime instance; got {type(self.created_at)!r}")

        if self.started_at is not None and not isinstance(self.started_at, datetime):
            raise TypeError(f"started_at must be a datetime instance or None; got {type(self.started_at)!r}")

        if self.completed_at is not None and not isinstance(self.completed_at, datetime):
            raise TypeError(f"completed_at must be a datetime instance or None; got {type(self.completed_at)!r}")

        if not isinstance(self.attempt_number, int) or self.attempt_number < 1:
            raise ValueError(f"attempt_number must be an integer >= 1; got {self.attempt_number!r}")

        if self.request is not None and not isinstance(self.request, ProviderDiscoveryRequest):
            raise TypeError(
                f"request must be a ProviderDiscoveryRequest instance or None; got {type(self.request)!r}"
            )

        if self.request is not None and self.request.provider_id != self.provider_id:
            raise ValueError(
                f"provider_id {self.provider_id!r} does not match request provider_id {self.request.provider_id!r}"
            )

        if not isinstance(self.provider_request_id, str):
            raise TypeError(f"provider_request_id must be a string; got {type(self.provider_request_id)!r}")

        # Coerce current_state enum if string passed
        if isinstance(self.current_state, str) and not isinstance(self.current_state, ProviderExecutionState):
            object.__setattr__(self, "current_state", ProviderExecutionState(self.current_state))

    @property
    def is_running(self) -> bool:
        """Return True if the execution is currently in RUNNING state."""
        return self.current_state == ProviderExecutionState.RUNNING

    @property
    def is_pending(self) -> bool:
        """Return True if the execution is currently in PENDING state."""
        return self.current_state == ProviderExecutionState.PENDING

    @property
    def has_failed(self) -> bool:
        """Return True if the execution is in FAILED state."""
        return self.current_state == ProviderExecutionState.FAILED

    @property
    def has_been_cancelled(self) -> bool:
        """Return True if the execution is in CANCELLED state."""
        return self.current_state == ProviderExecutionState.CANCELLED

    @property
    def is_terminal(self) -> bool:
        """Return True if the execution is in a terminal state."""
        return self.current_state in TERMINAL_STATES
