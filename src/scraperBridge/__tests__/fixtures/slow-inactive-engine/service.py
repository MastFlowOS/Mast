"""Fake engine: emits one lead, then goes silent on stdout for much longer
than the test's SCRAPER_SUBPROCESS_INACTIVITY_MS, without ever emitting
__done__ on its own. Used to test the inactivity watchdog -> graceful
SIGTERM -> child exit path (runEngineQuery must settle, not hang, once the
watchdog fires).

No SIGTERM handler installed, so Python's default disposition (terminate)
applies once Node's watchdog sends SIGTERM.
"""
import json
import os
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from _lead import make_lead  # noqa: E402


def main():
    sys.stdin.read()
    print(json.dumps(make_lead(0)), flush=True)
    # Long enough that the test's tiny inactivity watchdog fires well before
    # this returns on its own; SIGTERM (Python's default disposition:
    # terminate) is what actually ends this process during the test.
    time.sleep(60)


if __name__ == "__main__":
    main()
