"""
PHASE 5G — focused, standalone check for the new stage telemetry.
Not part of the pytest suite (per this milestone's own "no full
repository test run" instruction) -- run directly:

    python3 _phase5g_telemetry_focused_check.py

Verifies, with a fake EngineRuntime (no real workers/queues/Supabase
involved):
  1. `_execute_one` updates the new generic per-stage active/completed/
     failed counters for a non-Website stage (storage), not just the
     pre-existing Website-only counters.
  2. `_maybe_log_telemetry` emits one `[stage-throughput]` line per
     configured stage plus one resource line, without waiting the real
     30s (by backdating `_last_telemetry_log`).
  3. Nothing about `_execute_one`'s *return value* changed -- the
     StageOutcome it returns is untouched.
"""
import io
import logging
import sys

sys.path.insert(0, ".")

from engine.execution_driver import ExecutionDriver
from engine.runtime import StageConfig, StageOutcome


class _FakeRuntime:
    """Minimal stand-in for EngineRuntime.execute_stage()."""

    def __init__(self):
        self.calls = 0

    def execute_stage(self, stage: StageConfig) -> StageOutcome:
        self.calls += 1
        # Alternate success/failure so both counters get exercised.
        success = self.calls % 3 != 0
        return StageOutcome(
            stage_name=stage.name,
            ran=True,
            success=success,
            worker_id="fake-worker",
            queue_item_id=f"item-{self.calls}",
        )


def main() -> None:
    stages = [
        StageConfig(name="website", definition_id="website-def", input_queue_id="q-website"),
        StageConfig(name="instagram", definition_id="instagram-def", input_queue_id="q-instagram"),
        StageConfig(name="contact", definition_id="contact-def", input_queue_id="q-contact"),
        StageConfig(name="merge", definition_id="merge-def", input_queue_id="q-merge"),
        StageConfig(name="qualification", definition_id="qual-def", input_queue_id="q-qual"),
        StageConfig(name="storage", definition_id="storage-def", input_queue_id="q-storage"),
    ]
    driver = ExecutionDriver(
        engine_runtime=_FakeRuntime(),
        stages=stages,
        stage_concurrency={"website": 2, "contact": 2},
    )

    storage_stage = stages[5]

    # -- 1. _execute_one updates generic counters for a non-Website stage --
    assert driver._stage_completed["storage"] == 0
    assert driver._stage_failed["storage"] == 0
    outcome = driver._execute_one(storage_stage)
    assert outcome is not None and outcome.stage_name == "storage"
    assert driver._stage_active["storage"] == 0  # decremented back to 0 after finishing
    assert driver._stage_completed["storage"] + driver._stage_failed["storage"] == 1
    for _ in range(5):
        driver._execute_one(storage_stage)
    total_storage = driver._stage_completed["storage"] + driver._stage_failed["storage"]
    assert total_storage == 6, f"expected 6 storage outcomes counted, got {total_storage}"
    print("[OK] generic per-stage counters update for a non-Website stage (storage)")

    # -- 2. _maybe_log_telemetry emits one line per stage + one resource line --
    driver._execute_one(stages[0])   # website
    driver._execute_one(stages[1])   # instagram
    driver._execute_one(stages[2])   # contact
    driver._execute_one(stages[3])   # merge
    driver._execute_one(stages[4])   # qualification

    log_stream = io.StringIO()
    handler = logging.StreamHandler(log_stream)
    handler.setLevel(logging.INFO)
    engine_log = logging.getLogger("mast.engine.execution_driver")
    engine_log.addHandler(handler)
    engine_log.setLevel(logging.INFO)

    driver._last_telemetry_log = 0.0  # force the rate limit to allow a sample now
    driver._maybe_log_telemetry(min_interval_s=30.0)
    engine_log.removeHandler(handler)

    output = log_stream.getvalue()
    for name in ("website", "instagram", "contact", "merge", "qualification", "storage"):
        assert f"[stage-throughput] {name} " in output, f"missing telemetry line for stage={name}"
    assert "[stage-throughput] resource pid=" in output, "missing resource telemetry line"
    assert "queue_depth=n/a" in output, "queue_depth should be reported as n/a (flagged gap)"
    print("[OK] one [stage-throughput] line per stage + one resource line emitted")

    # -- 3. Rate limiting still works: a second call within min_interval_s logs nothing new --
    log_stream.truncate(0)
    log_stream.seek(0)
    engine_log.addHandler(handler)
    driver._maybe_log_telemetry(min_interval_s=30.0)  # _last_telemetry_log was just set to `now`
    engine_log.removeHandler(handler)
    assert log_stream.getvalue() == "", "telemetry should be rate-limited within min_interval_s"
    print("[OK] telemetry remains rate-limited (no log storm)")

    print("\nALL FOCUSED CHECKS PASSED")


if __name__ == "__main__":
    main()
