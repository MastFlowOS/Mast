"""
opportunity_ranking/models.py
==============================

Immutable domain models for Opportunity Ranking in the MAST Lead Engine.

Design Rules
------------
- Frozen, slotted dataclasses — runtime mutation is impossible.
- Minimal ordinal positioning representation — contains only opportunity_id, rank, and priority_score.
- Strict isolation: Consumes standard library types only.
"""

from __future__ import annotations

from dataclasses import dataclass


def _validate_non_empty_str(value: str, label: str) -> None:
    """Raise ValueError if value is not a non-empty string."""
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{label} must be a non-empty string; got {value!r}")


@dataclass(frozen=True, slots=True)
class RankedOpportunity:
    """
    Immutable domain model representing an Opportunity assigned a 1-based ordinal rank.

    Fields
    ------
    opportunity_id
        Canonical reference identifier of the ranked Opportunity.
    rank
        1-based ordinal position index (1, 2, 3, ...).
    priority_score
        Continuous priority score [0.0, 100.0] derived from Opportunity Prioritization.
    """

    opportunity_id: str
    rank: int
    priority_score: float

    def __post_init__(self) -> None:
        _validate_non_empty_str(self.opportunity_id, "opportunity_id")

        if not isinstance(self.rank, int) or isinstance(self.rank, bool):
            raise TypeError(f"rank must be an int; got {type(self.rank)!r}")

        if self.rank < 1:
            raise ValueError(f"rank must be >= 1; got {self.rank}")

        if not isinstance(self.priority_score, (int, float)):
            raise TypeError(
                f"priority_score must be a float or int; got {type(self.priority_score)!r}"
            )

        clamped_score = float(max(0.0, min(100.0, float(self.priority_score))))
        object.__setattr__(self, "priority_score", clamped_score)
