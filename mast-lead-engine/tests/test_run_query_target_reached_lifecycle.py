"""
PHASE 1B — target-reached stop propagation, exercised through the real
`service.run_query()` entrypoint (discovery_only=True branch — the
simplest of run_query()'s two branches, chosen so these tests hit the
actual production code path being fixed in this phase rather than a
reimplementation of it, without requiring Supabase/the full seven-stage
pipeline the way the production branch would — see
validate_service_run_query.py for that heavier harness).

Every test here substitutes exactly one thing: `service.GoogleMapsProvider`
(a module-level name run_query() looks up at call time, so this is a test
seam, not a code change) with a small fake whose `discover()` honors
`request.should_stop` the same way the real GoogleMapsProvider does (see
providers/google_maps_provider.py — already covered in isolation by
tests/test_google_maps_provider_should_stop.py). This lets these tests
verify the OTHER half: that run_query() itself — LeadAcceptanceGate,
`_should_stop_discovery`, the `while not gate.target_reached` loop — wires
up to that provider-level contract correctly, end to end.

Run: pytest tests/test_run_query_target_reached_lifecycle.py -v
"""

from __future__ import annotations

import asyncio
import json
import os
import sys
import time

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

import service
from engine.contracts import BusinessCandidate
from exceptions import DiscoveryFailure, DiscoveryFailureReason


def _candidate(i: int, session_id: str) -> BusinessCandidate:
    return BusinessCandidate(
        pipeline_id=f"pid-{i}",
        session_id=session_id,
        provider="google_maps",
        name=f"Business {i}",
        category="Coffee Shop",
        address="123 Main St",
        city="New York",
        country="US",
        website=None,
        phone=None,
        rating=4.5,
        review_count=10,
    )


class _CountingFakeProvider:
    """Stands in for GoogleMapsProvider: yields candidates one at a time,
    honoring `request.should_stop` exactly like the real provider (checked
    AFTER each yield, never before), and records how many candidates were
    actually pulled so tests can assert no extra discovery work happened
    once the target was reached."""

    def __init__(self, *, supply: int | None = 1_000_000) -> None:
        # `supply=None` behaves like an inexhaustible provider (Test A/E);
        # a finite int simulates genuine exhaustion (Test F).
        self.supply = supply
        self.pulled = 0
        self.aborted_early = False

    def discover(self, request):
        # `discovery_only`'s consumer thread reads through a bounded
        # (maxsize=10) queue with its own drain-on-exit cleanup (see
        # service.py's run_query, discovery_only branch) — a real
        # provider naturally paces itself with await'd Playwright/network
        # waits between candidates, giving the consumer thread frequent
        # chances to interleave and stop the race at exactly the target.
        # This tiny real sleep (the discover() call itself runs on a
        # plain OS thread here, not the event loop, so it must be a
        # blocking sleep, not asyncio.sleep) reproduces that pacing
        # instead of hammering the queue faster than any real provider
        # ever could — it does not change what's being tested, only how
        # realistically the race is modeled.
        limit = self.supply if self.supply is not None else float("inf")
        i = 0
        while i < limit:
            if request.should_stop is not None and request.should_stop():
                self.aborted_early = True
                return
            i += 1
            self.pulled += 1
            yield _candidate(i, request.session_id)
            time.sleep(0.01)
            if request.should_stop is not None and request.should_stop():
                self.aborted_early = True
                return


class _FailingFakeProvider:
    """Test G: yields a couple of candidates, then raises a genuine
    DiscoveryFailure — must propagate out of run_query() unchanged, never
    silently swallowed or reclassified as exhaustion."""

    def __init__(self) -> None:
        self.pulled = 0

    def discover(self, request):
        for i in range(1, 3):
            self.pulled += 1
            yield _candidate(i, request.session_id)
        raise DiscoveryFailure(DiscoveryFailureReason.SCRAPER_ERROR, "simulated scraper crash")


async def _drain(agen):
    return [lead async for lead in agen]


class TestTargetReachedStopsDiscovery:
    """Test A — once `requested` leads have been accepted, no additional
    discovery work is pulled from the provider."""

    @pytest.mark.asyncio
    async def test_stops_pulling_once_target_reached(self, monkeypatch, tmp_path):
        fake_provider = _CountingFakeProvider(supply=None)  # would run forever if not stopped
        monkeypatch.setattr(service, "GoogleMapsProvider", lambda: fake_provider)

        leads = await _drain(service.run_query(
            query="coffee", city="New York", deliver_target=5,
            discovery_only=True, db_path=str(tmp_path / "leads.db"),
        ))

        assert len(leads) == 5, "exactly `deliver_target` leads must be yielded, never more"
        assert fake_provider.pulled == 5, (
            "the provider must not be asked for a 6th candidate once the "
            "5th has already been accepted — pulling more than requested "
            "is exactly the bug this phase fixes"
        )
        # Not asserting `aborted_early` here: because the 5th (target-
        # reaching) candidate is the LAST one this provider ever produces
        # in this run, the consumer's own loop condition
        # (`while not gate.target_reached`) already stops it from ever
        # asking for a 6th — the provider-side should_stop() check after a
        # yield (exercised directly by
        # tests/test_google_maps_provider_should_stop.py, and by
        # TestExhaustionRemainsDistinct/TestScraperFailureRemainsDistinct
        # below via `pulled`) never even gets a chance to fire, which is a
        # strictly better outcome than needing it to.


class TestInFlightLeadPreserved:
    """Test E — the lead that actually reaches the target must not be
    lost: accepted == requested, and every accepted lead was yielded."""

    @pytest.mark.asyncio
    async def test_final_accepted_lead_is_not_dropped(self, monkeypatch, tmp_path):
        fake_provider = _CountingFakeProvider(supply=None)
        monkeypatch.setattr(service, "GoogleMapsProvider", lambda: fake_provider)

        leads = await _drain(service.run_query(
            query="coffee", city="New York", deliver_target=1,
            discovery_only=True, db_path=str(tmp_path / "leads.db"),
        ))

        assert [l["name"] for l in leads] == ["Business 1"]


class TestExhaustionRemainsDistinct:
    """Test F — genuine exhaustion (provider runs out before `requested`
    is reached) must not look like an error, and must simply yield fewer
    leads than requested — run_query() itself doesn't emit the
    target_reached/exhausted booleans (that's _main_cli's job), so this
    test asserts the behavior _main_cli's classification depends on:
    fewer leads than requested, no exception raised."""

    @pytest.mark.asyncio
    async def test_fewer_leads_than_requested_when_provider_exhausted(self, monkeypatch, tmp_path):
        fake_provider = _CountingFakeProvider(supply=4)  # only 4 usable candidates exist
        monkeypatch.setattr(service, "GoogleMapsProvider", lambda: fake_provider)

        leads = await _drain(service.run_query(
            query="coffee", city="New York", deliver_target=10,
            discovery_only=True, db_path=str(tmp_path / "leads.db"),
        ))

        assert len(leads) == 4
        assert fake_provider.pulled == 4
        assert fake_provider.aborted_early is False, (
            "should_stop() must never have reported true — this run ended "
            "because the provider ran out, not because the target was hit"
        )


class TestScraperFailureRemainsDistinct:
    """Test G — a genuine DiscoveryFailure must propagate out of
    run_query() unchanged, exactly like before this phase; target-reached
    handling must not intercept or reclassify it."""

    @pytest.mark.asyncio
    async def test_discovery_failure_propagates(self, monkeypatch, tmp_path):
        fake_provider = _FailingFakeProvider()
        monkeypatch.setattr(service, "GoogleMapsProvider", lambda: fake_provider)

        leads = []
        with pytest.raises(DiscoveryFailure) as excinfo:
            async for lead in service.run_query(
                query="coffee", city="New York", deliver_target=10,
                discovery_only=True, db_path=str(tmp_path / "leads.db"),
            ):
                leads.append(lead)

        assert excinfo.value.reason == DiscoveryFailureReason.SCRAPER_ERROR
        # The 2 leads yielded before the failure are still real and must
        # not be discarded — run_query() is a generator, so they were
        # already delivered to this test's `async for` before the raise.
        assert len(leads) == 2


class TestDeliverTargetDecoupledFromMaxResults:
    """PHASE 5 — target-aware discovery stopping (Node/Python contract
    regression test).

    Before this phase, poolExpandJob.ts never sent `deliver_target` at
    all, so Python's own fallback (`_deliver_target = deliver_target if
    deliver_target is not None else max_results`) silently made the
    QUALIFIED-lead stopping target equal to the generous RAW SCAN BUDGET
    (`max_results`/`askFor`) instead of the caller's real, much smaller,
    per-round need. This is exactly why hundreds of raw Maps candidates
    kept getting pulled long after enough qualified leads already existed
    for that round — the discovery loop's own `_should_stop_discovery()`
    literally didn't know the true target was that much smaller.

    This test reproduces the production parameter shape directly: a large
    `max_results` (mirrors `askFor = streamTarget * 4`) alongside a small,
    EXPLICIT `deliver_target` (mirrors `streamTarget`) — proving that once
    both are passed (the fix), the small `deliver_target` — not the large
    `max_results` — is what governs when `should_stop()`/the provider
    genuinely stops pulling candidates.
    """

    @pytest.mark.asyncio
    async def test_large_max_results_does_not_defeat_small_deliver_target(self, monkeypatch, tmp_path):
        # Mirrors production: askFor = max(streamTarget * 4, streamTarget)
        # for a streamTarget of 5 → askFor = 20. An inexhaustible fake
        # provider stands in for "hundreds of candidates available" so
        # nothing except deliver_target can be the reason this stops early.
        fake_provider = _CountingFakeProvider(supply=None)
        monkeypatch.setattr(service, "GoogleMapsProvider", lambda: fake_provider)

        stream_target = 5
        ask_for = max(stream_target * 4, stream_target)  # 20 — the generous scan budget
        assert ask_for > stream_target, "test is only meaningful if max_results is genuinely larger"

        leads = await _drain(service.run_query(
            query="coffee", city="New York",
            max_results=ask_for, deliver_target=stream_target,
            discovery_only=True, db_path=str(tmp_path / "leads_decoupled.db"),
        ))

        assert len(leads) == stream_target, (
            "must stop at the small deliver_target, never scale up to the "
            "larger max_results scan budget"
        )
        assert fake_provider.pulled == stream_target, (
            f"provider was pulled {fake_provider.pulled} times for a "
            f"deliver_target of {stream_target} with max_results={ask_for} "
            "available — any excess here is exactly the wasted post-target "
            "Maps discovery this phase eliminates"
        )

    @pytest.mark.asyncio
    async def test_missing_deliver_target_falls_back_to_max_results_old_behavior(self, monkeypatch, tmp_path):
        # Documents the OLD (pre-fix) behavior this phase moved away from:
        # when a caller omits deliver_target entirely (exactly what
        # poolExpandJob.ts used to do), Python's fallback makes the scan
        # budget itself the stopping target — i.e. it happily scans all
        # the way up to max_results, not the caller's true smaller need.
        # This is not a bug in service.py (the fallback is intentional
        # backward compatibility, documented in service.py's own
        # docstring) — it is a regression guard proving the CALLER
        # (poolExpandJob.ts) is what must supply deliver_target for the
        # fix to take effect.
        fake_provider = _CountingFakeProvider(supply=None)
        monkeypatch.setattr(service, "GoogleMapsProvider", lambda: fake_provider)

        leads = await _drain(service.run_query(
            query="coffee", city="New York",
            max_results=20,  # no deliver_target passed at all
            discovery_only=True, db_path=str(tmp_path / "leads_no_target.db"),
        ))

        assert len(leads) == 20, (
            "with no deliver_target, the engine correctly falls back to "
            "max_results as its own stopping target — this is the exact "
            "over-scan poolExpandJob.ts's missing deliver_target caused "
            "in production before this phase's fix"
        )


class TestShutdownEventAlsoStopsDiscovery:
    """The other half of `_should_stop_discovery()` — a cooperative
    shutdown request must stop discovery exactly like target_reached
    does, even if the target has not been reached yet."""

    @pytest.mark.asyncio
    async def test_shutdown_event_stops_discovery_before_target(self, monkeypatch, tmp_path):
        import threading

        fake_provider = _CountingFakeProvider(supply=None)
        monkeypatch.setattr(service, "GoogleMapsProvider", lambda: fake_provider)

        shutdown_event = threading.Event()

        async def _consume():
            leads = []
            try:
                async for lead in service.run_query(
                    query="coffee", city="New York", deliver_target=1000,
                    discovery_only=True, db_path=str(tmp_path / "leads.db"),
                    shutdown_event=shutdown_event,
                ):
                    leads.append(lead)
                    if len(leads) == 3:
                        shutdown_event.set()
            except DiscoveryFailure as exc:
                assert exc.reason == DiscoveryFailureReason.CANCELLED
            return leads

        leads = await _consume()

        assert len(leads) == 3, "shutdown_event.set() must stop discovery well short of deliver_target=1000"


class TestTargetReachedShutdownSemantics:
    """Cooperative shutdown with TARGET_REACHED signaled by parent must complete as
    a successful early stop with success=True, target_reached=True, and
    termination_reason=SUCCESS_TARGET_REACHED."""

    @pytest.mark.asyncio
    async def test_target_reached_shutdown_produces_success_and_target_reached(self, monkeypatch, tmp_path):
        import threading
        import io

        fake_provider = _CountingFakeProvider(supply=None)
        monkeypatch.setattr(service, "GoogleMapsProvider", lambda: fake_provider)

        shutdown_event = threading.Event()
        service._set_shutdown_reason("TARGET_REACHED")

        try:
            leads = []
            async for lead in service.run_query(
                query="coffee", city="New York", deliver_target=20,
                discovery_only=True, db_path=str(tmp_path / "leads.db"),
                shutdown_event=shutdown_event,
                shutdown_reason="TARGET_REACHED",
            ):
                leads.append(lead)
                if len(leads) == 5:
                    shutdown_event.set()

            assert len(leads) == 5

            # Also exercise _main_cli with TARGET_REACHED stop reason
            service._set_shutdown_reason("TARGET_REACHED")
            monkeypatch.setattr(sys, "argv", ["service.py", json.dumps({"query": "coffee", "city": "New York", "deliver_target": 20, "discovery_only": True, "db_path": str(tmp_path / "leads2.db")})])
            out = io.StringIO()
            monkeypatch.setattr(sys, "stdout", out)

            # Set shutdown event after 5 leads in background
            def _stop_after_5():
                while len([line for line in out.getvalue().splitlines() if line.strip() and '"__done__"' not in line and '"progress"' not in line]) < 5:
                    time.sleep(0.01)
                service._shutdown_event.set()

            threading.Thread(target=_stop_after_5, daemon=True).start()
            await service._main_cli()

            lines = [json.loads(l) for l in out.getvalue().splitlines() if l.strip()]
            done_line = next((l for l in lines if l.get("__done__")), None)
            assert done_line is not None
            assert done_line["delivered"] == 5
            assert done_line["requested"] == 20
            assert done_line["success"] is True
            assert done_line["target_reached"] is True
            assert done_line["termination_reason"] == "SUCCESS_TARGET_REACHED"
            assert done_line["failure_reason"] is None
            assert done_line["exhausted"] is False
        finally:
            service._set_shutdown_reason(None)
            service._shutdown_event.clear()

    @pytest.mark.asyncio
    async def test_user_cancelled_shutdown_produces_cancelled_done(self, monkeypatch, tmp_path):
        import threading
        import io

        fake_provider = _CountingFakeProvider(supply=None)
        monkeypatch.setattr(service, "GoogleMapsProvider", lambda: fake_provider)

        shutdown_event = threading.Event()
        service._set_shutdown_reason("USER_CANCELLED")

        try:
            monkeypatch.setattr(sys, "argv", ["service.py", json.dumps({"query": "coffee", "city": "New York", "deliver_target": 20, "discovery_only": True, "db_path": str(tmp_path / "leads3.db")})])
            out = io.StringIO()
            monkeypatch.setattr(sys, "stdout", out)

            def _stop_after_2():
                while len([line for line in out.getvalue().splitlines() if line.strip() and '"__done__"' not in line and '"progress"' not in line]) < 2:
                    time.sleep(0.01)
                service._shutdown_event.set()

            threading.Thread(target=_stop_after_2, daemon=True).start()
            await service._main_cli()

            lines = [json.loads(l) for l in out.getvalue().splitlines() if l.strip()]
            done_line = next((l for l in lines if l.get("__done__")), None)
            assert done_line is not None
            assert done_line["delivered"] == 2
            assert done_line["requested"] == 20
            assert done_line["success"] is False
            assert done_line["target_reached"] is False
            assert done_line["termination_reason"] == "CANCELLED"
            assert done_line["failure_reason"] == "CANCELLED"
        finally:
            service._set_shutdown_reason(None)
            service._shutdown_event.clear()


class TestConsumerStoppedShutdownSemantics:
    """
    FINAL SHUTDOWN LATENCY + CONSUMER_STOPPED FIX — item 1: a plain
    CONSUMER_STOPPED SIGTERM (the Node bridge's own consumer breaking out
    early — e.g. area rotation hitting its streaming batch quota) must be
    treated as a successful non-failure termination, exactly like
    TARGET_REACHED, but WITHOUT being reported as target_reached (the
    PARENT request's target was not necessarily met) or as exhausted (the
    search space did not genuinely run out).
    """

    @pytest.mark.asyncio
    async def test_consumer_stopped_shutdown_produces_success_without_target_reached(self, monkeypatch, tmp_path):
        import threading
        import io

        fake_provider = _CountingFakeProvider(supply=None)
        monkeypatch.setattr(service, "GoogleMapsProvider", lambda: fake_provider)

        shutdown_event = threading.Event()
        service._set_shutdown_reason("CONSUMER_STOPPED")

        try:
            leads = []
            async for lead in service.run_query(
                query="coffee", city="New York", deliver_target=20,
                discovery_only=True, db_path=str(tmp_path / "leads_consumer_stopped.db"),
                shutdown_event=shutdown_event,
                shutdown_reason="CONSUMER_STOPPED",
            ):
                leads.append(lead)
                if len(leads) == 5:
                    shutdown_event.set()

            assert len(leads) == 5

            # Also exercise _main_cli end-to-end with CONSUMER_STOPPED,
            # the same way the TARGET_REACHED/USER_CANCELLED tests above
            # do — this is the actual code path pythonBridge.ts's area
            # rotation SIGTERM drives in production.
            service._set_shutdown_reason("CONSUMER_STOPPED")
            monkeypatch.setattr(sys, "argv", ["service.py", json.dumps({"query": "coffee", "city": "New York", "deliver_target": 20, "discovery_only": True, "db_path": str(tmp_path / "leads_consumer_stopped2.db")})])
            out = io.StringIO()
            monkeypatch.setattr(sys, "stdout", out)

            def _stop_after_5():
                while len([line for line in out.getvalue().splitlines() if line.strip() and '"__done__"' not in line and '"progress"' not in line]) < 5:
                    time.sleep(0.01)
                service._shutdown_event.set()

            threading.Thread(target=_stop_after_5, daemon=True).start()
            await service._main_cli()

            lines = [json.loads(l) for l in out.getvalue().splitlines() if l.strip()]
            done_line = next((l for l in lines if l.get("__done__")), None)
            assert done_line is not None
            assert done_line["delivered"] == 5
            assert done_line["requested"] == 20
            # The core of this fix: success=True, never a CANCELLED failure.
            assert done_line["success"] is True
            assert done_line["failure_reason"] is None
            # Distinct from TARGET_REACHED: the parent's target was not
            # necessarily met, only this call's own batch was satisfied.
            assert done_line["target_reached"] is False
            assert done_line["termination_reason"] == "SUCCESS_CONSUMER_STOPPED"
            # Distinct from genuine exhaustion: the search space did not
            # actually run out, this run was just asked to stop early.
            assert done_line["exhausted"] is False
        finally:
            service._set_shutdown_reason(None)
            service._shutdown_event.clear()

    @pytest.mark.asyncio
    async def test_consumer_stopped_forced_cancellation_still_reports_success(self, monkeypatch, tmp_path):
        """
        Same CONSUMER_STOPPED reason, but exercised through the
        asyncio.CancelledError branch of `_main_cli` (i.e. the cooperative
        checkpoints didn't wind down in time and `_run_with_graceful_
        shutdown`'s escalation forced a `task.cancel()`) — the OTHER of
        the two places this fix touches, previously falling into the
        `else` branch and raising DiscoveryFailure(CANCELLED) exactly the
        same as the discovery_only/main branches above did.
        """
        import io

        service._set_shutdown_reason("CONSUMER_STOPPED")
        try:
            monkeypatch.setattr(sys, "argv", ["service.py", json.dumps({"query": "coffee", "city": "New York", "deliver_target": 20, "discovery_only": True, "db_path": str(tmp_path / "leads_forced.db")})])
            out = io.StringIO()
            monkeypatch.setattr(sys, "stdout", out)

            async def _raise_cancelled(**kwargs):
                raise asyncio.CancelledError()
                yield  # pragma: no cover - makes this an async generator

            monkeypatch.setattr(service, "run_query", _raise_cancelled)

            await service._main_cli()

            lines = [json.loads(l) for l in out.getvalue().splitlines() if l.strip()]
            done_line = next((l for l in lines if l.get("__done__")), None)
            assert done_line is not None
            assert done_line["success"] is True
            assert done_line["failure_reason"] is None
            assert done_line["target_reached"] is False
            assert done_line["termination_reason"] == "SUCCESS_CONSUMER_STOPPED"
            assert done_line["exhausted"] is False
        finally:
            service._set_shutdown_reason(None)
            service._shutdown_event.clear()


class TestFastTargetCleanupGracePeriod:
    """
    FINAL SHUTDOWN LATENCY + CONSUMER_STOPPED FIX — item 3: a SIGTERM
    whose reason means "no useful work remains" (TARGET_REACHED /
    CONSUMER_STOPPED) must escalate to forced cancellation on a much
    shorter fuse than a genuine watchdog/user-cancel SIGTERM, which still
    gets the full COOPERATIVE_SHUTDOWN_GRACE_S window to wind down
    in-flight work safely.
    """

    def test_grace_period_selection(self):
        assert service._shutdown_grace_period_s("TARGET_REACHED") == service.FAST_SHUTDOWN_GRACE_S
        assert service._shutdown_grace_period_s("CONSUMER_STOPPED") == service.FAST_SHUTDOWN_GRACE_S
        assert service._shutdown_grace_period_s("USER_CANCELLED") == service.COOPERATIVE_SHUTDOWN_GRACE_S
        assert service._shutdown_grace_period_s("WATCHDOG_TIMEOUT") == service.COOPERATIVE_SHUTDOWN_GRACE_S
        assert service._shutdown_grace_period_s(None) == service.COOPERATIVE_SHUTDOWN_GRACE_S
        # Sanity: the fast fuse really is shorter, not just a different value.
        assert service.FAST_SHUTDOWN_GRACE_S < service.COOPERATIVE_SHUTDOWN_GRACE_S

    @pytest.mark.skipif(sys.platform == "win32", reason="os.kill with SIGTERM terminates process on Windows")
    @pytest.mark.asyncio
    async def test_consumer_stopped_sigterm_escalates_on_the_fast_window(self, monkeypatch):
        import os
        import signal
        import tempfile

        # Shrink both windows (proportionally) so this test runs fast
        # while still proving CONSUMER_STOPPED uses the SHORT one.
        monkeypatch.setattr(service, "FAST_SHUTDOWN_GRACE_S", 0.05)
        monkeypatch.setattr(service, "COOPERATIVE_SHUTDOWN_GRACE_S", 1.0)

        async def _never_finishes_on_its_own():
            # Never checks _shutdown_event — forces this test down the
            # escalation (forced task.cancel()) path deterministically.
            await asyncio.sleep(100)

        # `_run_with_graceful_shutdown` resets the in-process shutdown
        # reason to None at entry (matching production: the reason is
        # meant to be discovered fresh from the stop-reason file/IPC when
        # SIGTERM actually arrives, not carried over from a previous run)
        # — so, like the real Node bridge, write the reason to the
        # stop-reason file this same PID's `_get_shutdown_reason()` reads,
        # rather than pre-seeding the in-process global.
        stop_file = os.path.join(tempfile.gettempdir(), f"mast_stop_{os.getpid()}.txt")
        with open(stop_file, "w", encoding="utf-8") as f:
            f.write("CONSUMER_STOPPED")
        try:
            start = time.monotonic()
            task = asyncio.ensure_future(service._run_with_graceful_shutdown(_never_finishes_on_its_own))
            await asyncio.sleep(0.01)  # let the signal handler register
            os.kill(os.getpid(), signal.SIGTERM)
            await task
            elapsed = time.monotonic() - start
            # Escalated on the FAST (0.05s) window, nowhere near the full
            # COOPERATIVE (1.0s) one this same reason used to always wait.
            assert elapsed < 0.5
        finally:
            service._set_shutdown_reason(None)
            try:
                os.remove(stop_file)
            except OSError:
                pass
