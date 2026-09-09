"""
street_inventory/repository.py
================================

Persistence for the GLOBAL street inventory (`discovery_streets`
table; see `migrations/028_discovery_streets.sql`). Mirrors
`storage_backends/supabase_backend.py`'s own conventions exactly
(constructor-injected `supabase_url`/`supabase_key` defaulting to the
`SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` environment variables,
stdlib-only `urllib`/`json` HTTP, "let network/HTTP errors propagate
unmodified" error handling) rather than inventing a second Python-side
Supabase configuration convention.

Upsert, not insert
-------------------
Unlike `SupabaseStorageBackend.persist()` (one-row INSERT of a brand
new opportunity), this backend UPSERTs on `street_key` — this phase's
own instructions require the inventory to be "safely refreshable"
without creating duplicate rows or destructive refresh logic, and for
existing street records to "retain stable IDs/keys when the same
street is encountered again". PostgREST's own `Prefer:
resolution=merge-duplicates` header combined with the `street_key`
uniqueness constraint (migration 028) is exactly the deterministic
upsert primitive this needs, without this backend needing to first
SELECT to decide insert-vs-update itself.

Batching
--------
`upsert_streets()` sends `records` in fixed-size batches (default 500
rows/request) rather than one HTTP request per street — a city can
have several thousand named streets, and one-request-per-row would be
exactly the N+1 insertion pattern this phase's own "Performance"
section rules out.
"""

from __future__ import annotations

import json
import os
import urllib.error
import urllib.request
from typing import Any, Sequence

from street_inventory.models import StreetRecord

DEFAULT_HTTP_TIMEOUT_SECONDS = 30.0
DEFAULT_TABLE = "discovery_streets"
DEFAULT_BATCH_SIZE = 500


def _street_record_to_row(record: StreetRecord) -> dict[str, Any]:
    """
    Maps one `StreetRecord` to exactly the `discovery_streets` columns
    migration 028 defines. No `user_id`, no worker-claim columns — see
    package docstring for why.
    """
    return {
        "street_key": record.street_key,
        "street_name": record.street_name,
        "normalized_name": record.normalized_name,
        "country_code": record.country_code,
        "country_name": record.country_name,
        "region": record.region,
        "city": record.city,
        "source": record.source,
        "source_id": record.source_id,
        "metadata": dict(record.metadata),
    }


class StreetInventoryRepositoryError(Exception):
    """Raised only for a malformed *successful* (2xx) Supabase response."""


class SupabaseStreetInventoryRepository:
    """
    Concrete Supabase/PostgREST-backed persistence for
    `discovery_streets`. See module docstring for the conventions this
    mirrors from `storage_backends/supabase_backend.py`.
    """

    def __init__(
        self,
        *,
        supabase_url: str | None = None,
        supabase_key: str | None = None,
        table: str = DEFAULT_TABLE,
        timeout_seconds: float = DEFAULT_HTTP_TIMEOUT_SECONDS,
        batch_size: int = DEFAULT_BATCH_SIZE,
    ) -> None:
        resolved_url = supabase_url or os.environ.get("SUPABASE_URL")
        resolved_key = supabase_key or os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
        if not resolved_url:
            raise ValueError(
                "SupabaseStreetInventoryRepository requires supabase_url or "
                "the SUPABASE_URL environment variable."
            )
        if not resolved_key:
            raise ValueError(
                "SupabaseStreetInventoryRepository requires supabase_key or "
                "the SUPABASE_SERVICE_ROLE_KEY environment variable."
            )
        if batch_size < 1:
            raise ValueError("batch_size must be at least 1")
        self._endpoint = f"{resolved_url.rstrip('/')}/rest/v1/{table}"
        self._key = resolved_key
        self._timeout_seconds = timeout_seconds
        self._batch_size = batch_size

    def upsert_streets(self, records: Sequence[StreetRecord]) -> dict[str, int]:
        """
        Upserts every record in `records` on `street_key`, batched (see
        module docstring). Returns `{"upserted": N, "batches": M}`.

        Raises `urllib.error.HTTPError` / `URLError` unmodified on any
        network or non-2xx response for any batch — same "never catch
        or retry" convention `SupabaseStorageBackend.persist()` follows
        (see that module's own docstring, item 3). A caller that wants
        partial-success semantics across batches should catch around
        individual `upsert_streets([...])` calls itself, not rely on
        this method to paper over a failed batch.
        """
        if not records:
            return {"upserted": 0, "batches": 0}

        batches = 0
        upserted = 0
        for start in range(0, len(records), self._batch_size):
            chunk = records[start : start + self._batch_size]
            rows = [_street_record_to_row(r) for r in chunk]
            self._upsert_batch(rows)
            batches += 1
            upserted += len(rows)
        return {"upserted": upserted, "batches": batches}

    def _upsert_batch(self, rows: list[dict[str, Any]]) -> None:
        url = f"{self._endpoint}?on_conflict=street_key"
        headers = {
            "Content-Type": "application/json",
            "apikey": self._key,
            "Authorization": f"Bearer {self._key}",
            # merge-duplicates: update the conflicting row's non-key
            # columns instead of erroring, so repeated inventory runs
            # over the same city are idempotent (see this phase's own
            # "Data refresh / upsert" requirement).
            "Prefer": "resolution=merge-duplicates,return=minimal",
        }
        data = json.dumps(rows).encode("utf-8")
        request = urllib.request.Request(url, data=data, headers=headers, method="POST")
        with urllib.request.urlopen(request, timeout=self._timeout_seconds) as response:
            status = response.getcode()
            if status not in (200, 201, 204):
                raise StreetInventoryRepositoryError(
                    f"Supabase upsert into discovery_streets returned unexpected status {status}"
                )
