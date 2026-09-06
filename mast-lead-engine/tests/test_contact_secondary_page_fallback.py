"""
Tests for ContactWorker secondary-page fallback fix.
===================================================

Verifies:
1. homepage succeeds + no secondary link + budget remains
   -> fallback candidate is attempted.
2. homepage succeeds + real secondary link exists
   -> real link remains preferred over fallback.
3. fetch budget exhausted
   -> fallback does not run.
4. required channels already satisfied
   -> fallback does not run.
5. fallback URL already fetched
   -> duplicate fetch prevented.
6. fallback candidate fetches successfully
   -> normal Instagram/contact extraction runs.
7. fallback fetch fails
   -> existing failure/recovery behavior preserved.
8. non-Instagram/contact missions behave as before.
9. no change to maximum fetch count.
"""

from __future__ import annotations

import os
import sys
from unittest.mock import MagicMock, patch

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

from engine.contracts import (
    BusinessCandidate,
    ContactIntel,
    WebsiteIntel,
)
from workers.contact_worker import ContactWorker


def _make_worker_with_responses(url_map: dict[str, str | Exception]) -> ContactWorker:
    """Helper to mock ContactWorker._fetch with URL -> html or exception."""
    worker = ContactWorker()

    def fake_fetch(url: str):
        clean = url.strip()
        for k, v in url_map.items():
            if k.rstrip("/").lower() == clean.rstrip("/").lower():
                if isinstance(v, Exception):
                    raise v
                return v, clean, 0.05
        raise ConnectionError(f"404 Not Found: {url}")

    worker._fetch = MagicMock(side_effect=fake_fetch)
    return worker


class TestContactSecondaryPageFallback:
    """Focused tests for contact secondary-page fallback behavior."""

    # ── Test 1: homepage succeeds + no secondary link + budget remains ─────────
    def test_1_homepage_succeeds_no_secondary_link_fallback_attempted(self):
        """When homepage succeeds but has no secondary links and budget remains, fallback is attempted."""
        worker = ContactWorker()
        fetched_urls = []

        def mock_fetch(url: str):
            fetched_urls.append(url.strip())
            if url.rstrip("/").lower() == "https://cafe.com":
                # Homepage without any secondary links or contact info
                return "<html><body><h1>Welcome to Cafe</h1></body></html>", url, 0.05
            if "contact" in url:
                return (
                    '<html><body><a href="mailto:hello@cafe.com">Mail</a><a href="tel:5551234567">Call</a><a href="https://instagram.com/cafe_official">IG</a></body></html>',
                    url,
                    0.05,
                )
            raise ConnectionError(f"404: {url}")

        with patch.object(worker, "_fetch", side_effect=mock_fetch):
            item = WebsiteIntel(pipeline_id="p-fb-1", final_url="https://cafe.com")
            intel = worker.process(item)

        assert intel.secondary_fallback_attempted is True
        assert intel.secondary_fallback_success is True
        assert intel.secondary_fallback_url == "https://cafe.com/contact"
        assert intel.emails == ("hello@cafe.com",)
        assert intel.instagram_url == "https://www.instagram.com/cafe_official/"
        assert intel.secondary_page_fetched is True
        assert len(fetched_urls) == 2
        assert "https://cafe.com" in fetched_urls
        assert "https://cafe.com/contact" in fetched_urls

    # ── Test 2: homepage succeeds + real secondary link exists ─────────────────
    def test_2_homepage_succeeds_real_link_preferred_over_fallback(self):
        """Discovered real link in HTML remains strictly preferred over guessed fallback candidates."""
        worker = ContactWorker()
        fetched_urls = []

        def mock_fetch(url: str):
            fetched_urls.append(url.strip())
            if url.rstrip("/").lower() == "https://cafe.com":
                # Discovered link to custom page /our-team
                return '<html><body><a href="/our-team">Our Team</a></body></html>', url, 0.05
            if "our-team" in url:
                return (
                    '<html><body><a href="mailto:team@cafe.com">Team</a><a href="tel:5551234567">Call</a><a href="https://instagram.com/cafe_official">IG</a></body></html>',
                    url,
                    0.05,
                )
            if "contact" in url:
                return '<html><body><a href="mailto:fallback@cafe.com">Fallback</a></body></html>', url, 0.05
            raise ConnectionError(f"404: {url}")

        with patch.object(worker, "_fetch", side_effect=mock_fetch):
            item = WebsiteIntel(pipeline_id="p-fb-2", final_url="https://cafe.com")
            intel = worker.process(item)

        # Real link was used, NOT fallback
        assert intel.secondary_page_fetched is True
        assert intel.secondary_page_type == "team"
        assert intel.secondary_fallback_attempted is False
        assert intel.emails == ("team@cafe.com",)
        assert "https://cafe.com/our-team" in fetched_urls
        assert "https://cafe.com/contact" not in fetched_urls

    # ── Test 3: fetch budget exhausted ─────────────────────────────────────────
    def test_3_fetch_budget_exhausted_fallback_does_not_run(self):
        """When 3 fetches are already used, fallback does not run."""
        worker = ContactWorker()
        fetched_urls = []

        def mock_fetch(url: str):
            fetched_urls.append(url.strip())
            # Neither has contact info
            return '<html><body><a href="/about">About</a></body></html>', url, 0.05

        with patch.object(worker, "_fetch", side_effect=mock_fetch):
            item = WebsiteIntel(
                pipeline_id="p-fb-3",
                final_url="https://cafe.com",
                contact_page="https://cafe.com/contact",
            )
            intel = worker.process(item)

        # Primary fetched contact_page (1) and final_url (2).
        # Discovered /about was fetched as secondary (3).
        # Total fetches = 3. Fallback must NOT run any further fetch.
        assert len(fetched_urls) == 3
        assert intel.secondary_fallback_attempted is False

    # ── Test 4: required channels already satisfied ────────────────────────────
    def test_4_required_channels_already_satisfied_fallback_does_not_run(self):
        """When all required channels are already present on homepage, fallback does not run."""
        worker = ContactWorker()
        fetched_urls = []

        def mock_fetch(url: str):
            fetched_urls.append(url.strip())
            return (
                '<html><body>'
                '<a href="mailto:info@cafe.com">Mail</a>'
                '<a href="tel:5551234567">Tel</a>'
                '<a href="https://instagram.com/cafe_official">IG</a>'
                '</body></html>',
                url,
                0.05,
            )

        with patch.object(worker, "_fetch", side_effect=mock_fetch):
            item = WebsiteIntel(pipeline_id="p-fb-4", final_url="https://cafe.com")
            intel = worker.process(item)

        assert len(fetched_urls) == 1
        assert intel.secondary_fallback_attempted is False
        assert intel.emails == ("info@cafe.com",)
        assert intel.phones is not None
        assert intel.instagram_url == "https://www.instagram.com/cafe_official/"

    # ── Test 5: fallback URL already fetched ────────────────────────────────────
    def test_5_fallback_url_already_fetched_duplicate_prevented(self):
        """If a standard candidate was already fetched as contact_page, it is not fetched again."""
        worker = ContactWorker()
        fetched_urls = []

        def mock_fetch(url: str):
            fetched_urls.append(url.strip())
            if url.rstrip("/").lower() == "https://cafe.com/contact":
                # Contact page had no IG or emails
                return "<html><body>Contact info coming soon</body></html>", url, 0.05
            if url.rstrip("/").lower() == "https://cafe.com":
                # Homepage had no links
                return "<html><body>Welcome</body></html>", url, 0.05
            if url.rstrip("/").lower() == "https://cafe.com/contact-us":
                # Next candidate in priority after /contact
                return '<html><body><a href="https://instagram.com/cafe_official">IG</a></body></html>', url, 0.05
            raise ConnectionError(f"404: {url}")

        with patch.object(worker, "_fetch", side_effect=mock_fetch):
            item = WebsiteIntel(
                pipeline_id="p-fb-5",
                final_url="https://cafe.com",
                contact_page="https://cafe.com/contact",
            )
            intel = worker.process(item)

        # /contact was already tried in primary fetches.
        # Fallback should pick /contact-us, NOT repeat /contact.
        assert fetched_urls.count("https://cafe.com/contact") == 1
        assert "https://cafe.com/contact-us" in fetched_urls
        assert intel.secondary_fallback_attempted is True
        assert intel.secondary_fallback_url == "https://cafe.com/contact-us"
        assert intel.instagram_url == "https://www.instagram.com/cafe_official/"

    # ── Test 6: fallback candidate fetches successfully ────────────────────────
    def test_6_fallback_candidate_fetches_successfully_extracts_contact(self):
        """Fallback candidate extraction populates normal ContactIntel fields."""
        worker = ContactWorker()

        def mock_fetch(url: str):
            if url.rstrip("/").lower() == "https://bakery.com":
                return "<html><body>Welcome to Bakery</body></html>", url, 0.05
            if url.rstrip("/").lower() == "https://bakery.com/contact":
                return (
                    '<html><head><script type="application/ld+json">'
                    '{"@context":"https://schema.org","@type":"LocalBusiness",'
                    '"email":"orders@bakery.com","telephone":"+1-212-555-0188",'
                    '"url":"https://bakery.com"}'
                    '</script></head><body>'
                    '<a href="https://www.instagram.com/bakery_ny/">Follow us</a>'
                    '</body></html>',
                    url,
                    0.05,
                )
            raise ConnectionError(f"404: {url}")

        with patch.object(worker, "_fetch", side_effect=mock_fetch):
            item = WebsiteIntel(pipeline_id="p-fb-6", final_url="https://bakery.com")
            intel = worker.process(item)

        assert intel.secondary_fallback_attempted is True
        assert intel.secondary_fallback_success is True
        assert intel.secondary_fallback_fetch_failed is False
        assert intel.emails == ("orders@bakery.com",)
        assert intel.email_source == "jsonld"
        assert intel.phones is not None
        assert any("555-0188" in p or "5550188" in p for p in intel.phones)
        assert intel.instagram_url == "https://www.instagram.com/bakery_ny/"

    # ── Test 7: fallback fetch fails ───────────────────────────────────────────
    def test_7_fallback_fetch_fails_tries_alternate_and_preserves_error(self):
        """When initial fallback candidate 404s, tries alternate standard candidate within budget."""
        worker = ContactWorker()
        fetched_urls = []

        def mock_fetch(url: str):
            fetched_urls.append(url.strip())
            if url.rstrip("/").lower() == "https://bakery.com":
                return "<html><body>Welcome</body></html>", url, 0.05
            if url.rstrip("/").lower() == "https://bakery.com/contact":
                # First fallback candidate 404s
                raise ConnectionError("404 Not Found")
            if url.rstrip("/").lower() == "https://bakery.com/contact-us":
                # Alternate standard candidate succeeds
                return '<html><body><a href="https://instagram.com/bakery_ig">IG</a></body></html>', url, 0.05
            raise ConnectionError(f"404: {url}")

        with patch.object(worker, "_fetch", side_effect=mock_fetch):
            item = WebsiteIntel(pipeline_id="p-fb-7", final_url="https://bakery.com")
            intel = worker.process(item)

        assert len(fetched_urls) == 3
        assert "https://bakery.com" in fetched_urls
        assert "https://bakery.com/contact" in fetched_urls
        assert "https://bakery.com/contact-us" in fetched_urls
        assert intel.secondary_fallback_attempted is True
        assert intel.secondary_fallback_success is True
        assert intel.secondary_fallback_fetch_failed is False
        assert intel.instagram_url == "https://www.instagram.com/bakery_ig/"

    # ── Test 8: non-Instagram/contact missions behave as before ─────────────────
    def test_8_mission_specific_required_channels(self):
        """Missions with specific required_channels stop once those specific channels are satisfied."""
        # Worker only requires 'phone'
        worker = ContactWorker(required_channels=("phone",))
        fetched_urls = []

        def mock_fetch(url: str):
            fetched_urls.append(url.strip())
            # Homepage only has phone
            return '<html><body><a href="tel:5551234567">Call</a></body></html>', url, 0.05

        with patch.object(worker, "_fetch", side_effect=mock_fetch):
            item = WebsiteIntel(pipeline_id="p-fb-8", final_url="https://phoneonly.com")
            intel = worker.process(item)

        # Phone is satisfied, email and instagram are NOT required, so no secondary fallback fetch!
        assert len(fetched_urls) == 1
        assert intel.secondary_fallback_attempted is False
        assert intel.phones is not None

        # Worker requires 'instagram' only
        worker_ig = ContactWorker(required_channels=("instagram",))
        fetched_urls_ig = []

        def mock_fetch_ig(url: str):
            fetched_urls_ig.append(url.strip())
            if url.rstrip("/").lower() == "https://igonly.com":
                return "<html><body>Welcome</body></html>", url, 0.05
            if "contact" in url:
                return '<html><body><a href="https://instagram.com/igonly">IG</a></body></html>', url, 0.05
            raise ConnectionError("404")

        with patch.object(worker_ig, "_fetch", side_effect=mock_fetch_ig):
            item_ig = WebsiteIntel(pipeline_id="p-fb-8-ig", final_url="https://igonly.com")
            intel_ig = worker_ig.process(item_ig)

        # Instagram was missing on homepage, so fallback ran and found it
        assert intel_ig.secondary_fallback_attempted is True
        assert intel_ig.instagram_url == "https://www.instagram.com/igonly/"
        assert len(fetched_urls_ig) == 2

    # ── Test 9: no change to maximum fetch count ───────────────────────────────
    def test_9_maximum_fetch_count_strictly_capped_at_three(self):
        """Under all failure modes, total fetches never exceed 3."""
        worker = ContactWorker()
        fetch_count = 0

        def mock_fetch(url: str):
            nonlocal fetch_count
            fetch_count += 1
            if url.rstrip("/").lower() == "https://tough.com":
                return "<html><body>No links here</body></html>", url, 0.05
            # Everything else fails
            raise ConnectionError("500 Server Error")

        with patch.object(worker, "_fetch", side_effect=mock_fetch):
            item = WebsiteIntel(pipeline_id="p-fb-9", final_url="https://tough.com")
            intel = worker.process(item)

        # 1 homepage + 1 /contact (failed) + 1 /contact-us (failed) = 3 fetches
        assert fetch_count == 3
        assert intel.secondary_fallback_attempted is True
        assert intel.secondary_fallback_fetch_failed is True
        assert intel.secondary_page_fetch_failed is True

    # ── Follow-Up Test 1: Fallback succeeds but yields nothing -> next tried ──
    def test_followup_1_fallback_succeeds_yields_nothing_tries_next_candidate(self):
        """When first fallback candidate succeeds but yields no required info, next candidate is tried while budget remains."""
        worker = ContactWorker()
        fetched_urls = []

        def mock_fetch(url: str):
            fetched_urls.append(url.strip())
            if url.rstrip("/").lower() == "https://cafe.com":
                return "<html><body>Homepage without contact info</body></html>", url, 0.05
            if url.rstrip("/").lower() == "https://cafe.com/contact":
                # First fallback succeeds, but yields no required channels
                return "<html><body>Under construction</body></html>", url, 0.05
            if url.rstrip("/").lower() == "https://cafe.com/contact-us":
                # Second fallback succeeds and yields Instagram
                return '<html><body><a href="https://instagram.com/cafe_nyc">IG</a></body></html>', url, 0.05
            raise ConnectionError(f"404: {url}")

        with patch.object(worker, "_fetch", side_effect=mock_fetch):
            item = WebsiteIntel(pipeline_id="p-tight-1", final_url="https://cafe.com")
            intel = worker.process(item)

        assert len(fetched_urls) == 3
        assert fetched_urls == [
            "https://cafe.com",
            "https://cafe.com/contact",
            "https://cafe.com/contact-us",
        ]
        assert intel.secondary_fallback_attempted is True
        assert intel.secondary_fallback_success is True
        assert intel.instagram_url == "https://www.instagram.com/cafe_nyc/"

    # ── Follow-Up Test 2: First fallback succeeds and satisfies Instagram ─────
    def test_followup_2_first_fallback_satisfies_instagram_no_additional_fetch(self):
        """When first fallback succeeds and satisfies missing Instagram, stops immediately without extra fetches."""
        # Email and phone already found on homepage, only Instagram is missing
        worker = ContactWorker()
        fetched_urls = []

        def mock_fetch(url: str):
            fetched_urls.append(url.strip())
            if url.rstrip("/").lower() == "https://cafe.com":
                return (
                    '<html><body><a href="mailto:info@cafe.com">Mail</a>'
                    '<a href="tel:5551234567">Tel</a></body></html>',
                    url,
                    0.05,
                )
            if url.rstrip("/").lower() == "https://cafe.com/contact":
                return '<html><body><a href="https://instagram.com/cafe_nyc">IG</a></body></html>', url, 0.05
            raise ConnectionError(f"404: {url}")

        with patch.object(worker, "_fetch", side_effect=mock_fetch):
            item = WebsiteIntel(pipeline_id="p-tight-2", final_url="https://cafe.com")
            intel = worker.process(item)

        # 1 homepage + 1 /contact = 2 fetches. Requirements now satisfied -> stops!
        assert len(fetched_urls) == 2
        assert intel.instagram_url == "https://www.instagram.com/cafe_nyc/"
        assert intel.emails == ("info@cafe.com",)
        assert intel.phones is not None

    # ── Follow-Up Test 3: First fallback fails -> next tried ──────────────────
    def test_followup_3_first_fallback_fails_next_tried(self):
        """When first fallback fails (e.g. 404), next fallback candidate is tried."""
        worker = ContactWorker()
        fetched_urls = []

        def mock_fetch(url: str):
            fetched_urls.append(url.strip())
            if url.rstrip("/").lower() == "https://cafe.com":
                return "<html><body>Welcome</body></html>", url, 0.05
            if url.rstrip("/").lower() == "https://cafe.com/contact":
                raise ConnectionError("404 Not Found")
            if url.rstrip("/").lower() == "https://cafe.com/contact-us":
                return '<html><body><a href="https://instagram.com/cafe_nyc">IG</a></body></html>', url, 0.05
            raise ConnectionError(f"404: {url}")

        with patch.object(worker, "_fetch", side_effect=mock_fetch):
            item = WebsiteIntel(pipeline_id="p-tight-3", final_url="https://cafe.com")
            intel = worker.process(item)

        assert len(fetched_urls) == 3
        assert fetched_urls[0] == "https://cafe.com"
        assert fetched_urls[1] == "https://cafe.com/contact"
        assert fetched_urls[2] == "https://cafe.com/contact-us"
        assert intel.secondary_fallback_success is True
        assert intel.instagram_url == "https://www.instagram.com/cafe_nyc/"

    # ── Follow-Up Test 4: Three total fetches reached -> stop ─────────────────
    def test_followup_4_three_total_fetches_reached_stops(self):
        """When 3 total fetches are reached, crawl stops even if info is still missing."""
        worker = ContactWorker()
        fetched_urls = []

        def mock_fetch(url: str):
            fetched_urls.append(url.strip())
            return "<html><body>Nothing useful here</body></html>", url, 0.05

        with patch.object(worker, "_fetch", side_effect=mock_fetch):
            item = WebsiteIntel(
                pipeline_id="p-tight-4",
                final_url="https://cafe.com",
                contact_page="https://cafe.com/contact",
            )
            intel = worker.process(item)

        # Primary fetched contact_page (1) + final_url (2).
        # Fallback fetched /contact-us (3).
        # Budget exhausted at 3 fetches -> stops!
        assert len(fetched_urls) == 3
        assert intel.secondary_fallback_attempted is True

    # ── Follow-Up Test 5: All fallback candidates exhausted -> stop ───────────
    def test_followup_5_all_fallback_candidates_exhausted_stops(self):
        """When no more untried fallback candidates exist, stops gracefully."""
        worker = ContactWorker()
        fetched_urls = []

        def mock_fetch(url: str):
            fetched_urls.append(url.strip())
            return "<html><body>Blank</body></html>", url, 0.05

        with patch(
            "workers.contact_worker.get_standard_contact_candidates",
            side_effect=[
                [("contact", "https://cafe.com/only-one")],  # first call
                [],  # second call: exhausted
            ],
        ):
            with patch.object(worker, "_fetch", side_effect=mock_fetch):
                item = WebsiteIntel(pipeline_id="p-tight-5", final_url="https://cafe.com")
                intel = worker.process(item)

        # 1 homepage + 1 only-one = 2 fetches. Then candidates exhausted -> stops gracefully at 2.
        assert len(fetched_urls) == 2
        assert "https://cafe.com/only-one" in fetched_urls

    # ── Follow-Up Test 6: Existing real secondary link takes priority ─────────
    def test_followup_6_real_secondary_link_still_takes_priority(self):
        """Real discovered secondary link in HTML is still fetched before any standard fallback candidate."""
        worker = ContactWorker()
        fetched_urls = []

        def mock_fetch(url: str):
            fetched_urls.append(url.strip())
            if url.rstrip("/").lower() == "https://cafe.com":
                return '<html><body><a href="/our-team">Meet Team</a></body></html>', url, 0.05
            if url.rstrip("/").lower() == "https://cafe.com/our-team":
                # Real link satisfies Instagram and contact
                return (
                    '<html><body><a href="mailto:team@cafe.com">Mail</a>'
                    '<a href="tel:5551234567">Tel</a>'
                    '<a href="https://instagram.com/cafe_team">IG</a></body></html>',
                    url,
                    0.05,
                )
            if "contact" in url:
                return '<html><body>Fallback</body></html>', url, 0.05
            raise ConnectionError(f"404: {url}")

        with patch.object(worker, "_fetch", side_effect=mock_fetch):
            item = WebsiteIntel(pipeline_id="p-tight-6", final_url="https://cafe.com")
            intel = worker.process(item)

        # Discovered link was fetched (fetch 2), satisfied all info, fallback never attempted
        assert len(fetched_urls) == 2
        assert fetched_urls == ["https://cafe.com", "https://cafe.com/our-team"]
        assert intel.secondary_fallback_attempted is False
        assert intel.secondary_page_type == "team"
        assert intel.instagram_url == "https://www.instagram.com/cafe_team/"

