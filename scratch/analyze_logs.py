import re
from collections import Counter

patterns = {
    "known_ids": re.compile(r"\[maps\]\[known-ids\].*"),
    "candidate_rejected": re.compile(r".*candidate_rejected.*|.*\[Event:candidate_rejected\].*"),
    "no_usable_channel": re.compile(r".*no_usable_channel.*"),
    "duplicate": re.compile(r".*duplicate.*", re.IGNORECASE),
    "closed_perm": re.compile(r".*permanently closed.*", re.IGNORECASE),
    "closed_temp": re.compile(r".*temporarily closed.*", re.IGNORECASE),
    "pre_click_skip": re.compile(r".*\[pre-click\].*"),
}

for log_path in [".logs_analysis.txt", "scratch/worker_log_clean_utf8.txt"]:
    print(f"\n==================== Analyzing {log_path} ====================")
    counts = Counter()
    samples = {k: [] for k in patterns}
    try:
        with open(log_path, "r", encoding="utf-8", errors="ignore") as f:
            for line_no, line in enumerate(f, 1):
                for k, pat in patterns.items():
                    if pat.search(line):
                        counts[k] += 1
                        if len(samples[k]) < 5:
                            samples[k].append((line_no, line.strip()))
    except Exception as e:
        print(f"Error reading {log_path}: {e}")
        continue

    for k, v in counts.items():
        print(f"Count of {k}: {v}")
    print("\n--- Samples ---")
    for k, s_list in samples.items():
        if s_list:
            print(f"\nSample {k}:")
            for lno, text in s_list:
                print(f"  Line {lno}: {text[:140]}")
