"""
Mast Lead Engine — Runtime utilities.

Provides:
  • RateLimiter — token-bucket with jitter, per-domain configurable
  • RetryExecutor — exponential backoff with circuit-breaker
  • RequestSession — aiohttp wrapper with proxy rotation, fingerprint rotation
  • structured logging with run-level context
"""

from __future__ import annotations

import asyncio
import logging
import os
import random
import sys
import time
from collections import deque
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable, TypeVar

import aiohttp

T = TypeVar("T")

# ──────────────────────────────────────────────────────────────────────────────
# Logging
# ──────────────────────────────────────────────────────────────────────────────

LOG_LEVEL = os.environ.get("LOG_LEVEL", "INFO").upper()

logging.basicConfig(
    stream=sys.stdout,
    level=getattr(logging, LOG_LEVEL, logging.INFO),
    format="%(asctime)s [%(levelname)s] %(name)s — %(message)s",
    datefmt="%H:%M:%S",
)

log = logging.getLogger("mast")


def get_logger(name: str) -> logging.Logger:
    return logging.getLogger(f"mast.{name}")


# ──────────────────────────────────────────────────────────────────────────────
# Rate limiter — token-bucket with optional jitter
# ──────────────────────────────────────────────────────────────────────────────

class RateLimiter:
    """Async token-bucket rate limiter with human-like jitter.

    Args:
        requests_per_minute: Sustained request rate ceiling.
        burst:               Allow up to this many requests before refilling.
        jitter_pct:          ±% random variation on each delay (0–100).
        min_delay_ms:        Hard floor on inter-request gap (milliseconds).
    """

    def __init__(
        self,
        requests_per_minute: float = 30,
        burst: int = 5,
        jitter_pct: float = 20,
        min_delay_ms: float = 500,
    ) -> None:
        self.rpm = max(1.0, requests_per_minute)
        self.burst = max(1, burst)
        self.jitter_pct = jitter_pct / 100
        self.min_delay = min_delay_ms / 1000
        self._tokens: float = float(self.burst)
        self._last: float = time.monotonic()
        self._lock = asyncio.Lock()

    async def acquire(self, label: str = "") -> None:
        async with self._lock:
            now = time.monotonic()
            elapsed = now - self._last
            self._tokens = min(
                self.burst,
                self._tokens + elapsed * (self.rpm / 60),
            )
            self._last = now

            if self._tokens >= 1:
                self._tokens -= 1
                await self._jitter_sleep(0)
                return

            # Wait for token to refill
            wait = (1 - self._tokens) * (60 / self.rpm)
            await self._jitter_sleep(wait)
            self._tokens = 0

    async def _jitter_sleep(self, base_wait: float) -> None:
        jitter = base_wait * random.uniform(-self.jitter_pct, self.jitter_pct)
        if base_wait <= 0:
            # Phase 2A / audit §3.1, Quick Win 3: when a burst token was
            # already available (base_wait == 0), min_delay must NOT apply.
            # That floor exists to pace genuine waits; applying it here was
            # an unconditional 800ms tax on every burst-available acquire,
            # confirmed by instrumentation (see rate_limit_wait_* stages)
            # to be a meaningful chunk of "rate limiter" time that bought
            # nothing — jitter is 0 when base_wait is 0, so this previously
            # always resolved to exactly min_delay, never anything less.
            delay = max(0.0, jitter)
        else:
            delay = max(self.min_delay, base_wait + jitter)
        if delay > 0:
            await asyncio.sleep(delay)


# ──────────────────────────────────────────────────────────────────────────────
# Circuit breaker
# ──────────────────────────────────────────────────────────────────────────────

class CircuitBreaker:
    """Simple sliding-window circuit breaker.

    CLOSED → OPEN after `failure_threshold` errors in `window_seconds`.
    OPEN → HALF_OPEN after `recovery_seconds`.
    HALF_OPEN → CLOSED on success, OPEN on failure.
    """

    def __init__(
        self,
        failure_threshold: int = 5,
        window_seconds: float = 60,
        recovery_seconds: float = 30,
    ) -> None:
        self.failure_threshold = failure_threshold
        self.window_seconds = window_seconds
        self.recovery_seconds = recovery_seconds
        self._failures: deque[float] = deque()
        self._opened_at: float | None = None
        self._state = "closed"

    @property
    def state(self) -> str:
        return self._state

    def is_open(self) -> bool:
        if self._state == "closed":
            return False
        if self._state == "open":
            if time.monotonic() - (self._opened_at or 0) > self.recovery_seconds:
                self._state = "half_open"
                return False
            return True
        return False  # half_open: allow probe

    def record_success(self) -> None:
        if self._state == "half_open":
            self._state = "closed"
            self._failures.clear()

    def record_failure(self) -> None:
        now = time.monotonic()
        self._failures.append(now)
        # Evict old failures outside window
        cutoff = now - self.window_seconds
        while self._failures and self._failures[0] < cutoff:
            self._failures.popleft()

        if len(self._failures) >= self.failure_threshold:
            self._state = "open"
            self._opened_at = now


# ──────────────────────────────────────────────────────────────────────────────
# Retry executor
# ──────────────────────────────────────────────────────────────────────────────

async def retry(
    fn: Callable[[], Awaitable[T]],
    *,
    attempts: int = 3,
    base_delay: float = 1.0,
    max_delay: float = 30.0,
    backoff: float = 2.0,
    jitter: float = 0.3,
    exceptions: tuple[type[Exception], ...] = (Exception,),
    on_retry: Callable[[int, Exception], None] | None = None,
) -> T:
    """Retry an async coroutine with exponential backoff and jitter.

    Args:
        fn:         No-arg async callable.
        attempts:   Max total attempts.
        base_delay: Initial wait (seconds).
        max_delay:  Cap on wait time.
        backoff:    Multiplier per retry.
        jitter:     ±fraction of delay added randomly.
        exceptions: Exception types to catch and retry.
        on_retry:   Optional callback(attempt_number, exception).
    """
    last_exc: Exception | None = None
    for attempt in range(attempts):
        try:
            return await fn()
        except exceptions as exc:
            last_exc = exc
            if attempt + 1 >= attempts:
                break
            wait = min(max_delay, base_delay * (backoff ** attempt))
            wait += wait * random.uniform(-jitter, jitter)
            if on_retry:
                on_retry(attempt + 1, exc)
            await asyncio.sleep(max(0, wait))
    raise last_exc or RuntimeError("retry exhausted")


# ──────────────────────────────────────────────────────────────────────────────
# User-agent rotation pool
# ──────────────────────────────────────────────────────────────────────────────

_UA_POOL: list[str] = [
    # Chrome / Windows (most common)
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
    # Chrome / macOS
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4_1) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    # Firefox / Windows
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:126.0) Gecko/20100101 Firefox/126.0",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0",
    # Safari / macOS
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4_1) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4.1 Safari/605.1.15",
    # Chrome / Linux
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
    # Mobile Chrome
    "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.6422.52 Mobile Safari/537.36",
    # Mobile Safari
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1",
]

_IG_UA_POOL: list[str] = [
    # Instagram requests use a separate, curated pool weighted toward mobile
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1",
    "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.6422.52 Mobile Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4_1) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4.1 Safari/605.1.15",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:126.0) Gecko/20100101 Firefox/126.0",
    "Mozilla/5.0 (Linux; Android 13; SM-G991B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/112.0.0.0 Mobile Safari/537.36",
]


def random_ua(for_instagram: bool = False) -> str:
    pool = _IG_UA_POOL if for_instagram else _UA_POOL
    return random.choice(pool)


def random_accept_language() -> str:
    langs = [
        "en-US,en;q=0.9",
        "en-GB,en;q=0.9",
        "en-US,en;q=0.8,es;q=0.3",
        "en-US,en;q=0.9,fr;q=0.3",
        "en-US,en;q=0.9,de;q=0.3",
    ]
    return random.choice(langs)


# ──────────────────────────────────────────────────────────────────────────────
# Proxy manager
# ──────────────────────────────────────────────────────────────────────────────

class ProxyManager:
    """Rotate through a list of proxies, tracking failure rates.

    Proxies are loaded from the MAST_PROXIES environment variable as a
    comma-separated list of URLs:
        http://user:pass@host:port,http://user:pass@host2:port2

    If no proxies are configured, all requests run direct.
    """

    def __init__(self, proxies: list[str] | None = None) -> None:
        raw = proxies or []
        if not raw:
            env = os.environ.get("MAST_PROXIES", "")
            raw = [p.strip() for p in env.split(",") if p.strip()]
        self._proxies = raw
        self._failures: dict[str, int] = {}
        self._idx = 0
        self._lock = asyncio.Lock()
        if raw:
            log.info(f"[proxy] loaded {len(raw)} proxies")
        else:
            log.info("[proxy] no proxies configured — direct connection mode")

    async def next(self) -> str | None:
        if not self._proxies:
            return None
        async with self._lock:
            # Find least-failed proxy
            best = min(
                self._proxies,
                key=lambda p: self._failures.get(p, 0),
            )
            return best

    def report_failure(self, proxy: str) -> None:
        self._failures[proxy] = self._failures.get(proxy, 0) + 1
        log.warning(f"[proxy] failure #{self._failures[proxy]} for {proxy}")

    def report_success(self, proxy: str) -> None:
        self._failures[proxy] = max(0, self._failures.get(proxy, 0) - 1)

    @property
    def count(self) -> int:
        return len(self._proxies)


# ──────────────────────────────────────────────────────────────────────────────
# ScraperConfig — central configuration object
# ──────────────────────────────────────────────────────────────────────────────

@dataclass
class ScraperConfig:
    """Central configuration for the Mast Lead Engine."""

    # Rate limits (requests/minute)
    maps_rpm: float = float(os.environ.get("MAPS_RPM", "20"))
    ig_rpm: float = float(os.environ.get("IG_RPM", "10"))
    site_rpm: float = float(os.environ.get("SITE_RPM", "30"))
    ddg_rpm: float = float(os.environ.get("DDG_RPM", "5"))

    # Timeouts (milliseconds)
    maps_timeout_ms: int = int(os.environ.get("MAPS_TIMEOUT_MS", "30000"))
    place_timeout_ms: int = int(os.environ.get("PLACE_TIMEOUT_MS", "25000"))
    site_timeout_ms: int = int(os.environ.get("SITE_TIMEOUT_MS", "20000"))
    ig_timeout_ms: int = int(os.environ.get("IG_TIMEOUT_MS", "18000"))

    # Delays (seconds)
    ig_delay_min: float = float(os.environ.get("IG_DELAY_MIN", "1.2"))
    ig_delay_max: float = float(os.environ.get("IG_DELAY_MAX", "4.5"))

    # Retries
    place_retries: int = int(os.environ.get("PLACE_RETRIES", "3"))
    ig_retries: int = int(os.environ.get("IG_RETRIES", "3"))
    site_retries: int = int(os.environ.get("SITE_RETRIES", "2"))

    # Scroll
    scroll_max_rounds: int = int(os.environ.get("SCROLL_ROUNDS", "15"))
    scroll_delay_ms: int = int(os.environ.get("SCROLL_DELAY_MS", "1500"))
    feed_wait_ms: int = int(os.environ.get("FEED_WAIT_MS", "15000"))
    # Phase 6 opt #1: bound on the event-driven "wait for new cards" poll in
    # _human_scroll. This replaces the old fixed ~5.6s blind sleep per round
    # with "wait only until new cards appear, capped at this timeout" — so
    # it's a ceiling, not a target duration like scroll_delay_ms was.
    scroll_settle_timeout_ms: int = int(os.environ.get("SCROLL_SETTLE_TIMEOUT_MS", "2500"))

    # Crash recovery — ROOT CAUSE FIX: a renderer crash ("Target crashed",
    # typically an OOM kill on memory-constrained hosts like Railway) used
    # to be treated as fatal for the entire search — one crash discarded
    # every place already yielded for that city and reported the whole
    # query as done/exhausted, even after 10+ minutes of real progress. Now
    # MapsScraper.search() catches a crash, tears down and rebuilds the
    # context/page, re-navigates, and resumes scrolling from where it left
    # off (seen_hrefs / yielded are preserved across the rebuild) — up to
    # this many times per search before finally giving up.
    max_crash_retries: int = int(os.environ.get("MAX_CRASH_RETRIES", "2"))

    # Mode flags
    fast: bool = bool(os.environ.get("SCRAPER_FAST", ""))
    headless: bool = True
    skip_site_crawl: bool = bool(os.environ.get("SKIP_SITE_CRAWL", ""))
    skip_ddg: bool = bool(os.environ.get("SKIP_DDG", ""))
    skip_ig: bool = bool(os.environ.get("SKIP_IG", ""))

    # Filtering — RELIABILITY FIX: these used to be hard cutoffs in
    # scraper/pipeline.py (anything above them was rejected outright before
    # ever reaching scoring). That threw away plenty of genuinely strong SMB
    # prospects — a bakery with 900 Google reviews or a boutique with 6,000
    # IG followers is still a great outreach target, just not the "ideal"
    # band. These two now only feed scoring/scorer.py's graduated penalty
    # bands (see review_score/ig_follower_score) instead of causing a reject.
    # Only HARD_MAX_REVIEWS / HARD_MAX_IG_FOLLOWERS below cause an outright
    # rejection now, reserved for businesses at genuinely enterprise scale.
    max_ig_followers: int = int(os.environ.get("MAX_IG_FOLLOWERS", "5000"))
    max_reviews: int = int(os.environ.get("MAX_REVIEWS", "2500"))

    # Hard rejection thresholds — a business beyond these is treated as
    # "obviously overgrown" (enterprise scale, not an SMB), the only case
    # (alongside chains/cannabis) where discovery should reject outright
    # rather than let scoring apply a penalty.
    hard_max_ig_followers: int = int(os.environ.get("HARD_MAX_IG_FOLLOWERS", "50000"))
    hard_max_reviews: int = int(os.environ.get("HARD_MAX_REVIEWS", "5000"))

    # Site crawl
    site_contact_page_budget: int = 4   # reduced to 2 in fast mode
    place_settle_ms: int = 1000

    def __post_init__(self) -> None:
        if self.fast:
            self.site_contact_page_budget = 2
            self.ig_delay_min = 0.8
            self.ig_delay_max = 2.0
            self.scroll_max_rounds = 8


# ──────────────────────────────────────────────────────────────────────────────
# RunStats
# ──────────────────────────────────────────────────────────────────────────────

@dataclass
class RunStats:
    collected: int = 0
    duplicates: int = 0
    errors: int = 0
    from_pool: int = 0
    # Total raw places that entered EnrichmentPipeline.process() — i.e. every
    # business the Maps scraper actually yielded, regardless of what happened
    # to it afterward. This is the denominator for the rejection summary.
    discovered: int = 0
    skipped: dict[str, int] = field(default_factory=dict)

    def skip(self, reason: str) -> None:
        self.skipped[reason] = self.skipped.get(reason, 0) + 1

    def summary(self) -> str:
        live = self.collected - self.from_pool
        lines = [
            f"✅ {self.collected} leads delivered ({self.from_pool} pool / {live} live)",
            f"   ♻️  duplicates     : {self.duplicates}",
            f"   ❌ errors          : {self.errors}",
        ]
        for reason, count in sorted(self.skipped.items(), key=lambda x: -x[1]):
            lines.append(f"   ⛔ {reason:<20}: {count}")
        return "\n".join(lines)

    def rejection_summary(self) -> str:
        """Plain-English breakdown in the exact shape requested for
        debugging "N discovered, 0 delivered" style reports:

            20 discovered
            18 rejected because missing required email
            1 duplicate
            1 inserted
        """
        lines = [f"{self.discovered} discovered"]
        for reason, count in sorted(self.skipped.items(), key=lambda x: -x[1]):
            lines.append(f"{count} rejected because {reason}")
        if self.duplicates:
            lines.append(f"{self.duplicates} duplicate" + ("s" if self.duplicates != 1 else ""))
        if self.errors:
            lines.append(f"{self.errors} error" + ("s" if self.errors != 1 else ""))
        lines.append(f"{self.collected} inserted")

        accounted_for = (
            sum(self.skipped.values()) + self.duplicates + self.errors + self.collected
        )
        if accounted_for != self.discovered:
            lines.append(
                f"⚠️  UNACCOUNTED: {self.discovered} discovered but only "
                f"{accounted_for} accounted for across skip/dup/error/insert "
                f"buckets — {self.discovered - accounted_for} business(es) "
                f"vanished from the pipeline without hitting a logged exit "
                f"point. This means a stage is returning/raising without "
                f"recording a reason — check for a bare `except` or an early "
                f"`return None` that isn't wrapped in self._stats.skip()."
            )
        return "\n".join(lines)
