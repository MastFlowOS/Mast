import json
import os
import sys

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

    # 4. Empty search: 0 leads delivered, immediately done
    print(
        json.dumps(
            {
                "__done__": True,
                "delivered": 0,
                "requested": 1,
                "exhausted": True,
                "success": True,
                "target_reached": False,
            }
        ),
        flush=True,
    )

    # 5. Empty ownership confirmed -> emit MAST_JOB_TERMINATED
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
