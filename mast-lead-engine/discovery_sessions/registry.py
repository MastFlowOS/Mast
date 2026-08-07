"""
discovery_sessions/registry.py
==============================

Thread-safe registry for DiscoverySession domain models.

Design Rules
------------
- Mirrors engine registry architectural patterns (NicheRegistry, DiscoveryTemplateRegistry).
- Guarantees thread-safety via `threading.RLock`.
- Rejects duplicate `session_id` registrations.
- Raises `KeyError` for unknown lookups in `get()`.
"""

from __future__ import annotations

import threading
from discovery_sessions.models import DiscoverySession


class DiscoverySessionRegistry:
    """
    Thread-safe in-memory registry for DiscoverySession instances.
    """

    def __init__(self) -> None:
        self._sessions: dict[str, DiscoverySession] = {}
        self._lock: threading.RLock = threading.RLock()

    def register(self, session: DiscoverySession) -> None:
        """
        Register a DiscoverySession. Rejects duplicate session_id.
        """
        if not isinstance(session, DiscoverySession):
            raise TypeError(f"session must be a DiscoverySession instance; got {type(session)!r}")

        with self._lock:
            if session.session_id in self._sessions:
                raise ValueError(
                    f"DiscoverySession with ID {session.session_id!r} is already registered."
                )
            self._sessions[session.session_id] = session

    def get(self, session_id: str) -> DiscoverySession:
        """
        Retrieve a registered DiscoverySession by session_id.
        Raises KeyError if session_id is not registered.
        """
        with self._lock:
            if session_id not in self._sessions:
                raise KeyError(f"DiscoverySession {session_id!r} not found in registry.")
            return self._sessions[session_id]

    def exists(self, session_id: str) -> bool:
        """
        Return True if session_id is registered.
        """
        with self._lock:
            return session_id in self._sessions

    def ids(self) -> tuple[str, ...]:
        """
        Return tuple of registered session IDs in insertion order.
        """
        with self._lock:
            return tuple(self._sessions.keys())

    def all(self) -> tuple[DiscoverySession, ...]:
        """
        Return tuple of all registered DiscoverySessions in insertion order.
        """
        with self._lock:
            return tuple(self._sessions.values())

    def remove(self, session_id: str) -> bool:
        """
        Remove session_id from registry. Return True if removed, False if not present.
        """
        with self._lock:
            if session_id in self._sessions:
                del self._sessions[session_id]
                return True
            return False
