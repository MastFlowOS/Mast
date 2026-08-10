"""Fake engine: emits nothing on stdout at all (no lead, no progress),
until it receives SIGTERM — at which point it reports a __done__ sentinel
exactly the way the real service.py's Phase 2B fix now does for a
cooperative-shutdown stop (see service.py's `_stopped_by_shutdown` /
`DiscoveryFailure(DiscoveryFailureReason.CANCELLED)`):

    success=False, exhausted=False, target_reached=False,
    failure_reason="CANCELLED"

Used to prove pythonBridge.ts's onDone() derives
terminationReason="WATCHDOG_TIMEOUT" (not "CANCELLED", since this
process's own SIGTERM here always coincides with runEngineQuery's local
`timedOut` state in the test that spawns it) for exactly this shape.
"""
import json
import signal
import sys
import time


def _on_sigterm(signum, frame):
    print(
        json.dumps(
            {
                "__done__": True,
                "delivered": 0,
                "requested": 5,
                "exhausted": False,
                "success": False,
                "target_reached": False,
                "failure_reason": "CANCELLED",
                "failure_detail": "cooperative shutdown (watchdog) stopped this run",
            }
        ),
        flush=True,
    )
    sys.exit(0)


def main():
    sys.stdin.read()
    signal.signal(signal.SIGTERM, _on_sigterm)
    # Sit completely silent — the test's tiny inactivity watchdog is what
    # is expected to end this process via SIGTERM, handled above.
    time.sleep(60)


if __name__ == "__main__":
    main()
