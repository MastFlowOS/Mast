"""Immutable domain models for CRM Intelligence (Subsystem 23) in the MAST Lead Engine 2.0.

Architectural Constraints:
- Pure, immutable data containers using @dataclass(frozen=True, slots=True).
- Explicit validation in __post_init__ enforcing domain invariants.
- Strict tuple coercion for collection fields to prevent mutability leaks.
- Zero external infrastructure or database dependencies.
"""

from dataclasses import dataclass, field
from enum import Enum
from typing import Optional, Tuple, Sequence


class RelationshipStage(str, Enum):
    """Canonical lifecycle stage of the relationship between a workspace and a business entity."""

    UNTOUCHED = "UNTOUCHED"
    IN_ATTEMPT = "IN_ATTEMPT"
    ENGAGED = "ENGAGED"
    NURTURING = "NURTURING"
    CONVERTED = "CONVERTED"
    DORMANT = "DORMANT"
    OPTED_OUT = "OPTED_OUT"


class RelationshipHealth(str, Enum):
    """Indicator of relationship health and interaction fatigue."""

    PRISTINE = "PRISTINE"
    RESPONSIVE = "RESPONSIVE"
    COOLING_OFF = "COOLING_OFF"
    FATIGUED = "FATIGUED"
    TERMINATED = "TERMINATED"


class ContactGuardrailDecision(str, Enum):
    """Deterministic policy decision governing whether new outreach is permitted."""

    ALLOWED = "ALLOWED"
    BLOCKED_COOLING_OFF = "BLOCKED_COOLING_OFF"
    BLOCKED_FREQUENCY_CAP = "BLOCKED_FREQUENCY_CAP"
    BLOCKED_OPT_OUT = "BLOCKED_OPT_OUT"
    BLOCKED_CONVERTED = "BLOCKED_CONVERTED"


@dataclass(frozen=True, slots=True)
class ContactPolicy:
    """Policy rules governing outreach frequency, rest periods, and decay thresholds."""

    max_attempts_per_window: int = 3
    window_days: int = 30
    cooling_off_days: int = 14
    dormancy_days: int = 60

    def __post_init__(self) -> None:
        if self.max_attempts_per_window <= 0:
            raise ValueError(
                f"max_attempts_per_window must be > 0, got {self.max_attempts_per_window}"
            )
        if self.window_days <= 0:
            raise ValueError(f"window_days must be > 0, got {self.window_days}")
        if self.cooling_off_days < 0:
            raise ValueError(
                f"cooling_off_days must be >= 0, got {self.cooling_off_days}"
            )
        if self.dormancy_days <= 0:
            raise ValueError(f"dormancy_days must be > 0, got {self.dormancy_days}")


@dataclass(frozen=True, slots=True)
class InteractionRecord:
    """Historical interaction event between a workspace and a business entity."""

    timestamp_iso: str
    interaction_type: str
    outcome_type: str = ""
    is_opt_out: bool = False
    is_conversion: bool = False
    is_positive: bool = False

    def __post_init__(self) -> None:
        if not isinstance(self.timestamp_iso, str) or not self.timestamp_iso.strip():
            raise ValueError("InteractionRecord.timestamp_iso must be a non-empty string.")
        if not isinstance(self.interaction_type, str) or not self.interaction_type.strip():
            raise ValueError("InteractionRecord.interaction_type must be a non-empty string.")


@dataclass(frozen=True, slots=True)
class RelationshipEvaluationRequest:
    """Single evaluation request containing history, evaluation context timestamp, and policy."""

    workspace_id: str
    business_id: str
    current_timestamp_iso: str
    interaction_history: Tuple[InteractionRecord, ...] = field(default_factory=tuple)
    policy: ContactPolicy = field(default_factory=ContactPolicy)

    def __post_init__(self) -> None:
        if not isinstance(self.workspace_id, str) or not self.workspace_id.strip():
            raise ValueError("workspace_id must be a non-empty string.")
        if not isinstance(self.business_id, str) or not self.business_id.strip():
            raise ValueError("business_id must be a non-empty string.")
        if not isinstance(self.current_timestamp_iso, str) or not self.current_timestamp_iso.strip():
            raise ValueError("current_timestamp_iso must be a non-empty string.")
        if not isinstance(self.policy, ContactPolicy):
            raise TypeError(f"policy must be a ContactPolicy instance, got {type(self.policy)}")

        # Enforce tuple coercion for immutability
        if not isinstance(self.interaction_history, tuple):
            object.__setattr__(
                self, "interaction_history", tuple(self.interaction_history)
            )

        for record in self.interaction_history:
            if not isinstance(record, InteractionRecord):
                raise TypeError(
                    f"interaction_history elements must be InteractionRecord, got {type(record)}"
                )


@dataclass(frozen=True, slots=True)
class RelationshipState:
    """Evaluated canonical state of a workspace-to-business relationship."""

    workspace_id: str
    business_id: str
    stage: RelationshipStage
    health: RelationshipHealth
    guardrail_decision: ContactGuardrailDecision
    total_attempts: int
    attempts_in_window: int
    days_since_last_interaction: Optional[float]
    reason: str

    def __post_init__(self) -> None:
        if not isinstance(self.workspace_id, str) or not self.workspace_id.strip():
            raise ValueError("workspace_id must be a non-empty string.")
        if not isinstance(self.business_id, str) or not self.business_id.strip():
            raise ValueError("business_id must be a non-empty string.")
        if not isinstance(self.stage, RelationshipStage):
            raise TypeError(f"stage must be a RelationshipStage, got {type(self.stage)}")
        if not isinstance(self.health, RelationshipHealth):
            raise TypeError(f"health must be a RelationshipHealth, got {type(self.health)}")
        if not isinstance(self.guardrail_decision, ContactGuardrailDecision):
            raise TypeError(
                f"guardrail_decision must be a ContactGuardrailDecision, got {type(self.guardrail_decision)}"
            )
        if self.total_attempts < 0:
            raise ValueError(f"total_attempts must be >= 0, got {self.total_attempts}")
        if self.attempts_in_window < 0:
            raise ValueError(f"attempts_in_window must be >= 0, got {self.attempts_in_window}")
        if self.days_since_last_interaction is not None and self.days_since_last_interaction < 0:
            raise ValueError(
                f"days_since_last_interaction must be >= 0 or None, got {self.days_since_last_interaction}"
            )
        if not isinstance(self.reason, str) or not self.reason.strip():
            raise ValueError("reason must be a non-empty string.")
