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
        sys.exit(79)

    # 3. Read query payload
    params_raw = sys.stdin.read()
    if not params_raw:
        sys.exit(1)

    # 4. Stream lead and __done__
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

    # 5. Emit malformed line pretending to be termination
    sys.stdout.write("{\"type\": \"MAST_JOB_TERMINATED\", unclosed_json: \n")
    sys.stdout.flush()


if __name__ == "__main__":
    main()
