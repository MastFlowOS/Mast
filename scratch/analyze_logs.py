import csv
import json
import re
import sys

# Force utf-8 stdout
sys.stdout.reconfigure(encoding="utf-8", errors="replace")

LOG_FILE = r"c:\Users\Beboo\Downloads\logs.1793746802525.csv"

def load_logs():
    with open(LOG_FILE, "r", encoding="utf-8", errors="replace") as f:
        reader = csv.DictReader(f)
        return list(reader)

def dump_section(title, predicate, limit=100, out_file=None):
    rows = load_logs()
    filtered = [r for r in rows if predicate(r)]
    lines = [f"\n{'='*20} {title} (Total: {len(filtered)}) {'='*20}"]
    for r in filtered[:limit]:
        lines.append(f"[{r['timestamp']}] [{r['severity']}] {r['message']}")
    if len(filtered) > limit:
        lines.append(f"... ({len(filtered) - limit} more records truncated)")
    text = "\n".join(lines)
    print(text)
    if out_file:
        with open(out_file, "a", encoding="utf-8") as f:
            f.write(text + "\n")

if __name__ == "__main__":
    print("Dumping log sections...")
    dump_section("1. Panel wait & Feed logs", lambda r: any(k in r["message"].lower() for k in ["place_panel_wait", "m6qerb", "feed", "panel wait"]))
    dump_section("2. Browser Lifecycle & Return to Results", lambda r: any(k in r["message"].lower() for k in ["return_to_results", "finally_after_card", "page.goto", "target closed", "page closed", "context closed"]))
    dump_section("3. Watchdog & Heartbeat", lambda r: any(k in r["message"].lower() for k in ["watchdog", "scrolling progress", "stalled", "no_progress"]))
    dump_section("4. Candidate & Enrichment Pipeline", lambda r: any(k in r["message"].lower() for k in ["candidate-audit", "delivering", "delivered", "rejected", "post_enrichment_channel_gate"]))
    dump_section("5. Retrying & Task State", lambda r: any(k in r["message"].lower() for k in ["retrying", "task outcome", "recordtaskoutcome", "discovery_plans"]))
    dump_section("6. Warnings & Infrastructure", lambda r: any(k in r["message"].lower() for k in ["deadlineexceeded", "containerd", "cgroup", "cdi", "provider credentials"]))
