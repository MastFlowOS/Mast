"""
Phase 15 — Email / Contact Acquisition Tests
=============================================

Tests for bounded, quality-preserving email and contact acquisition:
1. Existing homepage email extraction
2. Existing contact-page email extraction
3. Existing homepage phone extraction
4. Existing contact-page phone extraction
5. About-page link discovery
6. Team-page link discovery
7. Locations-page link discovery
8. Contact-page link discovery
9. Deterministic priority ranking (contact > about > team > staff > locations > catering > wholesale > press > partners)
10. Only ONE additional page is fetched (max 3 total)
11. Same-domain restriction works
12. External URLs are ignored
13. Existing contact_page is not fetched twice
14. Secondary page is not fetched if email+phone already exist
15. Early exit after valid email+phone
16. mailto extraction still works (percent-decoded, multi-address)
17. tel extraction still works
18. JSON-LD Organization / LocalBusiness / ContactPoint email extraction
19. JSON-LD Organization / LocalBusiness / ContactPoint telephone extraction
20. Placeholder email rejection
21. no-reply / system email rejection
22. Invalid phone-like strings rejection
23. Secondary page failure isolation (does not erase homepage/contact data)
24. Maximum 3 page fetches enforced
25. No recursive crawl occurs
26. Existing qualification semantics preserved
27. End-to-end flow (Website -> ContactWorker -> FanIn -> Merge -> Qualification)
28. Icon mailto link extraction (<a href="mailto:..."><svg>...</svg></a>)
29. Icon tel link extraction (<a href="tel:..."><svg>...</svg></a>)
30. email in aria-label
31. phone in aria-label
32. email in data-* attribute with proper context (<span data-email="...">)
33. phone in data-* attribute with proper context (<div title="Call us" data-phone="...">)
34. Unrelated numeric attributes ignored (data-id, width, height)
35. Unrelated @ text ignored
36. Telemetry fields (email_source, phone_source, secondary_page_type, secondary_page_fetched, secondary_page_fetch_failed)
"""

import pytest
from unittest.mock import MagicMock

from engine.contracts import BusinessCandidate, ContactIntel, EnrichedBusiness, WebsiteIntel
from utils.parsing import (
    extract_contextual_attribute_contacts,
    extract_jsonld_contact_data,
    find_secondary_contact_link,
    is_valid_email,
    is_valid_phone,
    normalize_phone,
)
from workers.contact_worker import ContactWorker
from workers.qualification_worker import QualificationWorker


def _make_worker_with_pages(pages_dict: dict[str, str]) -> ContactWorker:
    """Helper to mock ContactWorker._fetch with a mapping of URL -> HTML."""
    worker = ContactWorker()

    def fake_fetch(url: str):
        url_clean = url.strip()
        if url_clean not in pages_dict:
            for k, v in pages_dict.items():
                if k.rstrip("/") == url_clean.rstrip("/"):
                    return v, url, 0.05
            raise ConnectionError(f"HTTP 404: {url} not found")
        return pages_dict[url_clean], url, 0.05

    worker._fetch = MagicMock(side_effect=fake_fetch)
    return worker


class TestPhase15ContactAcquisition:

    def test_1_existing_homepage_email(self):
        worker = _make_worker_with_pages({
            "https://bakery.com": "<html><body>Contact us at info@bakery.com</body></html>"
        })
        item = WebsiteIntel(pipeline_id="p1", final_url="https://bakery.com")
        intel = worker.process(item)
        assert intel.emails == ("info@bakery.com",)
        assert intel.email_source == "homepage"

    def test_2_existing_contact_page_email(self):
        worker = _make_worker_with_pages({
            "https://bakery.com/contact": "<html><body>Email: hello@bakery.com</body></html>",
            "https://bakery.com": "<html><body>Welcome to the bakery</body></html>",
        })
        item = WebsiteIntel(pipeline_id="p2", final_url="https://bakery.com", contact_page="https://bakery.com/contact")
        intel = worker.process(item)
        assert intel.emails is not None
        assert "hello@bakery.com" in intel.emails
        assert intel.email_source == "contact_page"

    def test_3_existing_homepage_phone(self):
        worker = _make_worker_with_pages({
            "https://bakery.com": '<html><body><a href="tel:+12125550199">Call</a></body></html>'
        })
        item = WebsiteIntel(pipeline_id="p3", final_url="https://bakery.com")
        intel = worker.process(item)
        assert intel.phones is not None
        assert any("+1 (212) 555-0199" in p or "+12125550199" in p for p in intel.phones)
        assert intel.phone_source == "tel"

    def test_4_existing_contact_page_phone(self):
        worker = _make_worker_with_pages({
            "https://bakery.com/contact": '<html><body>Call us: (212) 555-0123</body></html>',
            "https://bakery.com": "<html><body>Welcome</body></html>",
        })
        item = WebsiteIntel(pipeline_id="p4", final_url="https://bakery.com", contact_page="https://bakery.com/contact")
        intel = worker.process(item)
        assert intel.phones is not None
        assert any("555-0123" in p or "5550123" in p for p in intel.phones)
        assert intel.phone_source == "contact_page"

    def test_5_about_page_discovery(self):
        worker = _make_worker_with_pages({
            "https://bakery.com": '<html><body><a href="/about-us">About Our Story</a> <a href="tel:+12125550100">Call</a></body></html>',
            "https://bakery.com/about-us": "<html><body>Founder email: founder@bakery.com</body></html>",
        })
        item = WebsiteIntel(pipeline_id="p5", final_url="https://bakery.com")
        intel = worker.process(item)
        assert intel.emails == ("founder@bakery.com",)
        assert intel.secondary_page_fetched is True
        assert intel.secondary_page_type == "about"
        assert intel.email_source == "secondary_page"

    def test_6_team_page_discovery(self):
        worker = _make_worker_with_pages({
            "https://bakery.com": '<html><body><a href="/our-team">Meet The Team</a> <a href="tel:+12125550100">Call</a></body></html>',
            "https://bakery.com/our-team": "<html><body>Contact: team@bakery.com</body></html>",
        })
        item = WebsiteIntel(pipeline_id="p6", final_url="https://bakery.com")
        intel = worker.process(item)
        assert intel.emails == ("team@bakery.com",)
        assert intel.secondary_page_fetched is True
        assert intel.secondary_page_type == "team"

    def test_7_locations_page_discovery(self):
        worker = _make_worker_with_pages({
            "https://bakery.com": '<html><body><a href="/locations">Our Stores</a> <a href="mailto:info@bakery.com">Email</a></body></html>',
            "https://bakery.com/locations": '<html><body>Store Phone: <a href="tel:+12125550199">Call Soho</a></body></html>',
        })
        item = WebsiteIntel(pipeline_id="p7", final_url="https://bakery.com")
        intel = worker.process(item)
        assert intel.phones is not None
        assert intel.secondary_page_fetched is True
        assert intel.secondary_page_type == "locations"

    def test_8_contact_page_link_discovery(self):
        worker = _make_worker_with_pages({
            "https://bakery.com": '<html><body><a href="/contact-us">Get in touch</a></body></html>',
            "https://bakery.com/contact-us": '<html><body><a href="mailto:support@bakery.com">Support</a> <a href="tel:+12125550155">Call</a></body></html>',
        })
        item = WebsiteIntel(pipeline_id="p8", final_url="https://bakery.com")
        intel = worker.process(item)
        assert intel.emails == ("support@bakery.com",)
        assert intel.secondary_page_fetched is True
        assert intel.secondary_page_type == "contact"

    def test_9_deterministic_priority_order(self):
        fetched = [("<html><body><a href='/catering'>Catering</a> <a href='/press'>Press</a> <a href='/contact'>Contact</a> <a href='/about'>About</a></body></html>", "https://bakery.com")]
        best_url, best_cat = find_secondary_contact_link(fetched, "https://bakery.com", set())
        assert best_cat == "contact"
        assert best_url == "https://bakery.com/contact"

        fetched2 = [("<html><body><a href='/press'>Press</a> <a href='/team'>Team</a> <a href='/about'>About</a></body></html>", "https://bakery.com")]
        best_url2, best_cat2 = find_secondary_contact_link(fetched2, "https://bakery.com", set())
        assert best_cat2 == "about"
        assert best_url2 == "https://bakery.com/about"

    def test_10_only_one_additional_page_fetched(self):
        worker = _make_worker_with_pages({
            "https://bakery.com": '<html><body><a href="/about">About</a> <a href="/team">Team</a> <a href="/press">Press</a></body></html>',
            "https://bakery.com/about": "<html><body>We are a bakery. (No email here)</body></html>",
            "https://bakery.com/team": "<html><body>team@bakery.com</body></html>",
        })
        item = WebsiteIntel(pipeline_id="p10", final_url="https://bakery.com")
        worker.process(item)
        assert worker._fetch.call_count == 2
        fetched_urls = [call.args[0] for call in worker._fetch.call_args_list]
        assert "https://bakery.com" in fetched_urls
        assert "https://bakery.com/about" in fetched_urls
        assert "https://bakery.com/team" not in fetched_urls

    def test_11_same_domain_restriction(self):
        fetched = [('<html><body><a href="https://external.com/about">External</a> <a href="/about">Local</a></body></html>', "https://bakery.com")]
        best_url, best_cat = find_secondary_contact_link(fetched, "https://bakery.com", set())
        assert best_url == "https://bakery.com/about"

    def test_12_external_social_urls_ignored(self):
        fetched = [('<html><body><a href="https://instagram.com/about">Insta About</a> <a href="https://facebook.com/contact">FB</a></body></html>', "https://bakery.com")]
        best_url, best_cat = find_secondary_contact_link(fetched, "https://bakery.com", set())
        assert best_url is None
        assert best_cat is None

    def test_13_existing_contact_page_not_fetched_twice(self):
        worker = _make_worker_with_pages({
            "https://bakery.com/contact": '<html><body><a href="/contact">Contact Link</a></body></html>',
            "https://bakery.com": '<html><body><a href="/contact">Contact</a></body></html>',
        })
        item = WebsiteIntel(pipeline_id="p13", final_url="https://bakery.com", contact_page="https://bakery.com/contact")
        worker.process(item)
        assert worker._fetch.call_count == 2

    def test_14_secondary_page_fetched_when_only_instagram_still_missing(self):
        # Phase 27, Step 2: Instagram is now also a missing-required-
        # acquisition-target that can justify the one allowed secondary
        # page — updated from this test's pre-Phase-27 name/assertion
        # ("...not_fetched_if_email_and_phone_exist" / call_count == 1),
        # which asserted the exact stop condition Phase 27, Step 1
        # deliberately changes. Email+phone are present after the first
        # page, but Instagram is missing and an "about" link is
        # available, so the bounded secondary-page fetch now fires.
        worker = _make_worker_with_pages({
            "https://bakery.com": '<html><body><a href="mailto:hello@bakery.com">Email</a> <a href="tel:+12125550199">Phone</a> <a href="/about">About</a></body></html>',
            "https://bakery.com/about": '<html><body>About us</body></html>',
        })
        item = WebsiteIntel(pipeline_id="p14", final_url="https://bakery.com")
        intel = worker.process(item)
        assert intel.emails == ("hello@bakery.com",)
        assert intel.phones is not None
        assert intel.instagram_url is None
        assert worker._fetch.call_count == 2
        assert intel.secondary_page_fetched is True
        assert intel.secondary_page_type == "about"

    def test_15_no_early_exit_while_instagram_still_missing(self):
        # Phase 27, Step 1/3: previously renamed from
        # "...early_exit_after_valid_email_and_phone" — the old
        # assertion (call_count == 1) was exactly the bug Step 3
        # describes: a contact page supplying email+phone stopped the
        # loop before the homepage (which may carry an Instagram icon)
        # was ever inspected. Neither page here has Instagram, so both
        # candidate pages are now fetched (still bounded — the existing
        # two-page (contact_page, final_url) budget is unchanged) before
        # falling through to qualification with Instagram missing.
        worker = _make_worker_with_pages({
            "https://bakery.com/contact": '<html><body><a href="mailto:hello@bakery.com">Email</a> <a href="tel:+12125550199">Phone</a></body></html>',
            "https://bakery.com": '<html><body>Homepage</body></html>',
        })
        item = WebsiteIntel(pipeline_id="p15", final_url="https://bakery.com", contact_page="https://bakery.com/contact")
        intel = worker.process(item)
        assert worker._fetch.call_count == 2
        assert intel.emails == ("hello@bakery.com",)
        assert intel.phones is not None
        assert intel.instagram_url is None

    def test_16_mailto_percent_decoded_and_params_stripped(self):
        worker = _make_worker_with_pages({
            "https://bakery.com": '<html><body><a href="mailto:hello%2Borders@bakery.com?subject=Hello%20World&body=Test">Email</a></body></html>'
        })
        item = WebsiteIntel(pipeline_id="p16", final_url="https://bakery.com")
        intel = worker.process(item)
        assert intel.emails == ("hello+orders@bakery.com",)
        assert intel.mailto_extracted is True

    def test_17_tel_extraction(self):
        worker = _make_worker_with_pages({
            "https://bakery.com": '<html><body><a href="tel:+1%20(212)%20555-0199">Call Us</a></body></html>'
        })
        item = WebsiteIntel(pipeline_id="p17", final_url="https://bakery.com")
        intel = worker.process(item)
        assert intel.phones is not None
        assert intel.tel_extracted is True

    def test_18_jsonld_email_extraction(self):
        html = """
        <html>
        <head>
        <script type="application/ld+json">
        {
          "@context": "https://schema.org",
          "@type": "Bakery",
          "name": "The Great Bakery",
          "email": "orders@greatbakery.com",
          "telephone": "+1-212-555-0188",
          "url": "https://greatbakery.com"
        }
        </script>
        </head>
        <body>No visible text contact</body>
        </html>
        """
        worker = _make_worker_with_pages({"https://greatbakery.com": html})
        item = WebsiteIntel(pipeline_id="p18", final_url="https://greatbakery.com")
        intel = worker.process(item)
        assert intel.emails == ("orders@greatbakery.com",)
        assert intel.email_source == "jsonld"

    def test_19_jsonld_phone_extraction(self):
        html = """
        <html>
        <head>
        <script type="application/ld+json">
        {
          "@context": "https://schema.org",
          "@type": "LocalBusiness",
          "name": "Joe's Coffee",
          "telephone": "+12125550177"
        }
        </script>
        </head>
        <body>Welcome</body>
        </html>
        """
        worker = _make_worker_with_pages({"https://coffee.com": html})
        item = WebsiteIntel(pipeline_id="p19", final_url="https://coffee.com")
        intel = worker.process(item)
        assert intel.phones is not None
        assert any("555-0177" in p or "5550177" in p for p in intel.phones)
        assert intel.phone_source == "jsonld"

    def test_20_placeholder_email_rejection(self):
        html = "<html><body>Contact test@example.com or user@domain.com or email@yourdomain.com</body></html>"
        worker = _make_worker_with_pages({"https://site.com": html})
        item = WebsiteIntel(pipeline_id="p20", final_url="https://site.com")
        intel = worker.process(item)
        assert intel.emails is None

    def test_21_noreply_email_rejection(self):
        html = "<html><body>Automated notices from noreply@bakery.com, support@sentry.io</body></html>"
        worker = _make_worker_with_pages({"https://site.com": html})
        item = WebsiteIntel(pipeline_id="p21", final_url="https://site.com")
        intel = worker.process(item)
        assert intel.emails is None

    def test_22_invalid_phone_rejection(self):
        html = "<html><body>Order ID: 1234567890, Dimensions: 1920x1080, Serial: 0000000000</body></html>"
        worker = _make_worker_with_pages({"https://site.com": html})
        item = WebsiteIntel(pipeline_id="p22", final_url="https://site.com")
        intel = worker.process(item)
        assert intel.phones is None

    def test_23_secondary_page_failure_isolation(self):
        worker = _make_worker_with_pages({
            "https://bakery.com": '<html><body><a href="mailto:hello@bakery.com">Email</a> <a href="/about">About</a></body></html>',
        })
        item = WebsiteIntel(pipeline_id="p23", final_url="https://bakery.com")
        intel = worker.process(item)
        assert intel.emails == ("hello@bakery.com",)
        assert intel.secondary_page_fetched is True
        assert intel.secondary_page_fetch_failed is True
        assert intel.partial_contact_success is True

    def test_24_maximum_3_fetches_enforced(self):
        worker = _make_worker_with_pages({
            "https://bakery.com/contact": '<html><body><a href="/about">About</a></body></html>',
            "https://bakery.com": '<html><body><a href="/about">About</a></body></html>',
            "https://bakery.com/about": '<html><body><a href="/team">Team</a></body></html>',
            "https://bakery.com/team": '<html><body>Team</body></html>',
        })
        item = WebsiteIntel(pipeline_id="p24", final_url="https://bakery.com", contact_page="https://bakery.com/contact")
        worker.process(item)
        assert worker._fetch.call_count == 3
        urls_called = [c.args[0] for c in worker._fetch.call_args_list]
        assert "https://bakery.com/team" not in urls_called

    def test_25_no_recursive_crawl(self):
        worker = _make_worker_with_pages({
            "https://bakery.com": '<html><body><a href="/about">About</a></body></html>',
            "https://bakery.com/about": '<html><body><a href="/about/subpage">Subpage</a></body></html>',
            "https://bakery.com/about/subpage": '<html><body>Subpage</body></html>',
        })
        item = WebsiteIntel(pipeline_id="p25", final_url="https://bakery.com")
        worker.process(item)
        assert worker._fetch.call_count == 2
        assert "https://bakery.com/about/subpage" not in [c.args[0] for c in worker._fetch.call_args_list]

    def test_26_qualification_behavior_preservation(self):
        candidate = BusinessCandidate(
            pipeline_id="p26",
            session_id="s26",
            provider="google_maps",
            name="The Artisanal Bakery",
            website="https://bakery.com",
            phone=None,
        )
        web_intel = WebsiteIntel(pipeline_id="p26", final_url="https://bakery.com", website_reachable=True)
        contact_intel = ContactIntel(
            pipeline_id="p26",
            emails=("hello@bakery.com",),
            phones=("+1 (212) 555-0199",),
            instagram_url="https://www.instagram.com/artisanalbakery/",
        )
        enriched = EnrichedBusiness(
            pipeline_id="p26",
            business=candidate,
            website_intel=web_intel,
            instagram_intel=None,
            contact_intel=contact_intel,
        )
        decision = QualificationWorker().process(enriched)
        assert decision.qualified is True

    def test_28_icon_mailto_link(self):
        html = '<a href="mailto:hello@bakery.com" class="social-icon"><svg viewBox="0 0 24 24"><path d="..."></path></svg></a>'
        worker = _make_worker_with_pages({"https://bakery.com": html})
        item = WebsiteIntel(pipeline_id="p28", final_url="https://bakery.com")
        intel = worker.process(item)
        assert intel.emails == ("hello@bakery.com",)
        assert intel.email_source == "mailto"

    def test_29_icon_tel_link(self):
        html = '<a href="tel:+12125551234" class="phone-icon"><svg viewBox="0 0 24 24"><path d="..."></path></svg></a>'
        worker = _make_worker_with_pages({"https://example.com": html})
        item = WebsiteIntel(pipeline_id="p29", final_url="https://example.com")
        intel = worker.process(item)
        assert intel.phones is not None
        assert any("555-1234" in p or "5551234" in p for p in intel.phones)
        assert intel.phone_source == "tel"

    def test_30_email_in_aria_label(self):
        html = '<button aria-label="Email us: support@bakery.com"><i class="icon-mail"></i></button>'
        worker = _make_worker_with_pages({"https://bakery.com": html})
        item = WebsiteIntel(pipeline_id="p30", final_url="https://bakery.com")
        intel = worker.process(item)
        assert intel.emails == ("support@bakery.com",)

    def test_31_phone_in_aria_label(self):
        html = '<button aria-label="Call us +1 (212) 555-0144"><i class="icon-phone"></i></button>'
        worker = _make_worker_with_pages({"https://bakery.com": html})
        item = WebsiteIntel(pipeline_id="p31", final_url="https://bakery.com")
        intel = worker.process(item)
        assert intel.phones is not None
        assert any("555-0144" in p or "5550144" in p for p in intel.phones)

    def test_32_email_in_data_attribute(self):
        html = '<button aria-label="Email us"><span data-email="hello@bakery.com">Send</span></button>'
        worker = _make_worker_with_pages({"https://bakery.com": html})
        item = WebsiteIntel(pipeline_id="p32", final_url="https://bakery.com")
        intel = worker.process(item)
        assert intel.emails == ("hello@bakery.com",)

    def test_33_phone_in_data_attribute(self):
        html = '<div title="Call us" data-phone="+12125551234"><svg></svg></div>'
        worker = _make_worker_with_pages({"https://bakery.com": html})
        item = WebsiteIntel(pipeline_id="p33", final_url="https://bakery.com")
        intel = worker.process(item)
        assert intel.phones is not None
        assert any("555-1234" in p or "5551234" in p for p in intel.phones)

    def test_34_unrelated_numeric_attributes_ignored(self):
        html = '<div data-id="1234567890" width="1920" height="1080" data-timestamp="1680000000"></div>'
        worker = _make_worker_with_pages({"https://bakery.com": html})
        item = WebsiteIntel(pipeline_id="p34", final_url="https://bakery.com")
        intel = worker.process(item)
        assert intel.phones is None

    def test_35_unrelated_at_ignored(self):
        html = '<div class="banner">Prices starting @ $10/item! Follow @bakery on twitter</div>'
        worker = _make_worker_with_pages({"https://bakery.com": html})
        item = WebsiteIntel(pipeline_id="p35", final_url="https://bakery.com")
        intel = worker.process(item)
        assert intel.emails is None

    def test_36_telemetry_fields_populated(self):
        worker = _make_worker_with_pages({
            "https://bakery.com": '<html><body><a href="/about">About</a></body></html>',
            "https://bakery.com/about": '<html><body><a href="mailto:info@bakery.com">Email</a> Call (212) 555-0199</body></html>',
        })
        item = WebsiteIntel(pipeline_id="p36", final_url="https://bakery.com")
        intel = worker.process(item)
        assert intel.secondary_page_fetched is True
        assert intel.secondary_page_fetch_failed is False
        assert intel.secondary_page_type == "about"
        assert intel.email_source == "mailto"
        assert intel.phone_source == "secondary_page"
