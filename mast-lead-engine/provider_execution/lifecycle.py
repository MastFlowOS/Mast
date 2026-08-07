"""
provider_execution/lifecycle.py
==============================

Stateless lifecycle service for Provider Execution.

Design Rules
------------
- Stateless operations: creates and returns new immutable `ProviderExecution` instances.
- Never mutates an existing execution object.
- Time ownership remains strictly with the caller: all timestamp parameters must be explicitly supplied.
- Enforces valid state transitions using `is_valid_execution_transition`.
"""

from __future__ import annotations

import uuid
from dataclasses import replace
from datetime import datetime

from discovery.models import ProviderDiscoveryRequest
from provider_execution.models import ProviderExecution
from provider_execution.state import ProviderExecutionState, is_valid_execution_transition


class ProviderExecutionLifecycle:
    """
    Stateless service managing Provider Execution state transitions and instantiation.
    """

    @staticmethod
    def create(
        session_id: str,
        provider_id: str,
        created_at: datetime,
        execution_id: str | None = None,
        attempt_number: int = 1,
        request: ProviderDiscoveryRequest | None = None,
        provider_request_id: str = "",
    ) -> ProviderExecution:
        """
        Create a new ProviderExecution in CREATED state.

        Parameters
        ----------
        session_id
            Owning Discovery Session ID.
        provider_id
            Target provider ID.
        created_at
            Explicit creation timestamp provided by caller.
        execution_id
            Optional custom execution ID. Auto-generated if omitted.
        attempt_number
            Execution attempt number (default 1).
        request
            Optional ProviderDiscoveryRequest object being executed.
        provider_request_id
            Optional string identifier for the provider request.
        """
        if not isinstance(created_at, datetime):
            raise TypeError(f"created_at must be a datetime instance; got {type(created_at)!r}")

        exec_id = execution_id if execution_id else f"exec_{provider_id}_{uuid.uuid4().hex[:12]}"

        return ProviderExecution(
            execution_id=exec_id,
            session_id=session_id,
            provider_id=provider_id,
            created_at=created_at,
            current_state=ProviderExecutionState.CREATED,
            attempt_number=attempt_number,
            request=request,
            provider_request_id=provider_request_id,
        )

    @classmethod
    def _transition(
        cls,
        execution: ProviderExecution,
        target_state: ProviderExecutionState,
        **extra_fields,
    ) -> ProviderExecution:
        """
        Validate transition legality and return a new ProviderExecution instance.
        """
        if not isinstance(execution, ProviderExecution):
            raise TypeError(f"execution must be a ProviderExecution instance; got {type(execution)!r}")

        if not is_valid_execution_transition(execution.current_state, target_state):
            raise ValueError(
                f"Cannot transition ProviderExecution '{execution.execution_id}' "
                f"from illegal state '{execution.current_state.value}' to '{target_state.value}'."
            )

        return replace(execution, current_state=target_state, **extra_fields)

    @classmethod
    def enqueue(cls, execution: ProviderExecution) -> ProviderExecution:
        """
        Transition execution to PENDING state.
        """
        return cls._transition(execution, ProviderExecutionState.PENDING)

    @classmethod
    def start(cls, execution: ProviderExecution, started_at: datetime) -> ProviderExecution:
        """
        Transition execution to RUNNING state with an explicit start timestamp.
        """
        if not isinstance(started_at, datetime):
            raise TypeError(f"started_at must be a datetime instance; got {type(started_at)!r}")

        return cls._transition(execution, ProviderExecutionState.RUNNING, started_at=started_at)

    @classmethod
    def complete(cls, execution: ProviderExecution, completed_at: datetime) -> ProviderExecution:
        """
        Transition execution to COMPLETED terminal state with an explicit completion timestamp.
        """
        if not isinstance(completed_at, datetime):
            raise TypeError(f"completed_at must be a datetime instance; got {type(completed_at)!r}")

        return cls._transition(execution, ProviderExecutionState.COMPLETED, completed_at=completed_at)

    @classmethod
    def fail(cls, execution: ProviderExecution, completed_at: datetime) -> ProviderExecution:
        """
        Transition execution to FAILED terminal state with an explicit completion timestamp.
        """
        if not isinstance(completed_at, datetime):
            raise TypeError(f"completed_at must be a datetime instance; got {type(completed_at)!r}")

        return cls._transition(execution, ProviderExecutionState.FAILED, completed_at=completed_at)

    @classmethod
    def cancel(cls, execution: ProviderExecution, completed_at: datetime | None = None) -> ProviderExecution:
        """
        Transition execution to CANCELLED terminal state with an optional completion timestamp.
        """
        if completed_at is not None and not isinstance(completed_at, datetime):
            raise TypeError(f"completed_at must be a datetime instance or None; got {type(completed_at)!r}")

        extra = {}
        if completed_at is not None:
            extra["completed_at"] = completed_at

        return cls._transition(execution, ProviderExecutionState.CANCELLED, **extra)
