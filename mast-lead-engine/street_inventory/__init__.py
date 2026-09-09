"""
MAST Engine V2 — Global Street Inventory (Phase 2A)
=====================================================

Source: MAST_PHASE_2A_GLOBAL_STREET_INVENTORY.txt (this milestone's own
instructions), providers/overpass_provider.py (read for precedent on the
"injectable HTTP callable defaulting to a real network call" transport
pattern and Overpass QL construction, not modified), and
providers/provider_request_translation.py:normalize_osm_area (reused,
not reimplemented, for area-name resolution).

Scope
-----
This package builds and persists the GLOBAL street inventory only:

    discovery_streets
        = canonical identity of a geographic street

It deliberately does NOT implement, and nothing in this package should
be extended to implement without a new phase:

    - per-user street completion/coverage state
    - street claiming for workers
    - any change to the existing area worker pool / area rotation system

See this package's own modules for the street identity model
(`models.py`), deterministic normalization (`normalization.py`), the
Overpass-backed inventory source (`overpass_source.py`), the Supabase
persistence backend (`repository.py`), and the orchestration entry
point (`build.py`).
"""

from __future__ import annotations

from street_inventory.models import StreetInventoryResult, StreetRecord
from street_inventory.normalization import build_street_key, normalize_street_name

__all__ = [
    "StreetRecord",
    "StreetInventoryResult",
    "normalize_street_name",
    "build_street_key",
]
