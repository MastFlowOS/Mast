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

6. `instagram_url` — added (4-channel blocker fix, post-Phase-5.6).
   Production analysis found Instagram structurally unsatisfiable as a
   required channel: no provider populates
   `BusinessCandidate.instagram_url`, `InstagramWorker` only inspects
   a profile that already has a URL, and `ContactIntel` itself had
   nowhere to hold one even if this worker found it while scanning the
   business's own site. But the scan this worker already performs for
   `whatsapp_link`/`messenger_link`/`telegram_link`/`linkedin_url` is
   the exact same anchor-tag scan that would find an Instagram link
   sitting in the same footer/header social-icon row — no new fetch,
   no new page, no new worker. This worker now also extracts one
   Instagram URL from the same already-fetched HTML, using
   `utils.parsing.extract_ig_urls` (and its `clean_ig_url`/
   `is_real_ig_handle` helpers) rather than inventing a fresh regex —
   that module already implements exactly this canonicalization
   (`https://www.instagram.com/<handle>/`) and fake/reserved-path
   rejection (`/p/`, `/reel/`, `/explore/`, purely numeric segments,
   etc.), and the V1 crawler (`enrichment/site_crawler.py`) already
   relies on it in production for the identical extraction. Reusing it
   here keeps ContactWorker's own `_extract_first_link` pattern (used
   for WhatsApp/Messenger/Telegram/LinkedIn) for links that are
   already full URLs on the page, while Instagram — whose canonical
   form isn't always the literal href text — goes through the
   dedicated helper built for that normalization.

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

Phase 8.1 — resilience fix (mailto:/tel: fetch bug + isolated page
failures)
--------------------------------------------------------------------
Production audit of 104 `contact_stage_failed` occurrences (53 unique
businesses, all with `WebsiteWorker` success) found two bugs in this
file, confirmed against `kettl.co`:

1. `mailto:`/`tel:` values in `contact_page` were passed straight into
   `_fetch()`, which calls `urllib.request.urlopen()` on them — these
   are not fetchable URLs, so this always raised. Fixed: `_fetch()` is
   never called on a `mailto:`/`tel:` value; the address/number is
   read directly off the literal href instead (same validators as
   before — `is_valid_email` for mailto, no loosening either way), and
   this counts as evidence found, not a page needing a network call.

2. `_pages_to_fetch()`'s two candidates were fetched in one unguarded
   loop, so a `contact_page` failure raised out of `process()` before
   `final_url` was ever tried, discarding a page that may have loaded
   fine. Fixed: each candidate page is now fetched in its own
   try/except; one page's failure is recorded and the loop continues
   to the next candidate instead of aborting `process()`.

Both fixes are additive to extraction, not a loosening of it: the
"Error handling" section above (no retry, no swallowed exceptions, no
partial `ContactIntel`) still holds for the case that now actually
matters — if every fetchable page fails and no evidence (mailto/tel or
otherwise) was found at all, the last fetch exception is re-raised
unmodified, exactly as before this phase. What changes is only that a
single page's failure no longer erases evidence already recovered from
another page, and that mailto:/tel: values never reach `urlopen()` in
the first place. Qualification's requirement (website + valid email +
valid phone + valid instagram) is untouched — this phase makes more of
the *evidence already on the page* recoverable; it invents nothing and
relaxes no validator.

New `ContactIntel` fields (`contact_page_fetch_failed`,
`homepage_fetch_failed`, `mailto_extracted`, `tel_extracted`,
`partial_contact_success`) are plain facts about this worker's own
run — which candidate page(s) failed, whether the recovered evidence
came from a literal mailto:/tel: href instead of a fetch, and whether
the overall result is now partial rather than a total loss — following
the exact precedent `fetch_duration` set in Phase 5.6: a measurement
of the extraction, not a judgment. `ContactWorker` still touches no
profiler/telemetry/runtime import itself; per-page counters
(`contact_page_fetch_failures`, `homepage_fetch_failures`,
`mailto_links_extracted`, `tel_links_extracted`,
`partial_contact_successes`) are derived from these fields one layer
up, in `engine/execution_driver.py`'s `_contact_downstream` /
`service.py`'s `_on_progress`, the same place every other stage
counter in this codebase is already incremented.

Status
------
Phase 8.1 (built on Phase 5.6). Depends only on WebsiteIntel,
ContactIntel, BaseWorker, WorkerCapability, and the standard library.
No queue/, providers/, engine.coordinator, or runtime import anywhere
in this file.

Contact-data audit fixes (extraction accuracy + wasted work)
------------------------------------------------------------
* Pages that cost no request (a mailto:/tel: contact target, the homepage
  HTML WebsiteWorker already fetched) are consumed FIRST; the contact
  page is fetched only if they did not satisfy what is needed.
* Extraction is demand-driven: `WebsiteIntel.known_channels` lists
  channels the discovery provider already supplied (not chased again),
  and `required_channels == ()` means "nothing mandatory" (primary pages
  only, no secondary crawl). `None` keeps the historical all-channels
  behavior for direct/library use.
* Emails: asset file names ("logo@2x.png"), hash ids and placeholder
  hosts are rejected; entity- and bracket-obfuscated addresses are
  decoded; the own-domain / role-ranked address is returned first.
* Phones: country-aware (`WebsiteIntel.region_hint`), extension-safe,
  date/time/id false positives rejected, deduplicated on their canonical
  key. Invalid `tel:` values are dropped.
* Every value keeps its source (`email_provenance` / `phone_provenance`).
* Fetching: bodies are size-capped, permanent HTTP errors (400/401/403/
  404/410...) are never retried, and requests hold one of the bounded
  process-wide fetch slots (`utils/http_limits.py`).
"""

from __future__ import annotations

import concurrent.futures
import re
import socket
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import List, Dict, Optional, Sequence, Set, Tuple
from urllib.parse import urljoin

from engine.contracts import ContactIntel, WebsiteIntel
from utils.egress_guard import assert_loopback_url, is_local_isolation_enforced, LocalIsolationRedirectHandler
from utils.http_limits import fetch_slot, is_permanent_http_error, read_capped
from utils.parsing import (
    decode_entities,
    digits_only,
    extract_contextual_attribute_contacts,
    extract_ig_urls_with_source,
    extract_jsonld_contact_data,
    extract_obfuscated_emails,
    extract_phones,
    find_secondary_contact_link,
    get_standard_contact_candidates,
    has_invalid_ig_candidate,
    is_valid_email,
    is_valid_phone,
    normalize_phone,
    phone_dedup_key,
    select_primary_email,
    strip_control_characters,
)
from workers.base_worker import BaseWorker
from workers.worker_capability import WorkerCapability

#: Not specified anywhere in Phase 1.1-1.5 for Contact — see module
#: docstring "Why plain HTTP/HTML inspection, not a browser" for why
#: this is an explicit, documented assumption rather than an
#: unremarked guess. Overridable per instance.
DEFAULT_TIMEOUT_SECONDS = 6.0

WORKER_TYPE = "contact"

#: Hard cap on page fetches per candidate (contact page, homepage and
#: secondary/fallback pages combined).
_MAX_PAGE_FETCHES = 3

_USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36 MAST-ContactWorker/1.0"

# -- Anchor scan, same shape as WebsiteWorker's own _ANCHOR_RE — a ------
# -- literal href/text extraction, not a heuristic judgment. ------------
_ANCHOR_RE = re.compile(
    r'<a\s[^>]*href=["\']([^"\']+)["\']', re.IGNORECASE | re.DOTALL
)
_FORM_RE = re.compile(r"<form\b", re.IGNORECASE)

#: Plain-text email pattern — a literal syntactic match against
#: whatever the page already renders. Every hit still has to pass
#: `utils.parsing.is_valid_email` (which rejects asset file names such as
#: `logo@2x.png`, placeholders and system mailboxes). Visible-text phone
#: numbers are extracted by `utils.parsing.extract_phones`, which is
#: region-aware and rejects dates, times and ids; `tel:` links and
#: JSON-LD `telephone` values are also read.
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
        required_channels: Optional[Sequence[str] | Set[str]] = None,
    ) -> None:
        super().__init__(
            worker_type=WORKER_TYPE,
            capabilities=(WorkerCapability(name=WORKER_TYPE),),
            worker_id=worker_id,
        )
        self._timeout = timeout
        self._required_channels = (
            tuple(required_channels) if required_channels is not None else None
        )

    def _is_requirement_unsatisfied(
        self,
        emails: "dict[str, str]",
        phones: "dict[str, str]",
        instagram_url: Optional[str],
        known: "frozenset[str]" = frozenset(),
    ) -> bool:
        """True while more crawling could still satisfy what is *needed*.

        Demand-driven: only the channels this run requires are chased,
        minus any the discovery provider already supplied (`known`, from
        `WebsiteIntel.known_channels`).

        * `required_channels` non-empty: only those channels.
        * `required_channels == ()` (the service passes this when the run
          required none): primary pages only, harvested while email or
          phone is missing; no secondary crawl, and Instagram never
          drives extra fetches.
        * `required_channels is None` (library default / unspecified):
          the historical "all three channels" behaviour.
        """
        if self._required_channels is None:
            # Library default ("unspecified"): historical behaviour of
            # acquiring all three channels, minus anything the provider
            # already supplied.
            return (
                not (bool(emails) or "email" in known)
                or not (bool(phones) or "phone" in known)
                or not (instagram_url is not None or "instagram" in known)
            )

        req = set(self._required_channels)
        if req:
            if "email" in req and "email" not in known and not emails:
                return True
            if "phone" in req and "phone" not in known and not phones:
                return True
            if "instagram" in req and "instagram" not in known and instagram_url is None:
                return True
            return False

        # Explicitly NO channel required (empty tuple, what the service
        # passes when the run requested none): the primary pages (cached
        # homepage, contact page) are still harvested while email or
        # phone is missing, but nothing is mandatory, so no secondary
        # pages are crawled (`_may_fetch_secondary`). Instagram is rarely
        # on a page; treating it as "missing" used to force the full
        # 3-page budget on nearly every candidate.
        return (
            not (bool(emails) or "email" in known)
            or not (bool(phones) or "phone" in known)
        )

    def _may_fetch_secondary(self) -> bool:
        """Secondary/fallback pages are crawled only when some channel is
        actually required (or the requirement is unspecified/legacy).
        With an explicit empty requirement nothing is mandatory."""
        return self._required_channels is None or len(self._required_channels) > 0

    # -- WorkerInterface -------------------------------------------------

    def process(self, item: WebsiteIntel) -> ContactIntel:
        """
        Consume exactly one WebsiteIntel and produce exactly one
        ContactIntel. Never mutates `item`.

        Phase 8.1 & 39: each candidate page (`contact_page`, `final_url`) is
        fetched independently and in parallel when multiple distinct pages exist.
        403/404 errors immediately trigger alternate page exploration.
        429/500 errors use bounded backoff and retry.
        Page budget remains strictly bounded (<= 3 page fetches).

        Phase 42D-2: when every attempted page fetch fails (all pages
        403/404/network-error), this no longer raises the underlying
        fetch exception. It returns a `ContactIntel` with only the
        per-page `*_fetch_failed` flags and `pipeline_id` set --
        everything else (emails, phones, contact_form_url, etc.) stays
        at its default None/empty. This is not "inventing success":
        no field claims contact data was found, only that the fetch
        attempt(s) failed, which is exactly what happened. Returning
        this lets the normal success path
        (`execution_driver._contact_downstream`) run its existing
        Maps-fallback required-channels check immediately, instead of
        forcing every such business through a stage-failure retry and
        dead-letter cycle before that same fallback logic (duplicated
        in `_on_enrichment_failure_outcome`) gets a chance to run. A
        business whose required channel(s) truly aren't satisfiable
        from Maps-level data either is still correctly rejected at
        Qualification -- this only removes an unnecessary and fragile
        detour for the ones that already are.
        """
        pages = self._pages_to_fetch(item)
        if not pages:
            return ContactIntel(pipeline_id=item.pipeline_id)

        emails: "dict[str, str]" = {}
        phones: "dict[str, str]" = {}
        contact_form_url: Optional[str] = None
        whatsapp_link: Optional[str] = None
        messenger_link: Optional[str] = None
        telegram_link: Optional[str] = None
        linkedin_url: Optional[str] = None
        instagram_url: Optional[str] = None
        instagram_source: Optional[str] = None
        instagram_invalid_candidate_seen = False
        total_elapsed = 0.0

        contact_page_fetch_failed = False
        homepage_fetch_failed = False
        mailto_extracted = False
        tel_extracted = False
        any_page_recovered = False
        last_exc: Optional[BaseException] = None

        fetched_htmls: list[tuple[str, str]] = []
        tried_urls: set[str] = set()

        def _process_page_content(role: str, html: str, page_url: str, elapsed: float) -> None:
            nonlocal contact_form_url, whatsapp_link, messenger_link, telegram_link
            nonlocal linkedin_url, instagram_url, instagram_source, instagram_invalid_candidate_seen
            nonlocal mailto_extracted, tel_extracted, any_page_recovered, total_elapsed

            any_page_recovered = True
            total_elapsed += elapsed
            fetched_htmls.append((html, page_url))
            tried_urls.add(page_url.strip())

            # Unified single-pass anchor extraction
            raw_anchors = _ANCHOR_RE.findall(html) if html else []
            resolved_anchors = [
                strip_control_characters(urljoin(page_url, h.strip()))
                for h in raw_anchors
                if h.strip()
            ]

            self._extract_page_contact_data(
                html=html,
                page_url=page_url,
                page_role=role,
                emails=emails,
                phones=phones,
                raw_anchors=raw_anchors,
                region=item.region_hint,
            )
            if any(s == "mailto" for s in emails.values()):
                mailto_extracted = True
            if any(s == "tel" for s in phones.values()):
                tel_extracted = True

            if contact_form_url is None and _FORM_RE.search(html):
                contact_form_url = page_url

            if whatsapp_link is None or messenger_link is None or telegram_link is None or linkedin_url is None:
                for resolved in resolved_anchors:
                    if whatsapp_link is None and _WHATSAPP_RE.search(resolved):
                        whatsapp_link = resolved
                    if messenger_link is None and _MESSENGER_RE.search(resolved):
                        messenger_link = resolved
                    if telegram_link is None and _TELEGRAM_RE.search(resolved):
                        telegram_link = resolved
                    if linkedin_url is None and _LINKEDIN_RE.search(resolved):
                        linkedin_url = resolved
                    if (
                        whatsapp_link is not None
                        and messenger_link is not None
                        and telegram_link is not None
                        and linkedin_url is not None
                    ):
                        break
            if instagram_url is None:
                instagram_url, instagram_source = self._extract_instagram_evidence(html)
                if instagram_url is None and has_invalid_ig_candidate(html):
                    instagram_invalid_candidate_seen = True

        total_fetches = 0
        known = frozenset(item.known_channels or ())
        region = item.region_hint

        def _unsatisfied() -> bool:
            return self._is_requirement_unsatisfied(emails, phones, instagram_url, known)

        # Pages that cost no network request (a mailto:/tel: contact
        # target, or the homepage HTML WebsiteWorker already fetched) are
        # consumed FIRST, in their original relative order. If they
        # already satisfy what is needed, no further page is requested.
        # Previously the contact page was fetched before the free cached
        # homepage was even looked at.
        free_pages: "list[tuple[str, str]]" = []
        net_pages: "list[tuple[str, str]]" = []
        for role, url in pages:
            u = url.strip()
            low = u.lower()
            if (
                low.startswith(_MAILTO_PREFIX)
                or low.startswith(_TEL_PREFIX)
                or (role == "homepage" and item.homepage_html is not None)
            ):
                free_pages.append((role, u))
            else:
                net_pages.append((role, u))

        satisfied_from_free = False
        for role, url_clean in free_pages:
            tried_urls.add(url_clean)
            low = url_clean.lower()
            if low.startswith(_MAILTO_PREFIX):
                address = url_clean[len(_MAILTO_PREFIX):].split("?", 1)[0].strip()
                address = urllib.parse.unquote(address)
                if address and is_valid_email(address):
                    emails.setdefault(address.lower(), "mailto")
                    mailto_extracted = True
                any_page_recovered = True
            elif low.startswith(_TEL_PREFIX):
                number = url_clean[len(_TEL_PREFIX):].split("?", 1)[0].strip()
                number = urllib.parse.unquote(number)
                # Same validation/normalization as every other phone
                # source: an invalid tel: value (e.g. "tel:0000") is
                # dropped instead of being stored verbatim.
                normalized = normalize_phone(number, region)
                if normalized and is_valid_phone(normalized):
                    if phone_dedup_key(normalized) not in {phone_dedup_key(p) for p in phones}:
                        phones[normalized] = "tel"
                    tel_extracted = True
                any_page_recovered = True
            else:
                _process_page_content(role, item.homepage_html, url_clean, 0.0)
            if not _unsatisfied():
                satisfied_from_free = True
                break

        # Network pages: only if still needed. `contact_page` and a
        # homepage that has no cached HTML are independent, so when both
        # need a request they are dispatched concurrently through a small
        # per-call executor (Phase 5D), joined before returning.
        fetch_needed = [] if satisfied_from_free or not _unsatisfied() else list(net_pages)

        futures_by_url: "Dict[str, concurrent.futures.Future]" = {}
        executor: "Optional[concurrent.futures.ThreadPoolExecutor]" = None
        if len(fetch_needed) > 1:
            executor = concurrent.futures.ThreadPoolExecutor(
                max_workers=len(fetch_needed)
            )
            futures_by_url = {
                url: executor.submit(self._fetch, url) for _, url in fetch_needed
            }

        try:
            for role, url_clean in fetch_needed:
                if not _unsatisfied():
                    break
                tried_urls.add(url_clean)
                total_fetches += 1
                try:
                    if url_clean in futures_by_url:
                        html, page_url, elapsed = futures_by_url[url_clean].result()
                    else:
                        html, page_url, elapsed = self._fetch(url_clean)
                    _process_page_content(role, html, page_url, elapsed)
                except Exception as exc:  # noqa: BLE001
                    last_exc = exc
                    if role == "contact_page":
                        contact_page_fetch_failed = True
                    else:
                        homepage_fetch_failed = True
        finally:
            if executor is not None:
                executor.shutdown(wait=True)

        # Phase 15 & 39 & Secondary-Page Fallback Fix: Bounded Secondary Page Discovery
        secondary_page_fetched = False
        secondary_page_fetch_failed = False
        secondary_page_type: Optional[str] = None
        secondary_fallback_attempted = False
        secondary_fallback_url: Optional[str] = None
        secondary_fallback_success = False
        secondary_fallback_fetch_failed = False

        if _unsatisfied() and total_fetches < _MAX_PAGE_FETCHES and self._may_fetch_secondary():
            base_url = item.final_url or item.contact_page or (fetched_htmls[0][1] if fetched_htmls else "")
            sec_url: Optional[str] = None
            sec_type: Optional[str] = None

            if fetched_htmls:
                sec_url, sec_type = find_secondary_contact_link(
                    fetched_htmls=fetched_htmls,
                    base_url=base_url,
                    tried_urls=tried_urls,
                )

            # A real link discovered in the HTML is fetched on its own.
            if sec_url:
                tried_urls.add(sec_url.strip())
                total_fetches += 1
                secondary_page_fetched = True
                secondary_page_type = sec_type
                try:
                    sec_html, sec_page_url, sec_elapsed = self._fetch(sec_url)
                    _process_page_content("secondary_page", sec_html, sec_page_url, sec_elapsed)
                except Exception as exc:
                    secondary_page_fetch_failed = True
                    if last_exc is None:
                        last_exc = exc

            # Standard-path fallback (no discovered link, or it did not
            # satisfy the need): one candidate at a time, in priority
            # order, inside the shared <= _MAX_PAGE_FETCHES budget.
            # Probing several guessed paths in parallel was considered and
            # rejected: it issues speculative extra requests whenever the
            # first path already works, which defeats "fewer requests per
            # lead".
            while _unsatisfied() and total_fetches < _MAX_PAGE_FETCHES and base_url:
                alt_cands = get_standard_contact_candidates(base_url, tried_urls)
                if not alt_cands:
                    break
                alt_type, alt_url = alt_cands[0]
                tried_urls.add(alt_url.strip())
                total_fetches += 1
                secondary_page_fetched = True
                secondary_fallback_attempted = True
                secondary_fallback_url = alt_url
                if secondary_page_type is None:
                    secondary_page_type = alt_type
                try:
                    alt_html, alt_page_url, alt_elapsed = self._fetch(alt_url)
                    secondary_page_fetch_failed = False
                    secondary_page_type = alt_type
                    secondary_fallback_success = True
                    secondary_fallback_fetch_failed = False
                    _process_page_content("secondary_page", alt_html, alt_page_url, alt_elapsed)
                except Exception as alt_exc:
                    secondary_page_fetch_failed = True
                    secondary_fallback_success = False
                    secondary_fallback_fetch_failed = True
                    last_exc = alt_exc


        if not any_page_recovered:
            # Phase 42D-2 correction: every candidate page fetch failed
            # (e.g. every page 403'd). This previously did
            # `assert last_exc is not None; raise last_exc`, re-raising
            # the underlying fetch exception so engine/runtime.py's
            # execute_stage() treated it as a stage failure, retried it
            # per the queue's retry policy, and eventually dead-lettered
            # it -- only then did
            # execution_driver._on_enrichment_failure_outcome's
            # "contact" branch get a chance to fall back to Maps-level
            # phone/email facts before pruning.
            #
            # That is not "inventing success" for a bug that never
            # happened -- returning this ContactIntel populates nothing
            # but the fetch-failed flags and pipeline_id; every other
            # field (emails, phones, contact_form_url, etc.) stays at
            # its default None/empty, identical to what a real "no
            # contact data found" ContactIntel already looks like
            # elsewhere in this method. Every downstream consumer
            # (_contact_downstream's required_channels gate,
            # QualificationWorker) already treats an empty/None contact
            # field as "no evidence found", never as a positive claim
            # that the business has no contact info -- so this changes
            # nothing about what "success" means, only how a business
            # that already satisfies its required channel(s) from
            # Maps-level data alone (e.g. business.phone already set,
            # required_channels=("phone",)) gets there: through the
            # SUCCESS path (_contact_downstream, which has the exact
            # same Maps-fallback logic as
            # _on_enrichment_failure_outcome's contact branch) instead
            # of being forced through a wasteful and fragile
            # retry-then-dead-letter cycle first. A business whose
            # required channel truly isn't satisfiable from Maps data
            # either is still correctly rejected at Qualification --
            # that's a legitimate rejection, not a bug this changes.
            return ContactIntel(
                pipeline_id=item.pipeline_id,
                contact_page_fetch_failed=contact_page_fetch_failed,
                homepage_fetch_failed=homepage_fetch_failed,
                secondary_page_fetch_failed=secondary_page_fetch_failed,
                secondary_fallback_attempted=secondary_fallback_attempted,
                secondary_fallback_url=secondary_fallback_url,
                secondary_fallback_success=secondary_fallback_success,
                secondary_fallback_fetch_failed=secondary_fallback_fetch_failed,
            )

        partial_contact_success = bool(
            (contact_page_fetch_failed or homepage_fetch_failed or secondary_page_fetch_failed)
            and (
                emails
                or phones
                or contact_form_url
                or whatsapp_link
                or messenger_link
                or telegram_link
                or linkedin_url
                or instagram_url
            )
        )

        # Best (own-domain, outreach-role) email first, so the primary
        # email chosen downstream is the most relevant valid one rather
        # than whichever happened to be found first.
        if len(emails) > 1:
            site_host = urllib.parse.urlparse(item.final_url or "").netloc.lower()
            ordered = select_primary_email(list(emails), site_host)
            emails = {e: emails[e] for e in ordered if e in emails}

        email_source = next(iter(emails.values())) if emails else None
        phone_source = next(iter(phones.values())) if phones else None

        return ContactIntel(
            pipeline_id=item.pipeline_id,
            emails=tuple(emails) or None,
            phones=tuple(phones) or None,
            contact_form_url=contact_form_url,
            whatsapp_link=whatsapp_link,
            messenger_link=messenger_link,
            telegram_link=telegram_link,
            linkedin_url=linkedin_url,
            instagram_url=instagram_url,
            instagram_source=instagram_source,
            instagram_invalid_candidate_seen=instagram_invalid_candidate_seen,
            fetch_duration=total_elapsed,
            contact_page_fetch_failed=contact_page_fetch_failed,
            homepage_fetch_failed=homepage_fetch_failed,
            mailto_extracted=mailto_extracted,
            tel_extracted=tel_extracted,
            partial_contact_success=partial_contact_success,
            email_source=email_source,
            phone_source=phone_source,
            email_provenance=tuple(emails.items()) or None,
            phone_provenance=tuple(phones.items()) or None,
            secondary_page_type=secondary_page_type,
            secondary_page_fetched=secondary_page_fetched,
            secondary_page_fetch_failed=secondary_page_fetch_failed,
            secondary_fallback_attempted=secondary_fallback_attempted,
            secondary_fallback_url=secondary_fallback_url,
            secondary_fallback_success=secondary_fallback_success,
            secondary_fallback_fetch_failed=secondary_fallback_fetch_failed,
        )


    def timeout_seconds(self) -> float:
        return self._timeout

    # -- internal, pure helpers ------------------------------------------
    #
    # Stateless functions of their arguments only — no instance state
    # read or written, so these can't leak between process() calls.

    @staticmethod
    def _pages_to_fetch(item: WebsiteIntel) -> Tuple[Tuple[str, str], ...]:
        """
        (role, url) pairs — contact_page first (most likely to hold a
        contact form/explicit channels), then final_url if present and
        distinct. See module docstring "Which pages get fetched".
        """
        urls: "dict[str, str]" = {}
        if item.contact_page:
            urls.setdefault(item.contact_page, "contact_page")
        if item.final_url:
            urls.setdefault(item.final_url, "homepage")
        return tuple((role, url) for url, role in urls.items())

    def _fetch(self, url: str) -> Tuple[str, str, float]:
        """
        Fetch `url` and return (html, resolved_url, elapsed_seconds).

        Bounded retry for TRANSIENT failures only (429 with Retry-After,
        500/502/503/504 once). Permanent client errors (400/401/403/404/
        410...) are raised immediately — a retry cannot change them. The
        body is read through a hard size cap and each request holds one of
        the process-wide bounded fetch slots.
        """
        raw_url = strip_control_characters(url.strip())
        if not re.match(r"^https?://", raw_url, re.IGNORECASE):
            raw_url = "https://" + raw_url

        if is_local_isolation_enforced():
            assert_loopback_url(raw_url)

        headers = {
            "User-Agent": _USER_AGENT,
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
            "Accept-Language": "en-US,en;q=0.9",
            "Connection": "close",
        }

        def _do_http(target: str) -> Tuple[str, str, float]:
            if is_local_isolation_enforced():
                assert_loopback_url(target)
            req = urllib.request.Request(target, headers=headers)
            start = time.monotonic()
            with fetch_slot():
                if is_local_isolation_enforced():
                    opener = urllib.request.build_opener(LocalIsolationRedirectHandler())
                    with opener.open(req, timeout=self._timeout) as response:
                        elapsed = time.monotonic() - start
                        resolved_url = response.geturl()
                        raw = read_capped(response)
                        charset = response.headers.get_content_charset() or "utf-8"
                else:
                    with urllib.request.urlopen(req, timeout=self._timeout) as response:
                        elapsed = time.monotonic() - start
                        resolved_url = response.geturl()
                        raw = read_capped(response)
                        charset = response.headers.get_content_charset() or "utf-8"
            html = raw.decode(charset, errors="replace")
            return html, resolved_url, elapsed

        try:
            return _do_http(raw_url)
        except urllib.error.HTTPError as exc:
            if is_permanent_http_error(exc.code):
                raise
            if exc.code == 429:
                retry_after = exc.headers.get("Retry-After") if exc.headers else None
                wait = 0.5
                if retry_after:
                    try:
                        wait = min(max(float(retry_after), 0.1), 2.0)
                    except Exception:
                        wait = 0.5
                time.sleep(wait)
                return _do_http(raw_url)
            elif exc.code in (500, 502, 503, 504):
                time.sleep(0.2)
                return _do_http(raw_url)
            else:
                raise

    @staticmethod
    def _extract_page_contact_data(
        *,
        html: str,
        page_url: str,
        page_role: str,
        emails: "dict[str, str]",
        phones: "dict[str, str]",
        raw_anchors: Optional[List[str]] = None,
        region: Optional[str] = None,
    ) -> None:
        if not html:
            return

        phone_keys: set[str] = {phone_dedup_key(p) for p in phones}

        def _add_phone(num: str, source: str) -> None:
            # Normalize first (country-aware, extension-safe), then dedup
            # on the canonical digits so "+20 100 123 4567" and
            # "0100 123 4567" are one number, not two.
            if not num:
                return
            norm = normalize_phone(num, region)
            if not norm or not is_valid_phone(norm):
                return
            key = phone_dedup_key(norm)
            if key in phone_keys:
                return
            phone_keys.add(key)
            phones[norm] = source

        def _add_email(addr: str, source: str) -> None:
            clean = urllib.parse.unquote(addr).strip().lower()
            if clean and is_valid_email(clean):
                emails.setdefault(clean, source)

        # 1. Anchor mailto: and tel: links (reuses pre-extracted anchors if supplied)
        anchors = raw_anchors if raw_anchors is not None else _ANCHOR_RE.findall(html)
        for href in anchors:
            href_clean = decode_entities(href.strip())
            if href_clean.lower().startswith(_MAILTO_PREFIX):
                address = href_clean[len(_MAILTO_PREFIX):].split("?", 1)[0].strip()
                # A mailto may list several recipients ("a@x.com,b@x.com").
                for part in re.split(r"[,;]", address):
                    _add_email(part, "mailto")
            elif href_clean.lower().startswith(_TEL_PREFIX):
                number = href_clean[len(_TEL_PREFIX):].split("?", 1)[0].strip()
                number = urllib.parse.unquote(number)
                _add_phone(number, "tel")

        # 2. JSON-LD structured data (Organization / LocalBusiness / ContactPoint)
        jsonld_data = extract_jsonld_contact_data(html)
        for e in jsonld_data.get("emails", []):
            _add_email(e, "jsonld")
        for p in jsonld_data.get("phones", []):
            _add_phone(p, "jsonld")

        # 3. Contextual HTML attributes (aria-label, title, alt, data-*) & icon containers
        attr_data = extract_contextual_attribute_contacts(html)
        for e in attr_data.get("emails", []):
            _add_email(e, page_role)
        for p in attr_data.get("phones", []):
            _add_phone(p, page_role)

        # 4. Text regex emails (entity-decoded so `info&#64;shop.com` is seen)
        decoded_html = decode_entities(html)
        for match in _EMAIL_RE.findall(decoded_html):
            _add_email(match, page_role)

        # 4b. Bracket-obfuscated emails ("name [at] shop [dot] com")
        for e in extract_obfuscated_emails(decoded_html):
            _add_email(e, page_role)

        # 5. Text / visible phones
        for token in extract_phones(html, region):
            _add_phone(token, page_role)

    @staticmethod
    def _extract_first_link(
        html: str, base_url: str, pattern: "re.Pattern[str]"
    ) -> Optional[str]:
        for href in _ANCHOR_RE.findall(html):
            resolved = strip_control_characters(urljoin(base_url, href.strip()))
            if pattern.search(resolved):
                return resolved
        return None

    @staticmethod
    def _extract_instagram_evidence(html: str) -> Tuple[Optional[str], Optional[str]]:
        """
        (url, source) for the highest-ranked Instagram evidence found on
        the page, or (None, None). Delegates entirely to
        `utils.parsing.extract_ig_urls_with_source`, which already
        canonicalizes to `https://www.instagram.com/<handle>/` and
        rejects reserved/non-profile paths (`/p/`, `/reel/`, `/explore/`,
        purely numeric segments, etc.) — see this module's own
        docstring, "Instagram-discovery correction", for why no separate
        extraction logic is written here.

        Phase 14.2: broadened from a single `extract_ig_urls()` call to
        `extract_ig_urls_with_source()`, which additionally recognizes a
        literal instagram.com URL wherever it appears in this
        already-fetched HTML (anchor href, JSON-LD `sameAs`, `<meta>`
        content attributes, or bare in the markup) and a business-specific
        plain-text @handle next to the word "instagram". No new page is
        fetched and no crawling is added — this only looks harder at the
        HTML ContactWorker already has in hand.

        Phase 27 (Step 5-7): `extract_ig_urls_with_source` now also
        recognizes scheme-less/protocol-relative Instagram URLs and
        `data-instagram*` attributes, and returns candidates ranked by
        evidence strength (anchor/social link > data attribute > JSON-LD
        > meta > raw HTML > plain @handle) with the strongest candidate
        first — this method still just takes that first entry, so the
        selection logic itself lives entirely in
        `extract_ig_urls_with_source`, not here. `source` is carried
        through to `ContactIntel.instagram_source` purely for telemetry
        (see Phase 14.2's execution_driver/service telemetry wiring) —
        it plays no part in qualification.
        """
        if not html:
            return None, None
        evidence = extract_ig_urls_with_source(html)
        if not evidence:
            return None, None
        return evidence[0]

