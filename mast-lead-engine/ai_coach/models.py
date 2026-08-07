"""
ai_coach/models.py
==================

Immutable domain models for AI Coach (Subsystem 17) in the MAST Lead Engine 2.0.

Design Rules
------------
- Frozen, slotted dataclasses — runtime mutation is impossible.
- Collections are stored as immutable `tuple`.
- Pure canonical domain models — zero infrastructure, provider, network, token, or prompt concerns.
- Infrastructure Separation Rule: Lead Engine models must never represent infrastructure state
  (provider availability, authentication, networking, rate limiting, token usage, retries, outages).
- Consumes strictly EngineContext (Subsystem 16).
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum

from engine_context.models import EngineContext


def _validate_non_empty_str(value: str, label: str) -> None:
    """Raise ValueError if value is not a non-empty string."""
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{label} must be a non-empty string; got {value!r}")


class InsightCategory(str, Enum):
    """Canonical classification for advisory insights."""

    EXPLANATION = "EXPLANATION"
    RISK = "RISK"
    OPPORTUNITY = "OPPORTUNITY"
    RECOMMENDATION = "RECOMMENDATION"
    SUMMARY = "SUMMARY"


@dataclass(frozen=True, slots=True)
class CoachInsight:
    """Minimal, generic canonical advisory finding."""

    category: InsightCategory
    title: str
    content: str

    def __post_init__(self) -> None:
        if not isinstance(self.category, InsightCategory):
            raise TypeError(
                f"category must be an InsightCategory enum; got {type(self.category)!r}"
            )
        _validate_non_empty_str(self.title, "title")
        _validate_non_empty_str(self.content, "content")


@dataclass(frozen=True, slots=True)
class CoachingRequest:
    """Input payload wrapping canonical EngineContext (Subsystem 16)."""

    engine_context: EngineContext

    def __post_init__(self) -> None:
        if not isinstance(self.engine_context, EngineContext):
            raise TypeError(
                f"engine_context must be an EngineContext instance; got {type(self.engine_context)!r}"
            )


@dataclass(frozen=True, slots=True)
class CoachingReport:
    """Immutable, pure canonical advisory report produced by AI Coach."""

    subject_id: str
    subject_type: str
    insights: tuple[CoachInsight, ...] = ()

    def __post_init__(self) -> None:
        _validate_non_empty_str(self.subject_id, "subject_id")
        _validate_non_empty_str(self.subject_type, "subject_type")
        if not isinstance(self.insights, tuple):
            object.__setattr__(self, "insights", tuple(self.insights))
        for item in self.insights:
            if not isinstance(item, CoachInsight):
                raise TypeError(
                    f"items in insights must be CoachInsight instances; got {type(item)!r}"
                )
