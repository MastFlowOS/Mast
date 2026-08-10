"""Fake engine: emits several `{"type": "progress", ...}` lines (PART C's
protocol — see service.py's `_on_progress` for the real producer), each
gap smaller than the test's tiny SCRAPER_SUBPROCESS_INACTIVITY_MS, but
whose TOTAL elapsed time is larger than that inactivity threshold. If
resetInactivityTimer() only recognized a delivered lead or __done__ (the
pre-Phase-2B behavior this fixture regression-tests against), the
watchdog would fire partway through and this process would be SIGTERM'd
before ever reaching its lead/__done__. Used to prove progress lines
alone are enough to keep the watchdog from firing.
"""
import json
import os
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from _lead import make_lead  # noqa: E402


def _progress(stage, event, item_id=None):
    print(
        json.dumps(
            {
                "type": "progress",
                "session_id": "fixture-session",
                "stage": stage,
                "event": event,
                "item_id": item_id,
                "timestamp": time.time(),
            }
        ),
        flush=True,
    )


def main():
    sys.stdin.read()
    events = [
        ("discovery", "candidate_discovered", "pid-1"),
        ("discovery", "candidate_queued", "pid-1"),
        ("website", "stage_completed", "pid-1"),
        ("instagram", "stage_completed", "pid-1"),
        ("contact", "stage_completed", "pid-1"),
        ("qualification", "candidate_qualified", "pid-1"),
    ]
    for stage, event, item_id in events:
        # Each individual gap is well under the test's inactivity
        # threshold, but six of them in a row exceed it in total.
        time.sleep(0.15)
        _progress(stage, event, item_id)

    print(json.dumps(make_lead(0)), flush=True)
    print(
        json.dumps(
            {
                "__done__": True,
                "delivered": 1,
                "requested": 1,
                "exhausted": False,
                "success": True,
                "target_reached": True,
            }
        ),
        flush=True,
    )


if __name__ == "__main__":
    main()
