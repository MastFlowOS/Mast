"""
opportunities/registry.py
==========================

Thread-safe in-memory registry for canonical Opportunity domain models.

Design Rules
------------
- Mirrors engine registry architectural patterns.
- Guarantees thread-safety via `threading.RLock`.
- Container for Opportunity models: does NOT expose `update()` method to maintain model immutability.
- Rejects duplicate `opportunity_id` registrations with ValueError.
- Raises `KeyError` for unknown lookups in `get()`.
"""

from __future__ import annotations

import threading
from opportunities.models import Opportunity


class OpportunityRegistry:
    """
    Thread-safe in-memory registry for Opportunity domain models.
    """

    def __init__(self) -> None:
        self._opportunities: dict[str, Opportunity] = {}
        self._lock: threading.RLock = threading.RLock()

    def register(self, opportunity: Opportunity) -> None:
        """
        Register an Opportunity model. Rejects duplicate opportunity_id.
        """
        if not isinstance(opportunity, Opportunity):
            raise TypeError(
                f"opportunity must be an Opportunity instance; got {type(opportunity)!r}"
            )

        with self._lock:
            if opportunity.opportunity_id in self._opportunities:
                raise ValueError(
                    f"Opportunity with ID {opportunity.opportunity_id!r} is already registered."
                )
            self._opportunities[opportunity.opportunity_id] = opportunity

    def get(self, opportunity_id: str) -> Opportunity:
        """
        Retrieve a registered Opportunity by opportunity_id.
        Raises KeyError if opportunity_id is not registered.
        """
        with self._lock:
            if opportunity_id not in self._opportunities:
                raise KeyError(f"Opportunity {opportunity_id!r} not found in registry.")
            return self._opportunities[opportunity_id]

    def exists(self, opportunity_id: str) -> bool:
        """
        Return True if opportunity_id is registered.
        """
        with self._lock:
            return opportunity_id in self._opportunities

    def ids(self) -> tuple[str, ...]:
        """
        Return tuple of registered opportunity IDs in insertion order.
        """
        with self._lock:
            return tuple(self._opportunities.keys())

    def all(self) -> tuple[Opportunity, ...]:
        """
        Return tuple of all registered Opportunity models in insertion order.
        """
        with self._lock:
            return tuple(self._opportunities.values())

    def remove(self, opportunity_id: str) -> bool:
        """
        Remove opportunity_id from registry. Return True if removed, False if not present.
        """
        with self._lock:
            if opportunity_id in self._opportunities:
                del self._opportunities[opportunity_id]
                return True
            return False
