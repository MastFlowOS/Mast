"""
Unit tests for the Phase 3B-VALIDATION observability additions:

  - engine/execution_driver.py:_site_class() — the weak/normal label
    wrapper around the existing, unmodified utils.parsing.is_weak_site()
    classifier.
  - utils/perf.py:RunProfiler._weak_site_validation_fields() / the
    area_sla_line() fields it feeds — the counters/derived rates the
    Phase 3B audit's Task 1-4 numbers are read from.

These tests cover only the new plumbing. They do not touch pruning,
qualification, dedup, or worker behavior — none of that was modified.
"""

from __future__ import annotations

from engine.execution_driver import _site_class
from utils.parsing import is_directory_site, is_weak_site
from utils.perf import NullProfiler, RunProfiler


# ─────────────────────────────────────────────────────────────────────────
# _site_class()
# ─────────────────────────────────────────────────────────────────────────

def test_site_class_labels_known_weak_domains_as_weak():
    weak_urls = [
        "https://www.facebook.com/somebusiness",
        "https://instagram.com/somebusiness",
        "https://linktr.ee/somebusiness",
        "https://mybiz.wixsite.com/home",
        "https://sites.google.com/view/mybiz",
        "https://mybiz.business.site",
        "https://mybiz.square.site",
        "https://mybiz.squarespace.com",
        "https://mybiz.godaddysites.com",
    ]
    for url in weak_urls:
        assert _site_class(url) == "weak", url


def test_site_class_labels_ordinary_business_domains_as_normal():
    normal_urls = [
        "https://www.acmeplumbing.com",
        "http://joes-pizza.net",
        "https://mybusiness.co",
    ]
    for url in normal_urls:
        assert _site_class(url) == "normal", url


def test_site_class_matches_existing_is_weak_site_classifier_exactly():
    # _site_class must never diverge from the already-shipped classifier
    # the audit calls out (utils.parsing.is_weak_site) — this is the whole
    # point of reusing it rather than inventing a new domain list.
    sample_urls = [
        "https://www.facebook.com/x",
        "https://acmeplumbing.com",
        None,
        "",
        "https://carrd.co/x",
        "https://blogspot.com/x",
    ]
    for url in sample_urls:
        expected = "weak" if is_weak_site(url) else "normal"
        assert _site_class(url) == expected, url


def test_site_class_treats_directory_domains_as_weak_too():
    # is_weak_site's domain set is a superset relevant to directory sites
    # such as yelp.com/tripadvisor.com; sanity-check the overlap the audit
    # relies on (V1's is_directory_site precedent) is actually present.
    for url in ("https://www.yelp.com/biz/x", "https://www.tripadvisor.com/x"):
        assert is_directory_site(url) is True
        assert _site_class(url) == "weak"


def test_site_class_never_raises_on_missing_website():
    # Discovery-time invariant per the audit (§1): required_channels
    # always includes "website", so every early_new candidate already has
    # one — but this must degrade safely, not raise, if that ever changes.
    assert _site_class(None) == "weak"
    assert _site_class("") == "weak"


# ─────────────────────────────────────────────────────────────────────────
# RunProfiler — new counters + derived fields surfaced in area_sla_line()
# ─────────────────────────────────────────────────────────────────────────

def _make_profiler_with_sample_run() -> RunProfiler:
    profiler = RunProfiler()

    # Simulate 5 early_new weak-site candidates, 3 early_new normal-site
    # candidates — mirroring the counter names service.py's _on_progress
    # now routes site_class_* events into.
    for _ in range(5):
        profiler.incr("early_new_weak_site")
    for _ in range(3):
        profiler.incr("early_new_normal_site")

    # All 5 weak-site candidates reach Website and Contact; none qualify.
    for _ in range(5):
        profiler.incr("website_reached_weak_site")
        profiler.incr("contact_reached_weak_site")
    profiler.incr("contact_failures_weak_site", by=2)

    # Of the 3 normal-site candidates: all reach Website/Contact, 1 qualifies
    # and is delivered.
    for _ in range(3):
        profiler.incr("website_reached_normal_site")
        profiler.incr("contact_reached_normal_site")
    profiler.incr("qualified_normal_site")
    profiler.incr("delivered_normal_site")

    # Record stage durations so the estimated-savings field has something
    # to multiply against (mirrors record_stage_duration() calls made from
    # service.py's _on_stage_timing in production).
    profiler.record_stage_duration("website_worker", 1200.0)
    profiler.record_stage_duration("website_worker", 800.0)
    profiler.record_stage_duration("contact_worker", 2000.0)
    profiler.record_stage_duration("contact_worker", 1000.0)

    return profiler


def test_area_sla_line_includes_weak_and_normal_site_counters():
    profiler = _make_profiler_with_sample_run()
    line = profiler.area_sla_line(
        area="TestArea",
        runtime_ms=1000.0,
        first_candidate_ms=None,
        first_enrichment_ms=None,
        first_qualified_ms=None,
        first_delivered_ms=None,
    )
    assert "early_new_weak_site=5" in line
    assert "early_new_normal_site=3" in line
    assert "website_reached_weak_site=5" in line
    assert "website_reached_normal_site=3" in line
    assert "contact_failures_weak_site=2" in line
    assert "qualified_normal_site=1" in line
    assert "delivered_normal_site=1" in line


def test_area_sla_line_computes_conversion_rates_correctly():
    profiler = _make_profiler_with_sample_run()
    line = profiler.area_sla_line(
        area="TestArea",
        runtime_ms=1000.0,
        first_candidate_ms=None,
        first_enrichment_ms=None,
        first_qualified_ms=None,
        first_delivered_ms=None,
    )
    # 0 weak-site candidates qualified out of 5 -> 0.0%
    assert "weak_site_to_qualified_rate=0.0%" in line
    # 1 of 3 normal-site candidates qualified -> 33.3%
    assert "normal_site_to_qualified_rate=33.3%" in line


def test_area_sla_line_conversion_rate_is_n_a_when_no_candidates_of_that_class():
    profiler = RunProfiler()
    line = profiler.area_sla_line(
        area="Empty",
        runtime_ms=1.0,
        first_candidate_ms=None,
        first_enrichment_ms=None,
        first_qualified_ms=None,
        first_delivered_ms=None,
    )
    assert "weak_site_to_qualified_rate=n/a" in line
    assert "normal_site_to_qualified_rate=n/a" in line
    assert "estimated_weak_site_ms_saved_if_pruned=0.0" in line


def test_estimated_weak_site_ms_saved_uses_observed_stage_averages():
    profiler = _make_profiler_with_sample_run()
    # website_worker avg = (1200 + 800) / 2 = 1000ms; contact_worker avg =
    # (2000 + 1000) / 2 = 1500ms. "Reached" a stage = completed OR failed
    # there (both mean the stage's network cost was actually paid).
    # website: 5 completed + 0 failed = 5 reached -> 5*1000 = 5000
    # contact: 5 completed + 2 failed = 7 reached -> 7*1500 = 10500
    # estimated = 5000 + 10500 = 15500.0
    line = profiler.area_sla_line(
        area="TestArea",
        runtime_ms=1000.0,
        first_candidate_ms=None,
        first_enrichment_ms=None,
        first_qualified_ms=None,
        first_delivered_ms=None,
    )
    assert "estimated_weak_site_ms_saved_if_pruned=15500.0" in line


def test_null_profiler_new_fields_are_still_no_ops():
    # NullProfiler must remain a safe drop-in — none of this phase's
    # additions require any changes to it, but confirm nothing broke.
    profiler = NullProfiler()
    profiler.incr("early_new_weak_site")
    assert profiler.counter("early_new_weak_site") == 0
    assert profiler.area_sla_line(area="x") == ""
