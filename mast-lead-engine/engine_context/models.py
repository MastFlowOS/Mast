"""
engine_context/models.py
========================

Immutable domain models for Engine Context Projection (Subsystem 16) in the MAST Lead Engine 2.0.

Design Rules
------------
- Frozen, slotted dataclasses — runtime mutation is impossible.
- Collections are stored as immutable `tuple`.
- Pure canonical projection — contains zero downstream AI, token, prompt, or vendor concerns.
- 1:1 mapping with canonical upstream attributes (Subsystems 5, 9–15).
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum


def _validate_non_empty_str(value: str, label: str) -> None:
    """Raise ValueError if value is not a non-empty string."""
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{label} must be a non-empty string; got {value!r}")


class ContextSubjectType(str, Enum):
    """Canonical target subject type for context projection."""

    BUSINESS = "BUSINESS"
    OPPORTUNITY = "OPPORTUNITY"
    MISSION = "MISSION"
    WORKFLOW = "WORKFLOW"
    WORKSPACE = "WORKSPACE"


class ContextComponent(str, Enum):
    """Canonical engine subsystem component types."""

    BUSINESS = "BUSINESS"
    OPPORTUNITY = "OPPORTUNITY"
    QUALIFICATION = "QUALIFICATION"
    SCORE = "SCORE"
    PRIORITY = "PRIORITY"
    RANK = "RANK"
    MISSION = "MISSION"
    WORKFLOW = "WORKFLOW"


@dataclass(frozen=True, slots=True)
class ContextSubject:
    """Target subject for context projection."""

    subject_id: str
    subject_type: ContextSubjectType

    def __post_init__(self) -> None:
        _validate_non_empty_str(self.subject_id, "subject_id")
        if not isinstance(self.subject_type, ContextSubjectType):
            raise TypeError(
                f"subject_type must be a ContextSubjectType enum; got {type(self.subject_type)!r}"
            )


@dataclass(frozen=True, slots=True)
class ContextProjectionRequest:
    """Specification for projecting engine context."""

    subject: ContextSubject
    requested_components: tuple[ContextComponent, ...] = (
        ContextComponent.BUSINESS,
        ContextComponent.OPPORTUNITY,
        ContextComponent.QUALIFICATION,
        ContextComponent.SCORE,
        ContextComponent.PRIORITY,
        ContextComponent.RANK,
        ContextComponent.MISSION,
        ContextComponent.WORKFLOW,
    )

    def __post_init__(self) -> None:
        if not isinstance(self.subject, ContextSubject):
            raise TypeError(f"subject must be a ContextSubject instance; got {type(self.subject)!r}")
        if not isinstance(self.requested_components, tuple):
            object.__setattr__(
                self, "requested_components", tuple(self.requested_components)
            )
        for comp in self.requested_components:
            if not isinstance(comp, ContextComponent):
                raise TypeError(
                    f"items in requested_components must be ContextComponent enums; got {type(comp)!r}"
                )


@dataclass(frozen=True, slots=True)
class BusinessContext:
    """Canonical projection of Subsystem 5 (Business)."""

    business_id: str
    name: str
    category: str | None = None
    address: str | None = None
    city: str | None = None
    region: str | None = None
    country: str | None = None
    description: str | None = None
    phones: tuple[str, ...] = ()
    emails: tuple[str, ...] = ()
    websites: tuple[str, ...] = ()

    def __post_init__(self) -> None:
        _validate_non_empty_str(self.business_id, "business_id")
        _validate_non_empty_str(self.name, "name")
        for col_name in ("phones", "emails", "websites"):
            val = getattr(self, col_name)
            if not isinstance(val, tuple):
                val_tuple = tuple(val)
                object.__setattr__(self, col_name, val_tuple)
            else:
                val_tuple = val
            for item in val_tuple:
                _validate_non_empty_str(item, f"item in {col_name}")


@dataclass(frozen=True, slots=True)
class OpportunityContext:
    """Canonical projection of Subsystem 9 (Opportunity Intelligence)."""

    opportunity_id: str
    business_id: str
    niche_id: str
    opportunity_type_id: str
    supporting_signal_ids: tuple[str, ...] = ()

    def __post_init__(self) -> None:
        _validate_non_empty_str(self.opportunity_id, "opportunity_id")
        _validate_non_empty_str(self.business_id, "business_id")
        _validate_non_empty_str(self.niche_id, "niche_id")
        _validate_non_empty_str(self.opportunity_type_id, "opportunity_type_id")
        if not isinstance(self.supporting_signal_ids, tuple):
            sig_tuple = tuple(self.supporting_signal_ids)
            object.__setattr__(self, "supporting_signal_ids", sig_tuple)
        else:
            sig_tuple = self.supporting_signal_ids
        for sig_id in sig_tuple:
            _validate_non_empty_str(sig_id, "item in supporting_signal_ids")


@dataclass(frozen=True, slots=True)
class QualificationContext:
    """Canonical projection of Subsystem 10 (Opportunity Qualification)."""

    opportunity_id: str
    status: str
    passed_rule_ids: tuple[str, ...] = ()
    failed_rule_ids: tuple[str, ...] = ()

    def __post_init__(self) -> None:
        _validate_non_empty_str(self.opportunity_id, "opportunity_id")
        _validate_non_empty_str(self.status, "status")
        for col_name in ("passed_rule_ids", "failed_rule_ids"):
            val = getattr(self, col_name)
            if not isinstance(val, tuple):
                val_tuple = tuple(val)
                object.__setattr__(self, col_name, val_tuple)
            else:
                val_tuple = val
            for rule_id in val_tuple:
                _validate_non_empty_str(rule_id, f"item in {col_name}")


@dataclass(frozen=True, slots=True)
class ScoreContext:
    """Canonical projection of Subsystem 11 (Opportunity Scoring)."""

    opportunity_id: str
    overall_score: float

    def __post_init__(self) -> None:
        _validate_non_empty_str(self.opportunity_id, "opportunity_id")
        if not isinstance(self.overall_score, (int, float)):
            raise TypeError(
                f"overall_score must be a float or int; got {type(self.overall_score)!r}"
            )
        object.__setattr__(self, "overall_score", float(self.overall_score))


@dataclass(frozen=True, slots=True)
class PriorityContext:
    """Canonical projection of Subsystem 12 (Opportunity Prioritization)."""

    opportunity_id: str
    priority_score: float
    score_contribution: float
    recency_contribution: float
    is_eligible: bool

    def __post_init__(self) -> None:
        _validate_non_empty_str(self.opportunity_id, "opportunity_id")
        if not isinstance(self.priority_score, (int, float)):
            raise TypeError(
                f"priority_score must be a float or int; got {type(self.priority_score)!r}"
            )
        if not isinstance(self.score_contribution, (int, float)):
            raise TypeError(
                f"score_contribution must be a float or int; got {type(self.score_contribution)!r}"
            )
        if not isinstance(self.recency_contribution, (int, float)):
            raise TypeError(
                f"recency_contribution must be a float or int; got {type(self.recency_contribution)!r}"
            )
        if not isinstance(self.is_eligible, bool):
            raise TypeError(
                f"is_eligible must be a bool; got {type(self.is_eligible)!r}"
            )
        object.__setattr__(self, "priority_score", float(self.priority_score))
        object.__setattr__(self, "score_contribution", float(self.score_contribution))
        object.__setattr__(self, "recency_contribution", float(self.recency_contribution))


@dataclass(frozen=True, slots=True)
class RankContext:
    """Canonical projection of Subsystem 13 (Opportunity Ranking)."""

    opportunity_id: str
    rank: int
    priority_score: float

    def __post_init__(self) -> None:
        _validate_non_empty_str(self.opportunity_id, "opportunity_id")
        if not isinstance(self.rank, int) or isinstance(self.rank, bool):
            raise TypeError(f"rank must be an int; got {type(self.rank)!r}")
        if self.rank < 1:
            raise ValueError(f"rank must be >= 1; got {self.rank}")
        if not isinstance(self.priority_score, (int, float)):
            raise TypeError(
                f"priority_score must be a float or int; got {type(self.priority_score)!r}"
            )
        object.__setattr__(self, "priority_score", float(self.priority_score))


@dataclass(frozen=True, slots=True)
class MissionContext:
    """Canonical projection of Subsystem 14 (Mission Generation)."""

    opportunity_id: str
    business_id: str
    mission_type: str

    def __post_init__(self) -> None:
        _validate_non_empty_str(self.opportunity_id, "opportunity_id")
        _validate_non_empty_str(self.business_id, "business_id")
        _validate_non_empty_str(self.mission_type, "mission_type")


@dataclass(frozen=True, slots=True)
class WorkflowContext:
    """Canonical projection of Subsystem 15 (Workflow Engine)."""

    mission_id: str
    opportunity_id: str
    business_id: str
    status: str

    def __post_init__(self) -> None:
        _validate_non_empty_str(self.mission_id, "mission_id")
        _validate_non_empty_str(self.opportunity_id, "opportunity_id")
        _validate_non_empty_str(self.business_id, "business_id")
        _validate_non_empty_str(self.status, "status")


@dataclass(frozen=True, slots=True)
class EngineContext:
    """Immutable, unified snapshot of canonical engine state."""

    subject: ContextSubject
    business: BusinessContext | None = None
    opportunities: tuple[OpportunityContext, ...] = ()
    qualifications: tuple[QualificationContext, ...] = ()
    scores: tuple[ScoreContext, ...] = ()
    priorities: tuple[PriorityContext, ...] = ()
    ranks: tuple[RankContext, ...] = ()
    missions: tuple[MissionContext, ...] = ()
    workflows: tuple[WorkflowContext, ...] = ()

    def __post_init__(self) -> None:
        if not isinstance(self.subject, ContextSubject):
            raise TypeError(f"subject must be a ContextSubject instance; got {type(self.subject)!r}")
        for field_name in (
            "opportunities",
            "qualifications",
            "scores",
            "priorities",
            "ranks",
            "missions",
            "workflows",
        ):
            val = getattr(self, field_name)
            if not isinstance(val, tuple):
                object.__setattr__(self, field_name, tuple(val))
