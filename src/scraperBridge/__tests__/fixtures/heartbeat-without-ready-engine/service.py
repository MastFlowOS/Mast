import json
import sys
import time

sys.stdin.read()
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
