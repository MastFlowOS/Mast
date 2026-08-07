"""
MAST Lead Engine — Business Subsystem (Phase 1: Canonical Business Models)
==========================================================================

This subsystem provides the canonical representation for business entities
discovered across provider platform executions within discovery sessions.

Design Principles
-----------------
1. Pure canonical model representation — no deduplication, scoring, enrichment,
   opportunities, AI, database persistence, or CRM integration.
2. Strict layer isolation: Independent from engine/, storage/, database/, crm/,
   missions/, opportunities/, and ai/.
3. Immutable slotted domain models (`Business`).
4. Single source of truth for contact collections and social profile URLs.
5. Thread-safe in-memory registry (`BusinessRegistry`).
"""

from __future__ import annotations

from business.models import Business
from business.registry import BusinessRegistry

__all__ = [
    "Business",
    "BusinessRegistry",
]
