"""
Mast Lead Engine — Performance Profiler (Phase 2 instrumentation).

Lightweight, zero-dependency, zero-behaviour-change timing module.

Usage::

    from utils.perf import RunProfiler

    profiler = RunProfiler()

    # Time a stage
    async with profiler.timer("site_crawl"):
        result = await crawl(url)

    # Record a single timestamp event
    profiler.mark("browser_startup_done")

    # Record a rejection with elapsed enrichment time so far
    profiler.record_rejection(business_name="Foo Bar", reason="viability:no_channels",
                              elapsed_ms=profiler.elapsed_since_business_start_ms())

    # At the end of the run
    profiler.print_report(query="yoga studios", city="Austin",
                          delivered=12, discovered=38)
    perf_dict = profiler.summary()   # embed in __done__ sentinel

Design constraints:
  - No numpy, no third-party packages
  - Percentiles via bisect.insort (O(log n) insert, O(1) index read)
  - Thread/async safe: each stage accumulates into its own StageTimer list
  - All timing uses time.perf_counter() — monotonic, nanosecond resolution
  - Per-business detail stored in memory; printed only if MAST_PERF_VERBOSE=1
"""

from __future__ import annotations

import bisect
import contextlib
import os
import time
from collections import defaultdict
from dataclasses import dataclass, field
from typing import Any, Generator

from utils.lifecycle_tracker import (
    active_browsers,
    active_contexts,
    active_pages,
    get_memory_usage,
)


# ──────────────────────────────────────────────────────────────────────────────
# StageTimer — collects samples for a single named stage
# ──────────────────────────────────────────────────────────────────────────────

class StageTimer:
    """Collects elapsed-ms samples for a named pipeline stage."""

    __slots__ = ("_sorted_ms",)

    def __init__(self) -> None:
        # Keep sorted at all times so percentiles are O(1) index reads.
        self._sorted_ms: list[float] = []

    def record(self, elapsed_ms: float) -> None:
        bisect.insort(self._sorted_ms, elapsed_ms)

    @property
    def count(self) -> int:
        return len(self._sorted_ms)

    @property
    def total_ms(self) -> float:
        return sum(self._sorted_ms)

    def _percentile(self, pct: float) -> float | None:
        """Return the p-th percentile (0–100) or None if no samples."""
        if not self._sorted_ms:
            return None
        idx = max(0, int(len(self._sorted_ms) * pct / 100) - 1)
        return self._sorted_ms[min(idx, len(self._sorted_ms) - 1)]

    def stats(self) -> dict:
        """Return a full statistics dict for this stage."""
        if not self._sorted_ms:
            return {"count": 0, "total_ms": 0.0, "avg_ms": None,
                    "min_ms": None, "max_ms": None,
                    "p50_ms": None, "p90_ms": None, "p99_ms": None}
        n = len(self._sorted_ms)
        return {
            "count": n,
            "total_ms": self.total_ms,
            "avg_ms": self.total_ms / n,
            "min_ms": self._sorted_ms[0],
            "max_ms": self._sorted_ms[-1],
            "p50_ms": self._percentile(50),
            "p90_ms": self._percentile(90),
            "p99_ms": self._percentile(99),
        }


# ──────────────────────────────────────────────────────────────────────────────
# RejectionRecord — enrichment time wasted on a rejected business
# ──────────────────────────────────────────────────────────────────────────────

@dataclass
class RejectionRecord:
    reason: str
    elapsed_ms: float   # enrichment time spent before this business was rejected


# ──────────────────────────────────────────────────────────────────────────────
# BusinessTiming — per-business stage breakdown (in-memory, not printed by default)
# ──────────────────────────────────────────────────────────────────────────────

@dataclass
class BusinessTiming:
    name: str
    stages: dict[str, float] = field(default_factory=dict)   # stage → elapsed_ms
    outcome: str = "delivered"   # delivered | rejected:<reason>
    total_ms: float = 0.0


# ──────────────────────────────────────────────────────────────────────────────
# RunProfiler — one instance per run_query() call
# ──────────────────────────────────────────────────────────────────────────────

class RunProfiler:
    """
    Collects all timing data for a single run_query() invocation.

    Thread/async-safe for single-coroutine sequential pipelines (which this
    engine is — no parallelism at the run_query level).
    """

    def __init__(self) -> None:
        self._run_start: float = time.perf_counter()
        self._stages: dict[str, StageTimer] = defaultdict(StageTimer)
        self._marks: dict[str, float] = {}          # event name → abs time
        self._rejections: list[RejectionRecord] = []
        self._per_business: list[BusinessTiming] = []

        # Phase 2 (per-area latency profiling): generic named counters —
        # see incr()/counter() below. Separate from `_discovered`/
        # `_delivered` above (those two are driven by begin_business()/
        # end_business(), which the current Engine 2.0 pipeline never
        # calls — see this class's Phase 2 audit notes on incr()).
        self._counters: dict[str, int] = defaultdict(int)

        # Current business being timed (set by begin_business / end_business)
        self._current_business: BusinessTiming | None = None
        self._business_start: float | None = None

        # Throughput counters
        self._discovered: int = 0
        self._delivered: int = 0

        # Memory snapshots
        self._mem_start_mb: float = get_memory_usage()
        self._mem_peak_mb: float = self._mem_start_mb
        self._mem_end_mb: float = 0.0

    # ── Public API ────────────────────────────────────────────────────────────

    @contextlib.contextmanager
    def timer(self, stage: str) -> Generator[None, None, None]:
        """
        Async-friendly context manager that records elapsed ms for *stage*.

        Usage::

            async with profiler.timer("site_crawl"):
                result = await crawl(url)

        Works equally well with synchronous ``with`` blocks.
        """
        t0 = time.perf_counter()
        try:
            yield
        finally:
            elapsed_ms = (time.perf_counter() - t0) * 1000.0
            self._stages[stage].record(elapsed_ms)
            # Mirror into the current business's stage dict if active
            if self._current_business is not None:
                self._current_business.stages[stage] = (
                    self._current_business.stages.get(stage, 0.0) + elapsed_ms
                )
            # Track peak memory at every stage boundary
            mem = get_memory_usage()
            if mem > self._mem_peak_mb:
                self._mem_peak_mb = mem

    def mark(self, event: str) -> None:
        """Record a single wall-clock timestamp for *event* (no duration)."""
        self._marks[event] = time.perf_counter()
        mem = get_memory_usage()
        if mem > self._mem_peak_mb:
            self._mem_peak_mb = mem

    def mark_first_opportunity(self) -> None:
        """
        Call exactly once when the first validated lead is yielded to the caller.
        Contributes to the 'Time to First Opportunity' metric.
        """
        if "first_opportunity" not in self._marks:
            self._marks["first_opportunity"] = time.perf_counter()

    def mark_first_discovered_business(self) -> None:
        """Phase 2A: first raw place successfully extracted from Maps
        (before dedup/filtering). No-op after the first call."""
        if "first_discovered_business" not in self._marks:
            self._marks["first_discovered_business"] = time.perf_counter()

    def mark_first_yielded_business(self) -> None:
        """Phase 2A: first raw place actually yielded out of
        MapsScraper.search() (i.e. survived dedup) — distinct from
        first_discovered_business, which fires even for a place that turns
        out to be a duplicate. No-op after the first call."""
        if "first_yielded_business" not in self._marks:
            self._marks["first_yielded_business"] = time.perf_counter()

    def begin_business(self, name: str) -> None:
        """Start timing a new business being processed by the pipeline."""
        self._current_business = BusinessTiming(name=name)
        self._business_start = time.perf_counter()
        self._discovered += 1

    def end_business(self, outcome: str) -> None:
        """
        Close the current business's timing record.

        outcome examples: "delivered", "rejected:chain_business",
                          "rejected:viability:no_channels"
        """
        if self._current_business is None:
            return
        elapsed_ms = (time.perf_counter() - (self._business_start or 0.0)) * 1000.0
        self._current_business.outcome = outcome
        self._current_business.total_ms = elapsed_ms
        self._per_business.append(self._current_business)
        self._current_business = None
        self._business_start = None
        if outcome == "delivered":
            self._delivered += 1

    def record_rejection(self, reason: str, elapsed_ms: float) -> None:
        """
        Record that a business was rejected after *elapsed_ms* ms of enrichment work.
        Call this at every rejection exit point inside pipeline.process().
        """
        self._rejections.append(RejectionRecord(reason=reason, elapsed_ms=elapsed_ms))

    def elapsed_since_business_start_ms(self) -> float:
        """How many ms have elapsed since begin_business() was called."""
        if self._business_start is None:
            return 0.0
        return (time.perf_counter() - self._business_start) * 1000.0

    # ── Phase 2 (per-area latency profiling): stage-duration + counters ────
    #
    # These two methods are the bridge between `EngineRuntime.execute_stage()`
    # / `build_seven_stage_pipeline()`'s new `on_stage_timing`/`_emit` events
    # (engine/runtime.py, engine/execution_driver.py) and this profiler's
    # existing `StageTimer` machinery. Deliberately generic (any stage name,
    # any counter name) rather than one method per field, so the [area-sla]
    # report (service.py) can be assembled without adding a new RunProfiler
    # method every time a new stage or count is wired in.

    def record_stage_duration(self, stage: str, elapsed_ms: float | None) -> None:
        """Record one sample for an out-of-band timed stage (i.e. one not
        wrapped in `timer()` because the timing happens in a different
        module — see `EngineRuntime.execute_stage()`'s `duration_ms`).
        No-ops on `None` (a no-op cycle, e.g. `ran=False`) rather than
        recording a bogus zero sample."""
        if elapsed_ms is None:
            return
        self._stages[stage].record(elapsed_ms)

    def incr(self, counter: str, by: int = 1) -> None:
        """Increment a named area-sla counter (raw_candidates, early_new,
        early_duplicates, early_pruned, contact_failures, qualified,
        delivered, ...). Unlike `_discovered`/`_delivered` above — which
        are only ever touched by the dead `begin_business()`/`end_business()`
        pair (see Phase 2 audit note in these methods' own docstrings) —
        these counters are driven directly by the pipeline's real
        `on_progress`/`on_stage_timing` events, so they reflect Engine 2.0
        as it actually runs today."""
        self._counters[counter] += by

    def counter(self, name: str) -> int:
        return self._counters.get(name, 0)

    def area_sla_line(
        self,
        *,
        area: str,
        runtime_ms: float,
        first_candidate_ms: float | None,
        first_enrichment_ms: float | None,
        first_qualified_ms: float | None,
        first_delivered_ms: float | None,
    ) -> str:
        """
        Build the single, authoritative `[area-sla]` report line for this
        run (Phase 2 §Step 2). One line per area child — this is the
        report a human (or a log-scraping script comparing Bronx/Queens/
        Staten Island/Manhattan against Brooklyn) is meant to grep for.

        Stage-time fields are sums of the underlying `StageTimer`s named
        below — every one of them either already existed (Maps/browser
        stages, wired by scraper/maps_scraper.py) or was added this phase
        (website/instagram/contact/merge/qualification/storage worker
        stages, wired via `EngineRuntime.execute_stage()`'s new
        `duration_ms` -> `on_stage_timing` -> `record_stage_duration()`
        path). A field is 0 if the underlying stage never ran this run
        (e.g. `skip_ig`), not missing — matching every other numeric
        field in this line.
        """
        def _sum(*names: str) -> float:
            return round(sum(self._stages[n].total_ms for n in names if n in self._stages), 1)

        def _ms(v: float | None) -> str:
            return "" if v is None else str(round(v, 1))

        fields = [
            ("area", area),
            ("runtime_ms", round(runtime_ms, 1)),
            ("first_candidate_ms", _ms(first_candidate_ms)),
            ("first_enrichment_ms", _ms(first_enrichment_ms)),
            ("first_qualified_ms", _ms(first_qualified_ms)),
            ("first_delivered_ms", _ms(first_delivered_ms)),
            ("maps_ms", _sum("playwright_startup", "browser_startup", "context_creation", "page_creation")),
            ("navigation_ms", _sum("maps_initial_load")),
            ("panel_ms", _sum("place_panel_wait", "place_settle")),
            ("scroll_ms", _sum("scroll_movement", "scroll_wait")),
            ("place_click_ms", _sum("place_click")),
            ("rate_limit_ms", _sum("rate_limit_wait_search", "rate_limit_wait_place")),
            ("extraction_ms", _sum("maps_place_extraction")),
            # PHASE 2B (discovery wall-clock instrumentation) — new
            # fields below. `discovery_total_ms` / `google_maps_total_ms`
            # / `overpass_total_ms` are single, direct wall-clock
            # measurements (ExecutionDriver's `on_stage_wallclock` /
            # providers/provider_timing.py's `TimedDiscoveryProvider`
            # respectively) — NOT computed as sums of the granular
            # sub-stage fields above or below; see those modules' own
            # docstrings for why that distinction matters. The
            # maps_navigation_ms/panel_resolution_ms/place_detail_ms/
            # candidate_extraction_ms quartet below are the same
            # underlying samples as navigation_ms/panel_ms/
            # place_click_ms/extraction_ms above, kept side-by-side
            # under both names rather than renamed in place, so any
            # existing log-scraping script reading the original field
            # names keeps working unmodified.
            ("discovery_total_ms", _sum("discovery_total_ms")),
            ("google_maps_total_ms", _sum("google_maps_provider_total")),
            ("overpass_total_ms", _sum("overpass_provider_total")),
            ("maps_navigation_ms", _sum("maps_initial_load")),
            ("panel_resolution_ms", _sum("place_panel_wait", "place_settle")),
            ("place_detail_ms", _sum("place_click")),
            ("candidate_extraction_ms", _sum("maps_place_extraction")),
            ("retry_wait_ms", _sum("retry_wait")),
            ("maps_rounds", self.counter("maps_rounds")),
            ("maps_candidates_seen", self.counter("maps_candidates_seen")),
            ("maps_candidates_yielded", self.counter("maps_candidates_yielded")),
            # PHASE 12A (zero-risk Maps click reduction): direct click
            # count (see MapsScraper.search()'s _human_click call site)
            # and the count of clicks skipped because the card itself
            # already, explicitly reported the business as permanently
            # closed — the only behavior change this phase makes.
            ("maps_candidates_clicked", self.counter("maps_candidates_clicked")),
            ("maps_candidates_card_closed_skipped", self.counter("maps_candidates_card_closed_skipped")),
            ("overpass_requests", self.counter("overpass_requests")),
            ("overpass_retries", self.counter("overpass_retries")),
            ("website_ms", _sum("website_worker")),
            ("instagram_ms", _sum("instagram_worker")),
            ("contact_ms", _sum("contact_worker")),
            ("merge_ms", _sum("merge_worker")),
            ("qualification_ms", _sum("qualification_worker")),
            ("storage_ms", _sum("storage_worker")),
            ("raw_candidates", self.counter("raw_candidates")),
            ("early_new", self.counter("early_new")),
            ("early_duplicates", self.counter("early_duplicates")),
            ("early_pruned", self.counter("early_pruned")),
            ("contact_failures", self.counter("contact_failures")),
            ("qualified", self.counter("qualified")),
            ("delivered", self.counter("delivered")),
        ]
        fields.extend(self._weak_site_validation_fields())
        return "[area-sla]\n" + "\n".join(f"{k}={v}" for k, v in fields)

    # ── Phase 3B-VALIDATION (observability only) ────────────────────────
    #
    # Everything below reads counters/timers that already exist by the
    # time this is called (populated via `incr()`/`record_stage_duration()`
    # from `service.py`'s `_on_progress`/`_on_stage_timing`, fed in turn by
    # the new, additive `site_class_*` events in
    # `engine/execution_driver.py`). Nothing here changes what gets
    # pruned, qualified, or delivered — it only reports on it, to answer
    # the Phase 3B audit's validation questions (weak vs normal site
    # counts/conversion, and an estimate of worker/network time that
    # pruning weak-site candidates at discovery would avoid) directly from
    # a real run instead of a one-off log query.
    def _weak_site_validation_fields(self) -> list[tuple[str, Any]]:
        def _rate(numerator: int, denominator: int) -> str:
            return f"{(numerator / denominator * 100):.1f}%" if denominator else "n/a"

        early_new_weak = self.counter("early_new_weak_site")
        early_new_normal = self.counter("early_new_normal_site")
        qualified_weak = self.counter("qualified_weak_site")
        qualified_normal = self.counter("qualified_normal_site")
        contact_failures_weak = self.counter("contact_failures_weak_site")
        contact_failures_normal = self.counter("contact_failures_normal_site")

        # Avoided-work estimate: for every weak-site candidate that reached
        # Website and/or Contact, what it cost is approximated as this
        # run's own observed average duration for that stage (falls back
        # to 0 if the stage never ran, i.e. no sample to average). This is
        # an estimate of the wall-clock/network work that would be
        # skipped if weak-site candidates were pruned at discovery (§4 of
        # the task) — it does not change what actually ran this session.
        website_avg_ms = self._stages["website_worker"].stats()["avg_ms"] or 0.0
        contact_avg_ms = self._stages["contact_worker"].stats()["avg_ms"] or 0.0
        website_reached_weak = self.counter("website_reached_weak_site") + self.counter("website_failed_weak_site")
        contact_reached_weak = self.counter("contact_reached_weak_site") + self.counter("contact_failures_weak_site")
        estimated_ms_saved = (website_reached_weak * website_avg_ms) + (contact_reached_weak * contact_avg_ms)

        return [
            ("early_new_weak_site", early_new_weak),
            ("early_new_normal_site", early_new_normal),
            ("website_reached_weak_site", self.counter("website_reached_weak_site")),
            ("website_reached_normal_site", self.counter("website_reached_normal_site")),
            ("website_failed_weak_site", self.counter("website_failed_weak_site")),
            ("website_failed_normal_site", self.counter("website_failed_normal_site")),
            ("contact_reached_weak_site", self.counter("contact_reached_weak_site")),
            ("contact_reached_normal_site", self.counter("contact_reached_normal_site")),
            ("contact_failures_weak_site", contact_failures_weak),
            ("contact_failures_normal_site", contact_failures_normal),
            ("qualified_weak_site", qualified_weak),
            ("qualified_normal_site", qualified_normal),
            ("delivered_weak_site", self.counter("delivered_weak_site")),
            ("delivered_normal_site", self.counter("delivered_normal_site")),
            ("weak_site_to_qualified_rate", _rate(qualified_weak, early_new_weak)),
            ("normal_site_to_qualified_rate", _rate(qualified_normal, early_new_normal)),
            ("estimated_weak_site_ms_saved_if_pruned", round(estimated_ms_saved, 1)),
        ]

    def print_area_sla(self, **kwargs: Any) -> None:
        """Print the `[area-sla]` block to stderr (same stream
        `print_report()` already uses) so it lands in the same per-child
        log a production run already captures."""
        import sys
        print("\n" + self.area_sla_line(**kwargs) + "\n", file=sys.stderr)

    # ── Computed metrics ──────────────────────────────────────────────────────

    @property
    def _total_run_ms(self) -> float:
        return (time.perf_counter() - self._run_start) * 1000.0

    @property
    def _time_to_first_opportunity_ms(self) -> float | None:
        t = self._marks.get("first_opportunity")
        return (t - self._run_start) * 1000.0 if t else None

    @property
    def _businesses_per_minute(self) -> float:
        run_min = self._total_run_ms / 60_000.0
        return (self._discovered / run_min) if run_min > 0 else 0.0

    @property
    def _leads_per_minute(self) -> float:
        run_min = self._total_run_ms / 60_000.0
        return (self._delivered / run_min) if run_min > 0 else 0.0

    # ── Phase 2A: Discovery utilization metrics ─────────────────────────────
    #
    # "Browser-bound" stages are ones where a real CDP round trip / page
    # render is happening. Everything else discovery-side (rate-limiter
    # waits, the place-settle wait, queue backpressure) is the browser
    # sitting idle while Python waits on something else — which is exactly
    # the distinction Phase 1A's audit needed but the profiler couldn't
    # previously show, since the rate-limiter wait wasn't timed at all and
    # the settle sleep was folded into the extraction timer (see audit §3.3).
    _BROWSER_BOUND_STAGES = frozenset({
        "playwright_startup", "browser_startup", "context_creation",
        "page_creation", "maps_initial_load", "scroll_movement",
        "scroll_wait", "place_click", "place_panel_wait",
        "maps_place_extraction",
    })
    _DISCOVERY_BLOCKED_STAGES = frozenset({
        "rate_limit_wait_search", "rate_limit_wait_place", "place_settle",
        "queue_wait_put",
    })

    def _discovery_span_ms(self) -> float | None:
        """Wall-clock span of the discovery worker, if marked. Falls back
        to the whole run span (over-counts if enrichment ran concurrently
        in the same profiler, so callers should prefer the marks when
        available)."""
        start = self._marks.get("discovery_worker_start")
        end = self._marks.get("discovery_worker_end") or time.perf_counter()
        if start is not None:
            return (end - start) * 1000.0
        return self._total_run_ms

    @property
    def _browser_utilization_pct(self) -> float | None:
        span = self._discovery_span_ms()
        if not span or span <= 0:
            return None
        busy = sum(
            t.total_ms for name, t in self._stages.items()
            if name in self._BROWSER_BOUND_STAGES
        )
        return round(min(100.0, busy / span * 100.0), 1)

    @property
    def _discovery_worker_utilization_pct(self) -> float | None:
        """Fraction of the discovery worker's own wall-clock time that was
        NOT spent blocked on downstream backpressure (enrich_queue.put()).
        Low values confirm the audit's §3.5 hypothesis that discovery is
        capped by a slower downstream consumer, independent of how fast
        discovery itself becomes."""
        span = self._discovery_span_ms()
        if not span or span <= 0:
            return None
        blocked = self._stages.get("queue_wait_put")
        blocked_ms = blocked.total_ms if blocked else 0.0
        return round(min(100.0, max(0.0, (1 - blocked_ms / span) * 100.0)), 1)

    def _rejection_breakdown(self) -> list[dict]:
        """Aggregate rejections by reason, include avg enrichment time wasted."""
        by_reason: dict[str, list[float]] = defaultdict(list)
        for r in self._rejections:
            by_reason[r.reason].append(r.elapsed_ms)
        result = []
        for reason, samples in sorted(by_reason.items(), key=lambda x: -len(x[1])):
            avg_ms = sum(samples) / len(samples)
            result.append({
                "reason": reason,
                "count": len(samples),
                "avg_enrich_ms_before_reject": round(avg_ms, 1),
                "total_wasted_ms": round(sum(samples), 1),
            })
        return result

    # ── Output ────────────────────────────────────────────────────────────────

    def summary(self) -> dict:
        """
        Return a fully-structured dict for embedding in the __done__ sentinel.
        Contains all timing data, percentiles, rejections, and resource usage.
        """
        self._mem_end_mb = get_memory_usage()
        total_ms = self._total_run_ms
        inter_lead_gaps = self._stages.get("inter_lead_gap")

        stages_dict: dict[str, dict] = {}
        for name, timer in self._stages.items():
            if name == "inter_lead_gap":
                continue  # reported separately
            s = timer.stats()
            s["pct_of_runtime"] = round(s["total_ms"] / total_ms * 100, 1) if total_ms > 0 else 0
            stages_dict[name] = s

        first_disc = self._marks.get("first_discovered_business")
        first_yield = self._marks.get("first_yielded_business")

        return {
            "run_total_ms": round(total_ms, 1),
            "time_to_first_opportunity_ms": (
                round(self._time_to_first_opportunity_ms, 1)
                if self._time_to_first_opportunity_ms is not None else None
            ),
            "time_to_first_discovered_business_ms": (
                round((first_disc - self._run_start) * 1000, 1) if first_disc else None
            ),
            "time_to_first_yielded_business_ms": (
                round((first_yield - self._run_start) * 1000, 1) if first_yield else None
            ),
            "businesses_discovered": self._discovered,
            "leads_delivered": self._delivered,
            "businesses_per_minute": round(self._businesses_per_minute, 2),
            "leads_per_minute": round(self._leads_per_minute, 2),
            "avg_inter_lead_gap_ms": (
                round(inter_lead_gaps.stats()["avg_ms"], 1)
                if inter_lead_gaps and inter_lead_gaps.count > 0 else None
            ),
            "browser_utilization_pct": self._browser_utilization_pct,
            "discovery_worker_utilization_pct": self._discovery_worker_utilization_pct,
            "stages": stages_dict,
            "rejection_breakdown": self._rejection_breakdown(),
            "resources": {
                "active_browsers": active_browsers,
                "active_contexts": active_contexts,
                "active_pages": active_pages,
                "mem_start_mb": round(self._mem_start_mb, 1),
                "mem_peak_mb": round(self._mem_peak_mb, 1),
                "mem_end_mb": round(self._mem_end_mb, 1),
            },
            "marks": {k: round((v - self._run_start) * 1000, 1) for k, v in self._marks.items()},
        }

    def print_report(
        self,
        *,
        query: str = "",
        city: str = "",
        delivered: int = 0,
        requested: int = 0,
    ) -> None:
        """
        Print ONE concise performance report to stderr.

        Per-business detail is suppressed by default.
        Set env MAST_PERF_VERBOSE=1 to enable it.
        """
        self._mem_end_mb = get_memory_usage()
        total_s = self._total_run_ms / 1000.0
        total_ms = self._total_run_ms
        rejected = self._discovered - self._delivered

        verbose = bool(os.environ.get("MAST_PERF_VERBOSE", ""))

        W = 70
        bar = "═" * W

        lines = [
            "",
            bar,
            f"  MAST PERFORMANCE REPORT  |  {query} / {city}".center(W),
            f"  Runtime: {total_s:.1f}s   Leads: {delivered}/{requested}"
            f"   Discovered: {self._discovered}   Rejected: {rejected}",
        ]

        t2fo = self._time_to_first_opportunity_ms
        inter = self._stages.get("inter_lead_gap")
        avg_gap = inter.stats()["avg_ms"] if inter and inter.count else None
        lines.append(
            f"  Time to First Opportunity: {f'{t2fo/1000:.1f}s' if t2fo else 'n/a'}"
            f"   Avg inter-lead gap: {f'{avg_gap/1000:.1f}s' if avg_gap else 'n/a'}"
        )
        lines.append(
            f"  Throughput: {self._businesses_per_minute:.1f} businesses/min"
            f"   {self._leads_per_minute:.1f} leads/min"
        )
        lines.append(bar)

        # Stage breakdown — ranked by total time
        lines.append("")
        lines.append("  STAGE BREAKDOWN  (ranked slowest → fastest)")
        lines.append("")
        hdr = f"  {'#':<4}{'Stage':<26}{'Calls':>6}{'Total':>8}{'Avg':>8}{'P50':>8}{'P90':>8}{'P99':>8}{'%':>5}"
        lines.append(hdr)
        lines.append("  " + "─" * (W - 2))

        def _fmt(ms: float | None, unit: str = "s") -> str:
            if ms is None:
                return "  — "
            return f"{ms/1000:.2f}s" if unit == "s" else f"{ms:.0f}ms"

        ranked = sorted(
            [(n, t) for n, t in self._stages.items() if n != "inter_lead_gap"],
            key=lambda x: -x[1].total_ms,
        )
        for rank, (name, timer) in enumerate(ranked, 1):
            s = timer.stats()
            pct = s["total_ms"] / total_ms * 100 if total_ms > 0 else 0
            row = (
                f"  {rank:<4}"
                f"{name:<26}"
                f"{s['count']:>6}"
                f"  {_fmt(s['total_ms'])}"
                f"  {_fmt(s['avg_ms'])}"
                f"  {_fmt(s['p50_ms'])}"
                f"  {_fmt(s['p90_ms'])}"
                f"  {_fmt(s['p99_ms'])}"
                f"  {pct:>4.0f}%"
            )
            lines.append(row)

        # Rejection breakdown
        lines.append("")
        rej_data = self._rejection_breakdown()
        lines.append(f"  REJECTION BREAKDOWN  ({rejected} businesses rejected)")
        lines.append("  " + "─" * (W - 2))
        lines.append(f"  {'Reason':<34}{'Count':>6}  {'Avg enrich time before reject'}")
        for r in rej_data:
            avg_s = r["avg_enrich_ms_before_reject"] / 1000
            lines.append(f"  {r['reason']:<34}{r['count']:>6}  {avg_s:.2f}s")

        # Resource usage
        lines.append("")
        lines.append("  RESOURCE USAGE")
        lines.append("  " + "─" * (W - 2))
        lines.append(
            f"  Browser launches: {len(self._stages.get('browser_startup', StageTimer())._sorted_ms) or 1}"
            f"   Contexts: {active_contexts + (sum(1 for _ in self._per_business) if False else 0)}"
            f"   Pages created: (see lifecycle log)"
        )
        lines.append(
            f"  Memory — start: {self._mem_start_mb:.0f}MB"
            f"   peak: {self._mem_peak_mb:.0f}MB"
            f"   end: {self._mem_end_mb:.0f}MB"
        )

        # Optional per-business detail
        if verbose and self._per_business:
            lines.append("")
            lines.append("  PER-BUSINESS DETAIL  (MAST_PERF_VERBOSE=1)")
            lines.append("  " + "─" * (W - 2))
            for b in self._per_business:
                lines.append(f"  [{b.outcome}] {b.name}  total={b.total_ms/1000:.2f}s")
                for stage_name, ms in sorted(b.stages.items(), key=lambda x: -x[1]):
                    lines.append(f"        {stage_name}: {ms/1000:.3f}s")

        lines.append(bar)
        lines.append("")

        import sys
        print("\n".join(lines), file=sys.stderr)


# ──────────────────────────────────────────────────────────────────────────────
# Null profiler — used when no profiler is injected (no-op, zero overhead)
# ──────────────────────────────────────────────────────────────────────────────

class _NullTimer:
    """Context manager that does nothing."""
    def __enter__(self): return self
    def __exit__(self, *_): pass


class NullProfiler:
    """
    Drop-in replacement for RunProfiler that does nothing.
    Used by pipeline/crawler/ig_intel when no profiler is injected,
    so callers don't need to guard every ``async with profiler.timer(...)`` call.
    """
    @contextlib.contextmanager
    def timer(self, stage: str) -> Generator[None, None, None]:  # noqa: ARG002
        yield

    def mark(self, event: str) -> None: pass  # noqa: ARG002
    def mark_first_opportunity(self) -> None: pass
    def mark_first_discovered_business(self) -> None: pass
    def mark_first_yielded_business(self) -> None: pass
    def begin_business(self, name: str) -> None: pass  # noqa: ARG002
    def end_business(self, outcome: str) -> None: pass  # noqa: ARG002
    def record_rejection(self, reason: str, elapsed_ms: float) -> None: pass  # noqa: ARG002
    def elapsed_since_business_start_ms(self) -> float: return 0.0
    def record_stage_duration(self, stage: str, elapsed_ms: float | None) -> None: pass  # noqa: ARG002
    def incr(self, counter: str, by: int = 1) -> None: pass  # noqa: ARG002
    def counter(self, name: str) -> int: return 0  # noqa: ARG002
    def area_sla_line(self, **kwargs: object) -> str: return ""  # noqa: ARG002
    def print_area_sla(self, **kwargs: object) -> None: pass  # noqa: ARG002
    def summary(self) -> dict: return {}
    def print_report(self, **_: object) -> None: pass


# Convenience: module-level factory so callers can write
#   from utils.perf import make_profiler
#   profiler = make_profiler(enabled=True)
def make_profiler(*, enabled: bool = True) -> RunProfiler | NullProfiler:
    return RunProfiler() if enabled else NullProfiler()
