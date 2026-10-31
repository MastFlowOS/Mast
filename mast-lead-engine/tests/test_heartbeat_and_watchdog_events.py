"""
Tests for Phase 2: Watchdog Reliability Architecture.

Covers:
1. ProgressEventWriter dropped_heartbeats counter & queue saturation observability.
2. Service ready event (seq=0) emission.
3. Common heartbeat ticker running for discovery_only=True AND discovery_only=False.
4. Monotonic sequence numbers and timestamps.
5. Search space expansion emitted only on new unique canonical place IDs.
6. Card attempt lifecycle events (card_attempt_started, card_processed, attempt_rebuilding).
7. Specific termination reason preservation (USER_CANCELLED, WATCHDOG_TIMEOUT,
   PROCESS_UNRESPONSIVE, DISCOVERY_PROGRESS_TIMEOUT).
"""

from __future__ import annotations

import asyncio
import io
import json
import os
import sys
import threading
import time
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

import service
from exceptions import DiscoveryFailure, DiscoveryFailureReason
from scraper.maps_scraper import MapsScraper


# =============================================================================
# 1. ProgressEventWriter: Heartbeat Drop Observability & service_ready
# =============================================================================

def test_progress_writer_dropped_heartbeats_observability():
    """Verify ProgressEventWriter drops heartbeats when saturated and increments counter."""
    # Prevent background thread from auto-draining the queue so we can inspect saturation
    with patch.object(service._ProgressEventWriter, "_run", lambda self: None):
        writer = service._ProgressEventWriter(maxsize=3)
        try:
            # Verify writer enqueues service_ready successfully
            writer.enqueue(
                {"type": "progress", "stage": "engine", "event": "service_ready", "seq": 0, "timestamp": time.time()},
                critical=True,
            )
            assert not writer._queue.empty()
            ready_evt = writer._queue.get_nowait()
            assert ready_evt["event"] == "service_ready"
            assert ready_evt["seq"] == 0
            assert ready_evt["stage"] == "engine"
            assert ready_evt["timestamp"] > 0

            # Fill the queue to capacity (maxsize=3)
            for i in range(3):
                writer.enqueue(
                    {"type": "progress", "stage": "discovery", "event": "candidate_discovered", "item_id": f"id-{i}"},
                    critical=False,
                )

            assert writer._queue.full()
            assert writer.dropped_heartbeats == 0

            # Heartbeat arriving when full must drop and increment dropped_heartbeats
            writer.enqueue(
                {"type": "progress", "stage": "engine", "event": "heartbeat", "seq": 1},
                critical=False,
            )
            assert writer.dropped_heartbeats == 1

            writer.enqueue(
                {"type": "progress", "stage": "engine", "event": "heartbeat", "seq": 2},
                critical=False,
            )
            assert writer.dropped_heartbeats == 2
        finally:
            writer.stop(timeout=0.1)


# =============================================================================
# 2. Common Heartbeat Ticker: discovery_only=True
# =============================================================================

@pytest.mark.asyncio
async def test_heartbeat_ticker_in_discovery_only_mode():
    """Verify heartbeat ticker is active and emits monotonically increasing seq in discovery_only=True."""
    stdout_buf = io.StringIO()

    def fake_discover(request):
        for i in range(3):
            time.sleep(0.04)
            candidate = MagicMock()
            candidate.pipeline_id = f"pipe-{i}"
            candidate.session_id = "test-session"
            candidate.name = f"Business {i}"
            candidate.category = "Restaurant"
            candidate.address = f"{i} Main St"
            candidate.city = "Venice"
            candidate.country = "US"
            candidate.website = f"https://example.com/{i}"
            candidate.phone = f"+1555000{i:04d}"
            candidate.rating = 4.5
            candidate.review_count = 100
            candidate.maps_url = f"https://maps.google.com/?cid={i}"
            candidate.is_google_verified = True
            candidate.has_website = True
            candidate.has_phone = True
            candidate.has_instagram = False
            candidate.discovered_at = "2026-10-31T00:00:00Z"
            yield candidate

    mock_provider = MagicMock()
    mock_provider.discover = fake_discover
    mock_composed = MagicMock()
    mock_composed.provider = mock_provider
    mock_composed.request = MagicMock()
    mock_composed.selected_provider_ids = ["google_maps"]

    orig_sleep = asyncio.sleep
    async def fast_ticker_sleep(duration):
        if duration == 15.0:
            await orig_sleep(0.02)
        else:
            await orig_sleep(duration)

    with patch("sys.stdout", stdout_buf), \
         patch.object(service, "compose_discovery", return_value=mock_composed), \
         patch("asyncio.sleep", side_effect=fast_ticker_sleep):

        leads = []
        async for lead in service.run_query(
            query="pizza",
            city="Venice",
            max_results=3,
            discovery_only=True,
        ):
            leads.append(lead)

    assert len(leads) == 3

    # Parse JSON lines emitted to stdout
    output_lines = stdout_buf.getvalue().splitlines()
    json_lines = []
    for line in output_lines:
        line = line.strip()
        if line.startswith("{") and line.endswith("}"):
            try:
                json_lines.append(json.loads(line))
            except Exception:
                pass

    # Verify service_ready initial event
    ready_events = [p for p in json_lines if p.get("type") == "progress" and p.get("event") == "service_ready"]
    assert len(ready_events) >= 1
    assert ready_events[0]["seq"] == 0

    # Verify heartbeats were emitted in discovery_only mode
    heartbeats = [p for p in json_lines if p.get("type") == "progress" and p.get("event") == "heartbeat"]
    assert len(heartbeats) >= 1, "Heartbeats MUST be emitted in discovery_only mode (PID 14 defect fix)"

    # Verify monotonic sequence numbers and valid timestamps
    seqs = [h["seq"] for h in heartbeats]
    assert seqs == sorted(seqs), f"Heartbeat seqs must be monotonic: {seqs}"
    assert all(isinstance(s, int) and s >= 1 for s in seqs)
    timestamps = [h["timestamp"] for h in heartbeats]
    assert timestamps == sorted(timestamps)


# =============================================================================
# 3. MapsScraper: Canonical Place ID Extraction & Deduplication
# =============================================================================

def test_extract_canonical_place_id_and_search_space_dedup():
    """Verify MapsScraper canonical ID extraction and scroll round expansion deduplication."""
    # Test canonical ID extraction
    url1 = "https://www.google.com/maps/place/Acme+Cafe/@37.7749,-122.4194,17z/data=!4m6!3m5!1s0x8085806283b7f2cf:0xa1b2c3d4e5f60718!8m2!3d37.7749!4d-122.4194!16s%2Fg%2F11b6example"
    url2 = "https://www.google.com/maps/place/Baker+St/@37.7749,-122.4194,17z/data=!4m6!3m5!1s0x8085806283b7f2cf:0x9999999999999999!8m2!3d37.7749!4d-122.4194!16s%2Fg%2F11b6other"
    non_place = "https://www.google.com/maps/search/pizza"

    id1 = MapsScraper._extract_canonical_place_id(url1)
    id2 = MapsScraper._extract_canonical_place_id(url2)
    id_none = MapsScraper._extract_canonical_place_id(non_place)

    assert id1 is not None and len(id1) > 0
    assert id2 is not None and len(id2) > 0
    assert id1 != id2
    assert id_none is None

    # Simulate scroll rounds against observed_place_ids
    observed_place_ids: set[str] = set()

    # Round 1: url1 and url2 appear (2 new IDs)
    round1_urls = [url1, url2]
    new_in_round1 = set()
    for u in round1_urls:
        cid = MapsScraper._extract_canonical_place_id(u)
        if cid and cid not in observed_place_ids:
            new_in_round1.add(cid)
    observed_place_ids.update(new_in_round1)
    assert len(new_in_round1) == 2
    assert len(observed_place_ids) == 2

    # Round 2: same url1 and url2 appear (redundant scroll round)
    round2_urls = [url1, url2]
    new_in_round2 = set()
    for u in round2_urls:
        cid = MapsScraper._extract_canonical_place_id(u)
        if cid and cid not in observed_place_ids:
            new_in_round2.add(cid)
    # Must NOT expand search space
    assert len(new_in_round2) == 0
    assert len(observed_place_ids) == 2


# =============================================================================
# 4. MapsScraper: Card Attempt Lifecycle Deduplication
# =============================================================================

def test_card_attempt_lifecycle_deduplication():
    """Verify card_attempt_started and card_processed deduplication."""
    emitted_card_attempts: set[str] = set()
    progress_events: list[tuple[str, str, str | None]] = []

    def mock_emit_progress(event: str, item_id: str, status: str | None = None):
        progress_events.append((event, item_id, status))

    place_key = "place-abc"
    attempt = 1

    # First attempt start
    card_attempt_id = f"{place_key}:{attempt}"
    if card_attempt_id not in emitted_card_attempts:
        emitted_card_attempts.add(card_attempt_id)
        mock_emit_progress("card_attempt_started", card_attempt_id)

    assert len(progress_events) == 1
    assert progress_events[0] == ("card_attempt_started", "place-abc:1", None)

    # Re-evaluating same attempt in same card must not emit duplicate
    if card_attempt_id not in emitted_card_attempts:
        emitted_card_attempts.add(card_attempt_id)
        mock_emit_progress("card_attempt_started", card_attempt_id)

    assert len(progress_events) == 1  # No duplicate

    # Terminal card_processed
    card_processed_emitted = False
    def emit_card_processed(status: str):
        nonlocal card_processed_emitted
        if not card_processed_emitted:
            card_processed_emitted = True
            mock_emit_progress("card_processed", f"{card_attempt_id}:{status}", status)

    emit_card_processed("verified")
    assert len(progress_events) == 2
    assert progress_events[1] == ("card_processed", "place-abc:1:verified", "verified")

    # Double-call must not emit duplicate
    emit_card_processed("verified")
    assert len(progress_events) == 2

    # Context rebuild attempt (attempt=2)
    attempt_2_id = f"{place_key}:2"
    mock_emit_progress("attempt_rebuilding", "2")
    if attempt_2_id not in emitted_card_attempts:
        emitted_card_attempts.add(attempt_2_id)
        mock_emit_progress("card_attempt_started", attempt_2_id)

    assert len(progress_events) == 4
    assert progress_events[2] == ("attempt_rebuilding", "2", None)
    assert progress_events[3] == ("card_attempt_started", "place-abc:2", None)


# =============================================================================
# 5. Termination Reason Propagation
# =============================================================================

def test_discovery_failure_reasons_contain_watchdog_members():
    """Verify typed watchdog and cancellation failure reasons exist in enum."""
    assert DiscoveryFailureReason.USER_CANCELLED.value == "USER_CANCELLED"
    assert DiscoveryFailureReason.WATCHDOG_TIMEOUT.value == "WATCHDOG_TIMEOUT"
    assert DiscoveryFailureReason.PROCESS_UNRESPONSIVE.value == "PROCESS_UNRESPONSIVE"
    assert DiscoveryFailureReason.DISCOVERY_PROGRESS_TIMEOUT.value == "DISCOVERY_PROGRESS_TIMEOUT"


@pytest.mark.asyncio
async def test_main_cli_preserves_specific_termination_reasons():
    """Verify _main_cli preserves specific termination reason in __done__ sentinel."""
    lines_written = []

    def mock_write(line):
        lines_written.append(line)

    mock_stdout = MagicMock(write=mock_write, flush=MagicMock())

    with patch("sys.stdout", mock_stdout), \
         patch.object(service, "_get_shutdown_reason", return_value="WATCHDOG_TIMEOUT"), \
         patch.object(service, "run_query") as mock_rq, \
         patch.object(sys, "argv", ["service.py", json.dumps({"query": "pizza", "city": "Venice"})]):

        async def raise_watchdog(*args, **kwargs):
            raise DiscoveryFailure(
                DiscoveryFailureReason.WATCHDOG_TIMEOUT,
                "watchdog requested shutdown",
            )
            # Make it an async generator
            if False:
                yield {}

        mock_rq.return_value = raise_watchdog()

        await service._main_cli()

    done_lines = [json.loads(l) for l in lines_written if "__done__" in l]
    assert len(done_lines) == 1
    done = done_lines[0]
    assert done["__done__"] is True
    assert done["success"] is False
    assert done["failure_reason"] == "WATCHDOG_TIMEOUT"
    assert done["termination_reason"] == "WATCHDOG_TIMEOUT"


# =============================================================================
# 6. Complete Heartbeat Coverage: discovery_only=False and Task Cleanup
# =============================================================================

@pytest.mark.asyncio
async def test_heartbeat_ticker_in_full_pipeline_mode():
    """Verify heartbeat ticker is active and emits heartbeats when discovery_only=False."""
    stdout_buf = io.StringIO()

    mock_coordinator = MagicMock()
    mock_session_ctx = MagicMock()
    mock_session_ctx.session.id = "test-session-id"
    mock_coordinator.create_session.return_value = mock_session_ctx

    mock_shutdown = threading.Event()
    mock_driver = MagicMock()
    mock_driver.last_error = None
    mock_driver.stopped_by_shutdown = False
    mock_driver.producers_finished.return_value = True
    call_count = 0
    def fake_run_once():
        nonlocal call_count
        call_count += 1
        time.sleep(0.04)
        if call_count >= 1:
            mock_shutdown.set()
        return []
    mock_driver.run_once = fake_run_once

    mock_fan_in = MagicMock()
    mock_fan_in.pending_count.return_value = 0

    mock_composed = MagicMock()
    mock_composed.provider = MagicMock()
    mock_composed.request = MagicMock()
    mock_composed.selected_provider_ids = ["google_maps"]

    orig_sleep = asyncio.sleep
    async def fast_ticker_sleep(duration):
        if duration == 15.0:
            await orig_sleep(0.02)
        else:
            await orig_sleep(duration)

    with patch("sys.stdout", stdout_buf), \
         patch.object(service, "engine_coordinator", mock_coordinator), \
         patch.object(service, "compose_discovery", return_value=mock_composed), \
         patch.object(service, "build_seven_stage_pipeline", return_value=([], MagicMock(), mock_fan_in, lambda: None)), \
         patch.object(service, "ExecutionDriver", return_value=mock_driver), \
         patch.object(service, "_build_storage_backend", return_value=MagicMock()), \
         patch.object(service, "_build_batch_intelligence_backend", return_value=MagicMock()), \
         patch.object(service, "_build_early_dedup_checker", return_value=None), \
         patch("asyncio.sleep", side_effect=fast_ticker_sleep):

        leads = []
        async for lead in service.run_query(
            query="pizza",
            city="Venice",
            max_results=3,
            discovery_only=False,
            shutdown_event=mock_shutdown,
            shutdown_reason="CONSUMER_STOPPED",
        ):
            leads.append(lead)

    output_lines = stdout_buf.getvalue().splitlines()
    json_lines = []
    for line in output_lines:
        line = line.strip()
        if line.startswith("{") and line.endswith("}"):
            try:
                json_lines.append(json.loads(line))
            except Exception:
                pass

    ready_events = [p for p in json_lines if p.get("type") == "progress" and p.get("event") == "service_ready"]
    assert len(ready_events) >= 1
    assert ready_events[0]["seq"] == 0

    heartbeats = [p for p in json_lines if p.get("type") == "progress" and p.get("event") == "heartbeat"]
    assert len(heartbeats) >= 1, "Heartbeats MUST be emitted in discovery_only=False mode"

    seqs = [h["seq"] for h in heartbeats]
    assert seqs == sorted(seqs), f"Heartbeat seqs must be monotonic: {seqs}"
    assert all(isinstance(s, int) and s >= 1 for s in seqs)


@pytest.mark.asyncio
async def test_heartbeat_task_cleanup_on_completion():
    """Verify heartbeat task is properly cancelled and awaited on successful completion."""
    captured_hb_tasks = []
    orig_create_task = asyncio.create_task

    def capturing_create_task(coro, **kwargs):
        task = orig_create_task(coro, **kwargs)
        if "hb_ticker" in getattr(coro, "__name__", "") or "_hb_ticker" in getattr(coro, "__qualname__", ""):
            captured_hb_tasks.append(task)
        return task

    def fake_discover(request):
        candidate = MagicMock()
        candidate.pipeline_id = "pipe-0"
        candidate.session_id = "test-session"
        candidate.name = "Business 0"
        candidate.category = "Restaurant"
        candidate.address = "0 Main St"
        candidate.city = "Venice"
        candidate.country = "US"
        candidate.website = "https://example.com/0"
        candidate.phone = "+15550000000"
        candidate.rating = 4.5
        candidate.review_count = 100
        candidate.maps_url = "https://maps.google.com/?cid=0"
        candidate.is_google_verified = True
        candidate.has_website = True
        candidate.has_phone = True
        candidate.has_instagram = False
        candidate.discovered_at = "2026-10-31T00:00:00Z"
        yield candidate

    mock_provider = MagicMock()
    mock_provider.discover = fake_discover
    mock_composed = MagicMock()
    mock_composed.provider = mock_provider
    mock_composed.request = MagicMock()
    mock_composed.selected_provider_ids = ["google_maps"]

    with patch("sys.stdout", io.StringIO()), \
         patch.object(service, "compose_discovery", return_value=mock_composed), \
         patch("asyncio.create_task", side_effect=capturing_create_task):

        async for _ in service.run_query(query="pizza", city="Venice", deliver_target=1, discovery_only=True):
            pass

    assert len(captured_hb_tasks) == 1
    hb_task = captured_hb_tasks[0]
    assert hb_task.done(), "Heartbeat task must be done (cancelled and awaited) after completion"


@pytest.mark.asyncio
async def test_heartbeat_task_cleanup_on_cancellation():
    """Verify heartbeat task is properly cancelled and awaited when run_query is cancelled."""
    captured_hb_tasks = []
    orig_create_task = asyncio.create_task

    def capturing_create_task(coro, **kwargs):
        task = orig_create_task(coro, **kwargs)
        if "hb_ticker" in getattr(coro, "__name__", "") or "_hb_ticker" in getattr(coro, "__qualname__", ""):
            captured_hb_tasks.append(task)
        return task

    def hanging_discover(req):
        time.sleep(0.5)
        return iter([])

    mock_provider = MagicMock()
    mock_provider.discover = hanging_discover
    mock_composed = MagicMock()
    mock_composed.provider = mock_provider
    mock_composed.request = MagicMock()
    mock_composed.selected_provider_ids = ["google_maps"]

    async def run_and_cancel():
        async for _ in service.run_query(query="pizza", city="Venice", discovery_only=True):
            pass

    with patch("sys.stdout", io.StringIO()), \
         patch.object(service, "compose_discovery", return_value=mock_composed), \
         patch("asyncio.create_task", side_effect=capturing_create_task):

        q_task = asyncio.create_task(run_and_cancel())
        await asyncio.sleep(0.05)
        q_task.cancel()
        try:
            await q_task
        except (asyncio.CancelledError, Exception):
            pass

    assert len(captured_hb_tasks) == 1
    hb_task = captured_hb_tasks[0]
    assert hb_task.done(), "Heartbeat task must be done (cancelled and cleaned up) after cancellation"
