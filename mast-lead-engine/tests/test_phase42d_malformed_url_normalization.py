"""
PHASE 42D-1 — Malformed/control-character URL crash fix.

Root cause under test
----------------------
A website/href value polluted with an embedded control character or
literal newline (not just leading/trailing whitespace, which `.strip()`
already handles) survives into `urllib.request`, whose underlying
`http.client` raises `ValueError: URL can't contain control characters`
when the request is opened. That `ValueError` was not one of the caught
exception types in `WebsiteWorker.process()` (only
`urllib.error.HTTPError`, `urllib.error.URLError`, `socket.timeout`,
`ConnectionError` were caught) and propagated uncaught, dead-lettering
an otherwise-legitimate candidate.

The fix has two layers:
  1. `utils.parsing.strip_control_characters()` sanitizes the value up
     front at every relevant call site (WebsiteWorker.process's
     `raw_website`, ContactWorker._fetch's `raw_url`,
     ContactWorker._extract_first_link's `resolved`, and
     utils.parsing.clean_ig_url's `raw`).
  2. Defense-in-depth: `ValueError` is now also caught in
     `WebsiteWorker.process()` (both the primary request and the http
     fallback) and treated the same as `urllib.error.URLError` --
     translated into `WebsiteIntel(website_reachable=False)`, not
     propagated.

Run: pytest tests/test_phase42d_malformed_url_normalization.py -v
"""

from __future__ import annotations

import os
import sys
import urllib.error

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

from engine.contracts import BusinessCandidate, WebsiteIntel
from utils.parsing import clean_ig_url, strip_control_characters
from workers.contact_worker import ContactWorker
from workers.website_worker import WebsiteWorker


_CONTROL_CHAR_URL = "facebook.com/\x00my\x0bbiz\x1fpage"
_CONTROL_CHAR_URL_CLEANED = "facebook.com/mybizpage"


# ── Test 1: strip_control_characters() itself ──────────────────────────────
def test_strip_control_characters_removes_embedded_control_chars():
    """Strips embedded (non-whitespace) control chars from a
    facebook.com-shaped URL without altering an already-clean URL.

    Note: tab/newline/CR (\\x09/\\x0a/\\x0d) are intentionally NOT in
    `_CONTROL_CHAR_RE`'s range -- those are left to the `ValueError`
    catch (defense-in-depth) added to WebsiteWorker.process(), per the
    fix description's "sanitization won't catch every edge case."
    """
    polluted = "https://facebook.com/my\x00biz\x1fpage\x7f"
    cleaned = strip_control_characters(polluted)
    assert "\x00" not in cleaned
    assert "\x1f" not in cleaned
    assert "\x7f" not in cleaned
    assert cleaned == "https://facebook.com/mybizpage"

    clean_url = "https://facebook.com/mybizpage"
    assert strip_control_characters(clean_url) == clean_url

    # None/empty pass through unchanged, no crash.
    assert strip_control_characters("") == ""
    assert strip_control_characters(None) is None


# ── Test 2: WebsiteWorker.process() with a control-character website ──────
def test_website_worker_control_character_url_does_not_raise():
    """A website value with an embedded control character must not crash
    process() -- it must return WebsiteIntel(website_reachable=False),
    exactly as any other unreachable-site fact would, instead of raising
    ValueError."""
    worker = WebsiteWorker()

    def _raise_value_error(request, timeout=None):
        raise ValueError("URL can't contain control characters")

    import urllib.request as _urllib_request
    orig_build_opener = _urllib_request.build_opener

    class _FakeOpener:
        def open(self, request, timeout=None):
            raise ValueError("URL can't contain control characters")

    def _fake_build_opener(*_args, **_kwargs):
        return _FakeOpener()

    _urllib_request.build_opener = _fake_build_opener
    try:
        candidate = BusinessCandidate(
            session_id="s1",
            provider="google_maps",
            pipeline_id="p-malformed-url",
            name="Malformed URL Biz",
            website=_CONTROL_CHAR_URL,
        )
        intel = worker.process(candidate)
        assert isinstance(intel, WebsiteIntel)
        assert intel.website_reachable is False
        assert intel.pipeline_id == "p-malformed-url"
    finally:
        _urllib_request.build_opener = orig_build_opener


def test_website_worker_sanitizes_input_before_building_target_url():
    """`raw_website` is sanitized up front, so the sanitized (not the
    original polluted) URL is what actually gets requested."""
    worker = WebsiteWorker()
    requested_urls = []

    import urllib.request as _urllib_request
    orig_build_opener = _urllib_request.build_opener

    class _RecordingOpener:
        def open(self, request, timeout=None):
            requested_urls.append(request.full_url)
            raise urllib.error.URLError("connection refused")

    def _fake_build_opener(*_args, **_kwargs):
        return _RecordingOpener()

    _urllib_request.build_opener = _fake_build_opener
    try:
        candidate = BusinessCandidate(
            session_id="s1",
            provider="google_maps",
            pipeline_id="p-sanitized-url",
            name="Sanitized URL Biz",
            website=_CONTROL_CHAR_URL,
        )
        worker.process(candidate)
        assert requested_urls, "expected at least one request attempt"
        for url in requested_urls:
            assert "\x00" not in url
            assert "\x0b" not in url
            assert "\x1f" not in url
    finally:
        _urllib_request.build_opener = orig_build_opener


# ── Test 3: ContactWorker link/href sanitization ───────────────────────────
def test_extract_first_link_sanitizes_control_characters():
    """A control-character-polluted href, once resolved against the base
    URL, must be normalized/cleaned before being returned/stored (e.g.
    for linkedin/whatsapp/messenger/telegram link extraction)."""
    html = '<a href="https://linkedin.com/company/my\x00biz\x1fpage">LinkedIn</a>'
    import re
    linkedin_re = re.compile(r"linkedin\.com/company/", re.IGNORECASE)
    result = ContactWorker._extract_first_link(html, "https://mybiz.com", linkedin_re)
    assert result is not None
    assert "\x00" not in result
    assert "\x1f" not in result
    assert result == "https://linkedin.com/company/mybizpage"


def test_contact_worker_fetch_sanitizes_raw_url():
    """ContactWorker._fetch's raw_url must be sanitized before any
    request is attempted."""
    worker = ContactWorker()
    requested = []

    import urllib.request as _urllib_request
    orig_urlopen = _urllib_request.urlopen

    def _fake_urlopen(req, timeout=None):
        requested.append(req.full_url)
        raise urllib.error.URLError("connection refused")

    _urllib_request.urlopen = _fake_urlopen
    try:
        try:
            worker._fetch(_CONTROL_CHAR_URL)
        except urllib.error.URLError:
            pass
        assert requested
        for url in requested:
            assert "\x00" not in url
            assert "\x0b" not in url
            assert "\x1f" not in url
    finally:
        _urllib_request.urlopen = orig_urlopen


# ── Test 4: clean_ig_url() sanitization ────────────────────────────────────
def test_clean_ig_url_sanitizes_control_characters():
    """Instagram URL normalization strips embedded control characters
    before parsing the handle out."""
    polluted = "https://instagram.com/my\x00handle\x1f/"
    cleaned = clean_ig_url(polluted)
    assert cleaned == "https://www.instagram.com/myhandle/"
