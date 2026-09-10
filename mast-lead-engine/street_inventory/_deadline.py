"""
street_inventory/_deadline.py
===============================

CRITMODE — street-inventory hang investigation.

`urllib.request.urlopen(..., timeout=N)` only bounds *individual* blocking
socket operations (connect, and each `recv()` inside a streamed `read()`) —
it does NOT bound the *total* wall-clock time of a call. A slow/trickling
response (data arriving in small chunks, each comfortably inside `N`
seconds of the previous one) or a DNS resolution stall (`getaddrinfo`,
which happens *before* the socket exists and is therefore not covered by
`socket.settimeout()` at all on most platforms) can make a "timeout=60"
call run far longer than 60 seconds without ever raising.

This module exists ONLY to close that specific gap: it runs a blocking
call on a worker thread and enforces a genuine hard ceiling with
`Future.result(timeout=...)`. It does not change retry behavior, does not
catch/hide the underlying exception (re-raised via `Future.result()`
unmodified), and does not add a fallback — a call that exceeds the hard
deadline raises `TimeoutError`, which both existing call sites already
have an `except TimeoutError` branch for (see `overpass_source.py`) or
propagate unmodified (see `repository.py`, which never catches network
errors by design).

The thread that timed out is NOT forcibly killed (Python cannot do that
safely) — it is abandoned to finish or die on its own; the pool is small
and per-process, so a handful of abandoned threads from rare timeouts is
not a resource concern for this one-shot, once-per-city CLI process.
"""

from __future__ import annotations

import concurrent.futures
from typing import Callable, TypeVar

T = TypeVar("T")

# One small shared pool for the whole process — this CLI mode makes at
# most a handful of network calls (one Overpass POST, a few upsert
# batches), never many concurrently.
_EXECUTOR = concurrent.futures.ThreadPoolExecutor(
    max_workers=4, thread_name_prefix="street-inventory-io"
)


def call_with_hard_deadline(fn: Callable[..., T], *args, deadline_seconds: float, **kwargs) -> T:
    """
    Runs `fn(*args, **kwargs)` on a worker thread and enforces a genuine
    wall-clock ceiling of `deadline_seconds`. Raises `TimeoutError` if the
    ceiling is hit; otherwise returns `fn`'s result, or re-raises whatever
    `fn` raised, unmodified.
    """
    future = _EXECUTOR.submit(fn, *args, **kwargs)
    try:
        return future.result(timeout=deadline_seconds)
    except concurrent.futures.TimeoutError as exc:
        raise TimeoutError(
            f"{getattr(fn, '__name__', fn)} exceeded hard wall-clock deadline of {deadline_seconds}s"
        ) from exc
