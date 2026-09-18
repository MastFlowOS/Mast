"""Fake engine with the REAL lead shape: the dicts the production engine emits
(`_candidate_dict` on the discovery-only/live path, `_opportunity_to_lead_dict`
on the full pipeline) have NO `niche` key, while Google's own `category` is
present. The other fixtures reuse `_lead.make_lead()`, which hard-codes
`"niche": "test"` — exactly why the dropped-niche bug went unnoticed.

Emits two leads per run, named after the query so tests can tell which
engine call produced which lead. Echoes the params it received as
`_received_params` so tests can assert what niche actually reached the
engine's stdin.
"""
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from _lead import make_lead  # noqa: E402


def main():
    raw = sys.stdin.read()
    params = json.loads(raw) if raw else {}
    query = params.get("query", "")
    for i in range(2):
        lead = make_lead(i)
        lead.pop("niche")  # real engine output has no `niche`
        lead["name"] = f"{query} #{i}"
        lead["query"] = query
        lead["category"] = "Coffee shop"  # Google's category, NOT the discovery niche
        lead["fingerprints"] = [f"fp:{query}:{i}"]
        lead["_received_params"] = params
        print(json.dumps(lead), flush=True)
    print(
        json.dumps(
            {"__done__": True, "delivered": 2, "requested": 2, "exhausted": True, "success": True}
        ),
        flush=True,
    )


if __name__ == "__main__":
    main()
