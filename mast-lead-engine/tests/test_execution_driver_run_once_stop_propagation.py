"""
Regression coverage for the run_once() stop-propagation fix.

Root cause (diagnosed separately): ExecutionDriver.run_once() walked
every configured stage in one synchronous pass with no stop-event
check in between, so a stop requested mid-pass (this driver's own
`_stop_event`, set via `stop()`, or an external `shutdown_event`
passed in as `external_stop_event`) could not prevent the remaining
stages in that same run_once() call from starting -- only the *next*
run_once() call would ever see it.

These tests exercise ExecutionDriver.run_once() directly, in-process,
against a fake EngineRuntime -- no threads, no real workers, no
network. Each stage is a simple transformer StageConfig (input queue
not None) so run_once() never skips any of them as a producer.
"""

from __future__ import annotations

import threading
from typing import List

import pytest

from engine.execution_driver import ExecutionDriver
from engine.runtime import StageConfig, StageOutcome


def _stage(name: str) -> StageConfig:
    # input_queue_id is arbitrary/unused by the fake runtime below --
    # only needs to be non-None so this isn't treated as a producer
    # stage (StageConfig.__post_init__ requires produce_worker_input
    # otherwise).
    return StageConfig(name=name, definition_id=f"def-{name}", input_queue_id=f"{name}_in")


class _FakeRuntime:
    """
    Minimal EngineRuntime stand-in: execute_stage() records which
    stage ran (in call order) and returns a trivial "ran, succeeded"
    StageOutcome. Optionally invokes a caller-supplied hook after
    recording, so a test can flip a stop event *during* a run_once()
    call to prove the next stage is skipped rather than the whole
    pass being uninterruptible.
    """

    def __init__(self, on_execute=None) -> None:
        self.calls: List[str] = []
        self._on_execute = on_execute

    def execute_stage(self, stage: StageConfig) -> StageOutcome:
        self.calls.append(stage.name)
        if self._on_execute is not None:
            self._on_execute(stage.name)
        return StageOutcome(
            stage_name=stage.name, ran=True, success=True,
            worker_id="w1", queue_item_id="q1", dead_lettered=False,
        )


STAGE_NAMES = ["website", "instagram", "contact", "merge", "qualification", "storage"]


def _stages() -> List[StageConfig]:
    return [_stage(n) for n in STAGE_NAMES]


def test_normal_run_executes_all_stages():
    """No stop requested anywhere: run_once() runs every stage, in order."""
    runtime = _FakeRuntime()
    driver = ExecutionDriver(runtime, _stages(), run_producers_once=False)

    outcomes = driver.run_once()

    assert runtime.calls == STAGE_NAMES
    assert [o.stage_name for o in outcomes] == STAGE_NAMES
    assert all(o.ran for o in outcomes)


def test_internal_stop_event_set_before_next_stage_skips_remaining_stages():
    """
    driver._stop_event set partway through a run_once() pass (e.g. as
    if stop() had been called concurrently) must stop the *next*
    stage from starting, without touching the stages that already ran.
    """
    runtime = _FakeRuntime()
    driver = ExecutionDriver(runtime, _stages(), run_producers_once=False)

    def stop_after_third(stage_name: str) -> None:
        if stage_name == "contact":  # 3rd stage in STAGE_NAMES
            driver._stop_event.set()

    runtime._on_execute = stop_after_third

    outcomes = driver.run_once()

    # website, instagram, contact ran; merge/qualification/storage did not.
    assert runtime.calls == ["website", "instagram", "contact"]
    assert [o.stage_name for o in outcomes] == ["website", "instagram", "contact"]


def test_external_stop_event_set_before_next_stage_skips_remaining_stages():
    """
    Same as above, but via the caller-owned external_stop_event (the
    service.py shutdown_event bridge) rather than the driver's own
    internal _stop_event -- this is the actual SIGTERM-driven path.
    """
    external_stop = threading.Event()
    runtime = _FakeRuntime()
    driver = ExecutionDriver(
        runtime, _stages(), run_producers_once=False,
        external_stop_event=external_stop,
    )

    def stop_after_first(stage_name: str) -> None:
        if stage_name == "website":
            external_stop.set()

    runtime._on_execute = stop_after_first

    outcomes = driver.run_once()

    assert runtime.calls == ["website"]
    assert [o.stage_name for o in outcomes] == ["website"]


def test_stop_between_stages_does_not_start_next_stage():
    """
    Stop requested strictly between two stages (not during either
    one's execute_stage() call) must still prevent the next stage
    from being started at all -- it should never appear in
    runtime.calls.
    """
    external_stop = threading.Event()
    runtime = _FakeRuntime()
    driver = ExecutionDriver(
        runtime, _stages(), run_producers_once=False,
        external_stop_event=external_stop,
    )

    # Flip the stop flag right after "instagram" finishes, well before
    # "contact" would be dispatched.
    def stop_after_second(stage_name: str) -> None:
        if stage_name == "instagram":
            external_stop.set()

    runtime._on_execute = stop_after_second

    outcomes = driver.run_once()

    assert "contact" not in runtime.calls
    assert "merge" not in runtime.calls
    assert runtime.calls == ["website", "instagram"]
    assert [o.stage_name for o in outcomes] == ["website", "instagram"]


def test_already_running_stage_is_not_forcibly_interrupted():
    """
    A stop signalled *while* a stage's own execute_stage() call is
    in flight must not abort that call -- it must be allowed to run
    to completion and its outcome must still be collected. Only the
    *next* stage is prevented from starting.
    """
    external_stop = threading.Event()
    runtime = _FakeRuntime()
    driver = ExecutionDriver(
        runtime, _stages(), run_producers_once=False,
        external_stop_event=external_stop,
    )

    completed_in_flight = {"flag": False}

    def during_merge(stage_name: str) -> None:
        if stage_name == "merge":
            # Simulate a stop request arriving *during* this stage's
            # in-flight execute_stage() call.
            external_stop.set()
            # This call is still running its course -- prove it
            # finishes and is recorded rather than being cut short.
            completed_in_flight["flag"] = True

    runtime._on_execute = during_merge

    outcomes = driver.run_once()

    # merge itself completed and is recorded ...
    assert completed_in_flight["flag"] is True
    assert "merge" in runtime.calls
    assert [o.stage_name for o in outcomes][-1] == "merge"
    # ... but qualification/storage (the remaining stages) never started.
    assert "qualification" not in runtime.calls
    assert "storage" not in runtime.calls


def test_returned_outcomes_contain_only_stages_that_actually_ran():
    """The outcomes list returned by run_once() must exactly match the
    stages recorded as having executed -- no gaps, no extras, no
    placeholder entries for skipped stages."""
    external_stop = threading.Event()
    runtime = _FakeRuntime()
    driver = ExecutionDriver(
        runtime, _stages(), run_producers_once=False,
        external_stop_event=external_stop,
    )

    def stop_after_fourth(stage_name: str) -> None:
        if stage_name == "merge":
            external_stop.set()

    runtime._on_execute = stop_after_fourth

    outcomes = driver.run_once()

    assert len(outcomes) == len(runtime.calls)
    assert [o.stage_name for o in outcomes] == runtime.calls
    assert runtime.calls == ["website", "instagram", "contact", "merge"]


def test_no_stop_requested_existing_behavior_unchanged_across_repeated_calls():
    """
    Sanity check that the fix is purely additive: with no stop ever
    requested, repeated run_once() calls keep behaving exactly as
    before -- every stage, every time, in order.
    """
    runtime = _FakeRuntime()
    driver = ExecutionDriver(runtime, _stages(), run_producers_once=False)

    first = driver.run_once()
    second = driver.run_once()

    assert [o.stage_name for o in first] == STAGE_NAMES
    assert [o.stage_name for o in second] == STAGE_NAMES
    assert runtime.calls == STAGE_NAMES * 2


def test_stop_requested_before_run_once_even_starts_returns_no_outcomes():
    """If the stop event is already set before run_once() is called at
    all, no stage should run and an empty outcomes list is returned."""
    external_stop = threading.Event()
    external_stop.set()
    runtime = _FakeRuntime()
    driver = ExecutionDriver(
        runtime, _stages(), run_producers_once=False,
        external_stop_event=external_stop,
    )

    outcomes = driver.run_once()

    assert outcomes == []
    assert runtime.calls == []
