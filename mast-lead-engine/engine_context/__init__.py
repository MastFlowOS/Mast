"""
engine_context
==============

Canonical Engine Context Projection (Subsystem 16) in the MAST Lead Engine 2.0.

Design Rules
------------
- Stateless, deterministic projection of canonical engine entities into an EngineContext snapshot.
- Zero downstream consumer optimizations (no LLM, token, prompt, or provider assumptions).
- 100% frozen, slotted dataclasses and immutable tuple collections.
- Faithfully projects canonical upstream fields (Subsystems 5, 9–15).
"""

from .models import (
    BusinessContext,
    ContextComponent,
    ContextProjectionRequest,
    ContextSubject,
    ContextSubjectType,
    EngineContext,
    MissionContext,
    OpportunityContext,
    PriorityContext,
    QualificationContext,
    RankContext,
    ScoreContext,
    WorkflowContext,
)
from .service import ContextProjectionService

__all__ = [
    "ContextSubjectType",
    "ContextComponent",
    "ContextSubject",
    "ContextProjectionRequest",
    "BusinessContext",
    "OpportunityContext",
    "QualificationContext",
    "ScoreContext",
    "PriorityContext",
    "RankContext",
    "MissionContext",
    "WorkflowContext",
    "EngineContext",
    "ContextProjectionService",
]
