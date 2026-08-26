"""
Phase 39 — Contact & Website Throughput Recovery Tests
======================================================
Verifies:
1. 403 on initial/contact page -> alternate contact page succeeds
2. 404 contact link -> alternate page succeeds
3. 429 bounded retry (respecting Retry-After and backoff)
4. 500 bounded retry
5. mailto email extraction
6. tel phone extraction
7. Instagram icon href extraction
8. Instagram aria-label extraction
9. Instagram data attribute extraction
10. JSON-LD email/phone extraction
11. contact page discovered from homepage
12. temporary fetch failure does NOT equal confirmed missing contact
13. page budget remains bounded (at most 3 page fetches)
14. 4-channel qualification rules unchanged
"""

from __future__ import annotations

import io
import urllib.error
from unittest.mock import MagicMock, patch

import pytest
from engine.contracts import (
    BusinessCandidate,
    ContactIntel,
    EnrichedBusiness,
    InstagramIntel,
    WebsiteIntel,
)
from utils.parsing import (
    decode_cfemail,
    extract_contextual_attribute_contacts,
    extract_emails,
    extract_ig_urls_with_source,
    extract_jsonld_contact_data,
    extract_phones,
    find_secondary_contact_link,
    get_standard_contact_candidates,
    is_valid_email,
    is_valid_phone,
)
from workers.contact_worker import ContactWorker
from workers.qualification_worker import QualificationWorker
from workers.website_worker import WebsiteWorker


# ── Test 1: 403 on initial contact page -> alternate page succeeds ────────────
def test_403_alternate_contact_page_succeeds():
    """When contact page returns 403, alternate page is fetched and succeeds."""
    worker = ContactWorker()

    def mock_fetch(url: str):
        if "contact-us" in url:
            raise urllib.error.HTTPError(url, 403, "Forbidden", {}, None)
        elif "mybiz.com" in url and "about" not in url and "contact" not in url:
            # homepage
            return (
                '<html><body><p>Welcome</p><a href="/about">About Us</a></body></html>',
                "https://mybiz.com",
                0.05,
            )
        elif "about" in url:
            return (
                '<html><body><p>Email: team@mybiz.com</p><a href="tel:5551234567">Call</a></body></html>',
                "https://mybiz.com/about",
                0.05,
            )
        raise urllib.error.HTTPError(url, 404, "Not Found", {}, None)

    with patch.object(worker, "_fetch", side_effect=mock_fetch):
        item = WebsiteIntel(
            pipeline_id="p-403",
            website_reachable=True,
            final_url="https://mybiz.com",
            contact_page="https://mybiz.com/contact-us",
        )
        intel = worker.process(item)
        assert intel.contact_page_fetch_failed is True
        assert intel.emails is not None
        assert "team@mybiz.com" in intel.emails
        assert intel.phones is not None


# ── Test 2: 404 contact link -> alternate page succeeds ───────────────────────
def test_404_contact_link_alternate_page_succeeds():
    """When contact page returns 404, worker explores alternate candidates and succeeds."""
    worker = ContactWorker()

    def mock_fetch(url: str):
        if "broken-contact" in url:
            raise urllib.error.HTTPError(url, 404, "Not Found", {}, None)
        elif url == "https://mybiz.com":
            return (
                '<html><body><p>Home</p></body></html>',
                "https://mybiz.com",
                0.05,
            )
        elif "contact" in url:
            return (
                '<html><body><a href="mailto:info@mybiz.com">Mail</a><a href="tel:5559876543">Tel</a></body></html>',
                "https://mybiz.com/contact",
                0.05,
            )
        raise urllib.error.HTTPError(url, 404, "Not Found", {}, None)

    with patch.object(worker, "_fetch", side_effect=mock_fetch):
        item = WebsiteIntel(
            pipeline_id="p-404",
            website_reachable=True,
            final_url="https://mybiz.com",
            contact_page="https://mybiz.com/broken-contact",
        )
        intel = worker.process(item)
        assert intel.contact_page_fetch_failed is True
        assert intel.emails == ("info@mybiz.com",)
        assert intel.phones is not None


# ── Test 3: 429 bounded retry ──────────────────────────────────────────────────
def test_429_bounded_retry():
    """When a 429 occurs, _fetch sleeps and retries once."""
    worker = ContactWorker()
    calls = []

    def mock_urlopen(req, timeout=None):
        calls.append(req.full_url)
        if len(calls) == 1:
            headers = {"Retry-After": "0.01"}
            raise urllib.error.HTTPError(req.full_url, 429, "Too Many Requests", headers, io.BytesIO(b"Rate limited"))
        resp = MagicMock()
        resp.geturl.return_value = req.full_url
        resp.read.return_value = b'<html><body><a href="mailto:retry@biz.com">Mail</a></body></html>'
        resp.headers.get_content_charset.return_value = "utf-8"
        resp.__enter__.return_value = resp
        return resp

    with patch("urllib.request.urlopen", side_effect=mock_urlopen):
        html, resolved, elapsed = worker._fetch("https://biz.com")
        assert len(calls) == 2
        assert "retry@biz.com" in html


# ── Test 4: 500 bounded retry ──────────────────────────────────────────────────
def test_500_bounded_retry():
    """When a 500 error occurs, _fetch retries once."""
    worker = ContactWorker()
    calls = []

    def mock_urlopen(req, timeout=None):
        calls.append(req.full_url)
        if len(calls) == 1:
            raise urllib.error.HTTPError(req.full_url, 500, "Internal Server Error", {}, io.BytesIO(b"Error"))
        resp = MagicMock()
        resp.geturl.return_value = req.full_url
        resp.read.return_value = b'<html><body><p>Recovered</p></body></html>'
        resp.headers.get_content_charset.return_value = "utf-8"
        resp.__enter__.return_value = resp
        return resp

    with patch("urllib.request.urlopen", side_effect=mock_urlopen):
        html, resolved, elapsed = worker._fetch("https://server-error.com")
        assert len(calls) == 2
        assert "Recovered" in html


# ── Test 5: mailto email extraction ───────────────────────────────────────────
def test_mailto_email_extraction():
    """Extracts email from anchor mailto links with subject/query params stripped."""
    html = '<a href="mailto:contact@localbakery.com?subject=Inquiry">Email Us</a>'
    emails = extract_emails(html)
    assert "contact@localbakery.com" in emails


# ── Test 6: tel phone extraction ──────────────────────────────────────────────
def test_tel_phone_extraction():
    """Extracts phone from anchor tel links."""
    html = '<a href="tel:+15551234567">Call Bakery</a>'
    phones = extract_phones(html)
    assert any("555" in p for p in phones)


# ── Test 7: Instagram icon href extraction ────────────────────────────────────
def test_instagram_icon_href_extraction():
    """Extracts Instagram profile from icon link href, including instagr.am."""
    html1 = '<a href="https://www.instagram.com/sweetbakery/" class="social-icon"><svg></svg></a>'
    urls1 = extract_ig_urls_with_source(html1)
    assert len(urls1) >= 1
    assert urls1[0][0] == "https://www.instagram.com/sweetbakery/"
    assert urls1[0][1] == "anchor_href"

    html2 = '<a href="https://instagr.am/sweetbakery_short/" class="ig-btn"></a>'
    urls2 = extract_ig_urls_with_source(html2)
    assert len(urls2) >= 1
    assert urls2[0][0] == "https://www.instagram.com/sweetbakery_short/"


# ── Test 8: Instagram aria-label extraction ───────────────────────────────────
def test_instagram_aria_label_extraction():
    """Extracts handle from icon link with aria-label / title containing Instagram."""
    html = '<a aria-label="Follow us on Instagram: @urbanroasters" href="/social-redirect"><i class="fa fa-instagram"></i></a>'
    urls = extract_ig_urls_with_source(html)
    assert len(urls) >= 1
    assert urls[0][0] == "https://www.instagram.com/urbanroasters/"


# ── Test 9: Instagram data attribute extraction ───────────────────────────────
def test_instagram_data_attribute_extraction():
    """Extracts handle from data-instagram or data-ig attributes."""
    html1 = '<div class="footer-social" data-instagram="craftsalon"></div>'
    urls1 = extract_ig_urls_with_source(html1)
    assert len(urls1) >= 1
    assert urls1[0][0] == "https://www.instagram.com/craftsalon/"
    assert urls1[0][1] == "data_attribute"

    html2 = '<a class="social-icon" data-ig-handle="craftsalon_ig" href="#"></a>'
    urls2 = extract_ig_urls_with_source(html2)
    assert len(urls2) >= 1
    assert urls2[0][0] == "https://www.instagram.com/craftsalon_ig/"


# ── Test 10: JSON-LD email and phone extraction ───────────────────────────────
def test_jsonld_email_phone_extraction():
    """Extracts email, telephone, and social URLs from JSON-LD schema blocks."""
    html = """
    <script type="application/ld+json">
    {
        "@context": "https://schema.org",
        "@type": "LocalBusiness",
        "name": "Acme Coffee",
        "email": "hello@acmecoffee.com",
        "telephone": "+1-555-888-9999",
        "sameAs": "https://www.instagram.com/acmecoffee/"
    }
    </script>
    """
    data = extract_jsonld_contact_data(html)
    assert "hello@acmecoffee.com" in data["emails"]
    assert any("888" in p for p in data["phones"])
    assert "https://www.instagram.com/acmecoffee/" in data["urls"]


# ── Test 11: Contact page discovered from homepage ────────────────────────────
def test_contact_page_discovered_from_homepage():
    """WebsiteWorker and find_secondary_contact_link discover contact/connect page from homepage."""
    html = """
    <html>
        <body>
            <nav>
                <a href="/menu">Menu</a>
                <a href="/connect">Connect With Us</a>
            </nav>
        </body>
    </html>
    """
    sec_url, sec_cat = find_secondary_contact_link(
        fetched_htmls=[(html, "https://localcafe.com")],
        base_url="https://localcafe.com",
        tried_urls={"https://localcafe.com"},
    )
    assert sec_url == "https://localcafe.com/connect"
    assert sec_cat == "contact"


# ── Test 12: Temporary fetch failure does NOT equal confirmed missing contact ─
def test_temporary_fetch_failure_propagates_exception():
    """
    Phase 42D-2: when every page fetch fails, ContactWorker no longer
    raises the underlying network exception (which used to force a
    retry/dead-letter cycle before Maps-fallback logic could run).
    Instead it returns a ContactIntel with only the fetch-failed flags
    set -- no field claims contact data was found, so this still does
    not equal a confirmed "no contact info exists" result; it lets the
    normal success-path Maps-fallback gate decide.
    """
    worker = ContactWorker()

    def mock_fail(url: str):
        raise urllib.error.URLError("Connection refused")

    with patch.object(worker, "_fetch", side_effect=mock_fail):
        item = WebsiteIntel(
            pipeline_id="p-netfail",
            website_reachable=True,
            final_url="https://down-site.com",
            contact_page="https://down-site.com/contact",
        )
        intel = worker.process(item)
        assert intel.pipeline_id == "p-netfail"
        assert intel.contact_page_fetch_failed is True
        assert intel.homepage_fetch_failed is True
        assert intel.emails is None
        assert intel.phones is None
        assert intel.contact_form_url is None
        assert intel.instagram_url is None


# ── Test 13: Page budget remains bounded ──────────────────────────────────────
def test_page_budget_remains_bounded():
    """ContactWorker never executes more than 3 HTTP page fetches per candidate."""
    worker = ContactWorker()
    fetched_urls = []

    def mock_fetch(url: str):
        fetched_urls.append(url)
        return (
            '<html><body><p>Page without contact info</p><a href="/about">About</a></body></html>',
            url,
            0.01,
        )

    with patch.object(worker, "_fetch", side_effect=mock_fetch):
        item = WebsiteIntel(
            pipeline_id="p-budget",
            website_reachable=True,
            final_url="https://site.com",
            contact_page="https://site.com/contact",
        )
        worker.process(item)
        assert len(fetched_urls) <= 3


# ── Test 14: 4-Channel qualification rules unchanged ──────────────────────────
def test_qualification_rules_unchanged():
    """Confirms 4-channel qualification logic (website, valid email, valid phone, valid instagram) is intact."""
    worker = QualificationWorker(required_channels=("website", "email", "phone", "instagram"))

    # Missing email -> rejected
    res_no_email = worker.process(
        EnrichedBusiness(
            pipeline_id="q1",
            business=BusinessCandidate(
                session_id="s1",
                provider="google_maps",
                pipeline_id="q1",
                name="Test Biz",
                website="https://testbiz.com",
                phone="+15551112222",
                instagram_url="https://instagram.com/testbiz",
            ),
            website_intel=WebsiteIntel(pipeline_id="q1", website_reachable=True, final_url="https://testbiz.com"),
            contact_intel=ContactIntel(pipeline_id="q1", phones=("+15551112222",), emails=None),
            instagram_intel=InstagramIntel(pipeline_id="q1", profile_reachable=True, followers=500),
        )
    )
    assert res_no_email.qualified is False
    assert any("email" in r for r in res_no_email.reasons)

    # All 4 valid -> qualified
    res_qualified = worker.process(
        EnrichedBusiness(
            pipeline_id="q2",
            business=BusinessCandidate(
                session_id="s1",
                provider="google_maps",
                pipeline_id="q2",
                name="Test Biz",
                website="https://testbiz.com",
                phone="+15551112222",
                instagram_url="https://instagram.com/testbiz",
            ),
            website_intel=WebsiteIntel(pipeline_id="q2", website_reachable=True, final_url="https://testbiz.com"),
            contact_intel=ContactIntel(pipeline_id="q2", phones=("+15551112222",), emails=("hello@testbiz.com",)),
            instagram_intel=InstagramIntel(pipeline_id="q2", profile_reachable=True, followers=500),
        )
    )
    assert res_qualified.qualified is True

    # Followers > 100k -> rejected (when evaluated by default rules)
    worker_default = QualificationWorker()
    res_over_limit = worker_default.process(
        EnrichedBusiness(
            pipeline_id="q3",
            business=BusinessCandidate(
                session_id="s1",
                provider="google_maps",
                pipeline_id="q3",
                name="Big Brand",
                website="https://bigbrand.com",
                phone="+15551112222",
                instagram_url="https://instagram.com/bigbrand",
            ),
            website_intel=WebsiteIntel(pipeline_id="q3", website_reachable=True, final_url="https://bigbrand.com"),
            contact_intel=ContactIntel(pipeline_id="q3", phones=("+15551112222",), emails=("hello@bigbrand.com",)),
            instagram_intel=InstagramIntel(pipeline_id="q3", profile_reachable=True, followers=150000),
        )
    )
    assert res_over_limit.qualified is False
    assert any("instagram_followers_over_limit" in r for r in res_over_limit.reasons)
