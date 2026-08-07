"""
niches/signals.py
=================

Descriptive business signals that freelancer niches may require or
benefit from.

Design rules
------------
- ``NicheSignal`` is a frozen, slotted domain model.  It carries no
  runtime behaviour — it describes *what* a signal is, not *how* to
  acquire it.  Acquisition belongs to Provider Intelligence.
- ``SignalRegistry`` is a thread-safe registry that mirrors the
  architectural quality of ``NicheRegistry`` and ``ProviderRegistry``.
  It rejects duplicate signal IDs and raises ``KeyError`` for unknown
  lookups.
- Built-in signals are registered through ``register_default_signals``
  rather than a module-level global instance.  This keeps the module
  free of hidden mutable state, which is important for clean test
  isolation and enterprise deployment scenarios.
- No imports from engine/, providers/, intelligence/, storage/,
  scoring/, enrichment/, or contacts/.
- ``NicheSignal`` and ``SignalRegistry`` do not import ``Taxonomy``
  or ``Category`` — signals are fully independent of the category
  hierarchy.
"""

from __future__ import annotations

import re
import threading
from dataclasses import dataclass
from typing import Optional


# ---------------------------------------------------------------------------
# Identifier validation (mirrors niches/models.py exactly)
# ---------------------------------------------------------------------------

_ID_PATTERN: re.Pattern[str] = re.compile(
    r"^[a-z0-9]+(?:_[a-z0-9]+)*$"
)


def _validate_id(value: str, label: str) -> None:
    """
    Raise ``ValueError`` if *value* is not a valid normalized identifier.

    Rules: non-empty, lowercase alphanumeric + underscores only, matches
    ``^[a-z0-9]+(?:_[a-z0-9]+)*$`` — no leading/trailing/consecutive
    underscores, no uppercase, no special characters other than ``_``.
    """
    if not isinstance(value, str) or not value:
        raise ValueError(f"{label} must be a non-empty string; got {value!r}")
    if not _ID_PATTERN.match(value):
        raise ValueError(
            f"{label} {value!r} is not a valid normalized identifier. "
            "Only lowercase alphanumeric characters and single underscores "
            "are allowed (e.g. 'seo', 'tech_stack', 'booking_system'). "
            "Leading/trailing/consecutive underscores and uppercase are "
            "rejected."
        )


# ---------------------------------------------------------------------------
# NicheSignal
# ---------------------------------------------------------------------------

@dataclass(frozen=True, slots=True)
class NicheSignal:
    """
    Immutable, descriptive representation of a business signal that is
    valuable for a freelancer niche.

    These are descriptive signals only.  They perform no runtime
    behaviour and have no knowledge of providers, scoring, or
    enrichment.

    Fields
    ------
    signal_id
        Normalized identifier.  Must satisfy
        ``^[a-z0-9]+(?:_[a-z0-9]+)*$``.
    name
        Human-readable display name (e.g. "Tech Stack").
    description
        Concise description of why this signal is valuable.
    """

    signal_id: str
    name: str
    description: str

    def __post_init__(self) -> None:
        _validate_id(self.signal_id, "signal_id")


# ---------------------------------------------------------------------------
# SignalRegistry
# ---------------------------------------------------------------------------

class SignalRegistry:
    """
    Thread-safe registry for ``NicheSignal`` instances.

    Mirrors the architectural quality of ``NicheRegistry`` and
    ``ProviderRegistry``:

    - ``register()`` rejects duplicate ``signal_id`` values.
    - ``get()`` raises ``KeyError`` for unknown IDs.
    - ``exists()`` / ``ids()`` / ``all()`` provide full introspection.
    - All public methods are guarded by a reentrant lock.

    Construction is independent of signal objects: the registry stores
    what it is given at registration time and never constructs signals
    itself.
    """

    def __init__(self) -> None:
        self._signals: dict[str, NicheSignal] = {}
        self._lock: threading.RLock = threading.RLock()

    # ------------------------------------------------------------------
    # Registration
    # ------------------------------------------------------------------

    def register(self, signal: NicheSignal) -> None:
        """
        Register *signal* under its ``signal_id``.

        Raises
        ------
        TypeError
            *signal* is not a ``NicheSignal`` instance.
        ValueError
            ``signal.signal_id`` is already registered.
        """
        if not isinstance(signal, NicheSignal):
            raise TypeError(
                f"signal must be a NicheSignal instance; got {type(signal)!r}"
            )
        with self._lock:
            if signal.signal_id in self._signals:
                raise ValueError(
                    f"signal_id {signal.signal_id!r} is already registered — "
                    "duplicate signal_ids are not allowed."
                )
            self._signals[signal.signal_id] = signal

    # ------------------------------------------------------------------
    # Lookup
    # ------------------------------------------------------------------

    def get(self, signal_id: str) -> NicheSignal:
        """
        Return the ``NicheSignal`` registered under *signal_id*.

        Raises
        ------
        KeyError
            *signal_id* is not registered.
        """
        with self._lock:
            if signal_id not in self._signals:
                raise KeyError(
                    f"signal_id {signal_id!r} is not registered in this "
                    "SignalRegistry."
                )
            return self._signals[signal_id]

    def exists(self, signal_id: str) -> bool:
        """Return ``True`` if *signal_id* is registered."""
        with self._lock:
            return signal_id in self._signals

    # ------------------------------------------------------------------
    # Introspection
    # ------------------------------------------------------------------

    def ids(self) -> tuple[str, ...]:
        """Return all registered signal IDs in insertion order."""
        with self._lock:
            return tuple(self._signals)

    def all(self) -> tuple[NicheSignal, ...]:
        """Return all registered ``NicheSignal`` instances in insertion order."""
        with self._lock:
            return tuple(self._signals.values())


# ---------------------------------------------------------------------------
# Built-in signals + factory
# ---------------------------------------------------------------------------

#: Pre-built ``NicheSignal`` objects for the ten standard business signals.
#: These are the canonical instances; ``register_default_signals`` registers
#: them into a caller-supplied ``SignalRegistry``.

WEBSITE = NicheSignal(
    signal_id="website",
    name="Website",
    description=(
        "The business has a public website. Indicates digital presence "
        "and readiness for web-focused services."
    ),
)

REVIEWS = NicheSignal(
    signal_id="reviews",
    name="Reviews",
    description=(
        "The business has customer reviews on public platforms (e.g. Google, "
        "Yelp, Trustpilot). Useful for reputation and credibility assessment."
    ),
)

TECH_STACK = NicheSignal(
    signal_id="tech_stack",
    name="Tech Stack",
    description=(
        "The technologies used to build or operate the business's digital "
        "presence (e.g. CMS, e-commerce platform, analytics tools)."
    ),
)

INSTAGRAM = NicheSignal(
    signal_id="instagram",
    name="Instagram",
    description=(
        "The business is active on Instagram. Relevant for visual niches "
        "such as photography, graphic design, and social media management."
    ),
)

PORTFOLIO = NicheSignal(
    signal_id="portfolio",
    name="Portfolio",
    description=(
        "The business or professional displays a portfolio of past work. "
        "Relevant for creative and design-heavy niches."
    ),
)

SEO = NicheSignal(
    signal_id="seo",
    name="SEO",
    description=(
        "The business has or lacks search engine optimisation signals "
        "(meta tags, rankings, backlinks). Indicates opportunity for "
        "SEO-focused freelancers."
    ),
)

BOOKING_SYSTEM = NicheSignal(
    signal_id="booking_system",
    name="Booking System",
    description=(
        "The business uses an online booking or scheduling system. "
        "Relevant for service-based niches and automation opportunities."
    ),
)

PHONE_NUMBER = NicheSignal(
    signal_id="phone_number",
    name="Phone Number",
    description=(
        "A publicly listed phone number for the business. A key contact "
        "field for outreach and lead qualification."
    ),
)

EMAIL = NicheSignal(
    signal_id="email",
    name="Email",
    description=(
        "A publicly discoverable email address for the business. Core "
        "contact signal for outreach campaigns."
    ),
)

SOCIAL_PRESENCE = NicheSignal(
    signal_id="social_presence",
    name="Social Presence",
    description=(
        "The business maintains one or more active social media profiles. "
        "A broad signal covering platforms beyond Instagram."
    ),
)


def register_default_signals(registry: SignalRegistry) -> None:
    """
    Register all ten built-in ``NicheSignal`` instances into *registry*.

    Callers construct the ``SignalRegistry`` themselves and pass it in.
    This keeps ``signals.py`` free of module-level global mutable state,
    which simplifies test isolation and avoids hidden side-effects in
    enterprise deployments.

    Parameters
    ----------
    registry:
        A ``SignalRegistry`` instance to populate.  Must be freshly
        constructed (or at least free of conflicting registrations)
        before calling this function.

    Raises
    ------
    ValueError
        Any of the built-in signal IDs is already registered in
        *registry* (i.e. the registry was not fresh).
    """
    for signal in (
        WEBSITE,
        REVIEWS,
        TECH_STACK,
        INSTAGRAM,
        PORTFOLIO,
        SEO,
        BOOKING_SYSTEM,
        PHONE_NUMBER,
        EMAIL,
        SOCIAL_PRESENCE,
    ):
        registry.register(signal)
