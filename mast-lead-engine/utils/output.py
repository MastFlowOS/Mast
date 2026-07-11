"""
Mast Lead Engine — Output Writers.

Provides:
  • CSVWriter      — writes leads to a rotating timestamped CSV file
  • SheetsWriter   — appends leads to a Google Sheets document
  • JSONLWriter     — JSONL format for downstream processing / API ingestion

CSV columns follow the architecture doc's canonical schema with
all 40+ fields in a logical order suitable for direct Mast import.
"""

from __future__ import annotations

import csv
import json
import os
from datetime import datetime
from pathlib import Path
from typing import Iterable

from utils.runtime import get_logger

log = get_logger("output")

# ──────────────────────────────────────────────────────────────────────────────
# Canonical column order (architecture doc §Output Schema)
# ──────────────────────────────────────────────────────────────────────────────

COLUMNS = [
    # Identity
    "name",
    "city",
    "country",
    "address",
    "category",
    "niche",
    "region",
    "query",

    # Scoring
    "score",
    "tier",
    "quality",
    "action",

    # Contact channels
    "email",
    "phone",
    "website",
    "instagram",
    "facebook",
    "contact_form",

    # Maps signals
    "rating",
    "reviews",
    "maps_link",
    "price_range",
    "has_photos",
    "has_popular_times",
    "owner_responds_to_reviews",
    "is_google_verified",
    "multi_location",
    "closed",

    # Instagram enrichment
    "ig_followers",
    "ig_posts",
    "ig_following",
    "ig_activity",
    "ig_last_post_days",
    "ig_post_frequency",
    "ig_legitimacy",
    "ig_is_business",
    "ig_bio",
    "ig_category",
    "ig_email",
    "ig_external_url",
    "ig_private",
    "ig_blocked",

    # Tech stack (serialized)
    "tech_stack_cms",
    "tech_stack_ecom",
    "tech_stack_booking",
    "tech_stack_analytics",
    "tech_stack_ads",
]

# ──────────────────────────────────────────────────────────────────────────────
# Row serialisation helper
# ──────────────────────────────────────────────────────────────────────────────

def _flatten(lead: dict) -> dict:
    """Flatten nested dicts into top-level columns for CSV output."""
    flat = dict(lead)

    # Tech stack
    ts = lead.get("tech_stack") or {}
    flat["tech_stack_cms"] = ts.get("cms") or ""
    flat["tech_stack_ecom"] = ts.get("ecom") or ""
    flat["tech_stack_booking"] = ts.get("booking") or ""
    flat["tech_stack_analytics"] = "|".join(ts.get("analytics") or [])
    flat["tech_stack_ads"] = "|".join(ts.get("ads") or [])

    # Boolean to Yes/No for readability in sheets
    for key in (
        "has_photos", "has_popular_times", "owner_responds_to_reviews",
        "is_google_verified", "multi_location", "closed",
        "ig_is_business", "ig_private", "ig_blocked",
    ):
        flat[key] = "Yes" if flat.get(key) else "No"

    # None → empty string
    for key in COLUMNS:
        if flat.get(key) is None:
            flat[key] = ""

    return flat


# ──────────────────────────────────────────────────────────────────────────────
# CSVWriter
# ──────────────────────────────────────────────────────────────────────────────

class CSVWriter:
    """Streaming CSV writer with auto-flush.

    Opens a new timestamped file per run. Appends rows as leads arrive
    without buffering the entire result set in memory.
    """

    def __init__(
        self,
        output_dir: str | Path = "output",
        label: str = "leads",
        columns: list[str] | None = None,
    ) -> None:
        self.output_dir = Path(output_dir)
        self.output_dir.mkdir(parents=True, exist_ok=True)
        self.columns = columns or COLUMNS

        ts = datetime.now().strftime("%Y%m%d_%H%M%S")
        self.path = self.output_dir / f"{label}_{ts}.csv"

        self._file = open(self.path, "w", newline="", encoding="utf-8-sig")
        self._writer = csv.DictWriter(
            self._file,
            fieldnames=self.columns,
            extrasaction="ignore",
        )
        self._writer.writeheader()
        self._file.flush()

        self.count = 0
        log.info(f"[csv] opened: {self.path}")

    def write(self, lead: dict) -> None:
        """Append a single lead row to the CSV."""
        flat = _flatten(lead)
        self._writer.writerow({col: flat.get(col, "") for col in self.columns})
        self.count += 1
        if self.count % 10 == 0:
            self._file.flush()

    def write_many(self, leads: Iterable[dict]) -> int:
        """Write multiple leads. Returns count written."""
        written = 0
        for lead in leads:
            self.write(lead)
            written += 1
        return written

    def close(self) -> None:
        try:
            self._file.flush()
            self._file.close()
        except Exception:
            pass
        log.info(f"[csv] closed: {self.path} ({self.count} rows)")

    def __enter__(self) -> "CSVWriter":
        return self

    def __exit__(self, *_) -> None:
        self.close()


# ──────────────────────────────────────────────────────────────────────────────
# JSONLWriter
# ──────────────────────────────────────────────────────────────────────────────

class JSONLWriter:
    """Write leads as newline-delimited JSON (JSONL) for API consumption."""

    def __init__(
        self,
        output_dir: str | Path = "output",
        label: str = "leads",
    ) -> None:
        self.output_dir = Path(output_dir)
        self.output_dir.mkdir(parents=True, exist_ok=True)
        ts = datetime.now().strftime("%Y%m%d_%H%M%S")
        self.path = self.output_dir / f"{label}_{ts}.jsonl"
        self._file = open(self.path, "w", encoding="utf-8")
        self.count = 0
        log.info(f"[jsonl] opened: {self.path}")

    def write(self, lead: dict) -> None:
        json.dump(lead, self._file, ensure_ascii=False, default=str)
        self._file.write("\n")
        self.count += 1
        if self.count % 20 == 0:
            self._file.flush()

    def write_many(self, leads: Iterable[dict]) -> int:
        written = 0
        for lead in leads:
            self.write(lead)
            written += 1
        return written

    def close(self) -> None:
        try:
            self._file.flush()
            self._file.close()
        except Exception:
            pass
        log.info(f"[jsonl] closed: {self.path} ({self.count} rows)")

    def __enter__(self) -> "JSONLWriter":
        return self

    def __exit__(self, *_) -> None:
        self.close()


# ──────────────────────────────────────────────────────────────────────────────
# SheetsWriter
# ──────────────────────────────────────────────────────────────────────────────

class SheetsWriter:
    """Append leads to a Google Sheets document.

    Requires:
        pip install google-auth google-auth-oauthlib google-auth-httplib2 google-api-python-client

    Configuration (via env vars or constructor args):
        MAST_SHEETS_CREDENTIALS_FILE  — path to service account JSON
        MAST_SHEETS_SPREADSHEET_ID    — target spreadsheet ID
        MAST_SHEETS_SHEET_NAME        — sheet tab name (default: "Leads")

    Writes in batches of `batch_size` rows to reduce API calls.
    """

    SCOPES = ["https://www.googleapis.com/auth/spreadsheets"]

    def __init__(
        self,
        spreadsheet_id: str | None = None,
        credentials_file: str | None = None,
        sheet_name: str | None = None,
        batch_size: int = 25,
        columns: list[str] | None = None,
    ) -> None:
        self.spreadsheet_id = spreadsheet_id or os.environ.get(
            "MAST_SHEETS_SPREADSHEET_ID", ""
        )
        self.credentials_file = credentials_file or os.environ.get(
            "MAST_SHEETS_CREDENTIALS_FILE", "credentials.json"
        )
        self.sheet_name = sheet_name or os.environ.get(
            "MAST_SHEETS_SHEET_NAME", "Leads"
        )
        self.batch_size = batch_size
        self.columns = columns or COLUMNS
        self._buffer: list[dict] = []
        self._service = None
        self._header_written = False
        self.count = 0

        if not self.spreadsheet_id:
            log.warning("[sheets] no spreadsheet ID — SheetsWriter is disabled")
            return

        self._connect()

    def _connect(self) -> None:
        try:
            from google.oauth2 import service_account
            from googleapiclient.discovery import build

            creds = service_account.Credentials.from_service_account_file(
                self.credentials_file, scopes=self.SCOPES
            )
            self._service = build("sheets", "v4", credentials=creds, cache_discovery=False)
            log.info(f"[sheets] connected to {self.spreadsheet_id}")
        except ImportError:
            log.error("[sheets] google-api-python-client not installed")
        except Exception as exc:
            log.error(f"[sheets] connection error: {exc}")

    def write(self, lead: dict) -> None:
        if not self._service:
            return
        self._buffer.append(lead)
        if len(self._buffer) >= self.batch_size:
            self.flush()

    def write_many(self, leads: Iterable[dict]) -> int:
        written = 0
        for lead in leads:
            self.write(lead)
            written += 1
        self.flush()
        return written

    def flush(self) -> None:
        if not self._service or not self._buffer:
            return
        try:
            rows: list[list] = []
            if not self._header_written:
                rows.append(self.columns)
                self._header_written = True

            for lead in self._buffer:
                flat = _flatten(lead)
                rows.append([flat.get(col, "") for col in self.columns])

            self._service.spreadsheets().values().append(
                spreadsheetId=self.spreadsheet_id,
                range=f"{self.sheet_name}!A1",
                valueInputOption="USER_ENTERED",
                insertDataOption="INSERT_ROWS",
                body={"values": rows},
            ).execute()

            self.count += len(self._buffer)
            log.debug(f"[sheets] flushed {len(self._buffer)} rows")
        except Exception as exc:
            log.error(f"[sheets] flush error: {exc}")
        finally:
            self._buffer.clear()

    def close(self) -> None:
        self.flush()
        log.info(f"[sheets] done — {self.count} rows written")

    def __enter__(self) -> "SheetsWriter":
        return self

    def __exit__(self, *_) -> None:
        self.close()
