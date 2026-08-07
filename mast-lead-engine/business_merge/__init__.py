"""
business_merge
==============

Canonical Consolidation Architecture Subsystem for the MAST Lead Engine.

Given a BusinessIdentity and referenced canonical Business domain objects,
produces a single, immutable, merged Business record alongside complete
provenance tracking and conflict audit logs.

Design Rules
------------
- Single responsibility: Merges canonical Business records linked by BusinessIdentity.
- Zero identity matching, scoring, enrichment, AI, or persistence responsibilities.
- Pure immutability: All models frozen, slotted, using immutable tuples.
- Pure source records: Input Business objects are never mutated.
- Pure provider strings: Business.originating_provider_id remains a clean scalar string.
- Structured provenance: Field origins represented as immutable FieldOrigin objects.
- Pure coordinate selection: Selects existing WGS84 coordinates without centroid math.
"""

from __future__ import annotations

from .models import (
    BusinessMergeResult,
    BusinessProvenance,
    FieldMergeStrategy,
    FieldOrigin,
    MergeConflict,
    MergePolicy,
    DEFAULT_MERGE_POLICY,
)
from .registry import BusinessMergeRegistry
from .service import BusinessMergeService

__all__ = [
    "BusinessMergeResult",
    "BusinessProvenance",
    "FieldMergeStrategy",
    "FieldOrigin",
    "MergeConflict",
    "MergePolicy",
    "DEFAULT_MERGE_POLICY",
    "BusinessMergeRegistry",
    "BusinessMergeService",
]
