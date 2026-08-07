"""
validate_discovery_sessions.py
===============================

Standalone validation suite for the discovery_sessions/ package.

Verification Checks
-------------------
1. Strict import isolation (no forbidden modules loaded).
2. Immutable models & slots (frozen dataclass, slots, tuple coercion).
3. Exclusion verification (no ProviderExecutionState, SessionStatistics, or error_message).
4. State definitions & transition legality (legal state transitions pass, illegal ones raise ValueError).
5. Stateless lifecycle service & explicit timestamp injection.
6. Registry correctness, KeyError on unknown lookups, duplicate protection, and thread safety.
7. Engine and external subsystem isolation.

Run directly with:
    python validate_discovery_sessions.py
"""

from __future__ import annotations

import sys
import threading
import dataclasses
from datetime import datetime, timezone

# ---------------------------------------------------------------------------
# Strict boundary checks: before importing discovery_sessions, verify no forbidden
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

# Now import discovery and discovery_sessions packages
import discovery
from discovery import (
    DiscoveryIntent,
    ProviderDiscoveryRequest,
    CompiledDiscovery,
)
import discovery_sessions
from discovery_sessions import (
    DiscoverySession,
    DiscoverySessionState,
    DiscoverySessionLifecycle,
    DiscoverySessionRegistry,
)
from discovery_sessions.state import is_valid_session_transition, TERMINAL_STATES

PASS = "PASS"
FAIL = "FAIL"
results: list[tuple[str, str, str]] = []


def check(name: str, condition: bool, detail: str = "") -> None:
    results.append((name, PASS if condition else FAIL, detail))
    if not condition:
        print(f"FAILED: {name} - {detail}")


def run_validation() -> bool:
    print("=" * 70)
    print("MAST Engine — Discovery Sessions Subsystem Validation")
    print("=" * 70)

    t0 = datetime.now(timezone.utc)

    # 1. Setup sample CompiledDiscovery
    intent = DiscoveryIntent(
        niche_id="web_design",
        city="London",
        country="UK",
        requested_providers=("google_maps", "yelp"),
    )
    req1 = ProviderDiscoveryRequest(
        provider_id="google_maps",
        niche_id="web_design",
        query="web design agency London UK",
    )
    req2 = ProviderDiscoveryRequest(
        provider_id="yelp",
        niche_id="web_design",
        query="web design agency London UK",
    )
    compiled = CompiledDiscovery(intent=intent, requests=(req1, req2))

    # ---------------------------------------------------------------------------
    # 2. Immutable Models & Slots Checks
    # ---------------------------------------------------------------------------
    session1 = DiscoverySession(
        session_id="session_test1",
        workspace_id="ws_123",
        niche_id="web_design",
        compiled_discovery=compiled,
        created_at=t0,
    )

    check("2a. DiscoverySession is frozen dataclass", dataclasses.is_dataclass(session1))

    try:
        session1.session_id = "session_changed"  # type: ignore[misc]
        check("2b. DiscoverySession rejects field mutation", False, "No FrozenInstanceError raised")
    except dataclasses.FrozenInstanceError:
        check("2b. DiscoverySession rejects field mutation", True)

    check("2c. DiscoverySession has __slots__", hasattr(session1, "__slots__"))
    check(
        "2d. participating_provider_ids is tuple",
        isinstance(session1.participating_provider_ids, tuple),
        f"Got {type(session1.participating_provider_ids)}",
    )
    check(
        "2e. participating_provider_ids populated from compiled_discovery",
        session1.participating_provider_ids == ("google_maps", "yelp"),
        f"Got {session1.participating_provider_ids}",
    )

    # ---------------------------------------------------------------------------
    # 3. Exclusion Verification Checks
    # ---------------------------------------------------------------------------
    check(
        "3a. ProviderExecutionState does not exist in discovery_sessions",
        not hasattr(discovery_sessions, "ProviderExecutionState"),
    )
    check(
        "3b. SessionStatistics does not exist in discovery_sessions",
        not hasattr(discovery_sessions, "SessionStatistics"),
    )

    # Verify DiscoverySessionLifecycle.fail takes fail(session, failed_at) with no error_message
    import inspect
    fail_sig = inspect.signature(DiscoverySessionLifecycle.fail)
    fail_params = list(fail_sig.parameters.keys())
    check(
        "3c. DiscoverySessionLifecycle.fail signature is (session, failed_at)",
        fail_params == ["session", "failed_at"],
        f"Got signature parameters: {fail_params}",
    )

    # ---------------------------------------------------------------------------
    # 4. State Definitions & Transitions Legality Checks
    # ---------------------------------------------------------------------------
    check("4a. CREATED -> RUNNING is valid", is_valid_session_transition(DiscoverySessionState.CREATED, DiscoverySessionState.RUNNING))
    check("4b. RUNNING -> PAUSED is valid", is_valid_session_transition(DiscoverySessionState.RUNNING, DiscoverySessionState.PAUSED))
    check("4c. PAUSED -> RUNNING is valid", is_valid_session_transition(DiscoverySessionState.PAUSED, DiscoverySessionState.RUNNING))
    check("4d. RUNNING -> COMPLETED is valid", is_valid_session_transition(DiscoverySessionState.RUNNING, DiscoverySessionState.COMPLETED))
    check("4e. COMPLETED -> RUNNING is illegal", not is_valid_session_transition(DiscoverySessionState.COMPLETED, DiscoverySessionState.RUNNING))
    check("4f. FAILED -> PAUSED is illegal", not is_valid_session_transition(DiscoverySessionState.FAILED, DiscoverySessionState.PAUSED))

    # ---------------------------------------------------------------------------
    # 5. Lifecycle Statelessness & Explicit Timestamp Injection
    # ---------------------------------------------------------------------------
    t_created = datetime.now(timezone.utc)
    s_created = DiscoverySessionLifecycle.create(
        workspace_id="ws_456",
        niche_id="web_design",
        compiled_discovery=compiled,
        created_at=t_created,
        session_id="session_life1",
    )

    check("5a. Created session state is CREATED", s_created.current_state == DiscoverySessionState.CREATED)
    check("5b. Created session timestamp matches explicit input", s_created.created_at == t_created)

    t_started = datetime.now(timezone.utc)
    s_running = DiscoverySessionLifecycle.start(s_created, started_at=t_started)

    check("5c. Start returns new instance", s_running is not s_created)
    check("5d. Original session remains in CREATED state", s_created.current_state == DiscoverySessionState.CREATED)
    check("5e. New session in RUNNING state", s_running.current_state == DiscoverySessionState.RUNNING)
    check("5f. Started timestamp recorded", s_running.started_at == t_started)

    # Pause & Resume
    s_paused = DiscoverySessionLifecycle.pause(s_running)
    check("5g. Pause transitions to PAUSED", s_paused.current_state == DiscoverySessionState.PAUSED)

    s_resumed = DiscoverySessionLifecycle.resume(s_paused)
    check("5h. Resume transitions back to RUNNING", s_resumed.current_state == DiscoverySessionState.RUNNING)

    # Complete
    t_completed = datetime.now(timezone.utc)
    s_completed = DiscoverySessionLifecycle.complete(s_resumed, completed_at=t_completed)
    check("5i. Complete transitions to COMPLETED", s_completed.current_state == DiscoverySessionState.COMPLETED)
    check("5j. Completed timestamp recorded", s_completed.completed_at == t_completed)
    check("5k. is_completed and is_terminal properties return True", s_completed.is_completed and s_completed.is_terminal)

    # Illegal transition attempt via lifecycle
    try:
        DiscoverySessionLifecycle.start(s_completed, started_at=datetime.now(timezone.utc))
        check("5l. Lifecycle rejects illegal transition from COMPLETED", False, "No ValueError raised")
    except ValueError:
        check("5l. Lifecycle rejects illegal transition from COMPLETED", True)

    # Fail
    s_running2 = DiscoverySessionLifecycle.start(
        DiscoverySessionLifecycle.create("ws_1", "web_design", compiled, created_at=t_created),
        started_at=t_started,
    )
    t_failed = datetime.now(timezone.utc)
    s_failed = DiscoverySessionLifecycle.fail(s_running2, failed_at=t_failed)
    check("5m. Fail transitions to FAILED", s_failed.current_state == DiscoverySessionState.FAILED)
    check("5n. Failed timestamp recorded as completed_at", s_failed.completed_at == t_failed)

    # ---------------------------------------------------------------------------
    # 6. Registry Correctness, KeyError & Thread Safety
    # ---------------------------------------------------------------------------
    reg = DiscoverySessionRegistry()
    reg.register(s_created)

    check("6a. Registry.exists returns True for registered session", reg.exists("session_life1"))
    check("6b. Registry.get returns registered session", reg.get("session_life1") is s_created)

    # Key Error check for unknown lookup
    try:
        reg.get("session_unknown")
        check("6c. Registry.get raises KeyError for unknown session_id", False, "No KeyError raised")
    except KeyError:
        check("6c. Registry.get raises KeyError for unknown session_id", True)

    # Duplicate registration check
    try:
        reg.register(s_created)
        check("6d. Registry rejects duplicate registration", False, "No ValueError raised")
    except ValueError:
        check("6d. Registry rejects duplicate registration", True)

    check("6e. Registry.ids returns session IDs tuple", reg.ids() == ("session_life1",))
    check("6f. Registry.all returns session models tuple", reg.all() == (s_created,))

    check("6g. Registry.remove removes session", reg.remove("session_life1"))
    check("6h. Removed session no longer exists", not reg.exists("session_life1"))

    # Thread safety check
    reg_concurrent = DiscoverySessionRegistry()
    threads: list[threading.Thread] = []
    num_threads = 20
    errors: list[Exception] = []

    def worker(tid: int) -> None:
        try:
            sess = DiscoverySessionLifecycle.create(
                workspace_id=f"ws_{tid}",
                niche_id="web_design",
                compiled_discovery=compiled,
                created_at=datetime.now(timezone.utc),
                session_id=f"session_conc_{tid}",
            )
            reg_concurrent.register(sess)
            _ = reg_concurrent.get(f"session_conc_{tid}")
        except Exception as ex:
            errors.append(ex)

    for i in range(num_threads):
        t = threading.Thread(target=worker, args=(i,))
        threads.append(t)
        t.start()

    for t in threads:
        t.join()

    check("6i. Concurrent thread registrations succeeded without errors", len(errors) == 0, f"Errors: {errors}")
    check("6j. Concurrent registry registered all sessions", len(reg_concurrent.all()) == num_threads)

    # ---------------------------------------------------------------------------
    # 7. Strict Layer Isolation Check
    # ---------------------------------------------------------------------------
    loaded_forbidden = []
    for mod in list(sys.modules.keys()):
        for f in forbidden:
            if mod == f or mod.startswith(f + "."):
                loaded_forbidden.append(mod)

    check("7. No forbidden modules loaded during discovery_sessions execution", len(loaded_forbidden) == 0, f"Loaded: {loaded_forbidden}")

    # Summary
    print("\n" + "-" * 70)
    passed = sum(1 for _, status, _ in results if status == PASS)
    failed = sum(1 for _, status, _ in results if status == FAIL)
    total = len(results)

    for name, status, detail in results:
        msg = f"  [{status}] {name}"
        if detail:
            msg += f" -- {detail}"
        print(msg)

    print("-" * 70)
    print(f"Summary: {passed}/{total} checks passed ({failed} failures).")
    print("=" * 70)

    return failed == 0


if __name__ == "__main__":
    success = run_validation()
    sys.exit(0 if success else 1)
