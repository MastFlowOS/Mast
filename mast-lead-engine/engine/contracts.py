"""
MAST Engine V2 — Data Contracts
================================

Source: Engine BluePrint, Phase 1.2 ("Data Contracts"), with one
explicit revision supplied alongside the Milestone 2 implementation
prompt (QualifiedOpportunity — see section 8 below), and a Phase 5.4
architecture correction to WebsiteIntel (see section 2 below).

Responsibility
--------------
This module is the single home for every object that flows through the
V2 engine. It defines *shape only* — no behavior, no validation logic,
no persistence, no scoring. Nothing in this file talks to Supabase,
Google Maps, or any worker.

Golden Rule (Phase 1.2)
------------------------
Objects are immutable. A worker never mutates its input — it reads one
object and produces a brand new object of a different type:

    BusinessCandidate -> WebsiteWorker -> WebsiteIntel

Never:

    business.website = "..."   # forbidden — mutation of a prior stage

Every contract below is a frozen, slotted dataclass so this rule is
enforced by Python itself (attribute assignment raises
FrozenInstanceError) rather than by convention alone. Collection
fields use tuples instead of lists so a caller can't mutate a
"finished" object's insides even though the object reference itself is
frozen.

Ownership Table (who may create / read / modify each contract)
----------------------------------------------------------------------
Object                  Created By              Read By            Can Modify
DiscoverySession        Engine                  Everyone           Engine
BusinessCandidate       GoogleMapsWorker        Everyone           Nobody
WebsiteIntel            WebsiteWorker           MergeWorker        Nobody
InstagramIntel          InstagramWorker         MergeWorker        Nobody
ContactIntel            ContactWorker           MergeWorker        Nobody
EnrichedBusiness        MergeWorker             Qualification      Nobody
QualificationResult     QualificationWorker     Scoring            Nobody
OpportunityScore        ScoringWorker           Storage            Nobody
QualifiedOpportunity    Qualification + Score   Storage            Nobody
StoredOpportunity       StorageWorker           Frontend           Nobody
QueueItem               Queue Manager           Workers            Queue Manager (state only, Phase 4+)

Note on BusinessCandidate.instagram_url: this is an optional discovery
field, not a guaranteed one. A discovery provider MAY populate it when
that provider naturally exposes an Instagram profile as part of
discovery (e.g. a future provider whose source data includes a social
link); a provider that has no way to discover an Instagram profile
simply leaves it unset (None). The Ownership Table's "Created By:
GoogleMapsWorker" for BusinessCandidate as a whole is unchanged by
this — it still names the sole creator of the object — this note only
clarifies that one particular field on that object is populated
opportunistically, not unconditionally, by whichever provider creates
it.

Status
------
Milestone 2. These dataclasses are now the real, final-shaped
contracts for Phase 1.2 (frozen, slotted, explicitly typed). Nothing
in the current running engine (scraper/, enrichment/, storage/,
scoring/, service.py) imports or is affected by this module yet — see
module docstring in engine/__init__.py for the zero-runtime-change
guarantee for this milestone.

Phase 5.4 change: WebsiteIntel was refined as an architecture
correction (not a WebsiteWorker-side workaround) after the field list
was found to be inconsistent with the approved worker responsibilities
— see WebsiteIntel's own docstring below for the full field-by-field
ownership mapping and rationale.

Phase 5.5 change: InstagramIntel received the same kind of correction
for the same reason (one derived-metric field removed, several
inspection-fact fields added, one field renamed for clarity) — see
InstagramIntel's own docstring below. BusinessCandidate also gained
one new field, instagram_url, as a direct consequence — see ambiguity
3 below and instagram_url's inline comment on BusinessCandidate.

TODO(future milestones):
    - Phase 3 (Worker Framework): workers/ will begin producing/consuming
      these contracts instead of ad-hoc dicts.
    - Phase 5 (Discovery Provider): GoogleMapsProvider will be the only
      producer of BusinessCandidate.
    - Phase 6 (Enrichment Package): WebsiteWorker, InstagramWorker,
      ContactWorker, and MergeWorker will populate WebsiteIntel,
      InstagramIntel, ContactIntel, and EnrichedBusiness respectively.
    - Phase 7 (Qualification Engine): QualificationWorker and
      ScoringWorker will populate QualificationResult and
      OpportunityScore, and combine them into QualifiedOpportunity.
    - Phase 8 (Storage Layer): StorageWorker will populate
      StoredOpportunity after a successful Supabase insert.
    - Phase 4 (Queue Framework): queue/manager.py will be the only
      writer of QueueItem.state transitions.
    - Validation, defaults beyond typing, and helper methods are
      intentionally absent and will be added only when a milestone
      requires them.

Ambiguities found while implementing this milestone (reported per
this milestone's "stop and ask, don't guess" rule — none of them
blocked implementation, but each is a real gap in the blueprint and is
called out explicitly rather than resolved silently):

    1. QueueItem "reservation state" — Phase 1.4 describes QueueItem's
       *field list* (pipelineId, sessionId, stage, payload, attempt,
       createdAt, lastUpdated, workerId, timeoutAt) without a
       "reservation state" field, but the Milestone 2 prompt explicitly
       asks for one, and Phase 1.4's own "Queue States" section defines
       exactly the enum needed (WAITING/RESERVED/PROCESSING/COMPLETED/
       FAILED/REJECTED — already present as QueueItemState in
       engine/state.py). I wired the existing enum in as
       `QueueItem.state` rather than inventing a new type. Flagging
       this because it's a field the Phase 1.2/1.4 text doesn't
       literally list, even though the type already exists for
       exactly this purpose.
    2. DiscoverySession.queue_stats / worker_stats / performance_stats
       — Phase 1.2 names these fields but never defines their shape
       (Phase 1.3/1.4 describe *candidate* metrics like queue length,
       oldest item age, processing rate, worker utilization, failure
       rate, but not a schema). Left untyped (`Optional[dict[str,
       Any]]`) as explicit placeholders pending Phase 3 (worker stats)
       and Phase 4 (queue stats), rather than guessing a schema now.
    3. BusinessCandidate had no field of any kind for locating an
       Instagram profile — unlike `website`, which already let
       WebsiteWorker's milestone work unmodified. This was found during
       Phase 5.5 (InstagramWorker) review: the milestone's own stated
       responsibility ("locate the Instagram profile using information
       already available on the BusinessCandidate") was literally
       unsatisfiable without it. Added `instagram_url` as the minimal,
       purely additive fix, mirroring `website`'s shape exactly. No
       current provider populates it; that remains future work,
       explicitly out of scope for this milestone.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Optional

from engine.state import QueueItemState


# ---------------------------------------------------------------------------
# 1. BusinessCandidate
# ---------------------------------------------------------------------------
@dataclass(frozen=True, slots=True)
class BusinessCandidate:
    """
    The ONLY object a discovery provider (e.g. Google Maps) is allowed
    to create. Discovery-only fields — no score, no social, no email,
    no opportunity judgment of any kind.

    Created by: a DiscoveryProviderInterface implementation (Phase 5:
    GoogleMapsProvider first).
    Consumed by: WebsiteWorker, InstagramWorker, ContactWorker, and
    (eventually) MergeWorker — read-only, per the Ownership Table.
    Terminal or intermediate: intermediate — feeds WebsiteIntel,
    InstagramIntel, ContactIntel, and ultimately EnrichedBusiness.

    instagram_url is an optional discovery field, unlike most fields
    above: a provider populates it only when that provider naturally
    exposes an Instagram profile as part of discovery. A provider with
    no such source data simply leaves it as None — that is a normal,
    expected outcome, not a partial or failed discovery. See
    instagram_url's own inline comment below for the full rationale.
    """

    # Identifiers
    pipeline_id: str
    session_id: str

    # Configuration
    provider: str
    provider_business_id: Optional[str] = None

    # Data
    maps_url: Optional[str] = None
    name: Optional[str] = None
    category: Optional[str] = None
    address: Optional[str] = None
    city: Optional[str] = None
    country: Optional[str] = None
    website: Optional[str] = None
    phone: Optional[str] = None
    rating: Optional[float] = None
    review_count: Optional[int] = None
    coordinates: Optional[tuple[float, float]] = None

    # Metadata
    discovered_at: Optional[str] = None

    # Phase 5.5 addition: the field InstagramWorker locates a profile
    # from, mirroring `website` above for WebsiteWorker. Added because
    # no field existed anywhere on this contract for InstagramWorker to
    # read — see InstagramIntel's docstring, "Phase 5.5 architecture
    # correction", ambiguity 1, for the full rationale. Optional and
    # appended last so this remains a purely additive, non-breaking
    # change: any existing keyword-constructed BusinessCandidate (no
    # provider currently populates this) is unaffected, and Migration
    # Rule 4 (no behavior change) holds — a provider populating it is
    # future work, not part of this milestone.
    #
    # This is an OPTIONAL discovery field, not a required or
    # guaranteed one: a discovery provider MAY populate it when that
    # provider naturally exposes an Instagram profile as part of its
    # own discovery process. A provider that has no way to discover an
    # Instagram profile leaves it as None — that is the normal,
    # expected case for every provider today (none currently populate
    # it), not an error or a partial-discovery signal. InstagramWorker
    # already treats None here as "no profile to inspect" rather than
    # a failure — see workers/instagram_worker.py's own reachability
    # handling.
    instagram_url: Optional[str] = None

    # Phase 4A addition: surfaces RawPlace.closed (scraper/maps_scraper.py)
    # onto the discovery contract so a permanently-closed business can be
    # recognized — and safely pruned before Website/Contact enrichment —
    # by anything downstream of a DiscoveryProviderInterface, not just
    # MapsScraper's own internal search loop (which already skips closed
    # places before they're ever yielded as a RawPlace, but that guard is
    # specific to the Google Maps scraping path; this field lets the
    # contract itself carry the fact for any current or future provider).
    # Defaults to False — an unknown/absent Maps signal is treated the
    # same as "not known to be closed", exactly as RawPlace.closed itself
    # defaults to False. Optional and appended last, mirroring
    # instagram_url immediately above: purely additive, no existing field
    # semantics change, and any existing keyword-constructed
    # BusinessCandidate (no provider currently populates this) is
    # unaffected.
    closed: bool = False

    # Traceability addition: records what niche a candidate's run actually
    # requested from the discovery provider. Purely additive and observational
    # — not used for gating, filtering, or scoring.
    requested_niche: Optional[str] = None


# ---------------------------------------------------------------------------
# 2. WebsiteIntel
# ---------------------------------------------------------------------------
@dataclass(frozen=True, slots=True)
class WebsiteIntel:
    """
    Created ONLY by WebsiteWorker. Every field is a direct, objective
    website-inspection fact obtainable from a single HTTP fetch and its
    HTML — nothing here requires rendering, a second page fetch, or
    business judgment.

    Phase 5.4 architecture correction (revised after review): this
    contract previously carried contact-discovery fields (emails_found,
    phones_found, contact_page), a social-discovery field
    (social_links), and business-judgment fields (website_quality,
    logo_present, portfolio_present, broken_pages). Reviewed
    field-by-field:

        - emails_found, phones_found -> removed. Owned by ContactWorker
          (Phase 1.3 worker type). WebsiteWorker's milestone explicitly
          forbids finding emails/phone numbers.
        - social_links -> removed. Owned by InstagramWorker (and any
          future social-discovery worker). WebsiteWorker's milestone
          explicitly forbids finding Instagram/social profiles.
        - website_quality, portfolio_present, broken_pages -> removed.
          Owned by QualificationWorker — these are business-eligibility
          judgments, not facts a single page fetch establishes
          objectively (broken_pages specifically would require a
          multi-page site-wide crawl, which is out of scope for a
          single BusinessCandidate -> WebsiteIntel transformation).
        - logo_present -> removed. Reconsidered on review: not excluded
          because it's inherently a judgment, but because a plain
          HTTP+HTML inspector (no rendering — see WebsiteWorker's own
          module docstring for why that's the intended architecture,
          not an oversight) cannot reliably observe it. Logos are
          frequently CSS background-images, inline SVG with no
          identifying text, or JS-injected — invisible to raw HTML
          parsing, unlike a technology fingerprint such as
          detected_platform's near-unique substring matches. Belongs to
          a future rendering-capable worker, should one be introduced.
        - contact_page -> initially removed, then restored on review.
          Discovering that a contact-page-shaped link exists on the
          already-fetched page is single-page structural inspection —
          the same category as detected_platform's signature matching,
          not a second page fetch. Extracting emails/phones from that
          linked page remains ContactWorker's job and is out of scope
          here; this field stores only the discovered link.

    final_url, http_status, detected_platform, page_language, and
    redirect_chain were added in the same pass — WebsiteWorker's actual
    scope always needed them and no field previously existed to hold
    them.

    Created by: WebsiteWorker (Phase 6), given a BusinessCandidate.
    Consumed by: MergeWorker only, per the Ownership Table.
    Terminal or intermediate: intermediate — one of the four inputs
    MergeWorker combines into an EnrichedBusiness.
    """

    # Identifiers
    pipeline_id: str

    # Data — direct inspection facts only
    website_reachable: Optional[bool] = None
    https: Optional[bool] = None
    final_url: Optional[str] = None
    http_status: Optional[int] = None
    redirect_chain: Optional[tuple[str, ...]] = None
    title: Optional[str] = None
    description: Optional[str] = None
    contact_page: Optional[str] = None
    # Phase 9.1 (audit follow-up, additive): which keyword out of
    # WebsiteWorker's broadened contact-page hint set (e.g. "contact",
    # "press", "careers", "policies", ...) matched the anchor that
    # produced `contact_page` above. None whenever `contact_page` is
    # None. Purely observational — telemetry only (see
    # engine/execution_driver.py's `_website_downstream` /
    # service.py's `_on_progress`) — never read for gating/qualification.
    contact_page_hint: Optional[str] = None
    detected_platform: Optional[str] = None
    page_language: Optional[str] = None

    # Metrics
    response_time: Optional[float] = None
    crawl_duration: Optional[float] = None


# ---------------------------------------------------------------------------
# 3. InstagramIntel
# ---------------------------------------------------------------------------
@dataclass(frozen=True, slots=True)
class InstagramIntel:
    """
    Created ONLY by InstagramWorker. Every field is a direct, objective
    fact observable on the public Instagram profile itself — nothing
    here is a derived metric, an estimate, or a business judgment.

    Phase 5.5 architecture correction (reviewed the same way WebsiteIntel
    was in Phase 5.4 — see that class's docstring above for the
    precedent this follows): the previous field list mixed genuine
    inspection facts with one derived-metric field and was missing
    several fields the finalized InstagramWorker responsibility
    actually needs. Reviewed field-by-field:

        - engagement -> removed. Not something a profile inspection
          observes directly; it is a computed/estimated metric (some
          function of likes, comments, and followers over time), which
          is exactly the "do not invent engagement scores... do not
          estimate popularity" boundary the Phase 5.5 milestone draws.
          If a future worker computes this, it belongs to
          QualificationWorker/ScoringWorker (business-eligibility and
          opportunity judgment), never to the inspector that only
          reports what the profile itself displays.
        - website -> renamed to external_website. Not a field-shape
          change, a naming correction: BusinessCandidate already has
          its own `website` (the business's main site, potentially
          from Google Maps), and InstagramIntel's field is a different
          fact — the external link the *Instagram profile itself*
          exposes, which may or may not match. Keeping both named
          `website` risked exactly the kind of same-named,
          different-meaning collision this module's contracts are
          otherwise careful to avoid.
        - profile_url, display_name, account_type, contact_buttons,
          profile_reachable -> added. All five are things the Phase 5.5
          milestone explicitly lists as in-scope Instagram facts
          (profile URL, display name, account type, public contact
          buttons) or are the direct structural counterpart to
          WebsiteIntel.website_reachable (profile_reachable) — no field
          previously existed to hold any of them.
        - contact_buttons stores only which public contact affordances
          the profile itself displays (e.g. "email", "call",
          "directions" — whatever labels are directly exposed), never
          the resolved email address or phone number behind them.
          Resolving those, on Instagram or anywhere else, remains
          ContactWorker's job — same boundary WebsiteIntel.contact_page
          already draws for its own linked-page discovery.
        - username, followers, following, posts, verified, bio,
          profile_picture, last_post_date -> kept unchanged; each is
          already a direct profile-inspection fact matching this
          contract's own rule.

    Created by: InstagramWorker (Phase 6), given a BusinessCandidate.
    Consumed by: MergeWorker only, per the Ownership Table.
    Terminal or intermediate: intermediate — one of the four inputs
    MergeWorker combines into an EnrichedBusiness.
    """

    # Identifiers
    pipeline_id: str

    # Data — direct profile-inspection facts only
    profile_reachable: Optional[bool] = None
    profile_url: Optional[str] = None
    username: Optional[str] = None
    display_name: Optional[str] = None
    bio: Optional[str] = None
    followers: Optional[int] = None
    following: Optional[int] = None
    posts: Optional[int] = None
    verified: Optional[bool] = None
    account_type: Optional[str] = None
    external_website: Optional[str] = None
    profile_picture: Optional[str] = None
    contact_buttons: Optional[tuple[str, ...]] = None
    last_post_date: Optional[str] = None

    # Metrics
    fetch_duration: Optional[float] = None


# ---------------------------------------------------------------------------
# 4. ContactIntel
# ---------------------------------------------------------------------------
@dataclass(frozen=True, slots=True)
class ContactIntel:
    """
    Created ONLY by ContactWorker — a single worker, per Phase 1.3's
    "Contact Worker" (the blueprint's "Email + Phone" split is an
    implementation-choice note, not two separate workers; see
    engine/interfaces.py's own note on this). Every field is a direct,
    objective contact fact discoverable on the already-fetched
    website/contact page — nothing here is a ranking, a validation
    result, or a guess about which channel is "best".

    Phase 5.6 architecture correction (reviewed the same way
    WebsiteIntel/InstagramIntel were in Phase 5.4/5.5 — see those
    classes' docstrings above for the precedent this follows):

        - Docstring corrected: this previously read "Created by
          EmailWorker + PhoneWorker", contradicting Phase 5.6's single
          ContactWorker architecture. No such two-worker split exists
          anywhere in this codebase; corrected to name ContactWorker
          only.
        - preferred_contact_method -> removed. Not an inspection fact
          — deciding which channel is "preferred" is a judgment about
          the business, not something the page itself states. Same
          category as InstagramIntel.engagement (Phase 5.5) and
          WebsiteIntel.website_quality (Phase 5.4): both removed for
          the identical reason. If a future worker ever ranks contact
          channels, that belongs to QualificationWorker/ScoringWorker,
          never to the inspector that only reports what a page
          exposes.
        - confidence -> removed. A confidence score is an estimate
          about the extraction, not an extracted fact — the same
          "do not invent... do not estimate" boundary that removed
          InstagramIntel.engagement.
        - contact_form_url, whatsapp_link, messenger_link,
          telegram_link, linkedin_url -> added. All are explicitly
          in-scope "objective contact facts" per the Phase 5.6
          milestone's own examples (contact form, WhatsApp/Messenger/
          Telegram links, LinkedIn company page) and no field
          previously existed to hold any of them.
        - emails, phones -> kept unchanged; both are already direct
          extraction facts (mailto:/tel: links and page text) matching
          this contract's own rule.
        - fetch_duration -> added, mirroring
          WebsiteIntel.response_time / InstagramIntel.fetch_duration —
          a timing measurement of ContactWorker's own fetch(es), not a
          judgment.

    Instagram-discovery correction (4-channel blocker fix): this
    contract previously had no field to hold an Instagram URL
    discovered on the scanned website/contact page, even though
    ContactWorker already extracted the structurally identical
    WhatsApp/Messenger/Telegram/LinkedIn link fields above via the
    same anchor scan. QualificationWorker's "instagram" required-
    channel rule already defensively read
    `getattr(contact_intel, "instagram_url", None)` in anticipation of
    this field (see workers/qualification_worker.py) — this was the
    one remaining piece needed to make that read meaningful instead of
    always None. Added `instagram_url` here, matching `linkedin_url`'s
    shape exactly (a single canonical URL, not a tuple — only the
    first/most-confident match found on the scanned pages is kept, the
    same "first match wins" precedent whatsapp_link/messenger_link/
    telegram_link/linkedin_url already use). Populated using the same
    canonicalization and fake-handle rejection already implemented and
    battle-tested in `utils.parsing.extract_ig_urls`/`clean_ig_url`/
    `is_real_ig_handle` (used identically by the V1 crawler in
    `enrichment/site_crawler.py`) — no new normalization logic
    invented here, only reused.

    Phase 8.1 addition (ContactWorker resilience fix): five fields —
    `contact_page_fetch_failed`, `homepage_fetch_failed`,
    `mailto_extracted`, `tel_extracted`, `partial_contact_success` —
    added. Same category as `fetch_duration`: a measurement of this
    worker's own run (which candidate page(s) failed, whether evidence
    came from a literal mailto:/tel: href instead of a fetch, whether
    the result is partial), not a judgment about the business. Default
    `False` for every field preserves the exact prior shape for any
    caller not yet reading them.

    Phase 14.2 addition (Instagram acquisition, quality-preserving):
    two fields — `instagram_source`, `instagram_invalid_candidate_seen`
    — added. Both are plain, observational facts about this worker's
    own extraction, not new evidence and not a qualification input:
        - `instagram_source` names which shape of the page
          `instagram_url` (above) was actually found in —
          "anchor_href", "jsonld", "meta", "raw_html", or
          "plain_handle" — for the telemetry this phase's own
          "Instagram Telemetry" requirement asks for. `None` whenever
          `instagram_url` is `None`.
        - `instagram_invalid_candidate_seen` is `True` when the scanned
          page contained something instagram.com-shaped that
          `utils.parsing`'s existing validation correctly declined
          (a reserved path, a numeric-only segment, a bare homepage
          link) — i.e. a near-miss the extractor saw and rejected, not
          silence. Distinguishes "no Instagram anywhere on the page"
          from "Instagram mentioned but not a business profile" in
          telemetry only; `instagram_url` itself is never set from a
          rejected candidate either way.
    Neither field changes what counts as a valid `instagram_url` or
    feeds QualificationWorker's "instagram" required-channel rule,
    which reads only `instagram_url` (unchanged) exactly as before.

    Created by: ContactWorker (Phase 6), given a WebsiteIntel.
    Consumed by: MergeWorker only, per the Ownership Table.
    Terminal or intermediate: intermediate — one of the four inputs
    MergeWorker combines into an EnrichedBusiness.
    """

    # Identifiers
    pipeline_id: str

    # Data — direct extraction facts only
    emails: Optional[tuple[str, ...]] = None
    phones: Optional[tuple[str, ...]] = None
    contact_form_url: Optional[str] = None
    whatsapp_link: Optional[str] = None
    messenger_link: Optional[str] = None
    telegram_link: Optional[str] = None
    linkedin_url: Optional[str] = None
    instagram_url: Optional[str] = None

    # Metrics
    fetch_duration: Optional[float] = None

    # Metrics — Phase 8.1 (per-page fetch resilience)
    contact_page_fetch_failed: bool = False
    homepage_fetch_failed: bool = False
    mailto_extracted: bool = False
    tel_extracted: bool = False
    partial_contact_success: bool = False

    # Metrics — Phase 14.2 (Instagram acquisition telemetry, observational
    # only — see this class's own docstring; never read by qualification)
    instagram_source: Optional[str] = None
    instagram_invalid_candidate_seen: bool = False

    # Metrics — Phase 15 (Email / Contact Acquisition telemetry, observational
    # only — see this class's own docstring; never read by qualification)
    email_source: Optional[str] = None
    phone_source: Optional[str] = None
    secondary_page_type: Optional[str] = None
    secondary_page_fetched: bool = False
    secondary_page_fetch_failed: bool = False


# ---------------------------------------------------------------------------
# 5. EnrichedBusiness
# ---------------------------------------------------------------------------
@dataclass(frozen=True, slots=True)
class EnrichedBusiness:
    """
    NOT created manually. Created ONLY by MergeWorker by composing a
    BusinessCandidate with WebsiteIntel, InstagramIntel, and
    ContactIntel. Complete — no worker enriches after this point.

    Composition, not inheritance, and no field duplication: this
    object holds references to the four upstream contracts rather than
    copying their fields onto itself.

    Created by: MergeWorker (Phase 6).
    Consumed by: QualificationWorker only, per the Ownership Table.
    Terminal or intermediate: intermediate — feeds QualificationResult
    (via QualificationWorker) and, later, QualifiedOpportunity.
    """

    # Identifiers
    pipeline_id: str

    # Data (composition of upstream contracts — no duplicated fields)
    business: Optional[BusinessCandidate] = None
    website_intel: Optional[WebsiteIntel] = None
    instagram_intel: Optional[InstagramIntel] = None
    contact_intel: Optional[ContactIntel] = None


# ---------------------------------------------------------------------------
# 6. QualificationResult
# ---------------------------------------------------------------------------
@dataclass(frozen=True, slots=True)
class QualificationResult:
    """
    The heart of MAST: "Can THIS freelancer realistically help THIS
    business?"

    Phase 5.7 architecture correction (reviewed the same way
    WebsiteIntel/InstagramIntel/ContactIntel were in Phase 5.4/5.5/5.6
    — see those classes' docstrings above for the precedent this
    follows). Reviewed field-by-field against QualificationWorker's
    approved responsibilities:

        - confidence -> removed. A confidence score is an estimated
          probability, exactly what this milestone's "do not estimate
          probabilities... do not invent scores" boundary forbids.
          Same category as InstagramIntel.engagement (Phase 5.5) and
          ContactIntel.confidence (Phase 5.6), both removed for the
          identical reason.
        - matched_skills -> removed. "Matching" implies comparing the
          business's needs against a specific freelancer's or agency's
          skill set, but no skills-catalog or freelancer-profile
          contract exists anywhere in Phase 1.1-1.5, and
          QualificationWorker's only input, EnrichedBusiness, carries
          no such data. Inventing a skills catalog here to make this
          field computable would itself be inventing architecture,
          which this milestone explicitly forbids. Belongs to a future
          worker once such a contract is actually defined.
        - reasons / rejected_reason -> consolidated. Both named the
          same concept (why the decision came out the way it did) with
          two different shapes. Kept the plural `reasons` tuple, which
          already covers both the qualified and rejected case; dropped
          the redundant singular field.
        - problems / business_problems -> consolidated for the same
          reason — two names for one concept. Kept the more
          descriptive `business_problems`; dropped `problems`.
        - needed_services -> kept unchanged. Unlike matched_skills,
          this is derivable purely from facts already present on
          EnrichedBusiness (e.g. no website -> "website" is a needed
          service) — no external input required.
        - niche -> kept, re-scoped. Not derived from EnrichedBusiness;
          it is caller/worker configuration (which ruleset to apply),
          the same role `timeout` plays for WebsiteWorker. Supplied to
          QualificationWorker at construction time and echoed onto the
          result, never read off the business.

    Created by: QualificationWorker (Phase 7), given an
    EnrichedBusiness.
    Consumed by: ScoringWorker, then folded into QualifiedOpportunity
    for Storage, per the Ownership Table.
    Terminal or intermediate: intermediate — a rejected result
    (qualified=False) is effectively terminal for that pipeline (the
    business does not proceed to scoring/storage), but the type itself
    always feeds into QualifiedOpportunity's `qualification` field.
    """

    # Identifiers
    pipeline_id: str

    # Configuration
    niche: Optional[str] = None

    # Data
    qualified: Optional[bool] = None
    reasons: tuple[str, ...] = field(default_factory=tuple)
    business_problems: tuple[str, ...] = field(default_factory=tuple)
    needed_services: tuple[str, ...] = field(default_factory=tuple)


# ---------------------------------------------------------------------------
# 7. OpportunityScore
# ---------------------------------------------------------------------------
@dataclass(frozen=True, slots=True)
class OpportunityScore:
    """
    Distinct from QualificationResult. Business Health and Opportunity
    Score are different metrics (a terrible website may LOWER business
    health but INCREASE opportunity).

    Created by: ScoringWorker (Phase 7), given an EnrichedBusiness (and
    typically a QualificationResult).
    Consumed by: Storage, via QualifiedOpportunity, per the Ownership
    Table.
    Terminal or intermediate: intermediate — always folded into
    QualifiedOpportunity's `score` field before Storage.
    """

    # Identifiers
    pipeline_id: str

    # Metrics
    opportunity_score: Optional[float] = None
    business_health_score: Optional[float] = None
    competition_score: Optional[float] = None
    urgency_score: Optional[float] = None
    expected_close_probability: Optional[float] = None

    # Metadata
    tier: Optional[str] = None
    profession_scores: tuple[Any, ...] = ()
    score_breakdown: Optional[dict[str, float]] = None



# ---------------------------------------------------------------------------
# 8. QualifiedOpportunity
# ---------------------------------------------------------------------------
@dataclass(frozen=True, slots=True)
class QualifiedOpportunity:
    """
    Everything comes together. This is what Storage receives.

    Revision (supplied alongside the Milestone 2 prompt, superseding
    the Phase 1.2 text): composition is through named fields rather
    than anonymous embedding, for cleaner serialization, debugging,
    and future API responses. The original Phase 1.2 field list also
    included a raw `BusinessCandidate` alongside `EnrichedBusiness`;
    that field is dropped here per the revision, since
    EnrichedBusiness.business already holds the BusinessCandidate
    (keeping both would duplicate that reference). `session_id` is
    added per the revision; it was not in the original Phase 1.2 list.

    Created by: QualificationWorker + ScoringWorker together (Phase 7).
    Consumed by: StorageWorker only, per the Ownership Table.
    Terminal or intermediate: intermediate — the last in-memory
    contract before Storage produces the terminal StoredOpportunity.
    """

    # Identifiers
    pipeline_id: str
    session_id: str

    # Data (explicit named composition — no anonymous embedding)
    business: Optional[EnrichedBusiness] = None
    qualification: Optional[QualificationResult] = None
    score: Optional[OpportunityScore] = None


# ---------------------------------------------------------------------------
# 9. StoredOpportunity
# ---------------------------------------------------------------------------
@dataclass(frozen=True, slots=True)
class StoredOpportunity:
    """
    Created ONLY after a successful insert. Now it exists inside
    Supabase.

    Phase 5.8 architecture correction (reviewed the same way
    WebsiteIntel / InstagramIntel / ContactIntel / QualificationResult
    were in Phase 5.4/5.5/5.6/5.7 — see those classes' docstrings above
    for the precedent this follows). Reviewed field-by-field against
    StorageWorker's approved responsibility ("persist one qualified
    Opportunity... return a StorageResult. Nothing else.") and against
    StorageWorker's only permitted input, QualifiedOpportunity
    (`pipeline_id`, `session_id`, `business`, `qualification`,
    `score`):

        - user_id -> removed. Not present anywhere on
          QualifiedOpportunity or anything it references
          (EnrichedBusiness / BusinessCandidate carry no user identity
          either), and StorageWorker is explicitly forbidden from
          depending on Sessions, Runtime, or EngineCoordinator to look
          one up from `session_id`. No producer anywhere in the
          current architecture can hand StorageWorker a `user_id`, so
          a required field for it cannot be honestly populated here.
          This belongs to whichever future milestone threads user
          identity through DiscoverySession and into
          QualifiedOpportunity (Session/Engine ownership, per the
          Ownership Table — never Storage's to originate). Reintroduce
          only once that producer exists; a workaround (e.g. reading
          it off a runtime/session object StorageWorker was never
          supposed to see) was rejected for the same reason
          matched_skills was rejected in QualificationResult (Phase
          5.7): the data this field needs simply does not exist on
          this worker's input.
        - business_id -> removed. Also absent from QualifiedOpportunity
          and everything upstream of it, and — unlike `opportunity_id`
          below — there is no textual basis anywhere in Phase 1.1-1.5
          for a second, storage-generated business identity distinct
          from the Pipeline ID. Phase 1.4 (AD-021) is explicit that
          "the Pipeline ID is the identity of the Business throughout
          the engine" and "remains constant throughout the entire
          engine"; `pipeline_id` (kept, below) already is that
          identity. Inventing a second, independent one here — with no
          normalized-table schema or deduplication step defined
          anywhere in this architecture to justify it, and this
          milestone's own instructions barring StorageWorker from
          performing deduplication absent such a contract — would be
          new architecture this milestone is not authorized to invent.
          Dropped rather than worked around.
        - opportunity_id -> kept, unchanged. Unlike business_id, this
          has exactly one legitimate producer: it is the identifier
          StorageWorker itself receives back from a successful insert
          (Phase 1.1 Principle 8: DELIVERED). Nothing upstream could
          have created it earlier, since it names the storage row
          itself, not the business or the pipeline.
        - pipeline_id -> kept, unchanged. Passed through verbatim from
          QualifiedOpportunity.pipeline_id — StorageWorker echoes the
          engine-wide identity already established at discovery
          (AD-021), the same way QualificationResult.niche is echoed
          configuration rather than newly computed.
        - created_at -> kept, unchanged. StorageWorker's own timestamp
          of when the insert happened; no other subsystem could supply
          it earlier.

    Created by: StorageWorker (Phase 8), after a successful Supabase
    insert of a QualifiedOpportunity.
    Consumed by: Frontend (via Supabase Realtime), per the Ownership
    Table.
    Terminal or intermediate: terminal — the final state of a
    successfully delivered opportunity (Phase 1.1 Principle 8:
    DELIVERED).
    """

    # Identifiers
    opportunity_id: str
    pipeline_id: str

    # Metadata
    created_at: Optional[str] = None


# ---------------------------------------------------------------------------
# 10. QueueItem
# ---------------------------------------------------------------------------
@dataclass(frozen=True, slots=True)
class QueueItem:
    """
    The universal wrapper every queue stores, regardless of stage
    (Website, Instagram, Storage, ...). See Phase 1.4 "Queue Item" and
    "Queue States". Generic enough that every queue can use it — the
    queue itself doesn't care whether the payload is a
    BusinessCandidate, an EnrichedBusiness, or a QualifiedOpportunity.

    Created by: the queue manager (Phase 4) when a producing worker
    pushes a new unit of work.
    Consumed by: whichever worker type reserves it next (Phase 3/4);
    the queue manager also reads/writes `state`, `attempt`,
    `worker_id`, `last_updated`, and `timeout_at` to implement
    reservation + ACK, heartbeats, and retries.
    Terminal or intermediate: intermediate — a wrapper, not a business
    object; it disappears once its payload's stage completes (Phase
    1.4: "Queue removes item").

    See module-level docstring, ambiguity #1, for why `state` is
    included even though Phase 1.4's own QueueItem field list didn't
    name it explicitly.
    """

    # Identifiers
    pipeline_id: str
    session_id: str

    # Configuration
    stage: Optional[str] = None

    # Data
    payload: Optional[Any] = None
    state: QueueItemState = QueueItemState.WAITING
    attempt: int = 0

    # Metadata
    created_at: Optional[str] = None
    last_updated: Optional[str] = None
    worker_id: Optional[str] = None
    timeout_at: Optional[str] = None
