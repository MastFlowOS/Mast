"""Fake engine: reads the JSON params Node wrote to stdin and echoes the
whole thing back as `_received_params` on the one lead it emits, then
__done__, then exits normally (code 0).

AREA-SCOPE OVERPASS FIX (Phase 13C) regression fixture — used to prove
`EngineQueryParams.area` (set from `SearchTarget.area` in
googleMapsProvider.ts) actually reaches the Python subprocess's stdin
payload, not just Node-side telemetry (`areaLabel`). Generic (echoes
every field, not just `area`), so it also works as a regression fixture
for any other future field-transmission test.
"""
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from _lead import make_lead  # noqa: E402


def main():
    raw = sys.stdin.read()
    try:
        received_params = json.loads(raw) if raw else {}
    except json.JSONDecodeError:
        received_params = {"_parse_error": raw}

    lead = make_lead(0)
    lead["_received_params"] = received_params
    print(json.dumps(lead), flush=True)
    print(
        json.dumps(
            {
                "__done__": True,
                "delivered": 1,
                "requested": 1,
                "exhausted": False,
                "success": True,
                "target_reached": True,
            }
        ),
        flush=True,
    )


if __name__ == "__main__":
    main()
