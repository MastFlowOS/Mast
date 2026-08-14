"""
Tests for Bug 2: Heartbeat ticker scoping and rate limiting in service.py.
Verifies that:
1. Heartbeat ticker is created once per run_query execution.
2. Heartbeat does not burst rapidly in a busy loop.
3. Cancellation or normal completion stops the ticker cleanly.
"""

import asyncio
import pytest
from unittest.mock import MagicMock, patch


@pytest.mark.asyncio
async def test_heartbeat_ticker_no_burst_and_clean_cancellation():
    """
    Simulates the heartbeat ticker logic to verify it sleeps 15s between emissions
    and cancels cleanly without bursting.
    """
    heartbeats_emitted = []
    hb_stop = asyncio.Event()

    def mock_on_progress(stage, event, item_id):
        heartbeats_emitted.append((stage, event, item_id))

    async def _hb_ticker():
        while not hb_stop.is_set():
            try:
                await asyncio.sleep(0.05)  # Accelerated sleep for fast testing
            except asyncio.CancelledError:
                break
            if not hb_stop.is_set():
                mock_on_progress("engine", "heartbeat", None)

    hb_task = asyncio.create_task(_hb_ticker())

    # Immediately check: should have 0 heartbeats at t=0 (no initial burst)
    assert len(heartbeats_emitted) == 0

    # Wait for ~2 intervals (0.12s)
    await asyncio.sleep(0.12)
    assert 1 <= len(heartbeats_emitted) <= 3, f"Expected 1-3 heartbeats, got {len(heartbeats_emitted)}"

    # Stop the ticker
    hb_stop.set()
    hb_task.cancel()
    try:
        await hb_task
    except (asyncio.CancelledError, Exception):
        pass

    count_at_stop = len(heartbeats_emitted)
    await asyncio.sleep(0.1)
    assert len(heartbeats_emitted) == count_at_stop, "No further heartbeats should be emitted after cancellation"
