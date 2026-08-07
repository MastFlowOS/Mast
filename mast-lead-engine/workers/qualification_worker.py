"""
MAST Engine V2 — Qualification Worker
========================================

Source: Engine BluePrint Phase 1.3 (Worker Types — Qualification
Worker), Phase 1.5 (Stage 5 — "validate Businesses, score Businesses,
determine Opportunity eligibility"), Phase 1.2 (Golden Rule — one
input, one output), and the Phase 5.7 implementation prompt. Builds on
workers/base_worker.py without duplicating any lifecycle logic, exactly
as workers/website_worker.py, workers/instagram_worker.py, and
workers/contact_worker.py do.

Responsibility
--------------
QualificationWorker performs exactly one transformation:

    EnrichedBusiness -> QualificationWorker.process() -> QualificationResult

It is the FIRST worker in the engine allowed to make a judgement:
every upstream worker (Website, Instagram, Contact) only reports
objective inspection facts. QualificationWorker reads those facts and
applies fixed, deterministic rules to decide whether the business
qualifies as an Opportunity. It does not discover, inspect websites,
crawl Instagram, extract contacts, score, store, retry, or talk to any
queue/session/runtime component.

Like WebsiteWorker/InstagramWorker/ContactWorker, this is a pure
transformer, not a producer: no callback, no streaming, one input in
and one already-finished output out.

Architecture review (Phase 5.7, pre-implementation)
--------------------------------------------------------------------
Reviewing `engine.contracts.QualificationResult` against this
milestone's stated responsibility surfaced four problems, all
corrected in `engine/contracts.py` directly rather than worked around
here — same discipline WebsiteWorker/InstagramWorker/ContactWorker's
own reviews used:

1. `confidence` — removed. A confidence score is an estimated
   probability, exactly what this milestone's "do not estimate
   probabilities... do not invent scores" line forbids.

2. `matched_skills` — removed. Computing it requires comparing the
   business's needs against a specific freelancer's or agency's skill
   set, but no skills-catalog or freelancer-profile contract exists
   anywhere in this codebase, and this worker's only input,
   EnrichedBusiness, carries no such data. There is nothing to match
   against. Inventing a skills catalog to make the field computable
   would itself be inventing architecture — out of scope, flagged
   rather than worked around.

3. `reasons` / `rejected_reason` — consolidated to `reasons` (a single
   tuple covering both the qualified and rejected case). Two fields
   for one concept.

4. `problems` / `business_problems` — consolidated to
   `business_problems`. Same redundancy.

See `QualificationResult`'s own docstring in `engine/contracts.py` for
the complete field-by-field rationale.

Deterministic rule set
------------------------
Every rule below reads only facts already present on the
EnrichedBusiness this worker was given (business, website_intel,
instagram_intel, contact_intel) or on this worker's own construction
configuration (required_categories). Given the same EnrichedBusiness
and the same worker configuration, process() always returns the same
QualificationResult — no randomness, no AI, no hidden heuristics.

Rejection rules, evaluated in a fixed order (first match wins, per
the milestone's own example rejection reasons):

    1. No website on the business at all
       -> rejected_reason: "missing required website"
    2. WebsiteWorker reported the website unreachable
       -> rejected_reason: "website unreachable"
    3. No contact method found on any channel WebsiteWorker,
       InstagramWorker, or ContactWorker inspected
       -> rejected_reason: "no contact methods"
    4. `required_categories` was configured and the business's
       category is not in it
       -> rejected_reason: "unsupported business type"

A business that clears all four is qualified. `business_problems` and
`needed_services` are collected independently of the qualify/reject
decision — a qualified business can still carry problems (e.g. "no
HTTPS") that describe what a freelancer could fix.

Missing upstream intel (website_intel, instagram_intel, or
contact_intel being None — e.g. a business with no website at all, so
WebsiteWorker/ContactWorker never had anything to inspect) is treated
as "no facts available from that worker," never as a qualification
failure by itself and never guessed at. Rule 1 already catches the
"no website" case explicitly; a missing instagram_intel simply cannot
contribute an Instagram-derived fact or need.

Error handling
----------------
No exception is caught or swallowed anywhere in this module. A
malformed EnrichedBusiness (the one case this worker cannot recover
from, since it has no fallback data source) propagates unmodified —
per this milestone's "allow exceptions to propagate... do not return
partial qualification."

Thread safety / statelessness
-------------------------------
No module-level mutable state, no caches. `required_categories` is
set once at construction (mirroring WebsiteWorker's `timeout`) and
never mutated; process() reads only its own argument and that frozen
configuration.

Status
------
Phase 5.7. Depends only on EnrichedBusiness, QualificationResult,
BaseWorker, WorkerCapability, and the standard library. No queue/,
providers/, engine.coordinator, or runtime import anywhere in this
file — matching WebsiteWorker/InstagramWorker/ContactWorker exactly.
"""

from __future__ import annotations

from typing import FrozenSet, Optional

from engine.contracts import EnrichedBusiness, QualificationResult
from workers.base_worker import BaseWorker
from workers.worker_capability import WorkerCapability

WORKER_TYPE = "qualification"

#: QualificationWorker makes no network calls of its own — it only
#: evaluates facts already collected by upstream workers — so its
#: timeout budget is not bound by Phase 1.3's per-fetch Timeout Rules
#: (Website=8s, Instagram=6s) the way those workers' budgets are. Kept
#: small and explicit rather than borrowing either of those numbers.
DEFAULT_TIMEOUT_SECONDS = 1.0


class QualificationWorker(BaseWorker[EnrichedBusiness, QualificationResult]):
    """
    Transforms one EnrichedBusiness into one QualificationResult by
    applying fixed, deterministic eligibility rules to the facts
    already collected by WebsiteWorker, InstagramWorker, and
    ContactWorker. Owns nothing else — see module docstring.
    """

    def __init__(
        self,
        *,
        niche: Optional[str] = None,
        required_categories: Optional[FrozenSet[str]] = None,
        timeout: float = DEFAULT_TIMEOUT_SECONDS,
        worker_id: Optional[str] = None,
    ) -> None:
        """
        niche:
            Which ruleset this worker instance is configured for.
            Configuration, not a fact read off any EnrichedBusiness —
            echoed onto every QualificationResult this instance
            produces. None means "no niche restriction."
        required_categories:
            If set, BusinessCandidate.category must be a member of
            this set or the business is rejected as "unsupported
            business type" (rule 4). None means "no category
            restriction" — every category is accepted.
        """
        super().__init__(
            worker_type=WORKER_TYPE,
            capabilities=(WorkerCapability(name=WORKER_TYPE),),
            worker_id=worker_id,
        )
        self._niche = niche
        self._required_categories = required_categories
        self._timeout = timeout

    # -- WorkerInterface -------------------------------------------------

    def process(self, item: EnrichedBusiness) -> QualificationResult:
        """
        Consume exactly one EnrichedBusiness and produce exactly one
        QualificationResult. Never mutates `item`. Deterministic: the
        same EnrichedBusiness against the same worker configuration
        always produces the same QualificationResult.
        """
        business = item.business
        website_intel = item.website_intel
        instagram_intel = item.instagram_intel
        contact_intel = item.contact_intel

        reasons: list[str] = []
        rejected = False

        # Rule 1 — no website at all.
        has_website_field = bool(business is not None and business.website)
        if not has_website_field:
            reasons.append("missing required website")
            rejected = True

        # Rule 2 — website reachability, only meaningful if a website
        # was actually inspected.
        if (
            not rejected
            and website_intel is not None
            and website_intel.website_reachable is False
        ):
            reasons.append("website unreachable")
            rejected = True

        # Rule 3 — no contact method found on any inspected channel.
        if not rejected and not self._has_any_contact_method(
            business, instagram_intel, contact_intel
        ):
            reasons.append("no contact methods")
            rejected = True

        # Rule 4 — category restriction, only if configured.
        if (
            not rejected
            and self._required_categories is not None
            and (business is None or business.category not in self._required_categories)
        ):
            reasons.append("unsupported business type")
            rejected = True

        business_problems = self._collect_business_problems(
            business, website_intel, instagram_intel, contact_intel
        )
        needed_services = self._collect_needed_services(
            business, website_intel, instagram_intel, contact_intel
        )

        return QualificationResult(
            pipeline_id=item.pipeline_id,
            niche=self._niche,
            qualified=not rejected,
            reasons=tuple(reasons),
            business_problems=business_problems,
            needed_services=needed_services,
        )

    def timeout_seconds(self) -> float:
        return self._timeout

    # -- internal, pure helpers ------------------------------------------
    #
    # Stateless functions of their arguments only — no instance state
    # read (other than the frozen configuration passed in explicitly),
    # so these can't leak between process() calls. Every helper reports
    # a fact already present on the EnrichedBusiness's own upstream
    # intel, or its absence — never a guess.

    @staticmethod
    def _has_any_contact_method(
        business,
        instagram_intel,
        contact_intel,
    ) -> bool:
        if business is not None and business.phone:
            return True
        if contact_intel is not None and (
            contact_intel.emails
            or contact_intel.phones
            or contact_intel.contact_form_url
            or contact_intel.whatsapp_link
            or contact_intel.messenger_link
            or contact_intel.telegram_link
            or contact_intel.linkedin_url
        ):
            return True
        if instagram_intel is not None and instagram_intel.contact_buttons:
            return True
        return False

    @staticmethod
    def _collect_business_problems(
        business,
        website_intel,
        instagram_intel,
        contact_intel,
    ) -> tuple[str, ...]:
        problems: list[str] = []

        if business is None or not business.website:
            problems.append("no_website")
        elif website_intel is not None and website_intel.website_reachable is False:
            problems.append("site_unreachable")
        elif website_intel is not None and website_intel.https is False:
            problems.append("no_https")

        if instagram_intel is None or instagram_intel.profile_reachable is not True:
            problems.append("no_instagram_presence")

        if contact_intel is None or not (
            contact_intel.emails
            or contact_intel.phones
            or contact_intel.contact_form_url
        ):
            problems.append("no_contact_methods")

        return tuple(problems)

    @staticmethod
    def _collect_needed_services(
        business,
        website_intel,
        instagram_intel,
        contact_intel,
    ) -> tuple[str, ...]:
        """
        Phase 5.8 correction: this previously also appended
        "social media presence" whenever instagram_intel was absent
        or unreachable. Removed on review: unlike "website" /
        "website repair" below — which are direct restatements of a
        fact already used in this worker's own rejection rules 1 and
        2 (missing/unreachable website) — "no Instagram profile
        implies this business needs social media marketing" is not a
        restatement of any fact on EnrichedBusiness. It is an added
        claim about what kind of marketing benefits this business,
        which does not hold universally (many business types have no
        use for Instagram) and is not backed by any qualification
        rule. That is a judgement, not a deterministic rule, and this
        worker is bound not to make one — see module docstring,
        "QUALIFICATION MUST NOT: ... invent scores" /
        "do not guess... do not infer" boundary shared with
        WebsiteIntel/InstagramIntel/ContactIntel's own field reviews.
        """
        needed: list[str] = []

        if business is None or not business.website:
            needed.append("website")
        elif website_intel is not None and website_intel.website_reachable is False:
            needed.append("website repair")

        return tuple(needed)
