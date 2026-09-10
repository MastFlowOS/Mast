"""
street_inventory/models.py
===========================

The street identity model for Phase 2A. See package docstring
(`street_inventory/__init__.py`) for scope.

Two concepts, deliberately kept separate (per this phase's own
architectural rule):

    GLOBAL   -> StreetRecord (this module)  -> discovery_streets table
    PER USER -> NOT implemented in this phase. No field on StreetRecord,
                no column in discovery_streets, references a user.

`StreetRecord` therefore carries no `user_id`, no "completed" flag, and
no worker-claim state — those belong to a future phase's own model,
not to this one.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Literal, Mapping, Optional, Sequence

# ---------------------------------------------------------------------------
# StreetRecord — global street identity
# ---------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class StreetRecord:
    """
    One row of the GLOBAL street inventory. Mirrors the field list this
    phase's own instructions proposed for `discovery_streets`
    (street_key, street_name, normalized_name, country_code,
    country_name, region, city, source, source_id, metadata) — nothing
    added beyond that list, and no `user_id` (see module docstring).

    `street_key` is the durable canonical identity (see
    `normalization.py:build_street_key`). `source_id` is NOT part of
    that identity — it is a representative upstream reference (e.g.
    "the lowest OSM way id observed for this street name in this
    city") kept for debugging/traceability only, since one real-world
    street is frequently represented by several disjoint OSM `way`
    segments sharing one `name` tag.
    """

    street_key: str
    street_name: str
    normalized_name: str
    country_code: str
    city: str
    source: str = "overpass"
    country_name: Optional[str] = None
    region: Optional[str] = None
    source_id: Optional[str] = None
    metadata: Mapping[str, Any] = field(default_factory=dict)
    #: CRITMODE — contaminated New York inventory follow-up. Stamped by
    #: `overpass_source.py` with the boundary-resolution/verification
    #: logic's own version identifier (see that module's
    #: `BOUNDARY_VERSION`), NOT left to default here, so every row this
    #: package ever produces carries proof of which boundary-safety
    #: logic produced it. This is what lets `ensureStreetInventory()`
    #: (Node side) tell "existing rows" apart from "existing rows built
    #: under boundary logic that has since been fixed" — a bare
    #: `count(*) > 0` cannot make that distinction, which is exactly how
    #: the 114,103-row New York STATE inventory survived the original
    #: geography fix undetected. See `street_inventory/overpass_source.py`
    #: module docstring, "CRITMODE — street inventory geography bug".
    boundary_version: str = "unversioned"


# ---------------------------------------------------------------------------
# StreetInventoryResult — the "available" vs "unavailable" fallback state
# ---------------------------------------------------------------------------

#: Per this phase's own instructions ("design a clean 'street inventory
#: unavailable' fallback state" / "the later discovery layer needs to be
#: able to detect: street inventory available versus unavailable"). A
#: future discovery-orchestration phase branches on `.status`, not on
#: catching an exception — an unsupported location is an expected,
#: modeled outcome here, not a failure mode this package raises for.
StreetInventoryStatus = Literal["ok", "unavailable"]


@dataclass(frozen=True, slots=True)
class StreetInventoryResult:
    """
    The result of attempting to build a street inventory for one city.

    `status == "unavailable"` means: this source could not enumerate
    streets for this location (no OSM boundary resolved, empty result,
    transport failure, timeout, etc). `streets` is always `()` in that
    case, and `reason` carries a short, human-readable explanation for
    logs/telemetry — never raised as an exception, per this phase's own
    instruction that missing street inventory data must not crash
    discovery (see also `overpass_source.py`).

    `status == "ok"` means at least a partial, real inventory was
    obtained. An "ok" result with zero streets is possible in principle
    (a genuinely street-less area) and is treated as a valid, empty
    inventory — distinct from "unavailable", which specifically means
    "we couldn't ask" or "the ask failed", not "we asked and there are
    none".
    """

    status: StreetInventoryStatus
    streets: Sequence[StreetRecord] = field(default_factory=tuple)
    reason: Optional[str] = None
