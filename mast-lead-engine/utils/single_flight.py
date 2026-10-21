"""
MAST Lead Engine — Single-Flight In-Flight Request Coordinator
==============================================================
Prevents duplicate concurrent requests (cache stampedes) when multiple
worker threads process candidates sharing the same domain or URL.

Guarantees that for any given key, exactly one worker performs the network
operation (the leader), while concurrent callers (followers) await the result
and receive the exact prototype facts, keeping distinct candidate identities
isolated.
"""

from __future__ import annotations

import threading
from typing import Any, Callable, Dict, Generic, Optional, TypeVar

T = TypeVar("T")


class _InFlightCall(Generic[T]):
    def __init__(self) -> None:
        self.event = threading.Event()
        self.result: Optional[T] = None
        self.error: Optional[BaseException] = None
        self.leader: bool = False


class SingleFlight(Generic[T]):
    """Coordinates duplicate in-flight requests across concurrent threads."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._calls: Dict[str, _InFlightCall[T]] = {}

    def do(self, key: str, fn: Callable[..., T], *args: Any, **kwargs: Any) -> T:
        """
        Execute `fn(*args, **kwargs)` if `key` is not currently in flight.
        If `key` is already in flight, block until the in-flight call completes
        and return the shared result.
        """
        result, _ = self.do_detailed(key, fn, *args, **kwargs)
        return result

    def do_detailed(
        self, key: str, fn: Callable[..., T], *args: Any, **kwargs: Any
    ) -> tuple[T, bool]:
        """
        Execute `fn(*args, **kwargs)` if `key` is not currently in flight.
        Returns `(result, is_leader)`.
        `is_leader` is True if this thread executed `fn`, False if it waited for another thread.
        """
        with self._lock:
            call = self._calls.get(key)
            if call is not None:
                is_leader = False
            else:
                call = _InFlightCall[T]()
                call.leader = True
                self._calls[key] = call
                is_leader = True

        if not is_leader:
            call.event.wait()
            if call.error is not None:
                raise call.error
            return call.result, False  # type: ignore[return-value]

        try:
            result = fn(*args, **kwargs)
            call.result = result
            return result, True
        except BaseException as exc:
            call.error = exc
            raise
        finally:
            with self._lock:
                self._calls.pop(key, None)
            call.event.set()

    def in_flight_count(self) -> int:
        """Return the number of currently active in-flight calls."""
        with self._lock:
            return len(self._calls)

    def clear(self) -> None:
        """Clear all active in-flight calls (for test teardown)."""
        with self._lock:
            for call in self._calls.values():
                call.event.set()
            self._calls.clear()
