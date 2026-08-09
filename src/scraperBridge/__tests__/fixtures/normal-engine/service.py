"""Fake engine: emits one lead, then __done__, then exits normally (code 0).
Used to test the ordinary "runEngineQuery reads to completion" path.
"""
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from _lead import make_lead  # noqa: E402


def main():
    sys.stdin.read()  # drain the params payload Node writes to stdin; unused here
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
