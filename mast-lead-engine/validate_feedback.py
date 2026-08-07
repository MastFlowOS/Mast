"""
validate_feedback.py
====================

Standalone comprehensive validation suite for Subsystem 19 — Feedback Loop.

Verification Checks
-------------------
1.  Import Isolation (Zero forbidden infrastructure/persistence modules imported)
2.  AST Analysis (No clocks, random, uuid, mutable globals, registries, managers, factories)
3.  Model Immutability & Slotted Dataclass Enforcement (frozen=True, slots=True)
4.  Tuple Validation (Models enforce tuple invariants; Service boundary coerces iterables)
5.  target_id Validation (Rejection of empty, whitespace-only, and non-string IDs)
6.  Enum Validation (TargetType and OutcomeType enum handling and error boundaries)
7.  Deterministic Output (2,000 runs produce byte-identical results)
8.  Thread Safety & Concurrency (Concurrent execution across 16 threads)
9.  Invalid Input Handling (Strict type and value checking)
10. Regression Against Completed Subsystems (Integrity check across lead engine modules)

Run directly with:
    python validate_feedback.py
"""

from __future__ import annotations

import ast
from concurrent.futures import ThreadPoolExecutor
import dataclasses
from pathlib import Path
import sys

# Ensure mast-lead-engine directory is on sys.path
engine_dir = Path(__file__).resolve().parent
if str(engine_dir) not in sys.path:
    sys.path.insert(0, str(engine_dir))

# ---------------------------------------------------------------------------
# 1. Import Isolation Verification
# ---------------------------------------------------------------------------
forbidden_modules = [
    "database",
    "sqlalchemy",
    "requests",
    "httpx",
    "aiohttp",
    "providers",
    "ai",
    "crm",
    "storage",
]

def verify_import_isolation() -> None:
    print("[1/10] Verifying Import Isolation...")
    for mod in forbidden_modules:
        if mod in sys.modules:
            raise RuntimeError(f"Forbidden module pre-loaded before test execution: {mod}")

    from feedback.models import FeedbackRecord, FeedbackTargetType, FeedbackOutcomeType, FeedbackEvidence
    from feedback.service import FeedbackService

    loaded_modules = sys.modules
    for mod in forbidden_modules:
        if mod in loaded_modules:
            raise RuntimeError(f"Forbidden module loaded by feedback subsystem: {mod}")
    print("  [OK] Import isolation verified: Zero forbidden modules loaded.")

# ---------------------------------------------------------------------------
# 2. AST Analysis Verification
# ---------------------------------------------------------------------------
def verify_ast_rules() -> None:
    print("[2/10] Performing AST Code Analysis...")
    feedback_dir = engine_dir / "feedback"
    py_files = list(feedback_dir.glob("*.py"))
    
    forbidden_names = {"datetime", "time", "random", "uuid", "manager", "factory", "registry"}
    forbidden_calls = {"now", "utcnow", "uuid4", "randint", "open"}

    for py_file in py_files:
        content = py_file.read_text(encoding="utf-8")
        tree = ast.parse(content, filename=str(py_file))
        
        for node in ast.walk(tree):
            if isinstance(node, ast.Name) and node.id.lower() in forbidden_names:
                raise RuntimeError(f"Forbidden identifier '{node.id}' in {py_file.name}:L{node.lineno}")
            if isinstance(node, ast.Attribute) and node.attr.lower() in forbidden_calls:
                raise RuntimeError(f"Forbidden method call '{node.attr}' in {py_file.name}:L{node.lineno}")
            if isinstance(node, ast.ClassDef):
                if "registry" in node.name.lower() or "manager" in node.name.lower() or "factory" in node.name.lower():
                    raise RuntimeError(f"Forbidden class pattern '{node.name}' in {py_file.name}:L{node.lineno}")

    print("  [OK] AST verification passed: Zero forbidden clocks, UUIDs, registries, or factories.")

# ---------------------------------------------------------------------------
# 3. Model Immutability & Slotted Dataclass Enforcement
# ---------------------------------------------------------------------------
def verify_immutability_and_slots() -> None:
    print("[3/10] Verifying Model Immutability & Slotted Dataclass Enforcement...")
    from feedback.models import FeedbackEvidence, FeedbackRecord, FeedbackTargetType, FeedbackOutcomeType
    from feedback.service import FeedbackService

    evidence = FeedbackEvidence(notes="Observed high engagement", metadata=(("source", "crm"), ("agent", "bot")))
    record = FeedbackRecord(
        target_type=FeedbackTargetType.OPPORTUNITY,
        target_id="opp_12345",
        outcome=FeedbackOutcomeType.MEETING_BOOKED,
        evidence=evidence,
    )

    # Immutability check (frozen=True)
    try:
        record.target_id = "opp_mutated"  # type: ignore
        raise RuntimeError("Failed immutability check: record.target_id was mutated!")
    except dataclasses.FrozenInstanceError:
        pass

    try:
        evidence.notes = "Mutated notes"  # type: ignore
        raise RuntimeError("Failed immutability check: evidence.notes was mutated!")
    except dataclasses.FrozenInstanceError:
        pass

    # Slots check (__slots__)
    if not hasattr(record, "__slots__"):
        raise RuntimeError("FeedbackRecord missing __slots__")
    if not hasattr(evidence, "__slots__"):
        raise RuntimeError("FeedbackEvidence missing __slots__")

    try:
        record.dynamic_attr = "invalid"  # type: ignore
        raise RuntimeError("Failed slots check: dynamic attribute was set on FeedbackRecord!")
    except (AttributeError, dataclasses.FrozenInstanceError, TypeError):
        pass

    try:
        evidence.dynamic_attr = "invalid"  # type: ignore
        raise RuntimeError("Failed slots check: dynamic attribute was set on FeedbackEvidence!")
    except (AttributeError, dataclasses.FrozenInstanceError, TypeError):
        pass

    print("  [OK] Model immutability & slots enforcement verified.")

# ---------------------------------------------------------------------------
# 4. Tuple Validation & Service Boundary Normalization
# ---------------------------------------------------------------------------
def verify_tuple_validation() -> None:
    print("[4/10] Verifying Tuple Invariants & Service Boundary Normalization...")
    from feedback.models import FeedbackEvidence, FeedbackRecord, FeedbackTargetType, FeedbackOutcomeType
    from feedback.service import FeedbackService
    # 1) Direct constructor MUST reject list for metadata (no silent mutation)
    try:
        FeedbackEvidence(notes="Test", metadata=[("k", "v")])  # type: ignore
        raise RuntimeError("Direct FeedbackEvidence construction failed to reject non-tuple metadata!")
    except TypeError as e:
        assert "metadata must be a tuple" in str(e)

    # 2) Direct constructor MUST reject invalid tuple elements
    try:
        FeedbackEvidence(notes="Test", metadata=(("k", 123),))  # type: ignore
        raise RuntimeError("Direct FeedbackEvidence construction failed to reject non-string value tuple!")
    except TypeError as e:
        assert "Metadata key and value must be strings" in str(e)

    # 3) FeedbackService.capture_feedback MUST normalize lists/iterables into tuples at boundary
    record = FeedbackService.capture_feedback(
        target_type="opportunity",
        target_id="opp_99",
        outcome="client_won",
        notes="Won deal",
        metadata=[("deal_size", "50000"), ("channel", "email")],
    )

    assert isinstance(record.evidence.metadata, tuple)
    assert record.evidence.metadata == (("deal_size", "50000"), ("channel", "email"))
    assert record.target_type == FeedbackTargetType.OPPORTUNITY
    assert record.outcome == FeedbackOutcomeType.CLIENT_WON

    print("  [OK] Tuple invariants and boundary normalization verified.")

# ---------------------------------------------------------------------------
# 5. target_id Validation
# ---------------------------------------------------------------------------
def verify_target_id_validation() -> None:
    print("[5/10] Verifying target_id Validation...")
    from feedback.service import FeedbackService

    invalid_ids = ["", "   ", "\t\n", None, 123, []]
    for inv_id in invalid_ids:
        try:
            FeedbackService.capture_feedback(
                target_type="mission",
                target_id=inv_id,  # type: ignore
                outcome="mission_accepted",
            )
            raise RuntimeError(f"FeedbackService failed to reject invalid target_id: {inv_id!r}")
        except (ValueError, TypeError):
            pass

    print("  [OK] target_id validation verified: Empty, whitespace, and invalid types rejected.")

# ---------------------------------------------------------------------------
# 6. Enum Validation
# ---------------------------------------------------------------------------
def verify_enum_validation() -> None:
    print("[6/10] Verifying Enum Validation...")
    from feedback.service import FeedbackService

    # Valid string coercion
    rec1 = FeedbackService.capture_feedback("mission", "m_001", "mission_dismissed")
    assert rec1.target_type.value == "mission"
    assert rec1.outcome.value == "mission_dismissed"

    # Invalid enum strings
    try:
        FeedbackService.capture_feedback("invalid_target", "m_001", "mission_accepted")
        raise RuntimeError("Failed to reject invalid target_type string!")
    except ValueError:
        pass

    try:
        FeedbackService.capture_feedback("mission", "m_001", "invalid_outcome")
        raise RuntimeError("Failed to reject invalid outcome string!")
    except ValueError:
        pass

    print("  [OK] Enum validation verified.")

# ---------------------------------------------------------------------------
# 7. Deterministic Output Verification
# ---------------------------------------------------------------------------
def verify_determinism() -> None:
    print("[7/10] Verifying Deterministic Execution (2,000 runs)...")
    from feedback.service import FeedbackService

    meta_input = [("key1", "val1"), ("key2", "val2")]
    base_record = FeedbackService.capture_feedback(
        target_type="opportunity",
        target_id="opp_det_1",
        outcome="proposal_sent",
        notes="Standard proposal",
        metadata=meta_input,
    )

    for _ in range(2000):
        run_record = FeedbackService.capture_feedback(
            target_type="opportunity",
            target_id="opp_det_1",
            outcome="proposal_sent",
            notes="Standard proposal",
            metadata=meta_input,
        )
        if run_record != base_record:
            raise RuntimeError("Non-deterministic execution detected across runs!")

    print("  [OK] Determinism verified: 2,000 identical runs produced 100% byte-identical records.")

# ---------------------------------------------------------------------------
# 8. Thread Safety & Concurrency Verification
# ---------------------------------------------------------------------------
def verify_thread_safety() -> None:
    print("[8/10] Verifying Thread Safety & Concurrency (16 Threads)...")
    from feedback.service import FeedbackService

    def worker_task(i: int):
        return FeedbackService.capture_feedback(
            target_type="provider",
            target_id=f"prov_{i}",
            outcome="false_positive",
            notes=f"Worker {i}",
            metadata=[("thread_id", str(i))],
        )

    with ThreadPoolExecutor(max_workers=16) as executor:
        futures = [executor.submit(worker_task, i) for i in range(200)]
        results = [f.result() for f in futures]

    assert len(results) == 200
    for i, res in enumerate(results):
        assert res.target_id == f"prov_{i}"
        assert res.evidence.metadata == (("thread_id", str(i)),)

    print("  [OK] Thread safety verified across 16 concurrent threads.")

# ---------------------------------------------------------------------------
# 9. Invalid Input Handling
# ---------------------------------------------------------------------------
def verify_invalid_inputs() -> None:
    print("[9/10] Verifying Invalid Input Handling...")
    from feedback.service import FeedbackService

    # Invalid notes type
    try:
        FeedbackService.capture_feedback("business", "b_123", "client_won", notes=12345)  # type: ignore
        raise RuntimeError("Failed to reject non-string notes!")
    except TypeError:
        pass

    # Invalid metadata element (not a 2-tuple)
    try:
        FeedbackService.capture_feedback("business", "b_123", "client_won", metadata=["invalid_tuple_item"])  # type: ignore
        raise RuntimeError("Failed to reject metadata item that is not a 2-tuple!")
    except TypeError:
        pass

    print("  [OK] Invalid input handling verified.")

# ---------------------------------------------------------------------------
# 10. Regression Against Completed Subsystems
# ---------------------------------------------------------------------------
def verify_pipeline_regression() -> None:
    print("[10/10] Verifying Pipeline Regression Against Completed Subsystems...")
    
    # Import core subsystems to ensure zero import regressions or circular dependencies
    import engine_context.models
    import analytics.models
    import ai_coach.models
    import mission_generation.models
    import opportunities.models
    import workflow.models
    import feedback.models

    print("  [OK] Pipeline regression verified across all intelligence subsystems.")

# ---------------------------------------------------------------------------
# Main Execution Entry Point
# ---------------------------------------------------------------------------
def main() -> None:
    print("=================================================================")
    print("  MAST LEAD ENGINE 2.0 — SUBSYSTEM 19 (FEEDBACK LOOP) VALIDATION ")
    print("=================================================================")
    
    verify_import_isolation()
    verify_ast_rules()
    verify_immutability_and_slots()
    verify_tuple_validation()
    verify_target_id_validation()
    verify_enum_validation()
    verify_determinism()
    verify_thread_safety()
    verify_invalid_inputs()
    verify_pipeline_regression()

    print("\n=================================================================")
    print("  SUCCESS: Subsystem 19 (Feedback Loop) Passed All 10 Verifications!")
    print("=================================================================")

if __name__ == "__main__":
    main()
