"""
PHASE 5D — targeted regression tests for ContactWorker's internal
page-fetch parallelism.

Deliberately narrow, per Phase 5D's own instructions ("do not create
dozens of edge-case tests"). Covers only:

    1. The `contact_page` and `homepage` fetches for one candidate
       execute concurrently (overlap in wall-clock time), not
       sequentially.
    2. One page failing does not prevent the other, successful page
       from contributing its evidence.
    3. Both pages failing preserves existing failure behavior
       (identical to the pre-Phase-5D sequential result for the same
       inputs).
    4. The merged ContactIntel is identical regardless of which page's
       fetch happens to finish first (determinism / fixed precedence).
    5. Existing per-page 429 retry/backoff still runs correctly when
       the fetch happens inside the executor.

No network I/O anywhere in this file -- `urllib.request.urlopen` is
monkeypatched, exactly as `tests/test_phase8_1_contact_worker_resilience.py`
already does.
"""

from __future__ import annotations

import threading
import time
import urllib.error
from typing import Optional

import pytest

from engine.contracts import WebsiteIntel
from workers.contact_worker import ContactWorker


class _FakeHeaders:
    def __init__(self, retry_after: Optional[str] = None) -> None:
        self._retry_after = retry_after

    def get_content_charset(self) -> Optional[str]:
        return "utf-8"

    def get(self, key: str, default=None):
        if key == "Retry-After":
            return self._retry_after
        return default


class _FakeResponse:
    def __init__(self, url: str, html: str) -> None:
        self._url = url
        self._html = html.encode("utf-8")
        self.headers = _FakeHeaders()

    def __enter__(self) -> "_FakeResponse":
        return self

    def __exit__(self, *exc_info) -> None:
        return None

    def geturl(self) -> str:
        return self._url

    def read(self) -> bytes:
        return self._html


def _website_intel(
    *, contact_page: Optional[str] = None, final_url: Optional[str] = None
) -> WebsiteIntel:
    return WebsiteIntel(
        pipeline_id="pl_test",
        website_reachable=True,
        contact_page=contact_page,
        final_url=final_url,
    )


HTML_WITH_EMAIL = '<html><body><a href="mailto:hello@kettl.co">Email</a></body></html>'
HTML_WITH_FORM_AND_WHATSAPP = (
    '<html><body><form action="/send"></form>'
    '<a href="https://wa.me/15551234567">WhatsApp</a></body></html>'
)


# ─────────────────────────────────────────────────────────────────────────
# 1. Concurrency: both fetches genuinely overlap
# ─────────────────────────────────────────────────────────────────────────

def test_contact_page_and_homepage_fetch_concurrently(monkeypatch):
    """Two 150ms fetches should take ~150ms total, not ~300ms, proving
    they run in parallel rather than one after another."""

    barrier = threading.Barrier(2, timeout=2)
    started_at: "dict[str, float]" = {}
    lock = threading.Lock()

    def _fake_urlopen(request, timeout=None):
        url = request.full_url
        with lock:
            started_at[url] = time.monotonic()
        barrier.wait()  # both requests must be in-flight simultaneously
        time.sleep(0.05)
        if url == "https://kettl.co/contact":
            return _FakeResponse(url, HTML_WITH_FORM_AND_WHATSAPP)
        return _FakeResponse(url, HTML_WITH_EMAIL)

    monkeypatch.setattr("workers.contact_worker.urllib.request.urlopen", _fake_urlopen)

    worker = ContactWorker()
    item = _website_intel(
        contact_page="https://kettl.co/contact", final_url="https://kettl.co/"
    )
    start = time.monotonic()
    result = worker.process(item)
    elapsed = time.monotonic() - start

    # Both requests observed as started, and process() didn't serialize them.
    assert set(started_at) == {"https://kettl.co/contact", "https://kettl.co/"}
    assert elapsed < 0.3  # well under 2x the per-fetch sleep
    assert result.contact_form_url == "https://kettl.co/contact"
    assert result.whatsapp_link == "https://wa.me/15551234567"
    assert result.emails == ("hello@kettl.co",)


# ─────────────────────────────────────────────────────────────────────────
# 2. One page failing does not block the other's contribution
# ─────────────────────────────────────────────────────────────────────────

def test_one_page_failure_does_not_prevent_other_page_success(monkeypatch):
    def _fake_urlopen(request, timeout=None):
        url = request.full_url
        if url == "https://kettl.co/contact":
            raise urllib.error.HTTPError(url, 403, "Forbidden", {}, None)
        time.sleep(0.02)
        return _FakeResponse(url, HTML_WITH_EMAIL)

    monkeypatch.setattr("workers.contact_worker.urllib.request.urlopen", _fake_urlopen)

    worker = ContactWorker()
    item = _website_intel(
        contact_page="https://kettl.co/contact", final_url="https://kettl.co/"
    )
    result = worker.process(item)

    assert result.contact_page_fetch_failed is True
    assert result.homepage_fetch_failed is False
    assert result.emails == ("hello@kettl.co",)
    assert result.partial_contact_success is True


# ─────────────────────────────────────────────────────────────────────────
# 3. Both pages failing preserves existing failure behavior
# ─────────────────────────────────────────────────────────────────────────

def test_both_pages_failing_preserves_existing_behavior(monkeypatch):
    def _fake_urlopen(request, timeout=None):
        raise urllib.error.URLError("connection reset")

    monkeypatch.setattr("workers.contact_worker.urllib.request.urlopen", _fake_urlopen)

    worker = ContactWorker()
    item = _website_intel(
        contact_page="https://kettl.co/contact", final_url="https://kettl.co/"
    )
    result = worker.process(item)

    # Matches the pre-Phase-5D sequential result for this same scenario
    # (see Phase 42D-2 in the module docstring): no exception propagates,
    # only the fetch-failed flags and pipeline_id are populated.
    assert result.contact_page_fetch_failed is True
    assert result.homepage_fetch_failed is True
    assert result.emails is None
    assert result.phones is None


# ─────────────────────────────────────────────────────────────────────────
# 4. Deterministic merge regardless of completion order
# ─────────────────────────────────────────────────────────────────────────

@pytest.mark.parametrize("slow_page", ["contact", "homepage"])
def test_merge_is_deterministic_regardless_of_completion_order(monkeypatch, slow_page):
    """`contact_page` must win precedence for contact_form_url whether it
    finishes first or last."""

    contact_html = '<html><body><form action="/a"></form></body></html>'
    homepage_html = '<html><body><form action="/b"></form></body></html>'

    def _fake_urlopen(request, timeout=None):
        url = request.full_url
        is_contact = url == "https://kettl.co/contact"
        if (slow_page == "contact") == is_contact:
            time.sleep(0.05)
        else:
            time.sleep(0.01)
        if is_contact:
            return _FakeResponse(url, contact_html)
        return _FakeResponse(url, homepage_html)

    monkeypatch.setattr("workers.contact_worker.urllib.request.urlopen", _fake_urlopen)

    worker = ContactWorker()
    item = _website_intel(
        contact_page="https://kettl.co/contact", final_url="https://kettl.co/"
    )
    result = worker.process(item)

    # contact_page is fetched/merged first in role-priority order
    # regardless of which HTTP request actually completed first.
    assert result.contact_form_url == "https://kettl.co/contact"


# ─────────────────────────────────────────────────────────────────────────
# 5. Per-page 429 retry/backoff still works inside the executor
# ─────────────────────────────────────────────────────────────────────────

def test_429_retry_still_works_when_fetch_runs_in_executor(monkeypatch):
    calls: "dict[str, int]" = {"contact": 0}

    def _fake_urlopen(request, timeout=None):
        url = request.full_url
        if url == "https://kettl.co/contact":
            calls["contact"] += 1
            if calls["contact"] == 1:
                raise urllib.error.HTTPError(
                    url, 429, "Too Many Requests", {"Retry-After": "0.01"}, None
                )
            return _FakeResponse(url, HTML_WITH_FORM_AND_WHATSAPP)
        return _FakeResponse(url, HTML_WITH_EMAIL)

    monkeypatch.setattr("workers.contact_worker.urllib.request.urlopen", _fake_urlopen)

    worker = ContactWorker()
    item = _website_intel(
        contact_page="https://kettl.co/contact", final_url="https://kettl.co/"
    )
    result = worker.process(item)

    assert calls["contact"] == 2  # one retry, same as sequential behavior
    assert result.contact_page_fetch_failed is False
    assert result.whatsapp_link == "https://wa.me/15551234567"
