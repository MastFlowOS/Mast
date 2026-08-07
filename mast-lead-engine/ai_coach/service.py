"""
ai_coach/service.py
===================

Pure, stateless advisory service for Subsystem 17 (AI Coach).

Design Rules
------------
- Pure functions only — zero side effects, zero I/O, zero state persistence.
- Accepts strictly CoachingRequest (wrapping EngineContext).
- Transforms canonical EngineContext into a CoachingReport.
- Zero infrastructure state, zero provider awareness, zero prompt templates.
- Infrastructure Separation Rule: Lead Engine service methods must never represent
  or process infrastructure failures (availability, retries, rate limits, networking).
"""

from __future__ import annotations

from typing import Sequence

from .models import CoachInsight, CoachingReport, CoachingRequest


class AICoachService:
    """Pure, stateless advisory service for canonical engine context."""

    @staticmethod
    def generate_coaching_report(
        request: CoachingRequest,
        insights: Sequence[CoachInsight] | None = None,
    ) -> CoachingReport:
        """
        Generates an immutable CoachingReport from a CoachingRequest.

        Pure projection transformer. Accepts optional pre-generated canonical insights.
        """
        if not isinstance(request, CoachingRequest):
            raise TypeError(
                f"request must be a CoachingRequest instance; got {type(request)!r}"
            )

        subject = request.engine_context.subject
        insight_tuple = tuple(insights) if insights is not None else ()

        for item in insight_tuple:
            if not isinstance(item, CoachInsight):
                raise TypeError(
                    f"items in insights must be CoachInsight instances; got {type(item)!r}"
                )

        subject_type_str = (
            subject.subject_type.value
            if hasattr(subject.subject_type, "value")
            else str(subject.subject_type)
        )

        return CoachingReport(
            subject_id=subject.subject_id,
            subject_type=subject_type_str,
            insights=insight_tuple,
        )
