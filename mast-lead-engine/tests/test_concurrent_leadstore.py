"""
Mast Lead Engine — Regression tests for concurrent-process LeadStore safety.

CONTEXT (bug report): the Google Maps area-worker pool
(src/discovery/googleAreaPool.ts) spawns multiple `python service.py`
subprocesses concurrently against the SAME sqlite dedup database (e.g.
`data/leads-pool-expand.db`). Each subprocess constructs its own
`LeadStore`, and two of them starting at effectively the same instant used
to race each other for the exclusive lock `PRAGMA journal_mode=WAL` and
schema bootstrap/migration need, raising
`sqlite3.OperationalError: database is locked` and crashing one worker.

These tests use REAL OS-level subprocesses (multiprocessing, not threads)
against a SHARED database file, because the failure mode is specifically a
cross-process file-lock race that threads within one interpreter cannot
reproduce (they'd share the same sqlite3 connection object's GIL-serialized
access instead of racing at the OS/file level).

Run: pytest tests/test_concurrent_leadstore.py -v
"""

from __future__ import annotations

import multiprocessing
import os
import sys
import time

import pytest

# Make the root importable — same pattern as tests/test_part1.py.
sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))


# ──────────────────────────────────────────────────────────────────────────────
# Worker functions — MUST be module-level (top-level, picklable) so they work
# under both "fork" and "spawn" multiprocessing start methods.
# ──────────────────────────────────────────────────────────────────────────────

def _worker_init_only(db_path: str, barrier, out_queue) -> None:
    """Every worker constructs a LeadStore at (as close as possible to) the
    exact same instant, then immediately closes it. Exercises the
    WAL-switch + bootstrap + migrate race directly."""
    import sys as _sys
    _sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
    from storage.dedup import LeadStore

    try:
        barrier.wait(timeout=30)
        store = LeadStore(db_path)
        store.close()
        out_queue.put(("ok", os.getpid()))
    except Exception as exc:  # noqa: BLE001 - want to report *any* failure
        out_queue.put(("error", f"{type(exc).__name__}: {exc}"))


def _worker_write_unique(db_path: str, worker_id: int, n_leads: int, barrier, out_queue) -> None:
    """Every worker opens its own LeadStore against the SHARED db and adds
    `n_leads` distinct businesses (unique per worker_id so there's no
    legitimate dedup collision to reason about) — exercises concurrent
    reads (is_duplicate) and writes (add) against the same file."""
    import sys as _sys
    _sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
    from storage.dedup import LeadStore

    try:
        barrier.wait(timeout=30)
        store = LeadStore(db_path)
        added = 0
        for i in range(n_leads):
            biz = {
                "name": f"Worker{worker_id} Business {i}",
                "city": "Testville",
                "email": f"worker{worker_id}-{i}@example.com",
            }
            is_dup, keys, _ = store.is_duplicate(biz)
            if not is_dup:
                store.add(biz, keys)
                added += 1
        store.close()
        out_queue.put(("ok", worker_id, added))
    except Exception as exc:  # noqa: BLE001
        out_queue.put(("error", worker_id, f"{type(exc).__name__}: {exc}"))


def _worker_add_one(db_path: str, biz: dict, out_queue) -> None:
    """Opens a fresh LeadStore, adds a single business, closes. Used to
    build up cross-process persisted state sequentially."""
    import sys as _sys
    _sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
    from storage.dedup import LeadStore

    try:
        store = LeadStore(db_path)
        is_dup, keys, matched = store.is_duplicate(biz)
        if not is_dup:
            store.add(biz, keys)
        store.close()
        out_queue.put(("ok", is_dup, matched))
    except Exception as exc:  # noqa: BLE001
        out_queue.put(("error", f"{type(exc).__name__}: {exc}"))


def _run_processes(target, args_list, timeout=60):
    """Spawn one process per entry in args_list, join them all, return the
    list of exitcodes (in start order)."""
    procs = [multiprocessing.Process(target=target, args=args) for args in args_list]
    for p in procs:
        p.start()
    for p in procs:
        p.join(timeout=timeout)
    return procs


# ──────────────────────────────────────────────────────────────────────────────
# 1. Two concurrent LeadStore instances / concurrent initialization
# ──────────────────────────────────────────────────────────────────────────────

class TestConcurrentInitialization:
    def test_two_concurrent_leadstores_same_db_no_lock_error(self, tmp_path):
        """The exact reported failure mode: two Python engine processes
        constructing a LeadStore against the same file at the same time."""
        db_path = str(tmp_path / "two_concurrent.db")
        ctx = multiprocessing.get_context()
        barrier = ctx.Barrier(2)
        out_queue = ctx.Queue()

        procs = _run_processes(
            _worker_init_only,
            [(db_path, barrier, out_queue), (db_path, barrier, out_queue)],
        )

        results = [out_queue.get(timeout=10) for _ in range(2)]
        errors = [r for r in results if r[0] == "error"]
        assert not errors, f"concurrent LeadStore init raised: {errors}"
        assert all(r[0] == "ok" for r in results)
        assert all(p.exitcode == 0 for p in procs)

    def test_many_concurrent_leadstores_same_db_no_lock_error(self, tmp_path):
        """Higher fan-out (mirrors `computedWorkers` > 2 in a bigger area
        pool) to make sure the fix scales past the minimal 2-process case."""
        db_path = str(tmp_path / "many_concurrent.db")
        n = 8
        ctx = multiprocessing.get_context()
        barrier = ctx.Barrier(n)
        out_queue = ctx.Queue()

        procs = _run_processes(
            _worker_init_only,
            [(db_path, barrier, out_queue) for _ in range(n)],
        )

        results = [out_queue.get(timeout=15) for _ in range(n)]
        errors = [r for r in results if r[0] == "error"]
        assert not errors, f"concurrent LeadStore init raised: {errors}"
        assert len(results) == n
        assert all(p.exitcode == 0 for p in procs)


# ──────────────────────────────────────────────────────────────────────────────
# 2. Concurrent reads/writes
# ──────────────────────────────────────────────────────────────────────────────

class TestConcurrentReadsAndWrites:
    def test_concurrent_writes_from_multiple_workers_no_lock_error(self, tmp_path):
        db_path = str(tmp_path / "concurrent_writes.db")
        n_workers = 4
        n_leads_each = 15
        ctx = multiprocessing.get_context()
        barrier = ctx.Barrier(n_workers)
        out_queue = ctx.Queue()

        procs = _run_processes(
            _worker_write_unique,
            [(db_path, wid, n_leads_each, barrier, out_queue) for wid in range(n_workers)],
            timeout=90,
        )

        results = [out_queue.get(timeout=20) for _ in range(n_workers)]
        errors = [r for r in results if r[0] == "error"]
        assert not errors, f"concurrent writes raised: {errors}"
        assert all(p.exitcode == 0 for p in procs)

        total_added = sum(r[2] for r in results if r[0] == "ok")
        assert total_added == n_workers * n_leads_each

        # Verify persisted state matches what every worker reported adding —
        # i.e. nothing was silently lost to a swallowed lock error.
        import sys as _sys
        _sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
        from storage.dedup import LeadStore

        store = LeadStore(db_path)
        try:
            assert store.total == n_workers * n_leads_each
        finally:
            store.close()


# ──────────────────────────────────────────────────────────────────────────────
# 3. Dedup remains shared/correct across processes
# ──────────────────────────────────────────────────────────────────────────────

class TestCrossProcessDedupCorrectness:
    def test_dedup_persists_and_is_seen_by_later_process(self, tmp_path):
        """Sequential cross-process check: a business added by process A is
        detected as a duplicate by process B, opening the SAME db fresh —
        proves persistent dedup semantics survived the locking fix
        untouched (no per-worker isolated DBs, no dedup disabled)."""
        db_path = str(tmp_path / "dedup_shared.db")
        ctx = multiprocessing.get_context()
        biz = {
            "name": "The Coffee Spot",
            "city": "Miami",
            "email": "hello@thecoffeespot.com",
            "instagram": "https://instagram.com/thecoffeespot",
        }

        # Process A: first writer — should NOT see a duplicate.
        q1 = ctx.Queue()
        p1 = ctx.Process(target=_worker_add_one, args=(db_path, biz, q1))
        p1.start()
        p1.join(timeout=20)
        status, is_dup, matched = q1.get(timeout=10)
        assert status == "ok"
        assert is_dup is False
        assert p1.exitcode == 0

        # Process B: second writer, same business — MUST see a duplicate.
        q2 = ctx.Queue()
        p2 = ctx.Process(target=_worker_add_one, args=(db_path, biz, q2))
        p2.start()
        p2.join(timeout=20)
        status, is_dup, matched = q2.get(timeout=10)
        assert status == "ok"
        assert is_dup is True
        assert matched is not None
        assert p2.exitcode == 0

        # Only one lead row should exist — process B correctly skipped add().
        import sys as _sys
        _sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
        from storage.dedup import LeadStore

        store = LeadStore(db_path)
        try:
            assert store.total == 1
        finally:
            store.close()

    def test_concurrent_workers_never_lose_distinct_fingerprints(self, tmp_path):
        """Concurrent, distinct businesses from different workers must all
        land in the shared fingerprint index — dedup isn't silently
        dropping cross-worker entries as a side effect of the locking fix."""
        db_path = str(tmp_path / "dedup_fingerprints.db")
        n_workers = 3
        n_leads_each = 10
        ctx = multiprocessing.get_context()
        barrier = ctx.Barrier(n_workers)
        out_queue = ctx.Queue()

        _run_processes(
            _worker_write_unique,
            [(db_path, wid, n_leads_each, barrier, out_queue) for wid in range(n_workers)],
            timeout=90,
        )
        for _ in range(n_workers):
            out_queue.get(timeout=20)

        import sys as _sys
        _sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
        from storage.dedup import LeadStore

        store = LeadStore(db_path)
        try:
            # Every worker's leads used a distinct email -> distinct
            # `email:` fingerprint, so every one of them must be resolvable
            # as a duplicate now that all writes have landed.
            for wid in range(n_workers):
                for i in range(n_leads_each):
                    biz = {
                        "name": f"Worker{wid} Business {i}",
                        "city": "Testville",
                        "email": f"worker{wid}-{i}@example.com",
                    }
                    is_dup, _, _ = store.is_duplicate(biz)
                    assert is_dup, f"lost fingerprint for worker={wid} lead={i}"
        finally:
            store.close()


# ──────────────────────────────────────────────────────────────────────────────
# 4. Deterministic busy_timeout exercise (not scheduler-luck dependent)
# ──────────────────────────────────────────────────────────────────────────────
#
# The previous tests exercise the real race under normal scheduling, but
# whether they actually land in the exclusive-lock window is still up to
# the OS scheduler. This test removes that luck factor: one process holds
# a real exclusive write lock on the database for longer than sqlite3's
# *old* default `timeout` (5s), while a second process tries to write
# concurrently. Without the raised `timeout=30.0` / explicit
# `PRAGMA busy_timeout=30000`, the second process would raise
# `database is locked` almost immediately instead of waiting; with the fix,
# it blocks until the lock is released and then succeeds.

_HOLD_SECONDS = 6.0  # deliberately > sqlite3's pre-fix 5s default timeout


def _worker_hold_exclusive_lock(db_path: str, ready_event, release_event) -> None:
    import sqlite3 as _sqlite3

    conn = _sqlite3.connect(db_path, timeout=30.0)
    conn.execute("BEGIN EXCLUSIVE")
    ready_event.set()
    release_event.wait(timeout=_HOLD_SECONDS + 5)
    conn.commit()
    conn.close()


def _worker_write_while_locked(db_path: str, ready_event, out_queue) -> None:
    import sys as _sys
    _sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
    from storage.dedup import LeadStore

    try:
        ready_event.wait(timeout=10)  # wait until the other process holds the lock
        start = time.monotonic()
        store = LeadStore(db_path)
        store.add({"name": "Waited It Out", "city": "Testville", "email": "waited@example.com"})
        store.close()
        elapsed = time.monotonic() - start
        out_queue.put(("ok", elapsed))
    except Exception as exc:  # noqa: BLE001
        out_queue.put(("error", f"{type(exc).__name__}: {exc}"))


class TestBusyTimeoutDeterministic:
    def test_write_waits_out_a_held_exclusive_lock_instead_of_failing(self, tmp_path):
        db_path = str(tmp_path / "busy_timeout.db")

        # Pre-bootstrap the schema so the held lock below is a pure write
        # (not first-time WAL/schema) contention, isolating what
        # PRAGMA busy_timeout is responsible for.
        import sys as _sys
        _sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
        from storage.dedup import LeadStore

        LeadStore(db_path).close()

        ctx = multiprocessing.get_context()
        ready_event = ctx.Event()
        release_event = ctx.Event()
        out_queue = ctx.Queue()

        locker = ctx.Process(target=_worker_hold_exclusive_lock, args=(db_path, ready_event, release_event))
        writer = ctx.Process(target=_worker_write_while_locked, args=(db_path, ready_event, out_queue))

        locker.start()
        writer.start()

        # Let the writer sit blocked against the held lock for a bit, then
        # release it — the writer must still succeed afterward rather than
        # having already raised "database is locked".
        time.sleep(_HOLD_SECONDS)
        release_event.set()

        locker.join(timeout=20)
        writer.join(timeout=20)

        status, payload = out_queue.get(timeout=15)
        assert status == "ok", f"writer failed while lock was held: {payload}"
        assert locker.exitcode == 0
        assert writer.exitcode == 0
        # The writer should have actually waited (not failed fast then
        # somehow retried outside our measurement) — elapsed time should be
        # in the same ballpark as the hold duration.
        assert payload >= _HOLD_SECONDS * 0.5, (
            f"writer returned suspiciously fast ({payload:.2f}s) for a "
            f"{_HOLD_SECONDS:.0f}s held lock — did it fail-fast instead of waiting?"
        )


if __name__ == "__main__":
    sys.exit(pytest.main([__file__, "-v"]))
