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
                while len([line for line in out.getvalue().splitlines() if line.strip() and not line.startswith("{'__done__'")]) < 5:
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
                while len([line for line in out.getvalue().splitlines() if line.strip() and not line.startswith("{'__done__'")]) < 2:
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

