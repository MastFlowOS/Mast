"""Stateless domain service for CRM Intelligence (Subsystem 23) in MAST Lead Engine 2.0.

Architectural Constraints:
- Pure, stateless service API with @staticmethod methods only.
- Zero side-effects, zero mutable global state, zero hidden system clocks.
- Deterministic calculation driven exclusively by RelationshipEvaluationRequest parameters.
- Comprehensive exception handling and invariant protection.
"""

from datetime import datetime, timezone
from typing import Tuple, List, Optional
import math

from crm_intelligence.models import (
    ContactGuardrailDecision,
    ContactPolicy,
    InteractionRecord,
    RelationshipEvaluationRequest,
    RelationshipHealth,
    RelationshipStage,
    RelationshipState,
)


class CRMIntelligenceService:
    """Pure, stateless domain service evaluating workspace-to-business relationships."""

    @staticmethod
    def _parse_iso(timestamp_iso: str) -> datetime:
        """Parse ISO-8601 timestamp string into timezone-aware datetime."""
        try:
            dt = datetime.fromisoformat(timestamp_iso.replace("Z", "+00:00"))
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=timezone.utc)
            return dt
        except Exception as err:
            raise ValueError(
                f"Invalid ISO-8601 timestamp string '{timestamp_iso}': {str(err)}"
            ) from err

    @staticmethod
    def evaluate_relationship(
        request: RelationshipEvaluationRequest,
    ) -> RelationshipState:
        """Evaluates the relationship lifecycle stage, health status, and contact guardrails.

        Args:
            request: Immutable RelationshipEvaluationRequest payload.

        Returns:
            Evaluated RelationshipState dataclass instance.

        Raises:
            TypeError: If request is not a RelationshipEvaluationRequest.
            ValueError: If timestamps are logically invalid (e.g. future relative to context).
        """
        if not isinstance(request, RelationshipEvaluationRequest):
            raise TypeError(
                f"request must be a RelationshipEvaluationRequest, got {type(request)}"
            )

        eval_dt = CRMIntelligenceService._parse_iso(request.current_timestamp_iso)
        history = request.interaction_history
        policy = request.policy

        if not history:
            return RelationshipState(
                workspace_id=request.workspace_id,
                business_id=request.business_id,
                stage=RelationshipStage.UNTOUCHED,
                health=RelationshipHealth.PRISTINE,
                guardrail_decision=ContactGuardrailDecision.ALLOWED,
                total_attempts=0,
                attempts_in_window=0,
                days_since_last_interaction=None,
                reason="Zero interaction history recorded. Entity is untouched.",
            )

        # Parse & validate interaction timestamps
        parsed_records: List[Tuple[InteractionRecord, datetime, float]] = []
        for rec in history:
            rec_dt = CRMIntelligenceService._parse_iso(rec.timestamp_iso)
            delta_seconds = (eval_dt - rec_dt).total_seconds()
            if delta_seconds < -1e-3:  # Tolerating sub-millisecond precision float drift
                raise ValueError(
                    f"Interaction timestamp '{rec.timestamp_iso}' is in the future relative to "
                    f"evaluation timestamp '{request.current_timestamp_iso}'."
                )
            delta_days = max(0.0, delta_seconds / 86400.0)
            parsed_records.append((rec, rec_dt, delta_days))

        # Sort history chronologically (earliest to latest)
        parsed_records.sort(key=lambda x: x[1])

        total_attempts = len(parsed_records)
        last_rec, last_dt, days_since_last = parsed_records[-1]

        attempts_in_window = sum(
            1 for _, _, d_days in parsed_records if d_days <= policy.window_days
        )
        any_opt_out = any(r.is_opt_out for r, _, _ in parsed_records)
        any_conversion = any(r.is_conversion for r, _, _ in parsed_records)
        has_positive = any(
            (r.is_positive or r.is_conversion) for r, _, _ in parsed_records
        )

        # 1. Evaluate Guardrail Decision
        if any_opt_out:
            guardrail = ContactGuardrailDecision.BLOCKED_OPT_OUT
            guardrail_reason = "Outreach blocked: Explicit opt-out/unsubscribe record present."
        elif any_conversion:
            guardrail = ContactGuardrailDecision.BLOCKED_CONVERTED
            guardrail_reason = "Outreach blocked: Business entity is already converted."
        elif (
            days_since_last < policy.cooling_off_days
            and not last_rec.is_positive
            and not last_rec.is_conversion
        ):
            guardrail = ContactGuardrailDecision.BLOCKED_COOLING_OFF
            guardrail_reason = (
                f"Outreach blocked: Cooling-off rest period active "
                f"({days_since_last:.1f} days elapsed < {policy.cooling_off_days} days required)."
            )
        elif attempts_in_window >= policy.max_attempts_per_window:
            guardrail = ContactGuardrailDecision.BLOCKED_FREQUENCY_CAP
            guardrail_reason = (
                f"Outreach blocked: Frequency cap reached "
                f"({attempts_in_window} attempts in rolling {policy.window_days}-day window >= max {policy.max_attempts_per_window})."
            )
        else:
            guardrail = ContactGuardrailDecision.ALLOWED
            guardrail_reason = "Outreach permitted under current workspace policy."

        # 2. Evaluate Relationship Stage
        if any_opt_out:
            stage = RelationshipStage.OPTED_OUT
        elif any_conversion:
            stage = RelationshipStage.CONVERTED
        elif days_since_last > policy.dormancy_days:
            stage = RelationshipStage.DORMANT
        elif has_positive:
            if days_since_last > policy.cooling_off_days:
                stage = RelationshipStage.NURTURING
            else:
                stage = RelationshipStage.ENGAGED
        else:
            stage = RelationshipStage.IN_ATTEMPT

        # 3. Evaluate Relationship Health
        if stage == RelationshipStage.OPTED_OUT:
            health = RelationshipHealth.TERMINATED
        elif has_positive and not any_opt_out:
            health = RelationshipHealth.RESPONSIVE
        elif (
            attempts_in_window >= policy.max_attempts_per_window
            or total_attempts >= policy.max_attempts_per_window * 2
        ):
            health = RelationshipHealth.FATIGUED
        elif guardrail == ContactGuardrailDecision.BLOCKED_COOLING_OFF:
            health = RelationshipHealth.COOLING_OFF
        else:
            health = RelationshipHealth.PRISTINE

        reason = (
            f"Stage: {stage.value}, Health: {health.value}, Decision: {guardrail.value}. "
            f"{guardrail_reason}"
        )

        return RelationshipState(
            workspace_id=request.workspace_id,
            business_id=request.business_id,
            stage=stage,
            health=health,
            guardrail_decision=guardrail,
            total_attempts=total_attempts,
            attempts_in_window=attempts_in_window,
            days_since_last_interaction=round(days_since_last, 4),
            reason=reason,
        )

    @staticmethod
    def evaluate_batch(
        requests: Tuple[RelationshipEvaluationRequest, ...],
    ) -> Tuple[RelationshipState, ...]:
        """Batch evaluates multiple relationship evaluation requests deterministically.

        Args:
            requests: Tuple of RelationshipEvaluationRequest objects.

        Returns:
            Tuple of evaluated RelationshipState objects in identical order.
        """
        if not isinstance(requests, (tuple, list)):
            raise TypeError(f"requests must be a sequence/tuple, got {type(requests)}")

        results: List[RelationshipState] = []
        for idx, req in enumerate(requests):
            if not isinstance(req, RelationshipEvaluationRequest):
                raise TypeError(
                    f"requests[{idx}] must be a RelationshipEvaluationRequest, got {type(req)}"
                )
            results.append(CRMIntelligenceService.evaluate_relationship(req))

        return tuple(results)
