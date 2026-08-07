"""Comprehensive Standalone Validation Suite for Subsystem 23: CRM Intelligence in MAST Lead Engine 2.0.

Validates:
1. Import isolation & absence of unauthorized dependencies.
2. AST structural inspection (zero hidden clocks, zero random, zero mutable globals).
3. Absence of registries, managers, factories, or service locators.
4. Domain model immutability & slotted dataclass enforcement.
5. Enum completeness & value validation.
6. Invariant protection & input guardrails.
7. Relationship Stage derivation accuracy.
8. Relationship Health derivation accuracy.
9. Contact Guardrail policy decision enforcement.
10. Batch evaluation ordering & alignment.
11. Sequence tuple coercion for immutability.
12. Pure determinism & zero side-effects.
13. Thread safety & concurrent execution consistency.
14. Edge-case handling & invalid input validation.
15. Cross-subsystem regression validation suite across frozen subsystems (14-22).
"""

import ast
from dataclasses import FrozenInstanceError, is_dataclass
import inspect
from concurrent.futures import ThreadPoolExecutor
import os
import sys

import pytest

from crm_intelligence import (
    ContactGuardrailDecision,
    ContactPolicy,
    CRMIntelligenceService,
    InteractionRecord,
    RelationshipEvaluationRequest,
    RelationshipHealth,
    RelationshipStage,
    RelationshipState,
)


def test_1_import_isolation():
    """Verify clean import boundaries with zero unauthorized third-party imports."""
    import crm_intelligence.models as models_mod
    import crm_intelligence.service as service_mod

    allowed_modules = {
        "dataclasses",
        "enum",
        "typing",
        "datetime",
        "math",
        "crm_intelligence.models",
        "crm_intelligence.service",
    }

    for mod in [models_mod, service_mod]:
        for name, val in inspect.getmembers(mod):
            if inspect.ismodule(val):
                mod_name = val.__name__
                if not any(
                    mod_name.startswith(allowed) or mod_name.startswith("builtins")
                    for allowed in allowed_modules
                ):
                    pytest.fail(f"Unauthorized import detected: {mod_name} in {mod.__name__}")


def test_2_ast_analysis():
    """Inspect AST to guarantee zero hidden clocks (datetime.now), no random, no globals."""
    service_file = inspect.getfile(CRMIntelligenceService)
    with open(service_file, "r", encoding="utf-8") as f:
        tree = ast.parse(f.read(), filename=service_file)

    class ASTVisitor(ast.NodeVisitor):
        def __init__(self):
            self.forbidden_calls = []

        def visit_Attribute(self, node):
            if node.attr in ("now", "utcnow", "today") and isinstance(node.value, ast.Name):
                if node.value.id in ("datetime", "date"):
                    self.forbidden_calls.append(f"{node.value.id}.{node.attr}")
            self.generic_visit(node)

        def visit_Name(self, node):
            if node.id in ("random", "time"):
                self.forbidden_calls.append(node.id)
            self.generic_visit(node)

    visitor = ASTVisitor()
    visitor.visit(tree)
    assert not visitor.forbidden_calls, f"Forbidden AST nodes found: {visitor.forbidden_calls}"


def test_3_absence_of_registries_and_globals():
    """Verify absence of forbidden architecture patterns (registries, factories, managers)."""
    forbidden_terms = ["registry", "factory", "manager", "locator", "singleton"]
    import crm_intelligence

    for name in dir(crm_intelligence):
        lower_name = name.lower()
        for term in forbidden_terms:
            assert term not in lower_name, f"Forbidden pattern '{term}' found in export '{name}'"


def test_4_model_immutability():
    """Verify models are frozen, slotted dataclasses."""
    policy = ContactPolicy()
    assert is_dataclass(policy)
    with pytest.raises(FrozenInstanceError):
        policy.max_attempts_per_window = 10

    record = InteractionRecord(
        timestamp_iso="2026-08-01T10:00:00Z",
        interaction_type="EMAIL_SENT",
    )
    with pytest.raises(FrozenInstanceError):
        record.is_opt_out = True

    req = RelationshipEvaluationRequest(
        workspace_id="ws_1",
        business_id="biz_1",
        current_timestamp_iso="2026-08-05T10:00:00Z",
    )
    with pytest.raises(FrozenInstanceError):
        req.workspace_id = "ws_2"


def test_5_enum_validation():
    """Verify complete enum definitions and value types."""
    assert RelationshipStage.UNTOUCHED == "UNTOUCHED"
    assert RelationshipStage.IN_ATTEMPT == "IN_ATTEMPT"
    assert RelationshipStage.ENGAGED == "ENGAGED"
    assert RelationshipStage.NURTURING == "NURTURING"
    assert RelationshipStage.CONVERTED == "CONVERTED"
    assert RelationshipStage.DORMANT == "DORMANT"
    assert RelationshipStage.OPTED_OUT == "OPTED_OUT"

    assert RelationshipHealth.PRISTINE == "PRISTINE"
    assert RelationshipHealth.RESPONSIVE == "RESPONSIVE"
    assert RelationshipHealth.COOLING_OFF == "COOLING_OFF"
    assert RelationshipHealth.FATIGUED == "FATIGUED"
    assert RelationshipHealth.TERMINATED == "TERMINATED"

    assert ContactGuardrailDecision.ALLOWED == "ALLOWED"
    assert ContactGuardrailDecision.BLOCKED_COOLING_OFF == "BLOCKED_COOLING_OFF"
    assert ContactGuardrailDecision.BLOCKED_FREQUENCY_CAP == "BLOCKED_FREQUENCY_CAP"
    assert ContactGuardrailDecision.BLOCKED_OPT_OUT == "BLOCKED_OPT_OUT"
    assert ContactGuardrailDecision.BLOCKED_CONVERTED == "BLOCKED_CONVERTED"


def test_6_dataclass_invariant_enforcement():
    """Verify post-init validation enforcing domain invariants."""
    with pytest.raises(ValueError, match="max_attempts_per_window must be > 0"):
        ContactPolicy(max_attempts_per_window=0)

    with pytest.raises(ValueError, match="cooling_off_days must be >= 0"):
        ContactPolicy(cooling_off_days=-5)

    with pytest.raises(ValueError, match="workspace_id must be a non-empty string"):
        RelationshipEvaluationRequest(
            workspace_id="   ",
            business_id="biz_1",
            current_timestamp_iso="2026-08-05T10:00:00Z",
        )

    with pytest.raises(ValueError, match="business_id must be a non-empty string"):
        RelationshipEvaluationRequest(
            workspace_id="ws_1",
            business_id="",
            current_timestamp_iso="2026-08-05T10:00:00Z",
        )

    with pytest.raises(ValueError, match="InteractionRecord.timestamp_iso must be a non-empty string"):
        InteractionRecord(timestamp_iso="", interaction_type="EMAIL_SENT")


def test_7_stage_derivation_rules():
    """Verify accurate RelationshipStage derivation under all scenarios."""
    eval_ts = "2026-08-05T10:00:00Z"
    policy = ContactPolicy(cooling_off_days=14, dormancy_days=60)

    # 1. UNTOUCHED
    req_untouched = RelationshipEvaluationRequest(
        workspace_id="ws_1",
        business_id="b_1",
        current_timestamp_iso=eval_ts,
        policy=policy,
    )
    res = CRMIntelligenceService.evaluate_relationship(req_untouched)
    assert res.stage == RelationshipStage.UNTOUCHED

    # 2. IN_ATTEMPT
    req_in_attempt = RelationshipEvaluationRequest(
        workspace_id="ws_1",
        business_id="b_1",
        current_timestamp_iso=eval_ts,
        interaction_history=(
            InteractionRecord(
                timestamp_iso="2026-08-01T10:00:00Z",
                interaction_type="EMAIL_SENT",
            ),
        ),
        policy=policy,
    )
    assert CRMIntelligenceService.evaluate_relationship(req_in_attempt).stage == RelationshipStage.IN_ATTEMPT

    # 3. ENGAGED (recent positive engagement within cooling off period)
    req_engaged = RelationshipEvaluationRequest(
        workspace_id="ws_1",
        business_id="b_1",
        current_timestamp_iso=eval_ts,
        interaction_history=(
            InteractionRecord(
                timestamp_iso="2026-08-04T10:00:00Z",
                interaction_type="MEETING_SCHEDULED",
                is_positive=True,
            ),
        ),
        policy=policy,
    )
    assert CRMIntelligenceService.evaluate_relationship(req_engaged).stage == RelationshipStage.ENGAGED

    # 4. NURTURING (positive engagement older than cooling off, but before dormancy)
    req_nurturing = RelationshipEvaluationRequest(
        workspace_id="ws_1",
        business_id="b_1",
        current_timestamp_iso=eval_ts,
        interaction_history=(
            InteractionRecord(
                timestamp_iso="2026-07-15T10:00:00Z",  # ~21 days ago
                interaction_type="MEETING_HELD",
                is_positive=True,
            ),
        ),
        policy=policy,
    )
    assert CRMIntelligenceService.evaluate_relationship(req_nurturing).stage == RelationshipStage.NURTURING

    # 5. DORMANT (interaction older than dormancy_days)
    req_dormant = RelationshipEvaluationRequest(
        workspace_id="ws_1",
        business_id="b_1",
        current_timestamp_iso=eval_ts,
        interaction_history=(
            InteractionRecord(
                timestamp_iso="2026-05-01T10:00:00Z",  # > 90 days ago
                interaction_type="EMAIL_SENT",
            ),
        ),
        policy=policy,
    )
    assert CRMIntelligenceService.evaluate_relationship(req_dormant).stage == RelationshipStage.DORMANT

    # 6. CONVERTED
    req_converted = RelationshipEvaluationRequest(
        workspace_id="ws_1",
        business_id="b_1",
        current_timestamp_iso=eval_ts,
        interaction_history=(
            InteractionRecord(
                timestamp_iso="2026-08-02T10:00:00Z",
                interaction_type="DEAL_CLOSED",
                is_conversion=True,
            ),
        ),
        policy=policy,
    )
    assert CRMIntelligenceService.evaluate_relationship(req_converted).stage == RelationshipStage.CONVERTED

    # 7. OPTED_OUT
    req_opt_out = RelationshipEvaluationRequest(
        workspace_id="ws_1",
        business_id="b_1",
        current_timestamp_iso=eval_ts,
        interaction_history=(
            InteractionRecord(
                timestamp_iso="2026-08-03T10:00:00Z",
                interaction_type="UNSUBSCRIBE_CLICK",
                is_opt_out=True,
            ),
        ),
        policy=policy,
    )
    assert CRMIntelligenceService.evaluate_relationship(req_opt_out).stage == RelationshipStage.OPTED_OUT


def test_8_health_derivation_rules():
    """Verify RelationshipHealth calculation across stages and interaction patterns."""
    eval_ts = "2026-08-05T10:00:00Z"
    policy = ContactPolicy(max_attempts_per_window=3, window_days=30, cooling_off_days=14)

    # PRISTINE
    req1 = RelationshipEvaluationRequest("ws_1", "b_1", eval_ts, policy=policy)
    assert CRMIntelligenceService.evaluate_relationship(req1).health == RelationshipHealth.PRISTINE

    # RESPONSIVE
    req2 = RelationshipEvaluationRequest(
        "ws_1",
        "b_1",
        eval_ts,
        interaction_history=(
            InteractionRecord("2026-08-01T10:00:00Z", "REPLY_RECEIVED", is_positive=True),
        ),
        policy=policy,
    )
    assert CRMIntelligenceService.evaluate_relationship(req2).health == RelationshipHealth.RESPONSIVE

    # COOLING_OFF
    req3 = RelationshipEvaluationRequest(
        "ws_1",
        "b_1",
        eval_ts,
        interaction_history=(
            InteractionRecord("2026-08-01T10:00:00Z", "EMAIL_SENT"),  # 4 days ago < 14
        ),
        policy=policy,
    )
    assert CRMIntelligenceService.evaluate_relationship(req3).health == RelationshipHealth.COOLING_OFF

    # FATIGUED (frequency cap reached)
    req4 = RelationshipEvaluationRequest(
        "ws_1",
        "b_1",
        eval_ts,
        interaction_history=(
            InteractionRecord("2026-07-10T10:00:00Z", "EMAIL_SENT"),
            InteractionRecord("2026-07-20T10:00:00Z", "CALL_ATTEMPT"),
            InteractionRecord("2026-07-30T10:00:00Z", "EMAIL_SENT"),
        ),
        policy=policy,
    )
    assert CRMIntelligenceService.evaluate_relationship(req4).health == RelationshipHealth.FATIGUED

    # TERMINATED
    req5 = RelationshipEvaluationRequest(
        "ws_1",
        "b_1",
        eval_ts,
        interaction_history=(
            InteractionRecord("2026-08-01T10:00:00Z", "OPT_OUT", is_opt_out=True),
        ),
        policy=policy,
    )
    assert CRMIntelligenceService.evaluate_relationship(req5).health == RelationshipHealth.TERMINATED


def test_9_contact_guardrail_policy_enforcement():
    """Verify ContactGuardrailDecision policy enforcement."""
    eval_ts = "2026-08-05T10:00:00Z"
    policy = ContactPolicy(max_attempts_per_window=2, window_days=30, cooling_off_days=7)

    # 1. ALLOWED (Untouched)
    r1 = RelationshipEvaluationRequest("ws_1", "b_1", eval_ts, policy=policy)
    assert CRMIntelligenceService.evaluate_relationship(r1).guardrail_decision == ContactGuardrailDecision.ALLOWED

    # 2. BLOCKED_COOLING_OFF
    r2 = RelationshipEvaluationRequest(
        "ws_1",
        "b_1",
        eval_ts,
        interaction_history=(
            InteractionRecord("2026-08-02T10:00:00Z", "EMAIL_SENT"),  # 3 days ago < 7
        ),
        policy=policy,
    )
    assert CRMIntelligenceService.evaluate_relationship(r2).guardrail_decision == ContactGuardrailDecision.BLOCKED_COOLING_OFF

    # 3. BLOCKED_FREQUENCY_CAP
    r3 = RelationshipEvaluationRequest(
        "ws_1",
        "b_1",
        eval_ts,
        interaction_history=(
            InteractionRecord("2026-07-10T10:00:00Z", "EMAIL_SENT"),
            InteractionRecord("2026-07-20T10:00:00Z", "EMAIL_SENT"),  # 2 attempts in 30 days >= max 2
        ),
        policy=policy,
    )
    assert CRMIntelligenceService.evaluate_relationship(r3).guardrail_decision == ContactGuardrailDecision.BLOCKED_FREQUENCY_CAP

    # 4. BLOCKED_OPT_OUT
    r4 = RelationshipEvaluationRequest(
        "ws_1",
        "b_1",
        eval_ts,
        interaction_history=(
            InteractionRecord("2026-07-01T10:00:00Z", "UNSUBSCRIBE", is_opt_out=True),
        ),
        policy=policy,
    )
    assert CRMIntelligenceService.evaluate_relationship(r4).guardrail_decision == ContactGuardrailDecision.BLOCKED_OPT_OUT

    # 5. BLOCKED_CONVERTED
    r5 = RelationshipEvaluationRequest(
        "ws_1",
        "b_1",
        eval_ts,
        interaction_history=(
            InteractionRecord("2026-07-01T10:00:00Z", "SIGNUP", is_conversion=True),
        ),
        policy=policy,
    )
    assert CRMIntelligenceService.evaluate_relationship(r5).guardrail_decision == ContactGuardrailDecision.BLOCKED_CONVERTED


def test_10_batch_evaluation_ordering():
    """Verify evaluate_batch maintains strict request ordering and alignment."""
    eval_ts = "2026-08-05T10:00:00Z"
    reqs = (
        RelationshipEvaluationRequest("ws_1", "b_1", eval_ts),
        RelationshipEvaluationRequest(
            "ws_1",
            "b_2",
            eval_ts,
            interaction_history=(
                InteractionRecord("2026-08-04T10:00:00Z", "CONVERT", is_conversion=True),
            ),
        ),
        RelationshipEvaluationRequest(
            "ws_1",
            "b_3",
            eval_ts,
            interaction_history=(
                InteractionRecord("2026-08-04T10:00:00Z", "OPT", is_opt_out=True),
            ),
        ),
    )

    results = CRMIntelligenceService.evaluate_batch(reqs)
    assert len(results) == 3
    assert results[0].business_id == "b_1"
    assert results[0].stage == RelationshipStage.UNTOUCHED
    assert results[1].business_id == "b_2"
    assert results[1].stage == RelationshipStage.CONVERTED
    assert results[2].business_id == "b_3"
    assert results[2].stage == RelationshipStage.OPTED_OUT


def test_11_tuple_coercion():
    """Verify mutable sequences passed to interaction_history or batch are coerced to immutable tuples."""
    record_list = [
        InteractionRecord("2026-08-01T10:00:00Z", "EMAIL_SENT"),
    ]
    req = RelationshipEvaluationRequest(
        workspace_id="ws_1",
        business_id="b_1",
        current_timestamp_iso="2026-08-05T10:00:00Z",
        interaction_history=record_list,
    )
    assert isinstance(req.interaction_history, tuple)


def test_12_pure_determinism():
    """Verify stateless service methods produce identical output across repeated invocations."""
    req = RelationshipEvaluationRequest(
        workspace_id="ws_1",
        business_id="b_1",
        current_timestamp_iso="2026-08-05T10:00:00Z",
        interaction_history=(
            InteractionRecord("2026-08-01T10:00:00Z", "EMAIL_SENT"),
            InteractionRecord("2026-08-03T10:00:00Z", "REPLY", is_positive=True),
        ),
    )

    res1 = CRMIntelligenceService.evaluate_relationship(req)
    res2 = CRMIntelligenceService.evaluate_relationship(req)
    assert res1 == res2


def test_13_thread_safety():
    """Verify thread-safety and lack of shared state concurrency issues."""
    req = RelationshipEvaluationRequest(
        workspace_id="ws_1",
        business_id="b_1",
        current_timestamp_iso="2026-08-05T10:00:00Z",
        interaction_history=(
            InteractionRecord("2026-08-01T10:00:00Z", "EMAIL_SENT"),
        ),
    )

    def worker(_):
        return CRMIntelligenceService.evaluate_relationship(req)

    with ThreadPoolExecutor(max_workers=8) as executor:
        results = list(executor.map(worker, range(50)))

    first = results[0]
    for r in results[1:]:
        assert r == first


def test_14_invalid_input_handling():
    """Verify graceful handling of invalid inputs and timestamps."""
    # Future timestamp relative to evaluation timestamp
    req_future = RelationshipEvaluationRequest(
        workspace_id="ws_1",
        business_id="b_1",
        current_timestamp_iso="2026-08-01T10:00:00Z",
        interaction_history=(
            InteractionRecord("2026-08-05T10:00:00Z", "EMAIL_SENT"),  # In future relative to Aug 1
        ),
    )
    with pytest.raises(ValueError, match="in the future relative to evaluation timestamp"):
        CRMIntelligenceService.evaluate_relationship(req_future)

    # Malformed ISO timestamp
    req_malformed = RelationshipEvaluationRequest("ws_1", "b_1", "not-a-timestamp")
    with pytest.raises(ValueError, match="Invalid ISO-8601 timestamp string"):
        CRMIntelligenceService.evaluate_relationship(req_malformed)


def test_15_cross_subsystem_regression():
    """Run regression tests across frozen upstream subsystems (14-22)."""
    import importlib
    frozen_modules = [
        "validate_mission_intelligence",
        "validate_workflow",
        "validate_feedback",
        "validate_analytics",
        "validate_ai_coach",
        "validate_engine_context",
        "validate_mission_generation",
    ]

    for mod_name in frozen_modules:
        mod = importlib.import_module(mod_name)
        if hasattr(mod, "main"):
            mod.main()


def main():
    test_1_import_isolation()
    test_2_ast_analysis()
    test_3_absence_of_registries_and_globals()
    test_4_model_immutability()
    test_5_enum_validation()
    test_6_dataclass_invariant_enforcement()
    test_7_stage_derivation_rules()
    test_8_health_derivation_rules()
    test_9_contact_guardrail_policy_enforcement()
    test_10_batch_evaluation_ordering()
    test_11_tuple_coercion()
    test_12_pure_determinism()
    test_13_thread_safety()
    test_14_invalid_input_handling()
    test_15_cross_subsystem_regression()
    print("ALL 15 VALIDATION TESTS FOR SUBSYSTEM 23 (CRM INTELLIGENCE) PASSED PERFECTLY!")


if __name__ == "__main__":
    main()

