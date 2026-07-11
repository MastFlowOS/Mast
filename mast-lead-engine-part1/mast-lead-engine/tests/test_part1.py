"""
Mast Lead Engine — Part 1 Test Suite.

Tests all core modules without requiring a live browser or network.
Run: pytest tests/test_part1.py -v
"""

from __future__ import annotations

import sys
import os
import pytest

# Make the root importable
sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

# ──────────────────────────────────────────────────────────────────────────────
# Parsing tests
# ──────────────────────────────────────────────────────────────────────────────

class TestPhoneNormalization:
    def test_us_10_digit(self):
        from utils.parsing import normalize_phone
        assert normalize_phone("3055551234", region="US") == "+1 (305) 555-1234"

    def test_us_11_digit(self):
        from utils.parsing import normalize_phone
        assert normalize_phone("13055551234", region="US") == "+1 (305) 555-1234"

    def test_tel_href(self):
        from utils.parsing import normalize_phone
        assert normalize_phone("tel:+1-305-555-1234", region="US") == "+1 (305) 555-1234"

    def test_international(self):
        from utils.parsing import normalize_phone
        result = normalize_phone("+44 20 7946 0958")
        assert "44" in result or "0958" in result

    def test_blocklist(self):
        from utils.parsing import is_valid_phone
        assert not is_valid_phone("0000000000")
        assert not is_valid_phone("1111111111")

    def test_too_short(self):
        from utils.parsing import is_valid_phone
        assert not is_valid_phone("12345")

    def test_empty(self):
        from utils.parsing import normalize_phone
        assert normalize_phone(None) == ""
        assert normalize_phone("") == ""


class TestEmailExtraction:
    def test_mailto_link(self):
        from utils.parsing import extract_emails
        html = '<a href="mailto:hello@coffee.com">Email us</a>'
        emails = extract_emails(html)
        assert "hello@coffee.com" in emails

    def test_plain_email(self):
        from utils.parsing import extract_emails
        emails = extract_emails("Contact us: info@thestudio.co.uk")
        assert "info@thestudio.co.uk" in emails

    def test_blocked_noreply(self):
        from utils.parsing import extract_emails
        emails = extract_emails("noreply@wordpress.com for support")
        assert "noreply@wordpress.com" not in emails

    def test_pick_best_own_domain(self):
        from utils.parsing import pick_best_email
        candidates = ["hello@gmail.com", "info@coffeeshop.com", "newsletter@mailchimp.com"]
        best = pick_best_email(candidates, preferred_domain="coffeeshop.com")
        assert best == "info@coffeeshop.com"

    def test_priority_prefix(self):
        from utils.parsing import pick_best_email
        candidates = ["team@thebrew.co", "hello@thebrew.co", "support@thebrew.co"]
        best = pick_best_email(candidates, preferred_domain="thebrew.co")
        assert best in ("hello@thebrew.co", "team@thebrew.co")


class TestCountParsing:
    def test_simple_int(self):
        from utils.parsing import parse_count
        assert parse_count("1234") == 1234

    def test_comma_sep(self):
        from utils.parsing import parse_count
        assert parse_count("1,234") == 1234

    def test_k_suffix(self):
        from utils.parsing import parse_count
        assert parse_count("1.2k") == 1200
        assert parse_count("15K") == 15000

    def test_m_suffix(self):
        from utils.parsing import parse_count
        assert parse_count("2.5M") == 2500000

    def test_arabic_indic(self):
        from utils.parsing import parse_count
        assert parse_count("١٢٣٤") == 1234

    def test_none(self):
        from utils.parsing import parse_count
        assert parse_count(None) is None
        assert parse_count("") is None
        assert parse_count("n/a") is None

    def test_review_count(self):
        from utils.parsing import parse_review_count
        assert parse_review_count("(1,234)") == 1234
        assert parse_review_count("49 reviews") == 49
        assert parse_review_count("2.5K reviews") == 2500
        assert parse_review_count(0) == 0
        assert parse_review_count(None) == 0


class TestURLUtils:
    def test_domain_of(self):
        from utils.parsing import domain_of
        assert domain_of("https://www.coffee.com/about") == "coffee.com"
        assert domain_of("https://coffee.com") == "coffee.com"
        assert domain_of("coffee.com/menu") == "coffee.com"
        assert domain_of(None) == ""

    def test_clean_url_strips_utm(self):
        from utils.parsing import clean_url
        url = "https://coffee.com/menu?utm_source=google&utm_medium=cpc"
        assert "utm_" not in clean_url(url)
        assert "coffee.com/menu" in clean_url(url)

    def test_is_weak_site(self):
        from utils.parsing import is_weak_site
        assert is_weak_site("https://thecoffee.wixsite.com/home")
        assert is_weak_site("https://linktr.ee/thecoffee")
        assert is_weak_site("https://facebook.com/thecoffee")
        assert not is_weak_site("https://thecoffeeshop.com")
        assert is_weak_site(None)

    def test_is_directory_site(self):
        from utils.parsing import is_directory_site
        assert is_directory_site("https://yelp.com/biz/coffee")
        assert is_directory_site("https://tripadvisor.com/place")
        assert not is_directory_site("https://coffee.com")


class TestInstagramUtils:
    def test_extract_ig_urls(self):
        from utils.parsing import extract_ig_urls
        html = '<a href="https://www.instagram.com/thecoffeespot/">IG</a>'
        urls = extract_ig_urls(html)
        assert "https://www.instagram.com/thecoffeespot/" in urls

    def test_ig_non_handles_filtered(self):
        from utils.parsing import extract_ig_urls
        html = '<a href="https://instagram.com/p/abc123/">post</a>'
        urls = extract_ig_urls(html)
        assert len(urls) == 0

    def test_is_real_ig_handle(self):
        from utils.parsing import is_real_ig_handle
        assert is_real_ig_handle("https://instagram.com/thecoffeespot/")
        assert not is_real_ig_handle("https://instagram.com/p/abc123/")
        assert not is_real_ig_handle("https://instagram.com/explore/")


class TestTextNormalization:
    def test_norm_text(self):
        from utils.parsing import norm_text
        assert norm_text("Café Montréal") == "cafe montreal"
        assert norm_text("THE COFFEE SPOT!") == "the coffee spot"
        assert norm_text(None) == ""

    def test_slug(self):
        from utils.parsing import slug
        assert slug("The Coffee Spot") == "the-coffee-spot"


# ──────────────────────────────────────────────────────────────────────────────
# Dedup tests
# ──────────────────────────────────────────────────────────────────────────────

class TestDedup:
    def test_fingerprints_ig(self):
        from storage.dedup import fingerprints_for
        biz = {"instagram": "https://instagram.com/coffeeshop/"}
        keys = fingerprints_for(biz)
        assert "ig:coffeeshop" in keys

    def test_fingerprints_email(self):
        from storage.dedup import fingerprints_for
        biz = {"email": "hello@coffee.com"}
        keys = fingerprints_for(biz)
        assert "email:hello@coffee.com" in keys

    def test_fingerprints_phone(self):
        from storage.dedup import fingerprints_for
        biz = {"phone": "+1 (305) 555-1234"}
        keys = fingerprints_for(biz)
        assert any("tel:" in k for k in keys)

    def test_fingerprints_website(self):
        from storage.dedup import fingerprints_for
        biz = {"website": "https://www.coffee.com/menu"}
        keys = fingerprints_for(biz)
        assert "web:coffee.com" in keys

    def test_fingerprints_name_city(self):
        from storage.dedup import fingerprints_for
        biz = {"name": "The Coffee Spot", "city": "Austin"}
        keys = fingerprints_for(biz)
        assert "name:the coffee spot" in keys
        assert "name:the coffee spot|austin" in keys

    def test_leaddstore_add_and_dedup(self, tmp_path):
        from storage.dedup import LeadStore
        db = tmp_path / "test.db"
        store = LeadStore(db)

        biz = {
            "name": "Test Cafe",
            "email": "info@testcafe.com",
            "city": "Austin",
        }
        is_dup, keys, _ = store.is_duplicate(biz)
        assert not is_dup
        store.add(biz, keys)

        is_dup2, _, matched = store.is_duplicate(biz)
        assert is_dup2
        assert matched is not None

        # Different business with same email = dup
        biz2 = {"name": "Other Place", "email": "info@testcafe.com", "city": "Austin"}
        is_dup3, _, _ = store.is_duplicate(biz2)
        assert is_dup3

    def test_leaddstore_different_businesses_not_dup(self, tmp_path):
        from storage.dedup import LeadStore
        db = tmp_path / "test2.db"
        store = LeadStore(db)

        biz1 = {"name": "Coffee A", "email": "a@cafea.com", "city": "Austin"}
        biz2 = {"name": "Coffee B", "email": "b@cafeb.com", "city": "Austin"}

        is_dup1, keys1, _ = store.is_duplicate(biz1)
        assert not is_dup1
        store.add(biz1, keys1)

        is_dup2, _, _ = store.is_duplicate(biz2)
        assert not is_dup2

    def test_leaddstore_total(self, tmp_path):
        from storage.dedup import LeadStore
        db = tmp_path / "test3.db"
        store = LeadStore(db)
        assert store.total == 0

        biz = {"name": "X", "email": "x@x.com"}
        _, keys, _ = store.is_duplicate(biz)
        store.add(biz, keys)
        assert store.total == 1


# ──────────────────────────────────────────────────────────────────────────────
# Scoring tests
# ──────────────────────────────────────────────────────────────────────────────

class TestScoring:
    def _good_lead(self, **overrides) -> dict:
        base = {
            "name": "The Brew Lab",
            "city": "Austin",
            "country": "US",
            "website": None,
            "instagram": "https://instagram.com/thebrewlab/",
            "email": "hello@thebrewlab.com",
            "phone": "+1 512 555 0123",
            "ig_followers": 800,
            "ig_activity": "VERIFIED",
            "ig_last_post_days": 10,
            "reviews": 45,
            "rating": 4.7,
            "has_photos": True,
            "query": "specialty coffee",
        }
        base.update(overrides)
        return base

    def test_high_score_no_website(self):
        from scoring.scorer import calculate_lead_score
        biz = self._good_lead(website=None)
        score = calculate_lead_score(biz)
        assert score >= 50, f"Expected high score for no-website lead, got {score}"

    def test_lower_score_with_website(self):
        from scoring.scorer import calculate_lead_score
        # Strip IG and contact channels to expose the website opportunity gap
        biz_no_site = {
            "name": "The Brew Lab",
            "city": "Austin",
            "website": None,
            "instagram": "https://instagram.com/thebrewlab/",
            "ig_followers": None,
            "reviews": 30,
            "rating": 4.5,
            "has_photos": True,
        }
        biz_with_site = dict(biz_no_site)
        biz_with_site["website"] = "https://thebrewlab.com"

        score_no_site = calculate_lead_score(biz_no_site)
        score_with_site = calculate_lead_score(biz_with_site)
        assert score_no_site > score_with_site, (
            f"No-site={score_no_site} should > with-site={score_with_site}"
        )

    def test_chain_disqualified(self):
        from scoring.scorer import calculate_lead_score, is_chain
        biz = self._good_lead(name="Starbucks - Austin Downtown")
        assert is_chain(biz["name"])
        score = calculate_lead_score(biz)
        assert score < 20, f"Chain should have very low score, got {score}"

    def test_cannabis_disqualified(self):
        from scoring.scorer import calculate_lead_score, is_cannabis
        biz = self._good_lead(name="The Green Dispensary", query="cannabis dispensary")
        assert is_cannabis(biz)
        score = calculate_lead_score(biz)
        assert score == 0, f"Cannabis should score 0, got {score}"

    def test_low_rating_penalty(self):
        from scoring.scorer import calculate_lead_score
        # Use no-IG, no-contact leads so the rating delta is visible
        base = {
            "name": "The Brew Lab",
            "city": "Austin",
            "website": None,
            "ig_followers": None,
            "has_photos": True,
            "reviews": 40,
        }
        biz_good = dict(base, rating=4.8)
        biz_bad  = dict(base, rating=2.3)
        s_good = calculate_lead_score(biz_good)
        s_bad  = calculate_lead_score(biz_bad)
        assert s_good > s_bad, f"Good rating={s_good} should > bad rating={s_bad}"

    def test_score_tiers(self):
        from scoring.scorer import score_tier
        assert score_tier(95) == "ELITE"
        assert score_tier(75) == "HOT"
        assert score_tier(55) == "WARM"
        assert score_tier(30) == "COLD"

    def test_score_bounds(self):
        from scoring.scorer import calculate_lead_score
        # Min/max boundaries
        worst = {"name": "McDonald's", "rating": 1.5, "reviews": 5000}
        best = {
            "name": "The Brew Lab",
            "website": None,
            "ig_followers": 500,
            "ig_activity": "VERIFIED",
            "ig_last_post_days": 5,
            "email": "hello@brewlab.com",
            "phone": "5125550123",
            "reviews": 80,
            "rating": 4.9,
            "has_photos": True,
            "contact_form": "https://brewlab.com/contact",
        }
        assert 0 <= calculate_lead_score(worst) <= 100
        assert 0 <= calculate_lead_score(best) <= 100

    def test_outreach_viability_pass(self):
        from scoring.scorer import passes_outreach_viability
        biz = {"email": "info@cafe.com", "instagram": "https://instagram.com/cafe/"}
        ok, _ = passes_outreach_viability(biz)
        assert ok

    def test_outreach_viability_fail_no_presence(self):
        from scoring.scorer import passes_outreach_viability
        biz = {"phone": "1234567890"}
        ok, reason = passes_outreach_viability(biz)
        assert not ok
        assert "digital_presence" in reason


# ──────────────────────────────────────────────────────────────────────────────
# Tech stack detection tests
# ──────────────────────────────────────────────────────────────────────────────

class TestTechStack:
    def test_detects_wordpress(self):
        from enrichment.site_crawler import detect_tech_stack
        html = '<link rel="stylesheet" href="/wp-content/themes/main.css">'
        ts = detect_tech_stack(html)
        assert ts["cms"] == "wordpress"

    def test_detects_shopify(self):
        from enrichment.site_crawler import detect_tech_stack
        html = '<script src="https://cdn.shopify.com/s/files/main.js"></script>'
        ts = detect_tech_stack(html)
        assert ts["cms"] == "shopify"

    def test_detects_squarespace(self):
        from enrichment.site_crawler import detect_tech_stack
        html = '<link href="https://static1.squarespace.com/style.css">'
        ts = detect_tech_stack(html)
        assert ts["cms"] == "squarespace"

    def test_detects_ga4(self):
        from enrichment.site_crawler import detect_tech_stack
        html = "gtag('config', 'G-XXXXXXXXXX');"
        ts = detect_tech_stack(html)
        assert "ga4" in ts["analytics"]

    def test_detects_facebook_pixel(self):
        from enrichment.site_crawler import detect_tech_stack
        html = "fbq('init', '12345678'); fbq('track', 'PageView');"
        ts = detect_tech_stack(html)
        assert "facebook_pixel" in ts["ads"]

    def test_no_false_positives(self):
        from enrichment.site_crawler import detect_tech_stack
        html = "<html><body><h1>Hello World</h1></body></html>"
        ts = detect_tech_stack(html)
        assert ts["cms"] is None
        assert ts["analytics"] == []


# ──────────────────────────────────────────────────────────────────────────────
# Runtime utils tests
# ──────────────────────────────────────────────────────────────────────────────

class TestRunStats:
    def test_skip_tracking(self):
        from utils.runtime import RunStats
        stats = RunStats()
        stats.skip("chain_business")
        stats.skip("chain_business")
        stats.skip("ig_followers_>5000")
        assert stats.skipped["chain_business"] == 2
        assert stats.skipped["ig_followers_>5000"] == 1

    def test_summary(self):
        from utils.runtime import RunStats
        stats = RunStats(collected=10, duplicates=5, errors=1)
        summary = stats.summary()
        assert "10" in summary
        assert "5" in summary


class TestScraperConfig:
    def test_fast_mode_reduces_budget(self):
        from utils.runtime import ScraperConfig
        cfg_fast = ScraperConfig(fast=True)
        cfg_normal = ScraperConfig(fast=False)
        assert cfg_fast.site_contact_page_budget < cfg_normal.site_contact_page_budget
        assert cfg_fast.scroll_max_rounds < cfg_normal.scroll_max_rounds


# ──────────────────────────────────────────────────────────────────────────────
# Output writer tests (no file I/O assertions — just smoke tests)
# ──────────────────────────────────────────────────────────────────────────────

class TestOutputWriters:
    def _make_lead(self) -> dict:
        return {
            "name": "The Brew Lab",
            "city": "Austin",
            "country": "US",
            "email": "hello@brewlab.com",
            "phone": "+1 512 555 0123",
            "website": None,
            "instagram": "https://instagram.com/brewlab/",
            "facebook": "",
            "contact_form": "",
            "maps_link": "https://maps.google.com/?cid=123",
            "rating": 4.7,
            "reviews": 45,
            "score": 82,
            "tier": "HOT",
            "quality": "HOT",
            "action": "PRIORITY — CONTACT FIRST",
            "ig_followers": 800,
            "tech_stack": {"cms": "squarespace", "analytics": ["ga4"]},
        }

    def test_csv_writer(self, tmp_path):
        from utils.output import CSVWriter
        with CSVWriter(output_dir=tmp_path) as w:
            w.write(self._make_lead())
            assert w.count == 1
        assert w.path.exists()
        content = w.path.read_text()
        assert "The Brew Lab" in content

    def test_jsonl_writer(self, tmp_path):
        from utils.output import JSONLWriter
        import json
        with JSONLWriter(output_dir=tmp_path) as w:
            w.write(self._make_lead())
            assert w.count == 1
        lines = w.path.read_text().strip().splitlines()
        assert len(lines) == 1
        parsed = json.loads(lines[0])
        assert parsed["name"] == "The Brew Lab"

    def test_flatten_booleans(self):
        from utils.output import _flatten
        lead = {"has_photos": True, "closed": False, "ig_private": False}
        flat = _flatten(lead)
        assert flat["has_photos"] == "Yes"
        assert flat["closed"] == "No"

    def test_flatten_tech_stack(self):
        from utils.output import _flatten
        lead = {
            "tech_stack": {
                "cms": "shopify",
                "analytics": ["ga4", "hotjar"],
                "ads": ["facebook_pixel"],
            }
        }
        flat = _flatten(lead)
        assert flat["tech_stack_cms"] == "shopify"
        assert "ga4" in flat["tech_stack_analytics"]
        assert "facebook_pixel" in flat["tech_stack_ads"]
