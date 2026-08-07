"""
business/registry.py
====================

Thread-safe in-memory registry for canonical Business domain models.

Design Rules
------------
- Mirrors engine registry architectural patterns.
- Guarantees thread-safety via `threading.RLock`.
- Container for Business models: does NOT expose `update()` method to maintain model immutability.
- Rejects duplicate `business_id` registrations with ValueError.
- Raises `KeyError` for unknown lookups in `get()`.
"""

from __future__ import annotations

import threading
from business.models import Business


class BusinessRegistry:
    """
    Thread-safe in-memory registry for Business domain models.
    """

    def __init__(self) -> None:
        self._businesses: dict[str, Business] = {}
        self._lock: threading.RLock = threading.RLock()

    def register(self, business: Business) -> None:
        """
        Register a Business model. Rejects duplicate business_id.
        """
        if not isinstance(business, Business):
            raise TypeError(f"business must be a Business instance; got {type(business)!r}")

        with self._lock:
            if business.business_id in self._businesses:
                raise ValueError(
                    f"Business with ID {business.business_id!r} is already registered."
                )
            self._businesses[business.business_id] = business

    def get(self, business_id: str) -> Business:
        """
        Retrieve a registered Business by business_id.
        Raises KeyError if business_id is not registered.
        """
        with self._lock:
            if business_id not in self._businesses:
                raise KeyError(f"Business {business_id!r} not found in registry.")
            return self._businesses[business_id]

    def exists(self, business_id: str) -> bool:
        """
        Return True if business_id is registered.
        """
        with self._lock:
            return business_id in self._businesses

    def ids(self) -> tuple[str, ...]:
        """
        Return tuple of registered business IDs in insertion order.
        """
        with self._lock:
            return tuple(self._businesses.keys())

    def all(self) -> tuple[Business, ...]:
        """
        Return tuple of all registered Business models in insertion order.
        """
        with self._lock:
            return tuple(self._businesses.values())

    def remove(self, business_id: str) -> bool:
        """
        Remove business_id from registry. Return True if removed, False if not present.
        """
        with self._lock:
            if business_id in self._businesses:
                del self._businesses[business_id]
                return True
            return False
