"""
niches/taxonomy.py
==================

Structural hierarchy of niche categories.

Design rules
------------
- ``Category`` is a frozen, slotted domain model with no runtime
  behaviour.
- ``Taxonomy`` is a thread-safe manager for the category hierarchy.
  It supports parent-child relationships, traversal, and introspection.
- ``Taxonomy`` is purely structural.  It does not construct or
  populate any default catalog.  Default niche definitions are deferred
  to a future milestone (e.g. catalog.py or defaults.py).
- ``Taxonomy`` is independent of ``NicheRegistry``:
    - A category can exist in the Taxonomy without any registered Niche
      referencing it.
    - A Niche's ``parent_category`` field is a plain string ID; the
      Taxonomy is not queried at Niche construction time.
- No imports from engine/, providers/, intelligence/, storage/,
  scoring/, enrichment/, or contacts/.
- ``Taxonomy`` does not import ``NicheSignal``, ``SignalRegistry``, or
  ``NicheRegistry``.
"""

from __future__ import annotations

import re
import threading
from dataclasses import dataclass
from typing import Optional


# ---------------------------------------------------------------------------
# Identifier validation (mirrors niches/models.py exactly)
# ---------------------------------------------------------------------------

_ID_PATTERN: re.Pattern[str] = re.compile(
    r"^[a-z0-9]+(?:_[a-z0-9]+)*$"
)


def _validate_id(value: str, label: str) -> None:
    """
    Raise ``ValueError`` if *value* is not a valid normalized identifier.

    Rules: non-empty, lowercase alphanumeric + underscores only, matches
    ``^[a-z0-9]+(?:_[a-z0-9]+)*$`` — no leading/trailing/consecutive
    underscores, no uppercase, no special characters other than ``_``.
    """
    if not isinstance(value, str) or not value:
        raise ValueError(f"{label} must be a non-empty string; got {value!r}")
    if not _ID_PATTERN.match(value):
        raise ValueError(
            f"{label} {value!r} is not a valid normalized identifier. "
            "Only lowercase alphanumeric characters and single underscores "
            "are allowed (e.g. 'programming_tech', 'graphic_design'). "
            "Leading/trailing/consecutive underscores and uppercase are "
            "rejected."
        )


# ---------------------------------------------------------------------------
# Category
# ---------------------------------------------------------------------------

@dataclass(frozen=True, slots=True)
class Category:
    """
    Immutable description of a top-level or nested niche category.

    Fields
    ------
    category_id
        Normalized identifier.  Must satisfy
        ``^[a-z0-9]+(?:_[a-z0-9]+)*$``.
    name
        Human-readable display name (e.g. "Programming & Tech").
    parent_id
        ``category_id`` of the parent category, or ``None`` for
        root-level categories.  The ``Taxonomy`` validates that a
        non-``None`` ``parent_id`` refers to an already-registered
        category.
    description
        Optional prose description of the category.
    """

    category_id: str
    name: str
    parent_id: Optional[str] = None
    description: str = ""

    def __post_init__(self) -> None:
        _validate_id(self.category_id, "category_id")
        if self.parent_id is not None:
            _validate_id(self.parent_id, "parent_id")


# ---------------------------------------------------------------------------
# Taxonomy
# ---------------------------------------------------------------------------

class Taxonomy:
    """
    Thread-safe manager for the category hierarchy.

    Supports:

    - Registering categories with optional parent linkage.
    - Querying parent, children, root categories, and the full list.
    - Preventing duplicate registrations.
    - Preventing orphaned parent references (a category's ``parent_id``
      must refer to an already-registered category).

    The ``Taxonomy`` is purely structural.  It does not know about
    ``Niche`` objects, ``NicheRegistry``, or any signal.  It does not
    construct or populate any default catalog — that is deferred to a
    future milestone.
    """

    def __init__(self) -> None:
        self._categories: dict[str, Category] = {}
        self._lock: threading.RLock = threading.RLock()

    # ------------------------------------------------------------------
    # Registration
    # ------------------------------------------------------------------

    def register_category(self, category: Category) -> None:
        """
        Register *category* in the taxonomy.

        Raises
        ------
        TypeError
            *category* is not a ``Category`` instance.
        ValueError
            ``category.category_id`` is already registered, or
            ``category.parent_id`` is not ``None`` and does not refer to
            an already-registered category.
        """
        if not isinstance(category, Category):
            raise TypeError(
                f"category must be a Category instance; got {type(category)!r}"
            )
        with self._lock:
            if category.category_id in self._categories:
                raise ValueError(
                    f"category_id {category.category_id!r} is already "
                    "registered — duplicate category_ids are not allowed."
                )
            if (
                category.parent_id is not None
                and category.parent_id not in self._categories
            ):
                raise ValueError(
                    f"parent_id {category.parent_id!r} is not registered in "
                    "this Taxonomy.  Register the parent category before "
                    "registering its children."
                )
            self._categories[category.category_id] = category

    # ------------------------------------------------------------------
    # Lookup
    # ------------------------------------------------------------------

    def get_category(self, category_id: str) -> Category:
        """
        Return the ``Category`` registered under *category_id*.

        Raises
        ------
        KeyError
            *category_id* is not registered.
        """
        with self._lock:
            if category_id not in self._categories:
                raise KeyError(
                    f"category_id {category_id!r} is not registered in this "
                    "Taxonomy."
                )
            return self._categories[category_id]

    def exists(self, category_id: str) -> bool:
        """Return ``True`` if *category_id* is registered."""
        with self._lock:
            return category_id in self._categories

    # ------------------------------------------------------------------
    # Traversal
    # ------------------------------------------------------------------

    def get_children(self, category_id: str) -> tuple[Category, ...]:
        """
        Return all categories whose ``parent_id`` equals *category_id*,
        in insertion order.

        Raises
        ------
        KeyError
            *category_id* is not registered.
        """
        with self._lock:
            if category_id not in self._categories:
                raise KeyError(
                    f"category_id {category_id!r} is not registered in this "
                    "Taxonomy."
                )
            return tuple(
                c
                for c in self._categories.values()
                if c.parent_id == category_id
            )

    def get_parent(self, category_id: str) -> Optional[Category]:
        """
        Return the parent ``Category`` of *category_id*, or ``None`` if
        *category_id* is a root category.

        Raises
        ------
        KeyError
            *category_id* is not registered.
        """
        with self._lock:
            category = self.get_category(category_id)
            if category.parent_id is None:
                return None
            return self._categories[category.parent_id]

    def get_roots(self) -> tuple[Category, ...]:
        """Return all categories with no parent, in insertion order."""
        with self._lock:
            return tuple(
                c for c in self._categories.values() if c.parent_id is None
            )

    def get_all(self) -> tuple[Category, ...]:
        """Return all registered categories in insertion order."""
        with self._lock:
            return tuple(self._categories.values())
