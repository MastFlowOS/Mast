"""
opportunity_qualification/models.py
===================================

Immutable domain models for Opportunity Qualification in the MAST Lead Engine.

Design Rules
------------
- Frozen, slotted dataclasses — runtime mutation is impossible.
- Collections are stored as immutable `tuple`.
- Pure derived evaluation result — contains zero runtime state, persistent identity, or timestamps.
- Binary qualification outcome: `QUALIFIED` or `NOT_QUALIFIED`.
- Strict isolation: Consumes standard library types only.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum


def _validate_non_empty_str(value: str, label: str) -> None:
    """Raise ValueError if value is not a non-empty string."""
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{label} must be a non-empty string; got {value!r}")


class QualificationStatus(str, Enum):
    """Binary qualification outcome for an opportunity."""

    QUALIFIED = "QUALIFIED"
    NOT_QUALIFIED = "NOT_QUALIFIED"


@dataclass(frozen=True, slots=True)
class OpportunityQualification:
    """
    Immutable representation of the derived qualification evaluation result for an Opportunity.

    Fields
    ------
    opportunity_id
        Canonical reference identifier of the evaluated Opportunity.
    status
        Binary qualification status (QUALIFIED or NOT_QUALIFIED).
    passed_rule_ids
        Immutable tuple of rule identifiers that satisfied qualification criteria.
    failed_rule_ids
        Immutable tuple of rule identifiers that failed qualification criteria (default: ()).
    """

    opportunity_id: str
    status: QualificationStatus
    passed_rule_ids: tuple[str, ...]
    failed_rule_ids: tuple[str, ...] = ()

    def __post_init__(self) -> None:
        _validate_non_empty_str(self.opportunity_id, "opportunity_id")

        if not isinstance(self.status, QualificationStatus):
            raise TypeError(
                f"status must be a QualificationStatus enum instance; got {type(self.status)!r}"
            )

        # Coerce passed_rule_ids collection to immutable tuple
        if not isinstance(self.passed_rule_ids, tuple):
            passed_tuple = tuple(self.passed_rule_ids)
        else:
            passed_tuple = self.passed_rule_ids

        for rule_id in passed_tuple:
            _validate_non_empty_str(rule_id, "item in passed_rule_ids")

        object.__setattr__(self, "passed_rule_ids", passed_tuple)

        # Coerce failed_rule_ids collection to immutable tuple
        if not isinstance(self.failed_rule_ids, tuple):
            failed_tuple = tuple(self.failed_rule_ids)
        else:
            failed_tuple = self.failed_rule_ids

        for rule_id in failed_tuple:
            _validate_non_empty_str(rule_id, "item in failed_rule_ids")

        object.__setattr__(self, "failed_rule_ids", failed_tuple)
