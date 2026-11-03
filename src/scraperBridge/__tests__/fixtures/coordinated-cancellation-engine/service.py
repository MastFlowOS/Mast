import json
import os
import signal
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from _lead import make_lead  # noqa: E402

def main():
    scout_id = os.environ.get("MAST_SCOUT_SESSION_ID", "default_scout")
    nonce = os.environ.get("MAST_STARTUP_NONCE", "default_nonce")
    job_name = os.environ.get("MAST_JOB_NAME", f"Local\\MAST_JOB_{scout_id}_{nonce}")

    # 1. Emit MAST_JOB_READY
    ready_msg = {
        "type": "MAST_JOB_READY",
        "scoutId": scout_id,
        "jobName": job_name,
        "nonce": nonce,
        "pid": os.getpid(),
    }
    sys.stdout.write(json.dumps(ready_msg) + "\n")
    sys.stdout.flush()

    # 2. Read MAST_JOB_ACK
    ack_line = sys.stdin.readline()
    if not ack_line:
        sys.stderr.write("[FATAL] No ACK received\n")
        sys.exit(79)

    ack = json.loads(ack_line.strip())
    if ack.get("type") != "MAST_JOB_ACK" or ack.get("status") != "CONFIRMED" or ack.get("nonce") != nonce:
        sys.stderr.write(f"[FATAL] Invalid ACK: {ack}\n")
        sys.exit(79)

    # 3. Read query payload
    params_raw = sys.stdin.read()
    if not params_raw:
        sys.stderr.write("[FATAL] No query params received\n")
        sys.exit(1)

    # 4. Stream 1 lead
    print(json.dumps(make_lead(0)), flush=True)

    terminated = [False]

    def handle_signal(sig, frame):
        if not terminated[0]:
            terminated[0] = True
            # Graceful cleanup
            print(
                json.dumps(
                    {
                        "__done__": True,
                        "delivered": 1,
                        "requested": 10,
                        "exhausted": False,
                        "success": False,
                        "target_reached": False,
                        "failure_reason": "CANCELLED",
                    }
                ),
                flush=True,
            )
            # Emit MAST_JOB_TERMINATED
            term_msg = {
                "type": "MAST_JOB_TERMINATED",
                "scoutId": scout_id,
                "nonce": nonce,
                "status": "CONFIRMED",
            }
            sys.stdout.write(json.dumps(term_msg) + "\n")
            sys.stdout.flush()
            sys.exit(0)

    try:
        signal.signal(signal.SIGTERM, handle_signal)
        signal.signal(signal.SIGINT, handle_signal)
    except Exception:
        pass

    # Wait for cancellation signal or timeout
    for _ in range(100):
        time.sleep(0.1)

if __name__ == "__main__":
    main()
