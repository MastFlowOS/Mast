"""
Regression tests for Phase 8.1 — ContactWorker resilience fix.

Covers the two confirmed production bugs (104 contact_stage_failed
occurrences / 53 unique businesses, all with WebsiteWorker success,
kettl.co as the confirmed four-channel false negative):

    FIX 1 — mailto:/tel: contact_page values must never be passed to
            urlopen(); the address/number is read directly off the
            literal href instead.
    FIX 2 — a failure fetching one candidate page (contact_page or
            final_url) must not prevent the other candidate from being
            tried, and must not discard evidence already extracted
            from a page that did succeed.

These tests touch only workers/contact_worker.py's own behavior. They
do not exercise qualification, scoring, retry policy, dedup, or any
runtime/queue component — none of that changed in this phase.
"""

from __future__ import annotations

import socket
import urllib.error
from typing import Optional

import pytest

from engine.contracts import ContactIntel, WebsiteIntel
from workers.contact_worker import ContactWorker


# ─────────────────────────────────────────────────────────────────────────
# Fakes
# ─────────────────────────────────────────────────────────────────────────

class _FakeHeaders:
    def get_content_charset(self) -> Optional[str]:
        return "utf-8"


class _FakeResponse:
    """Minimal stand-in for the object urllib.request.urlopen() returns,
    used as a context manager exactly as ContactWorker._fetch() uses it.
    """

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
# FIX 1 — mailto:/tel: must never be fetched
# ─────────────────────────────────────────────────────────────────────────

def test_mailto_contact_page_does_not_trigger_urllib(monkeypatch):
    def _fake_urlopen(*args, **kwargs):
        raise AssertionError("urlopen must never be called for a mailto: contact_page")

    monkeypatch.setattr("workers.contact_worker.urllib.request.urlopen", _fake_urlopen)

    worker = ContactWorker()
    item = _website_intel(contact_page="mailto:owner@kettl.co")
    result = worker.process(item)

    assert result.emails == ("owner@kettl.co",)


def test_mailto_email_is_extracted_correctly(monkeypatch):
    monkeypatch.setattr(
        "workers.contact_worker.urllib.request.urlopen",
        lambda *a, **k: (_ for _ in ()).throw(AssertionError("must not fetch")),
    )
    worker = ContactWorker()
    item = _website_intel(contact_page="mailto:Contact@Kettl.co?subject=Hi")
    result = worker.process(item)

    assert result.emails == ("contact@kettl.co",)
    assert result.mailto_extracted is True
    assert result.tel_extracted is False


def test_tel_contact_page_does_not_trigger_urllib(monkeypatch):
    def _fake_urlopen(*args, **kwargs):
        raise AssertionError("urlopen must never be called for a tel: contact_page")

    monkeypatch.setattr("workers.contact_worker.urllib.request.urlopen", _fake_urlopen)

    worker = ContactWorker()
    item = _website_intel(contact_page="tel:+15551234567")
    result = worker.process(item)

    assert result.phones == ("+15551234567",)


def test_tel_phone_is_extracted_correctly(monkeypatch):
    monkeypatch.setattr(
        "workers.contact_worker.urllib.request.urlopen",
        lambda *a, **k: (_ for _ in ()).throw(AssertionError("must not fetch")),
    )
    worker = ContactWorker()
    item = _website_intel(contact_page="tel: (555) 123-4567 ")
    result = worker.process(item)

    assert result.phones == ("(555) 123-4567", )
    assert result.tel_extracted is True
    assert result.mailto_extracted is False


# ─────────────────────────────────────────────────────────────────────────
# FIX 2 — isolate per-page fetch failures
# ─────────────────────────────────────────────────────────────────────────

def test_contact_page_403_plus_homepage_succeeds(monkeypatch):
    def _fake_urlopen(request, timeout=None):
        url = request.full_url
        if url == "https://kettl.co/contact":
            raise urllib.error.HTTPError(url, 403, "Forbidden", {}, None)
        return _FakeResponse(url, HTML_WITH_FORM_AND_WHATSAPP)

    monkeypatch.setattr("workers.contact_worker.urllib.request.urlopen", _fake_urlopen)

    worker = ContactWorker()
    item = _website_intel(
        contact_page="https://kettl.co/contact", final_url="https://kettl.co/"
    )
    result = worker.process(item)

    assert result.contact_page_fetch_failed is True
    assert result.homepage_fetch_failed is False
    assert result.contact_form_url == "https://kettl.co/"
    assert result.whatsapp_link == "https://wa.me/15551234567"
    assert result.partial_contact_success is True


def test_contact_page_404_plus_homepage_succeeds(monkeypatch):
    def _fake_urlopen(request, timeout=None):
        url = request.full_url
        if url == "https://kettl.co/contact":
            raise urllib.error.HTTPError(url, 404, "Not Found", {}, None)
        return _FakeResponse(url, HTML_WITH_EMAIL)

    monkeypatch.setattr("workers.contact_worker.urllib.request.urlopen", _fake_urlopen)

    worker = ContactWorker()
    item = _website_intel(
        contact_page="https://kettl.co/contact", final_url="https://kettl.co/"
    )
    result = worker.process(item)

    assert result.contact_page_fetch_failed is True
    assert result.emails == ("hello@kettl.co",)
    assert result.partial_contact_success is True


def test_homepage_failure_plus_contact_page_succeeds(monkeypatch):
    def _fake_urlopen(request, timeout=None):
        url = request.full_url
        if url == "https://kettl.co/":
            raise socket.timeout("timed out")
        return _FakeResponse(url, HTML_WITH_EMAIL)

    monkeypatch.setattr("workers.contact_worker.urllib.request.urlopen", _fake_urlopen)

    worker = ContactWorker()
    item = _website_intel(
        contact_page="https://kettl.co/contact", final_url="https://kettl.co/"
    )
    result = worker.process(item)

    assert result.homepage_fetch_failed is True
    assert result.contact_page_fetch_failed is False
    assert result.emails == ("hello@kettl.co",)
    assert result.partial_contact_success is True


def test_both_pages_fail_existing_failure_behavior_remains(monkeypatch):
    def _fake_urlopen(request, timeout=None):
        raise urllib.error.URLError("connection reset")

    monkeypatch.setattr("workers.contact_worker.urllib.request.urlopen", _fake_urlopen)

    worker = ContactWorker()
    item = _website_intel(
        contact_page="https://kettl.co/contact", final_url="https://kettl.co/"
    )
    with pytest.raises(urllib.error.URLError):
        worker.process(item)


def test_partial_email_and_phone_evidence_is_preserved(monkeypatch):
    # contact_page is a plain mailto: (no fetch at all); final_url fetch
    # fails outright. Evidence from the mailto: must still come back.
    def _fake_urlopen(request, timeout=None):
        raise urllib.error.URLError("connection reset")

    monkeypatch.setattr("workers.contact_worker.urllib.request.urlopen", _fake_urlopen)

    worker = ContactWorker()
    item = _website_intel(
        contact_page="mailto:hello@kettl.co", final_url="https://kettl.co/"
    )
    result = worker.process(item)

    assert result.emails == ("hello@kettl.co",)
    assert result.mailto_extracted is True
    assert result.homepage_fetch_failed is True
    assert result.partial_contact_success is True


def test_instagram_extraction_remains_unchanged(monkeypatch):
    html = (
        '<html><body><a href="https://www.instagram.com/kettlco/">IG</a>'
        "</body></html>"
    )

    def _fake_urlopen(request, timeout=None):
        return _FakeResponse(request.full_url, html)

    monkeypatch.setattr("workers.contact_worker.urllib.request.urlopen", _fake_urlopen)

    worker = ContactWorker()
    item = _website_intel(final_url="https://kettl.co/")
    result = worker.process(item)

    assert result.instagram_url == "https://www.instagram.com/kettlco/"


def test_existing_validation_rules_remain_unchanged(monkeypatch):
    # An invalid mailto address must still be rejected by the existing
    # email validator — Phase 8.1 must not loosen validation.
    monkeypatch.setattr(
        "workers.contact_worker.urllib.request.urlopen",
        lambda *a, **k: (_ for _ in ()).throw(AssertionError("must not fetch")),
    )
    worker = ContactWorker()
    item = _website_intel(contact_page="mailto:not-an-email")
    result = worker.process(item)

    assert result.emails is None
    # No valid address extracted, so mailto_extracted stays False even
    # though a mailto: href was present and handled without a fetch.
    assert result.mailto_extracted is False


# ─────────────────────────────────────────────────────────────────────────
# End-to-end: real ContactWorker, kettl.co-style mailto fixture
# ─────────────────────────────────────────────────────────────────────────

def test_end_to_end_kettl_co_style_four_channel_recovery(monkeypatch):
    """
    Reproduces the confirmed kettl.co false negative: WebsiteWorker
    found a mailto: contact_page and a reachable final_url whose
    contact page 404s. Before Phase 8.1 this raised out of process()
    on the mailto: urlopen() attempt alone; after, every channel the
    page actually exposes is recovered.
    """
    html = (
        "<html><body>"
        '<form action="/contact-submit"></form>'
        '<a href="tel:+15559876543">Call us</a>'
        '<a href="https://wa.me/15559876543">WhatsApp</a>'
        '<a href="https://www.instagram.com/kettlco/">Instagram</a>'
        '<a href="https://www.linkedin.com/company/kettlco">LinkedIn</a>'
        "</body></html>"
    )

    def _fake_urlopen(request, timeout=None):
        url = request.full_url
        if url == "https://kettl.co/contact":
            raise urllib.error.HTTPError(url, 404, "Not Found", {}, None)
        assert url == "https://kettl.co/"
        return _FakeResponse(url, html)

    monkeypatch.setattr("workers.contact_worker.urllib.request.urlopen", _fake_urlopen)

    worker = ContactWorker()
    item = _website_intel(
        contact_page="https://kettl.co/contact", final_url="https://kettl.co/"
    )
    result = worker.process(item)

    assert isinstance(result, ContactIntel)
    assert result.contact_page_fetch_failed is True
    assert result.phones == ("+15559876543",)
    assert result.whatsapp_link == "https://wa.me/15559876543"
    assert result.instagram_url == "https://www.instagram.com/kettlco/"
    assert result.linkedin_url == "https://www.linkedin.com/company/kettlco"
    assert result.contact_form_url == "https://kettl.co/"
    assert result.partial_contact_success is True
