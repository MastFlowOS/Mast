import json
import sys
import time

sys.stdin.read()
print(
    json.dumps(
        {
            "type": "progress",
            "stage": "engine",
            "event": "service_ready",
            "seq": 0,
            "timestamp": time.time(),
        }
    ),
    flush=True,
)
print(
    json.dumps(
        {
            "type": "progress",
            "stage": "discovery",
            "event": "search_exhausted",
            "timestamp": time.time(),
        }
    ),
    flush=True,
)
seq = 0
while True:
    seq += 1
    print(
        json.dumps(
            {
                "type": "progress",
                "stage": "engine",
                "event": "heartbeat",
                "seq": seq,
                "timestamp": time.time(),
            }
        ),
        flush=True,
    )
    time.sleep(0.05)
