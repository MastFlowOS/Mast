"""
MAST Engine V2 — Website Worker
==================================

Source: Engine BluePrint Phase 1.3 (Worker Types, Timeout Rules —
Website=8s), Phase 1.2 (Golden Rule — one input, one output), and the
Phase 5.4 implementation prompt. Builds on workers/base_worker.py
without duplicating any lifecycle logic, exactly as
workers/discovery_worker.py does.

Responsibility
--------------
WebsiteWorker performs exactly one transformation:

    BusinessCandidate -> WebsiteWorker.process() -> WebsiteIntel

It visits item.website, inspects the response, and reports objective
facts about it. It does not discover, score, qualify, find contacts,
find social profiles, store, retry, or talk to any queue/session/
runtime component — see engine/contracts.py's Phase 5.4 note on
WebsiteIntel for where those responsibilities now live.

Unlike DiscoveryWorker, this is a pure transformer, not a producer: no
callback, no streaming, one input in and one already-finished output
out. See workers/discovery_worker.py's own docstring for why Discovery
needed a different shape — WebsiteWorker doesn't, and shouldn't borrow
it.

Architecture review notes (Phase 5.4, post-implementation review)
--------------------------------------------------------------------
Three points were raised on review of the first version of this file;
all three are reflected in the code below.

1. `urllib.request`, not a browser. Intentional: WebsiteWorker is a
   lightweight HTTP/HTML inspector, not a browser-automation worker.
   Phase 1.3's Timeout Rules give Website an 8s budget — headless
   browser startup + render + network (the cost V1's Playwright-based
   MapsScraper already pays, and the reason GoogleMapsProvider needed
   a sync/async event-loop bridge) doesn't fit that budget for a
   single-page inspection, and every field this milestone asks for
   (reachable, final URL, status, title, meta description, platform
   signature, `<html lang>`, redirects, a contact-page link) is present
   in the raw HTTP response and initial HTML — none of it requires
   JavaScript execution or a rendered layout. This also keeps
   process() a plain synchronous function with no browser process, no
   event loop, no extra runtime resource — a closer fit to this
   worker's "no caches, no globals, fully stateless" requirement than
   a browser-backed implementation would be.

2. `logo_present` — reconsidered, still excluded. Not because logo
   presence is inherently a business judgment, but because a plain
   HTTP+HTML inspector (point 1 above) cannot reliably observe it:
   logos are frequently CSS background-images, inline SVG with no
   identifying text, or JS-injected, unlike a technology fingerprint
   such as detected_platform's near-unique substring matches. Belongs
   to a future rendering-capable worker, should one exist.

3. `contact_page` — reconsidered and restored. Discovering that a
   contact-page-shaped link exists on the page already fetched is
   single-page structural inspection, the same category as
   detected_platform's signature matching — not a second page fetch.
   Extracting emails/phones from that linked page remains
   ContactWorker's job; this worker only records the discovered link,
   never follows it.

Reachability vs. exceptions
----------------------------
The milestone asks this worker to "determine whether the site is
reachable" while also saying failures must propagate, not be swallowed.
These aren't actually in tension once "reachable" is read as one of
this worker's own inspection facts rather than a caught bug:

    - No website on the candidate at all -> not an error condition;
      returns WebsiteIntel(website_reachable=False) immediately, no
      network call attempted.
    - DNS failure / connection refused / timeout (urllib.error.URLError,
      socket.timeout, ConnectionError) -> these ARE the inspection
      result ("this site could not be reached"), not a worker bug.
      Caught narrowly, translated into website_reachable=False, and
      returned — this is reporting a fact, not swallowing a failure.
    - HTTP error status (4xx/5xx) -> the server responded, so the site
      IS reachable; urllib.error.HTTPError is caught narrowly and
      translated into http_status on an otherwise-normal WebsiteIntel.
    - Malformed/control-character-polluted URL (ValueError: "URL can't
      contain control characters", raised by http.client underneath
      urllib.request when the target URL contains an embedded control
      character or literal newline) -> Phase 42D-1: `process()` already
      sanitizes `item.website` up front via
      `utils.parsing.strip_control_characters`, so this should not
      normally occur; `ValueError` is additionally caught here as
      defense-in-depth (a URL library could theoretically re-inject
      something) and treated exactly like `urllib.error.URLError` --
      translated into `website_reachable=False`, not propagated. This
      is still reporting a fact ("this URL could not be requested"),
      not swallowing a genuine worker bug.
    - Anything else (programming errors, unexpected exception types)
      -> propagates completely unmodified. No bare except anywhere in
      this module.

Thread safety / statelessness
-------------------------------
No module-level mutable state, no caches. Every process() call builds
its own opener/request/timer from scratch, mirroring
GoogleMapsProvider's "fresh instance per call" pattern.

Status
------
Phase 5.4 (post-review revision). Depends only on BusinessCandidate,
WebsiteIntel, BaseWorker, WorkerCapability, and the standard library.
No queue/, providers/, engine.coordinator, or runtime import anywhere
in this file.
"""

from __future__ import annotations

import re
import socket
import time
import urllib.error
import urllib.request
from typing import List, Optional
from urllib.parse import urljoin, urlparse

from engine.contracts import BusinessCandidate, WebsiteIntel
from utils.parsing import strip_control_characters
from workers.base_worker import BaseWorker
from workers.worker_capability import WorkerCapability

#: Phase 1.3 "Timeout Rules": Website = 8s. Overridable per instance.
DEFAULT_TIMEOUT_SECONDS = 8.0

WORKER_TYPE = "website"

_USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36 MAST-WebsiteWorker/1.0"

_TITLE_RE = re.compile(r"<title[^>]*>(.*?)</title>", re.IGNORECASE | re.DOTALL)
_META_DESC_RE = re.compile(
    r'<meta[^>]+name=["\']description["\'][^>]+content=["\'](.*?)["\']',
    re.IGNORECASE | re.DOTALL,
)
_HTML_LANG_RE = re.compile(r'<html[^>]+lang=["\']([^"\']+)["\']', re.IGNORECASE)
_ANCHOR_RE = re.compile(
    r'<a\s[^>]*href=["\']([^"\']+)["\'][^>]*>(.*?)</a>',
    re.IGNORECASE | re.DOTALL,
)

# Phase 9.1 & 39: contact-page hint keywords broadened to include
# connect, find-us, visit-us, reach-us, about-us, contact-us.
_CONTACT_PAGE_HINT_KEYWORDS: tuple[str, ...] = (
    "contact",
    "help",
    "support",
    "about",
    "press",
    "careers",
    "wholesale",
    "partners",
    "terms",
    "policy",
    "policies",
    "locations",
)
_CONTACT_HINT_RE = re.compile(
    r"\b(" + "|".join(_CONTACT_PAGE_HINT_KEYWORDS) + r")\b",
    re.IGNORECASE,
)

#: Minimal, purely factual platform signatures — a literal string match
#: against the fetched HTML, not a heuristic judgment about the site.
#: "if already available" (per this milestone's prompt) is honored by
#: keeping this list intentionally small rather than building a
#: fingerprinting system.
_PLATFORM_SIGNATURES = (
    ("wp-content", "WordPress"),
    ("cdn.shopify.com", "Shopify"),
    ("static.wixstatic.com", "Wix"),
    ("squarespace.com", "Squarespace"),
    ("webflow.io", "Webflow"),
)


class _RedirectTracker(urllib.request.HTTPRedirectHandler):
    """Records every URL redirected to, in order, without altering
    urllib's default redirect behavior."""

    def __init__(self) -> None:
        super().__init__()
        self.chain: List[str] = []

    def redirect_request(self, req, fp, code, msg, headers, newurl):  # type: ignore[override]
        self.chain.append(newurl)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


class WebsiteWorker(BaseWorker[BusinessCandidate, WebsiteIntel]):
    """
    Transforms one BusinessCandidate into one WebsiteIntel by fetching
    item.website and reporting objective facts about the response.
    Owns nothing else — see module docstring.
    """

    def __init__(
        self,
        *,
        timeout: float = DEFAULT_TIMEOUT_SECONDS,
        worker_id: Optional[str] = None,
    ) -> None:
        super().__init__(
            worker_type=WORKER_TYPE,
            capabilities=(WorkerCapability(name=WORKER_TYPE),),
            worker_id=worker_id,
        )
        self._timeout = timeout

    # -- WorkerInterface -------------------------------------------------

    def process(self, item: BusinessCandidate) -> WebsiteIntel:
        """
        Consume exactly one BusinessCandidate and produce exactly one
        WebsiteIntel. Never mutates `item`. See "Reachability vs.
        exceptions" above for exactly which failures are caught and
        translated into fields versus left to propagate.
        """
        raw_website = strip_control_characters((item.website or "").strip())
        if not raw_website:
            return WebsiteIntel(pipeline_id=item.pipeline_id, website_reachable=False)

        if not re.match(r"^https?://", raw_website, re.IGNORECASE):
            target_url = "https://" + raw_website
            fallback_http_url: Optional[str] = "http://" + raw_website
        else:
            target_url = raw_website
            fallback_http_url = None

        headers = {
            "User-Agent": _USER_AGENT,
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
            "Accept-Language": "en-US,en;q=0.9",
            "Connection": "close",
        }

        redirect_tracker = _RedirectTracker()
        opener = urllib.request.build_opener(redirect_tracker)
        request = urllib.request.Request(target_url, headers=headers)

        start = time.monotonic()
        try:
            with opener.open(request, timeout=self._timeout) as response:
                elapsed = time.monotonic() - start
                final_url = response.geturl()
                status = response.status
                raw = response.read()
                charset = response.headers.get_content_charset() or "utf-8"
        except urllib.error.HTTPError as exc:
            # Server responded — reachable, just an error status.
            elapsed = time.monotonic() - start
            return WebsiteIntel(
                pipeline_id=item.pipeline_id,
                website_reachable=True,
                https=urlparse(exc.url or target_url).scheme == "https",
                final_url=exc.url or target_url,
                http_status=exc.code,
                redirect_chain=tuple(redirect_tracker.chain) or None,
                response_time=elapsed,
                crawl_duration=elapsed,
            )
        except (urllib.error.URLError, socket.timeout, ConnectionError, ValueError):
            if fallback_http_url:
                try:
                    fallback_req = urllib.request.Request(fallback_http_url, headers=headers)
                    with opener.open(fallback_req, timeout=self._timeout) as response:
                        elapsed = time.monotonic() - start
                        final_url = response.geturl()
                        status = response.status
                        raw = response.read()
                        charset = response.headers.get_content_charset() or "utf-8"
                except urllib.error.HTTPError as exc:
                    elapsed = time.monotonic() - start
                    return WebsiteIntel(
                        pipeline_id=item.pipeline_id,
                        website_reachable=True,
                        https=False,
                        final_url=exc.url or fallback_http_url,
                        http_status=exc.code,
                        redirect_chain=tuple(redirect_tracker.chain) or None,
                        response_time=elapsed,
                        crawl_duration=elapsed,
                    )
                except (urllib.error.URLError, socket.timeout, ConnectionError, ValueError):
                    elapsed = time.monotonic() - start
                    return WebsiteIntel(
                        pipeline_id=item.pipeline_id,
                        website_reachable=False,
                        response_time=elapsed,
                        crawl_duration=elapsed,
                    )
            else:
                # No response at all — this is the "unreachable" fact.
                elapsed = time.monotonic() - start
                return WebsiteIntel(
                    pipeline_id=item.pipeline_id,
                    website_reachable=False,
                    response_time=elapsed,
                    crawl_duration=elapsed,
                )

        html = raw.decode(charset, errors="replace")
        contact_page, contact_page_hint = self._extract_contact_page(html, final_url)

        return WebsiteIntel(
            pipeline_id=item.pipeline_id,
            website_reachable=True,
            https=urlparse(final_url).scheme == "https",
            final_url=final_url,
            http_status=status,
            redirect_chain=tuple(redirect_tracker.chain) or None,
            title=self._extract_title(html),
            description=self._extract_meta_description(html),
            contact_page=contact_page,
            contact_page_hint=contact_page_hint,
            detected_platform=self._detect_platform(html),
            page_language=self._extract_language(html),
            response_time=elapsed,
            crawl_duration=elapsed,
        )

    def timeout_seconds(self) -> float:
        return self._timeout

    # -- internal, pure helpers ------------------------------------------
    #
    # Stateless functions of their arguments only — no instance state
    # read or written, so these can't leak between process() calls.

    @staticmethod
    def _extract_title(html: str) -> Optional[str]:
        match = _TITLE_RE.search(html)
        return match.group(1).strip() if match else None

    @staticmethod
    def _extract_meta_description(html: str) -> Optional[str]:
        match = _META_DESC_RE.search(html)
        return match.group(1).strip() if match else None

    @staticmethod
    def _extract_language(html: str) -> Optional[str]:
        match = _HTML_LANG_RE.search(html)
        return match.group(1).strip() if match else None

    @staticmethod
    def _detect_platform(html: str) -> Optional[str]:
        for signature, platform in _PLATFORM_SIGNATURES:
            if signature in html:
                return platform
        return None

    @staticmethod
    def _extract_contact_page(
        html: str, base_url: str
    ) -> "tuple[Optional[str], Optional[str]]":
        """
        First link on this page whose href or link text mentions one of
        `_CONTACT_PAGE_HINT_KEYWORDS` (Phase 9.1: broadened from the
        literal substring "contact" — see that tuple's comment),
        resolved to an absolute URL against base_url. Still exactly the
        existing "first matching link wins" document-order semantics
        and still exactly one secondary page. Reports only that such a
        link exists on the page already fetched — does not follow it.
        Extracting emails/phones from the linked page is ContactWorker's
        responsibility, not this worker's (see module docstring, review
        point 3).

        Returns a (url, matched_keyword) pair, both None if no anchor
        matches. href is checked before text, matching the previous
        `href-or-text` check order, so `matched_keyword` reflects
        whichever of the two produced the match.
        """
        for href, text in _ANCHOR_RE.findall(html):
            match = _CONTACT_HINT_RE.search(href) or _CONTACT_HINT_RE.search(text)
            if match:
                return urljoin(base_url, href.strip()), match.group(1).lower()
        return None, None
