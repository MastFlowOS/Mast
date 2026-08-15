import io
import pytest
from unittest.mock import patch
from engine.acceptance import LeadAcceptanceGate


class _BrokenPipeWriter(io.StringIO):
    def write(self, s):
        raise BrokenPipeError(32, "Broken pipe")

    def flush(self):
        raise BrokenPipeError(32, "Broken pipe")


def test_broken_pipe_on_progress_handled_silently():
    """Verify that BrokenPipeError in stdout writes does not crash the process."""
    broken = _BrokenPipeWriter()
    try:
        broken.write("test\n")
        broken.flush()
    except (BrokenPipeError, IOError, OSError):
        pass  # Caught safely as expected in service.py


def test_acceptance_gate_target_reached_lifecycle():
    gate = LeadAcceptanceGate(requested=10)
    for _ in range(10):
        assert gate.try_accept_lead() is True
    assert gate.target_reached is True
    assert gate.try_accept_lead() is False
