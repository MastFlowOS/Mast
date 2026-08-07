"""
Subsystem 19 — Feedback Loop
=============================

Public package interface exporting canonical feedback domain models and the stateless FeedbackService.
"""

from feedback.models import (
    FeedbackEvidence,
    FeedbackOutcomeType,
    FeedbackRecord,
    FeedbackTargetType,
)
from feedback.service import FeedbackService

__all__ = [
    "FeedbackOutcomeType",
    "FeedbackTargetType",
    "FeedbackEvidence",
    "FeedbackRecord",
    "FeedbackService",
]
