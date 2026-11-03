import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from _lead import make_lead  # noqa: E402


def main():
    scout_id = os.environ.get("MAST_SCOUT_SESSION_ID", "default_scout")
    nonce = os.environ.get("MAST_STARTUP_NONCE", "default_nonce")
    job_name = os.environ.get("MAST_JOB_NAME", f"Local\\MAST_JOB_{scout_id}_{nonce}")

    # 1. First READY
    ready_msg = {
        "type": "MAST_JOB_READY",
        "scoutId": scout_id,
        "jobName": job_name,
        "nonce": nonce,
        "pid": os.getpid(),
    }
    sys.stdout.write(json.dumps(ready_msg) + "\n")
    sys.stdout.flush()

    # 2. ACK
    ack_line = sys.stdin.readline()
    params = sys.stdin.read()

    # 3. Emit a lead
    print(json.dumps(make_lead(0)), flush=True)

    # 4. Emit a DUPLICATE READY
    sys.stdout.write(json.dumps(ready_msg) + "\n")
    sys.stdout.flush()


if __name__ == "__main__":
    main()
