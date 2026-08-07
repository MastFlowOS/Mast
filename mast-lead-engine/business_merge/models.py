"""
business_merge/models.py
========================

Immutable domain models for Canonical Business Consolidation in the MAST Lead Engine.

Design Rules
------------
- Frozen, slotted dataclasses — runtime mutation is impossible.
- Collections are stored as immutable `tuple`.
- Pure provider strings: Business.originating_provider_id is a single clean scalar string.
- Structured provenance: Field origins are stored as immutable FieldOrigin objects.
- Simple, readable MergePolicy configuring field consolidation strategies.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import datetime
from enum import Enum
from typing import Any, TYPE_CHECKING

if TYPE_CHECKING:
    from business import Business

_ID_PATTERN: re.Pattern[str] = re.compile(r"^[a-zA-Z0-9_-]+$")


def _validate_non_empty_str(value: str, label: str) -> None:
    """Raise ValueError if value is not a non-empty string."""
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{label} must be a non-empty string; got {value!r}")


class FieldMergeStrategy(str, Enum):
    """Supported field-level consolidation strategies."""

    LONGEST_NON_EMPTY = "longest_non_empty"
    FIRST_NON_NULL = "first_non_null"
    PRIMARY_SOURCE = "primary_source"
    UNION_UNIQUE_ORDERED = "union_unique_ordered"


@dataclass(frozen=True, slots=True)
class MergePolicy:
    """
    Immutable configuration governing field-level consolidation logic during a merge.

    Fields
    ------
    primary_provider_id
        Optional preferred provider ID to prioritize when using PRIMARY_SOURCE strategy.
    scalar_strategy
        Default strategy for scalar text fields (name, address, city, region, country, postal_code, description, category, social URLs).
    collection_strategy
        Default strategy for contact collection fields (phones, emails, websites).
    coordinate_strategy
        Strategy for geographic coordinates (latitude, longitude). Strictly selects existing values; never computes centroids.
    """

    primary_provider_id: str | None = None
    scalar_strategy: FieldMergeStrategy = FieldMergeStrategy.LONGEST_NON_EMPTY
    collection_strategy: FieldMergeStrategy = FieldMergeStrategy.UNION_UNIQUE_ORDERED
    coordinate_strategy: FieldMergeStrategy = FieldMergeStrategy.FIRST_NON_NULL

    def __post_init__(self) -> None:
        if self.primary_provider_id is not None:
            _validate_non_empty_str(self.primary_provider_id, "primary_provider_id")

        if not isinstance(self.scalar_strategy, FieldMergeStrategy):
            raise TypeError(f"scalar_strategy must be a FieldMergeStrategy enum; got {type(self.scalar_strategy)!r}")

        if not isinstance(self.collection_strategy, FieldMergeStrategy):
            raise TypeError(f"collection_strategy must be a FieldMergeStrategy enum; got {type(self.collection_strategy)!r}")

        if not isinstance(self.coordinate_strategy, FieldMergeStrategy):
            raise TypeError(f"coordinate_strategy must be a FieldMergeStrategy enum; got {type(self.coordinate_strategy)!r}")


DEFAULT_MERGE_POLICY = MergePolicy()


@dataclass(frozen=True, slots=True)
class FieldOrigin:
    """
    Immutable representation of provenance lineage for a single field in the merged Business entity.

    Fields
    ------
    field_name
        Name of the consolidated Business field (e.g. 'name', 'address', 'phones').
    source_business_ids
        Immutable tuple of source business IDs that contributed value(s) to this field.
    winning_value
        The final selected value for this field in the merged entity.
    merge_reason
        Human-readable explanation of why this value/sources were selected.
    """

    field_name: str
    source_business_ids: tuple[str, ...]
    winning_value: Any = None
    merge_reason: str | None = None

    def __post_init__(self) -> None:
        _validate_non_empty_str(self.field_name, "field_name")

        if not isinstance(self.source_business_ids, tuple):
            s_tuple = tuple(self.source_business_ids)
        else:
            s_tuple = self.source_business_ids

        for s_id in s_tuple:
            _validate_non_empty_str(s_id, f"source_business_id in FieldOrigin({self.field_name})")

        object.__setattr__(self, "source_business_ids", s_tuple)

        if self.merge_reason is not None and not isinstance(self.merge_reason, str):
            raise TypeError(f"merge_reason must be a string or None; got {type(self.merge_reason)!r}")


@dataclass(frozen=True, slots=True)
class MergeConflict:
    """
    Immutable representation of a conflicting scalar field value discovered during consolidation.

    Fields
    ------
    field_name
        Name of the field where non-identical scalar values were present.
    winning_value
        The scalar value chosen for the canonical merged Business.
    winning_source_id
        The source business_id that supplied the winning value.
    competing_values
        Immutable tuple of (source_business_id, value) pairs for all non-winning differing values.
    """

    field_name: str
    winning_value: Any
    winning_source_id: str
    competing_values: tuple[tuple[str, Any], ...]

    def __post_init__(self) -> None:
        _validate_non_empty_str(self.field_name, "field_name")
        _validate_non_empty_str(self.winning_source_id, "winning_source_id")

        if not isinstance(self.competing_values, tuple):
            c_tuple = tuple(self.competing_values)
        else:
            c_tuple = self.competing_values

        for pair in c_tuple:
            if not isinstance(pair, tuple) or len(pair) != 2:
                raise TypeError(f"competing_values item must be a 2-tuple (source_id, value); got {pair!r}")
            _validate_non_empty_str(pair[0], "competing source_business_id")

        object.__setattr__(self, "competing_values", c_tuple)


@dataclass(frozen=True, slots=True)
class BusinessProvenance:
    """
    Immutable domain model capturing full lineage and field origins for a merged Business.

    Fields
    ------
    identity_id
        Identifier of the BusinessIdentity group that triggered the merge.
    merged_business_id
        Identifier of the resulting merged canonical Business.
    source_business_ids
        Immutable tuple of all source business IDs consolidated in this merge.
    source_execution_ids
        Immutable tuple of all unique execution IDs involved.
    source_provider_ids
        Immutable tuple of all unique originating provider IDs involved.
    source_session_ids
        Immutable tuple of all unique session IDs involved.
    field_origins
        Immutable tuple of FieldOrigin objects detailing origin lineage per field.
    """

    identity_id: str
    merged_business_id: str
    source_business_ids: tuple[str, ...]
    source_execution_ids: tuple[str, ...]
    source_provider_ids: tuple[str, ...]
    source_session_ids: tuple[str, ...]
    field_origins: tuple[FieldOrigin, ...]

    def __post_init__(self) -> None:
        _validate_non_empty_str(self.identity_id, "identity_id")
        _validate_non_empty_str(self.merged_business_id, "merged_business_id")

        # Coerce & validate collection fields
        for label, val in [
            ("source_business_ids", self.source_business_ids),
            ("source_execution_ids", self.source_execution_ids),
            ("source_provider_ids", self.source_provider_ids),
            ("source_session_ids", self.source_session_ids),
        ]:
            if not isinstance(val, tuple):
                t_val = tuple(val)
            else:
                t_val = val

            for item in t_val:
                _validate_non_empty_str(item, f"item in {label}")

            object.__setattr__(self, label, t_val)

        # Validate field_origins
        if not isinstance(self.field_origins, tuple):
            fo_tuple = tuple(self.field_origins)
        else:
            fo_tuple = self.field_origins

        for fo in fo_tuple:
            if not isinstance(fo, FieldOrigin):
                raise TypeError(f"item in field_origins must be a FieldOrigin instance; got {type(fo)!r}")

        object.__setattr__(self, "field_origins", fo_tuple)


@dataclass(frozen=True, slots=True)
class BusinessMergeResult:
    """
    Immutable container wrapping the consolidated canonical Business, its complete provenance,
    and any detected field conflicts.

    Fields
    ------
    business
        The single canonical merged Business object.
    provenance
        Detailed lineage and field origin metadata.
    conflicts
        Immutable tuple of MergeConflict objects for differing scalar field values.
    merged_at
        Timestamp when the consolidation was performed.
    """

    business: Business
    provenance: BusinessProvenance
    conflicts: tuple[MergeConflict, ...]
    merged_at: datetime

    def __post_init__(self) -> None:
        from business import Business

        if not isinstance(self.business, Business):
            raise TypeError(f"business must be a Business instance; got {type(self.business)!r}")

        if not isinstance(self.provenance, BusinessProvenance):
            raise TypeError(f"provenance must be a BusinessProvenance instance; got {type(self.provenance)!r}")

        if not isinstance(self.merged_at, datetime):
            raise TypeError(f"merged_at must be a datetime instance; got {type(self.merged_at)!r}")

        if not isinstance(self.conflicts, tuple):
            c_tuple = tuple(self.conflicts)
        else:
            c_tuple = self.conflicts

        for c in c_tuple:
            if not isinstance(c, MergeConflict):
                raise TypeError(f"item in conflicts must be a MergeConflict instance; got {type(c)!r}")

        object.__setattr__(self, "conflicts", c_tuple)
