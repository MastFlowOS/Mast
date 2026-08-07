"""
discovery_sessions/lifecycle.py
===============================

Stateless lifecycle service for Discovery Sessions.

Design Rules
------------
- Stateless operations: creates and returns new immutable `DiscoverySession` instances.
- Never mutates an existing session object.
- Time ownership remains strictly with the caller: all timestamp parameters must be explicitly supplied.
- Enforces valid state transitions using `is_valid_session_transition`.
"""

from __future__ import annotations

import uuid
from dataclasses import replace
from datetime import datetime
from typing import Sequence

from discovery.models import CompiledDiscovery
from discovery_sessions.models import DiscoverySession
from discovery_sessions.state import DiscoverySessionState, is_valid_session_transition


class DiscoverySessionLifecycle:
    """
    Stateless service managing Discovery Session state transitions and instantiation.
    """

    @staticmethod
    def create(
        workspace_id: str,
        niche_id: str,
        compiled_discovery: CompiledDiscovery,
        created_at: datetime,
        session_id: str | None = None,
        participating_provider_ids: Sequence[str] | None = None,
    ) -> DiscoverySession:
        """
        Create a new DiscoverySession in CREATED state.

        Parameters
        ----------
        workspace_id
            Owning workspace ID.
        niche_id
            Target niche ID.
        compiled_discovery
            CompiledDiscovery instance representing intent and requests.
        created_at
            Explicit creation timestamp provided by caller.
        session_id
            Optional custom session ID. Auto-generated if omitted.
        participating_provider_ids
            Optional explicit sequence of participating provider IDs.
            Derived from compiled_discovery if omitted.
        """
        if not isinstance(created_at, datetime):
            raise TypeError(f"created_at must be a datetime instance; got {type(created_at)!r}")

        sid = session_id if session_id else f"session_{uuid.uuid4().hex[:12]}"

        providers_tuple: tuple[str, ...]
        if participating_provider_ids is not None:
            providers_tuple = tuple(participating_provider_ids)
        else:
            providers_tuple = tuple(req.provider_id for req in compiled_discovery.requests)

        return DiscoverySession(
            session_id=sid,
            workspace_id=workspace_id,
            niche_id=niche_id,
            compiled_discovery=compiled_discovery,
            created_at=created_at,
            current_state=DiscoverySessionState.CREATED,
            participating_provider_ids=providers_tuple,
        )

    @classmethod
    def _transition(
        cls,
        session: DiscoverySession,
        target_state: DiscoverySessionState,
        **extra_fields,
    ) -> DiscoverySession:
        """
        Validate transition legality and return a new DiscoverySession instance.
        """
        if not isinstance(session, DiscoverySession):
            raise TypeError(f"session must be a DiscoverySession instance; got {type(session)!r}")

        if not is_valid_session_transition(session.current_state, target_state):
            raise ValueError(
                f"Cannot transition DiscoverySession '{session.session_id}' "
                f"from illegal state '{session.current_state.value}' to '{target_state.value}'."
            )

        return replace(session, current_state=target_state, **extra_fields)

    @classmethod
    def start(cls, session: DiscoverySession, started_at: datetime) -> DiscoverySession:
        """
        Transition session from CREATED/PENDING to RUNNING.
        """
        if not isinstance(started_at, datetime):
            raise TypeError(f"started_at must be a datetime instance; got {type(started_at)!r}")

        return cls._transition(session, DiscoverySessionState.RUNNING, started_at=started_at)

    @classmethod
    def pause(cls, session: DiscoverySession) -> DiscoverySession:
        """
        Transition session to PAUSED state.
        """
        return cls._transition(session, DiscoverySessionState.PAUSED)

    @classmethod
    def resume(cls, session: DiscoverySession) -> DiscoverySession:
        """
        Transition session from PAUSED to RUNNING state.
        """
        return cls._transition(session, DiscoverySessionState.RUNNING)

    @classmethod
    def cancel(cls, session: DiscoverySession, cancelled_at: datetime) -> DiscoverySession:
        """
        Transition session to CANCELLED state.
        """
        if not isinstance(cancelled_at, datetime):
            raise TypeError(f"cancelled_at must be a datetime instance; got {type(cancelled_at)!r}")

        return cls._transition(session, DiscoverySessionState.CANCELLED, completed_at=cancelled_at)

    @classmethod
    def complete(cls, session: DiscoverySession, completed_at: datetime) -> DiscoverySession:
        """
        Transition session to COMPLETED state.
        """
        if not isinstance(completed_at, datetime):
            raise TypeError(f"completed_at must be a datetime instance; got {type(completed_at)!r}")

        return cls._transition(session, DiscoverySessionState.COMPLETED, completed_at=completed_at)

    @classmethod
    def fail(cls, session: DiscoverySession, failed_at: datetime) -> DiscoverySession:
        """
        Transition session to FAILED state.
        """
        if not isinstance(failed_at, datetime):
            raise TypeError(f"failed_at must be a datetime instance; got {type(failed_at)!r}")

        return cls._transition(session, DiscoverySessionState.FAILED, completed_at=failed_at)
