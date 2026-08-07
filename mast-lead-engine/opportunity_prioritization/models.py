"""
opportunity_prioritization/models.py
=====================================

Immutable domain models for Opportunity Prioritization in the MAST Lead Engine.

Design Rules
------------
- Frozen, slotted dataclasses — runtime mutation is impossible.
- Pure derived evaluation output — contains continuous deterministic priority values.
- Zero hidden clocks — explicit evaluation_at datetime required in policy.
- Zero ranking or tier classifications — ranking and classification belong to outer layers.
- Single source of truth for strategy weights — predefined strategies determine weights internally;
  explicit weights are strictly restricted to CUSTOM_WEIGHTED.
- Strict isolation: Consumes standard library types only.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from enum import Enum
from typing import Optional


def _validate_non_empty_str(value: str, label: str) -> None:
    """Raise ValueError if value is not a non-empty string."""
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{label} must be a non-empty string; got {value!r}")


class PrioritizationStrategy(str, Enum):
    """
    Strategy defining relative weighting of quality score vs recency decay.
    """

    SCORE_DOMINANT = "SCORE_DOMINANT"      # Canonical weights: 80% Score, 20% Recency
    BALANCED = "BALANCED"                  # Canonical weights: 50% Score, 50% Recency
    RECENCY_DOMINANT = "RECENCY_DOMINANT"  # Canonical weights: 20% Score, 80% Recency
    CUSTOM_WEIGHTED = "CUSTOM_WEIGHTED"    # User-specified custom weights


_PREDEFINED_STRATEGY_WEIGHTS: dict[PrioritizationStrategy, tuple[float, float]] = {
    PrioritizationStrategy.SCORE_DOMINANT: (0.8, 0.2),
    PrioritizationStrategy.BALANCED: (0.5, 0.5),
    PrioritizationStrategy.RECENCY_DOMINANT: (0.2, 0.8),
}


@dataclass(frozen=True, slots=True)
class PrioritizationPolicy:
    """
    Immutable configuration policy governing priority calculation.

    Fields
    ------
    strategy
        Predefined weighting strategy or CUSTOM_WEIGHTED.
    evaluation_at
        Mandatory explicit evaluation timestamp (hidden clocks like datetime.now() are forbidden).
    score_weight
        Weight applied to the intrinsic quality score. Only allowed for CUSTOM_WEIGHTED.
    recency_weight
        Weight applied to the recency decay factor. Only allowed for CUSTOM_WEIGHTED.
    recency_half_life_days
        Half-life in days for exponential recency decay (must be > 0.0).
    require_qualification
        If True, unqualified opportunities are marked ineligible and assigned zero priority score.
    """

    strategy: PrioritizationStrategy
    evaluation_at: datetime
    score_weight: Optional[float] = None
    recency_weight: Optional[float] = None
    recency_half_life_days: float = 30.0
    require_qualification: bool = True

    def __post_init__(self) -> None:
        if not isinstance(self.strategy, PrioritizationStrategy):
            raise TypeError(
                f"strategy must be a PrioritizationStrategy enum instance; got {type(self.strategy)!r}"
            )

        if not isinstance(self.evaluation_at, datetime):
            raise TypeError(
                f"evaluation_at must be an explicit datetime instance; got {type(self.evaluation_at)!r}"
            )

        if not isinstance(self.recency_half_life_days, (int, float)):
            raise TypeError(
                f"recency_half_life_days must be a float or int; got {type(self.recency_half_life_days)!r}"
            )

        if not isinstance(self.require_qualification, bool):
            raise TypeError(
                f"require_qualification must be a bool; got {type(self.require_qualification)!r}"
            )

        half_life = float(self.recency_half_life_days)
        if half_life <= 0.0:
            raise ValueError(f"recency_half_life_days must be > 0.0; got {half_life}")

        object.__setattr__(self, "recency_half_life_days", half_life)

        # Single source of truth enforcement for strategy vs explicit weights
        if self.strategy in _PREDEFINED_STRATEGY_WEIGHTS:
            if self.score_weight is not None or self.recency_weight is not None:
                raise ValueError(
                    f"Explicit score_weight/recency_weight cannot be specified for predefined strategy "
                    f"{self.strategy.name!r}. Use PrioritizationStrategy.CUSTOM_WEIGHTED."
                )

            s_weight, r_weight = _PREDEFINED_STRATEGY_WEIGHTS[self.strategy]
            object.__setattr__(self, "score_weight", s_weight)
            object.__setattr__(self, "recency_weight", r_weight)
        else:
            # CUSTOM_WEIGHTED strategy
            s_val = 0.5 if self.score_weight is None else self.score_weight
            r_val = 0.5 if self.recency_weight is None else self.recency_weight

            if not isinstance(s_val, (int, float)):
                raise TypeError(
                    f"score_weight must be a float or int; got {type(s_val)!r}"
                )

            if not isinstance(r_val, (int, float)):
                raise TypeError(
                    f"recency_weight must be a float or int; got {type(r_val)!r}"
                )

            s_weight = float(s_val)
            r_weight = float(r_val)

            if s_weight < 0.0:
                raise ValueError(f"score_weight must be >= 0.0; got {s_weight}")

            if r_weight < 0.0:
                raise ValueError(f"recency_weight must be >= 0.0; got {r_weight}")

            if (s_weight + r_weight) <= 0.0:
                raise ValueError(
                    f"Sum of score_weight and recency_weight must be > 0.0; got {s_weight + r_weight}"
                )

            object.__setattr__(self, "score_weight", s_weight)
            object.__setattr__(self, "recency_weight", r_weight)


@dataclass(frozen=True, slots=True)
class OpportunityPriority:
    """
    Immutable derived evaluation result representing the continuous priority of an Opportunity.

    Fields
    ------
    opportunity_id
        Canonical reference identifier of the evaluated Opportunity.
    priority_score
        Normalized continuous priority score clamped to range [0.0, 100.0].
    score_contribution
        Component of the priority score contributed by the intrinsic quality score [0.0, 100.0].
    recency_contribution
        Component of the priority score contributed by recency decay [0.0, 100.0].
    is_eligible
        Boolean flag indicating whether the opportunity satisfied policy qualification requirements.
    """

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

        clamped_score = float(max(0.0, min(100.0, float(self.priority_score))))
        clamped_s_contrib = float(max(0.0, min(100.0, float(self.score_contribution))))
        clamped_r_contrib = float(max(0.0, min(100.0, float(self.recency_contribution))))

        object.__setattr__(self, "priority_score", clamped_score)
        object.__setattr__(self, "score_contribution", clamped_s_contrib)
        object.__setattr__(self, "recency_contribution", clamped_r_contrib)
