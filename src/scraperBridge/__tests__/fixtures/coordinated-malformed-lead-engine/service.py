import json
import os
import sys

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

    # 4. Stream malformed line, then valid lead, then __done__
    sys.stdout.write("MALFORMED NON-JSON LINE {\"broken\": [1, 2,\n")
    sys.stdout.flush()

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

    # 5. Emit MAST_JOB_TERMINATED
    term_msg = {
        "type": "MAST_JOB_TERMINATED",
        "scoutId": scout_id,
        "nonce": nonce,
        "status": "CONFIRMED",
    }
    sys.stdout.write(json.dumps(term_msg) + "\n")
    sys.stdout.flush()

if __name__ == "__main__":
    main()
