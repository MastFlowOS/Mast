"""
Phase 1A — focused tests for LeadAcceptanceGate (engine/acceptance.py),
the authoritative requested/accepted/target-reached state for a single
discovery request.

Does NOT touch service.py's run_query(), a browser, Supabase, or the
Node/Postgres `claim_discovery_delivery` path at all — per this phase's
explicit "do not redesign" instruction, these tests exercise only the new
gate primitive in isolation, the same narrow-scope pattern
test_google_maps_provider_should_stop.py already uses for a different
Phase 1A-era addition.

Run: pytest tests/test_lead_acceptance_gate.py -v
"""

from __future__ import annotations

import os
import sys
import threading

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

from engine.acceptance import AcceptanceSnapshot, LeadAcceptanceGate


class TestUnderTarget:
    """Test A — accepting fewer leads than requested must not flip
    target_reached."""

    def test_five_of_ten_leaves_target_not_reached(self):
        gate = LeadAcceptanceGate(requested=10)

        for _ in range(5):
            assert gate.try_accept_lead() is True

        assert gate.accepted == 5
        assert gate.requested == 10
        assert gate.target_reached is False


class TestExactTarget:
    """Test B — accepting exactly the requested count must flip
    target_reached on the accept that reaches it."""

    def test_ten_of_ten_reaches_target(self):
        gate = LeadAcceptanceGate(requested=10)

        results = [gate.try_accept_lead() for _ in range(10)]

        assert all(results)
        assert gate.accepted == 10
        assert gate.target_reached is True

    def test_target_reached_flips_on_the_accepting_call_itself(self):
        # The spec requires target_reached to become true "immediately
        # when accepted reaches requested" — i.e. observable right after
        # the 10th try_accept_lead() call returns, not only on some later
        # 11th attempt.
        gate = LeadAcceptanceGate(requested=3)
        gate.try_accept_lead()
        gate.try_accept_lead()
        assert gate.target_reached is False
        accepted = gate.try_accept_lead()
        assert accepted is True
        assert gate.target_reached is True


class TestOverTarget:
    """Test C — attempting to accept beyond the requested count must
    reject the overflow attempt(s) and never let accepted exceed
    requested."""

    def test_eleventh_of_ten_is_rejected(self):
        gate = LeadAcceptanceGate(requested=10)

        results = [gate.try_accept_lead() for _ in range(11)]

        assert results[:10] == [True] * 10
        assert results[10] is False
        assert gate.accepted == 10
        assert gate.target_reached is True

    def test_accepted_never_exceeds_requested_under_repeated_overflow(self):
        gate = LeadAcceptanceGate(requested=10)
        for _ in range(10):
            gate.try_accept_lead()

        # Hammer it with more rejected attempts than the first overflow
        # test does, to make sure repeated post-target calls stay inert.
        for _ in range(50):
            assert gate.try_accept_lead() is False

        assert gate.accepted == 10
        assert gate.accepted <= gate.requested
        assert gate.target_reached is True


class TestConcurrentAcceptance:
    """Test D (mandatory) — simulate multiple threads racing to accept
    leads when fewer slots remain than attempts, and assert the gate
    never over-accepts no matter the interleaving."""

    def test_five_concurrent_attempts_with_two_remaining_slots(self):
        gate = LeadAcceptanceGate(requested=10)
        # Pre-fill to 8/10 accepted, exactly as the spec's example does,
        # so only 2 slots remain for the 5 concurrent attempts below.
        for _ in range(8):
            assert gate.try_accept_lead() is True
        assert gate.accepted == 8
        assert gate.target_reached is False

        barrier = threading.Barrier(5)
        results: list[bool] = [None] * 5  # type: ignore[list-item]

        def worker(idx: int) -> None:
            # Barrier forces all 5 threads to call try_accept_lead() as
            # close to simultaneously as possible, maximizing the chance
            # of exposing a race if the gate's lock were missing/broken.
            barrier.wait()
            results[idx] = gate.try_accept_lead()

        threads = [threading.Thread(target=worker, args=(i,)) for i in range(5)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()

        accepted_count = sum(1 for r in results if r is True)
        rejected_count = sum(1 for r in results if r is False)

        assert accepted_count == 2
        assert rejected_count == 3
        assert gate.accepted == 10
        assert gate.accepted <= gate.requested
        assert gate.target_reached is True

    def test_many_threads_racing_from_zero_never_over_accept(self):
        # Broader stress variant: 50 threads, only 10 slots, starting from
        # an empty gate — same invariant (accepted never exceeds
        # requested, exactly `requested` accepts succeed) under heavier
        # contention and a different starting point than the spec's own
        # example.
        requested = 10
        attempts = 50
        gate = LeadAcceptanceGate(requested=requested)
        barrier = threading.Barrier(attempts)
        results: list[bool] = [None] * attempts  # type: ignore[list-item]

        def worker(idx: int) -> None:
            barrier.wait()
            results[idx] = gate.try_accept_lead()

        threads = [threading.Thread(target=worker, args=(i,)) for i in range(attempts)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()

        accepted_count = sum(1 for r in results if r is True)
        rejected_count = sum(1 for r in results if r is False)

        assert accepted_count == requested
        assert rejected_count == attempts - requested
        assert gate.accepted == requested
        assert gate.target_reached is True


class TestSnapshotAndEdgeCases:
    """Supporting coverage beyond the four required scenarios: the
    consistent-read snapshot helper and the requested=0 degenerate case
    the spec's pseudocode implies but doesn't spell out."""

    def test_snapshot_reflects_current_state_consistently(self):
        gate = LeadAcceptanceGate(requested=4)
        gate.try_accept_lead()
        gate.try_accept_lead()

        snap = gate.snapshot()

        assert isinstance(snap, AcceptanceSnapshot)
        assert snap.requested == 4
        assert snap.accepted == 2
        assert snap.target_reached is False

    def test_requested_zero_is_already_target_reached(self):
        gate = LeadAcceptanceGate(requested=0)

        assert gate.target_reached is True
        assert gate.try_accept_lead() is False
        assert gate.accepted == 0

    def test_negative_requested_is_rejected_at_construction(self):
        import pytest

        with pytest.raises(ValueError):
            LeadAcceptanceGate(requested=-1)
