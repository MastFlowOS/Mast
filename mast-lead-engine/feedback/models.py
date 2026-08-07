"""
Subsystem 19 — Feedback Loop Domain Models
===========================================

Strictly immutable, frozen, slotted dataclasses representing canonical feedback evidence.
Adheres to Lead Engine 2.0 principles:
- Immutable dataclasses (@dataclass(frozen=True, slots=True))
- Enforces strict tuple invariants without silent mutation
- Zero surrogate IDs
- Zero persistence or infrastructure metadata
- Zero EngineContext dependency
"""

from dataclasses import dataclass
from enum import Enum
from typing import Optional, Tuple


class FeedbackOutcomeType(str, Enum):
    """Canonical outcome observations."""
    MISSION_ACCEPTED = "mission_accepted"
    MISSION_DISMISSED = "mission_dismissed"
    OPPORTUNITY_IGNORED = "opportunity_ignored"
    OPPORTUNITY_CONVERTED = "opportunity_converted"
    MEETING_BOOKED = "meeting_booked"
    PROPOSAL_SENT = "proposal_sent"
    CLIENT_WON = "client_won"
    FALSE_POSITIVE = "false_positive"
    DUPLICATE_OPPORTUNITY = "duplicate_opportunity"


class FeedbackTargetType(str, Enum):
    """Canonical target entity types for feedback evidence."""
    OPPORTUNITY = "opportunity"
    MISSION = "mission"
    BUSINESS = "business"
    PROVIDER = "provider"


@dataclass(frozen=True, slots=True)
class FeedbackEvidence:
    """
    Immutable payload holding optional qualitative observation notes and key-value metadata tuples.
    Does NOT perform silent type coercion; enforces strict type invariants at construction.
    """
    notes: Optional[str] = None
    metadata: Tuple[Tuple[str, str], ...] = ()

    def __post_init__(self) -> None:
        if self.notes is not None and not isinstance(self.notes, str):
            raise TypeError(f"notes must be str or None, got {type(self.notes).__name__}")
        
        if not isinstance(self.metadata, tuple):
            raise TypeError(f"metadata must be a tuple, got {type(self.metadata).__name__}")
        
        for item in self.metadata:
            if not isinstance(item, tuple) or len(item) != 2:
                raise TypeError(f"Each metadata entry must be a 2-tuple, got {item!r}")
            if not isinstance(item[0], str) or not isinstance(item[1], str):
                raise TypeError(f"Metadata key and value must be strings, got {item!r}")


@dataclass(frozen=True, slots=True)
class FeedbackRecord:
    """
    Canonical, minimalist feedback observation linking a target entity to an observed outcome.
    Natural identity is derived from (target_type, target_id, outcome).
    """
    target_type: FeedbackTargetType
    target_id: str
    outcome: FeedbackOutcomeType
    evidence: FeedbackEvidence = FeedbackEvidence()

    def __post_init__(self) -> None:
        if not isinstance(self.target_type, FeedbackTargetType):
            raise TypeError(f"target_type must be FeedbackTargetType, got {type(self.target_type).__name__}")
        
        if not isinstance(self.target_id, str):
            raise TypeError(f"target_id must be str, got {type(self.target_id).__name__}")
        
        if not self.target_id.strip():
            raise ValueError("target_id must not be empty or whitespace-only")
        
        if not isinstance(self.outcome, FeedbackOutcomeType):
            raise TypeError(f"outcome must be FeedbackOutcomeType, got {type(self.outcome).__name__}")
        
        if not isinstance(self.evidence, FeedbackEvidence):
            raise TypeError(f"evidence must be FeedbackEvidence, got {type(self.evidence).__name__}")
