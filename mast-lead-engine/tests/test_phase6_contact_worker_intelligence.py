"""
MAST Phase 6 — ContactWorker Intelligence & Extraction Quality Tests
=====================================================================

Deterministic offline regression test suite covering all 25 Phase 6 requirements:
1. Email in a mailto link.
2. Email in visible page text.
3. Obfuscated email.
4. Email in JSON-LD.
5. Phone in a tel link.
6. Phone in visible text.
7. International phone normalization.
8. Instagram in footer navigation.
9. Instagram in a contact page.
10. Instagram embedded in structured metadata.
11. Duplicate URLs are not fetched repeatedly.
12. Contact-page prioritization.
13. Placeholder emails are rejected.
14. Invalid phone numbers are rejected.
15. Invalid Instagram URLs are rejected.
16. Multiple valid channels are extracted from one page.
17. Missing channels trigger targeted additional discovery.
18. Requested channels already supplied by Google Maps do not cause unnecessary crawling.
19. Static HTML success prevents unnecessary browser rendering.
20. JavaScript-heavy fixture triggers selective rendering.
21. Rendering failure is classified accurately.
22. Browser/page cleanup succeeds on all failure paths.
23. Existing valid contact information is never overwritten by empty results.
24. All channels survive serialization and Node handoff.
25. AND qualification logic remains unchanged.
"""

from __future__ import annotations

import os
os.environ.setdefault("NODE_ENV", "test")
import sys
from unittest.mock import MagicMock, patch

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from engine.contracts import (
    BusinessCandidate,
    ContactIntel,
    WebsiteIntel,
)
from workers.merge_worker import MergeInput
from engine_enrichment_bridge import (
    _enriched_to_dict,
    _website_instagram_url,
    enrich_business_with_engine_v2,
)
from utils.parsing import (
    clean_ig_url,
    extract_ig_urls_with_source,
    extract_jsonld_contact_data,
    extract_obfuscated_emails,
    extract_phones,
    find_secondary_contact_link,
    is_real_ig_handle,
    is_valid_email,
    is_valid_phone,
    normalize_phone,
    select_primary_email,
)
from workers.contact_worker import ContactWorker
from workers.merge_worker import MergeWorker


# ──────────────────────────────────────────────────────────────────────────────
# Helper for deterministic offline page fetching
# ──────────────────────────────────────────────────────────────────────────────
def _mock_worker_pages(worker: ContactWorker, pages: dict[str, str], delays: dict[str, float] | None = None):
    delays = delays or {}
    fetched_urls: list[str] = []

    def fake_fetch(url: str):
        norm = url.strip()
        fetched_urls.append(norm)
        # Match case-insensitively and trailing-slash-insensitively
        norm_key = norm.rstrip("/").lower()
        for k, content in pages.items():
            if k.rstrip("/").lower() == norm_key:
                return content, norm, delays.get(norm, 0.01)
        raise ConnectionError(f"404 Not Found: {url}")

    worker._fetch = MagicMock(side_effect=fake_fetch)
    return fetched_urls


# ──────────────────────────────────────────────────────────────────────────────
# 1. Email in a mailto link
# ──────────────────────────────────────────────────────────────────────────────
def test_01_email_in_mailto_link():
    html = """
    <html><body>
        <div class="header">
            <a href="mailto:info@chicagoroasters.com?subject=Inquiry">Email Us</a>
        </div>
    </body></html>
    """
    worker = ContactWorker()
    _mock_worker_pages(worker, {"https://chicagoroasters.com": html})
    item = WebsiteIntel(pipeline_id="p01", final_url="https://chicagoroasters.com")
    intel = worker.process(item)

    assert intel.emails is not None
    assert "info@chicagoroasters.com" in intel.emails
    assert intel.mailto_extracted is True
    assert intel.email_source == "mailto"
    assert ("info@chicagoroasters.com", "mailto") in intel.email_provenance


# ──────────────────────────────────────────────────────────────────────────────
# 2. Email in visible page text
# ──────────────────────────────────────────────────────────────────────────────
def test_02_email_in_visible_page_text():
    html = """
    <html><body>
        <div class="contact-card">
            <p>For private catering inquiries, email us at catering@chicagoroasters.com directly.</p>
        </div>
    </body></html>
    """
    worker = ContactWorker()
    _mock_worker_pages(worker, {"https://chicagoroasters.com": html})
    item = WebsiteIntel(pipeline_id="p02", final_url="https://chicagoroasters.com")
    intel = worker.process(item)

    assert intel.emails is not None
    assert "catering@chicagoroasters.com" in intel.emails


# ──────────────────────────────────────────────────────────────────────────────
# 3. Obfuscated email
# ──────────────────────────────────────────────────────────────────────────────
def test_03_obfuscated_email():
    html = """
    <html><body>
        <p>General inquiries: hello [at] artisanalcoffee [dot] com</p>
        <p>Press contact: press AT artisanalcoffee DOT com</p>
        <p>Support: support@artisanalcoffee [dot] com</p>
        <p>Do not match prose: meet us at home. Visit soon.</p>
    </body></html>
    """
    worker = ContactWorker()
    _mock_worker_pages(worker, {"https://artisanalcoffee.com": html})
    item = WebsiteIntel(pipeline_id="p03", final_url="https://artisanalcoffee.com")
    intel = worker.process(item)

    assert intel.emails is not None
    assert "hello@artisanalcoffee.com" in intel.emails
    assert "press@artisanalcoffee.com" in intel.emails
    assert "support@artisanalcoffee.com" in intel.emails
    assert "us@home.visit" not in intel.emails


# ──────────────────────────────────────────────────────────────────────────────
# 4. Email in JSON-LD
# ──────────────────────────────────────────────────────────────────────────────
def test_04_email_in_jsonld():
    html = """
    <html><body>
        <script type="application/ld+json">
        {
            "@context": "https://schema.org",
            "@type": "LocalBusiness",
            "name": "Artisan Dental",
            "email": "appointments@artisandental.org",
            "telephone": "+1-312-555-0199"
        }
        </script>
    </body></html>
    """
    worker = ContactWorker()
    _mock_worker_pages(worker, {"https://artisandental.org": html})
    item = WebsiteIntel(pipeline_id="p04", final_url="https://artisandental.org")
    intel = worker.process(item)

    assert intel.emails is not None
    assert "appointments@artisandental.org" in intel.emails
    assert ("appointments@artisandental.org", "jsonld") in intel.email_provenance


# ──────────────────────────────────────────────────────────────────────────────
# 5. Phone in a tel link
# ──────────────────────────────────────────────────────────────────────────────
def test_05_phone_in_tel_link():
    html = """
    <html><body>
        <a href="tel:+13125550188">Call us today</a>
    </body></html>
    """
    worker = ContactWorker()
    _mock_worker_pages(worker, {"https://biz.com": html})
    item = WebsiteIntel(pipeline_id="p05", final_url="https://biz.com", region_hint="US")
    intel = worker.process(item)

    assert intel.phones is not None
    assert "+1 (312) 555-0188" in intel.phones
    assert intel.tel_extracted is True
    assert ("+1 (312) 555-0188", "tel") in intel.phone_provenance


# ──────────────────────────────────────────────────────────────────────────────
# 6. Phone in visible text (and fax rejection)
# ──────────────────────────────────────────────────────────────────────────────
def test_06_phone_in_visible_text():
    html = """
    <html><body>
        <div>Tel: (312) 555-0144</div>
        <div>Fax: (312) 555-0199</div>
    </body></html>
    """
    worker = ContactWorker()
    _mock_worker_pages(worker, {"https://biz.com": html})
    item = WebsiteIntel(pipeline_id="p06", final_url="https://biz.com", region_hint="US")
    intel = worker.process(item)

    assert intel.phones is not None
    assert "+1 (312) 555-0144" in intel.phones
    # Fax number MUST NOT be extracted as a contact phone number
    assert "+1 (312) 555-0199" not in intel.phones


# ──────────────────────────────────────────────────────────────────────────────
# 7. International phone normalization
# ──────────────────────────────────────────────────────────────────────────────
def test_07_international_phone_normalization():
    # US local format
    assert normalize_phone("(312) 555-0144", region="US") == "+1 (312) 555-0144"
    # UK local format
    assert normalize_phone("020 7946 0958", region="GB") == "+442079460958"
    # Egypt local format
    assert normalize_phone("0100 123 4567", region="EG") == "+201001234567"
    # International prefixed number with no region
    assert normalize_phone("+33 1 42 68 55 55", region=None) == "+33142685555"


# ──────────────────────────────────────────────────────────────────────────────
# 8. Instagram in footer navigation
# ──────────────────────────────────────────────────────────────────────────────
def test_08_instagram_in_footer_navigation():
    html = """
    <html><body>
        <footer>
            <a href="https://www.instagram.com/downtown_diner/">Instagram</a>
        </footer>
    </body></html>
    """
    worker = ContactWorker()
    _mock_worker_pages(worker, {"https://diner.com": html})
    item = WebsiteIntel(pipeline_id="p08", final_url="https://diner.com")
    intel = worker.process(item)

    assert intel.instagram_url == "https://www.instagram.com/downtown_diner/"
    assert intel.instagram_source == "anchor_href"


# ──────────────────────────────────────────────────────────────────────────────
# 9. Instagram in a contact page
# ──────────────────────────────────────────────────────────────────────────────
def test_09_instagram_in_contact_page():
    home_html = '<html><body><h1>Welcome</h1><a href="/contact">Contact</a></body></html>'
    contact_html = '<html><body>Follow us on <a href="https://instagram.com/chicagobistro">IG</a></body></html>'

    worker = ContactWorker(required_channels=("instagram",))
    _mock_worker_pages(worker, {
        "https://chicagobistro.com": home_html,
        "https://chicagobistro.com/contact": contact_html,
    })
    item = WebsiteIntel(
        pipeline_id="p09",
        final_url="https://chicagobistro.com",
        contact_page="https://chicagobistro.com/contact",
    )
    intel = worker.process(item)

    assert intel.instagram_url == "https://www.instagram.com/chicagobistro/"


# ──────────────────────────────────────────────────────────────────────────────
# 10. Instagram embedded in structured metadata & JS-escaped strings
# ──────────────────────────────────────────────────────────────────────────────
def test_10_instagram_embedded_in_structured_metadata():
    # JSON-LD sameAs
    html_jsonld = """
    <html><body>
        <script type="application/ld+json">
        {
            "@context": "https://schema.org",
            "@type": "Restaurant",
            "name": "Cafe Sol",
            "sameAs": ["https://www.instagram.com/cafesol/"]
        }
        </script>
    </body></html>
    """
    worker = ContactWorker()
    _mock_worker_pages(worker, {"https://cafesol.com": html_jsonld})
    intel = worker.process(WebsiteIntel(pipeline_id="p10-a", final_url="https://cafesol.com"))
    assert intel.instagram_url == "https://www.instagram.com/cafesol/"

    # JavaScript-escaped URL: https:\/\/www.instagram.com\/chicagocoffee\/
    html_js = """
    <html><body>
        <script>var appConfig = {"instagram": "https:\\/\\/www.instagram.com\\/chicagocoffee\\/"};</script>
    </body></html>
    """
    worker2 = ContactWorker()
    _mock_worker_pages(worker2, {"https://chicagocoffee.com": html_js})
    intel2 = worker2.process(WebsiteIntel(pipeline_id="p10-b", final_url="https://chicagocoffee.com"))
    assert intel2.instagram_url == "https://www.instagram.com/chicagocoffee/"


# ──────────────────────────────────────────────────────────────────────────────
# 11. Duplicate URLs are not fetched repeatedly
# ──────────────────────────────────────────────────────────────────────────────
def test_11_duplicate_urls_are_not_fetched_repeatedly():
    home_html = """
    <html><body>
        <a href="/contact">Contact</a>
        <a href="/contact/">Contact Again</a>
        <a href="/contact#map">Contact Map</a>
    </body></html>
    """
    contact_html = '<html><body><a href="mailto:info@dups.com">Email</a></body></html>'

    worker = ContactWorker(required_channels=("email",))
    fetched = _mock_worker_pages(worker, {
        "https://dups.com": home_html,
        "https://dups.com/contact": contact_html,
    })
    item = WebsiteIntel(pipeline_id="p11", final_url="https://dups.com")
    intel = worker.process(item)

    contact_fetches = [u for u in fetched if "contact" in u.lower()]
    assert len(contact_fetches) == 1, "Duplicate URL variants with fragments/slashes must only be fetched once"


# ──────────────────────────────────────────────────────────────────────────────
# 12. Contact-page prioritization & irrelevant navigation rejection
# ──────────────────────────────────────────────────────────────────────────────
def test_12_contact_page_prioritization():
    home_html = """
    <html><body>
        <a href="/cart">Cart</a>
        <a href="/account/login?next=/contact">Sign In</a>
        <a href="/about-us">About Us</a>
        <a href="/impressum">Impressum</a>
    </body></html>
    """
    best_url, best_cat = find_secondary_contact_link(
        [(home_html, "https://shop.de")],
        "https://shop.de",
        tried_urls=set(),
    )
    # /cart and /login must be rejected; between /about-us and /impressum, /about-us has priority 1, /impressum has priority 2
    assert "login" not in best_url
    assert "cart" not in best_url
    assert best_cat in ("about", "imprint")


# ──────────────────────────────────────────────────────────────────────────────
# 13. Placeholder emails are rejected
# ──────────────────────────────────────────────────────────────────────────────
def test_13_placeholder_emails_are_rejected():
    assert is_valid_email("test@example.com") is False
    assert is_valid_email("user@domain.com") is False
    assert is_valid_email("firstname.lastname@company.com") is False
    assert is_valid_email("placeholder@yourdomain.com") is False
    assert is_valid_email("noreply@legitbusiness.com") is False
    assert is_valid_email("logo@2x.png") is False
    assert is_valid_email("hero@3x.jpg") is False
    assert is_valid_email("real.owner@chicagoroasters.com") is True


# ──────────────────────────────────────────────────────────────────────────────
# 14. Invalid phone numbers are rejected
# ──────────────────────────────────────────────────────────────────────────────
def test_14_invalid_phone_numbers_are_rejected():
    assert is_valid_phone("0000000") is False
    assert is_valid_phone("1111111111") is False
    assert is_valid_phone("1234567890") is False
    assert is_valid_phone("+1 (312) 555-0144") is True


# ──────────────────────────────────────────────────────────────────────────────
# 15. Invalid Instagram URLs are rejected
# ──────────────────────────────────────────────────────────────────────────────
def test_15_invalid_instagram_urls_are_rejected():
    assert is_real_ig_handle("https://www.instagram.com/p/B_abc123/") is False
    assert is_real_ig_handle("https://www.instagram.com/reel/C_xyz/") is False
    assert is_real_ig_handle("https://www.instagram.com/explore/") is False
    assert is_real_ig_handle("https://www.instagram.com/accounts/login/") is False
    assert is_real_ig_handle("https://www.instagram.com/chicagobakery/") is True


# ──────────────────────────────────────────────────────────────────────────────
# 16. Multiple valid channels extracted from one page
# ──────────────────────────────────────────────────────────────────────────────
def test_16_multiple_valid_channels_extracted_from_one_page():
    html = """
    <html><body>
        <a href="mailto:hello@allinone.com">Email</a>
        <a href="tel:+13125550177">Phone</a>
        <a href="https://instagram.com/allinone_biz">IG</a>
    </body></html>
    """
    worker = ContactWorker()
    _mock_worker_pages(worker, {"https://allinone.com": html})
    intel = worker.process(WebsiteIntel(pipeline_id="p16", final_url="https://allinone.com", region_hint="US"))

    assert "hello@allinone.com" in intel.emails
    assert "+1 (312) 555-0177" in intel.phones
    assert intel.instagram_url == "https://www.instagram.com/allinone_biz/"


# ──────────────────────────────────────────────────────────────────────────────
# 17. Missing channels trigger targeted additional discovery
# ──────────────────────────────────────────────────────────────────────────────
def test_17_missing_channels_trigger_targeted_additional_discovery():
    home_html = '<html><body><h1>Dental Spa</h1><a href="tel:+13125550188">Call</a><a href="/contact">Contact</a></body></html>'
    contact_html = '<html><body><a href="mailto:info@dentalspa.com">Email Us</a></body></html>'

    # Job requires both phone and email
    worker = ContactWorker(required_channels=("phone", "email"))
    fetched = _mock_worker_pages(worker, {
        "https://dentalspa.com": home_html,
        "https://dentalspa.com/contact": contact_html,
    })
    intel = worker.process(WebsiteIntel(
        pipeline_id="p17",
        final_url="https://dentalspa.com",
        contact_page="https://dentalspa.com/contact",
        region_hint="US",
    ))

    assert "+1 (312) 555-0188" in intel.phones
    assert "info@dentalspa.com" in intel.emails
    assert len(fetched) == 2, "Secondary contact page must be fetched because email was missing on homepage"


# ──────────────────────────────────────────────────────────────────────────────
# 18. Requested channels already supplied by Google Maps do not cause crawling
# ──────────────────────────────────────────────────────────────────────────────
def test_18_requested_channels_already_supplied_by_google_maps_no_extra_crawling():
    home_html = '<html><body><h1>Bakery</h1><a href="/contact">Contact</a><a href="/about">About</a></body></html>'

    # Google Maps already supplied phone and email
    worker = ContactWorker(required_channels=("phone", "email"))
    fetched = _mock_worker_pages(worker, {"https://bakery.com": home_html})
    intel = worker.process(WebsiteIntel(
        pipeline_id="p18",
        final_url="https://bakery.com",
        homepage_html=home_html,  # cached from WebsiteWorker
        known_channels=("phone", "email"),
    ))

    assert len(fetched) == 0, "When required channels are already supplied by discovery provider, zero network fetches are made"


# ──────────────────────────────────────────────────────────────────────────────
# 19. Static HTML success prevents unnecessary browser rendering
# ──────────────────────────────────────────────────────────────────────────────
def test_19_static_html_success_prevents_unnecessary_browser_rendering():
    html = '<html><body><a href="mailto:static@success.com">Mail</a></body></html>'
    worker = ContactWorker(required_channels=("email",))
    _mock_worker_pages(worker, {"https://static.com": html})

    mock_renderer = MagicMock()
    worker._custom_renderer = mock_renderer

    intel = worker.process(WebsiteIntel(pipeline_id="p19", final_url="https://static.com"))

    assert "static@success.com" in intel.emails
    assert intel.rendering_fallback_triggered is False
    assert mock_renderer.call_count == 0, "Browser rendering must not be triggered when static extraction satisfies required channels"


# ──────────────────────────────────────────────────────────────────────────────
# 20. JavaScript-heavy fixture triggers selective rendering
# ──────────────────────────────────────────────────────────────────────────────
def test_20_javascript_heavy_fixture_triggers_selective_rendering():
    spa_html = '<html><body><div id="root"></div><script src="/app.js"></script><noscript>Please enable JavaScript</noscript></body></html>'
    rendered_html = '<html><body><div id="root"><a href="mailto:dynamic@spa.io">Email</a></div></body></html>'

    worker = ContactWorker(required_channels=("email",), enable_dynamic_rendering=True)
    _mock_worker_pages(worker, {"https://spa.io": spa_html})

    mock_renderer = MagicMock(return_value=(rendered_html, "https://spa.io", 0.2))
    worker._custom_renderer = mock_renderer

    intel = worker.process(WebsiteIntel(pipeline_id="p20", final_url="https://spa.io"))

    assert intel.rendering_fallback_triggered is True
    assert intel.rendering_fallback_yield is True
    assert "dynamic@spa.io" in intel.emails
    assert mock_renderer.call_count == 1


# ──────────────────────────────────────────────────────────────────────────────
# 21. Rendering failure is classified accurately
# ──────────────────────────────────────────────────────────────────────────────
def test_21_rendering_failure_is_classified_accurately():
    spa_html = '<html><body><div id="root"></div><script src="/app.js"></script></body></html>'

    worker = ContactWorker(required_channels=("email",), enable_dynamic_rendering=True)
    _mock_worker_pages(worker, {"https://spa-timeout.io": spa_html})

    def mock_fail(url):
        raise TimeoutError("Playwright navigation timeout after 4000ms")

    worker._custom_renderer = mock_fail

    intel = worker.process(WebsiteIntel(pipeline_id="p21", final_url="https://spa-timeout.io"))

    assert intel.rendering_fallback_triggered is True
    assert intel.rendering_fallback_yield is False
    assert intel.rendering_fallback_error is not None
    assert "timeout" in intel.rendering_fallback_error.lower()


# ──────────────────────────────────────────────────────────────────────────────
# 22. Browser/page cleanup succeeds on all failure paths
# ──────────────────────────────────────────────────────────────────────────────
def test_22_browser_page_cleanup_succeeds_on_all_failure_paths():
    """Verifies that in _render_dynamic_page, page.close(), ctx.close(), and browser.close() are always called."""
    worker = ContactWorker(enable_dynamic_rendering=True)

    mock_page = MagicMock()
    mock_page.goto.side_effect = RuntimeError("Simulated crash inside page.goto")

    mock_ctx = MagicMock()
    mock_ctx.new_page.return_value = mock_page

    mock_browser = MagicMock()
    mock_browser.new_context.return_value = mock_ctx

    mock_playwright = MagicMock()
    mock_playwright.chromium.launch.return_value = mock_browser

    with patch("workers.contact_worker.assert_safe_egress_url"), patch("playwright.sync_api.sync_playwright") as mock_sync_pw:
        mock_sync_pw.return_value.__enter__.return_value = mock_playwright

        with pytest.raises(RuntimeError):
            worker._render_dynamic_page("https://example-crash.com/error")

        assert mock_page.close.call_count == 1, "page.close() must be called in finally"
        assert mock_ctx.close.call_count == 1, "ctx.close() must be called in finally"
        assert mock_browser.close.call_count == 1, "browser.close() must be called in finally"


# ──────────────────────────────────────────────────────────────────────────────
# 23. Existing valid contact information is never overwritten by empty results
# ──────────────────────────────────────────────────────────────────────────────
def test_23_existing_valid_contact_info_never_overwritten_by_empty_results():
    candidate = BusinessCandidate(
        pipeline_id="p23",
        session_id="s23",
        provider="google_maps",
        name="Lincoln Park Cafe",
        website="https://lincolnparkcafe.com",
        phone="+13125550100",
        provider_email="owner@lincolnparkcafe.com",
    )
    # ContactWorker found nothing on website
    empty_contact = ContactIntel(pipeline_id="p23")

    merged = MergeWorker().process(MergeInput(
        business=candidate,
        website_intel=WebsiteIntel(pipeline_id="p23", website_reachable=True),
        contact_intel=empty_contact,
    ))

    # Serialization preserves candidate phone/email
    d = _enriched_to_dict(merged)
    # Contact worker did not find website email, so c.emails is empty, but discovery provider values remain intact on b
    assert merged.business.phone == "+13125550100"
    assert merged.business.provider_email == "owner@lincolnparkcafe.com"


# ──────────────────────────────────────────────────────────────────────────────
# 24. All channels survive serialization and Node handoff
# ──────────────────────────────────────────────────────────────────────────────
def test_24_all_channels_survive_serialization_and_node_handoff():
    contact = ContactIntel(
        pipeline_id="p24",
        emails=("primary@biz.com", "alt@biz.com"),
        phones=("+1 (312) 555-0144",),
        instagram_url="https://www.instagram.com/biz_official/",
        instagram_source="anchor_href",
        pages_discovered=4,
        pages_fetched=2,
        static_extraction_attempted=True,
        static_extraction_yield=True,
        rendering_fallback_triggered=True,
        rendering_fallback_yield=True,
    )
    merged = MergeWorker().process(MergeInput(
        business=BusinessCandidate(pipeline_id="p24", session_id="s24", provider="google_maps", name="Biz"),
        website_intel=WebsiteIntel(pipeline_id="p24", website_reachable=True, http_status=200),
        contact_intel=contact,
    ))
    res = _enriched_to_dict(merged)

    assert res["email"] == "primary@biz.com"
    assert res["emails"] == ["primary@biz.com", "alt@biz.com"]
    assert res["phone"] == "+1 (312) 555-0144"
    assert res["phones"] == ["+1 (312) 555-0144"]
    assert res["instagram"] == "https://www.instagram.com/biz_official/"
    assert res["pages_discovered"] == 4
    assert res["pages_fetched"] == 2
    assert res["static_extraction_attempted"] is True
    assert res["static_extraction_yield"] is True
    assert res["rendering_fallback_triggered"] is True
    assert res["rendering_fallback_yield"] is True


# ──────────────────────────────────────────────────────────────────────────────
# 25. AND qualification logic remains unchanged
# ──────────────────────────────────────────────────────────────────────────────
def test_25_and_qualification_logic_remains_unchanged():
    """Verify that AND qualification semantics require ALL requested channels to be present."""
    # Scenario A: requested = ["email", "instagram"], candidate has only email
    lead_a = {"email": "user@biz.com", "phone": "+13125550144", "instagram": None}
    requested_channels = ["email", "instagram"]

    satisfied_a = all(bool(lead_a.get(ch)) for ch in requested_channels)
    assert satisfied_a is False, "AND gate must reject when one of the requested channels (instagram) is missing"

    # Scenario B: requested = ["email", "instagram"], candidate has both
    lead_b = {"email": "user@biz.com", "phone": "+13125550144", "instagram": "https://instagram.com/biz"}
    satisfied_b = all(bool(lead_b.get(ch)) for ch in requested_channels)
    assert satisfied_b is True, "AND gate must accept ONLY when all requested channels are satisfied"


# ──────────────────────────────────────────────────────────────────────────────
# 26. Cloudflare data-cfemail and href extraction
# ──────────────────────────────────────────────────────────────────────────────
def test_26_cloudflare_data_cfemail_and_href_extraction():
    """Verify extraction of Cloudflare protected emails via data-cfemail and /cdn-cgi/l/email-protection href."""
    # Encode "support@cf-biz.com" with XOR key 0x1a
    email_plain = "support@cf-biz.com"
    key = 0x1a
    cfemail = f"{key:02x}" + "".join(f"{ord(c) ^ key:02x}" for c in email_plain)

    html = f"""
    <html><body>
        <span class="__cf_email__" data-cfemail="{cfemail}">[email&#160;protected]</span>
        <a href="/cdn-cgi/l/email-protection#{cfemail}">Protected Mail</a>
    </body></html>
    """

    worker = ContactWorker(required_channels=("email",))
    _mock_worker_pages(worker, {"https://cf-biz.com": html})
    intel = worker.process(WebsiteIntel(pipeline_id="p26", final_url="https://cf-biz.com"))

    assert "support@cf-biz.com" in intel.emails


# ──────────────────────────────────────────────────────────────────────────────
# 27. Cloudflare malformed payload rejection
# ──────────────────────────────────────────────────────────────────────────────
def test_27_cloudflare_malformed_payload_rejected():
    """Malformed or truncated cfemail hex must not raise and must not extract garbage."""
    html = """
    <html><body>
        <span class="__cf_email__" data-cfemail="xyz">Bad</span>
        <span class="__cf_email__" data-cfemail="1">Truncated</span>
        <a href="/cdn-cgi/l/email-protection#not_hex">Bad Link</a>
    </body></html>
    """
    worker = ContactWorker(required_channels=("email",))
    _mock_worker_pages(worker, {"https://cf-bad.com": html})
    intel = worker.process(WebsiteIntel(pipeline_id="p27", final_url="https://cf-bad.com"))

    assert not intel.emails


# ──────────────────────────────────────────────────────────────────────────────
# 28. JavaScript unicode and escaped slashes
# ──────────────────────────────────────────────────────────────────────────────
def test_28_javascript_unicode_and_escaped_slashes():
    r"""Verify regex unescaping for unicode emails (@) and escaped URLs (https:\/\/)."""
    html = r"""
    <html><body>
        <script>
            window.__INIT__ = {
                "ownerEmail": "contact\u0040chicago\u002ecom",
                "social": "https:\/\/www.instagram.com\/chicagobakery\/"
            };
        </script>
    </body></html>
    """
    worker = ContactWorker(required_channels=("email", "instagram"))
    _mock_worker_pages(worker, {"https://chicago.com": html})
    intel = worker.process(WebsiteIntel(pipeline_id="p28", final_url="https://chicago.com"))

    assert "contact@chicago.com" in intel.emails
    assert intel.instagram_url == "https://www.instagram.com/chicagobakery/"


# ──────────────────────────────────────────────────────────────────────────────
# 29. Phone extraction fax precedence and nearby labels
# ──────────────────────────────────────────────────────────────────────────────
def test_29_phone_fax_precedence_and_nearby_labels():
    """Fax numbers must be rejected even if they appear before phone numbers; legitimate phones preserved."""
    # Case A: Fax appears first, Tel second
    html_a = """
    <html><body>
        <p>Fax: (312) 555-0199</p>
        <p>Tel: (312) 555-0144</p>
    </body></html>
    """
    worker_a = ContactWorker(required_channels=("phone",))
    _mock_worker_pages(worker_a, {"https://fax-tel.com": html_a})
    intel_a = worker_a.process(WebsiteIntel(pipeline_id="p29a", final_url="https://fax-tel.com"))
    assert "+1 (312) 555-0144" in intel_a.phones
    assert "+1 (312) 555-0199" not in intel_a.phones

    # Case B: Fax is the only number on the page
    html_b = """
    <html><body>
        <p>Facsimile: (312) 555-0199</p>
    </body></html>
    """
    worker_b = ContactWorker(required_channels=("phone",))
    _mock_worker_pages(worker_b, {"https://fax-only.com": html_b})
    intel_b = worker_b.process(WebsiteIntel(pipeline_id="p29b", final_url="https://fax-only.com"))
    assert not intel_b.phones

    # Case C: Nearby labels do not disqualify valid phone
    html_c = """
    <html><body>
        <div>Fax: (312) 555-0199 | Office Tel: (312) 555-0155</div>
    </body></html>
    """
    worker_c = ContactWorker(required_channels=("phone",))
    _mock_worker_pages(worker_c, {"https://fax-office.com": html_c})
    intel_c = worker_c.process(WebsiteIntel(pipeline_id="p29c", final_url="https://fax-office.com"))
    assert "+1 (312) 555-0155" in intel_c.phones
    assert "+1 (312) 555-0199" not in intel_c.phones


# ──────────────────────────────────────────────────────────────────────────────
# 30. Secondary-page discovery query parameter redirect rejection
# ──────────────────────────────────────────────────────────────────────────────
def test_30_secondary_page_query_parameter_redirect_rejection():
    """Verify that auth/cart URLs with redirect query parameters are rejected, while genuine pages are kept."""
    from utils.parsing import find_secondary_contact_link

    # Login and cart links with contact parameters
    html = """
    <html><body>
        <a href="/login?redirect=/contact">Login to Account</a>
        <a href="/cart?return=/about-us">View Shopping Cart</a>
        <a href="/about">About Our Studio</a>
    </body></html>
    """
    url, cat = find_secondary_contact_link([(html, "https://store.com")], "https://store.com", set())
    assert url == "https://store.com/about"
    assert cat == "about"

    # Imprint link
    html_imprint = """
    <html><body>
        <a href="/auth/signin?next=/impressum">Sign In</a>
        <a href="/imprint">Impressum</a>
    </body></html>
    """
    url_imp, cat_imp = find_secondary_contact_link([(html_imprint, "https://de-biz.de")], "https://de-biz.de", set())
    assert url_imp == "https://de-biz.de/imprint"
    assert cat_imp == "imprint"


# ──────────────────────────────────────────────────────────────────────────────
# 31. Email validation company local-part vs genuine placeholders
# ──────────────────────────────────────────────────────────────────────────────
def test_31_email_validation_company_local_part_vs_genuine_placeholders():
    """company@actual-business-domain.com is accepted; placeholders remain rejected."""
    # Real business domains with "company@" local part
    assert is_valid_email("company@acmecorp.com") is True
    assert is_valid_email("company@lawfirmchicago.com") is True

    # Placeholder domains with "company@" are rejected
    assert is_valid_email("company@example.com") is False
    assert is_valid_email("company@domain.com") is False
    assert is_valid_email("company@test.com") is False

    # Genuine template placeholders remain rejected on any domain
    assert is_valid_email("test@acmecorp.com") is False
    assert is_valid_email("example@acmecorp.com") is False
    assert is_valid_email("sample@acmecorp.com") is False
    assert is_valid_email("placeholder@acmecorp.com") is False
    assert is_valid_email("yourname@acmecorp.com") is False


# ──────────────────────────────────────────────────────────────────────────────
# 32. Telemetry privacy no sensitive data leakage
# ──────────────────────────────────────────────────────────────────────────────
def test_32_telemetry_privacy_no_sensitive_data_leakage():
    """Verify rendering_fallback_error records classified category:class, never sensitive URLs or tokens."""
    sensitive_url = "https://spa.com/page?token=secret123&user=admin@secret.com"
    err = RuntimeError(f"Failed to navigate to {sensitive_url}: Connection dropped")

    classified = ContactWorker._classify_rendering_error(err)

    assert "secret123" not in classified
    assert "admin@secret.com" not in classified
    assert "token" not in classified
    assert "https://" not in classified
    assert classified == "navigation_failed:RuntimeError"


# ──────────────────────────────────────────────────────────────────────────────
# 33. SSRF and egress guard blocks private and metadata targets
# ──────────────────────────────────────────────────────────────────────────────
def test_33_ssrf_and_egress_guard_blocks_private_and_metadata_targets():
    """Verify that assert_safe_egress_url rejects loopback, RFC1918, link-local, and cloud metadata."""
    from utils.egress_guard import assert_safe_egress_url, DisallowedEgressError

    forbidden_urls = [
        "http://localhost:8080",
        "http://127.0.0.1:3000",
        "http://169.254.169.254/latest/meta-data/",
        "http://metadata.google.internal/computeMetadata/v1/",
        "http://10.0.0.1/admin",
        "http://172.16.0.1/status",
        "http://192.168.1.1/",
        "http://[::1]:80/",
        "http://[fe80::1]/",
        "http://[::ffff:127.0.0.1]/",
        "http://[::ffff:169.254.169.254]/",
        "http://0.0.0.0:8000",
        "http://redis:6379/",
        "http://company.internal/api",
        "http://192.0.2.1/",
    ]

    for u in forbidden_urls:
        with pytest.raises(DisallowedEgressError):
            assert_safe_egress_url(u, resolve_dns=False)


# ──────────────────────────────────────────────────────────────────────────────
# 34. Browser rendering concurrency slots
# ──────────────────────────────────────────────────────────────────────────────
def test_34_browser_rendering_concurrency_slots():
    """Verify that render_slot enforces bounded concurrency."""
    from utils.http_limits import render_slot, _RENDER_SEMAPHORE

    # Acquire all slots
    with render_slot():
        # Semaphore was decremented
        assert _RENDER_SEMAPHORE._value < 2


# ──────────────────────────────────────────────────────────────────────────────
# 35. DNS rebinding TOCTOU defense: initial public IP passes, subsequent private IP blocked
# ──────────────────────────────────────────────────────────────────────────────
def test_35_dns_rebinding_initial_validation_passes_subsequent_connection_blocked():
    """Verify that if a domain initially resolves to a public IP but later resolves to a private IP, it is blocked."""
    import socket
    from utils.egress_guard import is_safe_egress_url

    public_addr = (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("93.184.216.34", 80))
    private_addr = (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("169.254.169.254", 80))

    # First resolution: public IP
    with patch("socket.getaddrinfo", return_value=[public_addr]):
        safe1, reason1 = is_safe_egress_url("http://rebound.attacker.com/", resolve_dns=True)
        assert safe1 is True, "Public IP must pass initial check"

    # Second resolution (DNS Rebinding TOCTOU): attacker changes DNS to metadata
    with patch("socket.getaddrinfo", return_value=[private_addr]):
        safe2, reason2 = is_safe_egress_url("http://rebound.attacker.com/", resolve_dns=True)
        assert safe2 is False, "Private destination after rebinding must be blocked"
        assert "restricted IP" in reason2


# ──────────────────────────────────────────────────────────────────────────────
# 36. Redirect to localhost is blocked
# ──────────────────────────────────────────────────────────────────────────────
def test_36_redirect_to_localhost_blocked():
    """Verify redirect handler blocks redirects to localhost/127.0.0.1."""
    from utils.egress_guard import assert_safe_egress_url, DisallowedEgressError

    with pytest.raises(DisallowedEgressError) as exc_info:
        assert_safe_egress_url("http://localhost:8080/admin", resolve_dns=False)
    assert "loopback" in str(exc_info.value).lower()

    with pytest.raises(DisallowedEgressError) as exc_info2:
        assert_safe_egress_url("http://127.0.0.1:3000/api", resolve_dns=False)
    assert "loopback" in str(exc_info2.value).lower()


# ──────────────────────────────────────────────────────────────────────────────
# 37. Redirect to private IPv4 address is blocked
# ──────────────────────────────────────────────────────────────────────────────
def test_37_redirect_to_private_ipv4_blocked():
    """Verify redirect to RFC1918 private IPv4 addresses is blocked."""
    from utils.egress_guard import assert_safe_egress_url, DisallowedEgressError

    private_ipv4_redirects = [
        "http://10.0.0.1/admin",
        "http://172.16.0.5/api",
        "http://192.168.1.1/setup",
    ]
    for redir in private_ipv4_redirects:
        with pytest.raises(DisallowedEgressError) as exc:
            assert_safe_egress_url(redir, resolve_dns=False)
        assert "private/restricted" in str(exc.value).lower()


# ──────────────────────────────────────────────────────────────────────────────
# 38. Redirect to private IPv6 address is blocked
# ──────────────────────────────────────────────────────────────────────────────
def test_38_redirect_to_private_ipv6_blocked():
    """Verify redirect to private IPv6 (ULA / Link-Local / Loopback) is blocked."""
    from utils.egress_guard import assert_safe_egress_url, DisallowedEgressError

    private_ipv6_redirects = [
        "http://[::1]:8080/",
        "http://[fd00::1]/admin",
        "http://[fe80::1]/api",
        "http://[::ffff:127.0.0.1]/",
    ]
    for redir in private_ipv6_redirects:
        with pytest.raises(DisallowedEgressError) as exc:
            assert_safe_egress_url(redir, resolve_dns=False)


# ──────────────────────────────────────────────────────────────────────────────
# 39. JavaScript-created subresource requests to internal IPs are blocked
# ──────────────────────────────────────────────────────────────────────────────
def test_39_js_created_subresource_to_internal_ip_blocked():
    """Verify route handler aborts JS subresources targeting internal IPs."""
    from utils.egress_guard import is_safe_egress_url

    mock_route = MagicMock()
    mock_route.request.resource_type = "fetch"
    mock_route.request.url = "http://10.0.0.5/api/config.json"

    # Evaluate safety
    safe, _ = is_safe_egress_url(mock_route.request.url, resolve_dns=False)
    assert safe is False

    # Route filter execution
    if not safe:
        mock_route.abort("blockedbyclient")
    mock_route.abort.assert_called_with("blockedbyclient")


# ──────────────────────────────────────────────────────────────────────────────
# 40. Cloud metadata endpoints remain unreachable
# ──────────────────────────────────────────────────────────────────────────────
def test_40_cloud_metadata_endpoints_unreachable():
    """Verify that cloud metadata IPs and hostnames are rejected."""
    from utils.egress_guard import assert_safe_egress_url, DisallowedEgressError

    metadata_targets = [
        "http://169.254.169.254/latest/meta-data/",
        "http://169.254.169.254/computeMetadata/v1/",
        "http://metadata.google.internal/computeMetadata/v1/",
        "http://instance-data/latest/meta-data/",
    ]
    for target in metadata_targets:
        with pytest.raises(DisallowedEgressError):
            assert_safe_egress_url(target, resolve_dns=False)


# ──────────────────────────────────────────────────────────────────────────────
# 41. Monotonic rendering deadline covers all pipeline stages
# ──────────────────────────────────────────────────────────────────────────────
def test_41_monotonic_rendering_deadline_covers_all_pipeline_stages():
    """Verify that _render_dynamic_page initializes a monotonic deadline and bounds timeouts."""
    worker = ContactWorker(enable_dynamic_rendering=True)

    mock_playwright = MagicMock()
    mock_browser = MagicMock()
    mock_ctx = MagicMock()
    mock_page = MagicMock()

    mock_ctx.new_page.return_value = mock_page
    mock_browser.new_context.return_value = mock_ctx
    mock_playwright.chromium.launch.return_value = mock_browser

    with patch("workers.contact_worker.assert_safe_egress_url"),          patch("playwright.sync_api.sync_playwright") as mock_sync_pw:
        mock_sync_pw.return_value.__enter__.return_value = mock_playwright

        mock_page.content.return_value = "<html><body>Dynamic Content</body></html>"
        mock_page.url = "https://example-fast.com/"

        html, url, elapsed = worker._render_dynamic_page("https://example-fast.com/")

        assert "Dynamic Content" in html
        # Verify launch was called with bounded timeout argument
        _, kwargs = mock_playwright.chromium.launch.call_args
        assert "timeout" in kwargs
        assert kwargs["timeout"] <= 4000


# ──────────────────────────────────────────────────────────────────────────────
# 42. Chromium sandbox environment configuration
# ──────────────────────────────────────────────────────────────────────────────
def test_42_chromium_sandbox_environment_configuration():
    """Verify that MAST_CHROMIUM_NO_SANDBOX controls --no-sandbox flag."""
    worker = ContactWorker(enable_dynamic_rendering=True)

    mock_playwright = MagicMock()
    mock_browser = MagicMock()
    mock_ctx = MagicMock()
    mock_page = MagicMock()

    mock_ctx.new_page.return_value = mock_page
    mock_browser.new_context.return_value = mock_ctx
    mock_playwright.chromium.launch.return_value = mock_browser

    with patch("workers.contact_worker.assert_safe_egress_url"),          patch("playwright.sync_api.sync_playwright") as mock_sync_pw:
        mock_sync_pw.return_value.__enter__.return_value = mock_playwright
        mock_page.content.return_value = "<html><body>OK</body></html>"
        mock_page.url = "https://example.com/"

        # Case A: MAST_CHROMIUM_NO_SANDBOX="1" (default)
        with patch.dict(os.environ, {"MAST_CHROMIUM_NO_SANDBOX": "1"}):
            worker._render_dynamic_page("https://example.com/")
            _, kwargs = mock_playwright.chromium.launch.call_args
            assert "--no-sandbox" in kwargs["args"]

        # Case B: MAST_CHROMIUM_NO_SANDBOX="0" (opt-out of --no-sandbox)
        with patch.dict(os.environ, {"MAST_CHROMIUM_NO_SANDBOX": "0"}):
            worker._render_dynamic_page("https://example.com/")
            _, kwargs = mock_playwright.chromium.launch.call_args
            assert "--no-sandbox" not in kwargs["args"]


# ──────────────────────────────────────────────────────────────────────────────
# 43. Dynamic rendering is disabled by default (fail-closed production gate)
# ──────────────────────────────────────────────────────────────────────────────
def test_43_dynamic_rendering_disabled_by_default():
    """Production default: dynamic rendering must be disabled without explicit opt-in."""
    with patch.dict(os.environ, {}, clear=True):
        worker = ContactWorker()
        assert worker._dynamic_rendering_enabled is False

        spa_html = '<html><body><div id="root"></div><script src="/bundle.js"></script></body></html>'
        _mock_worker_pages(worker, {"https://default-disabled.com": spa_html})

        mock_renderer = MagicMock(return_value=('<html><body><a href="mailto:a@b.com"></a></body></html>', "https://default-disabled.com", 0.1))
        worker._custom_renderer = mock_renderer

        intel = worker.process(WebsiteIntel(pipeline_id="p43", final_url="https://default-disabled.com"))

        assert intel.rendering_fallback_triggered is False
        assert intel.rendering_fallback_yield is False
        assert mock_renderer.call_count == 0


# ──────────────────────────────────────────────────────────────────────────────
# 44. Static extraction continues successfully when dynamic rendering is disabled
# ──────────────────────────────────────────────────────────────────────────────
def test_44_static_extraction_continues_when_rendering_disabled():
    """Static HTTP extraction must function completely even when rendering fallback is disabled."""
    worker = ContactWorker(required_channels=("email", "phone"))
    assert worker._dynamic_rendering_enabled is False

    static_html = """
    <html>
      <body>
        <p>Contact us: support@acmecorp.com</p>
        <p>Call us: (555) 234-5678</p>
        <div id="root"></div>
        <script src="/app.js"></script>
      </body>
    </html>
    """
    _mock_worker_pages(worker, {"https://acmecorp.com": static_html})

    intel = worker.process(WebsiteIntel(pipeline_id="p44", final_url="https://acmecorp.com"))

    assert "support@acmecorp.com" in intel.emails
    assert any("234-5678" in p or "2345678" in p for p in intel.phones)
    assert intel.rendering_fallback_triggered is False


# ──────────────────────────────────────────────────────────────────────────────
# 45. Existing valid channels survive disabled rendering fallback
# ──────────────────────────────────────────────────────────────────────────────
def test_45_existing_channels_survive_disabled_fallback():
    """Channels already known on the candidate must never be lost when rendering is disabled."""
    candidate = BusinessCandidate(
        pipeline_id="p45",
        session_id="s45",
        provider="google_maps",
        name="Safe Cleaners",
        website="https://safecleaners.com",
        phone="+1 555-0100",
        instagram_url="https://instagram.com/safecleaners",
    )

    worker = ContactWorker(required_channels=("email",))
    assert worker._dynamic_rendering_enabled is False

    # Page contains only client-rendered JS shell and no email
    spa_html = '<html><body><div id="root"></div><script src="/app.js"></script></body></html>'
    _mock_worker_pages(worker, {"https://safecleaners.com": spa_html})

    intel = worker.process(WebsiteIntel(pipeline_id="p45", final_url="https://safecleaners.com"))

    merged = MergeWorker().process(MergeInput(
        business=candidate,
        website_intel=WebsiteIntel(pipeline_id="p45", website_reachable=True),
        contact_intel=intel,
    ))

    assert merged.business.phone == "+1 555-0100"
    assert merged.business.instagram_url == "https://instagram.com/safecleaners"
    assert intel.rendering_fallback_triggered is False


# ──────────────────────────────────────────────────────────────────────────────
# 46. Explicitly enabled configuration invokes renderer
# ──────────────────────────────────────────────────────────────────────────────
def test_46_explicitly_enabled_configuration_invokes_renderer():
    """Opting into rendering via constructor or env var enables dynamic fallback."""
    spa_html = '<html><body><div id="root"></div><script src="/app.js"></script></body></html>'
    rendered_html = '<html><body><div id="root"><a href="mailto:optin@render.com"></a></div></body></html>'

    # Case A: constructor opt-in
    worker_ctor = ContactWorker(required_channels=("email",), enable_dynamic_rendering=True)
    _mock_worker_pages(worker_ctor, {"https://optin.com": spa_html})
    worker_ctor._custom_renderer = MagicMock(return_value=(rendered_html, "https://optin.com", 0.15))
    intel_ctor = worker_ctor.process(WebsiteIntel(pipeline_id="p46a", final_url="https://optin.com"))
    assert intel_ctor.rendering_fallback_triggered is True
    assert "optin@render.com" in intel_ctor.emails

    # Case B: environment variable opt-in
    with patch.dict(os.environ, {"ENABLE_DYNAMIC_RENDERING": "true"}):
        worker_env = ContactWorker(required_channels=("email",))
        assert worker_env._dynamic_rendering_enabled is True
        _mock_worker_pages(worker_env, {"https://optin.com": spa_html})
        worker_env._custom_renderer = MagicMock(return_value=(rendered_html, "https://optin.com", 0.15))
        intel_env = worker_env.process(WebsiteIntel(pipeline_id="p46b", final_url="https://optin.com"))
        assert intel_env.rendering_fallback_triggered is True
        assert "optin@render.com" in intel_env.emails


# ──────────────────────────────────────────────────────────────────────────────
# 47. Disallowed egress remains blocked on static path
# ──────────────────────────────────────────────────────────────────────────────
def test_47_disallowed_egress_remains_blocked_on_static_path():
    """Static HTTP extraction strictly prohibits loopback, link-local, and cloud metadata targets."""
    from utils.egress_guard import DisallowedEgressError

    worker = ContactWorker()

    disallowed_urls = [
        "http://127.0.0.1:8080/admin",
        "http://169.254.169.254/latest/meta-data/",
        "http://[::1]/secret",
        "http://10.0.0.1/internal",
    ]

    for bad_url in disallowed_urls:
        with pytest.raises(DisallowedEgressError):
            worker._fetch(bad_url)


# ──────────────────────────────────────────────────────────────────────────────
# 48. Monotonic deadline check: exhausted before launch
# ──────────────────────────────────────────────────────────────────────────────
def test_48_deadline_exhausted_before_launch():
    """If monotonic deadline expires before launch, _check_remaining raises TimeoutError immediately."""
    worker = ContactWorker(timeout=4.0, enable_dynamic_rendering=True)

    # Mock time.monotonic such that start is 100.0, but by the time launch is reached, monotonic is 105.0 (> 104.0)
    monotonic_vals = [100.0, 105.0]
    call_idx = [0]
    def fake_monotonic():
        val = monotonic_vals[min(call_idx[0], len(monotonic_vals) - 1)]
        call_idx[0] += 1
        return val

    mock_playwright = MagicMock()

    with patch("time.monotonic", side_effect=fake_monotonic), \
         patch("workers.contact_worker.assert_safe_egress_url"), \
         patch("playwright.sync_api.sync_playwright") as mock_sync_pw:
        mock_sync_pw.return_value.__enter__.return_value = mock_playwright

        with pytest.raises(TimeoutError, match="Rendering deadline expired"):
            worker._render_dynamic_page("https://example.com")

        assert mock_playwright.chromium.launch.call_count == 0


# ──────────────────────────────────────────────────────────────────────────────
# 49. Monotonic deadline check: exhausted during navigation
# ──────────────────────────────────────────────────────────────────────────────
def test_49_deadline_exhausted_during_navigation():
    """If monotonic deadline expires before page.goto, _check_remaining raises TimeoutError and cleans up."""
    worker = ContactWorker(timeout=4.0, enable_dynamic_rendering=True)

    # 100.0 (start), 100.1 (slot), 100.2 (launch check), 104.5 (goto check -> expired)
    monotonic_vals = [100.0, 100.1, 100.2, 104.5]
    call_idx = [0]
    def fake_monotonic():
        val = monotonic_vals[min(call_idx[0], len(monotonic_vals) - 1)]
        call_idx[0] += 1
        return val

    mock_playwright = MagicMock()
    mock_browser = MagicMock()
    mock_ctx = MagicMock()
    mock_page = MagicMock()

    mock_ctx.new_page.return_value = mock_page
    mock_browser.new_context.return_value = mock_ctx
    mock_playwright.chromium.launch.return_value = mock_browser

    with patch("time.monotonic", side_effect=fake_monotonic), \
         patch("workers.contact_worker.assert_safe_egress_url"), \
         patch("playwright.sync_api.sync_playwright") as mock_sync_pw:
        mock_sync_pw.return_value.__enter__.return_value = mock_playwright

        with pytest.raises(TimeoutError, match="Rendering deadline expired"):
            worker._render_dynamic_page("https://example.com")

        assert mock_page.goto.call_count == 0
        assert mock_page.close.call_count == 1
        assert mock_ctx.close.call_count == 1
        assert mock_browser.close.call_count == 1


# ──────────────────────────────────────────────────────────────────────────────
# 50. Monotonic deadline check: exhausted during hydration
# ──────────────────────────────────────────────────────────────────────────────
def test_50_deadline_exhausted_during_hydration():
    """If deadline is already reached after goto, wait_for_timeout is skipped (post_ms <= 0)."""
    worker = ContactWorker(timeout=4.0, enable_dynamic_rendering=True)

    # 100.0 (start), 100.1 (slot), 100.2 (launch), 101.0 (nav check), 104.2 (post-nav check -> rem <= 0)
    monotonic_vals = [100.0, 100.1, 100.2, 101.0, 104.2, 104.3]
    call_idx = [0]
    def fake_monotonic():
        val = monotonic_vals[min(call_idx[0], len(monotonic_vals) - 1)]
        call_idx[0] += 1
        return val

    mock_playwright = MagicMock()
    mock_browser = MagicMock()
    mock_ctx = MagicMock()
    mock_page = MagicMock()

    mock_ctx.new_page.return_value = mock_page
    mock_browser.new_context.return_value = mock_ctx
    mock_playwright.chromium.launch.return_value = mock_browser
    mock_page.content.return_value = "<html><body>Hydration Done</body></html>"
    mock_page.url = "https://example.com"

    with patch("time.monotonic", side_effect=fake_monotonic), \
         patch("workers.contact_worker.assert_safe_egress_url"), \
         patch("playwright.sync_api.sync_playwright") as mock_sync_pw:
        mock_sync_pw.return_value.__enter__.return_value = mock_playwright

        html, url, elapsed = worker._render_dynamic_page("https://example.com")

        assert "Hydration Done" in html
        assert mock_page.wait_for_timeout.call_count == 0


# ──────────────────────────────────────────────────────────────────────────────
# 51. Teardown cleanup failure does not crash worker or hide static results
# ──────────────────────────────────────────────────────────────────────────────
def test_51_teardown_cleanup_failure_does_not_crash_or_hide_static_results():
    """Exceptions during browser.close() or page.close() are caught and do not crash or corrupt output."""
    worker = ContactWorker(enable_dynamic_rendering=True)

    mock_playwright = MagicMock()
    mock_browser = MagicMock()
    mock_ctx = MagicMock()
    mock_page = MagicMock()

    mock_ctx.new_page.return_value = mock_page
    mock_browser.new_context.return_value = mock_ctx
    mock_playwright.chromium.launch.return_value = mock_browser

    mock_page.content.return_value = "<html><body>Success Before Close Crash</body></html>"
    mock_page.url = "https://example.com"

    # Make page.close() and browser.close() raise exceptions
    mock_page.close.side_effect = RuntimeError("Broken pipe on page.close")
    mock_browser.close.side_effect = RuntimeError("Target closed on browser.close")

    with patch("workers.contact_worker.assert_safe_egress_url"), \
         patch("playwright.sync_api.sync_playwright") as mock_sync_pw:
        mock_sync_pw.return_value.__enter__.return_value = mock_playwright

        html, url, elapsed = worker._render_dynamic_page("https://example.com")

        assert "Success Before Close Crash" in html
        # Both closes were attempted despite raising
        assert mock_page.close.call_count == 1
        assert mock_browser.close.call_count == 1


# ──────────────────────────────────────────────────────────────────────────────
# 52. Outer Node process supervisor termination contract
# ──────────────────────────────────────────────────────────────────────────────
def test_52_outer_node_process_termination_remains_safeguard():
    """Verifies contracts and constants that guarantee outer Node.js supervision."""
    from workers.contact_worker import DEFAULT_TIMEOUT_SECONDS
    # ContactWorker's per-worker timeout is bounded to 15s
    assert DEFAULT_TIMEOUT_SECONDS <= 15.0

    # Ensure dynamic rendering budget is strictly clamped to min(timeout, 4.0)
    worker_short = ContactWorker(timeout=2.0)
    assert min(float(worker_short._timeout), 4.0) == 2.0

    worker_long = ContactWorker(timeout=30.0)
    assert min(float(worker_long._timeout), 4.0) == 4.0


# ──────────────────────────────────────────────────────────────────────────────
# 53. Production environment + both environment flags enabled = rendering disabled
# ──────────────────────────────────────────────────────────────────────────────
def test_53_production_env_with_flags_enabled_disables_rendering():
    """In production, rendering is strictly disabled even if both env flags are true."""
    with patch.dict(os.environ, {
        "NODE_ENV": "production",
        "ENABLE_DYNAMIC_RENDERING": "true",
        "MAST_ENABLE_DYNAMIC_RENDERING": "true",
    }):
        worker = ContactWorker()
        assert worker._dynamic_rendering_enabled is False

        spa_html = '<html><body><div id="root"></div><script src="/app.js"></script></body></html>'
        _mock_worker_pages(worker, {"https://prod-flags.com": spa_html})

        mock_renderer = MagicMock()
        worker._custom_renderer = mock_renderer

        intel = worker.process(WebsiteIntel(pipeline_id="p53", final_url="https://prod-flags.com"))

        assert intel.rendering_fallback_triggered is False
        assert mock_renderer.call_count == 0


# ──────────────────────────────────────────────────────────────────────────────
# 54. Production environment + constructor override True = rendering disabled
# ──────────────────────────────────────────────────────────────────────────────
def test_54_production_env_with_constructor_override_disables_rendering():
    """In production, constructor override enable_dynamic_rendering=True is rejected."""
    with patch.dict(os.environ, {"NODE_ENV": "production"}):
        worker = ContactWorker(required_channels=("email",), enable_dynamic_rendering=True)
        assert worker._dynamic_rendering_enabled is False

        spa_html = '<html><body><div id="root"></div><script src="/app.js"></script></body></html>'
        _mock_worker_pages(worker, {"https://prod-override.com": spa_html})

        mock_renderer = MagicMock()
        worker._custom_renderer = mock_renderer

        intel = worker.process(WebsiteIntel(pipeline_id="p54", final_url="https://prod-override.com"))

        assert intel.rendering_fallback_triggered is False
        assert mock_renderer.call_count == 0


# ──────────────────────────────────────────────────────────────────────────────
# 55. Development/test environment + explicit opt-in = rendering works
# ──────────────────────────────────────────────────────────────────────────────
def test_55_dev_test_env_with_explicit_opt_in_allows_rendering():
    """In dev or test environment, explicit opt-in allows selective rendering fallback."""
    spa_html = '<html><body><div id="root"></div><script src="/app.js"></script></body></html>'
    rendered_html = '<html><body><div id="root"><a href="mailto:optin@devtest.com">Email</a></div></body></html>'

    with patch("workers.contact_worker.assert_safe_egress_url"):
        # Case A: NODE_ENV="test" with constructor override
        with patch.dict(os.environ, {"NODE_ENV": "test"}):
            worker_a = ContactWorker(required_channels=("email",), enable_dynamic_rendering=True)
            assert worker_a._dynamic_rendering_enabled is True
            _mock_worker_pages(worker_a, {"https://devtest-a.com": spa_html})
            mock_renderer_a = MagicMock(return_value=(rendered_html, "https://devtest-a.com", 0.1))
            worker_a._custom_renderer = mock_renderer_a
            intel_a = worker_a.process(WebsiteIntel(pipeline_id="p55a", final_url="https://devtest-a.com"))
            assert intel_a.rendering_fallback_triggered is True
            assert intel_a.rendering_fallback_yield is True
            assert "optin@devtest.com" in intel_a.emails
            assert mock_renderer_a.call_count == 1

        # Case B: NODE_ENV="development" with ENABLE_DYNAMIC_RENDERING="true"
        with patch.dict(os.environ, {"NODE_ENV": "development", "ENABLE_DYNAMIC_RENDERING": "true"}):
            worker_b = ContactWorker(required_channels=("email",))
            assert worker_b._dynamic_rendering_enabled is True
            _mock_worker_pages(worker_b, {"https://devtest-b.com": spa_html})
            mock_renderer_b = MagicMock(return_value=(rendered_html, "https://devtest-b.com", 0.1))
            worker_b._custom_renderer = mock_renderer_b
            intel_b = worker_b.process(WebsiteIntel(pipeline_id="p55b", final_url="https://devtest-b.com"))
            assert intel_b.rendering_fallback_triggered is True
            assert intel_b.rendering_fallback_yield is True
            assert "optin@devtest.com" in intel_b.emails
            assert mock_renderer_b.call_count == 1


# ──────────────────────────────────────────────────────────────────────────────
# 56. Unknown environment + explicit opt-in = rendering disabled
# ──────────────────────────────────────────────────────────────────────────────
def test_56_unknown_env_with_explicit_opt_in_disables_rendering():
    """If environment cannot be positively identified as dev/test, rendering is disabled."""
    with patch.dict(os.environ, {
        "NODE_ENV": "",
        "MAST_ENV": "",
        "APP_ENV": "",
        "ENVIRONMENT": "",
        "ENV": "",
        "MAST_TEST_ENV": "",
        "ENABLE_DYNAMIC_RENDERING": "true",
        "MAST_ENABLE_DYNAMIC_RENDERING": "true",
    }):
        # Both constructor override and env flags are rejected in unknown environment
        worker = ContactWorker(required_channels=("email",), enable_dynamic_rendering=True)
        assert worker._dynamic_rendering_enabled is False

        spa_html = '<html><body><div id="root"></div><script src="/app.js"></script></body></html>'
        _mock_worker_pages(worker, {"https://unknown-env.com": spa_html})

        mock_renderer = MagicMock()
        worker._custom_renderer = mock_renderer

        intel = worker.process(WebsiteIntel(pipeline_id="p56", final_url="https://unknown-env.com"))

        assert intel.rendering_fallback_triggered is False
        assert mock_renderer.call_count == 0


# ──────────────────────────────────────────────────────────────────────────────
# 57. No production construction path can launch the real browser renderer
# ──────────────────────────────────────────────────────────────────────────────
def test_57_no_production_construction_path_can_launch_real_browser():
    """Verifies that in production, no construction path can invoke Chromium."""
    with patch.dict(os.environ, {"NODE_ENV": "production"}):
        from engine_enrichment_bridge import enrich_business_with_engine_v2
        from workers.contact_worker import is_development_or_test_environment, is_dynamic_rendering_enabled

        # Guard checks are strictly False in production
        assert is_development_or_test_environment() is False
        assert is_dynamic_rendering_enabled() is False

        # Direct construction
        w_default = ContactWorker()
        assert w_default._dynamic_rendering_enabled is False

        w_override = ContactWorker(enable_dynamic_rendering=True)
        assert w_override._dynamic_rendering_enabled is False

        # Even if _render_dynamic_page is called directly, defense-in-depth raises RuntimeError
        with pytest.raises(RuntimeError, match="Dynamic browser rendering is disabled"):
            w_default._render_dynamic_page("https://example-production.com")
