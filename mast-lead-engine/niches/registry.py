"""
niches/registry.py
==================

Thread-safe registry for ``Niche`` domain models.

Design rules
------------
- Mirrors the architectural quality of ``ProviderRegistry``:
  ``register()`` / ``get()`` / ``exists()`` / ``ids()`` / ``all()``.
- Rejects duplicate ``niche_id`` values at registration time.
- Raises ``KeyError`` for unknown lookups — never returns ``None``.
- All public methods are guarded by a reentrant lock.
- Construction is independent of any other subsystem.  The registry
  stores exactly what it is given at registration time.
- ``NicheRegistry`` does not manage categories.  Category ownership
  belongs entirely to ``Taxonomy``.
- No imports from engine/, providers/, intelligence/, storage/,
  scoring/, enrichment/, or contacts/.
"""

from __future__ import annotations

import threading

from niches.models import Niche


class NicheRegistry:
    """
    Thread-safe registry for ``Niche`` domain models.

    Stateful by necessity (it holds the registration table), but that
    state is purely configuration — which niches exist and what they
    describe.  It never holds mutable niche state; every ``Niche``
    stored here is itself immutable (frozen dataclass).

    Methods
    -------
    register(niche)
        Add *niche* to the registry.  Rejects duplicates.
    get(niche_id)
        Return the ``Niche`` registered under *niche_id*.
        Raises ``KeyError`` if not found.
    exists(niche_id)
        Return ``True`` if *niche_id* is registered.
    ids()
        Return all registered niche IDs in insertion order.
    all()
        Return all registered ``Niche`` instances in insertion order.
    """

    def __init__(self) -> None:
        self._niches: dict[str, Niche] = {}
        self._lock: threading.RLock = threading.RLock()

    # ------------------------------------------------------------------
    # Registration
    # ------------------------------------------------------------------

    def register(self, niche: Niche) -> None:
        """
        Register *niche* under its ``niche_id``.

        Raises
        ------
        TypeError
            *niche* is not a ``Niche`` instance.
        ValueError
            ``niche.niche_id`` is already registered.
        """
        if not isinstance(niche, Niche):
            raise TypeError(
                f"niche must be a Niche instance; got {type(niche)!r}"
            )
        with self._lock:
            if niche.niche_id in self._niches:
                raise ValueError(
                    f"niche_id {niche.niche_id!r} is already registered — "
                    "duplicate niche_ids are not allowed."
                )
            self._niches[niche.niche_id] = niche

    # ------------------------------------------------------------------
    # Lookup
    # ------------------------------------------------------------------

    def get(self, niche_id: str) -> Niche:
        """
        Return the ``Niche`` registered under *niche_id*.

        Raises
        ------
        KeyError
            *niche_id* is not registered.
        """
        with self._lock:
            if niche_id not in self._niches:
                raise KeyError(
                    f"niche_id {niche_id!r} is not registered in this "
                    "NicheRegistry."
                )
            return self._niches[niche_id]

    def exists(self, niche_id: str) -> bool:
        """Return ``True`` if *niche_id* is registered."""
        with self._lock:
            return niche_id in self._niches

    # ------------------------------------------------------------------
    # Introspection
    # ------------------------------------------------------------------

    def ids(self) -> tuple[str, ...]:
        """Return all registered niche IDs in insertion order."""
        with self._lock:
            return tuple(self._niches)

    def all(self) -> tuple[Niche, ...]:
        """Return all registered ``Niche`` instances in insertion order."""
        with self._lock:
            return tuple(self._niches.values())
