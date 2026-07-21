"""
Mast Lead Engine — Pipeline Accounting & Invariant Tracking (Phase S1).

Lightweight, in-memory, zero-dependency tracer. Every business yielded by
MapsScraper is assigned a temporary pipeline identifier ("#1", "#2", ...)
the moment it's yielded, and every stage transition it goes through from
then on is recorded against that identifier. At the end of a run, every
discovered business must have reached exactly one terminal outcome —
DELIVERED, REJECTED, or FAILED — or the reconciliation report calls it out
by name as a PIPELINE INVARIANT VIOLATION.

This is observability only:
  - Lives entirely in process memory — nothing is written to disk, Redis,
    or any database table, and no migration is required.
  - A `PipelineTracer` instance exists for the lifetime of exactly one
    `run_query()` call (one engine run) and is discarded when that call
    returns — it is never shared across runs.
  - Recording a transition never changes control flow, filtering,
    scoring, or dedup — it is called *alongside* the existing decision
    points, never in place of them.

Usage::

    tracer = PipelineTracer()
    pid = tracer.discover("Joe's Pizza")           # -> "#1"
    tracer.transition(pid, "QUEUED_FOR_ENRICHMENT")
    ...
    tracer.reject(pid, "duplicate")                # terminal
    ...
    tracer.sweep_incomplete("run_ended_early")      # end-of-run safety net
    print(tracer.reconcile())
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal

from utils.runtime import get_logger

log = get_logger("pipeline_trace")

Outcome = Literal["DELIVERED", "REJECTED", "FAILED"]

# Canonical stage order for THIS process's half of the pipeline (Google
# Maps -> ... -> handed off across the process boundary to Node). Used only
# to report which stage a stuck business never reached in the invariant
# violation printout below — purely descriptive, has no effect on any
# decision the engine makes.
STAGE_ORDER = [
    "DISCOVERED",
    "QUEUED_FOR_ENRICHMENT",
    "ENRICHMENT_STARTED",
    "ENRICHMENT_COMPLETED",
    "RESULTS_QUEUE",
    "YIELDED_TO_NODE",
]


@dataclass
class _Record:
    pid: str
    name: str
    history: list[str] = field(default_factory=list)
    outcome: Outcome | None = None
    reason: str | None = None

    @property
    def last_stage(self) -> str:
        return self.history[-1] if self.history else "<never recorded>"


def _next_stage(last: str) -> str:
    try:
        idx = STAGE_ORDER.index(last)
    except ValueError:
        return "<unknown — stage not in canonical order>"
    if idx + 1 < len(STAGE_ORDER):
        return STAGE_ORDER[idx + 1]
    return "<end of this process's pipeline>"


class PipelineTracer:
    """One instance per engine run (one `run_query()` call)."""

    def __init__(self) -> None:
        self._records: dict[str, _Record] = {}
        self._next_id = 1

    # ── Recording ────────────────────────────────────────────────────────

    def discover(self, name: str) -> str:
        """Call immediately after MapsScraper yields a business — mints a
        new pipeline id and records the DISCOVERED stage. This is the
        starting point every reconciliation count is built against."""
        pid = f"#{self._next_id}"
        self._next_id += 1
        rec = _Record(pid=pid, name=name or "<unnamed>")
        rec.history.append("DISCOVERED")
        self._records[pid] = rec
        log.info(f"[pipeline][{pid}] DISCOVERED {rec.name!r}")
        return pid

    def transition(self, pid: str | None, stage: str) -> None:
        """Record that a business reached a new (non-terminal) stage."""
        rec = self._records.get(pid) if pid else None
        if rec is None:
            log.warning(f"[pipeline][{pid}] transition to {stage} for an UNKNOWN pipeline id")
            return
        if rec.outcome is not None:
            log.warning(
                f"[pipeline][{pid}] transition to {stage} requested AFTER "
                f"terminal outcome {rec.outcome} was already recorded — ignored"
            )
            return
        rec.history.append(stage)
        log.info(f"[pipeline][{pid}] {stage}")

    def reject(self, pid: str | None, reason: str) -> None:
        """Terminal outcome: business rules correctly decided not to keep this business."""
        self._close(pid, "REJECTED", reason)

    def fail(self, pid: str | None, reason: str) -> None:
        """Terminal outcome: something broke (exception, unexpected error) — not a business-rule decision."""
        self._close(pid, "FAILED", reason)

    def deliver(self, pid: str | None) -> None:
        """Terminal outcome: successfully handed off to the next stage of the pipeline."""
        self._close(pid, "DELIVERED", None)

    def _close(self, pid: str | None, outcome: Outcome, reason: str | None) -> None:
        rec = self._records.get(pid) if pid else None
        if rec is None:
            log.warning(f"[pipeline][{pid}] {outcome} for an UNKNOWN pipeline id (reason={reason})")
            return
        if rec.outcome is not None:
            # First outcome wins — a double-close is itself a bug worth
            # surfacing loudly, not silently overwriting the original.
            log.warning(
                f"[pipeline][{pid}] duplicate terminal outcome — already "
                f"{rec.outcome} ({rec.reason}); also tried {outcome} ({reason}) — keeping the first"
            )
            return
        rec.outcome = outcome
        rec.reason = reason
        suffix = f" reason={reason}" if reason else ""
        log.info(f"[pipeline][{pid}] {outcome}{suffix}")

    # ── End-of-run safety net ───────────────────────────────────────────

    def sweep_incomplete(self, reason: str) -> int:
        """Force-close every record that never reached a terminal outcome
        as REJECTED with the given reason. Used when a run intentionally
        stops early (delivery target already met, cancellation) while some
        businesses are still mid-pipeline in the queues/workers — this
        guarantees Missing stays 0 even in that legitimate case, while
        still recording precisely why each one stopped instead of letting
        it vanish. Returns the number of records swept."""
        swept = 0
        for rec in self._records.values():
            if rec.outcome is None:
                rec.outcome = "REJECTED"
                rec.reason = reason
                swept += 1
        if swept:
            log.info(f"[pipeline] swept {swept} in-flight business(es) -> REJECTED (reason={reason})")
        return swept

    # ── Reconciliation ───────────────────────────────────────────────────

    def reconcile(self) -> str:
        """Build the end-of-run reconciliation summary plus, if the
        invariant was violated (a business never reached a terminal
        outcome — should be impossible after sweep_incomplete runs first),
        one explicit violation block per missing business."""
        discovered = len(self._records)
        delivered = sum(1 for r in self._records.values() if r.outcome == "DELIVERED")
        rejected = sum(1 for r in self._records.values() if r.outcome == "REJECTED")
        failed = sum(1 for r in self._records.values() if r.outcome == "FAILED")
        missing = [r for r in self._records.values() if r.outcome is None]

        lines = [
            "=====================================",
            f"Businesses discovered : {discovered}",
            f"Delivered             : {delivered}",
            f"Rejected              : {rejected}",
            f"Failed                : {failed}",
            f"Missing               : {len(missing)}",
            "=====================================",
        ]

        if missing:
            lines.append("")
            for rec in missing:
                lines.append("PIPELINE INVARIANT VIOLATION")
                lines.append(f"Business {rec.pid} ({rec.name})")
                lines.append("Last Seen:")
                lines.append(f"  {rec.last_stage}")
                lines.append("Never reached:")
                lines.append(f"  {_next_stage(rec.last_stage)}")
                lines.append("")

        return "\n".join(lines)
