"""Fake engine: outputs 5 leads, then outputs __done__ sentinel with:
    delivered=5, requested=20, exhausted=False, success=False,
    target_reached=False, failure_reason="CANCELLED",
    failure_detail="cooperative shutdown (SIGTERM) stopped this run"
and exits 0.
"""
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from _lead import make_lead  # noqa: E402


def main():
    sys.stdin.read()
    for i in range(5):
        print(json.dumps(make_lead(i)), flush=True)
    print(
        json.dumps(
            {
                "__done__": True,
                "delivered": 5,
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


if __name__ == "__main__":
    main()
