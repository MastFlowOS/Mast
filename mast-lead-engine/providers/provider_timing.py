"""
providers/provider_timing.py
=============================

Phase 2B — Discovery Wall-Clock Instrumentation: Composition-Root
Provider Timing Wrapper.

Responsibility
--------------
`TimedDiscoveryProvider` is a transparent `DiscoveryProviderInterface`
decorator that measures the REAL wall-clock time a wrapped provider's
own `discover()` generator is actively running — one authoritative
number per provider (`google_maps_total_ms`, `overpass_total_ms`),
independent of whatever internal sub-stage timers that provider may or
may not have wired up.

Why this is NOT "fabricated from stage totals" (Phase 2B Task 2's own
explicit instruction)
----------------------------------------------------------------------
`utils/perf.py:RunProfiler.area_sla_line()` already reports fields like
`maps_ms` as a *sum* of several named `StageTimer`s
(`playwright_startup` + `browser_startup` + `context_creation` +
`page_creation`). That sum is only as complete as the granular timers
that happen to exist — any real wall-clock time GoogleMapsProvider
spends that isn't wrapped in one of those named `with
profiler.timer(...)` blocks (e.g. `asyncio.new_event_loop()` overhead,
`agen.aclose()` teardown, Python-side list/dict work between awaits,
an unnamed micro-step someone forgets to instrument next quarter) is
invisible to that sum, silently making "the stages add up to the
total" an assumption rather than a measured fact.

`TimedDiscoveryProvider` measures something structurally different: it
times each individual `next()` pull directly off the wrapped
provider's *own* generator, at the outermost boundary the composition
root controls (see `discovery_composition.py::_construct_provider()`,
where this wrapper is applied — before any parallel/dedup/target-aware
wrapping). That interval is real, measured wall-clock time the CPU
spent inside the provider's `discover()` implementation, full stop,
with no dependency on how many (or how few) of that provider's
internal operations happen to be individually instrumented. It is a
black-box measurement of the whole, not a sum of labeled parts — which
is exactly what makes it useful as a cross-check against the internal
stage totals: if `google_maps_total_ms` and the sum of MapsScraper's
own named stage timers diverge by more than a little, that gap *is*
the amount of currently-uninstrumented work, a real finding rather
than noise.

Time strictly excludes whatever the caller (`DiscoveryWorker.process()`
via `item.on_candidate(candidate)`) does with each yielded candidate
in between pulls — the clock stops the instant a candidate is handed
back and resumes only once the next `next()` call is actually made.
This is what keeps `google_maps_total_ms` and `overpass_total_ms`
additive with each other (each provider is only "charged" for its own
active work) rather than double-counting downstream queueing/dedup
time that has nothing to do with either provider.

Delegates `provider_id` / `display_name` to the wrapped instance
unchanged, so every composition-root caller that inspects those
(`ParallelCompositeDiscoveryProvider`'s `on_provider_error` logging,
`ProviderDeduplicator`, the `[provider] <id> selected` log lines in
`discovery_composition.py`) sees no difference between a wrapped and
an unwrapped provider. `metadata()` / `capabilities()` are NOT
proxied — they are declared classmethods on
`DiscoveryProviderInterface` subclasses precisely so a caller can
inspect them *without* constructing an instance (see
`engine/interfaces.py` and `providers/google_maps_provider.py`'s own
`metadata()` docstring); a `TimedDiscoveryProvider` instance is never
the thing registered with `ProviderRegistry`, so this omission changes
nothing for that lookup path.

Status
------
Phase 2B (Discovery Wall-Clock Instrumentation). New file. Does not
modify `GoogleMapsProvider`, `OverpassProvider`, `ParallelCompositeDiscoveryProvider`,
`ProviderDeduplicator`, or `TargetAwareDiscoveryProvider` — this is a
pure, additive decorator applied once, at construction time, in
`discovery_composition.py::_construct_provider()`.
"""

from __future__ import annotations

import time
from typing import Any, Iterator, Optional

from engine.contracts import BusinessCandidate
from engine.interfaces import DiscoveryProviderInterface
from utils.perf import NullProfiler


class TimedDiscoveryProvider(DiscoveryProviderInterface):
    """
    Wraps `provider` so every `next()` pull off its `discover()`
    generator is individually timed and accumulated into
    `profiler` under `total_stage` (a `RunProfiler` stage name, read
    the same way any other stage is — `profiler._stages[total_stage]
    .total_ms` — by `area_sla_line()`/service.py's `__done__`
    sentinel).

    `total_stage` is required (not optional/defaulted) so a caller at
    the composition root must make an explicit choice about which
    provider's total this measures — no "generic provider_total" bucket
    that would silently merge Google Maps and Overpass time together
    when more than one provider is composed in parallel.
    """

    def __init__(
        self,
        provider: DiscoveryProviderInterface,
        *,
        profiler: Any = None,
        total_stage: str,
    ) -> None:
        self._provider = provider
        self._profiler = profiler if profiler is not None else NullProfiler()
        self._total_stage = total_stage

    @property
    def provider_id(self) -> str:
        return self._provider.provider_id

    @property
    def display_name(self) -> str:
        return self._provider.display_name

    def discover(self, request: Any) -> Iterator[BusinessCandidate]:
        """
        Times each `next()` pull individually — see module docstring,
        "Time strictly excludes...", for why this (rather than one
        timer wrapped around the whole `for candidate in
        provider.discover(request): ...` loop from OUTSIDE this class)
        is the only shape that measures the provider's own active time
        without also billing it for whatever the eventual consumer
        does with each candidate in between pulls.

        Any exception raised while pulling from the wrapped generator
        (including on the final, exhausting `next()` call) propagates
        unmodified after the in-flight interval is still recorded —
        the time spent discovering that the provider failed, or that
        it's genuinely exhausted, is itself real provider wall-clock
        time and is not thrown away just because the outcome wasn't a
        fresh candidate.
        """
        inner = self._provider.discover(request)
        while True:
            t0 = time.perf_counter()
            try:
                candidate = next(inner)
            except StopIteration:
                self._profiler.record_stage_duration(
                    self._total_stage, (time.perf_counter() - t0) * 1000.0
                )
                return
            except BaseException:
                self._profiler.record_stage_duration(
                    self._total_stage, (time.perf_counter() - t0) * 1000.0
                )
                raise
            self._profiler.record_stage_duration(
                self._total_stage, (time.perf_counter() - t0) * 1000.0
            )
            yield candidate


def wrap_with_timing(
    provider: DiscoveryProviderInterface,
    *,
    profiler: Any = None,
    total_stage: Optional[str] = None,
) -> DiscoveryProviderInterface:
    """
    Convenience used by `discovery_composition.py::_construct_provider()`:
    returns `provider` unwrapped when either `profiler` or
    `total_stage` is falsy/`None` (no-op — matches every other
    optional-instrumentation seam in this codebase, e.g.
    `MapsScraper(profiler=None)`), otherwise returns a
    `TimedDiscoveryProvider` wrapping it.
    """
    if profiler is None or not total_stage:
        return provider
    return TimedDiscoveryProvider(provider, profiler=profiler, total_stage=total_stage)
