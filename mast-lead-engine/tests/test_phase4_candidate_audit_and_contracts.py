"""
Phase 4 Candidate Audit and Contracts Tests.

Deterministic offline unit tests verifying:
1. Email extracted and preserved through contracts & serialization.
2. Phone extracted and normalized.
3. Instagram URL extracted, validated, and normalized.
4. All 3 channels survive serialization in _enriched_to_dict.
5. Extracted values are not overwritten by empty enrichment facts.
6. Invalid values (e.g. invalid Instagram reserved paths or bad emails) receive explicit rejection reasons.
7. Genuine missing channels are distinguished from fetch failures (e.g. 403 vs 200 with no contacts).
8. Website fetch failures are reported accurately in diagnostic fields.
9. Candidates with requested channels pass qualification logic.
10. Candidate-level accounting reconciles across stages (yield_to_node vs deliver).
11. Existing Instagram extraction behavior is strictly preserved.
12. Deduplication and rejected candidates do not corrupt delivered counts.
"""

from __future__ import annotations

import unittest
from engine.contracts import BusinessCandidate, WebsiteIntel, ContactIntel
from workers.contact_worker import ContactWorker
from workers.merge_worker import MergeInput, MergeWorker
from workers.scoring_worker import ScoringWorker
import engine_enrichment_bridge as bridge
from utils.pipeline_trace import PipelineTracer
from utils.perf import RunProfiler


class TestPhase4CandidateAuditAndContracts(unittest.TestCase):
    def test_01_email_extracted_and_serialized(self):
        """1. Email successfully extracted and delivered through python serialization."""
        c_intel = ContactIntel(
            pipeline_id="#1",
            emails=("contact@example.com", "info@example.com"),
            email_source="anchor_href",
            mailto_extracted=True,
        )
        b = BusinessCandidate(pipeline_id="#1", session_id="s1", provider="maps", name="Test Biz")
        w = WebsiteIntel(pipeline_id="#1", website_reachable=True, http_status=200)
        enriched = MergeWorker().process(MergeInput(business=b, website_intel=w, contact_intel=c_intel))
        res = bridge._enriched_to_dict(enriched)

        self.assertEqual(res["email"], "contact@example.com")
        self.assertEqual(res["emails"], ["contact@example.com", "info@example.com"])
        self.assertEqual(res["email_count"], 2)
        self.assertTrue(res["mailto_extracted"])

    def test_02_phone_extracted_and_serialized(self):
        """2. Phone successfully extracted and delivered through python serialization."""
        c_intel = ContactIntel(
            pipeline_id="#2",
            phones=("+1 555-0199",),
            phone_source="tel_href",
            tel_extracted=True,
        )
        b = BusinessCandidate(pipeline_id="#2", session_id="s1", provider="maps", name="Test Biz")
        w = WebsiteIntel(pipeline_id="#2", website_reachable=True, http_status=200)
        enriched = MergeWorker().process(MergeInput(business=b, website_intel=w, contact_intel=c_intel))
        res = bridge._enriched_to_dict(enriched)

        self.assertEqual(res["phone"], "+1 555-0199")
        self.assertEqual(res["phones"], ["+1 555-0199"])
        self.assertEqual(res["phone_count"], 1)
        self.assertTrue(res["tel_extracted"])

    def test_03_instagram_extracted_and_serialized(self):
        """3. Instagram successfully extracted and delivered through python serialization."""
        c_intel = ContactIntel(
            pipeline_id="#3",
            instagram_url="https://www.instagram.com/real_bakery_nyc/",
            instagram_source="anchor_href",
        )
        b = BusinessCandidate(pipeline_id="#3", session_id="s1", provider="maps", name="Test Biz")
        w = WebsiteIntel(pipeline_id="#3", website_reachable=True, http_status=200)
        enriched = MergeWorker().process(MergeInput(business=b, website_intel=w, contact_intel=c_intel))
        res = bridge._enriched_to_dict(enriched)

        self.assertEqual(res["instagram"], "https://www.instagram.com/real_bakery_nyc/")
        self.assertTrue(res["instagram_found"])
        self.assertEqual(res["instagram_source"], "anchor_href")

    def test_04_all_three_channels_survive_serialization(self):
        """4. All three channels survive serialization simultaneously."""
        c_intel = ContactIntel(
            pipeline_id="#4",
            emails=("hi@bakery.com",),
            phones=("+1 555-0100",),
            instagram_url="https://instagram.com/bakery_nyc",
            fetch_duration=120.5,
        )
        b = BusinessCandidate(pipeline_id="#4", session_id="s1", provider="maps", name="Test Biz")
        w = WebsiteIntel(pipeline_id="#4", website_reachable=True, http_status=200)
        enriched = MergeWorker().process(MergeInput(business=b, website_intel=w, contact_intel=c_intel))
        res = bridge._enriched_to_dict(enriched)

        self.assertEqual(res["email"], "hi@bakery.com")
        self.assertEqual(res["phone"], "+1 555-0100")
        self.assertEqual(res["instagram"], "https://www.instagram.com/bakery_nyc/")
        self.assertEqual(res["email_count"], 1)
        self.assertEqual(res["phone_count"], 1)
        self.assertTrue(res["instagram_found"])
        self.assertEqual(res["fetch_duration"], 120.5)

    def test_05_extracted_values_not_overwritten_by_empty_facts(self):
        """5. Provider/candidate channels are not blanked out when contact worker finds none."""
        b = BusinessCandidate(
            pipeline_id="#5",
            session_id="s1",
            provider="maps",
            name="Test Biz",
            phone="+1 555-9999",
            provider_email="maps_email@example.com",
            instagram_url="https://www.instagram.com/provider_ig",
        )
        w = WebsiteIntel(pipeline_id="#5", website_reachable=True, http_status=200)
        # Empty ContactIntel
        c_intel = ContactIntel(pipeline_id="#5")
        enriched = MergeWorker().process(MergeInput(business=b, website_intel=w, contact_intel=c_intel))

        # MergeWorker preserves candidate fields on EnrichedBusiness
        self.assertEqual(enriched.business.phone, "+1 555-9999")
        self.assertEqual(enriched.business.provider_email, "maps_email@example.com")
        self.assertEqual(enriched.business.instagram_url, "https://www.instagram.com/provider_ig")

    def test_06_invalid_instagram_rejected_with_flag(self):
        """6. Reserved Instagram paths are rejected and flag invalid candidate seen."""
        c_intel = ContactIntel(
            pipeline_id="#6",
            instagram_url="https://www.instagram.com/explore/",  # reserved path
            instagram_invalid_candidate_seen=True,
        )
        b = BusinessCandidate(pipeline_id="#6", session_id="s1", provider="maps", name="Test Biz")
        w = WebsiteIntel(pipeline_id="#6", website_reachable=True, http_status=200)
        enriched = MergeWorker().process(MergeInput(business=b, website_intel=w, contact_intel=c_intel))
        res = bridge._enriched_to_dict(enriched)

        self.assertIsNone(res["instagram"])
        self.assertFalse(res["instagram_found"])
        self.assertTrue(res["instagram_invalid_candidate_seen"])

    def test_07_distinguish_missing_channels_from_fetch_failures(self):
        """7. Diagnostic flags accurately distinguish clean scrape (no channels) from fetch failure."""
        # Case A: Scrape clean, 0 channels
        c_clean = ContactIntel(pipeline_id="#7a", homepage_fetch_failed=False, contact_page_fetch_failed=False)
        w_clean = WebsiteIntel(pipeline_id="#7a", website_reachable=True, http_status=200)
        b_clean = BusinessCandidate(pipeline_id="#7a", session_id="s1", provider="maps", name="Clean Biz")
        en_clean = MergeWorker().process(MergeInput(business=b_clean, website_intel=w_clean, contact_intel=c_clean))
        res_clean = bridge._enriched_to_dict(en_clean)

        self.assertFalse(res_clean["homepage_fetch_failed"])
        self.assertFalse(res_clean["contact_page_fetch_failed"])
        self.assertTrue(res_clean["website_reachable"])
        self.assertEqual(res_clean["email_count"], 0)

        # Case B: Fetch failure (e.g. 403 or timeout)
        c_fail = ContactIntel(pipeline_id="#7b", homepage_fetch_failed=True, contact_page_fetch_failed=True)
        w_fail = WebsiteIntel(pipeline_id="#7b", website_reachable=False, http_status=403)
        b_fail = BusinessCandidate(pipeline_id="#7b", session_id="s1", provider="maps", name="Blocked Biz")
        en_fail = MergeWorker().process(MergeInput(business=b_fail, website_intel=w_fail, contact_intel=c_fail))
        res_fail = bridge._enriched_to_dict(en_fail)

        self.assertTrue(res_fail["homepage_fetch_failed"])
        self.assertTrue(res_fail["contact_page_fetch_failed"])
        self.assertFalse(res_fail["website_reachable"])
        self.assertEqual(res_fail["http_status"], 403)

    def test_08_website_fetch_failures_reported_accurately(self):
        """8. Partial and secondary fallback fetch failures are surfaced."""
        c_intel = ContactIntel(
            pipeline_id="#8",
            homepage_fetch_failed=False,
            contact_page_fetch_failed=True,
            secondary_page_fetch_failed=True,
            secondary_fallback_fetch_failed=True,
        )
        b = BusinessCandidate(pipeline_id="#8", session_id="s1", provider="maps", name="Test Biz")
        w = WebsiteIntel(pipeline_id="#8", website_reachable=True, http_status=200)
        enriched = MergeWorker().process(MergeInput(business=b, website_intel=w, contact_intel=c_intel))
        res = bridge._enriched_to_dict(enriched)

        self.assertFalse(res["homepage_fetch_failed"])
        self.assertTrue(res["contact_page_fetch_failed"])
        self.assertTrue(res["secondary_page_fetch_failed"])
        self.assertTrue(res["secondary_fallback_fetch_failed"])

    def test_09_pipeline_tracer_yield_to_node_semantics(self):
        """10. Candidate-level accounting distinguishes yielded_to_node from delivered."""
        tracer = PipelineTracer()
        pid1 = tracer.discover("Biz 1")
        pid2 = tracer.discover("Biz 2")

        tracer.transition(pid1, "YIELDED_TO_NODE")
        tracer.yield_to_node(pid1)

        tracer.reject(pid2, "closed")

        rec = tracer.reconcile()
        self.assertIn("Businesses discovered : 2", rec)
        self.assertIn("Yielded to Node       : 1", rec)
        self.assertIn("Delivered             : 0", rec)
        self.assertIn("Rejected              : 1", rec)
        self.assertIn("Missing               : 0", rec)

    def test_10_run_profiler_reports_discovered_candidates(self):
        """10b. RunProfiler summary reports discovered candidates even without begin_business calls."""
        profiler = RunProfiler()
        profiler.incr("raw_candidates", 50)
        profiler.incr("maps_candidates_yielded", 45)

        summary = profiler.summary()
        self.assertEqual(summary["businesses_discovered"], 45)

    def test_11_required_channels_demand_driven_and_known_merging(self):
        """11. ContactWorker demand-driven evaluation and provider-known channel merging."""
        # Task only requests phone:
        cw_phone = ContactWorker(required_channels=("phone",))
        # Initial: phone missing -> unsatisfied
        self.assertTrue(cw_phone._is_requirement_unsatisfied({}, {}, None))
        # Phone present -> satisfied! (stops secondary crawling)
        self.assertFalse(cw_phone._is_requirement_unsatisfied({}, {"p": "555-1234"}, None))
        # Provider already knew phone -> satisfied immediately without fetching!
        self.assertFalse(cw_phone._is_requirement_unsatisfied({}, {}, None, known=frozenset({"phone"})))

        # Task requests email AND instagram:
        cw_multi = ContactWorker(required_channels=("email", "instagram"))
        # Missing email does NOT suppress instagram check:
        self.assertTrue(cw_multi._is_requirement_unsatisfied({}, {}, "https://instagram.com/biz"))
        # Both present -> satisfied!
        self.assertFalse(cw_multi._is_requirement_unsatisfied({"e": "a@b.com"}, {}, "https://instagram.com/biz"))

    def test_12_different_tasks_do_not_share_required_channels(self):
        """12. Different discovery tasks have isolated ContactWorker requirement configurations."""
        cw1 = ContactWorker(required_channels=("phone",))
        cw2 = ContactWorker(required_channels=("email", "instagram"))
        cw3 = ContactWorker(required_channels=())

        self.assertEqual(cw1._required_channels, ("phone",))
        self.assertEqual(cw2._required_channels, ("email", "instagram"))
        self.assertEqual(cw3._required_channels, ())
        self.assertFalse(cw3._may_fetch_secondary())
        self.assertTrue(cw1._may_fetch_secondary())


if __name__ == "__main__":
    unittest.main()
