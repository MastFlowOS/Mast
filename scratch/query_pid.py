import csv
import sys

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
LOG_FILE = r"c:\Users\Beboo\Downloads\logs.1793746802525.csv"

def query_logs(filter_fn):
    with open(LOG_FILE, "r", encoding="utf-8", errors="replace") as f:
        reader = csv.DictReader(f)
        for r in reader:
            if filter_fn(r):
                print(f"[{r['timestamp']}] [{r['severity']}] {r['message']}")

if __name__ == "__main__":
    needle = sys.argv[1] if len(sys.argv) > 1 else "PID: 13"
    print(f"Querying for {needle}...")
    query_logs(lambda r: needle in r["message"])
