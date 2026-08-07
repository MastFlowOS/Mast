"""
niches
======

Niche Intelligence subsystem — Phase 1: Architecture Foundation.

This package is the structured source of truth for freelancer niche
knowledge.  It is consumed by downstream subsystems (Business
Intelligence, Opportunity Detection, AI Coach, Mission Generation, CRM
recommendations) but depends on none of them.

Public API
----------

Models
~~~~~~
``Niche``
    Immutable domain model describing a freelancer niche.

Signals
~~~~~~~
``NicheSignal``
    Immutable, descriptive representation of a business signal.
``SignalRegistry``
    Thread-safe registry for ``NicheSignal`` instances.
``register_default_signals(registry)``
    Populate a ``SignalRegistry`` with the ten built-in signals.

Taxonomy
~~~~~~~~
``Category``
    Immutable domain model for a niche category node.
``Taxonomy``
    Thread-safe structural manager for the category hierarchy.

Registry
~~~~~~~~
``NicheRegistry``
    Thread-safe registry for ``Niche`` domain models.

Boundary contract
-----------------
This package must not import from:
    engine, providers, intelligence, storage, scoring, enrichment, contacts

No circular dependencies are introduced.  Everything is immutable where
possible.  Every store (``NicheRegistry``, ``SignalRegistry``,
``Taxonomy``) is thread-safe.
"""

from niches.models import Niche
from niches.signals import (
    NicheSignal,
    SignalRegistry,
    register_default_signals,
)
from niches.taxonomy import Category, Taxonomy
from niches.registry import NicheRegistry

__all__ = [
    # Models
    "Niche",
    # Signals
    "NicheSignal",
    "SignalRegistry",
    "register_default_signals",
    # Taxonomy
    "Category",
    "Taxonomy",
    # Registry
    "NicheRegistry",
]
