"""Fake engine: emits several leads with a short delay between each, then
__done__. Used so a Node-side test can `break` out of the `for await` after
the first lead — exercising runEngineQuery()'s "consumer stopped iterating
early" cleanup path (gracefulKillProcessTree in its `finally`), which is
exactly the call path the exit-lifecycle race lived in.

Has no SIGTERM handler installed, so Python's default disposition (terminate)
applies — it exits promptly once Node sends SIGTERM during cleanup.
"""
import json
import os
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from _lead import make_lead  # noqa: E402


def main():
    sys.stdin.read()
    for i in range(5):
        print(json.dumps(make_lead(i)), flush=True)
        time.sleep(0.2)
    print(
        json.dumps(
            {
                "__done__": True,
                "delivered": 5,
                "requested": 5,
                "exhausted": True,
                "success": True,
            }
        ),
        flush=True,
    )


if __name__ == "__main__":
    main()
