"""
business_identity/registry.py
==============================

Thread-safe Business Identity Registry for the MAST Lead Engine.

Design Rules
------------
- Pure in-memory container storing BusinessIdentity instances by identity_id.
- Thread-safe via threading.RLock.
- Duplicate protection: raises ValueError on duplicate identity_id.
- Missing ID protection: raises KeyError on unknown identity_id lookup.
- Lack of update() method: mutating existing entries is forbidden.
- Pure storage: Does NOT enforce business ownership rules or cross-identity indexes.
"""

from __future__ import annotations

import threading
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from .models import BusinessIdentity


class BusinessIdentityRegistry:
    """
    Thread-safe, pure in-memory registry for BusinessIdentity objects.
    """

    __slots__ = ("_lock", "_identities")

    def __init__(self) -> None:
        self._lock: threading.RLock = threading.RLock()
        self._identities: dict[str, BusinessIdentity] = {}

    def register(self, identity: BusinessIdentity) -> None:
        """
        Register a new BusinessIdentity instance.

        Raises
        ------
        TypeError
            If identity is not a BusinessIdentity instance.
        ValueError
            If identity.identity_id is already registered.
        """
        from .models import BusinessIdentity

        if not isinstance(identity, BusinessIdentity):
            raise TypeError(f"Expected BusinessIdentity instance; got {type(identity)!r}")

        with self._lock:
            if identity.identity_id in self._identities:
                raise ValueError(f"BusinessIdentity with identity_id {identity.identity_id!r} is already registered.")

            self._identities[identity.identity_id] = identity

    def get(self, identity_id: str) -> BusinessIdentity:
        """
        Retrieve a registered BusinessIdentity by identity_id.

        Raises
        ------
        KeyError
            If identity_id is not found in the registry.
        """
        with self._lock:
            if identity_id not in self._identities:
                raise KeyError(f"No BusinessIdentity registered for identity_id {identity_id!r}")
            return self._identities[identity_id]

    def exists(self, identity_id: str) -> bool:
        """Return True if a BusinessIdentity with identity_id is registered."""
        with self._lock:
            return identity_id in self._identities

    def ids(self) -> tuple[str, ...]:
        """Return immutable tuple of all registered identity IDs in registration order."""
        with self._lock:
            return tuple(self._identities.keys())

    def all(self) -> tuple[BusinessIdentity, ...]:
        """Return immutable tuple of all registered BusinessIdentity objects in registration order."""
        with self._lock:
            return tuple(self._identities.values())

    def remove(self, identity_id: str) -> bool:
        """
        Remove a BusinessIdentity by identity_id.

        Returns
        -------
        bool
            True if removed, False if identity_id was not found.
        """
        with self._lock:
            if identity_id in self._identities:
                del self._identities[identity_id]
                return True
            return False
