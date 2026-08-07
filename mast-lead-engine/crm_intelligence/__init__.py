"""Subsystem 23: CRM Intelligence in MAST Lead Engine 2.0.

Provides pure, deterministic reasoning over workspace-to-business relationship
lifecycle stage, health status, and contact policy guardrails.

Architectural Guarantees:
- Single input boundary: RelationshipEvaluationRequest.
- Immutable domain models using @dataclass(frozen=True, slots=True).
- Pure, stateless service API with zero side-effects.
- Zero hidden clocks (explicit current_timestamp_iso parameter).
- Zero database or infrastructure dependencies.
"""

from crm_intelligence.models import (
    ContactGuardrailDecision,
    ContactPolicy,
    InteractionRecord,
    RelationshipEvaluationRequest,
    RelationshipHealth,
    RelationshipStage,
    RelationshipState,
)
from crm_intelligence.service import CRMIntelligenceService

__all__ = [
    "ContactGuardrailDecision",
    "ContactPolicy",
    "InteractionRecord",
    "RelationshipEvaluationRequest",
    "RelationshipHealth",
    "RelationshipStage",
    "RelationshipState",
    "CRMIntelligenceService",
]
