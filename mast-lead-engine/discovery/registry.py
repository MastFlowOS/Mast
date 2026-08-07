"""
discovery/registry.py
====================

Thread-safe registry for ``DiscoveryTemplate`` domain models.

Design rules
------------
- Mirrors the architectural quality of ``NicheRegistry``:
  ``register()`` / ``get()`` / ``exists()`` / ``ids()`` / ``all()``.
- Rejects duplicate ``template_id`` or ``(provider_id, niche_id)`` combinations.
- Raises ``KeyError`` for unknown lookups — never returns ``None``.
- All public methods are guarded by a reentrant lock (``threading.RLock``).
- Construction is independent of any other subsystem.
- No imports from engine/, providers/ (except ProviderMetadata/ProviderCapabilities),
  intelligence/, storage/, database/, crm/, opportunities/, missions/, or ai/.
"""

from __future__ import annotations

import threading
from typing import Sequence

from discovery.templates import DiscoveryTemplate


class DiscoveryTemplateRegistry:
    """
    Thread-safe registry for static ``DiscoveryTemplate`` domain models.

    Methods
    -------
    register(template)
        Add *template* to the registry. Rejects duplicates.
    get(template_id)
        Return the ``DiscoveryTemplate`` registered under *template_id*.
        Raises ``KeyError`` if not found.
    get_for_provider_and_niche(provider_id, niche_id)
        Return the registered ``DiscoveryTemplate`` for *provider_id* and *niche_id*.
        Raises ``KeyError`` if not found.
    exists(template_id)
        Return ``True`` if *template_id* is registered.
    ids()
        Return all registered template IDs in insertion order.
    all()
        Return all registered ``DiscoveryTemplate`` instances in insertion order.
    """

    def __init__(self) -> None:
        self._templates: dict[str, DiscoveryTemplate] = {}
        self._provider_niche_map: dict[tuple[str, str], str] = {}
        self._lock: threading.RLock = threading.RLock()

    # ------------------------------------------------------------------
    # Registration
    # ------------------------------------------------------------------

    def register(self, template: DiscoveryTemplate) -> None:
        """
        Register *template* under its ``template_id``.

        Raises
        ------
        TypeError
            *template* is not a ``DiscoveryTemplate`` instance.
        ValueError
            ``template.template_id`` or ``(provider_id, niche_id)`` is already registered.
        """
        if not isinstance(template, DiscoveryTemplate):
            raise TypeError(
                f"template must be a DiscoveryTemplate instance; got {type(template)!r}"
            )

        with self._lock:
            if template.template_id in self._templates:
                raise ValueError(
                    f"template_id {template.template_id!r} is already registered — "
                    "duplicate template_ids are not allowed."
                )

            pn_key = (template.provider_id, template.niche_id)
            if pn_key in self._provider_niche_map:
                raise ValueError(
                    f"Template for provider {template.provider_id!r} and "
                    f"niche {template.niche_id!r} is already registered as "
                    f"{self._provider_niche_map[pn_key]!r}."
                )

            self._templates[template.template_id] = template
            self._provider_niche_map[pn_key] = template.template_id

    # ------------------------------------------------------------------
    # Lookup
    # ------------------------------------------------------------------

    def get(self, template_id: str) -> DiscoveryTemplate:
        """
        Return the ``DiscoveryTemplate`` registered under *template_id*.

        Raises
        ------
        KeyError
            *template_id* is not registered.
        """
        with self._lock:
            if template_id not in self._templates:
                raise KeyError(
                    f"template_id {template_id!r} is not registered in this "
                    "DiscoveryTemplateRegistry."
                )
            return self._templates[template_id]

    def get_for_provider_and_niche(
        self, provider_id: str, niche_id: str
    ) -> DiscoveryTemplate:
        """
        Return the ``DiscoveryTemplate`` for *provider_id* and *niche_id*.

        Raises
        ------
        KeyError
            If no matching template is registered.
        """
        with self._lock:
            pn_key = (provider_id, niche_id)
            if pn_key not in self._provider_niche_map:
                raise KeyError(
                    f"No template registered for provider {provider_id!r} and niche {niche_id!r}."
                )
            template_id = self._provider_niche_map[pn_key]
            return self._templates[template_id]

    def exists(self, template_id: str) -> bool:
        """Return ``True`` if *template_id* is registered."""
        with self._lock:
            return template_id in self._templates

    def exists_for_provider_and_niche(self, provider_id: str, niche_id: str) -> bool:
        """Return ``True`` if a template exists for *provider_id* and *niche_id*."""
        with self._lock:
            return (provider_id, niche_id) in self._provider_niche_map

    def ids(self) -> tuple[str, ...]:
        """Return all registered template IDs in insertion order."""
        with self._lock:
            return tuple(self._templates.keys())

    def all(self) -> tuple[DiscoveryTemplate, ...]:
        """Return all registered ``DiscoveryTemplate`` objects in insertion order."""
        with self._lock:
            return tuple(self._templates.values())
