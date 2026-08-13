"""
Mast Lead Engine — Phase 3C-4B: Early Persistent Dedup Before Enrichment.

Phase 3C-4A confirmed (see that phase's report):
  * raw Maps candidates already contain a Maps URL with a stable place
    identifier
  * storage/dedup.py's normalization already knows how to derive
    `place:` / `map:` identity from that URL
  * persistent duplicate detection currently only happens AFTER the
    expensive Website/Instagram/Contact enrichment pipeline, in Node
    (src/scraperBridge/deliverLead.ts::findExistingBusiness, an overlap
    query against businesses.fingerprints in Supabase)

This module adds the early half of that check: a cheap, fail-open
lookup against the SAME `businesses` table / fingerprint-overlap
semantics, run the moment a BusinessCandidate exists (before any
enrichment worker has done any work), so a business the user already
has never pays for a website fetch, an Instagram profile fetch, or a
contact-discovery pass just to be thrown away afterward.

This is explicitly NOT a new identity mechanism:
  * `early_fingerprint_keys()` calls straight into storage/dedup.py's
    own normalizers (`norm_maps_place_id`, `norm_maps_link`,
    `norm_phone`) and utils/parsing.py's `domain_of` — nothing here
    reimplements normalization.
  * `PersistentEarlyDedupChecker` queries the exact same table
    (`businesses`) and the exact same column (`fingerprints`, via
    Postgres array-overlap) that `findExistingBusiness` already does —
    just earlier, and with a narrower key set (see below).

Why the key set is narrower than storage/dedup.py's full
`fingerprints_for()`
-------------------------------------------------------------------
`fingerprints_for()` can use `ig:` / `email:` / `fb:` / the
city-qualified `name:...|...` key — all of which require enrichment
(or, for the name+city key, deliberately excluded here anyway, see
below) that hasn't happened yet at discovery time. A BusinessCandidate
(engine/contracts.py) only ever carries `maps_url`, and *sometimes*
`website` / `phone` when the Maps provider happens to expose them
directly — nothing else `fingerprints_for()` knows how to key on. So
this module only ever derives:

    1. place: — stable Google Maps place id (preferred; from maps_url)
    2. map:   — cleaned maps URL, only when no place id could be found
    3. web:   — website domain, IF the candidate already has one
    4. tel:   — phone, IF the candidate already has one

It deliberately never derives a bare `name:` key (name alone was
already identified in Phase 3C-4A / storage/dedup.py's own C2 fix as
unsafe — two unrelated businesses sharing a common name in different
cities collide on it). It also never derives the city-qualified
`name:<name>|<city>` key here, even though both fields exist on
BusinessCandidate: Step 1 of this phase names exactly three preferred
early identity sources (Maps place id, website, phone) and name-based
matching — even city-qualified — is not one of them. Skipping it costs
nothing: `findExistingBusiness` still applies the full fingerprint set,
name+city included, as the final safety net.

Fail-open, by design
---------------------
`PersistentEarlyDedupChecker.is_duplicate()` never raises out to the
discovery pipeline. A missing config, a network hiccup, or a malformed
response is always treated as "no early match found" — i.e. the
candidate proceeds to enrichment exactly as it would have before this
phase existed. This is intentional and matches Step 4's own framing:
early dedup is a fast-reject *optimization*, not a correctness
guarantee. The existing final dedup (findExistingBusiness) remains
authoritative and is completely unmodified by this module.
"""

from __future__ import annotations

import json
import os
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from typing import Iterable, Optional

from storage.dedup import norm_maps_link, norm_maps_place_id, norm_phone
from utils.parsing import domain_of
from utils.runtime import get_logger

log = get_logger("early_dedup")

#: Matches storage_backends/supabase_backend.py's own HTTP timeout budget
#: for the same reason that module gives: PostgREST is plain HTTP and this
#: call sits directly in the discovery hot path, so it borrows the same
#: figure rather than inventing a different one.
DEFAULT_HTTP_TIMEOUT_SECONDS = 3.0

DEFAULT_TABLE = "businesses"


def early_fingerprint_keys(
    *,
    maps_url: Optional[str] = None,
    website: Optional[str] = None,
    phone: Optional[str] = None,
) -> set[str]:
    """
    Derive ONLY the identity keys that are safe and available before any
    enrichment has run. See module docstring for exactly which four key
    types this can ever produce and why.

    Accepts plain fields rather than a BusinessCandidate directly so it
    stays trivially unit-testable and has no import-time dependency on
    `engine.contracts` (mirrors storage/dedup.py's own `fingerprints_for`,
    which takes a plain dict for the same reason).
    """
    keys: set[str] = set()

    place = norm_maps_place_id(maps_url)
    if place:
        keys.add(f"place:{place.lower()}")

    link = norm_maps_link(maps_url)
    if link and not link.startswith("place:"):
        keys.add(f"map:{link}")

    dom = domain_of(website)
    if dom:
        keys.add(f"web:{dom}")

    phone_digits = norm_phone(phone)
    if len(phone_digits) >= 10:
        keys.add(f"tel:{phone_digits[-10:]}")
    elif 7 <= len(phone_digits) < 10:
        keys.add(f"tel:{phone_digits}")

    return keys


@dataclass(frozen=True)
class EarlyDedupDecision:
    """One decision record — see Phase 3C-4B Step 5 for the required
    fields. `scrape_job_id` is carried purely for log correlation with
    the Node-side dedup-waste-audit log lines; it is genuinely not
    available to the Python engine on the live path today (pythonBridge.ts
    never threads it into service.py/run_query — see deliverLead.ts's own
    `scrapeJobId` doc comment for the equivalent, pre-existing limitation
    on the final-dedup side), so it defaults to None rather than being
    guessed at or invented here."""

    pipeline_id: str
    session_id: Optional[str]
    scrape_job_id: Optional[str]
    maps_place_id: Optional[str]
    fingerprint_keys: tuple[str, ...]
    is_duplicate: bool
    # False when there were no usable early keys, or no checker was
    # configured at all — i.e. this candidate always falls through to
    # normal enrichment + the final dedup safety net, per Test C.
    checked: bool


def maps_place_id_from_keys(keys: Iterable[str]) -> Optional[str]:
    for k in keys:
        if k.startswith("place:"):
            return k[len("place:"):]
    for k in keys:
        if k.startswith("map:"):
            return k[len("map:"):]
    return None


def log_early_dedup_decision(decision: EarlyDedupDecision) -> None:
    """One structured log line per candidate — never one line per internal
    fingerprint comparison (Step 5's "do not spam" instruction). Mirrors
    src/lib/dedupWasteAudit.ts's `[dedup-waste-audit][<pipelineId>] ...`
    convention so both sides of one candidate's journey can be grepped
    together by pipeline id. Goes through the standard `mast.early_dedup`
    logger, which utils/runtime.py already routes to stderr — never stdout,
    which must carry nothing but the lead/progress protocol JSON (see that
    module's own comment on why). Never allowed to raise into the discovery
    pipeline — logging failures must never affect discovery."""
    try:
        decision_label = (
            "EARLY_DUPLICATE" if decision.is_duplicate
            else ("EARLY_NEW" if decision.checked else "EARLY_SKIPPED_NO_IDENTITY")
        )
        fields = {
            "scrapeJobId": decision.scrape_job_id,
            "pipelineId": decision.pipeline_id,
            "sessionId": decision.session_id,
            "mapsPlaceId": decision.maps_place_id,
            "fingerprint": list(decision.fingerprint_keys),
            "early_duplicate": decision.is_duplicate,
            "enrichment_started": not decision.is_duplicate,
        }
        log.info("[dedup-waste-audit][%s] %s %s", decision.pipeline_id, decision_label, json.dumps(fields))
    except Exception:
        log.debug("log_early_dedup_decision failed — ignored", exc_info=True)


class PersistentEarlyDedupError(Exception):
    """Raised only at construction time, for a genuine configuration
    mistake (missing SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY) — the caller
    should know about that immediately, not have it silently masked by
    is_duplicate()'s fail-open behavior on every single candidate."""


class PersistentEarlyDedupChecker:
    """
    Cheap, fail-open lookup against the existing `businesses` table's
    `fingerprints` column — the exact persistent store
    deliverLead.ts::findExistingBusiness already reads, just reached one
    HTTP hop earlier via Supabase's PostgREST layer instead of
    supabase-js (mirrors the constructor-injected URL/key pattern
    storage_backends/supabase_backend.py already established for this
    engine's Python side, rather than inventing a second convention).

    Deliberately does not replace or wrap LeadStore (storage/dedup.py) —
    that remains the in-run, in-process hot cache it always was. This
    checker is the persistent, cross-run counterpart Step 2 asks for.
    """

    def __init__(
        self,
        *,
        supabase_url: Optional[str] = None,
        supabase_key: Optional[str] = None,
        table: str = DEFAULT_TABLE,
        timeout_seconds: float = DEFAULT_HTTP_TIMEOUT_SECONDS,
    ) -> None:
        resolved_url = supabase_url or os.environ.get("SUPABASE_URL")
        resolved_key = supabase_key or os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
        if not resolved_url or not resolved_key:
            raise PersistentEarlyDedupError(
                "PersistentEarlyDedupChecker requires supabase_url/supabase_key "
                "(or the SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY environment "
                "variables)."
            )
        self._endpoint = f"{resolved_url.rstrip('/')}/rest/v1/{table}"
        self._key = resolved_key
        self._timeout_seconds = timeout_seconds

    def is_duplicate(self, fingerprint_keys: Iterable[str]) -> bool:
        """Return True only when a `businesses` row already exists whose
        `fingerprints` array overlaps `fingerprint_keys`. Fails open (False)
        on any config/network/parsing problem — see class + module
        docstrings. Never performs a lookup for an empty key set (there is
        nothing safe to match on): Test C's "no usable early identity"
        candidates simply fall straight through to enrichment."""
        keys = sorted({k for k in fingerprint_keys if k})
        if not keys:
            return False

        overlap_literal = "{" + ",".join(_pg_array_element(k) for k in keys) + "}"
        query = urllib.parse.urlencode(
            {"select": "id", "fingerprints": f"ov.{overlap_literal}", "limit": "1"}
        )
        request = urllib.request.Request(
            f"{self._endpoint}?{query}",
            method="GET",
            headers={
                "apikey": self._key,
                "Authorization": f"Bearer {self._key}",
                "Accept": "application/json",
            },
        )
        try:
            with urllib.request.urlopen(request, timeout=self._timeout_seconds) as response:
                rows = json.loads(response.read().decode("utf-8"))
        except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError, ValueError, OSError):
            log.debug("early dedup lookup failed — failing open (treated as NEW)", exc_info=True)
            return False
        return bool(rows)


def _pg_array_element(value: str) -> str:
    """Quote one element for a Postgres array-literal string
    (`{"a","b"}`), matching PostgREST's expected `ov.{...}` filter syntax.
    Fingerprint keys are always our own `prefix:normalized-value` strings
    (storage/dedup.py), so nothing here ever needs to handle embedded
    quotes in practice — escaped defensively anyway since this string
    gets sent over the wire."""
    escaped = value.replace("\\", "\\\\").replace('"', '\\"')
    return f'"{escaped}"'
