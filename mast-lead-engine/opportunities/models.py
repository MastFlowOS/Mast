"""
opportunities/models.py
========================

Immutable domain model for Canonical Opportunities in the MAST Lead Engine.

Design Rules
------------
- Frozen, slotted dataclass — runtime mutation is impossible.
- Collections are stored as immutable `tuple`.
- Stores purely canonical facts (`opportunity_id`, `business_id`, `niche_id`,
  `opportunity_type_id`, `discovered_at`, `supporting_signal_ids`).
- No free-form explanations (reconstructed later by AI/presentation layers).
- Strict isolation: Consumes standard library types and datetime only.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime


def _validate_non_empty_str(value: str, label: str) -> None:
    """
    Raise ValueError if value is not a non-empty string.
    """
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{label} must be a non-empty string; got {value!r}")


@dataclass(frozen=True, slots=True)
class Opportunity:
    """
    Immutable domain model representing a single canonical Opportunity discovered for
    a business within a freelancer niche.

    Fields
    ------
    opportunity_id
        Unique normalized canonical opportunity identifier (e.g. 'opp_biz_001_web_design_01').
    business_id
        Canonical reference identifier of the target Business (e.g. 'biz_dentist_berlin_01').
    niche_id
        Normalized freelancer niche identifier (e.g. 'web_design', 'seo', 'social_media').
    opportunity_type_id
        Normalized opportunity type identifier (e.g. 'missing_website', 'poor_seo').
    discovered_at
        Timestamp when the opportunity was discovered.
    supporting_signal_ids
        Immutable tuple of signal identifier strings supporting this opportunity (default: ()).
    """

    opportunity_id: str
    business_id: str
    niche_id: str
    opportunity_type_id: str
    discovered_at: datetime
    supporting_signal_ids: tuple[str, ...] = ()

    def __post_init__(self) -> None:
        _validate_non_empty_str(self.opportunity_id, "opportunity_id")
        _validate_non_empty_str(self.business_id, "business_id")
        _validate_non_empty_str(self.niche_id, "niche_id")
        _validate_non_empty_str(self.opportunity_type_id, "opportunity_type_id")

        if not isinstance(self.discovered_at, datetime):
            raise TypeError(
                f"discovered_at must be a datetime instance; got {type(self.discovered_at)!r}"
            )

        # Coerce and validate collection field
        if not isinstance(self.supporting_signal_ids, tuple):
            signal_tuple = tuple(self.supporting_signal_ids)
        else:
            signal_tuple = self.supporting_signal_ids

        for signal_id in signal_tuple:
            _validate_non_empty_str(signal_id, "item in supporting_signal_ids")

        object.__setattr__(self, "supporting_signal_ids", signal_tuple)
