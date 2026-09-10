"""
street_inventory/build.py
===========================

Orchestration entry point for Phase 2A: fetch a city's street
inventory from OSM/Overpass (`overpass_source.py`) and persist it
(`repository.py`). This is the ONLY place that wires those two pieces
together — deliberately not inside a worker, a queue, or the existing
area discovery path (see this phase's own "DO NOT WIRE WORKERS YET").

Run manually, e.g. via `validate_street_inventory.py`, or from a
one-off script / scheduled job a future phase may add — this module
itself does not register a cron, a CLI, or a worker, since none of
those were asked for in Phase 2A.
"""

from __future__ import annotations

import logging
from typing import Optional

from street_inventory.models import StreetInventoryResult
from street_inventory.overpass_source import fetch_city_street_inventory
from street_inventory.repository import SupabaseStreetInventoryRepository

log = logging.getLogger(__name__)


def build_city_street_inventory(
    *,
    country_code: str,
    city: str,
    country_name: Optional[str] = None,
    region: Optional[str] = None,
    area_name: Optional[str] = None,
    repository: Optional[SupabaseStreetInventoryRepository] = None,
    **fetch_kwargs,
) -> dict:
    """
    Fetches and persists the street inventory for one city.

    Returns a summary dict:

        {"status": "ok", "fetched": N, "upserted": N, "batches": M}
        {"status": "unavailable", "reason": "..."}

    A `status="unavailable"` result is NOT an error this function
    raises for — per this phase's own instruction that missing street
    inventory data must not crash discovery, an unsupported city simply
    reports why and returns normally. `repository` defaults to a real
    `SupabaseStreetInventoryRepository()` (reading `SUPABASE_URL` /
    `SUPABASE_SERVICE_ROLE_KEY` from the environment); inject a fake to
    test this function without a real Supabase project (see
    `tests/test_street_inventory.py`).
    """
    result: StreetInventoryResult = fetch_city_street_inventory(
        country_code=country_code,
        city=city,
        country_name=country_name,
        region=region,
        area_name=area_name,
        **fetch_kwargs,
    )

    if result.status == "unavailable":
        log.info("[street-inventory] unavailable for city=%r: %s", city, result.reason)
        return {"status": "unavailable", "reason": result.reason}

    # STAGE 4/4: persistence. See repository.py's own upsert_streets() for
    # per-batch progress/timing logs — this line just marks the boundary
    # between "fetched from Overpass" and "handed to the DB layer" so a
    # reader of the logs can tell which side of that line execution was
    # on when it stalled.
    log.info("[street-inventory] persisting city=%r fetched=%d", city, len(result.streets))
    repo = repository or SupabaseStreetInventoryRepository()
    upsert_summary = repo.upsert_streets(list(result.streets))

    log.info(
        "[street-inventory] city=%r fetched=%d upserted=%d batches=%d",
        city,
        len(result.streets),
        upsert_summary["upserted"],
        upsert_summary["batches"],
    )
    return {
        "status": "ok",
        "fetched": len(result.streets),
        "upserted": upsert_summary["upserted"],
        "batches": upsert_summary["batches"],
    }
