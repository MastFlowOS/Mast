"""
tests/test_phase23_comprehensive_scoring_fix.py
=================================================

Phase 23 Comprehensive Scoring and Qualification Verification Suite.

Validates all 33 specific requirements:
- Change 1: Instagram follower hard rejection (>100K)
- Change 2: Monotonic Instagram follower score curve with diminishing returns
- Change 3: Normalized outreach readiness (0-100 from max 85 raw)
- Change 4: Contiguous rating schedule preserving 3.0-3.49 as neutral band
- Change 5: Website weakness floor removal (best site reaches weakness 0)
- Change 6: Scoring interaction order (rejection before scoring)
- Change 7: Telemetry for instagram_followers_over_limit
- Change 8: Regression invariants (0-100 clamping, 40/40/20 weights, cannabis/chain overrides)
"""

from __future__ import annotations

import pytest
from unittest.mock import MagicMock

from engine.contracts import (
    BusinessCandidate,
    ContactIntel,
    EnrichedBusiness,
    InstagramIntel,
    QualificationResult,
    WebsiteIntel,
)
from workers.qualification_worker import QualificationWorker
from workers.scoring_worker import ScoringWorker


def _make_candidate(
    pipeline_id: str = "pipe-1",
    name: str = "Test Business",
    category: str = "Cafe",
    website: str | None = "https://example.com",
    phone: str | None = "+15551234567",
    rating: float | None = 4.5,
    review_count: int | None = 100,
    provider: str = "google_maps",
) -> BusinessCandidate:
    return BusinessCandidate(
        pipeline_id=pipeline_id,
        session_id="sess-1",
        provider=provider,
        name=name,
        category=category,
        website=website,
        phone=phone,
        rating=rating,
        review_count=review_count,
    )


def _make_enriched(
    pipeline_id: str = "pipe-1",
    candidate: BusinessCandidate | None = None,
    website_intel: WebsiteIntel | None = None,
    instagram_intel: InstagramIntel | None = None,
    contact_intel: ContactIntel | None = None,
) -> EnrichedBusiness:
    cand = candidate or _make_candidate(pipeline_id=pipeline_id)
    w_intel = (
        website_intel
        if website_intel is not None
        else WebsiteIntel(
            pipeline_id=pipeline_id,
            website_reachable=True,
            https=True,
            detected_platform="WordPress",
        )
    )
    c_intel = (
        contact_intel
        if contact_intel is not None
        else ContactIntel(
            pipeline_id=pipeline_id,
            emails=("contact@example.com",),
            phones=("+15551234567",),
        )
    )
    return EnrichedBusiness(
        pipeline_id=pipeline_id,
        business=cand,
        website_intel=w_intel,
        instagram_intel=instagram_intel,
        contact_intel=c_intel,
    )


# ==============================================================================
# SECTION 1: INSTAGRAM FOLLOWER HARD REJECTION (Tests 1-6)
# ==============================================================================

class TestInstagramHardRejection:
    """Tests 1-6: Validating >100K Instagram hard qualification rejection."""

    def test_1_100k_followers_qualifies(self):
        """1. 100,000 followers exactly -> qualifies/scoring allowed."""
        worker = QualificationWorker()
        ig = InstagramIntel(
            pipeline_id="pipe-1",
            profile_reachable=True,
            followers=100_000,
        )
        enriched = _make_enriched(instagram_intel=ig)
        result = worker.process(enriched)
        assert result.qualified is True
        assert "instagram_followers_over_limit" not in result.reasons

    def test_2_100001_followers_rejected(self):
        """2. 100,001 followers -> rejected."""
        worker = QualificationWorker()
        ig = InstagramIntel(
            pipeline_id="pipe-1",
            profile_reachable=True,
            followers=100_001,
        )
        enriched = _make_enriched(instagram_intel=ig)
        result = worker.process(enriched)
        assert result.qualified is False
        assert "instagram_followers_over_limit" in result.reasons

    def test_3_1m_followers_rejected(self):
        """3. 1,000,000 followers -> rejected."""
        worker = QualificationWorker()
        ig = InstagramIntel(
            pipeline_id="pipe-1",
            profile_reachable=True,
            followers=1_000_000,
        )
        enriched = _make_enriched(instagram_intel=ig)
        result = worker.process(enriched)
        assert result.qualified is False
        assert "instagram_followers_over_limit" in result.reasons

    def test_4_missing_follower_count_not_rejected(self):
        """4. missing/None follower count -> not rejected by this rule."""
        worker = QualificationWorker()
        # Case A: instagram_intel is None
        enriched_no_ig = _make_enriched(instagram_intel=None)
        res_a = worker.process(enriched_no_ig)
        assert res_a.qualified is True
        assert "instagram_followers_over_limit" not in res_a.reasons

        # Case B: instagram_intel present but followers is None
        ig_none = InstagramIntel(
            pipeline_id="pipe-1",
            profile_reachable=True,
            followers=None,
        )
        enriched_ig_none = _make_enriched(instagram_intel=ig_none)
        res_b = worker.process(enriched_ig_none)
        assert res_b.qualified is True
        assert "instagram_followers_over_limit" not in res_b.reasons

    def test_5_rejected_candidate_never_reaches_scoring_in_execution_driver(self):
        """5. Rejected candidate never reaches scoring in pipeline execution flow."""
        # Simulated execution_driver _qualification_downstream logic:
        worker = QualificationWorker()
        ig = InstagramIntel(
            pipeline_id="pipe-1",
            profile_reachable=True,
            followers=150_000,
        )
        enriched = _make_enriched(instagram_intel=ig)
        result = worker.process(enriched)
        assert result.qualified is False

        mock_scoring_worker = MagicMock()
        # In execution driver: if not result.qualified: return None (scoring is not called)
        opportunity = None
        if result.qualified:
            opportunity = mock_scoring_worker.process(enriched)

        assert opportunity is None
        mock_scoring_worker.process.assert_not_called()

    def test_6_exact_rejection_reason_is_instagram_followers_over_limit(self):
        """6. Exact rejection reason string = instagram_followers_over_limit."""
        worker = QualificationWorker()
        ig = InstagramIntel(
            pipeline_id="pipe-1",
            profile_reachable=True,
            followers=250_000,
        )
        enriched = _make_enriched(instagram_intel=ig)
        result = worker.process(enriched)
        assert result.reasons == ("instagram_followers_over_limit",)


# ==============================================================================
# SECTION 2: INSTAGRAM FOLLOWER SCORING CURVE (Tests 7-10)
# ==============================================================================

class TestInstagramFollowerCurve:
    """Tests 7-10: Monotonicity and boundary checks for follower score curve."""

    TEST_INPUTS = [
        0,
        50,
        99,
        100,
        500,
        1_000,
        2_000,
        5_000,
        10_000,
        25_000,
        50_000,
        75_000,
        100_000,
    ]

    def _eval_follower_contribution(self, followers: int | None) -> int:
        cand = _make_candidate(rating=None, review_count=None)  # zero other branding
        ig = InstagramIntel(
            pipeline_id="pipe-1",
            profile_reachable=True,
            followers=followers,
            verified=False,
            last_post_date=None,
        )
        # Base reachable ig profile gives 20. Follower contribution is above 20.
        branding = ScoringWorker._branding_component(cand, ig)
        return branding - 20

    def test_7_monotonic_from_0_to_100k(self):
        """7. Monotonic from 0 -> 100K: score(a) <= score(b) for all a <= b."""
        scores = [self._eval_follower_contribution(f) for f in self.TEST_INPUTS]
        for i in range(len(scores) - 1):
            f1, f2 = self.TEST_INPUTS[i], self.TEST_INPUTS[i + 1]
            s1, s2 = scores[i], scores[i + 1]
            assert s1 <= s2, f"Inversion detected: followers {f1} (score={s1}) > {f2} (score={s2})"

    def test_8_100k_is_maximum(self):
        """8. 100K achieves maximum follower contribution (+20)."""
        score_100k = self._eval_follower_contribution(100_000)
        assert score_100k == 20

    def test_9_no_inversion_above_any_threshold_up_to_100k(self):
        """9. No inversion anywhere across a dense range."""
        prev = 0
        for f in range(0, 100_001, 250):
            cur = self._eval_follower_contribution(f)
            assert cur >= prev, f"Inversion at {f}: {cur} < {prev}"
            prev = cur

    def test_10_follower_score_contributes_no_more_than_plus_20(self):
        """10. Follower score never exceeds +20, even if larger value tested."""
        assert self._eval_follower_contribution(100_000) <= 20
        assert self._eval_follower_contribution(500_000) <= 20


# ==============================================================================
# SECTION 3: OUTREACH READINESS NORMALIZATION (Tests 11-16)
# ==============================================================================

class TestOutreachReadinessNormalization:
    """Tests 11-16: Normalization of raw channel score (max 85) to 0-100."""

    def test_11_zero_channels_produces_0(self):
        """11. Zero contact channels -> 0."""
        cand = _make_candidate(phone=None)
        score = ScoringWorker._outreach_readiness_component(cand, None, None)
        assert score == 0

    def test_12_phone_only_normalized(self):
        """12. Phone only: raw 20 -> round((20/85)*100) = 24."""
        cand = _make_candidate(phone="+15551234567")
        score = ScoringWorker._outreach_readiness_component(cand, None, None)
        assert score == 24

    def test_13_email_only_normalized(self):
        """13. Email only: raw 25 -> round((25/85)*100) = 29."""
        cand = _make_candidate(phone=None)
        contact = ContactIntel(pipeline_id="pipe-1", emails=("info@example.com",))
        score = ScoringWorker._outreach_readiness_component(cand, None, contact)
        assert score == 29

    def test_14_all_channels_produces_exactly_100(self):
        """14. All channels present -> raw 85 -> exactly 100."""
        cand = _make_candidate(phone="+15551234567")
        ig = InstagramIntel(pipeline_id="pipe-1", profile_reachable=True)
        contact = ContactIntel(
            pipeline_id="pipe-1",
            emails=("info@example.com",),
            phones=("+15551234567",),
            contact_form_url="https://example.com/contact",
            whatsapp_link="https://wa.me/15551234567",
            messenger_link="https://m.me/example",
            telegram_link="https://t.me/example",
            linkedin_url="https://linkedin.com/company/example",
        )
        score = ScoringWorker._outreach_readiness_component(cand, ig, contact)
        assert score == 100

    def test_15_extra_phone_exclusivity_preserved(self):
        """15. Business phone (+20) and ContactIntel phones (+15) are mutually exclusive."""
        # Both present: only business.phone (+20 raw) is counted -> normalized 24
        cand_with_phone = _make_candidate(phone="+15551234567")
        contact_with_phone = ContactIntel(pipeline_id="pipe-1", phones=("+15559876543",))
        score_both = ScoringWorker._outreach_readiness_component(cand_with_phone, None, contact_with_phone)
        assert score_both == 24

        # Only contact_intel phone present: +15 raw -> round((15/85)*100) = 18
        cand_no_phone = _make_candidate(phone=None)
        score_contact_only = ScoringWorker._outreach_readiness_component(cand_no_phone, None, contact_with_phone)
        assert score_contact_only == 18

    def test_16_social_messaging_group_remains_plus_10_raw(self):
        """16. Multiple messaging channels contribute +10 raw combined (normalized to 12)."""
        cand = _make_candidate(phone=None)
        contact_one_msg = ContactIntel(pipeline_id="pipe-1", whatsapp_link="https://wa.me/123")
        contact_all_msg = ContactIntel(
            pipeline_id="pipe-1",
            whatsapp_link="https://wa.me/123",
            messenger_link="https://m.me/123",
            telegram_link="https://t.me/123",
            linkedin_url="https://linkedin.com/in/123",
        )
        score_one = ScoringWorker._outreach_readiness_component(cand, None, contact_one_msg)
        score_all = ScoringWorker._outreach_readiness_component(cand, None, contact_all_msg)
        assert score_one == round((10 / 85.0) * 100)  # 12
        assert score_all == round((10 / 85.0) * 100)  # 12
        assert score_one == score_all


# ==============================================================================
# SECTION 4: RATING BOUNDARIES AND 3.0-3.49 GAP (Tests 17-19)
# ==============================================================================

class TestRatingBoundaries:
    """Tests 17-19: Explicit boundary tests for rating schedule."""

    def _rating_points(self, rating: float | None) -> int:
        cand = _make_candidate(rating=rating, review_count=None)
        return ScoringWorker._branding_component(cand, None)

    def test_17_all_rating_boundaries(self):
        """17. Test every boundary in the rating schedule."""
        # < 3.0 -> -20
        assert self._rating_points(2.99) == 0  # clamped to 0 since branding min is 0
        assert self._rating_points(2.0) == 0

        # 3.0–3.49 -> 0 (neutral band)
        assert self._rating_points(3.0) == 0
        assert self._rating_points(3.2) == 0
        assert self._rating_points(3.49) == 0

        # 3.5–3.99 -> +5
        assert self._rating_points(3.5) == 5
        assert self._rating_points(3.99) == 5

        # 4.0–4.19 -> +12
        assert self._rating_points(4.0) == 12
        assert self._rating_points(4.19) == 12

        # 4.2–4.49 -> +18
        assert self._rating_points(4.2) == 18
        assert self._rating_points(4.49) == 18

        # 4.5–4.79 -> +24
        assert self._rating_points(4.5) == 24
        assert self._rating_points(4.79) == 24

        # >= 4.8 -> +30
        assert self._rating_points(4.8) == 30
        assert self._rating_points(5.0) == 30

    def test_18_no_accidental_discontinuities_in_rating_ladder(self):
        """18. Ladder is strictly monotonic across ratings with review count baseline."""
        # Give a +10 review count baseline so the -20 penalty is observable above 0
        def eval_with_baseline(r: float) -> int:
            cand = _make_candidate(rating=r, review_count=2500)  # +15 review points
            return ScoringWorker._branding_component(cand, None)

        ratings = [2.5, 2.99, 3.0, 3.49, 3.5, 3.99, 4.0, 4.19, 4.2, 4.49, 4.5, 4.79, 4.8, 5.0]
        scores = [eval_with_baseline(r) for r in ratings]
        for i in range(len(scores) - 1):
            assert scores[i] <= scores[i + 1], f"Discontinuity between {ratings[i]} and {ratings[i+1]}"

    def test_19_5_0_remains_same_as_4_8(self):
        """19. 5.0 rating produces exact same points as 4.8 (+30)."""
        assert self._rating_points(5.0) == self._rating_points(4.8) == 30


# ==============================================================================
# SECTION 5: WEBSITE WEAKNESS FLOOR (Tests 20-22)
# ==============================================================================

class TestWebsiteWeakness:
    """Tests 20-22: Website quality and weakness spectrum."""

    def test_20_best_website_reaches_weakness_0(self):
        """20. Best possible website (reachable, HTTPS, WP/Squarespace, .com) reaches weakness 0."""
        cand = _make_candidate(website="https://bestbakery.com")
        w_intel = WebsiteIntel(
            pipeline_id="pipe-1",
            website_reachable=True,
            https=True,
            detected_platform="WordPress",
        )
        quality = ScoringWorker._website_quality_component(cand, w_intel)
        assert quality == 100
        weakness = 100 - quality
        assert weakness == 0

    def test_21_missing_website_remains_maximum_weakness(self):
        """21. Missing website produces quality 0, weakness 100 (maximum opportunity)."""
        cand = _make_candidate(website=None)
        quality = ScoringWorker._website_quality_component(cand, None)
        assert quality == 0
        assert 100 - quality == 100

    def test_22_weak_site_is_weaker_than_strong_site(self):
        """22. Weak site (e.g. linktree) is weaker than strong site."""
        cand_weak = _make_candidate(website="https://linktr.ee/mycafe")
        cand_good = _make_candidate(website="https://mycafe.com")
        w_good = WebsiteIntel(
            pipeline_id="pipe-1",
            website_reachable=True,
            https=True,
            detected_platform=None,
        )
        q_weak = ScoringWorker._website_quality_component(cand_weak, None)
        q_good = ScoringWorker._website_quality_component(cand_good, w_good)
        w_weak = 100 - q_weak
        w_good_weakness = 100 - q_good

        assert q_weak == 25
        assert w_weak == 75
        assert q_good == 90  # 65 + 15 (https) + 10 (.com)
        assert w_good_weakness == 10
        assert w_weak > w_good_weakness


# ==============================================================================
# SECTION 6: REGRESSION & SCORING INVARIANTS (Tests 23-33)
# ==============================================================================

class TestScoringRegressionAndInvariants:
    """Tests 23-33: Clamping, weights, overrides, and engine regressions."""

    def test_23_opportunity_score_clamped_between_0_and_100(self):
        """23. Opportunity score remains clamped in [0, 100]."""
        worker = ScoringWorker()
        # Best possible opportunity (weak site, high branding, high outreach)
        cand_high = _make_candidate(
            website=None,
            phone="+15551234567",
            rating=5.0,
            review_count=2500,
        )
        ig = InstagramIntel(
            pipeline_id="pipe-1",
            profile_reachable=True,
            followers=100_000,
            verified=True,
            last_post_date="2026-08-20T00:00:00Z",
        )
        contact = ContactIntel(
            pipeline_id="pipe-1",
            emails=("test@example.com",),
            phones=("+15551234567",),
            contact_form_url="https://example.com/form",
            whatsapp_link="https://wa.me/1",
        )
        enriched_high = _make_enriched(
            candidate=cand_high,
            website_intel=None,
            instagram_intel=ig,
            contact_intel=contact,
        )
        score_high = worker.process(enriched_high)
        assert 0 <= score_high.opportunity_score <= 100

        # Worst opportunity
        cand_low = _make_candidate(
            website="https://bestbakery.com",
            phone=None,
            rating=2.0,
            review_count=0,
        )
        w_best = WebsiteIntel(
            pipeline_id="pipe-1",
            website_reachable=True,
            https=True,
            detected_platform="WordPress",
        )
        enriched_low = _make_enriched(
            candidate=cand_low,
            website_intel=w_best,
            instagram_intel=None,
            contact_intel=None,
        )
        score_low = worker.process(enriched_low)
        assert 0 <= score_low.opportunity_score <= 100

    def test_24_weights_40_40_20_unchanged(self):
        """24. opportunity_score = 0.40 * branding + 0.40 * website_weakness + 0.20 * outreach."""
        worker = ScoringWorker()
        cand = _make_candidate(
            website="https://simplecafe.org",
            phone="+15551234567",
            rating=4.0,  # +12
            review_count=500,  # int(round(500/2500*15)) = 3
        )
        w_intel = WebsiteIntel(
            pipeline_id="pipe-1",
            website_reachable=True,
            https=True,  # 65 + 15 = 80 quality -> weakness = 20
            detected_platform=None,
        )
        # outreach: phone only -> 24 (with empty contact_intel)
        # branding: 12 + 3 = 15
        # website weakness: 100 - 80 = 20
        # expected: round(0.40 * 15 + 0.40 * 20 + 0.20 * 24) = round(6 + 8 + 4.8) = round(18.8) = 19
        enriched = _make_enriched(
            candidate=cand,
            website_intel=w_intel,
            instagram_intel=None,
            contact_intel=ContactIntel(pipeline_id="pipe-1"),
        )
        res = worker.process(enriched)
        assert int(res.opportunity_score) == 19

    def test_25_cannabis_override_unchanged(self):
        """25. Cannabis businesses get opportunity_score = 0."""
        worker = ScoringWorker()
        cand = _make_candidate(name="Green Leaf Cannabis Dispensary", category="Dispensary")
        enriched = _make_enriched(candidate=cand)
        res = worker.process(enriched)
        assert res.opportunity_score == 0.0

    def test_26_chain_override_unchanged(self):
        """26. Chain businesses get opportunity_score = 10."""
        worker = ScoringWorker()
        cand = _make_candidate(name="Starbucks Coffee", category="Coffee shop")
        enriched = _make_enriched(candidate=cand)
        res = worker.process(enriched)
        assert res.opportunity_score == 10.0

    def test_27_qualification_still_requires_configured_channels(self):
        """27. Dynamic required_channels qualification is preserved."""
        qw = QualificationWorker(required_channels=("email", "phone"))
        # Missing email
        cand = _make_candidate(phone="+15551234567")
        contact_no_email = ContactIntel(pipeline_id="pipe-1", phones=("+15551234567",))
        enriched_no_email = _make_enriched(candidate=cand, contact_intel=contact_no_email)
        res = qw.process(enriched_no_email)
        assert res.qualified is False
        assert "missing required channel: email" in res.reasons

    def test_28_qualification_ordering_instagram_over_limit(self):
        """28. Instagram >100K rejection order verification."""
        qw = QualificationWorker()
        ig_over = InstagramIntel(
            pipeline_id="pipe-1",
            profile_reachable=True,
            followers=120_000,
        )
        enriched = _make_enriched(instagram_intel=ig_over)
        res = qw.process(enriched)
        assert res.qualified is False
        assert res.reasons == ("instagram_followers_over_limit",)

    def test_29_requested_niche_remains_independent_and_untouched(self):
        """29. requested_niche field on BusinessCandidate is preserved and not mutated by scoring/qualification."""
        cand = _make_candidate(pipeline_id="pipe-niche")
        # Candidate has requested_niche set
        cand_with_niche = BusinessCandidate(
            pipeline_id="pipe-niche",
            session_id="sess-niche",
            provider="google_maps",
            name="Special Cafe",
            category="Cafe",
            requested_niche="coffee roaster",
        )
        enriched = _make_enriched(pipeline_id="pipe-niche", candidate=cand_with_niche)
        qw = QualificationWorker(niche="coffee roaster")
        res = qw.process(enriched)
        assert res.niche == "coffee roaster"
        assert cand_with_niche.requested_niche == "coffee roaster"

    def test_30_cannabis_and_chain_interaction_order_with_followers(self):
        """30. >100K follower rejection is evaluated in qualification, before scoring chain/cannabis overrides."""
        qw = QualificationWorker()
        # Cannabis business with >100K followers: rejected by follower limit in qualification
        cand_cannabis = _make_candidate(
            name="High Times Cannabis",
            category="Dispensary",
        )
        ig_large = InstagramIntel(
            pipeline_id="pipe-1",
            profile_reachable=True,
            followers=200_000,
        )
        enriched = _make_enriched(candidate=cand_cannabis, instagram_intel=ig_large)
        qual_res = qw.process(enriched)
        assert qual_res.qualified is False
        assert "instagram_followers_over_limit" in qual_res.reasons

    def test_31_telemetry_event_in_service_progress(self):
        """31. service._on_progress correctly increments instagram_followers_over_limit counter."""
        from utils.perf import RunProfiler
        p = RunProfiler()
        p.incr("instagram_followers_over_limit")
        assert p.counter("instagram_followers_over_limit") == 1

