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
import tempfile
import time

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from _lead import make_lead  # noqa: E402

delivered_count = 0


def _on_sigterm(signum, frame):
    stop_file = os.path.join(tempfile.gettempdir(), f"mast_stop_{os.getpid()}.txt")
    reason = None
    if os.path.exists(stop_file):
        try:
            with open(stop_file, "r", encoding="utf-8") as f:
                reason = f.read().strip()
        except Exception:
            pass

    if reason == "TARGET_REACHED":
        print(
            json.dumps(
                {
                    "__done__": True,
                    "delivered": delivered_count,
                    "requested": 20,
                    "exhausted": False,
                    "success": True,
                    "target_reached": True,
                    "termination_reason": "SUCCESS_TARGET_REACHED",
                }
            ),
            flush=True,
        )
    else:
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
                    "failure_detail": f"cooperative shutdown (SIGTERM, reason={reason}) stopped this run before requested quantity",
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
    stop_file = os.path.join(tempfile.gettempdir(), f"mast_stop_{os.getpid()}.txt")
    for i in range(20):
        if os.path.exists(stop_file):
            _on_sigterm(None, None)
        delivered_count += 1
        print(json.dumps(make_lead(i)), flush=True)
        time.sleep(0.02)
        if os.path.exists(stop_file):
            _on_sigterm(None, None)
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
