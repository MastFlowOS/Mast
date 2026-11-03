import json
import os
import sys

def main():
    scout_id = os.environ.get("MAST_SCOUT_SESSION_ID", "default_scout")
    job_name = os.environ.get("MAST_JOB_NAME", "Local\\MAST_JOB_test")

    # Emit corrupted nonce
    ready_msg = {
        "type": "MAST_JOB_READY",
        "scoutId": scout_id,
        "jobName": job_name,
        "nonce": "corrupted_bad_nonce_1234567890",
        "pid": os.getpid(),
    }
    sys.stdout.write(json.dumps(ready_msg) + "\n")
    sys.stdout.flush()

    sys.stdin.read()

if __name__ == "__main__":
    main()
