"""
Regression tests — website-discovered Instagram URL must survive the
Python -> Node enrichment boundary.

ROOT CAUSE this pins: ContactWorker found an Instagram link on the
business's own website and put it on ContactIntel.instagram_url, but
engine_enrichment_bridge._enriched_to_dict() (the dict `service.py enrich`
prints as JSON for businessProcessingJob.ts::enrichBusiness) never
included it. Node therefore never saw an Instagram URL and live discovery
rejected Instagram-requiring leads at the post-enrichment channel gate.

No network: WebsiteWorker is stubbed and ContactWorker's page fetch is
monkeypatched, exactly like tests/test_instagram_discovery_fix.py.
"""

from __future__ import annotations

import json
from typing import Tuple

import pytest

import engine_enrichment_bridge as bridge
from engine.contracts import ContactIntel, WebsiteIntel
from workers.contact_worker import ContactWorker


class _StubWebsiteWorker:
    def process(self, candidate) -> WebsiteIntel:
        return WebsiteIntel(
            pipeline_id=candidate.pipeline_id,
            website_reachable=True,
            final_url=candidate.website,
        )


def _enrich(monkeypatch, html: str) -> dict:
    """Run the real bridge for one website-only business over fixed HTML."""

    def _fake_fetch(self, url: str) -> Tuple[str, str, float]:
        return html, url, 0.01

    monkeypatch.setattr(bridge, "WebsiteWorker", _StubWebsiteWorker)
    monkeypatch.setattr(ContactWorker, "_fetch", _fake_fetch)
    result = bridge.enrich_business_with_engine_v2(
        {"name": "Test Bakery", "website": "https://bakery.example"}
    )
    # What actually crosses the process boundary: service.py::_enrich_cli
    # writes json.dumps(result, default=str) and Node JSON.parse()s it.
    return json.loads(json.dumps(result, default=str))


def test_website_instagram_url_survives_bridge_output(monkeypatch):
    html = '<footer><a href="https://instagram.com/the_bakery?hl=en">IG</a></footer>'
    result = _enrich(monkeypatch, html)
    assert result["instagram"] == "https://www.instagram.com/the_bakery/"


def test_instagram_key_is_always_present_and_null_when_nothing_found(monkeypatch):
    result = _enrich(monkeypatch, "<html><body>No socials here</body></html>")
    assert "instagram" in result
    assert result["instagram"] is None


@pytest.mark.parametrize(
    "href",
    [
        "https://www.instagram.com/p/Cabc123/",
        "https://www.instagram.com/explore/",
        "https://www.instagram.com/reel/xyz/",
        "https://www.instagram.com/",
        "https://www.instagram.com/123456/",
    ],
)
def test_non_profile_instagram_links_are_not_returned(monkeypatch, href):
    result = _enrich(monkeypatch, f'<a href="{href}">link</a>')
    assert result["instagram"] is None


def test_unrelated_url_is_not_treated_as_instagram(monkeypatch):
    html = '<a href="https://fakeinstagram.com/bakery">x</a><a href="https://facebook.com/bakery">fb</a>'
    result = _enrich(monkeypatch, html)
    assert result["instagram"] is None


@pytest.mark.parametrize(
    "raw",
    [
        None,
        "",
        "https://www.instagram.com/p/xyz/",
        "https://www.instagram.com/accounts/login/",
        "https://example.com/not-instagram",
    ],
)
def test_helper_rejects_missing_or_invalid_contact_instagram(raw):
    intel = ContactIntel(pipeline_id="p1", instagram_url=raw)
    assert bridge._website_instagram_url(intel) is None


def test_helper_returns_canonical_url_and_handles_no_contact_intel():
    good = ContactIntel(pipeline_id="p1", instagram_url="https://instagram.com/Shop.One")
    assert bridge._website_instagram_url(good) == "https://www.instagram.com/Shop.One/"
    assert bridge._website_instagram_url(None) is None
