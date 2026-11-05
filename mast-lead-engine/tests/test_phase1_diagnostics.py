"""Tests for Phase 1 Diagnostics in maps_scraper.py.

Verifies:
1. Panel with empty name (detail panel open but h1 text is empty -> waiting_for_panel_name)
2. "Results" header (h1 text is "Results" -> excluded header -> waiting_for_detail_panel)
3. Valid panel (matching name and place id -> verified)
4. Stale prior panel (name & address unchanged from prior card -> panel_name_and_address_unchanged_from_prior)
5. Place ID conflict (card place id != panel place id -> place_id_conflict)
6. Distinction between "panel never loaded" vs "selector mismatch" vs "consent/block page"
7. Crash diagnostic logging on browser_page_crashed
8. Rate-limiting of panel verification failure logs per area
"""

from __future__ import annotations

import asyncio
import logging
import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import scraper.maps_scraper as ms
from scraper.maps_scraper import (
    _evaluate_panel_identity,
    _is_detail_pane_open,
    _read_panel_identity_snapshot,
    _log_panel_verification_failure,
    _log_browser_page_crashed,
    _check_consent_or_captcha_present,
    reset_panel_verify_fail_counts,
    set_last_navigation_step,
    get_last_navigation_step,
)
from tests.test_detail_panel_detection import _MockElement, _MockPage


@pytest.fixture(autouse=True)
def _reset_diagnostics():
    reset_panel_verify_fail_counts()
    set_last_navigation_step("none")
    yield
    reset_panel_verify_fail_counts()
    set_last_navigation_step("none")


@pytest.mark.asyncio
async def test_diagnostics_panel_empty_name(caplog):
    """Panel open with back button, but heading text, title, and URL !1s id are unavailable."""
    back_button = _MockElement(attrs={"aria-label": "Back to results"})
    empty_h1 = _MockElement(text="")
    feed = _MockElement(attrs={"role": "feed"})

    page = _MockPage(
        url="https://www.google.com/maps/place/Some+Cafe/@40.7,-74.0,15z",
        feed=feed,
        headings=[empty_h1],
        back_buttons={"Back to results": back_button},
    )

    snap = await _read_panel_identity_snapshot(page, feed)
    assert snap["open"] is True
    assert snap["name"] == ""
    assert snap["raw_name"] == ""

    card_url = "https://www.google.com/maps/place/Some+Cafe/data=!4m2!3m1!1s0x1:0x2"
    ok, reason = _evaluate_panel_identity(
        snap,
        card_href=card_url,
        place_key="0x1:0x2",
        card_signals={"name": "Some Cafe"},
        pre_click_snapshot=None,
        last_verified_panel=None,
    )
    assert ok is False
    assert reason == "waiting_for_panel_name"

    with caplog.at_level(logging.WARNING):
        await _log_panel_verification_failure(
            page,
            snap,
            reason,
            card_href=card_url,
            card_signals={"name": "Some Cafe"},
            area_key="brooklyn",
        )

    assert "[maps][panel-verify-fail]" in caplog.text
    assert "reason=waiting_for_panel_name" in caplog.text
    assert "card_name='Some Cafe'" in caplog.text
    assert "raw_panel_h1=''" in caplog.text
    assert "panel_open=True" in caplog.text


@pytest.mark.asyncio
async def test_diagnostics_panel_results_header(caplog):
    """Results feed header 'Results' is excluded from panel name."""
    results_h1 = _MockElement(text="Results")
    feed = _MockElement(attrs={"role": "feed"})

    page = _MockPage(
        url="https://www.google.com/maps/search/coffee+shop",
        feed=feed,
        headings=[results_h1],
        back_buttons={},
    )

    snap = await _read_panel_identity_snapshot(page, feed)
    assert snap["open"] is False
    assert snap["name"] == ""
    assert snap["raw_h1"] == "Results"

    card_url = "https://www.google.com/maps/place/Cafe+A/data=!4m2!3m1!1s0xa:0xb"
    ok, reason = _evaluate_panel_identity(
        snap,
        card_href=card_url,
        place_key="0xa:0xb",
        card_signals={"name": "Cafe A"},
        pre_click_snapshot=None,
        last_verified_panel=None,
    )
    assert ok is False
    assert reason == "waiting_for_detail_panel"

    with caplog.at_level(logging.WARNING):
        await _log_panel_verification_failure(
            page,
            snap,
            reason,
            card_href=card_url,
            card_signals={"name": "Cafe A"},
            area_key="queens",
        )

    assert "[maps][panel-verify-fail]" in caplog.text
    assert "reason=waiting_for_detail_panel" in caplog.text
    assert "raw_panel_h1='Results'" in caplog.text
    assert "panel_open=False" in caplog.text


@pytest.mark.asyncio
async def test_diagnostics_panel_valid():
    """Matching card name and place_id evaluates to verified."""
    h1 = _MockElement(text="Good Neighbor Coffee")
    back_button = _MockElement(attrs={"aria-label": "Back to results"})
    addr = _MockElement(text="100 Main St, New York, NY")
    feed = _MockElement(attrs={"role": "feed"})
    place_url = "https://www.google.com/maps/place/Good+Neighbor+Coffee/data=!4m2!3m1!1s0x100:0x200"

    page = _MockPage(
        url=place_url,
        feed=feed,
        headings=[h1],
        back_buttons={"Back to results": back_button},
        other_elements={"[data-item-id='address']": addr},
    )

    snap = await _read_panel_identity_snapshot(page, feed)
    assert snap["open"] is True
    assert snap["name"] == "good neighbor coffee"
    assert snap["place_id"] == "0x100:0x200"

    ok, reason = _evaluate_panel_identity(
        snap,
        card_href=place_url,
        place_key="0x100:0x200",
        card_signals={"name": "Good Neighbor Coffee", "address": "100 Main St"},
        pre_click_snapshot=None,
        last_verified_panel=None,
    )
    assert ok is True
    assert reason == "verified"


@pytest.mark.asyncio
async def test_diagnostics_panel_stale_prior(caplog):
    """Panel still renders the prior card's name and address."""
    h1 = _MockElement(text="Prior Coffee")
    back_button = _MockElement(attrs={"aria-label": "Back to results"})
    addr = _MockElement(text="50 Prior St, New York, NY")
    feed = _MockElement(attrs={"role": "feed"})

    # Note: URL has NOT updated to the new place_id yet
    prior_url = "https://www.google.com/maps/place/Prior+Coffee/data=!4m2!3m1!1s0xold:0xold"
    page = _MockPage(
        url=prior_url,
        feed=feed,
        headings=[h1],
        back_buttons={"Back to results": back_button},
        other_elements={"[data-item-id='address']": addr},
    )

    snap = await _read_panel_identity_snapshot(page, feed)

    last_verified = {
        "place_key": "0xold:0xold",
        "place_id": "0xold:0xold",
        "name": "prior coffee",
        "address": "50 prior st new york ny",
    }

    new_card_url = "https://www.google.com/maps/place/Next+Coffee/data=!4m2!3m1!1s0xnew:0xnew"
    ok, reason = _evaluate_panel_identity(
        snap,
        card_href=new_card_url,
        place_key="0xnew:0xnew",
        card_signals={"name": "Next Coffee", "address": "99 Next Ave"},
        pre_click_snapshot=None,
        last_verified_panel=last_verified,
    )
    assert ok is False
    assert reason in ("panel_name_and_address_unchanged_from_prior", "name_conflict(expected='next coffee',actual='prior coffee')")

    with caplog.at_level(logging.WARNING):
        await _log_panel_verification_failure(
            page,
            snap,
            reason,
            card_href=new_card_url,
            card_signals={"name": "Next Coffee"},
            area_key="manhattan",
        )

    assert "[maps][panel-verify-fail]" in caplog.text
    assert "reason=" in caplog.text
    assert "card_name='Next Coffee'" in caplog.text


@pytest.mark.asyncio
async def test_diagnostics_panel_place_id_conflict(caplog):
    """Card href place_id conflicts with loaded panel place_id."""
    h1 = _MockElement(text="Branch Cafe")
    back_button = _MockElement(attrs={"aria-label": "Back to results"})
    feed = _MockElement(attrs={"role": "feed"})

    panel_url = "https://www.google.com/maps/place/Branch+Cafe/data=!4m2!3m1!1s0x111:0x222"
    page = _MockPage(
        url=panel_url,
        feed=feed,
        headings=[h1],
        back_buttons={"Back to results": back_button},
    )

    snap = await _read_panel_identity_snapshot(page, feed)
    assert snap["place_id"] == "0x111:0x222"

    card_url = "https://www.google.com/maps/place/Branch+Cafe/data=!4m2!3m1!1s0x999:0x888"
    ok, reason = _evaluate_panel_identity(
        snap,
        card_href=card_url,
        place_key="0x999:0x888",
        card_signals={"name": "Branch Cafe"},
        pre_click_snapshot=None,
        last_verified_panel=None,
    )
    assert ok is False
    assert "place_id_conflict" in reason
    assert "0x999:0x888" in reason
    assert "0x111:0x222" in reason

    with caplog.at_level(logging.WARNING):
        await _log_panel_verification_failure(
            page,
            snap,
            reason,
            card_href=card_url,
            card_signals={"name": "Branch Cafe"},
            area_key="bronx",
        )

    assert "[maps][panel-verify-fail]" in caplog.text
    assert "place_id_conflict" in caplog.text
    assert "card_place_id='0x999:0x888'" in caplog.text


@pytest.mark.asyncio
async def test_diagnostics_distinguish_consent_block_vs_panel_not_loaded_vs_selector_mismatch(caplog):
    """Ensure logs clearly distinguish consent/block vs panel never loaded vs selector mismatch."""
    feed = _MockElement(attrs={"role": "feed"})

    # 1. Consent/block page
    consent_page = _MockPage(
        url="https://consent.google.com/m?continue=https://google.com/maps",
        feed=feed,
        headings=[],
        back_buttons={},
    )
    has_consent, consent_detail = await _check_consent_or_captcha_present(consent_page)
    assert has_consent is True
    assert consent_detail == "consent_url"

    snap_consent = await _read_panel_identity_snapshot(consent_page, feed)
    with caplog.at_level(logging.WARNING):
        await _log_panel_verification_failure(
            consent_page,
            snap_consent,
            "waiting_for_detail_panel",
            card_href="https://google.com/maps/place/X/data=!4m2!3m1!1s0x1:0x2",
            area_key="test_area",
        )
    assert "interstitial_or_captcha=True" in caplog.text
    assert "interstitial_detail='consent_url'" in caplog.text
    caplog.clear()

    # 2. Panel never loaded
    not_loaded_page = _MockPage(
        url="https://www.google.com/maps/search/coffee",
        feed=feed,
        headings=[],
        back_buttons={},
    )
    snap_not_loaded = await _read_panel_identity_snapshot(not_loaded_page, feed)
    with caplog.at_level(logging.WARNING):
        await _log_panel_verification_failure(
            not_loaded_page,
            snap_not_loaded,
            "waiting_for_detail_panel",
            card_href="https://google.com/maps/place/X/data=!4m2!3m1!1s0x1:0x2",
            area_key="test_area",
        )
    assert "panel_open=False" in caplog.text
    assert "interstitial_or_captcha=False" in caplog.text
    assert "reason=waiting_for_detail_panel" in caplog.text
    caplog.clear()

    # 3. Selector mismatch (loaded heading belongs to completely different place)
    diff_h1 = _MockElement(text="Unrelated Restaurant")
    back_btn = _MockElement(attrs={"aria-label": "Back to results"})
    mismatch_page = _MockPage(
        url="https://www.google.com/maps/place/Unrelated+Restaurant/data=!4m2!3m1!1s0x1:0x2",
        feed=feed,
        headings=[diff_h1],
        back_buttons={"Back to results": back_btn},
    )
    snap_mismatch = await _read_panel_identity_snapshot(mismatch_page, feed)
    ok, mismatch_reason = _evaluate_panel_identity(
        snap_mismatch,
        card_href="https://www.google.com/maps/place/Expected+Coffee/data=!4m2!3m1!1s0x1:0x2",
        place_key="0x1:0x2",
        card_signals={"name": "Expected Coffee"},
        pre_click_snapshot=None,
        last_verified_panel=None,
    )
    assert ok is False
    assert "name_conflict" in mismatch_reason
    with caplog.at_level(logging.WARNING):
        await _log_panel_verification_failure(
            mismatch_page,
            snap_mismatch,
            mismatch_reason,
            card_href="https://www.google.com/maps/place/Expected+Coffee/data=!4m2!3m1!1s0x1:0x2",
            card_signals={"name": "Expected Coffee"},
            area_key="test_area",
        )
    assert "panel_open=True" in caplog.text
    assert "name_conflict" in caplog.text
    assert "raw_panel_h1='Unrelated Restaurant'" in caplog.text


def test_diagnostics_browser_page_crashed_logging(caplog):
    """Crash logging emits process tree RSS memory, concurrent browsers, and last navigation step."""
    set_last_navigation_step("card_click")
    with caplog.at_level(logging.ERROR):
        _log_browser_page_crashed("Target crashed", context_label="return_to_results", last_step="card_click")

    assert "[maps][crash] browser_page_crashed" in caplog.text
    assert "reason='Target crashed'" in caplog.text
    assert "tree_memory_rss_mb=" in caplog.text
    assert "concurrent_browsers=" in caplog.text
    assert "last_navigation_step='card_click'" in caplog.text


@pytest.mark.asyncio
async def test_diagnostics_rate_limiting(caplog):
    """Failures beyond N=10 per area are rate-limited to avoid log flooding."""
    feed = _MockElement(attrs={"role": "feed"})
    page = _MockPage(feed=feed)
    snap = {"open": False, "raw_name": "", "name": ""}

    with caplog.at_level(logging.WARNING):
        for i in range(15):
            await _log_panel_verification_failure(
                page,
                snap,
                "waiting_for_detail_panel",
                card_href=f"https://example.com/{i}",
                area_key="rate_limited_area",
            )

    fail_log_count = caplog.text.count("reason=waiting_for_detail_panel")
    assert fail_log_count == 10, f"Expected exactly 10 failure logs, got {fail_log_count}"
    assert "rate-limit reached (10 failures logged)" in caplog.text


# ──────────────────────────────────────────────────────────────────────────────
# Nov 5 2026 Production Remediation: Phase 1, 2, 3, 4 & 8 Tests
# ──────────────────────────────────────────────────────────────────────────────


def test_phase1_place_id_parser_real_production_urls():
    """Phase 1: Verify _stable_place_id_from_url and _extract_canonical_place_id on verbatim production URLs."""
    from scraper.maps_scraper import (
        MapsScraper,
        _place_identity_from_href,
        _stable_place_id_from_url,
        expand_place_id_forms,
    )

    # 1. Verbatim Down Under Coffee URL (!5s anchor vs !3m6!1s authoritative place ID)
    down_under_url = (
        "https://www.google.com/maps/place/Down+Under+Coffee/@40.7578074,-73.9740556,13z/"
        "data=!3m1!5s0x89c37625d2a7a4a1:0x54e10982633b203e!4m10!1m2!2m1!"
        "1sCoffee+Shop+in+Manhattan,+New+York!3m6!1s0x89c2598818da0645:0x2c2119fb675d62e7!"
        "8m2!3d40.767054!4d-73.9829765!16s%2Fg%2F11vfblmz4v"
    )
    assert _stable_place_id_from_url(down_under_url) == "0x89c2598818da0645:0x2c2119fb675d62e7"
    assert MapsScraper._extract_canonical_place_id(down_under_url) == "0x89c2598818da0645:0x2c2119fb675d62e7"
    assert _place_identity_from_href(down_under_url) == "0x89c2598818da0645:0x2c2119fb675d62e7"
    assert "0x89c37625d2a7a4a1:0x54e10982633b203e" not in _stable_place_id_from_url(down_under_url)

    # 2. Verbatim Intelligentsia (Chicago) URL
    intelligentsia_url = (
        "https://www.google.com/maps/place/Intelligentsia+Coffee/@41.88,-87.63,14z/"
        "data=!3m1!5s0x880e2ca5a3d51ea5:0x7edf0a3a53c77ed0!4m10!1m2!2m1!"
        "1sCoffee+Shop+in+Chicago!3m6!1s0x880e2ca59d87f58f:0x16c6cb5e284d552d!8m2!3d41.88!4d-87.63"
    )
    assert _stable_place_id_from_url(intelligentsia_url) == "0x880e2ca59d87f58f:0x16c6cb5e284d552d"
    assert MapsScraper._extract_canonical_place_id(intelligentsia_url) == "0x880e2ca59d87f58f:0x16c6cb5e284d552d"

    # 3. Verbatim Liam's Cafe URL
    liams_cafe_url = (
        "https://www.google.com/maps/place/Liam%E2%80%99s+Cafe/@40.8472955,-73.8490123,17z/"
        "data=!3m6!1s0x89c2f500322e9c67:0x2f8e74ea9cd25ee7!8m2!3d40.8472955!4d-73.8490123"
    )
    assert _stable_place_id_from_url(liams_cafe_url) == "0x89c2f500322e9c67:0x2f8e74ea9cd25ee7"

    # 4. URL with only !1s
    only_1s_url = "https://www.google.com/maps/place/Test+Cafe/data=!4m2!3m1!1s0x11112222:0x33334444"
    assert _stable_place_id_from_url(only_1s_url) == "0x11112222:0x33334444"

    # 5. URL with only !5s — must NOT return the !5s id as the place id
    only_5s_url = (
        "https://www.google.com/maps/place/Down+Under+Coffee/@40.7578074,-73.9740556,13z/"
        "data=!3m1!5s0x89c37625d2a7a4a1:0x54e10982633b203e"
    )
    assert _stable_place_id_from_url(only_5s_url) == ""
    assert MapsScraper._extract_canonical_place_id(only_5s_url) is None

    # 6. Search/feed context URL must be ignored even if a CID appears in query params
    search_feed_url = (
        "https://www.google.com/maps/search/Coffee+Shop/@40.75,-73.98,13z/"
        "data=!3m1!5s0x89c37625d2a7a4a1:0x54e10982633b203e!2m1!1s0x89c2598818da0645:0x2c2119fb675d62e7"
    )
    assert _stable_place_id_from_url(search_feed_url) == ""
    assert MapsScraper._extract_canonical_place_id(search_feed_url) is None

    # 7. ChIJ forms (with and without !5s anchor) + normalization/expand logic
    chij_with_5s = (
        "https://www.google.com/maps/place/Blue+Bottle/@40.7,-74.0,15z/"
        "data=!3m1!5s0x89c37625d2a7a4a1:0x54e10982633b203e!3m6!1sChIJN1t_tDeuEmsRUsoyG83frY4"
    )
    assert _stable_place_id_from_url(chij_with_5s) == "ChIJN1t_tDeuEmsRUsoyG83frY4"
    forms = expand_place_id_forms("0x89c2598818da0645:0x2c2119fb675d62e7")
    assert "0x89c2598818da0645:0x2c2119fb675d62e7" in forms

    # 8. Malformed URLs
    assert _stable_place_id_from_url("") == ""
    assert _stable_place_id_from_url(None) == ""  # type: ignore[arg-type]
    assert _stable_place_id_from_url("not-a-url") == ""
    assert _stable_place_id_from_url("https://www.google.com/maps/place/Broken/data=!3m6!1s0xZZZ:0xYYY") == ""


@pytest.mark.asyncio
async def test_phase2_panel_identity_verification_matrix(caplog):
    """Phase 2: Verify panel identity across Liam's Cafe, Down Under Coffee, stale panels, title conflicts, and address conflicts."""
    results_h1 = _MockElement(text="Results")
    feed = _MockElement(attrs={"role": "feed"})

    # 1. Verbatim Liam's Cafe: h1='Results', page_title='Liam’s Cafe - Google Maps', URL !1s id matches card_place_id -> verified
    liams_url = (
        "https://www.google.com/maps/place/Liam%E2%80%99s+Cafe/@40.8472955,-73.8490123,17z/"
        "data=!3m6!1s0x89c2f500322e9c67:0x2f8e74ea9cd25ee7!8m2!3d40.8472955!4d-73.8490123"
    )
    liams_page = _MockPage(
        url=liams_url,
        title="Liam’s Cafe - Google Maps",
        feed=feed,
        headings=[results_h1],
        back_buttons={},
    )
    liams_snap = await _read_panel_identity_snapshot(liams_page, feed)
    assert liams_snap["open"] is True
    assert liams_snap["raw_h1"] == "Results"
    # 'Results' must never be used as place name; falls back to page_title
    assert liams_snap["raw_name"] == "Liam’s Cafe"
    assert liams_snap["name"] == "liam s cafe"
    ok_liam, reason_liam = _evaluate_panel_identity(
        liams_snap,
        card_href=liams_url,
        place_key="0x89c2f500322e9c67:0x2f8e74ea9cd25ee7",
        card_signals={"name": "Liam’s Cafe"},
        pre_click_snapshot=None,
        last_verified_panel=None,
    )
    assert ok_liam is True
    assert reason_liam == "verified"
    assert liams_snap["verdict_source"] in ("url_id", "title")

    # 2. Verbatim Down Under Coffee (previously failed with place_id_conflict on !5s vs !1s) -> verified
    down_under_panel_url = (
        "https://www.google.com/maps/place/Down+Under+Coffee/@40.7578074,-73.9740556,13z/"
        "data=!3m1!5s0x89c37625d2a7a4a1:0x54e10982633b203e!4m10!1m2!2m1!"
        "1sCoffee+Shop+in+Manhattan,+New+York!3m6!1s0x89c2598818da0645:0x2c2119fb675d62e7!"
        "8m2!3d40.767054!4d-73.9829765!16s%2Fg%2F11vfblmz4v"
    )
    down_under_card_href = (
        "https://www.google.com/maps/place/Down+Under+Coffee/data=!4m7!3m6!"
        "1s0x89c2598818da0645:0x2c2119fb675d62e7!8m2!3d40.767054!4d-73.9829765"
    )
    down_under_page = _MockPage(
        url=down_under_panel_url,
        title="Down Under Coffee - Google Maps",
        feed=feed,
        headings=[results_h1],
    )
    du_snap = await _read_panel_identity_snapshot(down_under_page, feed)
    ok_du, reason_du = _evaluate_panel_identity(
        du_snap,
        card_href=down_under_card_href,
        place_key="0x89c2598818da0645:0x2c2119fb675d62e7",
        card_signals={"name": "Down Under Coffee"},
        pre_click_snapshot=None,
        last_verified_panel=None,
    )
    assert ok_du is True
    assert reason_du == "verified"

    # 3. Stale panel: URL !1s id of previous verified card -> rejected
    stale_id_snap = await _read_panel_identity_snapshot(liams_page, feed)
    ok_stale_id, reason_stale_id = _evaluate_panel_identity(
        stale_id_snap,
        card_href=down_under_card_href,
        place_key="0x89c2598818da0645:0x2c2119fb675d62e7",
        card_signals={"name": "Down Under Coffee"},
        pre_click_snapshot=None,
        last_verified_panel={
            "place_key": "0x89c2f500322e9c67:0x2f8e74ea9cd25ee7",
            "place_id": "0x89c2f500322e9c67:0x2f8e74ea9cd25ee7",
            "name": "liam s cafe",
            "address": "123 bronx st",
        },
    )
    assert ok_stale_id is False
    assert reason_stale_id == "panel_place_id_unchanged_from_prior"
    assert stale_id_snap["verdict_source"] == "url_id"

    # 4. Stale panel: title of previous card when URL has not updated to new !1s id -> rejected
    stale_title_page = _MockPage(
        url="https://www.google.com/maps/place/Loading/@40.7,-73.9,15z",
        title="Liam’s Cafe - Google Maps",
        feed=feed,
        headings=[results_h1],
    )
    stale_title_snap = await _read_panel_identity_snapshot(stale_title_page, feed)
    ok_stale_title, reason_stale_title = _evaluate_panel_identity(
        stale_title_snap,
        card_href="https://www.google.com/maps/place/Down+Under+Coffee/@40.7,-73.9,15z",
        place_key="down_under_key",
        card_signals={"name": "Down Under Coffee"},
        pre_click_snapshot=None,
        last_verified_panel={
            "place_key": "liams_key",
            "place_id": "0x89c2f500322e9c67:0x2f8e74ea9cd25ee7",
            "name": "liam s cafe",
            "title_name": "liam s cafe",
            "address": "",
        },
    )
    assert ok_stale_title is False
    assert "name_conflict" in reason_stale_title
    assert stale_title_snap["verdict_source"] == "title"

    # 5. No title / no id / h1='Results' -> waiting_for_panel_name
    no_signal_page = _MockPage(
        url="https://www.google.com/maps/place/Down+Under+Coffee/@40.7578074,-73.9740556,13z/data=!3m1!5s0x89c37625d2a7a4a1:0x54e10982633b203e",
        title="Google Maps",
        feed=feed,
        headings=[results_h1],
    )
    no_signal_snap = await _read_panel_identity_snapshot(no_signal_page, feed)
    ok_wait, reason_wait = _evaluate_panel_identity(
        no_signal_snap,
        card_href=down_under_card_href,
        place_key="0x89c2598818da0645:0x2c2119fb675d62e7",
        card_signals={"name": "Down Under Coffee"},
        pre_click_snapshot=None,
        last_verified_panel=None,
    )
    assert ok_wait is False
    assert reason_wait == "waiting_for_panel_name"
    assert no_signal_snap["verdict_source"] == "none"

    # 6. Name conflict: title differs from card -> rejected
    conflict_title_page = _MockPage(
        url="https://www.google.com/maps/place/Starbucks/@40.75,-73.98,15z",
        title="Starbucks Reserve - Google Maps",
        feed=feed,
        headings=[results_h1],
    )
    conflict_title_snap = await _read_panel_identity_snapshot(conflict_title_page, feed)
    ok_conf, reason_conf = _evaluate_panel_identity(
        conflict_title_snap,
        card_href="https://www.google.com/maps/place/Down+Under+Coffee/@40.75,-73.98,15z",
        place_key="du_key",
        card_signals={"name": "Down Under Coffee"},
        pre_click_snapshot=None,
        last_verified_panel=None,
    )
    assert ok_conf is False
    assert "name_conflict" in reason_conf
    assert conflict_title_snap["verdict_source"] == "title"

    # 7. address_conflict path unchanged
    addr_el = _MockElement(text="999 Broadway, New York, NY")
    addr_page = _MockPage(
        url=down_under_panel_url,
        title="Down Under Coffee - Google Maps",
        feed=feed,
        headings=[results_h1],
        other_elements={"[data-item-id='address'] .fontBodyMedium": addr_el},
    )
    addr_snap = await _read_panel_identity_snapshot(addr_page, feed)
    ok_addr, reason_addr = _evaluate_panel_identity(
        addr_snap,
        card_href=down_under_card_href,
        place_key="0x89c2598818da0645:0x2c2119fb675d62e7",
        card_signals={"name": "Down Under Coffee", "visible_text": "Down Under Coffee · 123 Main St"},
        pre_click_snapshot=None,
        last_verified_panel=None,
    )
    assert ok_addr is False
    assert "address_conflict" in reason_addr

    # 8. [panel-verify-fail] log includes new Phase 2 fields and per-area rate-limit key
    caplog.clear()
    with caplog.at_level(logging.WARNING):
        await _log_panel_verification_failure(
            conflict_title_page,
            conflict_title_snap,
            reason_conf,
            card_href=down_under_card_href,
            card_signals={"name": "Down Under Coffee"},
            area_key="Queens",
        )
    assert "area='Queens'" in caplog.text
    assert "title_name='starbucks reserve'" in caplog.text
    assert "url_place_id=''" in caplog.text
    assert "card_place_id='0x89c2598818da0645:0x2c2119fb675d62e7'" in caplog.text
    assert "verdict_source='title'" in caplog.text


@pytest.mark.asyncio
async def test_phase3_extraction_risk_guard_and_dom_snapshots(caplog, monkeypatch):
    """Phase 3: Verify [maps][extraction-guard] and [maps][dom-snapshot] logging, truncation, sanitization, and MAST_PANEL_DOM_SNAPSHOT_MAX=0."""
    from scraper.maps_scraper import (
        RawPlace,
        _capture_and_log_dom_snapshot,
        _log_verified_card_extraction_guard,
        _sanitize_dom_snapshot_html,
        reset_panel_verify_fail_counts,
    )

    reset_panel_verify_fail_counts("Manhattan")

    # 1. Structured extraction-guard log line per verified card
    place = RawPlace(
        name="Liam’s Cafe",
        address="123 Morris Park Ave, Bronx, NY",
        phone="+1 718-555-0199",
        website="https://liamscafe.example.com",
        rating=4.8,
        reviews=142,
    )
    setattr(
        place,
        "_matched_selectors",
        {
            "name": "page_title_or_card_fallback",
            "phone": "[data-item-id^='phone:tel:'] .fontBodyMedium",
            "website": "a[data-item-id='authority']",
            "address": "[data-item-id='address'] .fontBodyMedium",
            "rating": "div.F7nice span[aria-hidden='true']",
        },
    )
    with caplog.at_level(logging.INFO):
        _log_verified_card_extraction_guard(
            card_name="Liam’s Cafe",
            card_place_id="0x89c2f500322e9c67:0x2f8e74ea9cd25ee7",
            place=place,
            panel_snap={"matched_selector": "none"},
            area_key="Manhattan",
        )
    assert "[maps][extraction-guard]" in caplog.text
    assert "name_found=True" in caplog.text
    assert "phone_found=True" in caplog.text
    assert "website_found=True" in caplog.text
    assert "address_found=True" in caplog.text
    assert "rating_found=True" in caplog.text
    assert "website_selector=\"a[data-item-id='authority']\"" in caplog.text

    # 2. Sanitization + 3KB truncation
    raw_dirty_html = (
        '<a href="https://example.com/contact?token=secret123&utm=abc">'
        'Contact owner@liamscafe.com Cookie: SID=abc123xyz; '
        + ("X" * 4000)
        + "</a>"
    )
    sanitized = _sanitize_dom_snapshot_html(raw_dirty_html, max_bytes=3072)
    assert "token=secret123" not in sanitized
    assert "?[REDACTED]" in sanitized
    assert "owner@liamscafe.com" not in sanitized
    assert "[EMAIL_REDACTED]" in sanitized
    assert "SID=abc123xyz" not in sanitized
    assert "[COOKIE_REDACTED]" in sanitized
    assert sanitized.endswith("...[truncated]")
    assert len(sanitized.encode("utf-8")) <= 3072 + len("...[truncated]")

    # 3. Default MAST_PANEL_DOM_SNAPSHOT_MAX=2 captures first 2 verified and first 2 failures per area
    class _SnapshotMockPage:
        async def evaluate(self, script):
            return {
                "header": "<h1>Results</h1>",
                "phone": '<button data-item-id="phone:tel:123">Call</button>',
                "website": '<a href="https://cafe.com?foo=bar">Website</a>',
                "address": '<div data-item-id="address">123 Main St</div>',
            }

    snap_page = _SnapshotMockPage()
    caplog.clear()
    monkeypatch.setenv("MAST_PANEL_DOM_SNAPSHOT_MAX", "2")
    with caplog.at_level(logging.INFO):
        assert await _capture_and_log_dom_snapshot(snap_page, snapshot_kind="verified", area_key="Manhattan", card_name="C1") is True
        assert await _capture_and_log_dom_snapshot(snap_page, snapshot_kind="verified", area_key="Manhattan", card_name="C2") is True
        assert await _capture_and_log_dom_snapshot(snap_page, snapshot_kind="verified", area_key="Manhattan", card_name="C3") is False
    assert caplog.text.count("[maps][dom-snapshot] kind=verified") == 2

    # 4. Disabled when MAST_PANEL_DOM_SNAPSHOT_MAX=0
    caplog.clear()
    reset_panel_verify_fail_counts("Manhattan")
    monkeypatch.setenv("MAST_PANEL_DOM_SNAPSHOT_MAX", "0")
    with caplog.at_level(logging.INFO):
        assert await _capture_and_log_dom_snapshot(snap_page, snapshot_kind="verified", area_key="Manhattan", card_name="C1") is False
    assert "[maps][dom-snapshot]" not in caplog.text


@pytest.mark.asyncio
async def test_phase4_honest_area_outcome_panel_verification_failed(monkeypatch):
    """Phase 4:
    - Area with >= 3 clicks and 0 verified (24 clicks / 0 verified) raises DiscoveryFailure(PANEL_VERIFICATION_FAILED).
    - Area with 0 places (< 3 clicks) ends normally as exhausted.
    - Area with 5 verified yields normally.
    """
    import scraper.maps_scraper as ms
    from utils.runtime import ScraperConfig
    from exceptions import DiscoveryFailure, DiscoveryFailureReason

    # Helper to build a minimal mocked MapsScraper instance ready to run .search()
    def _build_scraper(max_crash_retries: int = 1) -> ms.MapsScraper:
        cfg = ScraperConfig(
            scroll_max_rounds=1,
            max_crash_retries=max_crash_retries,
            place_timeout_ms=60,
            card_operation_timeout_ms=500,
            max_stale_panel_retries_per_card=0,
            max_stale_panel_recoveries_per_area=100,
        )
        setattr(cfg, "max_unopened_panel_retries_per_card", 0)
        scraper = ms.MapsScraper(cfg)
        scraper._is_launched = True
        scraper._is_owned = True
        scraper._is_closed = False
        scraper._browser = object()  # type: ignore[assignment]
        return scraper

    async def _noop_sleep(*_a, **_k):
        return None

    async def _true_async(*_a, **_k):
        return True

    monkeypatch.setattr(ms.asyncio, "sleep", _noop_sleep)
    monkeypatch.setattr(ms, "_run_page_load_diagnostics", lambda *_a, **_k: _noop_sleep())
    monkeypatch.setattr(ms, "_detect_interstitial", lambda *_a, **_k: _noop_sleep())
    monkeypatch.setattr(ms, "_diag_dump_panel_dom", lambda *_a, **_k: _noop_sleep())
    monkeypatch.setattr(ms, "_human_scroll", lambda *_a, **_k: _noop_sleep())
    monkeypatch.setattr(ms, "_human_click", lambda *_a, **_k: _noop_sleep())
    monkeypatch.setattr(ms, "_return_to_results", _true_async)
    monkeypatch.setattr(ms, "_is_feed_ready", _true_async)

    # Case 1: 24 card clicks, 0 verified -> raises DiscoveryFailure(PANEL_VERIFICATION_FAILED) after retrying with fresh context
    contexts_created = 0

    class _FakeAnchor:
        def __init__(self, idx: int):
            self._href = f"https://www.google.com/maps/place/Cafe+{idx}/data=!3m6!1s0x1000:0x{idx:04x}"

        async def get_attribute(self, name: str):
            return self._href if name == "href" else ""

        async def inner_text(self):
            return "Cafe"

        async def scroll_into_view_if_needed(self, **_k):
            return None

    class _FakeFeed:
        def __init__(self, anchors):
            self._anchors = anchors

        async def query_selector_all(self, _sel: str):
            return self._anchors

    class _FakePage:
        def __init__(self, anchors):
            self.url = "https://www.google.com/maps/search/Coffee+Shop"
            self._feed = _FakeFeed(anchors)

        async def title(self):
            return "Google Maps"

        async def goto(self, url: str, **_k):
            self.url = url

        async def wait_for_selector(self, *_a, **_k):
            return None

        async def query_selector(self, sel: str):
            if sel == "div[role='feed']":
                return self._feed
            return None

        async def evaluate(self, *_a, **_k):
            return "You've reached the end of the list"

        async def close(self):
            return None

    class _FakeContext:
        def __init__(self, anchors):
            self._anchors = anchors

        async def new_page(self):
            return _FakePage(self._anchors)

        async def close(self):
            return None

    anchors_24 = [_FakeAnchor(i) for i in range(1, 25)]

    async def _fake_new_context_24(*_a, **_k):
        nonlocal contexts_created
        contexts_created += 1
        return _FakeContext(anchors_24)

    async def _fake_resolve_panel(page, **_k):
        return "div[role='feed']", page._feed

    monkeypatch.setattr(ms, "_new_stealth_context", _fake_new_context_24)
    monkeypatch.setattr(ms, "_resolve_results_panel", _fake_resolve_panel)

    scraper_fail = _build_scraper(max_crash_retries=1)
    with pytest.raises(DiscoveryFailure) as exc_info:
        async for _ in scraper_fail.search("Coffee Shop", city="New York", street="Queens", max_results=20):
            pass
    assert exc_info.value.reason == DiscoveryFailureReason.PANEL_VERIFICATION_FAILED
    assert "24 card click(s) and verified 0" in exc_info.value.detail
    assert contexts_created == 2, "Must retry with a fresh browser context before failing terminally"

    # Case 2: 0 places found on initial scan (< 3 clicks) -> stays exhausted (no DiscoveryFailure)
    async def _fake_new_context_0(*_a, **_k):
        return _FakeContext([])

    monkeypatch.setattr(ms, "_new_stealth_context", _fake_new_context_0)
    scraper_empty = _build_scraper(max_crash_retries=0)
    yielded_empty = []
    async for p in scraper_empty.search("Coffee Shop", city="New York", street="Empty Area", max_results=20):
        yielded_empty.append(p)
    assert yielded_empty == []

    # Case 3: 5 verified cards -> yields 5 places normally without raising DiscoveryFailure
    from scraper.maps_scraper import RawPlace
    anchors_5 = [_FakeAnchor(i) for i in range(1, 6)]

    class _FakeVerifiedPage(_FakePage):
        def __init__(self, anchors):
            super().__init__(anchors)
            self._current_idx = 0

        async def title(self):
            return f"Cafe {self._current_idx} - Google Maps" if self._current_idx else "Google Maps"

        async def query_selector(self, sel: str):
            if sel == "div[role='feed']":
                return self._feed
            if any(h in sel for h in ("h1", "fontHeadlineLarge", "DUwDvf")):
                return _FakeAnchor(self._current_idx) if self._current_idx else None
            return None

    class _FakeVerifiedContext:
        async def new_page(self):
            return _FakeVerifiedPage(anchors_5)

        async def close(self):
            return None

    async def _fake_click_sets_url(page, anchor):
        href = await anchor.get_attribute("href")
        page.url = href
        page._current_idx += 1

    async def _fake_extract_place_data(page, *, fallback_name=None, **_k):
        return RawPlace(
            name=fallback_name or f"Cafe {page._current_idx}",
            address=f"{page._current_idx} Main St, New York, NY",
            website=f"https://cafe{page._current_idx}.example.com",
            phone=f"+1 212-555-010{page._current_idx}",
            rating=4.7,
            reviews=50,
            maps_link=page.url,
        )

    monkeypatch.setattr(ms, "_new_stealth_context", lambda *_a, **_k: _noop_sleep() or _FakeVerifiedContext())
    async def _fake_new_context_5(*_a, **_k):
        return _FakeVerifiedContext()
    monkeypatch.setattr(ms, "_new_stealth_context", _fake_new_context_5)
    monkeypatch.setattr(ms, "_human_click", _fake_click_sets_url)
    monkeypatch.setattr(ms, "_wait_for_place_settle", _noop_sleep)
    monkeypatch.setattr(ms, "_extract_place_data", _fake_extract_place_data)
    monkeypatch.setattr(ms, "_DEFAULT_EXTRACT_PLACE_DATA", _fake_extract_place_data)

    scraper_ok = _build_scraper(max_crash_retries=0)
    yielded_ok = []
    async for p in scraper_ok.search("Coffee Shop", city="New York", street="Manhattan", max_results=20):
        yielded_ok.append(p)
    assert len(yielded_ok) == 5


def test_phase8_stale_stop_sentinel_cleanup():
    """Phase 8: Verify service._cleanup_stop_sentinel_file removes stale mast_stop_<pid>.txt at startup and exit."""
    import os
    import tempfile
    import service

    fake_pid = 99999123
    stop_file = os.path.join(tempfile.gettempdir(), f"mast_stop_{fake_pid}.txt")
    try:
        with open(stop_file, "w", encoding="utf-8") as f:
            f.write("USER_CANCELLED\n")
        assert os.path.exists(stop_file)
        removed = service._cleanup_stop_sentinel_file(fake_pid)
        assert removed is True
        assert not os.path.exists(stop_file)
        assert service._cleanup_stop_sentinel_file(fake_pid) is False
    finally:
        if os.path.exists(stop_file):
            os.remove(stop_file)


@pytest.mark.asyncio
async def test_lead_name_safety_when_raw_panel_h1_is_results():
    """Task 3: Ensure lead name never comes from excluded header 'Results'.
    Prefers verified title name, else card name."""
    from scraper import maps_scraper as ms
    from scraper.maps_scraper import (
        _read_panel_identity_snapshot,
        _extract_place_data,
        _is_excluded_panel_header,
        RawPlace,
        ScraperConfig,
    )

    feed = _MockElement(attrs={"role": "feed"})
    results_h1 = _MockElement(text="Results")
    page = _MockPage(
        url="https://www.google.com/maps/place/Blue+Bottle+Coffee/@40.7,-73.9,15z/data=!3m6!1s0x89c2598818da0645:0x2c2119fb675d62e7",
        title="Blue Bottle Coffee - Google Maps",
        feed=feed,
        headings=[results_h1],
    )

    # 1. Snapshot must NOT set raw_name to 'Results'
    snap = await _read_panel_identity_snapshot(page, feed)
    assert snap["raw_h1"] == "Results"
    assert snap["raw_name"] == "Blue Bottle Coffee"
    assert not _is_excluded_panel_header(snap["raw_name"])

    # 2. _extract_place_data must reject 'Results' when DOM evaluate returns it as name
    class _MockEvaluatePage:
        url = page.url
        async def evaluate(self, js, *args):
            return {
                "name": "Results",  # DOM returned excluded header
                "address": "450 W 15th St, New York, NY",
                "category": "Coffee shop",
                "phoneCandidates": [],
                "html": "",
            }

    cfg = ScraperConfig()
    extracted = await _extract_place_data(
        _MockEvaluatePage(),
        config=cfg,
        fallback_name="Blue Bottle Coffee",
    )
    assert extracted is not None
    assert extracted.name == "Blue Bottle Coffee"
    assert extracted.name != "Results"


def test_stale_data_guard_detects_carried_over_fields():
    """Task 4: Stale-data guard detects when extracted phone/website are carried over
    from prior card's panel while business names differ."""
    from scraper.maps_scraper import _detect_stale_extraction, RawPlace

    prior_panel = {
        "name": "Alpha Coffee",
        "raw_name": "Alpha Coffee",
        "phone": "+1 212-555-0199",
        "website": "https://alphacoffee.example.com",
        "address": "100 Broadway, New York, NY",
    }

    # Case 1: New card has different name, but identical website and phone -> STALE
    curr_stale = RawPlace(
        name="Beta Cafe",
        phone="+1 212-555-0199",
        website="https://alphacoffee.example.com",
        address="200 Park Ave, New York, NY",
    )
    is_stale, reason = _detect_stale_extraction(curr_stale, prior_panel)
    assert is_stale is True
    assert reason == "stale_website_and_phone"

    # Case 2: Same business name (normalized match) -> NOT stale (same place)
    curr_same = RawPlace(
        name="alpha coffee",
        phone="+1 212-555-0199",
        website="https://alphacoffee.example.com",
        address="100 Broadway, New York, NY",
    )
    is_stale_same, _ = _detect_stale_extraction(curr_same, prior_panel)
    assert is_stale_same is False

    # Case 3: Different name and fresh phone/website -> NOT stale
    curr_fresh = RawPlace(
        name="Beta Cafe",
        phone="+1 212-555-0288",
        website="https://betacafe.example.com",
        address="200 Park Ave, New York, NY",
    )
    is_stale_fresh, _ = _detect_stale_extraction(curr_fresh, prior_panel)
    assert is_stale_fresh is False


def test_colocated_tenants_same_website_and_address_different_phones_keep_data():
    """Task 4: Co-located tenants (same website and address, but different phones)
    are flagged with warning_website_and_address_only and retain all fields without clearing."""
    from scraper.maps_scraper import _detect_stale_extraction, RawPlace

    tenant1 = {
        "name": "Acme Dental Clinic",
        "raw_name": "Acme Dental Clinic",
        "phone": "+1 212-555-0101",
        "website": "https://medicalplaza.example.com",
        "address": "500 Madison Ave, New York, NY",
    }

    # Tenant 2 is co-located in the same building and shares the plaza website, but has distinct phone
    tenant2 = RawPlace(
        name="Zenith Law Firm",
        phone="+1 212-555-0102",
        website="https://medicalplaza.example.com",
        address="500 Madison Ave, New York, NY",
    )

    is_stale, reason = _detect_stale_extraction(tenant2, tenant1)
    assert is_stale is True
    assert reason == "warning_website_and_address_only"

    # Verify that because phone is distinct, fields must NOT be cleared
    prior_phone = (tenant1.get("phone") or "").strip()
    curr_phone = (getattr(tenant2, "phone", "") or "").strip()
    should_clear = bool(curr_phone and prior_phone and curr_phone == prior_phone)
    assert should_clear is False, "Co-located tenants with different phones must not have fields cleared"

    # Both keep their respective fields
    assert tenant2.phone == "+1 212-555-0102"
    assert tenant2.website == "https://medicalplaza.example.com"
    assert tenant2.address == "500 Madison Ave, New York, NY"


@pytest.mark.asyncio
async def test_stale_panel_protection_negative_cases():
    """Item 3 negative tests proving stale-panel protection holds:
    (a) title-based verify must reject when the panel URL !1s id equals the PRIOR verified card's id
        (even if page_title matches the current card's name);
    (b) must reject when the title equals the prior card's title and differs from the current card;
    (c) split-view/feed-visible scenario: clicking new card while old detail panel is still mounted
        must not verify from the stale detail panel.
    """
    feed = _MockElement(attrs={"role": "feed"})
    results_h1 = _MockElement(text="Results")

    # (a) Title matches current card, but URL !1s ID equals PRIOR verified card's ID
    # Simulates a browser where document.title updated, but the detail pane/URL hasn't transitioned yet.
    prior_card_id = "0x89c2598818da0645:0x2c2119fb675d62e7"
    current_card_id = "0x89c2f500322e9c67:0x2f8e74ea9cd25ee7"
    stale_url_page = _MockPage(
        url=f"https://www.google.com/maps/place/Prior+Cafe/@40.7,-74.0,15z/data=!4m2!3m1!1s{prior_card_id}",
        title="Liam’s Cafe - Google Maps",  # title matches current card!
        feed=feed,
        headings=[results_h1],
    )
    snap_a = await _read_panel_identity_snapshot(stale_url_page, feed)
    ok_a, reason_a = _evaluate_panel_identity(
        snap_a,
        card_href=f"https://www.google.com/maps/place/Liam%E2%80%99s+Cafe/@40.8,-73.8,15z/data=!4m2!3m1!1s{current_card_id}",
        place_key=current_card_id,
        card_signals={"name": "Liam’s Cafe"},
        pre_click_snapshot=None,
        last_verified_panel={
            "place_key": prior_card_id,
            "place_id": prior_card_id,
            "url_place_id": prior_card_id,
            "name": "prior cafe",
            "title_name": "prior cafe",
        },
    )
    assert ok_a is False, "Must reject when panel URL place ID belongs to prior card"
    assert reason_a == "panel_place_id_unchanged_from_prior"
    assert snap_a["verdict_source"] == "url_id"

    # (b) Title equals prior card's title and differs from current card
    stale_title_page = _MockPage(
        url="https://www.google.com/maps/place/Prior+Cafe/@40.7,-74.0,15z",
        title="Prior Cafe - Google Maps",
        feed=feed,
        headings=[results_h1],
    )
    snap_b = await _read_panel_identity_snapshot(stale_title_page, feed)
    ok_b, reason_b = _evaluate_panel_identity(
        snap_b,
        card_href=f"https://www.google.com/maps/place/Liam%E2%80%99s+Cafe/@40.8,-73.8,15z/data=!4m2!3m1!1s{current_card_id}",
        place_key=current_card_id,
        card_signals={"name": "Liam’s Cafe"},
        pre_click_snapshot=None,
        last_verified_panel={
            "place_key": prior_card_id,
            "place_id": prior_card_id,
            "name": "prior cafe",
            "title_name": "prior cafe",
        },
    )
    assert ok_b is False, "Must reject when title belongs to prior card"
    assert reason_b in ("name_conflict", "panel_name_and_address_unchanged_from_prior", "panel_place_id_unchanged_from_prior") or "name_conflict" in reason_b

    # (c) Split-view / feed-visible scenario: detail panel is open before click (pre_click_snapshot)
    # Clicking a second card while the first card's detail panel is still mounted must reject.
    pre_click_snap = {
        "open": True,
        "name": "prior cafe",
        "raw_name": "Prior Cafe",
        "title_name": "prior cafe",
        "place_id": prior_card_id,
        "url_place_id": prior_card_id,
        "url": f"https://www.google.com/maps/place/Prior+Cafe/@40.7,-74.0,15z/data=!4m2!3m1!1s{prior_card_id}",
        "address": "100 Broadway, New York, NY",
    }
    split_view_page = _MockPage(
        url=f"https://www.google.com/maps/place/Prior+Cafe/@40.7,-74.0,15z/data=!4m2!3m1!1s{prior_card_id}",
        title="Prior Cafe - Google Maps",
        feed=feed,
        headings=[_MockElement(text="Prior Cafe")],
        other_elements={"[data-item-id='address'] .fontBodyMedium": _MockElement(text="100 Broadway, New York, NY")},
    )
    snap_c = await _read_panel_identity_snapshot(split_view_page, feed)
    ok_c, reason_c = _evaluate_panel_identity(
        snap_c,
        card_href=f"https://www.google.com/maps/place/Second+Shop/@40.8,-73.8,15z/data=!4m2!3m1!1s{current_card_id}",
        place_key=current_card_id,
        card_signals={"name": "Second Shop"},
        pre_click_snapshot=pre_click_snap,
        last_verified_panel=pre_click_snap,
    )
    assert ok_c is False, "Split-view un-transitioned panel must be rejected as stale from pre-click state"
    assert reason_c in ("panel_place_id_unchanged_from_prior", "name_conflict(expected='second shop',actual='prior cafe')")


# ---------------------------------------------------------------------------
# Title regex suffix tests (' - ', ' – ', ' · ')
# ---------------------------------------------------------------------------


def test_google_maps_title_suffix_re_variants():
    """Confirm _GOOGLE_MAPS_TITLE_SUFFIX_RE accepts ' - ', ' – ' and ' · ' before 'Google Maps'."""
    from scraper.maps_scraper import _GOOGLE_MAPS_TITLE_SUFFIX_RE, _extract_title_place_name

    # 1. Standard hyphen ' - '
    t_hyphen = "Liam’s Cafe - Google Maps"
    assert _GOOGLE_MAPS_TITLE_SUFFIX_RE.search(t_hyphen) is not None
    assert _extract_title_place_name(t_hyphen) == "Liam’s Cafe"

    # 2. En-dash ' – ' (\u2013)
    t_endash = "Liam’s Cafe \u2013 Google Maps"
    assert _GOOGLE_MAPS_TITLE_SUFFIX_RE.search(t_endash) is not None
    assert _extract_title_place_name(t_endash) == "Liam’s Cafe"

    # 3. Middle dot ' · ' (\u00b7)
    t_middledot = "Liam’s Cafe \u00b7 Google Maps"
    assert _GOOGLE_MAPS_TITLE_SUFFIX_RE.search(t_middledot) is not None
    assert _extract_title_place_name(t_middledot) == "Liam’s Cafe"

    # 4. Em-dash ' — ' (\u2014)
    t_emdash = "Liam’s Cafe \u2014 Google Maps"
    assert _GOOGLE_MAPS_TITLE_SUFFIX_RE.search(t_emdash) is not None
    assert _extract_title_place_name(t_emdash) == "Liam’s Cafe"


# ---------------------------------------------------------------------------
# Panel content marker wait tests (immediate, 1s delay, never mount)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_panel_content_markers_present_immediately():
    """When panel content markers are present immediately after verification,
    _wait_for_panel_content_markers returns True without polling."""
    from scraper.maps_scraper import _wait_for_panel_content_markers

    page = _MockPage(
        url="https://www.google.com/maps/place/Liam%E2%80%99s+Cafe/@40.8,-73.8,15z",
        title="Liam’s Cafe - Google Maps",
        headings=[_MockElement(text="Liam’s Cafe")],
        other_elements={
            "[data-item-id='address']": _MockElement(text="123 Main St, New York, NY"),
        },
    )

    mounted = await _wait_for_panel_content_markers(
        page,
        timeout_s=2.5,
        poll_interval_s=0.15,
    )
    assert mounted is True


@pytest.mark.asyncio
async def test_panel_content_markers_mount_after_1s():
    """When panel content markers take 1s to mount in the DOM,
    _wait_for_panel_content_markers polls and succeeds once they appear."""
    from scraper.maps_scraper import _wait_for_panel_content_markers

    loop = asyncio.get_event_loop()
    start_time = loop.time()

    class _DelayedMountPage:
        def __init__(self, delay_s: float = 1.0):
            self.delay_s = delay_s
            self.url = "https://www.google.com/maps/place/Liam%E2%80%99s+Cafe/@40.8,-73.8,15z"

        async def query_selector(self, selector: str):
            elapsed = loop.time() - start_time
            if elapsed < self.delay_s:
                return None
            if "phone:" in selector:
                return _MockElement(text="+1 212-555-0199")
            if "h1" in selector:
                return _MockElement(text="Liam’s Cafe")
            return None

    page = _DelayedMountPage(delay_s=1.0)
    mounted = await _wait_for_panel_content_markers(
        page,
        timeout_s=2.5,
        poll_interval_s=0.15,
    )
    assert mounted is True
    elapsed = loop.time() - start_time
    assert elapsed >= 0.9, f"Should have waited for the 1s delay, took {elapsed}s"


@pytest.mark.asyncio
async def test_panel_content_markers_never_mount_logs_verified_but_empty(caplog, monkeypatch):
    """When a card verifies via url_id/title but no panel content markers ever mount,
    _wait_for_panel_content_markers returns False after re-reading once.
    The scraper treats the card as unverified, logs [maps][verified-but-empty],
    and does not yield an empty lead."""
    from scraper.maps_scraper import _wait_for_panel_content_markers

    class _EmptyPage:
        def __init__(self):
            self.url = "https://www.google.com/maps/place/Ghost+Cafe/@40.8,-73.8,15z"
            self.query_count = 0

        async def query_selector(self, selector: str):
            self.query_count += 1
            return None

    page = _EmptyPage()
    mounted = await _wait_for_panel_content_markers(
        page,
        timeout_s=0.3,
        poll_interval_s=0.1,
    )
    assert mounted is False
    assert page.query_count > 0, "Must have polled and re-read"

    # Also verify the scraper flow via scraper.search()
    from scraper.maps_scraper import MapsScraper, ScraperConfig

    config = ScraperConfig(
        scroll_max_rounds=1,
        max_crash_retries=0,
        place_timeout_ms=100,
        max_stale_panel_retries_per_card=0,
    )
    config.panel_content_marker_timeout_s = 0.2
    config.panel_content_marker_poll_s = 0.05
    scraper = MapsScraper(config)
    scraper._is_launched = True
    scraper._is_owned = True
    scraper._is_closed = False
    scraper._browser = object()

    class _TestAnchor:
        def __init__(self, idx: int):
            self._href = f"https://www.google.com/maps/place/Empty+Cafe/data=!3m6!1s0x1000:0x{idx:04x}"

        async def get_attribute(self, name: str):
            return self._href if name == "href" else ""

        async def inner_text(self):
            return "Empty Cafe"

        async def scroll_into_view_if_needed(self, **_k):
            return None

    class _TestFeed:
        def __init__(self, anchors):
            self._anchors = anchors

        async def query_selector_all(self, _sel: str):
            return self._anchors

    anchor = _TestAnchor(99)

    class _EmptyDetailPanelPage:
        def __init__(self, anchors):
            self.url = "https://www.google.com/maps/search/Coffee+Shop"
            self._feed = _TestFeed(anchors)
            self._clicked = False

        async def title(self):
            return "Empty Cafe - Google Maps" if self._clicked else "Google Maps"

        async def goto(self, url: str, **_k):
            self.url = url

        async def wait_for_selector(self, *_a, **_k):
            return None

        async def evaluate(self, *_a, **_k):
            return "You've reached the end of the list"

        async def query_selector(self, sel: str):
            if sel == "div[role='feed']":
                return self._feed
            return None

        async def close(self):
            return None

    empty_page = _EmptyDetailPanelPage([anchor])

    class _Context:
        async def new_page(self):
            return empty_page

        async def close(self):
            return None

    async def _click(p, a):
        p.url = await a.get_attribute("href")
        p._clicked = True

    async def _true_async(*_a, **_k):
        return True

    async def _fake_new_context(*_a, **_k):
        return _Context()

    monkeypatch.setattr(ms, "_new_stealth_context", _fake_new_context)
    monkeypatch.setattr(ms, "_human_click", _click)
    monkeypatch.setattr(ms, "_human_scroll", lambda *_a, **_k: None)
    monkeypatch.setattr(ms, "_return_to_results", _true_async)
    monkeypatch.setattr(ms, "_is_feed_ready", _true_async)
    monkeypatch.setattr(ms, "_wait_for_place_settle", lambda *_a, **_k: None)

    yielded = []
    with caplog.at_level(logging.WARNING):
        async for p in scraper.search("Coffee Shop", city="New York", street="Ghost Area", max_results=5):
            yielded.append(p)

    assert yielded == [], "Must not yield an empty lead"
    assert any("[maps][verified-but-empty]" in record.message for record in caplog.records)


# ---------------------------------------------------------------------------
# MAST_PANEL_MARKER_WAIT_MS tests (default, override, clamping)
# ---------------------------------------------------------------------------


def test_panel_marker_wait_ms_default(monkeypatch):
    """When MAST_PANEL_MARKER_WAIT_MS is not set, resolve_panel_marker_wait_ms
    and ScraperConfig use the default 5000 ms."""
    from utils.runtime import resolve_panel_marker_wait_ms, ScraperConfig

    monkeypatch.delenv("MAST_PANEL_MARKER_WAIT_MS", raising=False)
    assert resolve_panel_marker_wait_ms() == 5000
    cfg = ScraperConfig()
    assert cfg.panel_marker_wait_ms == 5000
    assert resolve_panel_marker_wait_ms(cfg) == 5000


def test_panel_marker_wait_ms_env_override(monkeypatch):
    """When MAST_PANEL_MARKER_WAIT_MS is set, resolve_panel_marker_wait_ms
    and ScraperConfig honor the override within valid bounds."""
    from utils.runtime import resolve_panel_marker_wait_ms, ScraperConfig

    monkeypatch.setenv("MAST_PANEL_MARKER_WAIT_MS", "7500")
    assert resolve_panel_marker_wait_ms() == 7500
    cfg = ScraperConfig()
    assert cfg.panel_marker_wait_ms == 7500
    assert resolve_panel_marker_wait_ms(cfg) == 7500


def test_panel_marker_wait_ms_config_override():
    """Explicit config argument overrides default within valid bounds."""
    from utils.runtime import resolve_panel_marker_wait_ms, ScraperConfig

    cfg = ScraperConfig(panel_marker_wait_ms=8000)
    assert cfg.panel_marker_wait_ms == 8000
    assert resolve_panel_marker_wait_ms(cfg) == 8000


def test_panel_marker_wait_ms_clamping(monkeypatch):
    """Values below 500 ms are clamped to 500 ms; values above 15000 ms are clamped to 15000 ms."""
    from utils.runtime import resolve_panel_marker_wait_ms, ScraperConfig

    # Lower bound clamping
    monkeypatch.setenv("MAST_PANEL_MARKER_WAIT_MS", "200")
    assert resolve_panel_marker_wait_ms() == 500
    cfg_low = ScraperConfig()
    assert cfg_low.panel_marker_wait_ms == 500
    cfg_low_arg = ScraperConfig(panel_marker_wait_ms=100)
    assert cfg_low_arg.panel_marker_wait_ms == 500

    # Upper bound clamping
    monkeypatch.setenv("MAST_PANEL_MARKER_WAIT_MS", "25000")
    assert resolve_panel_marker_wait_ms() == 15000
    cfg_high = ScraperConfig()
    assert cfg_high.panel_marker_wait_ms == 15000
    cfg_high_arg = ScraperConfig(panel_marker_wait_ms=30000)
    assert cfg_high_arg.panel_marker_wait_ms == 15000


@pytest.mark.asyncio
async def test_wait_for_panel_content_markers_uses_env_override(monkeypatch):
    """_wait_for_panel_content_markers defaults timeout_s to resolve_panel_marker_wait_ms() / 1000.0."""
    from scraper.maps_scraper import _wait_for_panel_content_markers

    monkeypatch.setenv("MAST_PANEL_MARKER_WAIT_MS", "600")

    class _EmptyPage:
        async def query_selector(self, _sel: str):
            return None

    page = _EmptyPage()
    loop = asyncio.get_event_loop()
    t0 = loop.time()
    mounted = await _wait_for_panel_content_markers(page, poll_interval_s=0.15)
    t1 = loop.time()

    assert mounted is False
    elapsed = t1 - t0
    # Expected ~0.6s wait + single re-read
    assert 0.5 <= elapsed <= 1.5, f"Expected ~0.6s wait, took {elapsed}s"

