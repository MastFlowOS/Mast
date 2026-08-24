"""
MAST Engine V2 — ProviderDeduplicator
========================================

Source: this milestone's own instructions ("build Cross-Provider
Deduplication"), engine/interfaces.py (DiscoveryProviderInterface),
engine/contracts.py (BusinessCandidate), and the existing provider
layer this wraps — providers/composite_provider.py
(CompositeDiscoveryProvider), providers/registry.py (ProviderRegistry),
providers/google_maps_provider.py, providers/yelp_provider.py — all
read for precedent, none modified.

Responsibility
--------------
ProviderDeduplicator has exactly one job: wrap another
DiscoveryProviderInterface (typically a CompositeDiscoveryProvider
holding several concrete providers) and stream the same
BusinessCandidate objects back out, minus later duplicates of a
business already seen earlier in the same stream. It does not
discover anything itself, does not enrich, qualify, score, store,
retry, cache, allocate workers, or own queues — same boundary every
other file in this package already respects. It adds exactly one new
capability to that boundary: recognizing when two BusinessCandidate
objects, possibly produced by two different providers, describe the
same real-world business.

Architecture review (performed before writing any code)
----------------------------------------------------------------------
Reviewed: DiscoveryProviderInterface (engine/interfaces.py),
BusinessCandidate (engine/contracts.py), GoogleMapsProvider,
YelpProvider, CompositeDiscoveryProvider, ProviderRegistry, and the
existing provider validation scripts' style (canned/fake sources
injected via constructor args, no live network in tests).

Finding: no architectural contradiction exists. Cross-provider
deduplication can be built entirely inside providers/, for the same
three reasons CompositeDiscoveryProvider's own review already
established, plus one more specific to dedup:

1. DiscoveryProviderInterface's contract (`provider_id`,
   `display_name`, `discover(request) -> Iterator[BusinessCandidate]`)
   is exactly the shape a wrapper needs on both sides. A
   ProviderDeduplicator can satisfy it on the output side by
   construction, and can consume it on the input side because whatever
   it wraps — a single provider or a CompositeDiscoveryProvider —
   already satisfies the identical contract. Nothing dedup needs is
   missing from the interface, and nothing the interface promises is
   violated by adding a wrapper that only ever drops items, never adds
   or reorders them.

2. `request: Any` is already unconstrained, and CompositeDiscoveryProvider
   has already established the precedent of a provider-layer class
   that takes whatever the wrapped provider(s) need and passes it
   through unexamined. ProviderDeduplicator does the same thing here,
   more simply still: it wraps exactly one DiscoveryProviderInterface
   (which may itself be a CompositeDiscoveryProvider fanning out to
   many), so there is only ever one `request` object to forward, and
   ProviderDeduplicator never needs to know or care what shape it is.

3. Streaming, statelessness of the *provider graph*, and "never mutate
   a BusinessCandidate" are all preservable by a pure filtering layer:
   pull one candidate at a time from the wrapped provider, decide
   in-line whether it's a duplicate of something already yielded, and
   either yield it unchanged or drop it. No buffering of a full result
   set is required — see "Streaming and memory" below for exactly what
   state this layer *does* need to keep, and why that's different from
   materializing the stream.

4. (Dedup-specific) A cross-provider fingerprint can be computed using
   only fields BusinessCandidate already has. It requires no schema
   change, no new contract, no per-provider special-casing baked into
   the wrapper (the same fingerprint function runs over a candidate
   from any provider, unmodified), and no fuzzy/AI matching — see
   "Fingerprinting" below.

Nothing under engine/, workers/, queues/, or models/ needs to change,
be read differently, or be reinterpreted for this to work, and none of
GoogleMapsProvider, YelpProvider, CompositeDiscoveryProvider, or
ProviderRegistry needed to change either — a ProviderDeduplicator
instance is just another DiscoveryProviderInterface value that a
caller can drop in anywhere a bare provider or composite was being
passed to the Engine, including via ProviderRegistry (a factory can
close over an already-built CompositeDiscoveryProvider and return
`ProviderDeduplicator(composite)`; the registry's own validation —
"registered factory must return a DiscoveryProviderInterface" — is
satisfied without registry.py needing to know deduplication exists).
See validate_provider_deduplicator.py for the concrete demonstration,
including a fake "Engine" that only ever holds a
DiscoveryProviderInterface reference and cannot tell a deduplicated
composite from a bare one.

No genuine architectural contradiction was found. This milestone did
not need to stop and report a blocker.

Fingerprinting
----------------------------------------------------------------------
Goal: a *deterministic* fingerprint — same inputs always produce the
same key, no randomness, no ML, no external lookups — built only from
fields that genuinely exist on BusinessCandidate today, favoring
correctness (false negatives: two real duplicates slip through as
"different") over aggressiveness (false positives: two real different
businesses get collapsed into one). Per this milestone's explicit
instruction, when there isn't enough shared, meaningful data to be
confident two candidates are the same business, both are kept.

A candidate can therefore produce *several* independent match keys,
not one single fingerprint string — because different providers expose
different fields (GoogleMapsProvider never populates `coordinates`;
YelpProvider never populates `website`; both may or may not populate
`phone`), a single combined "hash everything" fingerprint would fail
to match two real duplicates the moment even one contributing field
differs in presence or formatting between providers. Instead, each key
below is its own independent, moderately strong piece of evidence.
Two candidates are treated as the same business if *any one* of their
key sets intersects — i.e. OR across signals, not AND — because each
individual key type was chosen specifically for being unlikely to
collide *on its own* between two genuinely different businesses (see
each key's rationale below), so requiring corroboration from a second
key type would only suppress correct matches without meaningfully
reducing false positives.

    1. ("provider_id", provider, provider_business_id) — only when
       `provider_business_id` is populated. Strongest possible
       signal, but provider-scoped: a Yelp Fusion `id` and a Google
       Place ID are different identifier spaces, so this key alone
       never matches *across* providers. It still has real value for
       within-provider duplicates (e.g. the same provider queried
       twice, or a paginated source that repeats a row).

    2. ("phone", normalized_phone) — only when the candidate has a
       phone number that normalizes to at least 7 digits (punctuation,
       spaces, a leading country code, and formatting like "(555)"
       or "+1" are stripped; see `_normalize_phone`). A working phone
       number genuinely shared by two BusinessCandidate records from
       different providers is strong, provider-independent evidence
       of the same business — two unrelated businesses essentially
       never share one.

    3. ("website", normalized_domain) — only when the candidate has a
       `website` that normalizes to a real-looking domain (contains a
       ".", scheme/`www.`/path/query stripped; see
       `_normalize_domain`). Two unrelated businesses essentially
       never share a domain. (YelpProvider never populates `website` —
       see that module's docstring — so this key can only ever
       originate from providers that do; it costs nothing to compute
       and simply never fires for a Yelp-only candidate.)

    4. ("name_address", normalized_name, normalized_address) — only
       when *both* `name` and `address` are present and each
       normalizes to non-empty text (lowercased, punctuation collapsed
       to single spaces, whitespace collapsed; see `_normalize_text`).
       Name alone is deliberately never used as a match key on its own
       — "Restaurant Name" chains and coincidentally-identical business
       names are exactly the false-positive case this milestone warns
       against ("different businesses with similar names are NOT
       collapsed"). Pairing name with a normalized street address
       makes a false positive require both the same name text *and*
       the same address text, which is a materially different bar than
       name alone.

    5. ("name_coordinates", normalized_name, rounded_lat, rounded_lon)
       — only when the candidate has both a `name` that normalizes to
       non-empty text and `coordinates`. Coordinates are rounded to 5
       decimal places (~1.1 meters of precision) before matching, so
       this key requires both the same business name text and
       near-exact physical location — again a same-name-AND-same-place
       bar, not name alone. (GoogleMapsProvider never populates
       `coordinates` — see that module's docstring — so, symmetric to
       key 3, this key simply never fires for a Google-Maps-only
       candidate; it costs nothing to compute for one.)

    6. ("maps_place", normalized_place_id) — only when `maps_url`
       resolves to a stable Google Maps place id (e.g. a `ChIJ...`
       token or a hex feature id embedded in the URL — see
       `storage/dedup.py:norm_maps_place_id`, reused here unmodified,
       the exact same normalizer `storage/early_persistent_dedup.py`
       already keys its own `place:` fingerprint on). This is the
       strongest possible signal for the "same exact Maps place"
       duplicate class: two BusinessCandidate records that resolve to
       the same place id are, by construction, the same real-world
       Maps listing — there is no false-positive risk to weigh, unlike
       keys 4-5. It is also, in practice, the *only* key that reliably
       fires for back-to-back repeats of the same Maps listing seen
       twice in one discovery run (e.g. overlapping grid/tile
       sub-areas, or a paginated source that re-crosses a boundary):
       `provider_business_id` (key 1) is never populated by
       GoogleMapsProvider (see that module's own docstring), and a
       repeat listing frequently carries no phone or website on Maps
       at all, leaving name+address/name+coordinates as the only other
       chance to catch it — this key removes that dependency.

    7. ("maps_link", normalized_link) — fallback for when `maps_url`
       is present but no place id could be extracted from it (see
       `storage/dedup.py:norm_maps_link`, reused unmodified). Two
       candidates whose Maps URLs clean down to the identical link are
       the same listing; deliberately mutually exclusive with key 6
       for a given candidate (a link that does resolve to a place id
       only ever contributes the stronger key 6, never both) so the
       two never redundantly double-count the same evidence.

A candidate with none of these keys (e.g. only a bare `name` and
nothing else corroborating it) produces an empty key set and is never
treated as a duplicate of anything, by construction — "insufficient
data to confidently deduplicate -> keep both" falls directly out of
the algorithm rather than needing a special case.

What is deliberately NOT done, per this milestone's explicit
instructions:
    - No fuzzy string matching (edit distance, token-set similarity,
      phonetic matching, etc.) on names or addresses. Only exact
      matching on *normalized* text — normalization is whitespace/
      punctuation/case cleanup, not approximate matching.
    - No calls to any external service (no geocoding API, no phone
      validation service, no address-standardization API) to enrich or
      verify a key before comparing it.
    - No merging of fields between a kept candidate and a dropped
      duplicate. The kept candidate is returned byte-for-byte as its
      originating provider produced it (see "Duplicate policy" below)
      — nothing from the dropped duplicate is copied onto it, even if
      the dropped duplicate happened to have a field (e.g. a phone
      number) the kept one lacks. That is enrichment, explicitly out
      of scope for this milestone ("Do NOT merge fields. Do NOT
      attempt enrichment.").

Duplicate policy
----------------------------------------------------------------------
First occurrence wins. `discover()` yields a candidate the first time
any of its match keys is seen, and silently drops every later
candidate that shares at least one key with something already yielded
— regardless of which provider produced either one, and regardless of
which provider's version happens to be "more complete." No comparison
of "which duplicate has more fields populated" is performed; that
would be a data-quality judgment (implicitly a kind of scoring/
enrichment logic) this milestone does not ask for and explicitly
forbids ("Correctness is more important than aggressiveness" governs
*whether* to match, not which of two matches to prefer). Streaming
order is whatever order the wrapped provider already produces (for a
CompositeDiscoveryProvider: sequential, provider-by-provider, in
construction order — see that module's Design Decision 2), so "first
occurrence" is well-defined and deterministic for a given wrapped
provider and request.

Streaming and memory
----------------------------------------------------------------------
`discover()` is a generator that pulls exactly one candidate at a time
from the wrapped provider's own `discover()` iterator, decides
in-line, and yields immediately or drops immediately — never buffering
the wrapped stream, never look-ahead, never sorting. The one piece of
state it keeps across the life of one `discover()` call is a running
set of every match key seen so far ("the state necessary to recognize
previously-seen businesses" — this milestone's own phrase). That set
grows by at most a handful of small tuples per *yielded* candidate,
which is asymptotically smaller than materializing the candidates
themselves, and is exactly the same shape of bounded-but-necessary
state CompositeDiscoveryProvider's own best-effort mode already keeps
(a set of seen provider_ids) — an unavoidable minimum for the
operation being performed, not a materialization of the stream. Fresh
per `discover()` call: nothing here persists across calls or across
ProviderDeduplicator instances, matching every other provider's
"stateless between calls" pattern.

Never mutates a BusinessCandidate
----------------------------------------------------------------------
No field of any yielded candidate is read for any purpose other than
computing its match keys, and no field is ever written, copied,
derived, or defaulted onto a candidate. Every object this generator
yields is the exact object the wrapped provider produced — same
identity, same fields, same frozen dataclass instance — never a copy,
a reconstruction, or a modified version.

Status
------
Cross-Provider Deduplication milestone. Adds one new wrapper class on
top of the existing, unmodified provider layer (DiscoveryProviderInterface,
GoogleMapsProvider, YelpProvider, CompositeDiscoveryProvider,
ProviderRegistry). The Engine remains completely unaware deduplication
exists — it still only ever holds a bare DiscoveryProviderInterface
reference. Nothing under engine/, workers/, queues/, or models/ is
touched, and none of the four existing provider-layer files are
modified.
"""

from __future__ import annotations

import re
from typing import Any, FrozenSet, Iterator, Optional, Tuple
from urllib.parse import urlparse

from engine.contracts import BusinessCandidate
from engine.interfaces import DiscoveryProviderInterface

# PHASE 40 — reuses the SAME Maps place/link normalizers
# storage/dedup.py and storage/early_persistent_dedup.py already use
# for the identical purpose (see module docstring, "Fingerprinting",
# key 6 below). Not reimplemented here — importing the canonical
# normalizer is exactly what this module already does one line down
# for its own text/phone/domain helpers' spirit (deterministic,
# single source of truth), and avoids a second, possibly-diverging
# definition of "what is a Maps place id" ever existing.
from storage.dedup import norm_maps_link, norm_maps_place_id

_MIN_PHONE_DIGITS = 7
_COORDINATE_PRECISION = 5  # decimal places (~1.1m)


# ---------------------------------------------------------------------------
# Normalization helpers — deterministic text/format cleanup only. None of
# these attempt fuzzy matching; they only make two representations of the
# *same* underlying value compare equal (e.g. "(555) 123-4567" vs.
# "555-123-4567"), never make two different values compare equal.
# ---------------------------------------------------------------------------
def _normalize_text(value: Optional[str]) -> str:
    """
    Lowercase, collapse punctuation to single spaces, collapse
    whitespace, strip. Used for `name` and `address` before pairing
    them into a match key. Deliberately not stemming, not removing
    business-suffix words ("llc", "inc", "the"), not reordering tokens
    — any of those would drift from normalization into approximate
    matching, which this milestone explicitly excludes.
    """
    if not value:
        return ""
    text = value.strip().lower()
    text = re.sub(r"[^a-z0-9]+", " ", text)
    return re.sub(r"\s+", " ", text).strip()


def _normalize_phone(value: Optional[str]) -> str:
    """
    Digits only. A leading "1" on an 11-digit result is dropped (US/
    Canada country-code normalization: "+1 555-123-4567" and
    "555-123-4567" must compare equal), otherwise digits are left
    exactly as extracted — no other country-code assumptions are made,
    since BusinessCandidate carries no explicit country-calling-code
    field to disambiguate further.
    """
    if not value:
        return ""
    digits = re.sub(r"\D", "", value)
    if len(digits) == 11 and digits.startswith("1"):
        digits = digits[1:]
    return digits


def _normalize_domain(value: Optional[str]) -> str:
    """
    Bare registrable-ish domain: scheme, "www.", path, query, and port
    stripped, lowercased. "https://www.example.com/menu?x=1" and
    "example.com" both normalize to "example.com". Does not attempt
    real public-suffix-list-aware domain parsing (e.g. distinguishing
    "co.uk" registrable domains) — BusinessCandidate.website is a
    plain string, not a structured URL, and this milestone does not
    call any external service to resolve one.
    """
    if not value:
        return ""
    candidate = value.strip().lower()
    if "//" not in candidate:
        candidate = "//" + candidate
    parsed = urlparse(candidate)
    netloc = parsed.netloc or parsed.path
    netloc = netloc.split("/")[0].split(":")[0]
    if netloc.startswith("www."):
        netloc = netloc[4:]
    return netloc


def _fingerprint_keys(candidate: BusinessCandidate) -> FrozenSet[Tuple[Any, ...]]:
    """
    Every independent match key this candidate contributes — see
    module docstring, "Fingerprinting", for the full rationale behind
    each key. Reads fields only; never writes or derives a value back
    onto `candidate`.
    """
    keys: set[Tuple[Any, ...]] = set()

    if candidate.provider_business_id:
        keys.add(("provider_id", candidate.provider, candidate.provider_business_id))

    maps_place_id = norm_maps_place_id(candidate.maps_url)
    if maps_place_id:
        keys.add(("maps_place", maps_place_id.lower()))
    else:
        # Only when no stable place id could be extracted — mirrors
        # storage/early_persistent_dedup.py's own "map: key only when
        # no place: id was found" rule (see that module's
        # `early_fingerprint_keys`), so a candidate never contributes
        # both a place-id key AND a weaker whole-link key for the same
        # `maps_url`.
        maps_link = norm_maps_link(candidate.maps_url)
        if maps_link and not maps_link.startswith("place:"):
            keys.add(("maps_link", maps_link))

    phone = _normalize_phone(candidate.phone)
    if len(phone) >= _MIN_PHONE_DIGITS:
        keys.add(("phone", phone))

    domain = _normalize_domain(candidate.website)
    if domain and "." in domain:
        keys.add(("website", domain))

    name = _normalize_text(candidate.name)
    address = _normalize_text(candidate.address)
    if name and address:
        keys.add(("name_address", name, address))

    if name and candidate.coordinates is not None:
        lat, lon = candidate.coordinates
        if lat is not None and lon is not None:
            keys.add(
                (
                    "name_coordinates",
                    name,
                    round(lat, _COORDINATE_PRECISION),
                    round(lon, _COORDINATE_PRECISION),
                )
            )

    return frozenset(keys)


class ProviderDeduplicator(DiscoveryProviderInterface):
    """
    Wraps a single DiscoveryProviderInterface (typically a
    CompositeDiscoveryProvider fanning out to several concrete
    providers) and streams its BusinessCandidate output with later
    duplicates of an already-seen business dropped. See module
    docstring for the full architecture review, fingerprinting design,
    duplicate policy, and streaming/memory behavior.

    Stateless between calls, like every other provider in this layer:
    the wrapped provider is held (the caller's already-constructed
    instance, not rebuilt here), but this class owns no mutable state
    that outlives one `discover()` call — the "seen keys" set is local
    to each `discover()` generator invocation.
    """

    def __init__(
        self,
        wrapped: DiscoveryProviderInterface,
        *,
        provider_id: str = "deduplicated",
        display_name: str = "Deduplicated",
    ) -> None:
        """
        `wrapped` — the DiscoveryProviderInterface this deduplicator
        filters. Typically a CompositeDiscoveryProvider, but nothing
        here requires that — wrapping a single bare provider (to
        collapse that provider's own repeated rows) is equally valid
        and requires no special-casing.

        `provider_id` / `display_name` — this wrapper's own identity,
        distinct from the wrapped provider's (or, for a composite, from
        any of the providers inside it). Defaulted so a caller who
        doesn't care can just wrap and go; overridable for a caller
        that wants a more specific identity (e.g. when registering this
        wrapper itself in a ProviderRegistry under its own key).
        """
        self._wrapped = wrapped
        self._provider_id = provider_id
        self._display_name = display_name

    @property
    def provider_id(self) -> str:
        return self._provider_id

    @property
    def display_name(self) -> str:
        return self._display_name

    @property
    def wrapped(self) -> DiscoveryProviderInterface:
        """
        Read-only access to the wrapped provider, for introspection/
        testing — mirrors CompositeDiscoveryProvider.providers. Never
        mutated after construction.
        """
        return self._wrapped

    def discover(self, request: Any) -> Iterator[BusinessCandidate]:
        """
        Streams BusinessCandidate objects from the wrapped provider,
        dropping later duplicates of a business already yielded. See
        module docstring for "Duplicate policy" (first occurrence
        wins) and "Streaming and memory" (one pass, one running set of
        match keys, no buffering of the wrapped stream).

        `request` is forwarded to `self._wrapped.discover(request)`
        unexamined — this wrapper has no request shape of its own (see
        Architecture review, point 2).

        Error handling: matches every existing provider's rule. An
        exception raised while driving the wrapped provider propagates
        unchanged, uncaught — this wrapper adds a filtering step, not a
        failure-handling policy, so it introduces no new behavior here
        beyond what the wrapped provider (bare or composite) already
        does on its own.
        """
        seen_keys: set[Tuple[Any, ...]] = set()
        for candidate in self._wrapped.discover(request):
            keys = _fingerprint_keys(candidate)
            if keys and not keys.isdisjoint(seen_keys):
                continue  # Duplicate of an earlier candidate — dropped, not merged.
            seen_keys.update(keys)
            yield candidate
