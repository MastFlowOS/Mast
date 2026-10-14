"""Deterministic characterization tests for utils.runtime.RateLimiter.

These pin the limiter's ACTUAL timing behavior, measured under a fake clock
(no real sleeping, jitter disabled), so a future change to the limiter is a
conscious decision with a visible throughput consequence.

IMPORTANT - read before "fixing" anything here:
  Characterization 2/3 document that the sustained rate is ~2x the declared
  requests_per_minute, because `_last` is set to `now` BEFORE the wait-sleep
  and `_tokens` is zeroed afterwards without refreshing `_last`; the next
  call therefore credits the slept interval as a second refill. Production
  Maps/site pacing has been running with this behavior. Correcting it would
  HALVE effective Maps/site request pacing and slow discovery; loosening it
  would raise Google anti-bot risk. Either is a product decision, not a
  bug-fix, which is why these tests assert the current behavior explicitly.
"""
from __future__ import annotations

import asyncio
import types

import pytest

import utils.runtime as rt

_REAL_SLEEP = asyncio.sleep


class _Clock:
    def __init__(self) -> None:
        self.t = 0.0


@pytest.fixture()
def clock(monkeypatch):
    c = _Clock()
    monkeypatch.setattr(
        rt, "time",
        types.SimpleNamespace(monotonic=lambda: c.t, time=lambda: c.t,
                              perf_counter=lambda: c.t),
    )
    state = {"active": 0, "max_active": 0, "sleeps": []}

    async def fake_sleep(d: float) -> None:
        state["active"] += 1
        state["max_active"] = max(state["max_active"], state["active"])
        state["sleeps"].append(d)
        await _REAL_SLEEP(0)          # yield so concurrent callers can interleave
        c.t += d
        state["active"] -= 1

    monkeypatch.setattr(rt, "asyncio",
                        types.SimpleNamespace(Lock=asyncio.Lock, sleep=fake_sleep))
    c.state = state
    return c


def _limiter(rpm: int, burst: int, min_delay_ms: int):
    return rt.RateLimiter(requests_per_minute=rpm, burst=burst,
                          jitter_pct=0, min_delay_ms=min_delay_ms)


async def _stamps(clock, lim, n):
    out = []
    for _ in range(n):
        await lim.acquire("t")
        out.append(clock.t)
    return out


@pytest.mark.asyncio
async def test_burst_requests_are_not_delayed(clock):
    stamps = await _stamps(clock, _limiter(20, 3, 800), 3)
    assert stamps == [0.0, 0.0, 0.0]


@pytest.mark.asyncio
async def test_first_post_burst_request_waits_one_declared_interval(clock):
    # 20 rpm => one token every 3.0s.
    stamps = await _stamps(clock, _limiter(20, 3, 800), 4)
    assert stamps[3] - stamps[2] == pytest.approx(3.0)


@pytest.mark.asyncio
async def test_CURRENT_post_burst_gaps_alternate_full_interval_then_zero(clock):
    """Characterization of the double-credit quirk (see module docstring)."""
    stamps = await _stamps(clock, _limiter(20, 3, 800), 11)
    gaps = [round(b - a, 6) for a, b in zip(stamps, stamps[1:])]
    assert gaps[2:10] == [3.0, 0.0, 3.0, 0.0, 3.0, 0.0, 3.0, 0.0]


@pytest.mark.asyncio
@pytest.mark.parametrize("rpm,burst,min_delay_ms", [(20, 3, 800), (30, 5, 400)])
async def test_CURRENT_sustained_rate_is_double_the_declared_rate(clock, rpm, burst, min_delay_ms):
    n = 61
    stamps = await _stamps(clock, _limiter(rpm, burst, min_delay_ms), n)
    post = n - burst
    span = stamps[-1] - stamps[burst - 1]
    effective_rpm = post / span * 60.0
    assert effective_rpm == pytest.approx(2 * rpm, rel=0.06)


@pytest.mark.asyncio
async def test_CURRENT_waiting_caller_holds_the_lock_so_waits_never_overlap(clock):
    """Concurrent callers are fully serialized behind the sleeping one."""
    lim = _limiter(20, 1, 800)
    await asyncio.gather(*[lim.acquire("t") for _ in range(6)])
    assert clock.state["max_active"] == 1
    assert len(clock.state["sleeps"]) >= 2


@pytest.mark.asyncio
async def test_jitter_never_goes_below_min_delay_floor(monkeypatch, clock):
    lim = rt.RateLimiter(requests_per_minute=600, burst=1, jitter_pct=0.2,
                         min_delay_ms=800)
    for _ in range(20):
        await lim.acquire("t")
    assert clock.state["sleeps"], "expected at least one throttled wait"
    assert min(clock.state["sleeps"]) >= 0.8 - 1e-9
