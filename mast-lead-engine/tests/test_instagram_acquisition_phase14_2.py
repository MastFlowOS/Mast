"""
Regression tests — Phase 14.2 (Instagram acquisition, quality-preserving).

Covers the broadened Instagram extraction added in this phase
(`utils.parsing.extract_ig_urls_with_source` /
`utils.parsing.has_invalid_ig_candidate`, wired into
`workers.contact_worker.ContactWorker`), the new observational
`ContactIntel` telemetry fields, and an end-to-end proof that a
discovered Instagram URL still reaches QualificationWorker exactly as
before. Nothing here touches qualification semantics, scoring, dedup,
or the existing two-page (`contact_page` / `final_url`) ContactWorker
fetch limit — see module docstrings in `utils/parsing.py` and
`workers/contact_worker.py` for the reasoning.
"""

from __future__ import annotations

from typing import Tuple

import pytest

from engine.contracts import (
    BusinessCandidate,
    ContactIntel,
    EnrichedBusiness,
    WebsiteIntel,
)
from utils.parsing import extract_ig_urls_with_source, has_invalid_ig_candidate
from workers.contact_worker import ContactWorker
from workers.qualification_worker import QualificationWorker


# ---------------------------------------------------------------------------
# Test helpers (same shape as tests/test_instagram_discovery_fix.py)
# ---------------------------------------------------------------------------


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
# 1. Existing anchor href extraction still works.
# ---------------------------------------------------------------------------


class TestAnchorHrefExtractionUnchanged:
    def test_anchor_href_instagram_still_detected(self):
        html = '<a href="https://www.instagram.com/joesbarber/">Follow us</a>'
        intel = _run_contact_worker(html)
        assert intel.instagram_url == "https://www.instagram.com/joesbarber/"
        assert intel.instagram_source == "anchor_href"


# ---------------------------------------------------------------------------
# 2. Instagram URL in non-anchor raw HTML is detected.
# ---------------------------------------------------------------------------


class TestRawHtmlExtraction:
    def test_bare_url_in_page_text_detected(self):
        html = (
            "<footer>Find us on the gram: "
            "https://www.instagram.com/joesbarber/ "
            "or drop by any time.</footer>"
        )
        intel = _run_contact_worker(html)
        assert intel.instagram_url == "https://www.instagram.com/joesbarber/"
        assert intel.instagram_source == "raw_html"

    def test_extract_ig_urls_with_source_raw_html(self):
        html = "some inline text mentioning https://instagram.com/joesbarber directly"
        results = extract_ig_urls_with_source(html)
        assert results == [("https://www.instagram.com/joesbarber/", "raw_html")]


# ---------------------------------------------------------------------------
# 3. Valid JSON-LD sameAs Instagram URL is detected.
# ---------------------------------------------------------------------------


class TestJsonLdExtraction:
    def test_jsonld_sameas_detected(self):
        html = """
        <script type="application/ld+json">
        {"@context":"https://schema.org","@type":"Organization",
         "name":"Joe's Barber","sameAs":["https://www.instagram.com/joesbarber/"]}
        </script>
        """
        intel = _run_contact_worker(html)
        assert intel.instagram_url == "https://www.instagram.com/joesbarber/"
        assert intel.instagram_source == "jsonld"


# ---------------------------------------------------------------------------
# 4. Relevant meta Instagram URL is detected.
# ---------------------------------------------------------------------------


class TestMetaTagExtraction:
    def test_meta_content_instagram_detected(self):
        html = '<meta property="og:see_also" content="https://www.instagram.com/joesbarber"/>'
        intel = _run_contact_worker(html)
        assert intel.instagram_url == "https://www.instagram.com/joesbarber/"
        assert intel.instagram_source == "meta"


# ---------------------------------------------------------------------------
# 5. Valid business-specific @handle is detected when context is strong.
# ---------------------------------------------------------------------------


class TestPlainHandleExtraction:
    def test_plain_handle_with_instagram_context_detected(self):
        html = "<p>Instagram: @joesbarber</p>"
        intel = _run_contact_worker(html)
        assert intel.instagram_url == "https://www.instagram.com/joesbarber/"
        assert intel.instagram_source == "plain_handle"

    def test_plain_handle_only_used_when_no_url_present(self):
        # A literal URL elsewhere on the page always wins over a
        # plain-text @handle mention, even if the handle appears first.
        html = (
            '<p>Instagram: @wronghandle</p>'
            '<a href="https://www.instagram.com/joesbarber/">Follow</a>'
        )
        intel = _run_contact_worker(html)
        assert intel.instagram_url == "https://www.instagram.com/joesbarber/"
        assert intel.instagram_source == "anchor_href"


# ---------------------------------------------------------------------------
# 6. Generic "Instagram" text does NOT produce a false positive.
# ---------------------------------------------------------------------------


class TestNoFalsePositives:
    def test_generic_instagram_mention_with_no_handle(self):
        html = "<p>Follow us on Instagram for daily specials!</p>"
        intel = _run_contact_worker(html)
        assert intel.instagram_url is None
        assert intel.instagram_source is None

    def test_at_mention_with_no_nearby_instagram_context_ignored(self):
        html = "<p>Reach the owner directly: @joesbarber</p>"
        intel = _run_contact_worker(html)
        assert intel.instagram_url is None

    def test_literal_word_instagram_as_handle_excluded(self):
        html = "<p>Follow @instagram for platform news.</p>"
        intel = _run_contact_worker(html)
        assert intel.instagram_url is None


# ---------------------------------------------------------------------------
# 7-9. Reserved paths never become a business profile.
# ---------------------------------------------------------------------------


class TestReservedPathsRejected:
    def test_post_path_not_a_profile(self):
        html = '<a href="https://instagram.com/p/CxYz123abc/">post</a>'
        intel = _run_contact_worker(html)
        assert intel.instagram_url is None
        assert intel.instagram_invalid_candidate_seen is True

    def test_reel_path_not_a_profile(self):
        html = '<a href="https://instagram.com/reel/CxYz123abc/">reel</a>'
        intel = _run_contact_worker(html)
        assert intel.instagram_url is None
        assert intel.instagram_invalid_candidate_seen is True

    def test_explore_path_not_a_profile(self):
        html = '<a href="https://instagram.com/explore/tags/bakery/">explore</a>'
        intel = _run_contact_worker(html)
        assert intel.instagram_url is None
        assert intel.instagram_invalid_candidate_seen is True


# ---------------------------------------------------------------------------
# 10-11. Malformed / homepage Instagram URLs rejected.
# ---------------------------------------------------------------------------


class TestMalformedAndHomepageRejected:
    def test_numeric_only_handle_rejected(self):
        html = '<a href="https://instagram.com/12345/">link</a>'
        intel = _run_contact_worker(html)
        assert intel.instagram_url is None

    def test_bare_homepage_link_rejected(self):
        html = '<a href="https://instagram.com/">home</a>'
        intel = _run_contact_worker(html)
        assert intel.instagram_url is None
        # A bare homepage link has no path at all, so it never matches
        # the instagram.com/<path> shape in the first place — this is
        # "never became a candidate", not "candidate rejected".
        assert has_invalid_ig_candidate(html) is False


# ---------------------------------------------------------------------------
# 12. Multiple sources normalize to one canonical URL.
# ---------------------------------------------------------------------------


class TestCanonicalization:
    def test_multiple_shapes_of_same_handle_normalize_identically(self):
        variants = [
            "https://instagram.com/joesbarber",
            "https://www.instagram.com/joesbarber/",
            "https://instagram.com/joesbarber?hl=en",
        ]
        for href in variants:
            html = f'<a href="{href}">IG</a>'
            intel = _run_contact_worker(html)
            assert intel.instagram_url == "https://www.instagram.com/joesbarber/"

    def test_first_source_wins_when_multiple_present_on_page(self):
        html = (
            '<a href="https://instagram.com/first_handle">one</a>'
            '<a href="https://instagram.com/second_handle">two</a>'
        )
        intel = _run_contact_worker(html)
        assert intel.instagram_url == "https://www.instagram.com/first_handle/"


# ---------------------------------------------------------------------------
# 13-14. Existing two-page ContactWorker behavior is unchanged; no
#         third-page crawling was introduced.
# ---------------------------------------------------------------------------


class TestNoNewCrawling:
    def test_only_contact_page_and_final_url_are_fetched(self):
        fetched_urls = []
        worker = ContactWorker()

        def _fake_fetch(url: str) -> Tuple[str, str, float]:
            fetched_urls.append(url)
            return "<html>no instagram here</html>", url, 0.01

        worker._fetch = _fake_fetch  # type: ignore[method-assign]

        website_intel = WebsiteIntel(
            pipeline_id="p1",
            website_reachable=True,
            final_url="https://bakery.com",
            contact_page="https://bakery.com/contact",
        )
        worker.process(website_intel)

        assert set(fetched_urls) == {
            "https://bakery.com",
            "https://bakery.com/contact",
        }
        assert len(fetched_urls) == 2


# ---------------------------------------------------------------------------
# 15. InstagramWorker still short-circuits safely when no URL exists.
# ---------------------------------------------------------------------------


class TestInstagramWorkerUnchanged:
    def test_short_circuit_still_returns_unreachable_no_network_call(self):
        from engine.contracts import BusinessCandidate as _BC
        from workers.instagram_worker import InstagramWorker

        worker = InstagramWorker()

        def _boom(*_args, **_kwargs):
            raise AssertionError("InstagramWorker must not fetch with no URL")

        import urllib.request

        original_urlopen = urllib.request.urlopen
        urllib.request.urlopen = _boom  # type: ignore[assignment]
        try:
            candidate = _BC(
                pipeline_id="p1", session_id="s1", provider="google_maps", name="Joe's"
            )
            intel = worker.process(candidate)
        finally:
            urllib.request.urlopen = original_urlopen  # type: ignore[assignment]

        assert intel.profile_reachable is False
        assert intel.fetch_duration is None


# ---------------------------------------------------------------------------
# 16. Qualification semantics remain unchanged.
# ---------------------------------------------------------------------------


class TestQualificationSemanticsUnchanged:
    def test_discovered_instagram_reaches_qualification(self):
        html = """
        <a href="mailto:hello@bakery.com">Email us</a>
        <a href="tel:+14165550199">Call us</a>
        <script type="application/ld+json">
        {"@type":"Organization","sameAs":["https://www.instagram.com/thebakery/"]}
        </script>
        """
        contact_intel = _run_contact_worker(html)
        assert contact_intel.instagram_url == "https://www.instagram.com/thebakery/"
        assert contact_intel.instagram_source == "jsonld"

        lead = _make_enriched_business(contact_intel=contact_intel)
        worker = QualificationWorker(
            required_channels=("website", "email", "phone", "instagram")
        )
        result = worker.process(lead)

        assert result.qualified is True
        assert result.reasons == ()

    def test_invalid_candidate_still_fails_required_channel(self):
        html = """
        <a href="https://instagram.com/explore/">Explore</a>
        <a href="mailto:hello@bakery.com">Email us</a>
        <a href="tel:+14165550199">Call us</a>
        """
        contact_intel = _run_contact_worker(html)
        assert contact_intel.instagram_url is None
        assert contact_intel.instagram_invalid_candidate_seen is True

        lead = _make_enriched_business(contact_intel=contact_intel)
        worker = QualificationWorker(
            required_channels=("website", "email", "phone", "instagram")
        )
        result = worker.process(lead)

        assert result.qualified is False
        assert "missing required channel: instagram" in result.reasons


# ---------------------------------------------------------------------------
# 17. Telemetry differentiates "worker completed" from "Instagram found".
# ---------------------------------------------------------------------------


class TestTelemetryDistinguishesCompletionFromDiscovery:
    def test_instagram_stage_telemetry_events(self):
        from engine.execution_driver import _instagram_telemetry_events
        from engine.contracts import InstagramIntel

        # Case A: short-circuited (no instagram_url on the candidate at
        # all) — must be attempted + short_circuited, never
        # "profile_reachable".
        short_circuit_intel = InstagramIntel(pipeline_id="p1", profile_reachable=False)
        events = _instagram_telemetry_events(short_circuit_intel, url_input_present=False)
        assert "instagram_attempted" in events
        assert "instagram_short_circuited" in events
        assert "instagram_profile_reachable" not in events
        assert "instagram_url_input_present" not in events

        # Case B: actually reached a profile.
        reached_intel = InstagramIntel(
            pipeline_id="p1",
            profile_reachable=True,
            profile_url="https://www.instagram.com/joes/",
            fetch_duration=0.4,
        )
        events = _instagram_telemetry_events(reached_intel, url_input_present=True)
        assert "instagram_attempted" in events
        assert "instagram_profile_reachable" in events
        assert "instagram_url_input_present" in events
        assert "instagram_short_circuited" not in events

        # Case C: attempted but genuinely unreachable (network failure)
        # — must NOT be counted as short-circuited, since a real
        # request was actually made (fetch_duration is set).
        unreachable_intel = InstagramIntel(
            pipeline_id="p1", profile_reachable=False, fetch_duration=0.2
        )
        events = _instagram_telemetry_events(unreachable_intel, url_input_present=True)
        assert "instagram_attempted" in events
        assert "instagram_short_circuited" not in events
        assert "instagram_profile_reachable" not in events

    def test_contact_stage_discovery_source_telemetry(self):
        from engine.execution_driver import _contact_instagram_discovery_event

        found_intel = ContactIntel(
            pipeline_id="p1",
            instagram_url="https://www.instagram.com/joes/",
            instagram_source="meta",
        )
        assert _contact_instagram_discovery_event(found_intel) == "instagram_discovery_found:meta"

        missing_intel = ContactIntel(pipeline_id="p1")
        assert _contact_instagram_discovery_event(missing_intel) == "instagram_discovery_missing"

        invalid_intel = ContactIntel(
            pipeline_id="p1", instagram_invalid_candidate_seen=True
        )
        assert _contact_instagram_discovery_event(invalid_intel) == "instagram_discovery_invalid"

    def test_end_to_end_telemetry_via_contact_worker_output(self):
        # Ties the pure decision function to an actual ContactWorker
        # run, so this fails if the two ever drift apart.
        from engine.execution_driver import _contact_instagram_discovery_event

        html = '<meta property="og:see_also" content="https://www.instagram.com/joesbarber"/>'
        intel = _run_contact_worker(html)
        assert _contact_instagram_discovery_event(intel) == "instagram_discovery_found:meta"
