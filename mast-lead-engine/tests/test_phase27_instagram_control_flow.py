"""
Regression tests — Phase 27 (Instagram acquisition control-flow +
extraction hardening).

Covers the ten numbered test groups from the Phase 27 prompt's own
"STEP 10 — TESTS" section:

    1-4   Fetch control (stop condition, secondary-page trigger, hard
          page budget, contact-page-then-homepage ordering)
    5-9   Instagram URL parser hardening (scheme-less / protocol-
          relative / bare-domain forms, all normalizing identically)
    10-12 data-instagram* attribute extraction
    13-16 Multiple-account precedence / ranking / dedup / reserved
          paths
    17-18 Telemetry (counters emitted, persisted in RunProfiler.summary())
    19-22 Regression (ContactWorker email/phone unchanged, qualification
          unchanged, InstagramWorker unchanged, no fetch-budget increase)

Nothing here touches scoring, niche relevance, qualification rules,
Maps/Overpass, worker counts, dedup, or credits — see
workers/contact_worker.py and utils/parsing.py module docstrings for
the full Phase 27 rationale.
"""

from __future__ import annotations

from typing import Tuple
from unittest.mock import MagicMock

import pytest

from engine.contracts import (
    BusinessCandidate,
    ContactIntel,
    EnrichedBusiness,
    WebsiteIntel,
)
from utils.parsing import (
    clean_ig_url,
    extract_ig_urls_with_source,
    has_invalid_ig_candidate,
)
from utils.perf import RunProfiler
from workers.contact_worker import ContactWorker
from workers.qualification_worker import QualificationWorker


# ---------------------------------------------------------------------------
# Test helpers (same shape as tests/test_phase15_contact_acquisition.py)
# ---------------------------------------------------------------------------


def _make_worker_with_pages(pages_dict: "dict[str, str]") -> ContactWorker:
    """Mock ContactWorker._fetch with a mapping of URL -> HTML."""
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


def _run_contact_worker(html: str, *, final_url: str = "https://bakery.com") -> ContactIntel:
    worker = ContactWorker()

    def _fake_fetch(url: str) -> Tuple[str, str, float]:
        return html, url, 0.01

    worker._fetch = _fake_fetch  # type: ignore[method-assign]

    website_intel = WebsiteIntel(
        pipeline_id="p1",
        website_reachable=True,
        final_url=final_url,
    )
    return worker.process(website_intel)


def _make_enriched_business(*, contact_intel: ContactIntel) -> EnrichedBusiness:
    candidate = BusinessCandidate(
        pipeline_id="p1",
        session_id="s1",
        provider="google_maps",
        name="Test Bakery",
        website="https://bakery.com",
        phone=None,
    )
    website_intel = WebsiteIntel(
        pipeline_id="p1", website_reachable=True, final_url="https://bakery.com"
    )
    return EnrichedBusiness(
        pipeline_id="p1",
        business=candidate,
        website_intel=website_intel,
        instagram_intel=None,
        contact_intel=contact_intel,
    )


# ---------------------------------------------------------------------------
# 1-4. FETCH CONTROL
# ---------------------------------------------------------------------------


class TestFetchControl:
    def test_1_email_phone_found_instagram_missing_continues_to_next_page(self):
        """email+phone found on page 1, Instagram missing -> page 2 is
        still fetched (budget allows it)."""
        worker = _make_worker_with_pages({
            "https://bakery.com/contact": (
                '<a href="mailto:hello@bakery.com">Email</a> '
                '<a href="tel:+12125550199">Phone</a>'
            ),
            "https://bakery.com": (
                '<a href="https://instagram.com/bakery">IG</a>'
            ),
        })
        item = WebsiteIntel(
            pipeline_id="p1",
            final_url="https://bakery.com",
            contact_page="https://bakery.com/contact",
        )
        intel = worker.process(item)
        assert intel.emails == ("hello@bakery.com",)
        assert intel.phones is not None
        assert intel.instagram_url == "https://www.instagram.com/bakery/"
        assert worker._fetch.call_count == 2

    def test_2_email_phone_instagram_all_found_early_exits(self):
        """All three found on the first page -> the second candidate
        page is never fetched."""
        worker = _make_worker_with_pages({
            "https://bakery.com/contact": (
                '<a href="mailto:hello@bakery.com">Email</a> '
                '<a href="tel:+12125550199">Phone</a> '
                '<a href="https://instagram.com/bakery">IG</a>'
            ),
            "https://bakery.com": "<html>homepage, never fetched</html>",
        })
        item = WebsiteIntel(
            pipeline_id="p2",
            final_url="https://bakery.com",
            contact_page="https://bakery.com/contact",
        )
        intel = worker.process(item)
        assert intel.emails == ("hello@bakery.com",)
        assert intel.phones is not None
        assert intel.instagram_url == "https://www.instagram.com/bakery/"
        assert worker._fetch.call_count == 1

    def test_3_hard_page_budget_never_exceeded(self):
        """Even when email, phone, and Instagram are all still missing
        after both initial pages, at most one secondary page is
        fetched -- never more than 3 total."""
        worker = _make_worker_with_pages({
            "https://bakery.com/contact": '<a href="/about">About</a>',
            "https://bakery.com": '<a href="/about">About</a>',
            "https://bakery.com/about": "<html>still nothing here</html>",
        })
        item = WebsiteIntel(
            pipeline_id="p3",
            final_url="https://bakery.com",
            contact_page="https://bakery.com/contact",
        )
        intel = worker.process(item)
        assert intel.emails is None
        assert intel.phones is None
        assert intel.instagram_url is None
        assert worker._fetch.call_count <= 3

    def test_4_contact_page_email_phone_homepage_instagram_icon_found(self):
        """The scenario Step 3 names explicitly: contact page has
        email+phone but no Instagram; homepage has an Instagram icon
        href. Required result: homepage gets inspected and Instagram is
        found."""
        worker = _make_worker_with_pages({
            "https://bakery.com/contact": (
                '<a href="mailto:hello@bakery.com">Email</a> '
                '<a href="tel:+12125550199">Phone</a>'
            ),
            "https://bakery.com": (
                '<footer><a href="https://instagram.com/bakery" '
                'class="social-icon"><svg></svg></a></footer>'
            ),
        })
        item = WebsiteIntel(
            pipeline_id="p4",
            final_url="https://bakery.com",
            contact_page="https://bakery.com/contact",
        )
        intel = worker.process(item)
        assert intel.instagram_url == "https://www.instagram.com/bakery/"
        assert worker._fetch.call_count == 2


# ---------------------------------------------------------------------------
# 5-9. URL PARSER HARDENING
# ---------------------------------------------------------------------------


class TestUrlParserHardening:
    @pytest.mark.parametrize(
        "href",
        [
            "https://instagram.com/business",
            "https://www.instagram.com/business",
            "http://instagram.com/business",
            "//instagram.com/business",
            "instagram.com/business",
        ],
    )
    def test_5_9_all_variants_normalize_identically(self, href):
        html = f'<a href="{href}">Follow</a>'
        results = extract_ig_urls_with_source(html)
        assert results == [("https://www.instagram.com/business/", "anchor_href")]

    @pytest.mark.parametrize(
        "href",
        [
            "https://instagram.com/business",
            "https://www.instagram.com/business",
            "http://instagram.com/business",
            "//instagram.com/business",
            "instagram.com/business",
        ],
    )
    def test_clean_ig_url_normalizes_all_variants(self, href):
        assert clean_ig_url(href) == "https://www.instagram.com/business/"

    def test_bare_domain_in_plain_text_recognized(self):
        html = "<p>Find us at instagram.com/business for daily specials.</p>"
        intel = _run_contact_worker(html)
        assert intel.instagram_url == "https://www.instagram.com/business/"

    def test_protocol_relative_in_plain_text_recognized(self):
        html = '<p>Follow: //instagram.com/business</p>'
        intel = _run_contact_worker(html)
        assert intel.instagram_url == "https://www.instagram.com/business/"

    def test_bare_domain_does_not_false_positive_on_similar_word(self):
        # "fakeinstagram.com" must never be treated as instagram.com —
        # the negative lookbehind that makes the bare-domain form safe.
        html = "<p>Visit fakeinstagram.com/business for unrelated content.</p>"
        results = extract_ig_urls_with_source(html)
        assert results == []

    def test_reserved_paths_still_rejected_in_bare_form(self):
        html = "<p>instagram.com/explore/tags/bakery/</p>"
        assert extract_ig_urls_with_source(html) == []
        assert has_invalid_ig_candidate(html) is True

    def test_numeric_only_handle_still_rejected_in_bare_form(self):
        html = "<p>instagram.com/12345</p>"
        assert extract_ig_urls_with_source(html) == []


# ---------------------------------------------------------------------------
# 10-12. DATA / JS ATTRIBUTE EXTRACTION
# ---------------------------------------------------------------------------


class TestDataAttributeExtraction:
    def test_10_data_instagram_attribute_found(self):
        html = '<div data-instagram="business"></div>'
        results = extract_ig_urls_with_source(html)
        assert results == [("https://www.instagram.com/business/", "data_attribute")]

    def test_11_data_instagram_handle_attribute_found(self):
        html = '<div data-instagram-handle="business"></div>'
        results = extract_ig_urls_with_source(html)
        assert results == [("https://www.instagram.com/business/", "data_attribute")]

    def test_data_instagram_url_attribute_found(self):
        html = '<div data-instagram-url="https://instagram.com/business"></div>'
        results = extract_ig_urls_with_source(html)
        assert results == [("https://www.instagram.com/business/", "data_attribute")]

    def test_12_arbitrary_data_id_not_interpreted_as_instagram(self):
        html = '<div data-id="business" data-name="business"></div>'
        results = extract_ig_urls_with_source(html)
        assert results == []

    def test_data_attribute_reaches_contact_intel(self):
        html = '<div data-instagram="business"></div>'
        intel = _run_contact_worker(html)
        assert intel.instagram_url == "https://www.instagram.com/business/"
        assert intel.instagram_source == "data_attribute"


# ---------------------------------------------------------------------------
# 13-16. MULTIPLE ACCOUNTS / PRECEDENCE / DEDUP / RESERVED PATHS
# ---------------------------------------------------------------------------


class TestMultipleAccountPrecedence:
    def test_13_plain_handle_candidate_not_suppressed_by_unrelated_url(self):
        """A random Instagram URL (e.g. a press-feature link) no longer
        silently discards a real business @handle mentioned elsewhere on
        the page -- both are collected, so the real business candidate
        can still be selected (by a caller inspecting the full ranked
        list) rather than vanishing outright, which was the Step 7 bug."""
        html = (
            '<a href="https://instagram.com/random_press_feature">Read</a>'
            '<p>Instagram: @realbusinesshandle</p>'
        )
        results = extract_ig_urls_with_source(html)
        urls = [u for u, _ in results]
        assert "https://www.instagram.com/random_press_feature/" in urls
        assert "https://www.instagram.com/realbusinesshandle/" in urls
        # URL-based evidence still ranks first (unchanged precedent —
        # see test_plain_handle_only_used_when_no_url_present in
        # tests/test_instagram_acquisition_phase14_2.py).
        assert results[0][1] == "anchor_href"
        # The real-business plain-handle candidate is present, not
        # discarded.
        assert results[-1] == (
            "https://www.instagram.com/realbusinesshandle/",
            "plain_handle",
        )

    def test_14_duplicate_instagram_urls_deduplicated(self):
        html = (
            '<a href="https://instagram.com/business">One</a>'
            '<a href="https://www.instagram.com/business/">Two</a>'
            '<a href="https://instagram.com/business?hl=en">Three</a>'
        )
        results = extract_ig_urls_with_source(html)
        assert results == [("https://www.instagram.com/business/", "anchor_href")]

    def test_15_reserved_paths_still_rejected(self):
        for path in ("/p/abc123/", "/reel/abc123/", "/explore/tags/x/",
                      "/accounts/login/", "/direct/inbox/", "/stories/x/",
                      "/tv/abc123/"):
            html = f'<a href="https://instagram.com{path}">link</a>'
            assert extract_ig_urls_with_source(html) == []

    def test_16_numeric_only_handle_still_rejected(self):
        html = '<a href="https://instagram.com/12345/">link</a>'
        assert extract_ig_urls_with_source(html) == []

    def test_ranking_priority_anchor_beats_later_jsonld(self):
        """A structured JSON-LD signal appearing earlier in the
        document must not outrank an anchor/social-link signal that
        appears later -- ranking is by evidence-type strength, not raw
        document order (Step 7)."""
        html = (
            '<script type="application/ld+json">'
            '{"@type":"Organization","sameAs":["https://instagram.com/jsonld_handle"]}'
            '</script>'
            '<footer><a href="https://instagram.com/anchor_handle">Follow</a></footer>'
        )
        results = extract_ig_urls_with_source(html)
        assert results[0] == ("https://www.instagram.com/anchor_handle/", "anchor_href")
        assert ("https://www.instagram.com/jsonld_handle/", "jsonld") in results

    def test_ranking_data_attribute_outranks_jsonld(self):
        html = (
            '<script type="application/ld+json">'
            '{"@type":"Organization","sameAs":["https://instagram.com/jsonld_handle"]}'
            '</script>'
            '<div data-instagram="attr_handle"></div>'
        )
        results = extract_ig_urls_with_source(html)
        assert results[0] == ("https://www.instagram.com/attr_handle/", "data_attribute")


# ---------------------------------------------------------------------------
# 17-18. TELEMETRY
# ---------------------------------------------------------------------------


class TestTelemetryPersistence:
    def test_17_found_missing_invalid_counters_emitted(self):
        from engine.execution_driver import _contact_instagram_discovery_event

        found_intel = ContactIntel(
            pipeline_id="p1",
            instagram_url="https://www.instagram.com/business/",
            instagram_source="anchor_href",
        )
        assert _contact_instagram_discovery_event(found_intel) == "instagram_discovery_found:anchor_href"

        invalid_intel = ContactIntel(
            pipeline_id="p1", instagram_invalid_candidate_seen=True
        )
        assert _contact_instagram_discovery_event(invalid_intel) == "instagram_discovery_invalid"

        missing_intel = ContactIntel(pipeline_id="p1")
        assert _contact_instagram_discovery_event(missing_intel) == "instagram_discovery_missing"

    def test_18_run_summary_contains_instagram_counters(self):
        """Phase 27, Step 9: counters incr()'d during a run must reach
        RunProfiler.summary() (the dict embedded in the __done__
        sentinel), not stay in-memory-only."""
        profiler = RunProfiler()
        profiler.incr("instagram_attempted")
        profiler.incr("instagram_attempted")
        profiler.incr("instagram_discovery_found")
        profiler.incr("instagram_discovery_missing")
        profiler.incr("instagram_discovery_invalid")
        profiler.incr("instagram_url_input_present")
        profiler.incr("instagram_profile_reachable")
        profiler.incr("instagram_short_circuited")

        summary = profiler.summary()
        assert "counters" in summary
        assert summary["counters"]["instagram_attempted"] == 2
        assert summary["counters"]["instagram_discovery_found"] == 1
        assert summary["counters"]["instagram_discovery_missing"] == 1
        assert summary["counters"]["instagram_discovery_invalid"] == 1
        assert summary["counters"]["instagram_url_input_present"] == 1
        assert summary["counters"]["instagram_profile_reachable"] == 1
        assert summary["counters"]["instagram_short_circuited"] == 1

    def test_no_raw_html_or_page_content_in_summary(self):
        """Step 9's explicit constraint: only aggregate counters, never
        raw HTML or full page contents."""
        profiler = RunProfiler()
        profiler.incr("instagram_attempted")
        summary = profiler.summary()
        serialized = repr(summary)
        assert "<html" not in serialized.lower()
        assert "<body" not in serialized.lower()


# ---------------------------------------------------------------------------
# 19-22. REGRESSION
# ---------------------------------------------------------------------------


class TestRegression:
    def test_19_contact_worker_email_phone_behavior_unchanged(self):
        html = '<a href="mailto:hello@bakery.com">Email</a> <a href="tel:+12125550199">Phone</a>'
        intel = _run_contact_worker(html)
        assert intel.emails == ("hello@bakery.com",)
        assert intel.phones is not None
        assert intel.email_source == "mailto"
        assert intel.phone_source == "tel"

    def test_20_qualification_semantics_unchanged(self):
        html = """
        <a href="mailto:hello@bakery.com">Email us</a>
        <a href="tel:+14165550199">Call us</a>
        <script type="application/ld+json">
        {"@type":"Organization","sameAs":["https://www.instagram.com/thebakery/"]}
        </script>
        """
        contact_intel = _run_contact_worker(html)
        lead = _make_enriched_business(contact_intel=contact_intel)
        worker = QualificationWorker(
            required_channels=("website", "email", "phone", "instagram")
        )
        result = worker.process(lead)
        assert result.qualified is True
        assert result.reasons == ()

    def test_21_instagram_worker_behavior_unchanged_once_url_provided(self):
        from workers.instagram_worker import InstagramWorker

        worker = InstagramWorker()

        def _boom(*_args, **_kwargs):
            raise AssertionError("InstagramWorker must not fetch with no URL")

        import urllib.request

        original_urlopen = urllib.request.urlopen
        urllib.request.urlopen = _boom  # type: ignore[assignment]
        try:
            candidate = BusinessCandidate(
                pipeline_id="p1", session_id="s1", provider="google_maps", name="Joe's"
            )
            intel = worker.process(candidate)
        finally:
            urllib.request.urlopen = original_urlopen  # type: ignore[assignment]

        assert intel.profile_reachable is False
        assert intel.fetch_duration is None

    def test_22_no_increase_beyond_existing_page_fetch_maximum(self):
        """Even in the worst case (everything missing everywhere), the
        total fetch count stays at the pre-existing ceiling of 3
        (contact_page + final_url + at most one secondary page)."""
        worker = _make_worker_with_pages({
            "https://bakery.com/contact": '<a href="/team">Team</a>',
            "https://bakery.com": '<a href="/team">Team</a>',
            "https://bakery.com/team": "<html>nothing here either</html>",
        })
        item = WebsiteIntel(
            pipeline_id="p22",
            final_url="https://bakery.com",
            contact_page="https://bakery.com/contact",
        )
        worker.process(item)
        assert worker._fetch.call_count == 3
