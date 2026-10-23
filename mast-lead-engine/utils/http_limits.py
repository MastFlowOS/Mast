"""Shared limits for outbound website fetches.

* ``read_capped`` — never buffer more than ``MAX_RESPONSE_BYTES`` of a
  response body. Contact data lives in the first part of a page; an
  unbounded ``response.read()`` lets one huge page (or an endless stream)
  hold memory for every in-flight candidate and for the website cache.
* ``fetch_slot`` — a process-wide bounded semaphore so the *total* number
  of simultaneous outbound fetches stays bounded regardless of how many
  stage threads / per-call executors are alive at once.
* ``is_permanent_http_error`` — HTTP statuses that will not change on a
  retry (a retry only wastes a round trip).

Both limits are overridable through environment variables so operators
can tune them without a code change; the defaults are conservative.
"""

from __future__ import annotations

import contextlib
import os
import threading
from typing import Iterator

_DEFAULT_MAX_RESPONSE_BYTES = 2_000_000
_DEFAULT_MAX_CONCURRENT_FETCHES = 24


def _env_int(name: str, default: int, *, minimum: int) -> int:
    raw = os.environ.get(name)
    if raw is None:
        return default
    try:
        value = int(raw)
    except (TypeError, ValueError):
        return default
    return value if value >= minimum else default


MAX_RESPONSE_BYTES = _env_int(
    "MAST_MAX_RESPONSE_BYTES", _DEFAULT_MAX_RESPONSE_BYTES, minimum=10_000
)
MAX_CONCURRENT_FETCHES = _env_int(
    "MAST_MAX_CONCURRENT_FETCHES", _DEFAULT_MAX_CONCURRENT_FETCHES, minimum=1
)

_FETCH_SEMAPHORE = threading.BoundedSemaphore(MAX_CONCURRENT_FETCHES)

#: Statuses that never succeed on retry. 429/5xx are NOT here: they are
#: transient and keep their bounded retry.
PERMANENT_HTTP_ERRORS = frozenset({400, 401, 402, 403, 404, 405, 406, 410, 451})


def is_permanent_http_error(code: int) -> bool:
    return code in PERMANENT_HTTP_ERRORS


def read_capped(response, limit: int | None = None) -> bytes:
    """Read at most ``limit`` bytes (default ``MAX_RESPONSE_BYTES``)."""
    cap = MAX_RESPONSE_BYTES if limit is None else limit
    try:
        data = response.read(cap)
    except TypeError:
        # File-like objects whose read() takes no size argument.
        data = response.read()
    return data[:cap]


@contextlib.contextmanager
def fetch_slot() -> Iterator[None]:
    """Hold one of the bounded global outbound-fetch slots."""
    _FETCH_SEMAPHORE.acquire()
    try:
        yield
    finally:
        _FETCH_SEMAPHORE.release()
