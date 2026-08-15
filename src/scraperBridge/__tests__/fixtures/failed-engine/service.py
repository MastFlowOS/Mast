import json
import sys

def main():
    sys.stdin.read()
    print(
        json.dumps(
            {
                "__done__": True,
                "delivered": 0,
                "requested": 10,
                "exhausted": False,
                "success": False,
                "target_reached": False,
                "failure_reason": "SCRAPER_ERROR",
                "failure_detail": "BusinessCandidate error",
            }
        ),
        flush=True,
    )

if __name__ == "__main__":
    main()
