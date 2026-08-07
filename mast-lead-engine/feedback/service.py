"""
Subsystem 19 — Feedback Loop Service API
==========================================

Stateless FeedbackService class providing pure, deterministic functions for capturing
and validating canonical feedback evidence.

Adheres to Lead Engine 2.0 principles:
- Stateless service class with @staticmethod functions
- Normalizes inputs at the service boundary (coercing iterables into immutable tuples)
- Deterministic behavior
- Zero hidden clocks, zero registries, zero global state
"""

from typing import Iterable, Optional, Tuple, Union
from feedback.models import (
    FeedbackEvidence,
    FeedbackOutcomeType,
    FeedbackRecord,
    FeedbackTargetType,
)


class FeedbackService:
    """
    Stateless service class for Subsystem 19 — Feedback Loop.
    Normalizes inputs into immutable domain models without mutating internal engine state.
    """

    @staticmethod
    def capture_feedback(
        target_type: Union[FeedbackTargetType, str],
        target_id: str,
        outcome: Union[FeedbackOutcomeType, str],
        notes: Optional[str] = None,
        metadata: Optional[Iterable[Tuple[str, str]]] = None,
    ) -> FeedbackRecord:
        """
        Pure, stateless function to capture and return an immutable FeedbackRecord.

        Service Boundary Responsibility:
        - Coerces string target_type or outcome into canonical Enums if necessary.
        - Coerces metadata iterable into a strict tuple of (str, str) pairs before instantiating models.
        """
        resolved_target_type = (
            target_type
            if isinstance(target_type, FeedbackTargetType)
            else FeedbackTargetType(target_type)
        )

        resolved_outcome = (
            outcome
            if isinstance(outcome, FeedbackOutcomeType)
            else FeedbackOutcomeType(outcome)
        )

        # Normalize metadata at service boundary into a tuple of (str, str)
        if metadata is None:
            normalized_metadata: Tuple[Tuple[str, str], ...] = ()
        else:
            meta_list = []
            for item in metadata:
                if not isinstance(item, (tuple, list)) or len(item) != 2:
                    raise TypeError(f"Metadata item must be a 2-element sequence, got {item!r}")
                meta_list.append((str(item[0]), str(item[1])))
            normalized_metadata = tuple(meta_list)

        evidence = FeedbackEvidence(
            notes=notes,
            metadata=normalized_metadata,
        )

        return FeedbackRecord(
            target_type=resolved_target_type,
            target_id=target_id,
            outcome=resolved_outcome,
            evidence=evidence,
        )
