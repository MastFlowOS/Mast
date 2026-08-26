"""
PHASE 42D-2 — Instagram discovery-vs-short-circuit semantics
(verification, not a bug fix).

This behavior was audited during Phase 42D-2 and found CORRECT as-is;
these tests exist only to pin it down with a dedicated regression
suite, since none previously proved it stays correct.

What's under test
------------------
1. `workers.instagram_worker.InstagramWorker.process()` returns the
   short-circuit shape (`InstagramIntel(profile_reachable=False,
   fetch_duration=None)`) ONLY when `item.instagram_url` was never
   populated -- i.e. no network attempt was made at all -- never after
   a real fetch attempt (DNS failure/timeout/ConnectionError set a real
   `fetch_duration`; HTTP errors set `profile_reachable=True`).
2. `engine.execution_driver._instagram_telemetry_events()` emits
   "instagram_short_circuited" only for that exact no-attempt shape,
   never for a real failed attempt (`profile_reachable=False` with a
   real `fetch_duration`) or a reachable profile.
3. `workers.qualification_worker.QualificationWorker`'s "instagram"
   required-channel rule correctly treats a short-circuited/no-attempt
   `InstagramIntel` as "not yet disqualifying" and falls back to
   `business.instagram_url` / `contact_intel.instagram_url` (Instagram
   discovered later via ContactWorker's website scan still counts).

Run: pytest tests/test_phase42d_instagram_discovery_semantics.py -v
"""

from __future__ import annotations

import os
import socket
import sys
import urllib.error
from unittest.mock import MagicMock, patch

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

from engine.contracts import (
    BusinessCandidate,
    ContactIntel,
    EnrichedBusiness,
    InstagramIntel,
    WebsiteIntel,
)
from engine.execution_driver import _instagram_telemetry_events
from workers.instagram_worker import InstagramWorker
from workers.qualification_worker import QualificationWorker


def _candidate(pipeline_id: str, *, instagram_url=None) -> BusinessCandidate:
    return BusinessCandidate(
        pipeline_id=pipeline_id,
        session_id="s1",
        provider="fake",
        name="Test Biz",
        instagram_url=instagram_url,
    )


# ── Test 1: no instagram_url on the candidate -> short-circuit shape, no network call ──
def test_no_instagram_url_short_circuits_without_network_call():
    """No instagram_url at all -> InstagramIntel(profile_reachable=False,
    fetch_duration=None), and the HTTP layer is never touched."""
    worker = InstagramWorker()
    item = _candidate("p-no-ig-url", instagram_url=None)

    with patch("urllib.request.urlopen") as mock_urlopen:
        intel = worker.process(item)
        mock_urlopen.assert_not_called()

    assert intel.pipeline_id == "p-no-ig-url"
    assert intel.profile_reachable is False
    assert intel.fetch_duration is None
    assert intel.profile_url is None


# ── Test 2: real network failure -> profile_reachable=False WITH a real fetch_duration ──
def test_real_network_failure_sets_fetch_duration_not_short_circuit_shape():
    """instagram_url IS populated but the fetch fails (URLError/timeout/
    ConnectionError) -> profile_reachable=False, but fetch_duration is a
    real (non-None) timing value -- this must NOT match the
    short-circuit shape."""
    worker = InstagramWorker()
    item = _candidate("p-net-fail", instagram_url="https://instagram.com/somebiz")

    with patch("urllib.request.urlopen", side_effect=urllib.error.URLError("no route to host")):
        intel = worker.process(item)

    assert intel.profile_reachable is False
    assert intel.fetch_duration is not None
    assert intel.fetch_duration >= 0.0


def test_real_timeout_sets_fetch_duration_not_short_circuit_shape():
    worker = InstagramWorker()
    item = _candidate("p-timeout", instagram_url="https://instagram.com/somebiz")

    with patch("urllib.request.urlopen", side_effect=socket.timeout("timed out")):
        intel = worker.process(item)

    assert intel.profile_reachable is False
    assert intel.fetch_duration is not None


# ── Test 3: HTTP error -> profile_reachable=True (server responded) ──────
def test_http_error_response_sets_profile_reachable_true():
    """An HTTPError means the server DID respond (e.g. private/removed
    profile) -- this is reachable, not a short-circuit or a network
    failure."""
    worker = InstagramWorker()
    item = _candidate("p-http-error", instagram_url="https://instagram.com/somebiz")

    with patch(
        "urllib.request.urlopen",
        side_effect=urllib.error.HTTPError("https://instagram.com/somebiz", 404, "Not Found", {}, None),
    ):
        intel = worker.process(item)

    assert intel.profile_reachable is True
    assert intel.fetch_duration is not None
    assert intel.profile_url == "https://instagram.com/somebiz"


# ── Test 4: _instagram_telemetry_events() shape discrimination ───────────
def test_telemetry_emits_short_circuited_only_for_no_attempt_shape():
    """instagram_short_circuited fires only for profile_reachable=False
    AND fetch_duration=None; never for a real failed attempt (real
    fetch_duration) nor a reachable profile."""
    short_circuit_intel = InstagramIntel(
        pipeline_id="p1", profile_reachable=False, fetch_duration=None,
    )
    events = _instagram_telemetry_events(short_circuit_intel, url_input_present=False)
    assert "instagram_short_circuited" in events

    real_failure_intel = InstagramIntel(
        pipeline_id="p2", profile_reachable=False, fetch_duration=1.2,
    )
    events = _instagram_telemetry_events(real_failure_intel, url_input_present=True)
    assert "instagram_short_circuited" not in events

    reachable_intel = InstagramIntel(
        pipeline_id="p3", profile_reachable=True, fetch_duration=0.8,
    )
    events = _instagram_telemetry_events(reachable_intel, url_input_present=True)
    assert "instagram_short_circuited" not in events
    assert "instagram_profile_reachable" in events


# ── Test 5: QualificationWorker's "instagram" required-channel rule ──────
def test_qualification_short_circuited_ig_falls_back_to_contact_discovery():
    """Short-circuited/no-attempt instagram_intel (profile_reachable=False,
    no attempt made) but contact_intel.instagram_url set (discovered via
    website scan) -> qualifies on the instagram channel."""
    worker = QualificationWorker(required_channels=("instagram",))

    enriched = EnrichedBusiness(
        pipeline_id="q-ig-discovered",
        business=BusinessCandidate(
            pipeline_id="q-ig-discovered",
            session_id="s1",
            provider="fake",
            name="Test Biz",
            website="https://testbiz.com",
        ),
        website_intel=WebsiteIntel(pipeline_id="q-ig-discovered", website_reachable=True, final_url="https://testbiz.com"),
        instagram_intel=InstagramIntel(pipeline_id="q-ig-discovered", profile_reachable=False, fetch_duration=None),
        contact_intel=ContactIntel(pipeline_id="q-ig-discovered", instagram_url="https://www.instagram.com/testbiz/"),
    )

    result = worker.process(enriched)
    assert result.qualified is True
    assert not any("instagram" in r for r in result.reasons)


def test_qualification_no_instagram_anywhere_correctly_rejected():
    """No instagram_url anywhere (business, instagram_intel, or
    contact_intel) -> correctly rejected with the instagram channel
    reason."""
    worker = QualificationWorker(required_channels=("instagram",))

    enriched = EnrichedBusiness(
        pipeline_id="q-no-ig",
        business=BusinessCandidate(
            pipeline_id="q-no-ig",
            session_id="s1",
            provider="fake",
            name="Test Biz",
            website="https://testbiz.com",
        ),
        website_intel=WebsiteIntel(pipeline_id="q-no-ig", website_reachable=True, final_url="https://testbiz.com"),
        instagram_intel=InstagramIntel(pipeline_id="q-no-ig", profile_reachable=False, fetch_duration=None),
        contact_intel=ContactIntel(pipeline_id="q-no-ig"),
    )

    result = worker.process(enriched)
    assert result.qualified is False
    assert any("missing required channel: instagram" in r for r in result.reasons)
