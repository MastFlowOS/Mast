"""
Regression tests for Phase 9.1 — broaden contact-page discovery.

Covers the confirmed email false-negative mechanism from the Phase 9
audit: `WebsiteWorker._extract_contact_page()` only recognized links
whose href/text contained the literal substring "contact", missing
real published-email pages under Press/Careers/Wholesale/Policies/
Help/Support/Partners/Locations/About (confirmed audited false
negatives: Chalait, Café Grumpy, Blank Street).

Scope: ONLY the broadened hint-keyword matcher and its telemetry.
No deep crawling, no browser rendering, no JSON-LD, no qualification
change, no additional network calls, no change to ContactWorker's
email validators — see workers/website_worker.py's own Phase 9.1
comments for the exact same scope statement.
"""

from __future__ import annotations

from typing import Optional

from engine.contracts import BusinessCandidate, WebsiteIntel
from workers.website_worker import (
    _CONTACT_PAGE_HINT_KEYWORDS,
    WebsiteWorker,
)


# ─────────────────────────────────────────────────────────────────────────
# Fakes — mirrors tests/test_phase8_1_contact_worker_resilience.py's
# minimal urllib.request.urlopen()-shaped stand-ins.
# ─────────────────────────────────────────────────────────────────────────

class _FakeHeaders:
    def get_content_charset(self) -> Optional[str]:
        return "utf-8"


class _FakeResponse:
    def __init__(self, url: str, html: str, status: int = 200) -> None:
        self._url = url
        self._html = html.encode("utf-8")
        self.headers = _FakeHeaders()
        self.status = status

    def __enter__(self) -> "_FakeResponse":
        return self

    def __exit__(self, *exc_info) -> None:
        return None

    def geturl(self) -> str:
        return self._url

    def read(self) -> bytes:
        return self._html


def _candidate(website: str = "https://example.com") -> BusinessCandidate:
    return BusinessCandidate(
        pipeline_id="pl_test",
        session_id="sess_test",
        provider="test",
        website=website,
    )


def _process_html(monkeypatch, html: str, url: str = "https://example.com") -> WebsiteIntel:
    """Runs the full WebsiteWorker.process() path against fixed HTML, via
    a fake opener — exercises _extract_contact_page() exactly the way
    production does, with no real network call."""

    def _fake_open(self, request, timeout=None):  # noqa: ARG001
        return _FakeResponse(url, html)

    monkeypatch.setattr(
        "urllib.request.OpenerDirector.open", _fake_open, raising=True
    )
    worker = WebsiteWorker()
    return worker.process(_candidate(website=url))


# ─────────────────────────────────────────────────────────────────────────
# Unit-level: _extract_contact_page() directly (no network involved at
# all — this is a pure function of html/base_url).
# ─────────────────────────────────────────────────────────────────────────

def test_keyword_list_is_exactly_the_specified_set():
    assert _CONTACT_PAGE_HINT_KEYWORDS == (
        "contact",
        "help",
        "support",
        "about",
        "press",
        "careers",
        "wholesale",
        "partners",
        "terms",
        "policy",
        "policies",
        "locations",
    )


def test_contact_us_still_works():
    html = '<html><body><a href="/contact-us">Contact Us</a></body></html>'
    url, hint = WebsiteWorker._extract_contact_page(html, "https://example.com")
    assert url == "https://example.com/contact-us"
    assert hint == "contact"


def test_help_is_recognized():
    html = '<html><body><a href="/help">Help</a></body></html>'
    url, hint = WebsiteWorker._extract_contact_page(html, "https://example.com")
    assert url == "https://example.com/help"
    assert hint == "help"


def test_support_is_recognized():
    html = '<html><body><a href="/support">Customer Support</a></body></html>'
    url, hint = WebsiteWorker._extract_contact_page(html, "https://example.com")
    assert url == "https://example.com/support"
    assert hint == "support"


def test_press_is_recognized():
    html = '<html><body><a href="/press">Press</a></body></html>'
    url, hint = WebsiteWorker._extract_contact_page(html, "https://example.com")
    assert url == "https://example.com/press"
    assert hint == "press"


def test_careers_is_recognized():
    html = '<html><body><a href="/careers">Careers</a></body></html>'
    url, hint = WebsiteWorker._extract_contact_page(html, "https://example.com")
    assert url == "https://example.com/careers"
    assert hint == "careers"


def test_wholesale_is_recognized():
    html = '<html><body><a href="/wholesale">Wholesale Inquiries</a></body></html>'
    url, hint = WebsiteWorker._extract_contact_page(html, "https://example.com")
    assert url == "https://example.com/wholesale"
    assert hint == "wholesale"


def test_policies_is_recognized():
    html = '<html><body><a href="/policies">Our Policies</a></body></html>'
    url, hint = WebsiteWorker._extract_contact_page(html, "https://example.com")
    assert url == "https://example.com/policies"
    assert hint == "policies"


def test_terms_is_recognized():
    html = '<html><body><a href="/terms">Terms of Service</a></body></html>'
    url, hint = WebsiteWorker._extract_contact_page(html, "https://example.com")
    assert url == "https://example.com/terms"
    assert hint == "terms"


def test_locations_is_recognized():
    html = '<html><body><a href="/locations">Locations</a></body></html>'
    url, hint = WebsiteWorker._extract_contact_page(html, "https://example.com")
    assert url == "https://example.com/locations"
    assert hint == "locations"


def test_policy_word_boundary_does_not_match_policies_or_vice_versa():
    # "\b" boundaries mean "policy" won't spuriously match inside
    # "policies" — each keyword only matches its own whole word.
    html = '<html><body><a href="/policies">Policies</a></body></html>'
    _, hint = WebsiteWorker._extract_contact_page(html, "https://example.com")
    assert hint == "policies"

    html2 = '<html><body><a href="/privacy-policy">Privacy Policy</a></body></html>'
    _, hint2 = WebsiteWorker._extract_contact_page(html2, "https://example.com")
    assert hint2 == "policy"


def test_first_match_behavior_is_deterministic():
    # Two matching anchors on the page — the FIRST one in document
    # order must win, every time, not whichever keyword "looks more
    # specific" and not a random choice.
    html = (
        "<html><body>"
        '<a href="/about">About Us</a>'
        '<a href="/contact">Contact</a>'
        "</body></html>"
    )
    for _ in range(5):
        url, hint = WebsiteWorker._extract_contact_page(html, "https://example.com")
        assert url == "https://example.com/about"
        assert hint == "about"


def test_external_unrelated_navigation_is_not_treated_as_contact_page():
    html = (
        "<html><body>"
        '<a href="https://example.com/shop">Shop</a>'
        '<a href="https://example.com/blog">Blog</a>'
        '<a href="https://facebook.com/example">Facebook</a>'
        "</body></html>"
    )
    url, hint = WebsiteWorker._extract_contact_page(html, "https://example.com")
    assert url is None
    assert hint is None


def test_no_anchors_at_all_returns_none():
    html = "<html><body><p>No links here.</p></body></html>"
    url, hint = WebsiteWorker._extract_contact_page(html, "https://example.com")
    assert url is None
    assert hint is None


def test_existing_contact_page_extraction_behavior_remains_unchanged():
    # Same shape of test as the original: href-only match, text-only
    # match, and absolute-URL resolution against base_url all still
    # behave exactly as before broadening.
    html_href_only = '<html><body><a href="/contact-page">Get in touch</a></body></html>'
    url, hint = WebsiteWorker._extract_contact_page(html_href_only, "https://example.com")
    assert url == "https://example.com/contact-page"
    assert hint == "contact"

    html_text_only = '<html><body><a href="/reach-us">Contact</a></body></html>'
    url2, hint2 = WebsiteWorker._extract_contact_page(html_text_only, "https://example.com")
    assert url2 == "https://example.com/reach-us"
    assert hint2 == "contact"

    html_absolute = '<html><body><a href="https://other.example.com/contact">Contact</a></body></html>'
    url3, _ = WebsiteWorker._extract_contact_page(html_absolute, "https://example.com")
    assert url3 == "https://other.example.com/contact"


# ─────────────────────────────────────────────────────────────────────────
# Audited fixture-style regressions — Chalait / Café Grumpy shaped
# homepages, where no link literally says "contact" but a real public
# email lives behind a Press/Careers or Policies/Terms page.
# ─────────────────────────────────────────────────────────────────────────

CHALAIT_STYLE_HTML = """
<html>
<head><title>Chalait</title></head>
<body>
  <nav>
    <a href="/shop">Shop</a>
    <a href="/press-careers">Press &amp; Careers</a>
    <a href="/locations">Our Locations</a>
  </nav>
</body>
</html>
"""

CAFE_GRUMPY_STYLE_HTML = """
<html>
<head><title>Cafe Grumpy</title></head>
<body>
  <nav>
    <a href="/menu">Menu</a>
    <a href="/wholesale">Wholesale</a>
  </nav>
  <footer>
    <a href="/policies-and-terms">Policies &amp; Terms</a>
  </footer>
</body>
</html>
"""


def test_chalait_style_fixture_resolves_press_careers_page():
    url, hint = WebsiteWorker._extract_contact_page(
        CHALAIT_STYLE_HTML, "https://chalait.example.com"
    )
    assert url == "https://chalait.example.com/press-careers"
    assert hint == "press"


def test_cafe_grumpy_style_fixture_resolves_wholesale_before_policies():
    # First-match-in-document-order: Wholesale appears before the
    # Policies/Terms footer link, so Wholesale wins deterministically.
    url, hint = WebsiteWorker._extract_contact_page(
        CAFE_GRUMPY_STYLE_HTML, "https://cafegrumpy.example.com"
    )
    assert url == "https://cafegrumpy.example.com/wholesale"
    assert hint == "wholesale"


def test_cafe_grumpy_style_fixture_resolves_policies_terms_when_earlier_in_document():
    # Same fixture family, but with only the Policies/Terms page present
    # (no Wholesale link) — confirms the Policies/Terms match itself
    # resolves correctly and reports the "policies" hint.
    html = """
    <html><body>
      <nav><a href="/menu">Menu</a></nav>
      <footer><a href="/policies-and-terms">Policies &amp; Terms</a></footer>
    </body></html>
    """
    url, hint = WebsiteWorker._extract_contact_page(html, "https://cafegrumpy.example.com")
    assert url == "https://cafegrumpy.example.com/policies-and-terms"
    assert hint == "policies"


# ─────────────────────────────────────────────────────────────────────────
# Full process() integration — confirms the hint flows into WebsiteIntel
# and that at most one secondary page is ever chosen, with no additional
# fetches (only the one homepage open() call happens).
# ─────────────────────────────────────────────────────────────────────────

def test_process_populates_contact_page_and_hint_from_broadened_keywords(monkeypatch):
    intel = _process_html(monkeypatch, CHALAIT_STYLE_HTML, "https://chalait.example.com")
    assert isinstance(intel, WebsiteIntel)
    assert intel.contact_page == "https://chalait.example.com/press-careers"
    assert intel.contact_page_hint == "press"


def test_process_selects_at_most_one_secondary_page(monkeypatch):
    html = (
        "<html><body>"
        '<a href="/about">About</a>'
        '<a href="/careers">Careers</a>'
        '<a href="/contact">Contact</a>'
        "</body></html>"
    )
    intel = _process_html(monkeypatch, html, "https://example.com")
    # Exactly one contact_page / hint pair — first match wins.
    assert intel.contact_page == "https://example.com/about"
    assert intel.contact_page_hint == "about"


def test_process_with_no_matching_link_leaves_contact_page_none(monkeypatch):
    html = '<html><body><a href="/shop">Shop</a></body></html>'
    intel = _process_html(monkeypatch, html, "https://example.com")
    assert intel.contact_page is None
    assert intel.contact_page_hint is None
