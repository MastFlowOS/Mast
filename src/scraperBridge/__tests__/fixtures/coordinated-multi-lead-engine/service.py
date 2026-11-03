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

    # 4. Stream progress events and leads
    print(json.dumps({"type": "progress", "stage": "startup", "event": "service_ready"}), flush=True)

    place_ids = [
        "ChIJN1t_tDeuEmsRUsoyG83frY4",
        "ChIJd8BlQ2BZwokRAFUEcm_qrcA",
        "ChIJ2eUgeAK6j4ARMBFcjdDvFre",
    ]

    for idx, pid in enumerate(place_ids):
        print(json.dumps({"type": "progress", "stage": "extraction", "event": "card_attempt_started", "item_id": pid}), flush=True)
        lead = make_lead(idx)
        lead["place_id"] = pid
        lead["maps_link"] = f"https://www.google.com/maps/place/?q=place_id:{pid}"
        print(json.dumps(lead), flush=True)
        print(json.dumps({"type": "progress", "stage": "extraction", "event": "candidate_discovered", "item_id": pid}), flush=True)

    print(
        json.dumps(
            {
                "__done__": True,
                "delivered": len(place_ids),
                "requested": len(place_ids),
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
