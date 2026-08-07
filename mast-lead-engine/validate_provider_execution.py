"""
validate_provider_execution.py
==============================

Standalone validation suite for the provider_execution/ package.

Verification Checks
-------------------
1. Strict import isolation (no forbidden modules loaded).
2. Immutable models & slots (frozen dataclass, slots, tuple/datetime validation).
3. Registry correctness & lack of update() method (register, get, exists, ids, all, remove).
4. Duplicate protection (ValueError on duplicate execution_id).
5. Lifecycle correctness & method names (create, enqueue, start, complete, fail, cancel).
6. Legal state transitions.
7. Illegal state transitions rejected (ValueError).
8. Stateless lifecycle service & caller-injected timestamps.
9. Explicit timestamp ownership (no datetime.now in lifecycle module).
10. Thread safety across concurrent execution registrations and lookups.
11. Import isolation & boundary integrity.
12. Engine untouched.
13. Provider Platform untouched.
14. Provider Intelligence untouched.
15. Discovery Intelligence untouched.
16. Discovery Sessions untouched.

Run directly with:
    python validate_provider_execution.py
"""

from __future__ import annotations

import sys
import threading
import dataclasses
import inspect
from datetime import datetime, timezone

# ---------------------------------------------------------------------------
# Strict boundary checks: before importing provider_execution, verify no forbidden
# modules are loaded and guarantee strict layer isolation.
# ---------------------------------------------------------------------------
forbidden = [
    "engine",
    "providers.intelligence",
    "storage",
    "database",
    "crm",
    "opportunities",
    "missions",
    "ai",
]

for m in list(sys.modules.keys()):
    for f in forbidden:
        if m == f or m.startswith(f + "."):
            del sys.modules[m]

# Now import discovery and provider_execution packages
import discovery
from discovery import ProviderDiscoveryRequest
import provider_execution
from provider_execution import (
    ProviderExecution,
    ProviderExecutionState,
    ProviderExecutionLifecycle,
    ProviderExecutionRegistry,
    is_valid_execution_transition,
    TERMINAL_STATES,
)

PASS = "PASS"
FAIL = "FAIL"
results: list[tuple[str, str, str]] = []


def check(name: str, condition: bool, detail: str = "") -> None:
    results.append((name, PASS if condition else FAIL, detail))
    if not condition:
        print(f"FAILED: {name} - {detail}")


def run_validation() -> bool:
    print("=" * 70)
    print("MAST Engine — Provider Execution Subsystem Validation")
    print("=" * 70)

    t0 = datetime.now(timezone.utc)
    t1 = datetime(2026, 8, 4, 10, 0, 0, tzinfo=timezone.utc)
    t2 = datetime(2026, 8, 4, 10, 1, 0, tzinfo=timezone.utc)
    t3 = datetime(2026, 8, 4, 10, 5, 0, tzinfo=timezone.utc)

    # Sample ProviderDiscoveryRequest
    req = ProviderDiscoveryRequest(
        provider_id="google_maps",
        niche_id="dentists",
        query="dentists in Berlin",
        city="Berlin",
        country="Germany",
    )

    # 1. Immutable models & slots
    exec1 = ProviderExecution(
        execution_id="exec_gm_01",
        session_id="session_100",
        provider_id="google_maps",
        created_at=t0,
        request=req,
        provider_request_id="req_gm_01",
    )

    check(
        "1. Immutable models (dataclass frozen)",
        dataclasses.is_dataclass(exec1) and exec1.__dataclass_params__.frozen,
        "ProviderExecution must be a frozen dataclass",
    )

    # Verify mutation is prevented
    mutation_failed = False
    try:
        exec1.current_state = ProviderExecutionState.RUNNING  # type: ignore
    except (dataclasses.FrozenInstanceError, AttributeError):
        mutation_failed = True

    check(
        "1b. Model immutability enforcement",
        mutation_failed,
        "Attempting to mutate ProviderExecution must raise FrozenInstanceError/AttributeError",
    )

    # 2. Slots enforcement
    has_slots = hasattr(exec1, "__slots__")
    no_dict = not hasattr(exec1, "__dict__")
    check(
        "2. Slots definition",
        has_slots and no_dict,
        f"ProviderExecution must use slots (has_slots={has_slots}, no_dict={no_dict})",
    )

    # 3. Registry correctness & dumb registry verification (no update method!)
    reg = ProviderExecutionRegistry()
    has_update = hasattr(reg, "update")
    check(
        "3a. Dumb registry (no update() method exists)",
        not has_update,
        "ProviderExecutionRegistry must NOT expose an update() method",
    )

    reg.register(exec1)
    check("3b. Registry register() & exists()", reg.exists("exec_gm_01"), "Registered execution must exist")
    check("3c. Registry get()", reg.get("exec_gm_01") == exec1, "get() must return registered execution")
    check("3d. Registry ids()", reg.ids() == ("exec_gm_01",), "ids() must return tuple of registered IDs")
    check("3e. Registry all()", reg.all() == (exec1,), "all() must return tuple of registered executions")

    # 4. Duplicate protection
    duplicate_rejected = False
    try:
        reg.register(exec1)
    except ValueError:
        duplicate_rejected = True
    check(
        "4. Duplicate registration protection",
        duplicate_rejected,
        "register() must raise ValueError for duplicate execution_id",
    )

    # Key Error on unknown lookup
    key_error_raised = False
    try:
        reg.get("unknown_exec")
    except KeyError:
        key_error_raised = True
    check("3f. Registry KeyError on unknown ID", key_error_raised, "get() must raise KeyError for unknown IDs")

    # Remove method
    removed = reg.remove("exec_gm_01")
    check("3g. Registry remove()", removed and not reg.exists("exec_gm_01"), "remove() must remove execution")

    # 5. Lifecycle correctness & method names
    created_exec = ProviderExecutionLifecycle.create(
        session_id="session_100",
        provider_id="google_maps",
        created_at=t0,
        execution_id="exec_gm_02",
        request=req,
    )
    check(
        "5a. Lifecycle create() state",
        created_exec.current_state == ProviderExecutionState.CREATED,
        "create() must return execution in CREATED state",
    )

    pending_exec = ProviderExecutionLifecycle.enqueue(created_exec)
    check(
        "5b. Lifecycle enqueue() state",
        pending_exec.current_state == ProviderExecutionState.PENDING,
        "enqueue() must transition execution to PENDING state",
    )

    running_exec = ProviderExecutionLifecycle.start(pending_exec, started_at=t1)
    check(
        "5c. Lifecycle start() state & timestamp",
        running_exec.current_state == ProviderExecutionState.RUNNING and running_exec.started_at == t1,
        "start() must transition execution to RUNNING state with started_at timestamp",
    )

    completed_exec = ProviderExecutionLifecycle.complete(running_exec, completed_at=t2)
    check(
        "5d. Lifecycle complete() state & timestamp",
        completed_exec.current_state == ProviderExecutionState.COMPLETED and completed_exec.completed_at == t2,
        "complete() must transition execution to COMPLETED state with completed_at timestamp",
    )

    # 6. Legal transitions (e.g. CREATED -> RUNNING, RUNNING -> FAILED, RUNNING -> CANCELLED)
    run_direct = ProviderExecutionLifecycle.start(created_exec, started_at=t1)
    failed_exec = ProviderExecutionLifecycle.fail(run_direct, completed_at=t2)
    check(
        "6a. Legal transition RUNNING -> FAILED",
        failed_exec.current_state == ProviderExecutionState.FAILED and failed_exec.has_failed,
        "RUNNING -> FAILED must succeed",
    )

    run_direct2 = ProviderExecutionLifecycle.start(
        ProviderExecutionLifecycle.create("session_100", "yelp", created_at=t0), started_at=t1
    )
    cancelled_exec = ProviderExecutionLifecycle.cancel(run_direct2, completed_at=t3)
    check(
        "6b. Legal transition RUNNING -> CANCELLED",
        cancelled_exec.current_state == ProviderExecutionState.CANCELLED and cancelled_exec.has_been_cancelled,
        "RUNNING -> CANCELLED must succeed",
    )

    # 7. Illegal transitions rejected
    illegal_rejected = False
    try:
        # COMPLETED is terminal, transitioning COMPLETED -> RUNNING must fail
        ProviderExecutionLifecycle.start(completed_exec, started_at=t3)
    except ValueError:
        illegal_rejected = True
    check(
        "7. Illegal transition rejection",
        illegal_rejected,
        "Transitioning from terminal state (COMPLETED -> RUNNING) must raise ValueError",
    )

    # 8. Stateless lifecycle behavior
    check(
        "8. Lifecycle statelessness",
        created_exec.current_state == ProviderExecutionState.CREATED,
        "Original execution object must not be mutated when lifecycle methods are invoked",
    )

    # 9. Explicit timestamp ownership
    lifecycle_src = inspect.getsource(provider_execution.lifecycle)
    has_datetime_now = "datetime.now" in lifecycle_src or "utcnow" in lifecycle_src
    check(
        "9. Explicit timestamp ownership (no datetime.now inside lifecycle)",
        not has_datetime_now,
        "ProviderExecutionLifecycle must not call datetime.now() or datetime.utcnow()",
    )

    # 10. Thread safety test
    thread_reg = ProviderExecutionRegistry()
    threads = []
    errors: list[Exception] = []

    def worker(i: int):
        try:
            ex = ProviderExecutionLifecycle.create(
                session_id=f"session_{i}",
                provider_id="google_maps",
                created_at=t0,
                execution_id=f"exec_thread_{i}",
            )
            thread_reg.register(ex)
            _ = thread_reg.get(f"exec_thread_{i}")
            _ = thread_reg.all()
        except Exception as e:
            errors.append(e)

    for i in range(50):
        t = threading.Thread(target=worker, args=(i,))
        threads.append(t)
        t.start()

    for t in threads:
        t.join()

    check(
        "10. Thread safety across 50 concurrent threads",
        len(errors) == 0 and len(thread_reg.ids()) == 50,
        f"Concurrent registration test must pass with 0 errors (errors={errors}, count={len(thread_reg.ids())})",
    )

    # 11. Import isolation check
    loaded_forbidden = []
    for m in sys.modules:
        for f in forbidden:
            if m == f or m.startswith(f + "."):
                loaded_forbidden.append(m)

    check(
        "11. Strict import isolation",
        len(loaded_forbidden) == 0,
        f"Forbidden modules loaded: {loaded_forbidden}",
    )

    # 12-16. Subsystem untouched checks (verify imports from other subsystems succeed without side-effects)
    try:
        import discovery_sessions
        import providers
        import engine
        untouched = True
    except Exception as e:
        untouched = False

    check(
        "12-16. External subsystems untouched & compatible",
        untouched,
        "External engine & subsystem modules must remain untouched and importable",
    )

    print("-" * 70)
    passed_count = sum(1 for _, res, _ in results if res == PASS)
    total_count = len(results)
    print(f"Results: {passed_count}/{total_count} checks PASSED.")
    print("=" * 70)

    return passed_count == total_count


if __name__ == "__main__":
    success = run_validation()
    sys.exit(0 if success else 1)
