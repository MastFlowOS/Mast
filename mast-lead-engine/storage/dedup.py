"""
Mast Lead Engine — Deduplication engine.

Multi-key fingerprinting across all available business identifiers.
Backed by SQLite (persistent, cross-run) + in-memory set (O(1) hot lookups).

Architecture (from the HTML spec):
  - Global pool dedup: prevents duplicate entries in lead_pool table
  - User-level dedup:  prevents re-delivery to the same user (Part 2)

Fingerprint types:
  ig:      Instagram handle          → "ig:thecoffeespot"
  email:   Normalized email address  → "email:hello@coffee.com"
  place:   Google Maps place ID      → "place:ChIJabc123"
  map:     Cleaned maps URL          → "map:google.com/maps/..."
  web:     Domain of website         → "web:thecoffeespot.com"
  tel:     Last 10 digits of phone   → "tel:3055551234"
  fb:      Facebook page handle      → "fb:thecoffeespot"
  name:    Normalized business name  → "name:the coffee spot"
  namecity: Name + city combo        → "name:the coffee spot|miami"
"""

from __future__ import annotations

import os
import re
import sqlite3
from pathlib import Path
from typing import Iterable
from urllib.parse import urlparse

from utils.parsing import domain_of, digits_only, norm_text


# ──────────────────────────────────────────────────────────────────────────────
# Normalization helpers
# ──────────────────────────────────────────────────────────────────────────────

_FB_SKIP = frozenset({
    "profile.php", "pages", "groups", "events", "watch", "share",
    "sharer", "dialog", "plugins", "help", "policies", "login",
})

_IG_NON_HANDLES = frozenset({
    "p", "reel", "reels", "tv", "explore", "stories", "accounts",
    "about", "directory", "legal", "privacy", "press", "help",
    "api", "oauth", "challenge",
})


def norm_instagram(value: str | None) -> str:
    if not value:
        return ""
    s = value.strip().lower()
    m = re.search(r"instagram\.com/([^/?#]+)", s)
    if m:
        s = m.group(1)
    s = s.lstrip("@").strip("/")
    return "" if (not s or s in _IG_NON_HANDLES or s.isdigit()) else s


def norm_facebook(value: str | None) -> str:
    if not value:
        return ""
    m = re.search(r"facebook\.com/([^/?#]+)", value.strip().lower())
    if not m:
        return ""
    handle = m.group(1).strip("/")
    return "" if (not handle or handle in _FB_SKIP) else handle


def norm_email(value: str | None) -> str:
    if not value:
        return ""
    e = value.strip().lower()
    if "@" not in e or e.count("@") != 1:
        return ""
    local, domain = e.split("@", 1)
    if not local or not domain or "." not in domain:
        return ""
    return f"{local}@{domain}"


def norm_phone(value: str | None) -> str:
    return digits_only(value)


def norm_maps_place_id(value: str | None) -> str:
    """Extract stable Google Maps place ID from a URL."""
    if not value:
        return ""
    raw = value.strip()
    # Canonical ChIJ…
    m = re.search(r"(ChIJ[\w\-]+)", raw, re.IGNORECASE)
    if m:
        return m.group(1)
    # Hex-encoded feature IDs inside data= blocks
    m = re.search(r"!1s(0x[a-f0-9]+:0x[a-f0-9]+)", raw, re.IGNORECASE)
    if m:
        return m.group(1).lower()
    return ""


def norm_maps_link(value: str | None) -> str:
    place_id = norm_maps_place_id(value)
    if place_id:
        return f"place:{place_id.lower()}"
    if not value:
        return ""
    return value.strip().split("?", 1)[0].rstrip("/").lower()


# ──────────────────────────────────────────────────────────────────────────────
# Fingerprint generator
# ──────────────────────────────────────────────────────────────────────────────

def fingerprints_for(biz: dict) -> set[str]:
    """Return all normalized keys that uniquely identify this business."""
    keys: set[str] = set()

    ig = norm_instagram(biz.get("instagram"))
    if ig:
        keys.add(f"ig:{ig}")

    email = norm_email(biz.get("email"))
    if email:
        keys.add(f"email:{email}")

    place = norm_maps_place_id(biz.get("maps_link"))
    if place:
        keys.add(f"place:{place.lower()}")

    link = norm_maps_link(biz.get("maps_link"))
    if link and not link.startswith("place:"):
        keys.add(f"map:{link}")

    dom = domain_of(biz.get("website"))
    if dom:
        keys.add(f"web:{dom}")

    phone = norm_phone(biz.get("phone"))
    if len(phone) >= 10:
        keys.add(f"tel:{phone[-10:]}")
    if 7 <= len(phone) < 10:
        keys.add(f"tel:{phone}")

    fb = norm_facebook(biz.get("facebook"))
    if fb:
        keys.add(f"fb:{fb}")

    # C2 fix: the bare `name:<name>` key (no city) used to be registered
    # unconditionally whenever a name existed. Because the TS delivery layer
    # (deliverLead.ts::findExistingBusiness) does a set-overlap match
    # against ALL fingerprints, two unrelated real businesses that happen to
    # share a common name in two different cities (e.g. "Bella Vista Salon"
    # in Miami and in Denver) collided on this key alone — even though the
    # more specific `name:<name>|<city>` key already distinguishes them
    # correctly. Worse, the collision didn't just suppress the second
    # business: it applied a rediscovery-confidence bump to the FIRST
    # (wrong) business's record, merging two unrelated identities. Bare
    # name alone is not a safe identity fingerprint at any error tolerance
    # this product implies — dropped entirely; the city-qualified key below
    # is the only name-based fingerprint now.
    name = norm_text(biz.get("name"))
    city = norm_text(biz.get("city"))
    if name and city:
        keys.add(f"name:{name}|{city}")

    return keys


# ──────────────────────────────────────────────────────────────────────────────
# LeadStore — SQLite-backed persistent dedup database
# ──────────────────────────────────────────────────────────────────────────────

DEFAULT_DB = Path(os.environ.get("LEADS_DB_PATH", "data/leads.db"))


class LeadStore:
    """SQLite-backed persistent dedup store.

    Architecture:
      - leads table:        one row per unique business
      - fingerprints table: many rows per lead, indexed for O(1) lookup
      - In-memory set:      hot cache for zero-latency duplicate checks

    Thread-safety: NOT thread-safe. Use one instance per async worker.
    For multi-process use, WAL journal mode prevents writer starvation.
    """

    def __init__(self, db_path: str | Path = DEFAULT_DB, *, profiler=None) -> None:
        self.db_path = Path(db_path)
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self._conn = sqlite3.connect(str(self.db_path), check_same_thread=False)
        self._conn.execute("PRAGMA journal_mode=WAL")
        self._conn.execute("PRAGMA synchronous=NORMAL")
        self._conn.execute("PRAGMA cache_size=-32000")  # 32MB page cache
        self._bootstrap()
        # Phase 2A (audit §3.7): this full-table fingerprint scan runs once
        # per process start with no prior visibility into its cost. Timed
        # here (optional profiler — defaults to doing nothing so existing
        # callers that don't pass one are unaffected) so it shows up in
        # __perf__ instead of silently growing with the total lead pool.
        if profiler is not None:
            with profiler.timer("leadstore_cache_load"):
                self._cache: set[str] = self._load_cache()
        else:
            self._cache: set[str] = self._load_cache()

    def _bootstrap(self) -> None:
        self._conn.executescript("""
            CREATE TABLE IF NOT EXISTS leads (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                name        TEXT,
                maps_link   TEXT,
                website     TEXT,
                instagram   TEXT,
                email       TEXT,
                phone       TEXT,
                city        TEXT,
                country     TEXT,
                score       INTEGER DEFAULT 0,
                quality     TEXT DEFAULT 'COLD',
                added_at    TEXT DEFAULT (datetime('now'))
            );

            CREATE TABLE IF NOT EXISTS fingerprints (
                key         TEXT PRIMARY KEY,
                lead_id     INTEGER NOT NULL,
                FOREIGN KEY (lead_id) REFERENCES leads(id) ON DELETE CASCADE
            );

            CREATE INDEX IF NOT EXISTS idx_fp_lead
                ON fingerprints(lead_id);
        """)
        self._conn.commit()
        self._migrate()

    def _migrate(self) -> None:
        """Add columns introduced after initial schema without breaking old DBs."""
        existing = {
            row[1]
            for row in self._conn.execute("PRAGMA table_info(leads)")
        }
        migrations = {
            "score": "INTEGER DEFAULT 0",
            "quality": "TEXT DEFAULT 'COLD'",
            "niche": "TEXT DEFAULT ''",
            "region": "TEXT DEFAULT ''",
        }
        for col, typedef in migrations.items():
            if col not in existing:
                self._conn.execute(
                    f"ALTER TABLE leads ADD COLUMN {col} {typedef}"
                )
        self._conn.commit()

    def _load_cache(self) -> set[str]:
        return {row[0] for row in self._conn.execute("SELECT key FROM fingerprints")}

    @property
    def total(self) -> int:
        (n,) = self._conn.execute("SELECT COUNT(*) FROM leads").fetchone()
        return n

    def is_duplicate(self, biz: dict) -> tuple[bool, set[str], str | None]:
        """Return (is_dup, computed_keys, matched_key_or_None)."""
        keys = fingerprints_for(biz)
        for k in keys:
            if k in self._cache:
                return True, keys, k
        return False, keys, None

    def add(
        self,
        biz: dict,
        keys: Iterable[str] | None = None,
        *,
        score: int = 0,
        quality: str = "COLD",
        niche: str = "",
        region: str = "",
    ) -> int:
        """Persist a unique business and register all its fingerprints."""
        effective_keys = set(keys) if keys is not None else fingerprints_for(biz)
        cur = self._conn.execute(
            """
            INSERT INTO leads(
                name, maps_link, website, instagram, email, phone,
                city, country, score, quality, niche, region
            ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
            """,
            (
                biz.get("name", ""),
                biz.get("maps_link", ""),
                biz.get("website", ""),
                biz.get("instagram", ""),
                biz.get("email", ""),
                biz.get("phone", ""),
                biz.get("city", ""),
                biz.get("country", ""),
                score,
                quality,
                niche,
                region,
            ),
        )
        lead_id = cur.lastrowid
        for k in effective_keys:
            self._conn.execute(
                "INSERT OR IGNORE INTO fingerprints(key, lead_id) VALUES (?,?)",
                (k, lead_id),
            )
            self._cache.add(k)
        self._conn.commit()
        return lead_id

    def register_keys(self, keys: Iterable[str], lead_id: int | None = None) -> None:
        """Attach extra fingerprints to the most recent lead."""
        if lead_id is None:
            row = self._conn.execute(
                "SELECT id FROM leads ORDER BY id DESC LIMIT 1"
            ).fetchone()
            if not row:
                return
            lead_id = row[0]
        for k in keys:
            self._conn.execute(
                "INSERT OR IGNORE INTO fingerprints(key, lead_id) VALUES (?,?)",
                (k, lead_id),
            )
            self._cache.add(k)
        self._conn.commit()

    def contains_fingerprint(self, key: str) -> bool:
        return key in self._cache

    def reset(self) -> None:
        """Wipe entire database. Only for fresh runs with --no-history."""
        self._conn.execute("DELETE FROM fingerprints")
        self._conn.execute("DELETE FROM leads")
        self._conn.commit()
        self._cache.clear()

    def close(self) -> None:
        try:
            self._conn.close()
        except Exception:
            pass

    def __repr__(self) -> str:
        return f"<LeadStore path={self.db_path} total={self.total}>"
