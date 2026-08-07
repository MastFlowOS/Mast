"""
MAST Engine V2 — Supabase Storage Backend
============================================

Source: Engine BluePrint Phase 1.5 Stage 6 ("Storage Pipeline"),
engine/contracts.py's own StoredOpportunity docstring ("Created ONLY
after a successful insert. Now it exists inside Supabase" / "Created
by: StorageWorker (Phase 8), after a successful Supabase insert"), and
workers/storage_worker.py's `_StoragePersistenceProtocol` (the
provisional, module-private persistence contract this class
implements).

Responsibility
--------------
SupabaseStorageBackend is the first concrete implementation of
`_StoragePersistenceProtocol`. It has exactly one job:

    QualifiedOpportunity -> persist() -> StoredOpportunity

by issuing one INSERT against a Supabase (PostgREST) table and
mapping the row Supabase hands back into a StoredOpportunity. It does
not validate, qualify, score, deduplicate, retry, cache, own a queue,
or own runtime state — all of that already lives elsewhere (or
doesn't apply to Storage at all) per StorageWorker's own module
docstring, "Persistence behavior".

It satisfies `_StoragePersistenceProtocol` structurally (the protocol
is `@runtime_checkable` and this class is never imported by
workers/storage_worker.py, matching that protocol's own instruction
that it "is not meant to be imported anywhere else" — this module
does not import it either; conformance is verified in
validate_storage_backend.py via `isinstance(..., Protocol)`, not by
inheritance).

What this backend does NOT do, and why
----------------------------------------
1. It does not persist `opportunity.business`, `opportunity.
   qualification`, or `opportunity.score`. StoredOpportunity
   (engine/contracts.py) carries exactly two identifiers
   (`opportunity_id`, `pipeline_id`) plus `created_at` — `user_id` and
   `business_id` were both deliberately removed in the Phase 5.8
   architecture correction documented on that class, and no other
   field was added in their place. This backend echoes that contract
   exactly rather than writing columns the contract doesn't expose a
   way to read back out; storing more than StoredOpportunity can
   represent would let this backend silently diverge from the
   contract it's supposed to satisfy. If a future milestone widens
   StoredOpportunity, this backend's insert payload should widen with
   it — not before.
2. It does not create, own, or assume a specific Supabase project.
   `supabase_url` / `supabase_key` are constructor-injected, never
   read from a hardcoded value, matching `_StoragePersistenceProtocol`
   itself being constructor-injected into StorageWorker.
3. It does not catch or retry on failure. `persist()` lets
   `urllib.error.HTTPError` / `URLError` / `KeyError` (a malformed
   response missing `id`) propagate unmodified, exactly as
   `_StoragePersistenceProtocol.persist()` requires ("Must raise on
   failure; must never return a partial StoredOpportunity") and as
   StorageWorker's own "Error handling" section requires of the
   backend it delegates to.

A flagged gap this backend does not work around
---------------------------------------------------
No migration anywhere in this repository defines a table shaped for
StoredOpportunity (searched: migrations/ has no `pipeline_id` /
`opportunity_id` table, and Engine BluePrint Phase 1.1-1.5 /
Architecture Decisions.md never name one either — the existing
`businesses` / `leads` / `scrape_jobs` tables in
migrations/001_opportunity_engine.sql belong to a different, older
system than this V2 engine's contracts). A concrete backend cannot
insert into a table that doesn't exist, so
migrations/021_qualified_opportunities.sql (added alongside this
file) defines the minimal table this backend writes to — exactly the
three StoredOpportunity columns, nothing more. This mirrors the
precedent workers/storage_worker.py itself set for a real,
undecided-by-the-architecture gap (its `_StoragePersistenceProtocol`,
item 3 in that module's own review): flagged explicitly, scoped as
narrowly as possible, and never presented as a settled architectural
decision. Table name and column shape here should be treated the same
way — provisional until a real schema decision is made, not
retroactive authorization for this backend to have picked one
silently.

Configuration
-------------
No Python-side Supabase configuration convention existed anywhere in
this codebase before this file (searched: no `supabase-py` dependency
in requirements.txt, no `SUPABASE_*` env var read anywhere under
mast-lead-engine/). The frontend's `VITE_SUPABASE_URL` /
`VITE_SUPABASE_ANON_KEY` (api/send-email.ts, api/test-smtp.ts) are
browser-exposed anon-key variables and are not reused here — this
backend runs server-side and needs to bypass Row Level Security the
same way `leads`/`businesses` writes already do elsewhere in this
project, so it reads `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`
instead, following this codebase's own `os.environ.get(...)` pattern
(utils/runtime.py) rather than introducing a new config-loading
mechanism. Both are read only as constructor *defaults* — the caller
that builds the `worker_factory` (see storage_backends/__init__.py)
can always override them explicitly.

Status
------
Phase 6.6. Uses only the standard library (`urllib`, `json`) — no new
third-party dependency added to requirements.txt, since Supabase's
REST layer (PostgREST) is plain HTTP and StorageWorker's own budget
for this call is small (DEFAULT_TIMEOUT_SECONDS = 3.0 in
workers/storage_worker.py; this module borrows the same figure as its
own HTTP timeout default rather than inventing a different one).
"""

from __future__ import annotations

import json
import os
import urllib.error
import urllib.request
from typing import Optional

from engine.contracts import QualifiedOpportunity, StoredOpportunity

#: Matches workers/storage_worker.py's DEFAULT_TIMEOUT_SECONDS for the
#: same reason that module borrowed it from engine/interfaces.py's
#: Timeout Rules table rather than inventing its own figure.
DEFAULT_HTTP_TIMEOUT_SECONDS = 3.0

#: Provisional — see module docstring, "A flagged gap this backend
#: does not work around". Overridable per instance; not sourced from
#: any architecture document.
DEFAULT_TABLE = "qualified_opportunities"


class SupabaseStorageBackendError(Exception):
    """
    Raised only for a malformed *successful* Supabase response (HTTP
    2xx body missing the `id` a fresh insert must return) — i.e. a
    problem this backend detected itself, as opposed to a network /
    HTTP failure, which propagates as the underlying
    `urllib.error.HTTPError` / `URLError` unchanged (see module
    docstring, item 3).
    """


class SupabaseStorageBackend:
    """
    Concrete `_StoragePersistenceProtocol` implementation
    (workers/storage_worker.py) backed by one Supabase table via
    PostgREST. See module docstring for full rationale; see
    `persist()` below for the one method the protocol requires.
    """

    def __init__(
        self,
        *,
        supabase_url: Optional[str] = None,
        supabase_key: Optional[str] = None,
        table: str = DEFAULT_TABLE,
        timeout_seconds: float = DEFAULT_HTTP_TIMEOUT_SECONDS,
    ) -> None:
        """
        supabase_url / supabase_key:
            Constructor-injected, defaulting to `SUPABASE_URL` /
            `SUPABASE_SERVICE_ROLE_KEY` from the environment (see
            module docstring, "Configuration"). Neither is silently
            defaulted to an empty string: a missing value raises here,
            at construction time, rather than surfacing later as an
            opaque HTTP failure from `persist()`.
        table:
            Name of the Supabase table to insert into. Defaults to
            `DEFAULT_TABLE` — see module docstring, "A flagged gap
            this backend does not work around".
        timeout_seconds:
            Per-request HTTP timeout. Defaults to
            DEFAULT_HTTP_TIMEOUT_SECONDS (mirrors
            workers/storage_worker.py's own DEFAULT_TIMEOUT_SECONDS).
        """
        resolved_url = supabase_url or os.environ.get("SUPABASE_URL")
        resolved_key = supabase_key or os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
        if not resolved_url:
            raise ValueError(
                "SupabaseStorageBackend requires supabase_url or the "
                "SUPABASE_URL environment variable."
            )
        if not resolved_key:
            raise ValueError(
                "SupabaseStorageBackend requires supabase_key or the "
                "SUPABASE_SERVICE_ROLE_KEY environment variable."
            )
        self._endpoint = f"{resolved_url.rstrip('/')}/rest/v1/{table}"
        self._key = resolved_key
        self._timeout_seconds = timeout_seconds

    # -- _StoragePersistenceProtocol -------------------------------------

    def persist(self, opportunity: QualifiedOpportunity) -> StoredOpportunity:
        """
        Insert one row for `opportunity.pipeline_id` and return the
        resulting StoredOpportunity. Reads nothing off `opportunity`
        besides `pipeline_id` — see module docstring, item 1, for why
        `business` / `qualification` / `score` are not written.

        Raises
        ------
        urllib.error.HTTPError / urllib.error.URLError
            Propagated unmodified on any network or non-2xx response —
            never caught here (see module docstring, item 3).
        SupabaseStorageBackendError
            If Supabase returns 2xx but the row it hands back has no
            `id` — a successful-looking response this backend still
            cannot honestly turn into a StoredOpportunity.
        """
        row = self._insert_row({"pipeline_id": opportunity.pipeline_id})
        if "id" not in row:
            raise SupabaseStorageBackendError(
                f"Supabase insert into table did not return an 'id' "
                f"column; got keys: {sorted(row.keys())!r}"
            )
        return StoredOpportunity(
            opportunity_id=str(row["id"]),
            pipeline_id=opportunity.pipeline_id,
            created_at=row.get("created_at"),
        )

    # -- internal ----------------------------------------------------------

    def _insert_row(self, payload: dict) -> dict:
        """
        POST one row to this backend's table via PostgREST and return
        the single inserted row Supabase hands back
        (`Prefer: return=representation`). No exception raised here is
        caught — see `persist()`'s own docstring.
        """
        body = json.dumps(payload).encode("utf-8")
        request = urllib.request.Request(
            self._endpoint,
            data=body,
            method="POST",
            headers={
                "apikey": self._key,
                "Authorization": f"Bearer {self._key}",
                "Content-Type": "application/json",
                "Prefer": "return=representation",
            },
        )
        with urllib.request.urlopen(
            request, timeout=self._timeout_seconds
        ) as response:
            rows = json.loads(response.read().decode("utf-8"))
        if not rows:
            raise SupabaseStorageBackendError(
                "Supabase insert returned an empty result set."
            )
        return rows[0]
