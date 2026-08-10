"""
MAST Engine V2 — Lead Acceptance Gate
========================================

Phase 1A: authoritative target/acceptance state for a discovery request.

Problem this fixes
-------------------
Before this module, "how many leads have we delivered so far" lived as a
single, un-synchronized local variable (`delivered`) inside
`service.py::run_query()`. Every stop decision — the cooperative
`should_stop` check handed to `GoogleMapsDiscoveryRequest`, the per-pass
loop condition, the post-yield break — read and wrote that same bare int
directly. That happened to be safe only by accident, because exactly one
coroutine ever touched it. It gave no single, explicit place that answers
"has this request's target been reached" and "can one more lead still be
accepted" atomically, and it would silently stop being safe the moment a
second concurrent producer (a second provider, a second worker) started
writing to it too — see the module-level docstrings in engine/session.py
and engine/coordinator.py for the provider-parallelism work this is
explicitly *not* part of yet.

What this module is
--------------------
`LeadAcceptanceGate` is the one authoritative source of truth for a single
discovery request's:

    requested        — how many leads were asked for (fixed at construction)
    accepted         — how many have actually been accepted for delivery
    target_reached   — whether `accepted` has reached `requested`

It exposes exactly one mutating operation, `try_accept_lead()`, which
atomically checks-and-increments under a single `threading.Lock` — the
same primitive already used elsewhere in this codebase for shared
in-process state (see `EngineCoordinator._lock` in engine/coordinator.py).
This mirrors that existing pattern rather than inventing a new one.

What this module is NOT
------------------------
It does not decide *what* counts as an accepted/deliverable lead — that
semantic point is chosen by the caller (see service.py::run_query(), which
constructs one gate per run and calls `try_accept_lead()` at the existing
"a lead is about to be yielded to the caller" point, both in the
discovery-only branch and the full-pipeline branch). It does not talk to
Maps, Supabase, or any queue. It does not replace `RunStats` (rejection
bookkeeping) or `PipelineTracer` (per-business trace state) — those track
different, non-competing things. It does not itself stop a running Maps
scrape; `GoogleMapsDiscoveryRequest.should_stop` (already wired in
service.py) is what a caller uses this gate's `target_reached` to answer.
"""

from __future__ import annotations

import threading
from dataclasses import dataclass


@dataclass(frozen=True)
class AcceptanceSnapshot:
    """Point-in-time, consistent read of a LeadAcceptanceGate's three
    fields, taken under the gate's lock. Use this (rather than reading
    `.accepted` and `.target_reached` as two separate property accesses)
    when a caller needs both values to agree with each other, e.g. for
    logging or a __done__ sentinel."""

    requested: int
    accepted: int
    target_reached: bool


class LeadAcceptanceGate:
    """
    Race-safe requested/accepted/target-reached state for one discovery
    request. One instance per `run_query()` call — not shared across
    requests, not persisted.

    Usage (mirrors the pseudocode in the Phase 1A spec):

        gate = LeadAcceptanceGate(requested=deliver_target)
        ...
        if gate.try_accept_lead():
            yield lead_dict
            if gate.target_reached:
                break
        else:
            # Target was already reached by the time this candidate
            # cleared validation — do not count or yield it.
            continue
    """

    __slots__ = ("_requested", "_accepted", "_target_reached", "_lock")

    def __init__(self, requested: int) -> None:
        if requested < 0:
            raise ValueError(
                f"LeadAcceptanceGate: requested must be >= 0, got {requested!r}"
            )
        self._requested = requested
        self._accepted = 0
        self._lock = threading.Lock()
        # A request for 0 leads is a degenerate but legal case: the target
        # is already reached before any lead is ever considered.
        self._target_reached = requested <= 0

    @property
    def requested(self) -> int:
        """Fixed for the lifetime of this gate — never mutated."""
        return self._requested

    @property
    def accepted(self) -> int:
        with self._lock:
            return self._accepted

    @property
    def target_reached(self) -> bool:
        with self._lock:
            return self._target_reached

    def try_accept_lead(self) -> bool:
        """
        Atomically attempt to accept exactly one lead against `requested`.

        Returns True and increments `accepted` if there was remaining
        capacity; returns False (and leaves `accepted` unchanged) if the
        target had already been reached. Marks `target_reached` the
        instant `accepted` reaches `requested` — including on the accept
        that reaches it, and on every retry attempted after it — so a
        caller never needs to re-derive "am I done" from any other
        counter. Idempotent per call: calling this once decides the fate
        of exactly one lead; callers are responsible for not calling it
        more than once per lead (service.py's own dedup — fingerprints /
        the existing `leads` unique index downstream — is unaffected and
        unchanged by this gate).
        """
        with self._lock:
            if self._accepted >= self._requested:
                self._target_reached = True
                return False

            self._accepted += 1

            if self._accepted >= self._requested:
                self._target_reached = True

            return True

    def snapshot(self) -> AcceptanceSnapshot:
        """Consistent read of all three fields taken under one lock
        acquisition — see AcceptanceSnapshot's docstring for why this
        differs from reading the properties individually."""
        with self._lock:
            return AcceptanceSnapshot(
                requested=self._requested,
                accepted=self._accepted,
                target_reached=self._target_reached,
            )
