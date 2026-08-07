"""
niches/models.py
================

Immutable domain model for a freelancer niche.

Design rules
------------
- Frozen, slotted dataclass — no runtime mutation is possible.
- Collection fields are always stored as ``tuple``, never ``list``.
  ``__post_init__`` converts any mutable sequence the caller passes
  into an immutable ``tuple`` before the instance is sealed.  This
  makes it impossible for the caller to retain a mutable reference to
  the internal state.
- Signals are referenced by ``signal_id`` string only.  No
  ``NicheSignal`` object is held here.  Resolution belongs to
  ``SignalRegistry``; the model is the source of what IDs are
  relevant, not what those IDs resolve to.
- No provider references of any kind.  Provider selection belongs
  exclusively to Provider Intelligence.
- No imports from engine/, providers/, intelligence/, storage/,
  scoring/, enrichment/, or contacts/.
"""

from __future__ import annotations

import re


# ---------------------------------------------------------------------------
# Identifier validation
# ---------------------------------------------------------------------------

_ID_PATTERN: re.Pattern[str] = re.compile(
    r"^[a-z0-9]+(?:_[a-z0-9]+)*$"
)


def _validate_id(value: str, label: str) -> None:
    """
    Raise ``ValueError`` if *value* is not a valid normalized identifier.

    Rules (identical across all ``niches`` models):

    - Non-empty string.
    - Lowercase alphanumeric characters and underscores only.
    - Pattern: ``^[a-z0-9]+(?:_[a-z0-9]+)*$``

      - No leading or trailing underscores.
      - No consecutive underscores.
      - No uppercase letters.
      - No special characters other than ``_``.
    """
    if not isinstance(value, str) or not value:
        raise ValueError(f"{label} must be a non-empty string; got {value!r}")
    if not _ID_PATTERN.match(value):
        raise ValueError(
            f"{label} {value!r} is not a valid normalized identifier. "
            "Only lowercase alphanumeric characters and single underscores "
            "are allowed (e.g. 'web_design', 'seo', 'video_editing'). "
            "Leading/trailing/consecutive underscores and uppercase are "
            "rejected."
        )


# ---------------------------------------------------------------------------
# Niche
# ---------------------------------------------------------------------------

from dataclasses import dataclass


@dataclass(frozen=True, slots=True)
class Niche:
    """
    Immutable, structured description of a freelancer niche.

    This is a domain model only.  It carries no runtime behaviour,
    no provider references, and no AI / scoring logic.  It is the
    single source of truth for what a niche *is*; downstream
    subsystems (Business Intelligence, Opportunity Detection, Mission
    Generation, CRM) consume this description without modifying it.

    Fields
    ------
    niche_id
        Normalized identifier.  Must satisfy
        ``^[a-z0-9]+(?:_[a-z0-9]+)*$``.
    name
        Human-readable display name (e.g. "Web Design").
    description
        A concise prose description of the niche.
    parent_category
        Normalized identifier of the parent ``Category`` in the
        ``Taxonomy``.  The ``Niche`` model stores this as a plain
        string; the ``Taxonomy`` is the authoritative store of
        categories, not the ``Niche``.
    services
        Tuple of service names this niche typically offers.
    common_deliverables
        Tuple of typical deliverable names (e.g. "Landing page",
        "Brand kit").
    required_business_signal_ids
        Tuple of ``signal_id`` strings from ``SignalRegistry`` that
        are required for this niche.  Stored as IDs, not as live
        ``NicheSignal`` objects — resolution is the caller's
        responsibility.
    optional_business_signal_ids
        Tuple of ``signal_id`` strings that benefit this niche but
        are not strictly required.
    supported_regions
        Tuple of region identifiers this niche serves.  Empty tuple
        means globally applicable.
    required_contact_fields
        Tuple of contact field names that are mandatory for leads in
        this niche (e.g. "email", "phone").
    keywords
        Tuple of lowercase keyword strings for deterministic matching
        by future Business Intelligence.  These are structured
        metadata, not AI prompts.
    """

    niche_id: str
    name: str
    description: str
    parent_category: str
    services: tuple[str, ...]
    common_deliverables: tuple[str, ...]
    required_business_signal_ids: tuple[str, ...]
    optional_business_signal_ids: tuple[str, ...]
    supported_regions: tuple[str, ...]
    required_contact_fields: tuple[str, ...]
    keywords: tuple[str, ...]

    def __post_init__(self) -> None:
        # Validate identifiers.
        _validate_id(self.niche_id, "niche_id")
        _validate_id(self.parent_category, "parent_category")

        # Deep immutability: coerce any mutable sequence to tuple.
        # Because the dataclass is frozen we must use object.__setattr__.
        object.__setattr__(self, "services", tuple(self.services))
        object.__setattr__(
            self, "common_deliverables", tuple(self.common_deliverables)
        )
        object.__setattr__(
            self,
            "required_business_signal_ids",
            tuple(self.required_business_signal_ids),
        )
        object.__setattr__(
            self,
            "optional_business_signal_ids",
            tuple(self.optional_business_signal_ids),
        )
        object.__setattr__(
            self, "supported_regions", tuple(self.supported_regions)
        )
        object.__setattr__(
            self,
            "required_contact_fields",
            tuple(self.required_contact_fields),
        )
        object.__setattr__(self, "keywords", tuple(self.keywords))
