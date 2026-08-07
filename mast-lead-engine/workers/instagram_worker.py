"""
MAST Engine V2 — Instagram Worker
====================================

Source: Engine BluePrint Phase 1.3 (Worker Types, Timeout Rules —
Instagram=6s), Phase 1.2 (Golden Rule — one input, one output), and
the Phase 5.5 implementation prompt. Builds on workers/base_worker.py
without duplicating any lifecycle logic, exactly as
workers/website_worker.py and workers/discovery_worker.py do.

Responsibility
--------------
InstagramWorker performs exactly one transformation:

    BusinessCandidate -> InstagramWorker.process() -> InstagramIntel

It visits item.instagram_url, inspects the public profile, and reports
objective facts about it. It does not discover, score, qualify, crawl
websites, find contacts outside Instagram, store, retry, or talk to
any queue/session/runtime component.

Like WebsiteWorker, this is a pure transformer, not a producer: no
callback, no streaming, one input in and one already-finished output
out. See workers/discovery_worker.py's own docstring for why Discovery
needed a different shape — InstagramWorker doesn't, and shouldn't
borrow it.

Architecture review (Phase 5.5, pre-implementation — same discipline
WebsiteWorker's Phase 5.4 post-implementation review used, done here
before writing this file instead of after, since the mismatch was
found while reviewing the *contract*, not this worker's code)
--------------------------------------------------------------------
Reviewing `engine.contracts.InstagramIntel` against this milestone's
stated responsibility surfaced two problems, both corrected in
`engine/contracts.py` directly rather than worked around here:

1. `InstagramIntel.engagement` was a derived/estimated metric, not an
   inspection fact — exactly what this milestone's "do not invent
   engagement scores... do not estimate popularity" line forbids.
   Removed from the contract. This worker never computes or reports
   an engagement figure of any kind.

2. `BusinessCandidate` had no field at all for locating an Instagram
   profile — unlike `website`, which already lets WebsiteWorker's
   milestone work as written. This milestone's own responsibility
   list ("locate the Instagram profile using information already
   available on the BusinessCandidate") was literally unsatisfiable
   without one. Added `BusinessCandidate.instagram_url` — optional,
   appended last, mirroring `website`'s shape exactly, populated by no
   current provider (that remains future work). See
   `engine/contracts.py`'s ambiguity 3 for the full note.

`InstagramIntel` also gained profile_url, display_name, account_type,
contact_buttons, and profile_reachable — fields this milestone
explicitly asks for that the previous contract had no place to hold —
and renamed its own `website` field to `external_website` to avoid
colliding, in name only, with the different fact BusinessCandidate's
`website` already holds. None of this changed this worker's shape or
responsibilities; it only made the contract able to hold what this
worker was always meant to report. See `InstagramIntel`'s own
docstring for the complete field-by-field rationale.

No architecture problem remains after those corrections — this file
implements the milestone exactly as specified, against the corrected
contract.

Why a plain HTTP/HTML inspector, not a browser or a private API
------------------------------------------------------------------
Same reasoning WebsiteWorker's module docstring gives for its own
choice, applied to Instagram: Phase 1.3's Timeout Rules give Instagram
a 6s budget, tighter than Website's 8s, and every field this milestone
asks for is present in the public profile page's own `<meta>` tags and
embedded page data — none of it requires JavaScript execution, a
rendered layout, or an authenticated session. This keeps process() a
plain synchronous function with no browser process, no event loop, and
no extra runtime resource — the same "no caches, no globals, fully
stateless" fit WebsiteWorker's choice was made for.

This also means what this worker can observe is bounded by what
Instagram's public, logged-out profile page actually exposes in static
HTML. Some accounts render meaningfully less in that state (private
accounts, rate-limited responses, profile layouts that vary over
time). Fields this worker cannot find are reported as `None` — never
guessed, never estimated — exactly like WebsiteWorker's own optional
fields when a signature isn't present in the fetched HTML.

Reachability vs. exceptions
----------------------------
Mirrors WebsiteWorker's own "Reachability vs. exceptions" section
exactly, substituting "profile" for "site":

    - No instagram_url on the candidate at all -> not an error
      condition; returns InstagramIntel(profile_reachable=False)
      immediately, no network call attempted.
    - DNS failure / connection refused / timeout (urllib.error.URLError,
      socket.timeout, ConnectionError) -> these ARE the inspection
      result ("this profile could not be reached"), not a worker bug.
      Caught narrowly, translated into profile_reachable=False, and
      returned.
    - HTTP error status (4xx/5xx) -> the server responded, so the
      profile page IS reachable; urllib.error.HTTPError is caught
      narrowly and translated into an otherwise-mostly-empty
      InstagramIntel with profile_reachable=True (e.g. a private or
      removed profile may still 404/redirect while clearly having
      responded).
    - Anything else (programming errors, unexpected exception types)
      -> propagates completely unmodified. No bare except anywhere in
      this module.

Thread safety / statelessness
-------------------------------
No module-level mutable state, no caches. Every process() call builds
its own opener/request/timer from scratch, mirroring WebsiteWorker's
and GoogleMapsProvider's "fresh instance per call" pattern.

Status
------
Phase 5.5. Depends only on BusinessCandidate, InstagramIntel,
BaseWorker, WorkerCapability, and the standard library. No queue/,
providers/, engine.coordinator, or runtime import anywhere in this
file.
"""

from __future__ import annotations

import re
import socket
import time
import urllib.error
import urllib.request
from typing import Optional

from engine.contracts import BusinessCandidate, InstagramIntel
from workers.base_worker import BaseWorker
from workers.worker_capability import WorkerCapability

#: Phase 1.3 "Timeout Rules": Instagram = 6s. Overridable per instance.
DEFAULT_TIMEOUT_SECONDS = 6.0

WORKER_TYPE = "instagram"

_USER_AGENT = "MAST-InstagramWorker/1.0 (+profile inspection only)"

# -- Regexes over the public profile page's own <meta> tags and --------
# -- embedded page JSON. Every one of these matches a fact Instagram --
# -- itself already renders/embeds — none of this infers anything. ----

_OG_TITLE_RE = re.compile(
    r'<meta[^>]+property=["\']og:title["\'][^>]+content=["\'](.*?)["\']',
    re.IGNORECASE | re.DOTALL,
)
_OG_DESCRIPTION_RE = re.compile(
    r'<meta[^>]+property=["\']og:description["\'][^>]+content=["\'](.*?)["\']',
    re.IGNORECASE | re.DOTALL,
)
_OG_IMAGE_RE = re.compile(
    r'<meta[^>]+property=["\']og:image["\'][^>]+content=["\'](.*?)["\']',
    re.IGNORECASE | re.DOTALL,
)

#: og:title on a public profile is conventionally
#: "Display Name (@username) • Instagram photos and videos"
_TITLE_NAME_HANDLE_RE = re.compile(r"^(.*?)\s*\(@([^)]+)\)")

#: og:description is conventionally
#: "12,345 Followers, 678 Following, 90 Posts - See Instagram photos
#:  and videos from Display Name (@username): "bio text""
_DESCRIPTION_COUNTS_RE = re.compile(
    r"([\d,]+)\s+Followers,\s*([\d,]+)\s+Following,\s*([\d,]+)\s+Posts",
    re.IGNORECASE,
)
_DESCRIPTION_BIO_RE = re.compile(r':\s*"(.*)"\s*$', re.DOTALL)

#: Embedded-page-JSON signatures. Plain substring/regex matches against
#: the raw HTML, in the same spirit as WebsiteWorker's
#: _PLATFORM_SIGNATURES — a literal fact check, not a heuristic
#: judgment.
_VERIFIED_RE = re.compile(r'"is_verified"\s*:\s*true', re.IGNORECASE)
_BUSINESS_ACCOUNT_RE = re.compile(r'"is_business_account"\s*:\s*true', re.IGNORECASE)
_PROFESSIONAL_ACCOUNT_RE = re.compile(
    r'"is_professional_account"\s*:\s*true', re.IGNORECASE
)
_EXTERNAL_URL_RE = re.compile(r'"external_url"\s*:\s*"([^"]+)"')
_PUBLIC_EMAIL_RE = re.compile(r'"public_email"\s*:\s*"([^"]+)"')
_CONTACT_PHONE_RE = re.compile(r'"contact_phone_number"\s*:\s*"([^"]+)"')
_BUSINESS_ADDRESS_RE = re.compile(r'"business_address_json"\s*:\s*"(\{[^"]*\})"')


class InstagramWorker(BaseWorker[BusinessCandidate, InstagramIntel]):
    """
    Transforms one BusinessCandidate into one InstagramIntel by
    fetching item.instagram_url and reporting objective facts about
    the response. Owns nothing else — see module docstring.
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

    def process(self, item: BusinessCandidate) -> InstagramIntel:
        """
        Consume exactly one BusinessCandidate and produce exactly one
        InstagramIntel. Never mutates `item`. See "Reachability vs.
        exceptions" above for exactly which failures are caught and
        translated into fields versus left to propagate.
        """
        if not item.instagram_url:
            return InstagramIntel(
                pipeline_id=item.pipeline_id, profile_reachable=False
            )

        request = urllib.request.Request(
            item.instagram_url, headers={"User-Agent": _USER_AGENT}
        )

        start = time.monotonic()
        try:
            with urllib.request.urlopen(request, timeout=self._timeout) as response:
                elapsed = time.monotonic() - start
                raw = response.read()
                charset = response.headers.get_content_charset() or "utf-8"
        except urllib.error.HTTPError:
            # Server responded — the profile page is reachable, just
            # an error status (e.g. a private/removed profile page).
            elapsed = time.monotonic() - start
            return InstagramIntel(
                pipeline_id=item.pipeline_id,
                profile_reachable=True,
                profile_url=item.instagram_url,
                fetch_duration=elapsed,
            )
        except (urllib.error.URLError, socket.timeout, ConnectionError):
            # No response at all — this is the "unreachable" fact.
            elapsed = time.monotonic() - start
            return InstagramIntel(
                pipeline_id=item.pipeline_id,
                profile_reachable=False,
                fetch_duration=elapsed,
            )

        html = raw.decode(charset, errors="replace")
        display_name, username = self._extract_name_and_handle(html)
        followers, following, posts = self._extract_counts(html)

        return InstagramIntel(
            pipeline_id=item.pipeline_id,
            profile_reachable=True,
            profile_url=item.instagram_url,
            username=username,
            display_name=display_name,
            bio=self._extract_bio(html),
            followers=followers,
            following=following,
            posts=posts,
            verified=self._extract_verified(html),
            account_type=self._extract_account_type(html),
            external_website=self._extract_external_website(html),
            profile_picture=self._extract_profile_picture(html),
            contact_buttons=self._extract_contact_buttons(html),
            fetch_duration=elapsed,
        )

    def timeout_seconds(self) -> float:
        return self._timeout

    # -- internal, pure helpers ------------------------------------------
    #
    # Stateless functions of their arguments only — no instance state
    # read or written, so these can't leak between process() calls.
    # Every helper reports a fact already present in the fetched HTML,
    # or returns None if that fact isn't present — never a guess.

    @staticmethod
    def _extract_name_and_handle(html: str):
        match = _OG_TITLE_RE.search(html)
        if not match:
            return None, None
        title = match.group(1).strip()
        name_handle = _TITLE_NAME_HANDLE_RE.search(title)
        if not name_handle:
            return None, None
        return name_handle.group(1).strip() or None, name_handle.group(2).strip()

    @staticmethod
    def _extract_counts(html: str):
        match = _OG_DESCRIPTION_RE.search(html)
        if not match:
            return None, None, None
        counts = _DESCRIPTION_COUNTS_RE.search(match.group(1))
        if not counts:
            return None, None, None
        try:
            followers = int(counts.group(1).replace(",", ""))
            following = int(counts.group(2).replace(",", ""))
            posts = int(counts.group(3).replace(",", ""))
        except ValueError:
            # e.g. an abbreviated count like "1.2M" — not a plain
            # integer. Reported as unknown rather than approximated.
            return None, None, None
        return followers, following, posts

    @staticmethod
    def _extract_bio(html: str) -> Optional[str]:
        match = _OG_DESCRIPTION_RE.search(html)
        if not match:
            return None
        bio = _DESCRIPTION_BIO_RE.search(match.group(1))
        return bio.group(1).strip() if bio else None

    @staticmethod
    def _extract_verified(html: str) -> Optional[bool]:
        return True if _VERIFIED_RE.search(html) else None

    @staticmethod
    def _extract_account_type(html: str) -> Optional[str]:
        if _BUSINESS_ACCOUNT_RE.search(html):
            return "business"
        if _PROFESSIONAL_ACCOUNT_RE.search(html):
            return "creator"
        return None

    @staticmethod
    def _extract_external_website(html: str) -> Optional[str]:
        match = _EXTERNAL_URL_RE.search(html)
        return match.group(1) if match else None

    @staticmethod
    def _extract_profile_picture(html: str) -> Optional[str]:
        match = _OG_IMAGE_RE.search(html)
        return match.group(1) if match else None

    @staticmethod
    def _extract_contact_buttons(html: str):
        """
        Which public contact affordances the profile itself displays
        — labels only. Never the resolved email/phone value behind
        them; resolving those is ContactWorker's job (see module
        docstring and InstagramIntel's own docstring).
        """
        buttons = []
        if _PUBLIC_EMAIL_RE.search(html):
            buttons.append("email")
        if _CONTACT_PHONE_RE.search(html):
            buttons.append("call")
        if _BUSINESS_ADDRESS_RE.search(html):
            buttons.append("directions")
        return tuple(buttons) or None
