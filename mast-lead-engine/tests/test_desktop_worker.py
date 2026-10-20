"""
Unit tests for Desktop Worker prototype (Phase 3 / 3.5).
Tests the local worker coordination logic, batching, heartbeats,
browser detection/provisioning, and candidate normalization.
"""

import asyncio
import time
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

from desktop_worker import (
    DesktopCoordinatorClient,
    DesktopWorker,
    ensure_playwright_browser_provisioned,
    get_desktop_data_dir,
    is_chromium_installed,
    normalize_candidate_for_ingest,
    run_browser_test,
    setup_playwright_browsers_path,
)


class TestDesktopWorkerNormalization(unittest.TestCase):
    def test_normalize_candidate_populates_required_schema_fields(self):
        task = {
            "id": "task-123",
            "city": "Austin",
            "niche": "yoga studios",
            "countryCode": "US",
            "countryName": "United States",
            "region": "TX",
        }
        raw_lead = {
            "name": "Prana Yoga",
            "address": "123 Main St",
            "phone": "+1 512 555 1234",
            "website": "https://pranayoga.com",
            "rating": 4.8,
            "reviews": 120,
            "score": 85,
            "fingerprints": ["fp1", "fp2"],
        }
        norm = normalize_candidate_for_ingest(raw_lead, task)

        self.assertEqual(norm["name"], "Prana Yoga")
        self.assertEqual(norm["city"], "Austin")
        self.assertEqual(norm["country"], "United States")
        self.assertEqual(norm["country_code"], "US")
        self.assertEqual(norm["niche"], "yoga studios")
        self.assertEqual(norm["phone"], "+1 512 555 1234")
        self.assertEqual(norm["website"], "https://pranayoga.com")
        self.assertEqual(norm["rating"], 4.8)
        self.assertEqual(norm["reviews"], 120)
        self.assertEqual(norm["score"], 85.0)
        self.assertEqual(norm["fingerprints"], ["fp1", "fp2"])
        self.assertFalse(norm["is_disqualified"])
        self.assertIsInstance(norm["tech_stack"], dict)

    def test_normalize_candidate_handles_missing_fields_gracefully(self):
        task = {"id": "task-456", "city": "Denver", "niche": "plumbers"}
        raw_lead = {}
        norm = normalize_candidate_for_ingest(raw_lead, task)

        self.assertEqual(norm["name"], "Unknown Business")
        self.assertEqual(norm["city"], "Denver")
        self.assertEqual(norm["niche"], "plumbers")
        self.assertEqual(norm["country_code"], "US")
        self.assertIsNone(norm["rating"])
        self.assertEqual(norm["reviews"], 0)
        self.assertEqual(norm["fingerprints"], [])


class TestDesktopWorkerCoordination(unittest.IsolatedAsyncioTestCase):
    async def test_worker_executes_task_batches_and_completes(self):
        client = MagicMock(spec=DesktopCoordinatorClient)
        client.heartbeat = AsyncMock(return_value=True)
        client.ingest_batch = AsyncMock(side_effect=lambda t, l, b, c: {"accepted": len(c), "duplicates": 0, "rejected": 0})
        client.complete_task = AsyncMock(return_value=True)

        async def fake_engine(**kwargs):
            yield {"name": "Biz 1", "rating": 4.5}
            yield {"name": "Biz 2", "rating": 4.7}

        worker = DesktopWorker(
            client=client,
            batch_size=2,
            heartbeat_interval_s=10.0,
            engine_runner=fake_engine,
        )

        task = {
            "id": "task-uuid-1",
            "leaseToken": "lease-token-abc",
            "niche": "cafes",
            "city": "Seattle",
            "candidateBudget": 2,
        }

        success = await worker.execute_task(task)

        self.assertTrue(success)
        # Immediate first-lead flush dispatches Candidate 1 in batch 1, then Candidate 2 in batch 2
        self.assertEqual(client.ingest_batch.call_count, 2)
        batch1 = client.ingest_batch.call_args_list[0][0][3]
        batch2 = client.ingest_batch.call_args_list[1][0][3]
        self.assertEqual(len(batch1), 1)
        self.assertEqual(len(batch2), 1)
        self.assertEqual(batch1[0]["name"], "Biz 1")
        self.assertEqual(batch2[0]["name"], "Biz 2")

        client.complete_task.assert_called_once()
        complete_kwargs = client.complete_task.call_args.kwargs
        self.assertEqual(complete_kwargs["task_id"], "task-uuid-1")
        self.assertEqual(complete_kwargs["status"], "completed")
        self.assertEqual(complete_kwargs["accepted"], 2)
        self.assertEqual(complete_kwargs["completion_reason"], "target_reached")

    async def test_worker_aborts_when_heartbeat_fails(self):
        client = MagicMock(spec=DesktopCoordinatorClient)
        client.heartbeat = AsyncMock(return_value=False)
        client.ingest_batch = AsyncMock(return_value={"accepted": 1, "duplicates": 0, "rejected": 0})
        client.complete_task = AsyncMock(return_value=True)

        async def endless_fake_engine(**kwargs):
            i = 0
            while True:
                i += 1
                yield {"name": f"Biz {i}"}
                await asyncio.sleep(0.05)

        worker = DesktopWorker(
            client=client,
            batch_size=5,
            heartbeat_interval_s=0.01,
            engine_runner=endless_fake_engine,
        )

        task = {
            "id": "task-uuid-2",
            "leaseToken": "lease-token-expired",
            "niche": "gyms",
            "city": "Chicago",
            "candidateBudget": 50,
        }

        await worker.execute_task(task)

        client.complete_task.assert_called_once()
        complete_kwargs = client.complete_task.call_args.kwargs
        self.assertEqual(complete_kwargs["termination_reason"], "CANCELLED")
        self.assertFalse(worker._shutdown_event.is_set(), "Task cancellation should not shut down outer worker loop")

    async def test_worker_stops_when_plan_target_reached(self):
        client = MagicMock(spec=DesktopCoordinatorClient)
        client.heartbeat = AsyncMock(return_value=True)
        # Ingest response reports planTargetReached=True
        client.ingest_batch = AsyncMock(return_value={"accepted": 2, "duplicates": 0, "rejected": 0, "planTargetReached": True})
        client.complete_task = AsyncMock(return_value=True)

        async def endless_fake_engine(**kwargs):
            i = 0
            while True:
                i += 1
                yield {"name": f"Biz {i}"}
                await asyncio.sleep(0.01)

        worker = DesktopWorker(
            client=client,
            batch_size=2,
            heartbeat_interval_s=10.0,
            engine_runner=endless_fake_engine,
        )

        task = {
            "id": "task-uuid-target-reached",
            "leaseToken": "lease-token-target-reached",
            "niche": "gyms",
            "city": "Miami",
            "candidateBudget": 50,
        }

        await worker.execute_task(task)

        client.complete_task.assert_called_once()
        complete_kwargs = client.complete_task.call_args.kwargs
        self.assertEqual(complete_kwargs["termination_reason"], "PLAN_TARGET_REACHED")
        self.assertFalse(worker._shutdown_event.is_set(), "Worker should stay alive for next task")

    async def test_worker_fails_and_aborts_when_ingest_fails(self):
        client = MagicMock(spec=DesktopCoordinatorClient)
        client.heartbeat = AsyncMock(return_value=True)
        # Ingest fails (simulating repeated network failure or 409)
        client.ingest_batch = AsyncMock(return_value=None)
        client.complete_task = AsyncMock(return_value=True)

        async def fake_engine(**kwargs):
            yield {"name": "Biz 1"}
            yield {"name": "Biz 2"}

        worker = DesktopWorker(
            client=client,
            batch_size=1,
            heartbeat_interval_s=10.0,
            engine_runner=fake_engine,
        )

        task = {
            "id": "task-uuid-3",
            "leaseToken": "lease-token-fail",
            "niche": "bakeries",
            "city": "Austin",
            "candidateBudget": 10,
        }

        success = await worker.execute_task(task)
        self.assertFalse(success)

        client.complete_task.assert_called_once()
        complete_kwargs = client.complete_task.call_args.kwargs
        self.assertEqual(complete_kwargs["status"], "failed")
        self.assertEqual(complete_kwargs["completion_reason"], "failed")
        self.assertEqual(complete_kwargs["termination_reason"], "FAILURE_INGESTION")
        self.assertIn("Ingestion failed", complete_kwargs["error"])

    async def test_worker_reports_engine_exception_with_distinct_reason_and_details(self):
        client = MagicMock(spec=DesktopCoordinatorClient)
        client.heartbeat = AsyncMock(return_value=True)
        client.complete_task = AsyncMock(return_value=True)

        async def failing_engine(**kwargs):
            raise RuntimeError("Database connection timed out")
            yield {}

        worker = DesktopWorker(
            client=client,
            batch_size=1,
            heartbeat_interval_s=10.0,
            engine_runner=failing_engine,
        )

        task = {
            "id": "task-uuid-exc",
            "leaseToken": "lease-token-exc",
            "niche": "bakeries",
            "city": "Austin",
            "candidateBudget": 10,
        }

        success = await worker.execute_task(task)
        self.assertFalse(success)

        client.complete_task.assert_called_once()
        complete_kwargs = client.complete_task.call_args.kwargs
        self.assertEqual(complete_kwargs["status"], "failed")
        self.assertEqual(complete_kwargs["completion_reason"], "failed")
        self.assertEqual(complete_kwargs["termination_reason"], "FAILURE_RUNTIMEERROR")
        self.assertIn("RuntimeError: Database connection timed out", complete_kwargs["error"])

    async def test_worker_run_loop_aborts_without_auth_token(self):
        client = MagicMock(spec=DesktopCoordinatorClient)
        client.auth_token = ""
        client.claim_task = AsyncMock()

        worker = DesktopWorker(client=client)
        await worker.run_loop(once=True)

        client.claim_task.assert_not_called()

    async def test_worker_passes_localized_query_to_runner(self):
        client = MagicMock(spec=DesktopCoordinatorClient)
        client.heartbeat = AsyncMock(return_value=True)
        client.ingest_batch = AsyncMock(return_value={"accepted": 1, "duplicates": 0, "rejected": 0})
        client.complete_task = AsyncMock(return_value=True)

        captured_kwargs = {}

        async def fake_engine(**kwargs):
            captured_kwargs.update(kwargs)
            yield {"name": "Local Cafe"}

        worker = DesktopWorker(client=client, batch_size=1, engine_runner=fake_engine)

        # 1. With explicit queryString
        task_with_query_string = {
            "id": "t-1",
            "leaseToken": "lt-1",
            "queryString": "Coffee Shop in Lincoln Square, Chicago",
            "niche": "Coffee Shop",
            "city": "Chicago",
            "area": "Lincoln Square",
            "candidateBudget": 1,
        }
        await worker.execute_task(task_with_query_string)
        self.assertEqual(captured_kwargs.get("query"), "Coffee Shop in Lincoln Square, Chicago")

        # 2. Without queryString, but with area, niche, city
        captured_kwargs.clear()
        task_with_area = {
            "id": "t-2",
            "leaseToken": "lt-2",
            "niche": "Bakeries",
            "city": "Chicago",
            "area": "Logan Square",
            "candidateBudget": 1,
        }
        await worker.execute_task(task_with_area)
        self.assertEqual(captured_kwargs.get("query"), "Bakeries in Logan Square, Chicago")

    async def test_worker_filters_required_channels_to_maps_channels(self):
        client = MagicMock(spec=DesktopCoordinatorClient)
        client.heartbeat = AsyncMock(return_value=True)
        client.ingest_batch = AsyncMock(return_value={"accepted": 1, "duplicates": 0, "rejected": 0})
        client.complete_task = AsyncMock(return_value=True)

        captured_kwargs = {}

        async def fake_engine(**kwargs):
            captured_kwargs.update(kwargs)
            yield {"name": "Lead"}

        worker = DesktopWorker(client=client, batch_size=1, engine_runner=fake_engine)

        task = {
            "id": "t-ch",
            "leaseToken": "lt-ch",
            "niche": "Cafes",
            "city": "Seattle",
            "candidateBudget": 1,
            "channels": ["email", "instagram", "website", "phone"],
        }
        await worker.execute_task(task)
        # Only website and phone should be sent to engine runner; email and instagram are resolved during website enrichment
        self.assertEqual(captured_kwargs.get("required_channels"), ["website", "phone"])

    async def test_worker_cancels_sibling_tasks_when_plan_target_reached(self):
        client = MagicMock(spec=DesktopCoordinatorClient)
        client.heartbeat = AsyncMock(return_value=True)
        client.ingest_batch = AsyncMock(return_value={"accepted": 1, "duplicates": 0, "rejected": 0, "planTargetReached": True})
        client.complete_task = AsyncMock(return_value=True)

        async def fake_engine(**kwargs):
            yield {"name": "Biz 1"}

        worker = DesktopWorker(client=client, batch_size=1, engine_runner=fake_engine)

        plan_id = "plan-multi-123"
        task1_abort = asyncio.Event()
        task2_abort = asyncio.Event()

        worker._active_tasks["task-1"] = task1_abort
        worker._active_tasks["task-2"] = task2_abort
        worker._plan_tasks[plan_id] = {"task-1", "task-2"}

        task1 = {
            "id": "task-1",
            "leaseToken": "lt-1",
            "planId": plan_id,
            "niche": "cafes",
            "city": "Austin",
            "candidateBudget": 5,
        }

        await worker.execute_task(task1, task_abort=task1_abort)

        self.assertTrue(task1_abort.is_set())
        self.assertTrue(task2_abort.is_set())

    async def test_worker_run_loop_starts_concurrent_scout_slots(self):
        client = MagicMock(spec=DesktopCoordinatorClient)
        client.auth_token = "valid-token"
        claimed_tasks = []

        async def fake_claim():
            await asyncio.sleep(0.01)
            t_id = f"task-{len(claimed_tasks) + 1}"
            task = {"id": t_id, "leaseToken": f"lt-{t_id}", "niche": "cafes", "city": "Austin", "candidateBudget": 1}
            claimed_tasks.append(task)
            return task

        client.claim_task = AsyncMock(side_effect=fake_claim)
        client.heartbeat = AsyncMock(return_value=True)
        client.ingest_batch = AsyncMock(return_value={"accepted": 1, "duplicates": 0, "rejected": 0})
        client.complete_task = AsyncMock(return_value=True)

        async def fake_engine(**kwargs):
            await asyncio.sleep(0.05)
            yield {"name": "Cafe"}

        worker = DesktopWorker(client=client, concurrency=3, batch_size=1, engine_runner=fake_engine)

        async def stopper():
            while len(worker._active_tasks) < 2 and len(claimed_tasks) < 3:
                await asyncio.sleep(0.01)
            worker._shutdown_event.set()

        await asyncio.gather(
            worker.run_loop(poll_interval_s=0.01),
            stopper(),
        )

        self.assertGreaterEqual(len(claimed_tasks), 2)


    async def test_producer_consumer_decoupling_does_not_block_discovery(self):
        """Proves discovery scraper produces candidates ahead into bounded queue while ingestion sends batches."""
        client = MagicMock(spec=DesktopCoordinatorClient)
        client.heartbeat = AsyncMock(return_value=True)
        client.complete_task = AsyncMock(return_value=True)

        async def slow_ingest(task_id, lease_token, batch_id, candidates):
            await asyncio.sleep(0.05)
            return {"accepted": len(candidates), "duplicates": 0, "rejected": 0}

        client.ingest_batch = AsyncMock(side_effect=slow_ingest)

        discovery_times = []

        async def fast_engine(**kwargs):
            for i in range(4):
                discovery_times.append(time.time())
                yield {"name": f"Fast Biz {i}"}
                await asyncio.sleep(0.01)

        worker = DesktopWorker(
            client=client,
            batch_size=2,
            engine_runner=fast_engine,
        )

        task = {
            "id": "t-pipelined",
            "leaseToken": "lt-pipe",
            "niche": "plumbers",
            "city": "Austin",
            "candidateBudget": 4,
        }

        ok = await worker.execute_task(task)
        self.assertTrue(ok)
        # Immediate first lead (1 lead) + full batch (2 leads) + remaining final (1 lead) = 3 batches
        self.assertEqual(client.ingest_batch.call_count, 3)
        self.assertEqual(len(discovery_times), 4)
        client.complete_task.assert_called_once()
        complete_kwargs = client.complete_task.call_args.kwargs
        self.assertEqual(complete_kwargs["accepted"], 4)
        self.assertEqual(complete_kwargs["status"], "completed")

    async def test_immediate_first_candidate_flush(self):
        """Proves the first discovered candidate is immediately dispatched without waiting for batch size."""
        client = MagicMock(spec=DesktopCoordinatorClient)
        client.heartbeat = AsyncMock(return_value=True)
        first_ingest_time: list[float] = []
        second_yield_time: list[float] = []

        async def staggered_engine(**kwargs):
            yield {"name": "Candidate 1", "rating": 4.5}
            await asyncio.sleep(0.2)
            second_yield_time.append(time.time())
            yield {"name": "Candidate 2", "rating": 4.6}

        async def tracking_ingest(task_id, lease_token, batch_id, candidates):
            if not first_ingest_time:
                first_ingest_time.append(time.time())
            return {"accepted": len(candidates), "duplicates": 0, "rejected": 0}

        client.ingest_batch = AsyncMock(side_effect=tracking_ingest)
        client.complete_task = AsyncMock(return_value=True)

        worker = DesktopWorker(
            client=client,
            batch_size=5,  # batch size 5!
            heartbeat_interval_s=10.0,
            engine_runner=staggered_engine,
        )

        task = {
            "id": "t-first-flush",
            "leaseToken": "lt-first",
            "niche": "cafes",
            "city": "Seattle",
            "candidateBudget": 2,
        }

        ok = await worker.execute_task(task)
        self.assertTrue(ok)
        self.assertEqual(client.ingest_batch.call_count, 2)
        batch1 = client.ingest_batch.call_args_list[0][0][3]
        self.assertEqual(len(batch1), 1, "First batch must flush immediately with 1 candidate")
        self.assertEqual(batch1[0]["name"], "Candidate 1")
        if second_yield_time and first_ingest_time:
            self.assertLess(first_ingest_time[0], second_yield_time[0] + 0.05)

    async def test_time_based_partial_batch_flush_in_sparse_market(self):
        """Proves that buffered candidates flush on bounded idle timer (1.5s) in sparse markets."""
        client = MagicMock(spec=DesktopCoordinatorClient)
        client.heartbeat = AsyncMock(return_value=True)
        client.complete_task = AsyncMock(return_value=True)

        batch_times: list[float] = []

        async def sparse_engine(**kwargs):
            yield {"name": "Sparse 1"}
            yield {"name": "Sparse 2"}
            await asyncio.sleep(1.8)
            yield {"name": "Sparse 3"}

        async def recording_ingest(task_id, lease_token, batch_id, candidates):
            batch_times.append(time.time())
            return {"accepted": len(candidates), "duplicates": 0, "rejected": 0}

        client.ingest_batch = AsyncMock(side_effect=recording_ingest)

        worker = DesktopWorker(
            client=client,
            batch_size=5,
            heartbeat_interval_s=10.0,
            engine_runner=sparse_engine,
        )

        task = {
            "id": "t-sparse-timer",
            "leaseToken": "lt-sparse",
            "niche": "specialty",
            "city": "RemoteTown",
            "candidateBudget": 3,
        }

        ok = await worker.execute_task(task)
        self.assertTrue(ok)
        self.assertEqual(client.ingest_batch.call_count, 3)

    async def test_sparse_markets_fewer_candidates_than_batch_size(self):
        """Proves sparse markets delivering fewer candidates than batch size complete with exhausted=True."""
        client = MagicMock(spec=DesktopCoordinatorClient)
        client.heartbeat = AsyncMock(return_value=True)
        client.ingest_batch = AsyncMock(side_effect=lambda t, l, b, c: {"accepted": len(c), "duplicates": 0, "rejected": 0})
        client.complete_task = AsyncMock(return_value=True)

        async def small_market_engine(**kwargs):
            yield {"name": "Small 1"}
            yield {"name": "Small 2"}

        worker = DesktopWorker(
            client=client,
            batch_size=5,
            engine_runner=small_market_engine,
        )

        task = {
            "id": "t-sparse-exhaust",
            "leaseToken": "lt-sparse-ex",
            "niche": "rare",
            "city": "SmallTown",
            "candidateBudget": 10,
        }

        ok = await worker.execute_task(task)
        self.assertTrue(ok)
        client.complete_task.assert_called_once()
        complete_kwargs = client.complete_task.call_args.kwargs
        self.assertTrue(complete_kwargs["exhausted"])
        self.assertEqual(complete_kwargs["status"], "completed")
        self.assertEqual(complete_kwargs["accepted"], 2)

    async def test_final_partial_batch_flushing(self):
        """Proves remaining buffered candidates are properly flushed when discovery completes normally."""
        client = MagicMock(spec=DesktopCoordinatorClient)
        client.heartbeat = AsyncMock(return_value=True)
        client.ingest_batch = AsyncMock(side_effect=lambda t, l, b, c: {"accepted": len(c), "duplicates": 0, "rejected": 0})
        client.complete_task = AsyncMock(return_value=True)

        async def engine_4_items(**kwargs):
            for i in range(4):
                yield {"name": f"Lead {i+1}"}

        worker = DesktopWorker(
            client=client,
            batch_size=5,
            engine_runner=engine_4_items,
        )

        task = {
            "id": "t-final-flush",
            "leaseToken": "lt-final",
            "niche": "plumbers",
            "city": "Dallas",
            "candidateBudget": 10,
        }

        ok = await worker.execute_task(task)
        self.assertTrue(ok)
        self.assertEqual(client.ingest_batch.call_count, 2)
        batch2 = client.ingest_batch.call_args_list[1][0][3]
        self.assertEqual(len(batch2), 3)

    async def test_cancellation_discards_queued_and_does_not_send_new_work(self):
        """Proves cancelling task aborts cleanly without sending buffered work over the network."""
        client = MagicMock(spec=DesktopCoordinatorClient)
        client.heartbeat = AsyncMock(return_value=True)
        client.complete_task = AsyncMock(return_value=True)

        ingest_calls: list[list[dict]] = []

        async def slow_ingest(task_id, lease_token, batch_id, candidates):
            ingest_calls.append(candidates)
            await asyncio.sleep(0.05)
            return {"accepted": len(candidates), "duplicates": 0, "rejected": 0}

        client.ingest_batch = AsyncMock(side_effect=slow_ingest)

        async def continuous_engine(**kwargs):
            s_event = kwargs.get("shutdown_event")
            for i in range(50):
                if s_event and s_event.is_set():
                    break
                yield {"name": f"Cont Lead {i}"}
                await asyncio.sleep(0.01)

        worker = DesktopWorker(
            client=client,
            batch_size=5,
            engine_runner=continuous_engine,
        )

        task = {
            "id": "t-cancel-nowork",
            "leaseToken": "lt-cancel",
            "niche": "lawyers",
            "city": "Miami",
            "candidateBudget": 50,
        }

        abort_event = asyncio.Event()

        async def cancel_soon():
            await asyncio.sleep(0.08)
            abort_event.set()

        await asyncio.gather(
            worker.execute_task(task, task_abort=abort_event),
            cancel_soon(),
        )

        client.complete_task.assert_called_once()
        complete_kwargs = client.complete_task.call_args.kwargs
        self.assertEqual(complete_kwargs["termination_reason"], "CANCELLED")
        calls_count_after_cancel = len(ingest_calls)
        await asyncio.sleep(0.1)
        self.assertEqual(len(ingest_calls), calls_count_after_cancel)


class TestBrowserDetectionAndProvisioning(unittest.IsolatedAsyncioTestCase):
    def test_is_chromium_installed_returns_false_for_empty_dir(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            self.assertFalse(is_chromium_installed(tmpdir))

    def test_is_chromium_installed_detects_chrome_exe(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            chrome_dir = Path(tmpdir) / "chromium-1228" / "chrome-win64"
            chrome_dir.mkdir(parents=True)
            chrome_exe = chrome_dir / "chrome.exe"
            chrome_exe.write_text("fake binary")

            self.assertTrue(is_chromium_installed(tmpdir))

    def test_ensure_playwright_browser_provisioned_skips_when_installed(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            chrome_dir = Path(tmpdir) / "chromium-1228" / "chrome-win64"
            chrome_dir.mkdir(parents=True)
            (chrome_dir / "chrome.exe").write_text("fake binary")

            result = ensure_playwright_browser_provisioned(tmpdir)
            self.assertEqual(result, Path(tmpdir))

    def test_setup_playwright_browsers_path_returns_valid_string(self):
        path = setup_playwright_browsers_path(provision_if_missing=False)
        self.assertIsInstance(path, str)
        self.assertGreater(len(path), 0)
        self.assertEqual(os.environ.get("PLAYWRIGHT_BROWSERS_PATH"), path)

    async def test_run_browser_test_mocked(self):
        with patch("playwright.async_api.async_playwright") as mock_pw:
            mock_browser = AsyncMock()
            mock_page = AsyncMock()
            mock_page.evaluate = AsyncMock(return_value="OK")
            mock_browser.new_page = AsyncMock(return_value=mock_page)
            mock_browser.close = AsyncMock()

            mock_p_instance = AsyncMock()
            mock_p_instance.chromium.launch = AsyncMock(return_value=mock_browser)
            mock_pw.return_value.__aenter__.return_value = mock_p_instance

            code = await run_browser_test("dummy/path")
            self.assertEqual(code, 0)
            mock_p_instance.chromium.launch.assert_called_once()
            mock_browser.close.assert_called_once()


class TestDesktopCoordinatorClient(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self._temp_dir = tempfile.TemporaryDirectory()
        self._patcher = patch("desktop_worker.get_desktop_data_dir", return_value=Path(self._temp_dir.name))
        self._patcher.start()

    def tearDown(self):
        self._patcher.stop()
        self._temp_dir.cleanup()
    async def test_claim_task_success(self):
        mock_response = MagicMock()
        mock_response.status = 200
        mock_response.json = AsyncMock(return_value={"task": {"id": "t-1", "leaseToken": "lt-1"}})

        mock_session = MagicMock()
        mock_session.post.return_value.__aenter__.return_value = mock_response

        client = DesktopCoordinatorClient("http://localhost:3000", "jwt-token-123", "worker-1", mock_session)
        task = await client.claim_task()

        self.assertIsNotNone(task)
        self.assertEqual(task["id"], "t-1")
        mock_session.post.assert_called_once()
        url = mock_session.post.call_args[0][0]
        self.assertEqual(url, "http://localhost:3000/v1/desktop/tasks/claim")
        headers = mock_session.post.call_args[1]["headers"]
        self.assertEqual(headers["Authorization"], "Bearer jwt-token-123")

    async def test_claim_task_aborts_without_token(self):
        mock_session = MagicMock()
        client = DesktopCoordinatorClient("http://localhost:3000", "", "worker-1", mock_session)
        task = await client.claim_task()

        self.assertIsNone(task)
        mock_session.post.assert_not_called()

    async def test_claim_task_handles_401_unauthorized(self):
        mock_response = MagicMock()
        mock_response.status = 401
        mock_response.text = AsyncMock(return_value="Unauthorized")

        mock_session = MagicMock()
        mock_session.post.return_value.__aenter__.return_value = mock_response

        client = DesktopCoordinatorClient("http://localhost:3000", "expired-token", "worker-1", mock_session)
        task = await client.claim_task()
        self.assertIsNone(task)
        self.assertTrue(client.last_auth_error)

    async def test_claim_task_empty(self):
        mock_response = MagicMock()
        mock_response.status = 200
        mock_response.json = AsyncMock(return_value={"task": None})

        mock_session = MagicMock()
        mock_session.post.return_value.__aenter__.return_value = mock_response

        client = DesktopCoordinatorClient("http://localhost:3000", "jwt-token", "worker-1", mock_session)
        task = await client.claim_task()
        self.assertIsNone(task)

    async def test_heartbeat_success_and_conflict(self):
        # 200 OK
        resp_ok = MagicMock()
        resp_ok.status = 200
        resp_ok.json = AsyncMock(return_value={"renewed": True})

        mock_session = MagicMock()
        mock_session.post.return_value.__aenter__.return_value = resp_ok

        client = DesktopCoordinatorClient("http://localhost:3000", "jwt-token", "worker-1", mock_session)
        ok = await client.heartbeat("t-1", "lt-1")
        self.assertTrue(ok)

        # 409 Conflict
        resp_conflict = MagicMock()
        resp_conflict.status = 409
        mock_session.post.return_value.__aenter__.return_value = resp_conflict

        ok2 = await client.heartbeat("t-1", "lt-1")
        self.assertFalse(ok2)

    async def test_heartbeat_stops_when_server_reports_cancelled(self):
        resp_stop = MagicMock()
        resp_stop.status = 200
        resp_stop.json = AsyncMock(return_value={"renewed": False, "stopReason": "cancelled"})

        mock_session = MagicMock()
        mock_session.post.return_value.__aenter__.return_value = resp_stop

        client = DesktopCoordinatorClient("http://localhost:3000", "jwt-token", "worker-1", mock_session)
        ok = await client.heartbeat("t-1", "lt-1")
        self.assertFalse(ok, "heartbeat must return False when renewed is False")

    def test_dynamic_token_refresh_from_file(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            token_file = Path(tmp_dir) / "auth.token"
            token_file.write_text("refreshed-jwt-token-456", encoding="utf-8")

            with patch("desktop_worker.get_desktop_data_dir", return_value=Path(tmp_dir)):
                mock_session = MagicMock()
                client = DesktopCoordinatorClient("http://localhost:3000", "initial-jwt-123", "worker-1", mock_session)
                token = client._get_token()
                self.assertEqual(token, "refreshed-jwt-token-456")
                headers = client._headers()
                self.assertEqual(headers["Authorization"], "Bearer refreshed-jwt-token-456")

    async def test_ingest_batch_success(self):
        resp = MagicMock()
        resp.status = 200
        resp.json = AsyncMock(return_value={"accepted": 5, "duplicates": 0, "rejected": 0})

        mock_session = MagicMock()
        mock_session.post.return_value.__aenter__.return_value = resp

        client = DesktopCoordinatorClient("http://localhost:3000", "jwt-token", "worker-1", mock_session)
        result = await client.ingest_batch("t-1", "lt-1", "b-1", [{"name": "Biz"}])
        self.assertIsNotNone(result)
        self.assertEqual(result["accepted"], 5)

    async def test_ingest_batch_retries_with_refreshed_token_on_401(self):
        resp_401 = MagicMock()
        resp_401.status = 401

        resp_200 = MagicMock()
        resp_200.status = 200
        resp_200.json = AsyncMock(return_value={"accepted": 3, "duplicates": 0, "rejected": 0})

        mock_session = MagicMock()
        mock_session.post.return_value.__aenter__.side_effect = [resp_401, resp_200]

        client = DesktopCoordinatorClient("http://localhost:3000", "old-token", "worker-1", mock_session)
        # Mock _get_token to return new token on refresh
        def get_tok():
            return "refreshed-new-token" if mock_session.post.call_count >= 1 else "old-token"
        client._get_token = MagicMock(side_effect=get_tok)

        result = await client.ingest_batch("t-1", "lt-1", "b-1", [{"name": "Biz"}])
        self.assertIsNotNone(result)
        self.assertEqual(result["accepted"], 3)
        self.assertEqual(mock_session.post.call_count, 2)

    async def test_complete_task_success(self):
        resp = MagicMock()
        resp.status = 200
        resp.json = AsyncMock(return_value={"status": "completed", "planDrained": True})

        mock_session = MagicMock()
        mock_session.post.return_value.__aenter__.return_value = resp

        client = DesktopCoordinatorClient("http://localhost:3000", "jwt-token", "worker-1", mock_session)
        ok = await client.complete_task("t-1", "lt-1", "completed", discovered=10, accepted=10)
        self.assertTrue(ok)


class TestPathAndEnvironmentSafety(unittest.TestCase):
    def test_paths_with_spaces_in_data_dir(self):
        with tempfile.TemporaryDirectory(prefix="Path With Spaces_") as space_dir:
            with patch.dict(os.environ, {"LOCALAPPDATA": space_dir}):
                data_dir = get_desktop_data_dir()
                self.assertTrue(data_dir.exists())
                self.assertIn("Path With Spaces", str(data_dir))
                cache_file = data_dir / "cache" / "test.db"
                cache_file.parent.mkdir(parents=True, exist_ok=True)
                cache_file.write_text("sqlite placeholder")
                self.assertTrue(cache_file.exists())


if __name__ == "__main__":
    unittest.main()
