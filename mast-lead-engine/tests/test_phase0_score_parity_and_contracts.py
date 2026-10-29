"""
tests/test_phase0_score_parity_and_contracts.py
=================================================

Phase 0 + Phase 1: Authoritative Profession Reconciliation, 100% Score-Parity Harness,
and Python->Node Contract & Scoring-Input Regression Suite.

Scope:
- Reconciles and pins the 12 canonical PROFESSION_SLUGS and normalized WeightVectors.
- Evaluates 100% score parity across all 12 canonical professions for representative
  business fixtures (full healthy, weak/templated website, no website, unreachable
  website, missing/null optional fields, disqualified chain/cannabis, website-discovered
  Instagram, and slow/non-SSL website).
- Verifies that ScoringWorker.process(), engine_enrichment_bridge._enriched_to_dict(),
  and service.score_business_v2() produce 100% identical scores, breakdowns, and health
  scores across all 12 canonical professions after repairing D-1 through D-5.
- Verifies Python-side producer contracts for review_count + reviews (preserving null/unknown),
  maps_url -> maps_link, normalized profession_scores map shape, observable HTML signals
  (seo, blog, tech_stack, growth_signals, website_is_weak), and business context /
  known_channels / required_channels propagation.
"""

from __future__ import annotations

import asyncio
from datetime import datetime, timedelta, timezone
import pytest

from engine.contracts import (
    BusinessCandidate,
    ContactIntel,
    EnrichedBusiness,
    InstagramIntel,
    WebsiteIntel,
)
from engine_enrichment_bridge import (
    _candidate_from_payload,
    _enriched_to_dict,
    enrich_business_with_engine_v2,
)
from opportunity_scoring.professions import PROFESSION_SLUGS, PROFESSION_WEIGHTS
from opportunity_scoring.service import (
    OpportunityScoringService,
    compute_branding_opportunity,
    compute_growth_opportunity,
    compute_newness_opportunity,
    compute_social_opportunity,
    compute_tech_opportunity,
    compute_universal_breakdown,
    compute_website_opportunity,
)
from service import _candidate_dict, score_business_v2
from utils.parsing import is_weak_site
from workers.scoring_worker import ScoringWorker
from workers.website_worker import WebsiteWorker


EXPECTED_CANONICAL_12_PROFESSIONS = (
    "graphic_design",
    "digital_marketing",
    "writing_translation",
    "video_animation",
    "music_audio",
    "programming_tech",
    "data",
    "business",
    "personal_growth_hobbies",
    "photography",
    "finance",
    "end_to_end_project",
)


class TestCanonicalProfessionReconciliation:
    """1. Reconciles the 10-vs-12 profession discrepancy against repository code."""

    def test_canonical_profession_slugs_exact_12(self):
        assert len(PROFESSION_SLUGS) == 12
        assert tuple(PROFESSION_SLUGS) == EXPECTED_CANONICAL_12_PROFESSIONS

    def test_every_canonical_profession_has_normalized_weights(self):
        assert set(PROFESSION_WEIGHTS.keys()) == set(EXPECTED_CANONICAL_12_PROFESSIONS)
        for slug in EXPECTED_CANONICAL_12_PROFESSIONS:
            w = PROFESSION_WEIGHTS[slug]
            total = w.website + w.branding + w.social + w.growth + w.newness + w.tech
            assert abs(total - 1.0) <= 1e-9, f"{slug} weights sum to {total}, expected 1.0"


class TestScoreParityMatrixAcross12Professions:
    """3. Score-parity harness across all 12 canonical professions and edge cases."""

    @staticmethod
    def _recent_iso(days_ago: int = 5) -> str:
        return (datetime.now(timezone.utc) - timedelta(days=days_ago)).isoformat()

    def test_normalized_payload_parity_between_scoring_worker_and_score_business_v2(self):
        """
        When ScoringWorker and score_business_v2 receive the same normalized
        underlying business signals, both call OpportunityScoringService
        and produce 100% identical scores, breakdowns, and health scores across
        all 12 canonical professions.
        """
        recent_post = self._recent_iso(5)
        candidate = BusinessCandidate(
            pipeline_id="biz-parity-1",
            session_id="sess-parity-1",
            provider="google_maps",
            name="Craft Roasters",
            category="Coffee shop",
            website="https://craftroasters.example.com",
            phone="+15552345678",
            rating=4.6,
            review_count=85,
            instagram_url="https://www.instagram.com/craftroasters/",
            has_photos=False,
        )
        website_intel = WebsiteIntel(
            pipeline_id="biz-parity-1",
            website_reachable=True,
            https=True,
            response_time=0.45,
            detected_platform="WordPress",
            website_is_weak=False,
        )
        contact_intel = ContactIntel(
            pipeline_id="biz-parity-1",
            emails=("hello@craftroasters.example.com",),
            phones=("+15552345678",),
            linkedin_url="https://www.linkedin.com/company/craftroasters",
        )
        ig_intel = InstagramIntel(
            pipeline_id="biz-parity-1",
            profile_reachable=True,
            username="craftroasters",
            followers=1800,
            last_post_date=recent_post,
        )
        enriched = EnrichedBusiness(
            pipeline_id="biz-parity-1",
            business=candidate,
            website_intel=website_intel,
            instagram_intel=ig_intel,
            contact_intel=contact_intel,
        )

        worker_score = ScoringWorker().process(enriched)
        bridge_dict = _enriched_to_dict(enriched, worker_score)

        # Construct the equivalent DB payload for score_business_v2
        db_payload = {
            "id": "biz-parity-1",
            "website": "https://craftroasters.example.com",
            "instagram": "https://www.instagram.com/craftroasters/",
            "facebook": None,
            "linkedin": "https://www.linkedin.com/company/craftroasters",
            "has_photos": False,
            "reviews_count": 85,
            "reviews_rating": 4.6,
            "is_disqualified": False,
            "website_is_weak": False,
            "ssl_valid": True,
            "load_time_ms": 450,
            "signals": {
                "ig_last_post_days": 5,
                "tech_stack": {"cms": "WordPress", "detected_platform": "WordPress"},
                "growth_signals": {},
            },
        }
        v2_res = asyncio.run(score_business_v2(db_payload))

        assert len(worker_score.profession_scores) == 12
        assert isinstance(bridge_dict["profession_scores"], dict)
        assert len(bridge_dict["profession_scores"]) == 12
        assert len(v2_res["profession_scores"]) == 12
        assert bridge_dict["health_score"] == v2_res["health_score"]
        assert bridge_dict["universal_breakdown"] == v2_res["universal_breakdown"]

        for ps_obj in worker_score.profession_scores:
            slug = ps_obj.profession_slug
            assert slug in EXPECTED_CANONICAL_12_PROFESSIONS
            assert slug in bridge_dict["profession_scores"]
            assert slug in v2_res["profession_scores"]

            bridge_entry = bridge_dict["profession_scores"][slug]
            v2_entry = v2_res["profession_scores"][slug]
            assert abs(ps_obj.score - v2_entry["score"]) <= 1e-9, f"Mismatch on {slug}"
            assert abs(bridge_entry["score"] - v2_entry["score"]) <= 1e-9
            assert bridge_entry["breakdown"] == v2_entry["breakdown"]
            assert bridge_entry["summary"] == v2_entry["summary"]
            assert bridge_entry["reasons"] == v2_entry["reasons"]

    @pytest.mark.parametrize(
        "fixture_name,biz_payload,expected_checks",
        [
            (
                "full_healthy_business",
                {
                    "id": "fix-healthy",
                    "website": "https://artisan-coffee.com",
                    "instagram": "https://www.instagram.com/artisancoffee/",
                    "has_photos": True,
                    "reviews_count": 250,
                    "reviews_rating": 4.8,
                    "is_disqualified": False,
                    "website_is_weak": False,
                    "ssl_valid": True,
                    "load_time_ms": 800,
                    "seo": {"has_title": True, "has_meta_description": True},
                    "blog": {"has_blog": True, "last_post_days": 10},
                    "signals": {
                        "ig_last_post_days": 3,
                        "tech_stack": {"chat": True, "booking": True, "analytics": True},
                        "growth_signals": {},
                    },
                },
                {"website": 30.0, "branding": 0.0, "social": 10.0, "tech": 10.0},
            ),
            (
                "weak_templated_website_business",
                {
                    "id": "fix-weak-site",
                    "website": "https://beanhouse.wixsite.com/home",
                    "instagram": "https://www.instagram.com/beanhouse/",
                    "has_photos": True,
                    "reviews_count": 25,
                    "reviews_rating": 4.1,
                    "is_disqualified": False,
                    "website_is_weak": True,
                    "ssl_valid": True,
                    "load_time_ms": 1800,
                    "signals": {
                        "ig_last_post_days": 45,
                        "tech_stack": {},
                    },
                },
                {"website": 70.0, "social": 45.0, "tech": 100.0},
            ),
            (
                "no_website_business",
                {
                    "id": "fix-no-site",
                    "website": None,
                    "instagram": None,
                    "has_photos": False,
                    "reviews_count": 12,
                    "reviews_rating": 3.9,
                    "is_disqualified": False,
                    "signals": {},
                },
                {"website": 100.0, "social": 100.0, "tech": 50.0},
            ),
            (
                "missing_unknown_optional_fields",
                {
                    "id": "fix-missing-optional",
                    "website": "https://quiet-cafe.com",
                    "instagram": "https://www.instagram.com/quietcafe/",
                    "has_photos": True,
                    "reviews_count": 50,
                    "reviews_rating": 4.5,
                    "is_disqualified": False,
                    "seo": {},  # Empty dict from deliverLead.ts default `lead.seo ?? {}`
                    "blog": {},
                    "signals": {"ig_last_post_days": None},
                },
                # Missing SEO (`{}`) must NOT be treated as bad SEO (`good_seo=True`),
                # and missing `ig_last_post_days` (`None`) yields neutral social=40.0 (not 85/100).
                {"website": 30.0, "branding": 20.0, "social": 40.0, "tech": 100.0},
            ),
            (
                "disqualified_business",
                {
                    "id": "fix-disqualified",
                    "website": None,
                    "instagram": None,
                    "has_photos": False,
                    "reviews_count": 0,
                    "reviews_rating": 2.0,
                    "is_disqualified": True,
                },
                {"all_zero": True},
            ),
        ],
    )
    def test_12_profession_matrix_fixtures_in_opportunity_scoring_service(
        self, fixture_name: str, biz_payload: dict, expected_checks: dict
    ):
        res = asyncio.run(score_business_v2(biz_payload))
        assert set(res["profession_scores"].keys()) == set(EXPECTED_CANONICAL_12_PROFESSIONS)

        if expected_checks.get("all_zero"):
            assert res["is_disqualified"] is True
            for slug in EXPECTED_CANONICAL_12_PROFESSIONS:
                assert res["profession_scores"][slug]["score"] == 0.0, (
                    f"{fixture_name}: expected 0.0 for {slug}"
                )
            return

        ub = res["universal_breakdown"]
        for comp_key, expected_val in expected_checks.items():
            assert abs(ub[comp_key] - expected_val) <= 1e-6, (
                f"{fixture_name}: component {comp_key}={ub[comp_key]}, expected {expected_val}"
            )

        # Verify each of the 12 profession scores equals the rounded weighted dot product
        for slug in EXPECTED_CANONICAL_12_PROFESSIONS:
            w = PROFESSION_WEIGHTS[slug]
            expected_score = round(
                ub["website"] * w.website
                + ub["branding"] * w.branding
                + ub["social"] * w.social
                + ub["growth"] * w.growth
                + ub["newness"] * w.newness
                + ub["tech"] * w.tech,
                2,
            )
            actual_score = res["profession_scores"][slug]["score"]
            assert abs(actual_score - expected_score) <= 1e-6, (
                f"{fixture_name}/{slug}: actual={actual_score}, expected={expected_score}"
            )
            assert 0.0 <= actual_score <= 100.0


class TestPhase1RepairedScoringDivergences:
    """
    Verifies that all 5 scoring divergences (D-1 through D-5) identified in Phase 0
    are repaired and produce 100% parity between `ScoringWorker.process()` /
    `_enriched_to_dict()` and `score_business_v2()` across all 12 canonical professions.
    """

    def test_repaired_divergence_1_profession_scores_canonical_dict_shape(self):
        """
        D-1 Repair: `_enriched_to_dict()` now emits `profession_scores` as a dict
        keyed by `profession_slug` with keys `score`, `breakdown`, `summary`, `reasons`,
        matching `score_business_v2()` and `EngineScoreResult`.
        """
        cand = BusinessCandidate(
            pipeline_id="div-1",
            session_id="s-1",
            provider="google_maps",
            name="Corner Espresso",
            category="Coffee shop",
            website="https://cornerespresso.example.com",
        )
        enriched = EnrichedBusiness(pipeline_id="div-1", business=cand)
        score_obj = ScoringWorker().process(enriched)
        enrich_dict = _enriched_to_dict(enriched, score_obj)
        score_rpc_dict = asyncio.run(
            score_business_v2({"id": "div-1", "website": "https://cornerespresso.example.com"})
        )

        assert isinstance(enrich_dict["profession_scores"], dict)
        assert set(enrich_dict["profession_scores"].keys()) == set(EXPECTED_CANONICAL_12_PROFESSIONS)
        assert enrich_dict["profession_scores"] == score_rpc_dict["profession_scores"]
        assert enrich_dict["universal_breakdown"] == score_rpc_dict["universal_breakdown"]

    def test_repaired_divergence_2_website_discovered_instagram_used_by_scoring_worker(self):
        """
        D-2 Repair: When Instagram is absent on the Maps card (`business.instagram_url` is None)
        but `ContactWorker` extracts a valid Instagram URL from the business's website
        (`contact_intel.instagram_url`), `ScoringWorker.process()` resolves that Instagram URL
        before scoring. Both `ScoringWorker` and `score_business_v2` produce identical
        `social=40.0`, `branding=40.0`, `health_score`, and all 12 profession scores.
        """
        cand = BusinessCandidate(
            pipeline_id="div-2",
            session_id="s-2",
            provider="google_maps",
            name="Website IG Roasters",
            category="Coffee shop",
            website="https://websiteigroasters.example.com",
            instagram_url=None,  # Not on Maps card
            rating=4.5,
            review_count=40,
            has_photos=False,
        )
        w_intel = WebsiteIntel(
            pipeline_id="div-2",
            website_reachable=True,
            https=True,
        )
        c_intel = ContactIntel(
            pipeline_id="div-2",
            emails=("info@websiteigroasters.example.com",),
            instagram_url="https://www.instagram.com/websiteigroasters/",
        )
        enriched = EnrichedBusiness(
            pipeline_id="div-2",
            business=cand,
            website_intel=w_intel,
            contact_intel=c_intel,
        )

        worker_score = ScoringWorker().process(enriched)
        bridge_dict = _enriched_to_dict(enriched, worker_score)

        assert bridge_dict["instagram"] == "https://www.instagram.com/websiteigroasters/"
        assert worker_score.score_breakdown["social"] == 40.0
        assert worker_score.score_breakdown["branding"] == 40.0

        score_rpc_dict = asyncio.run(
            score_business_v2(
                {
                    "id": "div-2",
                    "website": "https://websiteigroasters.example.com",
                    "instagram": bridge_dict["instagram"],
                    "has_photos": False,
                    "reviews_count": 40,
                    "reviews_rating": 4.5,
                    "is_disqualified": False,
                    "ssl_valid": True,
                }
            )
        )
        assert score_rpc_dict["universal_breakdown"] == worker_score.score_breakdown
        assert score_rpc_dict["health_score"] == worker_score.business_health_score
        assert bridge_dict["profession_scores"] == score_rpc_dict["profession_scores"]

    def test_repaired_divergence_3_website_is_weak_ssl_valid_and_load_time_ms_parity(self):
        """
        D-3 Repair:
        - `ScoringWorker.process()` passes real `load_time_ms` (`round(response_time * 1000)`)
          and `ssl_valid` (`website_intel.https` when reachable, else `None`).
        - `compute_website_opportunity()` treats `website_is_weak is None` (after checking
          `weak_patterns`) identically to `website_is_weak is False`, so `ssl_valid is False`
          (+20.0) and `load_time_ms > 4000` (+10.0) are evaluated consistently in both paths.
        """
        cand = BusinessCandidate(
            pipeline_id="div-3",
            session_id="s-3",
            provider="google_maps",
            name="Slow Insecure Cafe",
            category="Coffee shop",
            website="http://slow-insecure-cafe.com",
        )
        w_intel = WebsiteIntel(
            pipeline_id="div-3",
            website_reachable=True,
            https=False,
            response_time=5.5,  # 5500 ms (> 4000 ms)
        )
        enriched = EnrichedBusiness(pipeline_id="div-3", business=cand, website_intel=w_intel)

        worker_score = ScoringWorker().process(enriched)
        bridge_dict = _enriched_to_dict(enriched, worker_score)

        assert bridge_dict["ssl_valid"] is False
        assert bridge_dict["load_time_ms"] == 5500
        assert bridge_dict["website_is_weak"] is False
        assert worker_score.score_breakdown["website"] == 70.0  # 40 base + 20 no SSL + 10 slow load

        # Even if `website_is_weak` is None in a legacy row, score_business_v2 still computes 70.0:
        score_rpc_none_weak = asyncio.run(
            score_business_v2(
                {
                    "id": "div-3",
                    "website": "http://slow-insecure-cafe.com",
                    "website_is_weak": None,
                    "ssl_valid": False,
                    "load_time_ms": 5500,
                }
            )
        )
        assert score_rpc_none_weak["universal_breakdown"]["website"] == 70.0
        assert bridge_dict["profession_scores"] == score_rpc_none_weak["profession_scores"]

    def test_repaired_divergence_4_has_photos_preserved_in_scoring_worker(self):
        """
        D-4 Repair: `BusinessCandidate.has_photos` is threaded from the database / discovery
        payload into `ScoringWorker.process()`, matching `score_business_v2()`.
        """
        cand = BusinessCandidate(
            pipeline_id="div-4",
            session_id="s-4",
            provider="google_maps",
            name="Photo Rich Bistro",
            category="Coffee shop",
            website="https://photorich.example.com",
            rating=4.6,
            review_count=50,
            has_photos=True,
        )
        enriched = EnrichedBusiness(pipeline_id="div-4", business=cand)
        worker_score = ScoringWorker().process(enriched)
        bridge_dict = _enriched_to_dict(enriched, worker_score)

        score_rpc_with_photos = asyncio.run(
            score_business_v2(
                {
                    "id": "div-4",
                    "website": "https://photorich.example.com",
                    "has_photos": True,
                    "reviews_count": 50,
                    "reviews_rating": 4.6,
                }
            )
        )
        assert worker_score.score_breakdown["branding"] == 40.0
        assert score_rpc_with_photos["universal_breakdown"]["branding"] == 40.0
        assert bridge_dict["profession_scores"] == score_rpc_with_photos["profession_scores"]

    def test_repaired_divergence_5_health_score_parity_with_unreachable_site_and_active_ig(self):
        """
        D-5 Repair:
        - When `website_intel.website_reachable` is False, `ScoringWorker` passes `ssl_valid=None`
          (unknown SSL, never penalizing an unreachable site as insecure HTTP).
        - `score_business_v2` respects `website_reachable` and `signals.ig_last_post_days` when
          computing `health_score`, matching `ScoringWorker.process()`.
        """
        recent_post = (datetime.now(timezone.utc) - timedelta(days=3)).isoformat()
        cand = BusinessCandidate(
            pipeline_id="div-5",
            session_id="s-5",
            provider="google_maps",
            name="Unreachable Site But Active IG",
            category="Coffee shop",
            website="https://unreachable-site.example.com",
            instagram_url="https://www.instagram.com/activeig/",
            rating=4.5,
            review_count=60,
        )
        w_intel = WebsiteIntel(
            pipeline_id="div-5",
            website_reachable=False,
            https=False,
        )
        ig_intel = InstagramIntel(
            pipeline_id="div-5",
            profile_reachable=True,
            last_post_date=recent_post,
        )
        enriched = EnrichedBusiness(
            pipeline_id="div-5",
            business=cand,
            website_intel=w_intel,
            instagram_intel=ig_intel,
        )

        worker_score = ScoringWorker().process(enriched)
        bridge_dict = _enriched_to_dict(enriched, worker_score)

        score_rpc = asyncio.run(
            score_business_v2(
                {
                    "id": "div-5",
                    "website": "https://unreachable-site.example.com",
                    "instagram": "https://www.instagram.com/activeig/",
                    "reviews_rating": 4.5,
                    "reviews_count": 60,
                    "website_reachable": False,
                    "ssl_valid": None,
                    "signals": {"ig_last_post_days": 3},
                }
            )
        )
        assert worker_score.business_health_score == score_rpc["health_score"]
        assert bridge_dict["profession_scores"] == score_rpc["profession_scores"]


class TestPhase1ContractAndSignalRegressions:
    """5. Regression tests for Phase 1 contract fixes and observable HTML signal propagation."""

    def test_contract_1_candidate_dict_emits_both_review_count_and_reviews_preserving_null(self):
        """
        Verifies Deliverable 1:
        `service.py:_candidate_dict()` emits both `"review_count"` and `"reviews"`
        with the exact integer count (or `None` when unknown, never fabricating 0).
        """
        cand = BusinessCandidate(
            pipeline_id="cand-1",
            session_id="sess-1",
            provider="google_maps",
            name="Tiny Review Shop",
            category="Coffee shop",
            website="https://tinyreview.example.com",
            phone="+15550001111",
            rating=4.8,
            review_count=5,
            has_photos=True,
            maps_url="https://www.google.com/maps/place/Tiny+Review+Shop",
        )
        wire_dict = _candidate_dict(cand)

        assert wire_dict["review_count"] == 5
        assert wire_dict["reviews"] == 5
        assert wire_dict["has_photos"] is True

        # Unknown review_count=None stays None on both keys
        unknown_cand = BusinessCandidate(
            pipeline_id="cand-null-rev",
            session_id="sess-1",
            provider="google_maps",
            name="Unknown Review Shop",
            review_count=None,
        )
        unknown_wire = _candidate_dict(unknown_cand)
        assert unknown_wire["review_count"] is None
        assert unknown_wire["reviews"] is None

    def test_contract_2_maps_url_to_maps_link_mapping(self):
        maps_url = "https://www.google.com/maps/place/Test+Cafe/@30.26,-97.74"
        cand = BusinessCandidate(
            pipeline_id="cand-maps",
            session_id="sess-maps",
            provider="google_maps",
            name="Test Cafe",
            maps_url=maps_url,
        )
        wire_dict = _candidate_dict(cand)
        assert wire_dict["maps_link"] == maps_url

        reconstructed = _candidate_from_payload({"name": "Test Cafe", "maps_link": maps_url})
        assert reconstructed.maps_url == maps_url

        enriched = EnrichedBusiness(pipeline_id="cand-maps", business=reconstructed)
        bridge_out = _enriched_to_dict(enriched)
        assert "maps_link" not in bridge_out
        assert "maps_url" not in bridge_out

    def test_observable_html_signals_extracted_and_propagated_to_scoring(self):
        """
        Verifies Deliverables 4 & 5:
        When `WebsiteWorker` decodes reachable HTML, `_extract_html_signals()` extracts
        `seo`, `blog`, `tech_stack` (`booking`, `chat`, `analytics`, `cms`, `detected_platform`),
        `growth_signals` (`hiring`, `new_location`), and `website_is_weak`.
        `ScoringWorker` and `_enriched_to_dict()` propagate these signals to
        `compute_branding_opportunity()`, `compute_tech_opportunity()`, and
        `compute_growth_opportunity()`.
        """
        sample_html = """
        <!doctype html>
        <html>
          <head>
            <title>Specialty Roasters — Austin Coffee</title>
            <meta name="description" content="Freshly roasted specialty coffee in Austin, TX.">
            <meta name="viewport" content="width=device-width, initial-scale=1">
            <script src="https://www.googletagmanager.com/gtm.js?id=GTM-12345"></script>
          </head>
          <body>
            <h1>Welcome to Specialty Roasters</h1>
            <a href="/blog">Read our Coffee Journal</a>
            <a href="/careers">We're hiring baristas!</a>
            <script src="https://calendly.com/assets/external/widget.js"></script>
            <script src="https://widget.intercom.io/widget/abc"></script>
          </body>
        </html>
        """
        title = WebsiteWorker._extract_title(sample_html)
        desc = WebsiteWorker._extract_meta_description(sample_html)
        seo = WebsiteWorker._extract_seo_signals(title, desc)
        blog = WebsiteWorker._extract_blog_signal(sample_html)
        tech_stack = WebsiteWorker._extract_tech_stack(sample_html, "WordPress")
        growth_signals = WebsiteWorker._extract_growth_signals(sample_html)
        website_is_weak = is_weak_site("https://specialtyroasters.example.com")

        assert seo["has_title"] is True
        assert seo["has_meta_description"] is True
        assert blog["has_blog"] is True
        assert tech_stack["booking"] == "calendly"
        assert tech_stack["chat"] == "intercom"
        assert "gtm" in tech_stack["analytics"] or "ga4" in tech_stack["analytics"]
        assert tech_stack["cms"] == "WordPress"
        assert growth_signals["hiring"] is True
        assert website_is_weak is False

        cand = BusinessCandidate(
            pipeline_id="cand-html",
            session_id="sess-html",
            provider="google_maps",
            name="Specialty Roasters",
            website="https://specialtyroasters.example.com",
            instagram_url="https://www.instagram.com/specialtyroasters/",
            rating=4.8,
            review_count=120,
            has_photos=True,
        )
        w_intel = WebsiteIntel(
            pipeline_id="cand-html",
            website_reachable=True,
            https=True,
            response_time=0.6,
            detected_platform="WordPress",
            seo=seo,
            blog=blog,
            tech_stack=tech_stack,
            growth_signals=growth_signals,
            website_is_weak=website_is_weak,
        )
        enriched = EnrichedBusiness(pipeline_id="cand-html", business=cand, website_intel=w_intel)
        score_obj = ScoringWorker().process(enriched)
        bridge_out = _enriched_to_dict(enriched, score_obj)

        # Tech has booking + chat + analytics -> 100 - 90 = 10.0
        assert score_obj.score_breakdown["tech"] == 10.0
        # Branding has photos + instagram + rating>=4.3 + good_seo (4/5 signals, recent_activity=False) -> 20.0
        assert abs(score_obj.score_breakdown["branding"] - 20.0) <= 1e-6
        # And when HTML lacks meta description (`has_meta_description: False`), good_seo is False -> 3/5 -> 40.0
        bad_seo_intel = WebsiteIntel(
            pipeline_id="cand-html",
            website_reachable=True,
            https=True,
            seo={"has_title": True, "has_meta_description": False},
        )
        bad_seo_score = ScoringWorker().process(
            EnrichedBusiness(pipeline_id="cand-html", business=cand, website_intel=bad_seo_intel)
        )
        assert abs(bad_seo_score.score_breakdown["branding"] - 40.0) <= 1e-6
        # Growth has hiring (+30) + active blog (+15) -> 45.0
        assert score_obj.score_breakdown["growth"] == 45.0

        # Bridge output exposes seo, blog, tech_stack, growth_signals, website_is_weak for Node persistence
        assert bridge_out["seo"] == seo
        assert bridge_out["blog"] == blog
        assert bridge_out["tech_stack"] == tech_stack
        assert bridge_out["growth_signals"] == growth_signals
        assert bridge_out["website_is_weak"] is False

    def test_enrichment_bridge_threads_context_known_channels_and_skips_redundant_ig_worker(
        self, monkeypatch
    ):
        """
        Verifies Deliverable 4:
        `enrich_business_with_engine_v2()` threads existing business context
        (`id`, `reviews_count`, `reviews_rating`, `has_photos`, `existing_instagram`,
        `known_channels`, `required_channels`) into the workers and skips `InstagramWorker`
        when only `existing_instagram` context was supplied.
        """
        captured: dict = {}

        class FakeWebsiteWorker:
            def process(self, candidate: BusinessCandidate) -> WebsiteIntel:
                captured["candidate"] = candidate
                return WebsiteIntel(
                    pipeline_id=candidate.pipeline_id,
                    website_reachable=True,
                    https=True,
                    response_time=0.4,
                )

        class FakeContactWorker:
            def __init__(self, required_channels=None):
                captured["required_channels"] = required_channels

            def process(self, website_intel: WebsiteIntel) -> ContactIntel:
                captured["known_channels"] = getattr(website_intel, "known_channels", None)
                captured["region_hint"] = getattr(website_intel, "region_hint", None)
                return ContactIntel(
                    pipeline_id=website_intel.pipeline_id,
                    emails=("owner@contextcafe.com",),
                    phones=("+15125550199",),
                )

        class FakeInstagramWorker:
            def process(self, candidate: BusinessCandidate) -> InstagramIntel:
                captured["ig_worker_called"] = True
                return InstagramIntel(pipeline_id=candidate.pipeline_id)

        monkeypatch.setattr("engine_enrichment_bridge.WebsiteWorker", FakeWebsiteWorker)
        monkeypatch.setattr("engine_enrichment_bridge.ContactWorker", FakeContactWorker)
        monkeypatch.setattr("engine_enrichment_bridge.InstagramWorker", FakeInstagramWorker)

        res = enrich_business_with_engine_v2(
            {
                "id": "biz-ctx-1",
                "name": "Context Cafe",
                "website": "https://contextcafe.com",
                "phone": "+15125550199",
                "email": "existing@contextcafe.com",
                "existing_instagram": "https://www.instagram.com/contextcafe/",
                "has_photos": True,
                "reviews_count": 64,
                "reviews_rating": 4.7,
                "region": "United States",
                "known_channels": {"phone": True, "email": True, "instagram": True},
                "required_channels": ["email", "phone", "instagram"],
            }
        )

        assert captured["candidate"].pipeline_id == "biz-ctx-1"
        assert captured["candidate"].review_count == 64
        assert captured["candidate"].rating == 4.7
        assert captured["candidate"].has_photos is True
        assert captured["candidate"].instagram_url == "https://www.instagram.com/contextcafe/"
        assert set(captured["known_channels"]) == {"phone", "email", "instagram"}
        assert set(captured["required_channels"]) == {"email", "phone", "instagram"}
        assert captured["region_hint"] == "US"
        assert "ig_worker_called" not in captured
        assert res["business_id"] == "biz-ctx-1"
        assert len(res["profession_scores"]) == 12
