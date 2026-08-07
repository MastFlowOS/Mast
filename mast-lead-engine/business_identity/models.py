"""
business_identity/models.py
===========================

Immutable domain models for Business Identity Resolution in the MAST Lead Engine.

Design Rules
------------
- Frozen, slotted dataclass — runtime mutation is impossible.
- Collections stored as immutable `tuple`.
- Strictly declarative identity grouping: contains `identity_id`, `business_ids`, and `created_at`.
- Zero bias: No primary anchor, winner, or ranking.
- Strict isolation: Standard library types and datetime.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import datetime

_ID_PATTERN: re.Pattern[str] = re.compile(r"^[a-zA-Z0-9_-]+$")


def _validate_non_empty_str(value: str, label: str) -> None:
    """Raise ValueError if value is not a non-empty string."""
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{label} must be a non-empty string; got {value!r}")


@dataclass(frozen=True, slots=True)
class BusinessIdentity:
    """
    Immutable domain model representing an identity relationship (equivalence group)
    across canonical Business instances that represent the same real-world business entity.

    Fields
    ------
    identity_id
        Unique identifier for the identity relationship group (e.g. 'id_group_001').
    business_ids
        Immutable tuple of canonical business identifiers belonging to this identity group.
    created_at
        Timestamp when the identity relationship was determined/created.
    """

    identity_id: str
    business_ids: tuple[str, ...]
    created_at: datetime

    def __post_init__(self) -> None:
        _validate_non_empty_str(self.identity_id, "identity_id")

        if not isinstance(self.created_at, datetime):
            raise TypeError(f"created_at must be a datetime instance; got {type(self.created_at)!r}")

        # Coerce and validate business_ids sequence
        if not isinstance(self.business_ids, tuple):
            b_tuple = tuple(self.business_ids)
        else:
            b_tuple = self.business_ids

        if not b_tuple:
            raise ValueError("business_ids cannot be empty")

        for item in b_tuple:
            _validate_non_empty_str(item, "item in business_ids")

        object.__setattr__(self, "business_ids", b_tuple)

    @property
    def count(self) -> int:
        """Return total number of business IDs in this identity relationship group."""
        return len(self.business_ids)
