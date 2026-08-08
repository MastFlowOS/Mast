"""
MAST Engine V2 — Exceptions Package (placeholder)
====================================================

Source: Engine BluePrint, Phase 1.1 Principle 7 ("One bad business
must never slow another") and Phase 1.4 ("Retry Strategy" / "Dead
Letter Queue").

Future responsibility
----------------------
The blueprint's structure implies a shared, typed vocabulary of engine
failure modes so that timeouts, retry exhaustion, and dead-lettering
are handled consistently across every worker and queue instead of each
one inventing its own ad-hoc error handling. This is not spelled out as
its own named file in the blueprint's V2 folder structure, but this
milestone's task explicitly calls for the package, so it is created now
as an empty placeholder rather than left undecided.

Expected future contents (not implemented in this milestone):
    - A base engine exception type.
    - A worker timeout exception (Phase 1.3 "Timeout Rules").
    - A retry-exhausted exception (Phase 1.4 "Retry Strategy").
    - A dead-letter exception (Phase 1.4 "Dead Letter Queue").

Status
------
FOUNDATION ONLY (Milestone 1). Empty package — no modules, no classes,
no logic. Not imported by the currently running engine.

TODO(future milestones): the concrete exception hierarchy will be
defined once a milestone (likely Phase 3 or Phase 4) actually needs
workers/queues to raise and catch typed errors instead of implicit
ones.

Engine 2.0 Fix — Discovery failure semantics
---------------------------------------------
`DiscoveryFailure` below is the first concrete member of this
package's exception hierarchy. It exists specifically to close the
gap described in the Engine 2.0 discovery-reliability fix: a
discovery provider (currently `scraper/maps_scraper.py`'s
`MapsScraper.search()`) that fails to *access or discover* results —
no results panel found, a Google consent/interstitial page, a
block/challenge page, a navigation timeout, or a raw parsing failure
— must never be indistinguishable from a search whose result set
genuinely ran out. Before this, a failed discovery attempt and a
truly exhausted one produced the exact same observable outcome
(`return` from the generator with nothing yielded), which downstream
callers (service.py's `__done__` sentinel, then
`src/jobs/discoverJob.ts`'s `citySearchExhausted` /
`rotation.markCurrentSearchExhausted`) could not tell apart — a
failure got silently recorded as "this city/niche has no more
matching businesses," permanently starving it of future attempts.

`DiscoveryFailure` carries a `reason` drawn from `DiscoveryFailureReason`
(a closed, machine-readable vocabulary — not a free-text message) so
that every layer between the scraper and the job that receives the
`__done__` sentinel can make that distinction on `reason` alone,
without string-matching a human log message.
"""

from __future__ import annotations

from enum import Enum


class DiscoveryFailureReason(str, Enum):
    """Closed vocabulary of ways a discovery attempt can fail to reach
    or parse results, distinct from genuine exhaustion (which is not
    a failure at all and is therefore not a member of this enum).

    Subclassing `str` means these compare/serialize as their own
    value (e.g. `DiscoveryFailureReason.PANEL_NOT_FOUND == "PANEL_NOT_FOUND"`),
    so they round-trip through `json.dumps`/the JSONL bridge protocol
    with no separate serialization step required at either end.
    """

    # No selector in the results-panel candidate list matched anything
    # that validated as an actual results feed (see
    # scraper/maps_scraper.py's `_resolve_results_panel`).
    PANEL_NOT_FOUND = "PANEL_NOT_FOUND"
    # Landed on a Google consent interstitial (consent.google.com or a
    # `/consent` path) instead of Maps results, and no ordinary
    # accept-cookies control was available to dismiss it.
    CONSENT_REQUIRED = "CONSENT_REQUIRED"
    # Landed on Google's automated-traffic block/"sorry" page.
    BLOCKED = "BLOCKED"
    # Some other CAPTCHA-like challenge state was detected.
    CHALLENGE = "CHALLENGE"
    # `page.goto()` (or the panel-readiness wait that follows it) never
    # settled within the configured bound.
    NAVIGATION_TIMEOUT = "NAVIGATION_TIMEOUT"
    # The page loaded and is reachable, but its structure doesn't match
    # anything recognizable as a Maps results page (e.g. redirected to
    # an unrelated Google property).
    INVALID_RESULTS_PAGE = "INVALID_RESULTS_PAGE"
    # A lower-level, non-network exception the scraper cannot classify
    # into any of the above (Playwright/browser-level error, parser
    # exception with no recoverable path, etc).
    SCRAPER_ERROR = "SCRAPER_ERROR"


class DiscoveryFailure(Exception):
    """Raised by a discovery provider when it fails to access or parse
    results, as opposed to genuinely exhausting them.

    Callers up the stack (service.py's `_main_cli`, in particular)
    catch this specifically so its `reason` can be attached to the
    `__done__` sentinel as a machine-readable field instead of the
    failure being indistinguishable from `exhausted=True`. Any other
    (unclassified) exception continues to propagate and crash the
    subprocess as before — this type is additive, not a replacement
    for normal error handling.
    """

    def __init__(self, reason: "DiscoveryFailureReason | str", detail: str = "") -> None:
        self.reason = DiscoveryFailureReason(reason) if not isinstance(reason, DiscoveryFailureReason) else reason
        self.detail = detail
        super().__init__(f"{self.reason.value}: {detail}" if detail else self.reason.value)
