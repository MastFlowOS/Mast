"""
MAST Engine V2 — Contact Worker
==================================

Source: Engine BluePrint Phase 1.3 (Worker Types — Contact Worker),
Phase 1.2 (Golden Rule — one input, one output), and the Phase 5.6
implementation prompt. Builds on workers/base_worker.py without
duplicating any lifecycle logic, exactly as workers/website_worker.py
and workers/instagram_worker.py do.

Responsibility
--------------
ContactWorker performs exactly one transformation:

    WebsiteIntel -> ContactWorker.process() -> ContactIntel

It inspects the pages WebsiteWorker already found — the business's own
site (`final_url`) and, if WebsiteWorker discovered one, a
contact-page-shaped link (`contact_page`) — and reports objective
contact facts present on them. It does not discover businesses,
inspect websites generally (platform, title, language, ...; that
remains WebsiteWorker's job), analyse Instagram, qualify, score,
store, retry, or talk to any queue/session/runtime component.

Like WebsiteWorker and InstagramWorker, this is a pure transformer,
not a producer: no callback, no streaming, one input in and one
already-finished output out.

Architecture review (Phase 5.6, pre-implementation)
--------------------------------------------------------------------
Reviewing `engine.contracts.ContactIntel` against this milestone's
stated responsibility surfaced problems, corrected in
`engine/contracts.py` directly rather than worked around here — same
discipline WebsiteWorker's Phase 5.4 and InstagramWorker's Phase 5.5
reviews used:

1. `preferred_contact_method` — removed. Deciding which channel is
   "preferred" is a judgment about the business, not a fact the page
   itself states. This milestone's own "do not guess... do not infer"
   line forbids exactly this. Same category as
   `InstagramIntel.engagement` (Phase 5.5) and
   `WebsiteIntel.website_quality` (Phase 5.4), both removed for the
   identical reason.

2. `confidence` — removed. A confidence score is an estimate about the
   extraction, not an extracted fact — the same "do not invent... do
   not estimate" boundary that removed `InstagramIntel.engagement`.

3. `contact_form_url`, `whatsapp_link`, `messenger_link`,
   `telegram_link`, `linkedin_url` — added. This milestone's own
   responsibility list explicitly names contact forms and
   WhatsApp/Messenger/Telegram/LinkedIn links as in-scope objective
   contact facts, and no field previously existed to hold any of them.

4. `fetch_duration` — added, mirroring
   `WebsiteIntel.response_time` / `InstagramIntel.fetch_duration`: a
   timing measurement of this worker's own fetch(es), not a judgment.

5. The stale docstring ("Created by EmailWorker + PhoneWorker") was
   corrected to name the single ContactWorker this milestone
   implements — no two-worker split exists anywhere in this codebase.

See `ContactIntel`'s own docstring in `engine/contracts.py` for the
complete field-by-field rationale.

A genuine architecture inconsistency, flagged rather than resolved
silently
--------------------------------------------------------------------
This milestone's own "Boundaries" section says: "If Instagram exposes
native business contact buttons, ContactWorker may resolve the
underlying contact values only if those values are publicly accessible
without authentication." That describes a second input
(`InstagramIntel`) alongside `WebsiteIntel`.

But the milestone's INPUT, OUTPUT, and TRANSFORMATION sections all
state, explicitly and repeatedly, a single input:

    WebsiteIntel -> ContactWorker.process() -> ContactIntel
    "One input. One output."

— matching Phase 1.2's Golden Rule exactly, and matching how every
other worker in this codebase (WebsiteWorker, InstagramWorker,
DiscoveryWorker) is shaped: one contract in, one contract out. No
worker anywhere in this codebase takes two input contracts.

These two statements cannot both be implemented as written without
inventing a second-input worker shape that exists nowhere else in this
architecture — exactly the kind of decision this milestone's own
"Architecture First" section says not to make silently. Resolved here
in favor of the explicit, three-times-repeated INPUT/OUTPUT/
TRANSFORMATION contract: `ContactWorker.process()` takes only a
`WebsiteIntel`. The Instagram-contact-button-resolution capability is
therefore out of scope for this milestone and is not implemented here.
The natural place for it, if a future milestone wants it, is
`MergeWorker` — the one component that already receives both
`InstagramIntel` and `ContactIntel` and composes them (Phase 1.2,
`EnrichedBusiness`) — not a second input parameter bolted onto
ContactWorker.

Why plain HTTP/HTML inspection, not a browser
------------------------------------------------
Same reasoning WebsiteWorker's and InstagramWorker's module docstrings
give for their own choice: every field this milestone asks for
(mailto:/tel: links, a contact `<form>`, WhatsApp/Messenger/Telegram/
LinkedIn links) is present in a page's raw HTML — none of it requires
JavaScript execution or a rendered layout. This keeps process() a
plain synchronous function with no browser process, no event loop, and
no extra runtime resource — the same "no caches, no globals, fully
stateless" fit the other two enrichment workers were built for.

Phase 1.3's "Timeout Rules" section names a per-job timeout for
Website (8s) and Instagram (6s) but not Contact. Nothing in Phase
1.1-1.5 or this milestone's prompt supplies one. Rather than invent a
number with no source, this module documents its default explicitly as
an assumption (6.0s, matching Instagram's budget) and leaves it
trivially overridable per instance — the same pattern
`WorkerDefinition.timeout_seconds` already uses for values a future
milestone may want to configure per worker type.

Which pages get fetched
--------------------------
This milestone's own "Responsibilities" section names two: "the
already-discovered business website" and "the already-discovered
contact page (if WebsiteWorker exposed one)". Concretely:

    - `item.contact_page`, if WebsiteWorker found one, fetched first
      (it is the page most likely to actually contain a contact form
      or explicit contact channels).
    - `item.final_url`, the business's own site WebsiteWorker already
      resolved to, fetched if present and distinct from
      `contact_page`.
    - If neither is present (e.g. `item.website_reachable` is False,
      or WebsiteWorker recorded no `final_url`) -> not an error
      condition; returns `ContactIntel(pipeline_id=item.pipeline_id)`
      immediately, no network call attempted — the same "no URL -> no
      fetch, not a failure" precedent WebsiteWorker and InstagramWorker
      both use for their own respective inputs.

Error handling — deliberately different from WebsiteWorker/
InstagramWorker
--------------------------------------------------------------------
WebsiteWorker and InstagramWorker each catch their own network
failures and translate them into a `*_reachable=False` fact, because
"is this site/profile reachable" is itself one of their inspection
questions. This milestone's own "Error Handling" section instead says,
explicitly: "If contact extraction fails: allow exceptions to
propagate. Do not retry. Do not swallow exceptions. Do not return
partial ContactIntel." Reachability of the underlying page is not one
of ContactIntel's fields (WebsiteIntel already owns that fact) — so
there is nothing here to catch and no reachability field to populate.
Every fetch this worker makes is therefore unguarded: `urllib` /
`socket` errors propagate completely unmodified, exactly as this
milestone requires, and no `ContactIntel` is constructed (partial or
otherwise) until every planned fetch has succeeded.

Thread safety / statelessness
-------------------------------
No module-level mutable state, no caches. Every process() call builds
its own request(s)/timer from scratch, mirroring WebsiteWorker's and
InstagramWorker's "fresh instance per call" pattern.

Status
------
Phase 5.6. Depends only on WebsiteIntel, ContactIntel, BaseWorker,
WorkerCapability, and the standard library. No queue/, providers/,
engine.coordinator, or runtime import anywhere in this file.
"""

from __future__ import annotations

import re
import socket
import time
import urllib.error
import urllib.request
from typing import Dict, Optional, Tuple
from urllib.parse import urljoin

from engine.contracts import ContactIntel, WebsiteIntel
from workers.base_worker import BaseWorker
from workers.worker_capability import WorkerCapability

#: Not specified anywhere in Phase 1.1-1.5 for Contact — see module
#: docstring "Why plain HTTP/HTML inspection, not a browser" for why
#: this is an explicit, documented assumption rather than an
#: unremarked guess. Overridable per instance.
DEFAULT_TIMEOUT_SECONDS = 6.0

WORKER_TYPE = "contact"

_USER_AGENT = "MAST-ContactWorker/1.0 (+contact extraction only)"

# -- Anchor scan, same shape as WebsiteWorker's own _ANCHOR_RE — a ------
# -- literal href/text extraction, not a heuristic judgment. ------------
_ANCHOR_RE = re.compile(
    r'<a\s[^>]*href=["\']([^"\']+)["\']', re.IGNORECASE | re.DOTALL
)
_FORM_RE = re.compile(r"<form\b", re.IGNORECASE)

#: Plain-text email pattern — a literal syntactic match against
#: whatever the page already renders, same category as WebsiteWorker's
#: _PLATFORM_SIGNATURES substring matches. No phone-number equivalent
#: is used: unlike email syntax, phone formats vary too widely for a
#: literal pattern to avoid becoming a guess (see module docstring's
#: "do not guess" discussion) — phones are extracted only from
#: explicit tel: links below.
_EMAIL_RE = re.compile(r"[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}")

_MAILTO_PREFIX = "mailto:"
_TEL_PREFIX = "tel:"

_WHATSAPP_RE = re.compile(
    r"^https?://(?:api\.)?(?:www\.)?wa\.me/|^https?://(?:www\.)?api\.whatsapp\.com/",
    re.IGNORECASE,
)
_MESSENGER_RE = re.compile(
    r"^https?://(?:www\.)?(?:m\.me|messenger\.com)/", re.IGNORECASE
)
_TELEGRAM_RE = re.compile(
    r"^https?://(?:www\.)?(?:t\.me|telegram\.me)/", re.IGNORECASE
)
_LINKEDIN_RE = re.compile(
    r"^https?://(?:www\.)?linkedin\.com/company/", re.IGNORECASE
)


class ContactWorker(BaseWorker[WebsiteIntel, ContactIntel]):
    """
    Transforms one WebsiteIntel into one ContactIntel by fetching the
    pages WebsiteWorker already located (`contact_page`, `final_url`)
    and reporting objective contact facts found on them. Owns nothing
    else — see module docstring.
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

    def process(self, item: WebsiteIntel) -> ContactIntel:
        """
        Consume exactly one WebsiteIntel and produce exactly one
        ContactIntel. Never mutates `item`. See "Error handling" above
        — nothing here is caught; a failed fetch propagates completely
        and no ContactIntel (partial or otherwise) is returned.
        """
        urls = self._pages_to_fetch(item)
        if not urls:
            return ContactIntel(pipeline_id=item.pipeline_id)

        emails: "dict[str, None]" = {}
        phones: "dict[str, None]" = {}
        contact_form_url: Optional[str] = None
        whatsapp_link: Optional[str] = None
        messenger_link: Optional[str] = None
        telegram_link: Optional[str] = None
        linkedin_url: Optional[str] = None
        total_elapsed = 0.0

        for url in urls:
            html, page_url, elapsed = self._fetch(url)
            total_elapsed += elapsed

            for email in self._extract_emails(html):
                emails.setdefault(email, None)
            for phone in self._extract_phones(html):
                phones.setdefault(phone, None)

            if contact_form_url is None and _FORM_RE.search(html):
                contact_form_url = page_url

            if whatsapp_link is None:
                whatsapp_link = self._extract_first_link(html, page_url, _WHATSAPP_RE)
            if messenger_link is None:
                messenger_link = self._extract_first_link(
                    html, page_url, _MESSENGER_RE
                )
            if telegram_link is None:
                telegram_link = self._extract_first_link(html, page_url, _TELEGRAM_RE)
            if linkedin_url is None:
                linkedin_url = self._extract_first_link(html, page_url, _LINKEDIN_RE)

        return ContactIntel(
            pipeline_id=item.pipeline_id,
            emails=tuple(emails) or None,
            phones=tuple(phones) or None,
            contact_form_url=contact_form_url,
            whatsapp_link=whatsapp_link,
            messenger_link=messenger_link,
            telegram_link=telegram_link,
            linkedin_url=linkedin_url,
            fetch_duration=total_elapsed,
        )

    def timeout_seconds(self) -> float:
        return self._timeout

    # -- internal, pure helpers ------------------------------------------
    #
    # Stateless functions of their arguments only — no instance state
    # read or written, so these can't leak between process() calls.

    @staticmethod
    def _pages_to_fetch(item: WebsiteIntel) -> Tuple[str, ...]:
        """
        contact_page first (most likely to hold a contact form/explicit
        channels), then final_url if present and distinct. See module
        docstring "Which pages get fetched".
        """
        urls: "dict[str, None]" = {}
        if item.contact_page:
            urls.setdefault(item.contact_page, None)
        if item.final_url:
            urls.setdefault(item.final_url, None)
        return tuple(urls)

    def _fetch(self, url: str) -> Tuple[str, str, float]:
        """
        Fetch `url` and return (html, resolved_url, elapsed_seconds).
        Unguarded on purpose — see module docstring "Error handling".
        """
        request = urllib.request.Request(url, headers={"User-Agent": _USER_AGENT})
        start = time.monotonic()
        with urllib.request.urlopen(request, timeout=self._timeout) as response:
            elapsed = time.monotonic() - start
            resolved_url = response.geturl()
            raw = response.read()
            charset = response.headers.get_content_charset() or "utf-8"
        html = raw.decode(charset, errors="replace")
        return html, resolved_url, elapsed

    @staticmethod
    def _extract_emails(html: str) -> Tuple[str, ...]:
        found: "dict[str, None]" = {}
        for href in _ANCHOR_RE.findall(html):
            if href.lower().startswith(_MAILTO_PREFIX):
                address = href[len(_MAILTO_PREFIX):].split("?", 1)[0].strip()
                if address:
                    found.setdefault(address, None)
        for match in _EMAIL_RE.findall(html):
            found.setdefault(match, None)
        return tuple(found)

    @staticmethod
    def _extract_phones(html: str) -> Tuple[str, ...]:
        found: "dict[str, None]" = {}
        for href in _ANCHOR_RE.findall(html):
            if href.lower().startswith(_TEL_PREFIX):
                number = href[len(_TEL_PREFIX):].strip()
                if number:
                    found.setdefault(number, None)
        return tuple(found)

    @staticmethod
    def _extract_first_link(
        html: str, base_url: str, pattern: "re.Pattern[str]"
    ) -> Optional[str]:
        for href in _ANCHOR_RE.findall(html):
            resolved = urljoin(base_url, href.strip())
            if pattern.search(resolved):
                return resolved
        return None
