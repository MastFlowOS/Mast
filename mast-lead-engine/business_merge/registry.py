"""
business_merge/registry.py
==========================

Thread-safe Business Merge Registry for the MAST Lead Engine.

Design Rules
------------
- Pure in-memory container storing BusinessMergeResult instances indexed by identity_id and merged_business_id.
- Thread-safe via threading.RLock.
- Duplicate protection: raises ValueError on duplicate identity_id or merged_business_id.
- Missing ID protection: raises KeyError on unknown identity lookup.
- Lack of update() method: mutating existing entries is strictly forbidden.
"""

from __future__ import annotations

import threading
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from .models import BusinessMergeResult


class BusinessMergeRegistry:
    """
    Thread-safe in-memory registry for BusinessMergeResult objects.
    """

    __slots__ = ("_lock", "_by_identity_id", "_by_merged_business_id")

    def __init__(self) -> None:
        self._lock: threading.RLock = threading.RLock()
        self._by_identity_id: dict[str, BusinessMergeResult] = {}
        self._by_merged_business_id: dict[str, BusinessMergeResult] = {}

    def register(self, result: BusinessMergeResult) -> None:
        """
        Register a new BusinessMergeResult instance.

        Raises
        ------
        TypeError
            If result is not a BusinessMergeResult instance.
        ValueError
            If result.provenance.identity_id or result.business.business_id is already registered.
        """
        from .models import BusinessMergeResult

        if not isinstance(result, BusinessMergeResult):
            raise TypeError(f"Expected BusinessMergeResult instance; got {type(result)!r}")

        identity_id = result.provenance.identity_id
        merged_id = result.business.business_id

        with self._lock:
            if identity_id in self._by_identity_id:
                raise ValueError(f"BusinessMergeResult with identity_id {identity_id!r} is already registered.")

            if merged_id in self._by_merged_business_id:
                raise ValueError(f"BusinessMergeResult with merged_business_id {merged_id!r} is already registered.")

            self._by_identity_id[identity_id] = result
            self._by_merged_business_id[merged_id] = result

    def get_by_identity_id(self, identity_id: str) -> BusinessMergeResult:
        """
        Retrieve a registered BusinessMergeResult by identity_id.

        Raises
        ------
        KeyError
            If identity_id is not found in the registry.
        """
        with self._lock:
            if identity_id not in self._by_identity_id:
                raise KeyError(f"No BusinessMergeResult registered for identity_id {identity_id!r}")
            return self._by_identity_id[identity_id]

    def get_by_merged_business_id(self, merged_business_id: str) -> BusinessMergeResult:
        """
        Retrieve a registered BusinessMergeResult by merged_business_id.

        Raises
        ------
        KeyError
            If merged_business_id is not found in the registry.
        """
        with self._lock:
            if merged_business_id not in self._by_merged_business_id:
                raise KeyError(f"No BusinessMergeResult registered for merged_business_id {merged_business_id!r}")
            return self._by_merged_business_id[merged_business_id]

    def exists(self, identity_id: str) -> bool:
        """Return True if a BusinessMergeResult for identity_id is registered."""
        with self._lock:
            return identity_id in self._by_identity_id

    def all(self) -> tuple[BusinessMergeResult, ...]:
        """Return immutable tuple of all registered BusinessMergeResult objects in registration order."""
        with self._lock:
            return tuple(self._by_identity_id.values())

    def remove(self, identity_id: str) -> bool:
        """
        Remove a BusinessMergeResult by identity_id.

        Returns
        -------
        bool
            True if removed, False if identity_id was not found.
        """
        with self._lock:
            if identity_id in self._by_identity_id:
                res = self._by_identity_id.pop(identity_id)
                self._by_merged_business_id.pop(res.business.business_id, None)
                return True
            return False
