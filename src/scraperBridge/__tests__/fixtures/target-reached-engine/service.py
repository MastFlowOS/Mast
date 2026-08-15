"""Fake engine: yields leads (up to 20) with a delay between each.
When it receives SIGTERM, it outputs __done__ sentinel with:
    delivered=count, requested=20, exhausted=False, success=False,
    target_reached=False, failure_reason="CANCELLED",
    failure_detail="cooperative shutdown stopped this run"
and exits 0.
"""
import json
import os
import signal
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from _lead import make_lead  # noqa: E402

delivered_count = 0


def _on_sigterm(signum, frame):
    print(
        json.dumps(
            {
                "__done__": True,
                "delivered": delivered_count,
                "requested": 20,
                "exhausted": False,
                "success": False,
                "target_reached": False,
                "failure_reason": "CANCELLED",
                "failure_detail": "cooperative shutdown (SIGTERM) stopped this run before requested quantity",
            }
        ),
        flush=True,
    )
    sys.exit(0)


def main():
    global delivered_count
    if sys.platform != "win32":
        signal.signal(signal.SIGTERM, _on_sigterm)
    sys.stdin.read()
    for i in range(20):
        delivered_count += 1
        print(json.dumps(make_lead(i)), flush=True)
        time.sleep(0.05)
    print(
        json.dumps(
            {
                "__done__": True,
                "delivered": delivered_count,
                "requested": 20,
                "exhausted": True,
                "success": True,
                "target_reached": True,
            }
        ),
        flush=True,
    )


if __name__ == "__main__":
    main()
