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
    """Panel open with back button, but heading text is empty string."""
    back_button = _MockElement(attrs={"aria-label": "Back to results"})
    empty_h1 = _MockElement(text="")
    feed = _MockElement(attrs={"role": "feed"})

    page = _MockPage(
        url="https://www.google.com/maps/place/Some+Cafe/data=!4m2!3m1!1s0x1:0x2",
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
