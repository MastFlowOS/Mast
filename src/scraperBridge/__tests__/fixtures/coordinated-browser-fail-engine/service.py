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

    # 4. Simulate browser/driver launch failure
    sys.stderr.write("[ERROR] Playwright driver launch failed: connection refused / timeout\n")
    # Exits without emitting MAST_JOB_TERMINATED because ownership/cleanup could not be verified
    sys.exit(1)

if __name__ == "__main__":
    main()
