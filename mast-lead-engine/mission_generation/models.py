"""
mission_generation/models.py
============================

Immutable domain models for Mission Generation in the MAST Lead Engine.

Design Rules
------------
- Frozen, slotted dataclasses — runtime mutation is impossible.
- Strict isolation: Consumes standard library types only.
- Derived commercial intent representation (opportunity_id, business_id, mission_type).
- Zero non-deterministic identifiers, zero presentation fields, zero payload bags.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum


def _validate_non_empty_str(value: str, label: str) -> None:
    """Raise ValueError if value is not a non-empty string."""
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{label} must be a non-empty string; got {value!r}")


class MissionType(str, Enum):
    """
    Canonical enum representing the finite commercial intention vocabulary
    supported across the MAST Lead Engine 2.0 architecture.
    """

    OUTREACH = "OUTREACH"
    AUDIT = "AUDIT"
    RECOVERY = "RECOVERY"
    CLAIM = "CLAIM"
    NURTURE = "NURTURE"


@dataclass(frozen=True, slots=True)
class Mission:
    """
    Immutable domain model representing a derived commercial intent (objective).

    Fields
    ------
    opportunity_id
        Canonical reference identifier of the target Opportunity.
    business_id
        Canonical reference identifier of the target Business entity.
    mission_type
        Canonical commercial intent type (MissionType enum).
    """

    opportunity_id: str
    business_id: str
    mission_type: MissionType

    def __post_init__(self) -> None:
        _validate_non_empty_str(self.opportunity_id, "opportunity_id")
        _validate_non_empty_str(self.business_id, "business_id")

        if not isinstance(self.mission_type, MissionType):
            raise TypeError(
                f"mission_type must be a MissionType enum instance; got {type(self.mission_type)!r}"
            )
