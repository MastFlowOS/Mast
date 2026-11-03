import json
import os
import sys

def main():
    nonce = os.environ.get("MAST_STARTUP_NONCE", "default_nonce")
    job_name = os.environ.get("MAST_JOB_NAME", "Local\\MAST_JOB_test")

    # Emit wrong scoutId
    ready_msg = {
        "type": "MAST_JOB_READY",
        "scoutId": "completely_wrong_scout_id",
        "jobName": job_name,
        "nonce": nonce,
        "pid": os.getpid(),
    }
    sys.stdout.write(json.dumps(ready_msg) + "\n")
    sys.stdout.flush()

    sys.stdin.read()

if __name__ == "__main__":
    main()
