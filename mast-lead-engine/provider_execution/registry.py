"""
provider_execution/registry.py
=============================

Thread-safe registry for ProviderExecution domain models.

Design Rules
------------
- Mirrors engine registry architectural patterns.
- Guarantees thread-safety via `threading.RLock`.
- Dumb in-memory container: does NOT expose state update methods to prevent lifecycle bypass.
- Rejects duplicate `execution_id` registrations.
- Raises `KeyError` for unknown lookups in `get()`.
"""

from __future__ import annotations

import threading
from provider_execution.models import ProviderExecution


class ProviderExecutionRegistry:
    """
    Thread-safe in-memory registry for ProviderExecution instances.
    """

    def __init__(self) -> None:
        self._executions: dict[str, ProviderExecution] = {}
        self._lock: threading.RLock = threading.RLock()

    def register(self, execution: ProviderExecution) -> None:
        """
        Register a ProviderExecution. Rejects duplicate execution_id.
        """
        if not isinstance(execution, ProviderExecution):
            raise TypeError(f"execution must be a ProviderExecution instance; got {type(execution)!r}")

        with self._lock:
            if execution.execution_id in self._executions:
                raise ValueError(
                    f"ProviderExecution with ID {execution.execution_id!r} is already registered."
                )
            self._executions[execution.execution_id] = execution

    def get(self, execution_id: str) -> ProviderExecution:
        """
        Retrieve a registered ProviderExecution by execution_id.
        Raises KeyError if execution_id is not registered.
        """
        with self._lock:
            if execution_id not in self._executions:
                raise KeyError(f"ProviderExecution {execution_id!r} not found in registry.")
            return self._executions[execution_id]

    def exists(self, execution_id: str) -> bool:
        """
        Return True if execution_id is registered.
        """
        with self._lock:
            return execution_id in self._executions

    def ids(self) -> tuple[str, ...]:
        """
        Return tuple of registered execution IDs in insertion order.
        """
        with self._lock:
            return tuple(self._executions.keys())

    def all(self) -> tuple[ProviderExecution, ...]:
        """
        Return tuple of all registered ProviderExecutions in insertion order.
        """
        with self._lock:
            return tuple(self._executions.values())

    def remove(self, execution_id: str) -> bool:
        """
        Remove execution_id from registry. Return True if removed, False if not present.
        """
        with self._lock:
            if execution_id in self._executions:
                del self._executions[execution_id]
                return True
            return False
