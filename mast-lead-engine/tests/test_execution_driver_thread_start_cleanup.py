"""Regression coverage for producer-thread startup resource exhaustion."""

from __future__ import annotations

import pytest

from engine.execution_driver import ExecutionDriver
from engine.runtime import StageConfig
import engine.execution_driver as execution_driver_module


class _ThreadStartFailsOnSecondProducer:
    created: list["_ThreadStartFailsOnSecondProducer"] = []

    def __init__(self, *args, **kwargs) -> None:
        self.index = len(self.created)
        self.joined = False
        self.created.append(self)

    def start(self) -> None:
        if self.index == 1:
            raise RuntimeError("can't start new thread")

    def join(self, timeout=None) -> None:
        if self.index == 1:
            raise AssertionError("cleanup attempted to join a never-started thread")
        self.joined = True


def test_failed_producer_start_preserves_root_error_and_cleanup_joins_only_started_threads(monkeypatch):
    """A failed second producer launch must not create a join-before-start error."""
    _ThreadStartFailsOnSecondProducer.created = []
    monkeypatch.setattr(execution_driver_module.threading, "Thread", _ThreadStartFailsOnSecondProducer)

    stages = [
        StageConfig(name="producer-one", definition_id="one", produce_worker_input=lambda: None),
        StageConfig(name="producer-two", definition_id="two", produce_worker_input=lambda: None),
    ]
    driver = ExecutionDriver(object(), stages)

    with pytest.raises(RuntimeError, match="can't start new thread"):
        driver._ensure_producers_started()

    # Normal cleanup must only join the producer whose start() completed.
    driver.stop()
    assert len(_ThreadStartFailsOnSecondProducer.created) == 2
    assert _ThreadStartFailsOnSecondProducer.created[0].joined is True
    assert _ThreadStartFailsOnSecondProducer.created[1].joined is False
    assert "producer-two" not in driver._producer_threads
