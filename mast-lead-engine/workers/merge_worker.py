"""
MAST Engine V2 — Merge Worker
===============================

Source: Engine BluePrint Phase 1.3 (Worker Types — Merge Worker), Phase
1.2 (Golden Rule — one input, one output; "Composition, not
inheritance"), and `engine.contracts.EnrichedBusiness`'s own Ownership
Table ("Created by: MergeWorker"). Builds on workers/base_worker.py
without duplicating any lifecycle logic, exactly as workers/
website_worker.py, instagram_worker.py, contact_worker.py, and
qualification_worker.py do.

Architecture-review context (Runtime Integration review)
--------------------------------------------------------------------
A prior architecture review (Runtime Integration, pre-Phase-6-work)
found that no file anywhere in this codebase implements MergeWorker,
even though `engine.contracts.py`'s Ownership Table names it as the
*only* legal creator of `EnrichedBusiness`, and `EnrichedBusiness` is
`QualificationWorker`'s *only* input. Without this file,
`QualificationWorker` — already fully implemented — was structurally
unreachable with real data. This file closes that gap; nothing else
changes as a result (see "Status" below for exactly what is still not
wired to this worker).

Responsibility
--------------
MergeWorker performs exactly one transformation:

    MergeInput -> MergeWorker.process() -> EnrichedBusiness

It composes one already-produced BusinessCandidate with the (possibly
partial) WebsiteIntel / InstagramIntel / ContactIntel already produced
for it by WebsiteWorker / InstagramWorker / ContactWorker, and returns
one EnrichedBusiness. It does not discover, inspect websites, crawl
Instagram, extract contacts, qualify, score, store, retry, or talk to
any queue/session/runtime component. Per EnrichedBusiness's own
docstring in engine/contracts.py: "Composition, not inheritance, and
no field duplication" — this worker holds references to the four
upstream contracts rather than copying their fields onto itself, and
it is the last worker allowed to touch any of Website/Instagram/
Contact's own facts; nothing downstream of MergeWorker ever
re-inspects them.

Why a local composite input type, not four parameters bolted onto
WorkerInterface
--------------------------------------------------------------------
Every other worker in this codebase satisfies Phase 1.2's Golden Rule
("one input object in, one different object out") with a single,
already-existing engine.contracts type as InputT. MergeWorker cannot:
its job is specifically to combine four upstream objects that no
single existing contract bundles together (EnrichedBusiness itself is
the *output*, not something that exists yet to be an input).

This is not a new problem for this codebase — workers/discovery_worker.py
already faced the identical shape mismatch (a worker whose real input
isn't a single existing contract) and resolved it the same way: define
a small, local, frozen dataclass (there: `DiscoveryExecution`; here:
`MergeInput`) scoped to this module only, not added to
engine/contracts.py. `WorkerInterface.process(item: InputT) -> OutputT`
does not change and did not need to — the generic contract already
allows any InputT/OutputT pair per worker type (interfaces.py's own
WorkerInterface docstring: "concrete worker types differ... this
module does not pick a single input/output pair for all workers").
`MergeInput` is that pair's InputT for this worker only.

`MergeInput.business` is required (not Optional): a pipeline_id must
come from *somewhere*, and business.pipeline_id is the only field
anywhere in this bundle guaranteed to carry one (BusinessCandidate.
pipeline_id is a required field; EnrichedBusiness.business itself is
Optional only because a *hypothetical* future caller might one day
construct an EnrichedBusiness without ever having a business — this
worker is not that caller, and requires one). `website_intel` /
`instagram_intel` / `contact_intel` are each Optional, mirroring
EnrichedBusiness's own field optionality exactly: in every case this
worker currently knows of, WebsiteWorker / InstagramWorker /
ContactWorker each always return a real object (never None — see
their own "no URL -> no fetch, not a failure" precedent), so in
practice all three normally arrive populated. But nothing in Phase
1.1-1.5, and nothing yet built in queues/ or a future execution loop,
guarantees a caller always has all three by the time it calls this
worker (e.g. a future routing decision might legitimately skip a
stage). Rather than assume that guarantee exists, MergeWorker accepts
partial input and passes each field through exactly as given — see
"No fabrication" below.

No fabrication
------------------
MergeWorker never invents, defaults, or infers a fact that wasn't
already produced upstream. A missing website_intel/instagram_intel/
contact_intel is passed through as None on the resulting
EnrichedBusiness, exactly as given — never replaced with an empty
placeholder object, a guessed value, or a business judgment about
*why* it's missing. Deciding what a missing upstream intel *means*
(e.g. "no contact methods") is QualificationWorker's job, already
built to treat a None field as "no facts available from that worker,"
never a qualification failure by itself (see
workers/qualification_worker.py). MergeWorker itself makes no such
judgment — it only composes what it was given.

Error handling
----------------
No exception is caught or swallowed anywhere in this module. A
MergeInput with `business=None` cannot be constructed at all —
`MergeInput.__post_init__` raises immediately, the same discipline
every other local/shared frozen dataclass in this codebase already
uses (see e.g. AllocationResult, WorkerDefinition,
DiscoveryExecution's sibling GoogleMapsDiscoveryRequest). There is no
other failure mode: process() reads only attributes already validated
to exist, performs no I/O, and constructs no object whose fields
could be individually invalid (EnrichedBusiness itself declares no
__post_init__ validation of its own in engine/contracts.py).

Thread safety / statelessness
-------------------------------
No module-level mutable state, no caches, no instance configuration
of any kind beyond what BaseWorker itself carries (worker_id,
capabilities). Every process() call is a pure function of its own
argument — mirroring WebsiteWorker's / InstagramWorker's / ContactWorker's
/ QualificationWorker's "no instance state read or written" pattern,
here trivially true since MergeWorker takes no constructor
configuration at all.

Status
------
Runtime Integration review, item 1 of the agreed implementation
sequence (MergeWorker -> RuntimeContext -> Engine Runtime ->
EngineCoordinator integration -> Storage backend -> service.py
cutover). This file makes MergeWorker's process() a genuine, reachable
transformation for the first time. It does NOT:

    - wire this worker into any queue (no queues/ import anywhere in
      this file, matching WebsiteWorker/InstagramWorker/ContactWorker/
      QualificationWorker/StorageWorker exactly)
    - construct, register, or allocate a MergeWorker instance anywhere
      (that remains a future RuntimeContext / Engine Runtime
      responsibility, items 2 and 3 of the agreed sequence — not
      implemented by this change)
    - change engine/contracts.py, engine/interfaces.py, or any other
      existing worker file

Depends only on BusinessCandidate, WebsiteIntel, InstagramIntel,
ContactIntel, EnrichedBusiness, BaseWorker, WorkerCapability, and the
standard library. No queue/, providers/, engine.coordinator, or
runtime import anywhere in this file — matching every other worker in
this package exactly.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Optional

from engine.contracts import (
    BusinessCandidate,
    ContactIntel,
    EnrichedBusiness,
    InstagramIntel,
    WebsiteIntel,
)
from workers.base_worker import BaseWorker
from workers.worker_capability import WorkerCapability

#: Phase 1.3 "Timeout Rules" names Merge explicitly (Website=8s,
#: Instagram=6s, Contact=6s, Merge=2s, Qualification=2s, Storage=3s —
#: see engine/interfaces.py and workers/storage_worker.py's own
#: docstring for where this table is already quoted). Borrowed
#: directly, the same discipline StorageWorker used for its own
#: Storage=3s figure, since the table already names this worker type
#: — not invented here.
DEFAULT_TIMEOUT_SECONDS = 2.0

WORKER_TYPE = "merge"


@dataclass(frozen=True)
class MergeInput:
    """
    This worker's own accepted input shape — local to this module, not
    a shared `engine.contracts` type, for the same reason
    `workers.discovery_worker.DiscoveryExecution` is local rather than
    added to engine/contracts.py: no existing contract bundles a
    BusinessCandidate together with its (possibly partial) upstream
    intel, and inventing a shared one is out of scope for this
    milestone. See the module docstring's "Why a local composite input
    type" section for the full reasoning.

    Attributes
    ----------
    business:
        The BusinessCandidate this bundle is being merged for.
        Required — see the module docstring for why `business=None`
        cannot be accepted (there would be no pipeline_id to compose
        the result under).
    website_intel:
        WebsiteWorker's output for this business, if available.
        Optional — passed through to EnrichedBusiness exactly as
        given, never defaulted or inferred.
    instagram_intel:
        InstagramWorker's output for this business, if available.
        Optional, same handling as website_intel.
    contact_intel:
        ContactWorker's output for this business, if available.
        Optional, same handling as website_intel.
    """

    business: BusinessCandidate
    website_intel: Optional[WebsiteIntel] = None
    instagram_intel: Optional[InstagramIntel] = None
    contact_intel: Optional[ContactIntel] = None

    def __post_init__(self) -> None:
        if self.business is None:
            raise ValueError(
                "MergeInput.business must not be None — MergeWorker "
                "has no other source for EnrichedBusiness.pipeline_id "
                "(see module docstring, 'Why a local composite input "
                "type')."
            )


class MergeWorker(BaseWorker[MergeInput, EnrichedBusiness]):
    """
    Transforms one MergeInput into one EnrichedBusiness by composing
    the given BusinessCandidate with whichever of WebsiteIntel /
    InstagramIntel / ContactIntel were supplied. Owns nothing else —
    see module docstring.
    """

    def __init__(self, *, worker_id: Optional[str] = None) -> None:
        super().__init__(
            worker_type=WORKER_TYPE,
            capabilities=(WorkerCapability(name=WORKER_TYPE),),
            worker_id=worker_id,
        )

    # -- WorkerInterface -------------------------------------------------

    def process(self, item: MergeInput) -> EnrichedBusiness:
        """
        Consume exactly one MergeInput and produce exactly one
        EnrichedBusiness. Never mutates `item`. Pure composition — no
        field is read, transformed, defaulted, or judged; see module
        docstring, "No fabrication".
        """
        return EnrichedBusiness(
            pipeline_id=item.business.pipeline_id,
            business=item.business,
            website_intel=item.website_intel,
            instagram_intel=item.instagram_intel,
            contact_intel=item.contact_intel,
        )

    def timeout_seconds(self) -> float:
        return DEFAULT_TIMEOUT_SECONDS
