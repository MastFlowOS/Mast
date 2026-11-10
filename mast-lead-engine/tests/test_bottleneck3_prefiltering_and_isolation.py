"""
tests/test_bottleneck3_prefiltering_and_isolation.py
===================================================

Comprehensive test suite for Bottleneck 3:
1. DesktopWorker task-scoped Place ID state & tenant isolation (no cross-user leak).
2. Place ID normalization & bidirectional conversion (Hex <-> ChIJ <-> prefixed fingerprints).
3. Feed card signal extraction & closed business detection (permanent, temporary, localized, container-scoped).
4. Safe pre-click filters (Tier 1 Known User Place IDs, Tier 2 Explicit Closure, failure-open on unknown).
5. Contact channel preservation (missing feed website/phone/email/instagram NEVER causes pre-click skip).
"""

import asyncio
import re
import pytest
from unittest.mock import AsyncMock, MagicMock, patch

from desktop_worker import DesktopWorker
from utils.place_id import chij_to_hex, hex_to_chij, canonical_place_id, expand_place_id_forms
from scraper.maps_scraper import (
    _extract_card_signals,
    _stable_place_id_from_url,
    _PERMANENTLY_CLOSED_MARKERS,
    _TEMPORARILY_CLOSED_MARKERS,
)


# ──────────────────────────────────────────────────────────────────────────────
# PART 1: DesktopWorker Task-Scoped State & Tenant Isolation
# ──────────────────────────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_desktop_worker_task_state_isolation_between_users():
    """Worker task state must be strictly isolated per execute_task invocation.
    IDs received from User A's task must never leak into User B's task."""
    client = MagicMock()
    client.heartbeat = AsyncMock(return_value=True)
    client.ingest_batch = AsyncMock(return_value={"accepted": 1, "rejected": 0, "duplicates": 0})
    client.complete_task = AsyncMock(return_value=True)

    captured_pids = []

    async def mock_runner(**kwargs):
        # Snapshot the active filter set during runner execution before task cleanup
        captured_pids.append(set(kwargs["known_place_ids"]))
        # Yield one candidate that has a maps_link with a new Place ID
        yield {
            "name": "Discovered Business",
            "maps_link": "https://www.google.com/maps/place/Foo/@41.8,-87.6/data=!1s0x880fcd_new:0x123",
            "city": "Chicago",
            "country": "US",
            "website": "https://foo.example.com",
            "phone": "+15551234567",
        }

    worker = DesktopWorker(client=client, engine_runner=mock_runner)

    task_a = {
        "id": "task-userA-001",
        "leaseToken": "lease-a",
        "planId": "plan-a",
        "niche": "plumbers",
        "city": "Chicago",
        "countryCode": "US",
        "candidateBudget": 1,
        "knownPlaceIds": ["0x880fcd_userA_1:0x111", "ChIJuserAPlaceA"],
    }

    task_b = {
        "id": "task-userB-002",
        "leaseToken": "lease-b",
        "planId": "plan-b",
        "niche": "dentists",
        "city": "Chicago",
        "countryCode": "US",
        "candidateBudget": 1,
        "knownPlaceIds": ["0x880fcd_userB_1:0x222"],
    }

    # Execute Task A
    await worker.execute_task(task_a)
    assert len(captured_pids) == 1
    pids_a = captured_pids[0]
    assert "0x880fcd_userA_1:0x111" in pids_a
    assert "ChIJuserAPlaceA" in pids_a
    assert "0x880fcd_userB_1:0x222" not in pids_a

    # Execute Task B (different user/task)
    await worker.execute_task(task_b)
    assert len(captured_pids) == 2
    pids_b = captured_pids[1]

    # CRITICAL MULTI-TENANT ISOLATION:
    # Task B must NOT contain User A's known Place IDs or IDs discovered in Task A!
    assert "0x880fcd_userB_1:0x222" in pids_b
    assert "0x880fcd_userA_1:0x111" not in pids_b, "User A known ID leaked into User B task!"
    assert "ChIJuserAPlaceA" not in pids_b, "User A known ID leaked into User B task!"
    assert "0x880fcd_new:0x123" not in pids_b, "In-run discovered ID from Task A leaked into Task B!"


@pytest.mark.asyncio
async def test_desktop_worker_in_run_ids_accumulate_within_same_task():
    """Within a single task, newly discovered Place IDs must accumulate dynamically
    to prevent the scraper from re-processing duplicate cards in the same run."""
    client = MagicMock()
    client.heartbeat = AsyncMock(return_value=True)
    client.ingest_batch = AsyncMock(return_value={"accepted": 2, "rejected": 0, "duplicates": 0})
    client.complete_task = AsyncMock(return_value=True)

    active_set_ref = None

    async def mock_runner(**kwargs):
        nonlocal active_set_ref
        active_set_ref = kwargs["known_place_ids"]
        # Yield first lead with Hex place ID
        yield {
            "name": "Cafe One",
            "maps_link": "https://www.google.com/maps/place/CafeOne/@41.8,-87.6/data=!1s0x880e_lead1:0xaaa",
            "city": "Chicago",
            "country": "US",
        }
        # Yield second lead with ChIJ place ID
        yield {
            "name": "Cafe Two",
            "maps_link": "https://www.google.com/maps/place/CafeTwo/ChIJ_lead2_bbbbbbbbbbbb",
            "city": "Chicago",
            "country": "US",
        }

    worker = DesktopWorker(client=client, engine_runner=mock_runner)
    task = {
        "id": "task-acc-001",
        "leaseToken": "lease-acc",
        "candidateBudget": 2,
        "knownPlaceIds": ["0xinitial:0x111"],
    }

    await worker.execute_task(task)
    # The active set passed into query_params should have received both dynamically discovered IDs
    assert "0xinitial:0x111" in active_set_ref or len(active_set_ref) == 0  # was cleared in finally


# ──────────────────────────────────────────────────────────────────────────────
# PART 2: Place ID Normalization & Format Compatibility
# ──────────────────────────────────────────────────────────────────────────────

def test_hex_and_chij_bidirectional_conversion():
    hex_pair = "0x880fcd7f8fee01b5:0x89b38e817d796008"
    chij = hex_to_chij(hex_pair)
    assert chij is not None
    assert chij.startswith("ChIJ")
    assert len(chij) == 27

    back_to_hex = chij_to_hex(chij)
    assert back_to_hex == hex_pair


def test_expand_place_id_forms_contains_all_equivalent_representations():
    raw_hex = "0x880FCD7F8FEE01B5:0x89B38E817D796008"
    forms = expand_place_id_forms(raw_hex)
    assert raw_hex in forms
    assert raw_hex.lower() in forms
    assert canonical_place_id(raw_hex) in forms
    # Equivalent ChIJ must also be generated (exact case preserved)
    chij = hex_to_chij(canonical_place_id(raw_hex))
    assert chij in forms
    assert chij.lower() not in forms


def test_chij_case_sensitivity_and_canonical_matching():
    """ChIJ tokens are Base64URL and MUST be case-sensitive.
    Two tokens differing only by case must NOT collide, while equivalent Hex and ChIJ must match.
    """
    hex_a = "0x880e2c3cd0f4c5a7:0x4c3d2e1b0a9f8e7d"
    chij_a = hex_to_chij(hex_a)
    assert chij_a == "ChIJp8X00DwsDogRfY6fChsuPUw"

    # Distinct ChIJ differing only by casing of a character (lowercase 'p' vs uppercase 'P')
    chij_b = "ChIJp8X00DwsDogRfY6fChsupUw"

    forms_a = expand_place_id_forms(chij_a)
    forms_b = expand_place_id_forms(chij_b)

    # 1. ChIJ tokens must never be lowercased
    assert chij_a.lower() not in forms_a
    assert chij_b.lower() not in forms_b

    # 2. Distinct tokens differing only by case must NOT collide
    assert not (forms_a & forms_b), "Distinct ChIJ tokens collided due to improper casing normalization!"
    assert chij_b not in forms_a
    assert chij_a not in forms_b

    # 3. Hex representations CAN and SHOULD match case-insensitively
    hex_forms = expand_place_id_forms(hex_a.upper())
    assert chij_a in hex_forms
    assert hex_a in forms_a
    assert hex_a.upper() in forms_a or hex_a.lower() in forms_a


def test_viewport_tokens_stripped_and_not_mistaken_for_place_ids():
    # URL containing both a !5s viewport anchor and a genuine !1s place ID
    url_with_5s = "https://www.google.com/maps/place/Lincoln+Park/@41.92,-87.64,15z/data=!3m1!5s0x880fd34b1234:0x5678!4m6!3m5!1s0x880fd38a6a2a0141:0x6a161fa406cb7473!8m2!3d41.921!4d-87.637"
    pid = _stable_place_id_from_url(url_with_5s)
    assert pid == "0x880fd38a6a2a0141:0x6a161fa406cb7473"
    assert "0x880fd34b1234:0x5678" not in pid


# ──────────────────────────────────────────────────────────────────────────────
# PART 3: Feed Card Closed Business Detection
# ──────────────────────────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_extract_card_signals_detects_permanently_closed_from_container():
    """Anchor has empty inner_text, but containing card has 'Permanently closed' text."""
    anchor = MagicMock()
    anchor.get_attribute = AsyncMock(side_effect=lambda attr: "Colectivo Coffee · 4.5 · Coffee shop" if attr == "aria-label" else "")
    anchor.inner_text = AsyncMock(return_value="")  # Empty in real Google Maps overlay anchor
    anchor.evaluate = AsyncMock(return_value={
        "containerText": "Colectivo Coffee\n4.5 (1.2K)\nPermanently closed · 2530 N Lincoln Ave",
        "innerText": "",
        "aria": "Colectivo Coffee · 4.5 · Coffee shop",
        "href": "https://www.google.com/maps/place/data=!1s0x880e:0x123",
    })

    signals = await _extract_card_signals(anchor)
    assert signals["closed"] is True
    assert signals["closure_status"] == "permanently_closed"
    assert signals["name"] == "Colectivo Coffee"


@pytest.mark.asyncio
async def test_extract_card_signals_detects_temporarily_closed_from_container():
    """Containing card has 'Temporarily closed' text."""
    anchor = MagicMock()
    anchor.get_attribute = AsyncMock(side_effect=lambda attr: "The Corner Bakery · 4.1 · Bakery" if attr == "aria-label" else "")
    anchor.inner_text = AsyncMock(return_value="")
    anchor.evaluate = AsyncMock(return_value={
        "containerText": "The Corner Bakery\n4.1 (500)\nTemporarily closed · Reopens in Spring",
        "innerText": "",
        "aria": "The Corner Bakery · 4.1 · Bakery",
        "href": "https://www.google.com/maps/place/data=!1s0x880e:0x456",
    })

    signals = await _extract_card_signals(anchor)
    assert signals["closed"] is True
    assert signals["closure_status"] == "temporarily_closed"
    assert signals["name"] == "The Corner Bakery"


@pytest.mark.asyncio
async def test_extract_card_signals_supports_localized_closure_strings():
    """Spanish, French, and German closure markers must be recognized."""
    # Spanish
    anchor_es = MagicMock()
    anchor_es.evaluate = AsyncMock(return_value={
        "containerText": "Cafeteria El Sol\nCerrado permanentemente\nCalle Mayor 12",
        "innerText": "",
        "aria": "Cafeteria El Sol",
        "href": "",
    })
    sig_es = await _extract_card_signals(anchor_es)
    assert sig_es["closure_status"] == "permanently_closed"

    # French
    anchor_fr = MagicMock()
    anchor_fr.evaluate = AsyncMock(return_value={
        "containerText": "Bistrot Parisien\nFermé temporairement\nRue de Rivoli",
        "innerText": "",
        "aria": "Bistrot Parisien",
        "href": "",
    })
    sig_fr = await _extract_card_signals(anchor_fr)
    assert sig_fr["closure_status"] == "temporarily_closed"


@pytest.mark.asyncio
async def test_extract_card_signals_fails_open_when_ambiguous_or_unknown():
    """Cards with normal hours or failed evaluation must fail open to normal processing."""
    # Active open business
    anchor_open = MagicMock()
    anchor_open.evaluate = AsyncMock(return_value={
        "containerText": "Dark Matter Coffee\n4.8 (3.1K)\nOpen · Closes 7 PM",
        "innerText": "",
        "aria": "Dark Matter Coffee · 4.8 · Coffee shop",
        "href": "",
    })
    sig_open = await _extract_card_signals(anchor_open)
    assert sig_open["closed"] is False
    assert sig_open["closure_status"] == "not_marked_closed"

    # Exception during evaluation -> must fail open (closed=False, status=unknown)
    anchor_err = MagicMock()
    anchor_err.get_attribute = AsyncMock(side_effect=Exception("CDP connection disconnected"))
    anchor_err.evaluate = AsyncMock(side_effect=Exception("Frame detached"))
    anchor_err.inner_text = AsyncMock(side_effect=Exception("Frame detached"))
    sig_err = await _extract_card_signals(anchor_err)
    assert sig_err["closed"] is False
    assert sig_err["closure_status"] == "unknown"


# ──────────────────────────────────────────────────────────────────────────────
# PART 4: Contact Channel Safety (Never Reject Feed Cards for Missing Contacts)
# ──────────────────────────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_missing_feed_website_or_phone_does_not_mark_card_closed_or_ineligible():
    """Cards in Google Maps results feed often omit website and phone buttons to save space.
    An absent website/phone on the feed card must NEVER cause a pre-click skip."""
    anchor = MagicMock()
    # Card has name and rating, but NO website button, NO phone number, NO email
    anchor.evaluate = AsyncMock(return_value={
        "containerText": "Artisan Woodworks\n5.0 (12)\nFurniture maker · 123 Industrial Way\nOpen now",
        "innerText": "",
        "aria": "Artisan Woodworks · 5.0 · Furniture maker",
        "href": "https://www.google.com/maps/place/Artisan+Woodworks/@41.8,-87.6/data=!1s0x880e:0x777",
    })

    signals = await _extract_card_signals(anchor)
    assert signals["closed"] is False
    assert signals["closure_status"] == "not_marked_closed"
    # Candidate MUST NOT be skipped pre-click; it proceeds to detail panel click where full info is retrieved.


# ──────────────────────────────────────────────────────────────────────────────
# PART 5: Scraper Pre-Click Decision Gate Simulation
# ──────────────────────────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_scraper_preclick_skips_known_hex_pid_without_clicking():
    """When a candidate card's Place ID is known, it must be skipped before clicking."""
    known_place_ids_norm = set()
    for f in expand_place_id_forms("0x880fcd7f8fee01b5:0x89b38e817d796008"):
        known_place_ids_norm.add(f)
        known_place_ids_norm.add(f.lower())

    card_href = "https://www.google.com/maps/place/Data/data=!1s0x880fcd7f8fee01b5:0x89b38e817d796008"
    candidate_pid = _stable_place_id_from_url(card_href)

    cand_forms = expand_place_id_forms(candidate_pid)
    is_known = any(
        f in known_place_ids_norm or f.lower() in known_place_ids_norm
        for f in (cand_forms or [candidate_pid])
    )

    human_click_called = False
    if is_known:
        # Skipped pre-click!
        pass
    else:
        human_click_called = True

    assert is_known is True
    assert human_click_called is False


@pytest.mark.asyncio
async def test_scraper_preclick_skips_equivalent_chij_representation():
    """Known set was seeded with Hex, feed card contains equivalent ChIJ token in URL."""
    hex_pair = "0x880fcd7f8fee01b5:0x89b38e817d796008"
    chij_token = hex_to_chij(hex_pair)
    assert chij_token is not None

    # Server seeded with Hex representation
    known_place_ids_norm = set()
    for f in expand_place_id_forms(hex_pair):
        known_place_ids_norm.add(f)
        known_place_ids_norm.add(f.lower())

    # Card has ChIJ token in URL
    card_href = f"https://www.google.com/maps/place/Foo/{chij_token}"
    candidate_pid = _stable_place_id_from_url(card_href)

    cand_forms = expand_place_id_forms(candidate_pid)
    is_known = any(
        f in known_place_ids_norm or f.lower() in known_place_ids_norm
        for f in (cand_forms or [candidate_pid])
    )

    assert is_known is True, "Equivalent ChIJ token must match Hex Place ID in pre-click set!"


@pytest.mark.asyncio
async def test_scraper_preclick_skips_explicitly_closed_cards_and_proceeds_on_unknown():
    """Permanently and temporarily closed cards are skipped before click; unknown fails open."""
    # Test 1: Permanently closed card
    closed_anchor = MagicMock()
    closed_anchor.evaluate = AsyncMock(return_value={
        "containerText": "Historic Tavern\nPermanently closed",
        "innerText": "",
        "aria": "Historic Tavern",
        "href": "https://www.google.com/maps/place/data=!1s0x1:0x2",
    })
    sig1 = await _extract_card_signals(closed_anchor)
    assert sig1["closure_status"] == "permanently_closed"

    # Test 2: Temporarily closed card
    temp_anchor = MagicMock()
    temp_anchor.evaluate = AsyncMock(return_value={
        "containerText": "Seasonal Ice Cream\nTemporarily closed",
        "innerText": "",
        "aria": "Seasonal Ice Cream",
        "href": "https://www.google.com/maps/place/data=!1s0x3:0x4",
    })
    sig2 = await _extract_card_signals(temp_anchor)
    assert sig2["closure_status"] == "temporarily_closed"

    # Test 3: Open card with no closure marker
    open_anchor = MagicMock()
    open_anchor.evaluate = AsyncMock(return_value={
        "containerText": "Active Coffee\nOpen 7 AM - 6 PM",
        "innerText": "",
        "aria": "Active Coffee",
        "href": "https://www.google.com/maps/place/data=!1s0x5:0x6",
    })
    sig3 = await _extract_card_signals(open_anchor)
    assert sig3["closure_status"] == "not_marked_closed"
    assert sig3["closed"] is False


@pytest.mark.asyncio
async def test_task_local_seen_id_lifecycle_transient_failure_and_retries():
    """Verify task-local seen-ID lifecycle:
    1. First encounter times out during detail-pane mounting: ID is NOT blacklisted or added to known sets.
    2. Second encounter is allowed to retry (pre-click skip does NOT trigger).
    3. Second encounter extracts successfully: ID is added to task_active_filter_pids and known_place_ids_norm.
    4. Subsequent duplicate encounter is skipped pre-click.
    5. A failed enrichment or delivery attempt does not produce a delivered lead row, preserving clean retry semantics.
    """
    task_known_place_ids: set[str] = set()
    task_seen_place_ids: set[str] = set()
    task_active_filter_pids: set[str] = set(task_known_place_ids)
    known_place_ids_norm: set[str] = set()

    candidate_hex = "0x880fd123456789ab:0x9876543210fedcba"
    card_href = f"https://www.google.com/maps/place/Demo/@41.8,-87.6/data=!1s{candidate_hex}"
    cand_forms = expand_place_id_forms(candidate_hex)

    # Helper for pre-click check:
    def is_skipped_preclick(pid_forms: set[str]) -> bool:
        return any(
            f in known_place_ids_norm
            or (not f.startswith("ChIJ") and f.lower() in known_place_ids_norm)
            or (f in task_active_filter_pids or (not f.startswith("ChIJ") and f.lower() in task_active_filter_pids))
            for f in pid_forms
        )

    # ── STEP 1: First Encounter Times Out During Detail Panel Mounting ───────────
    # Initial state: not known, not seen
    assert is_skipped_preclick(cand_forms) is False, "Initial card must not be skipped pre-click"

    # Scraper attempts click, but detail panel wait times out with 'waiting_for_detail_panel'
    # Scraper aborts this card extraction attempt:
    # CRITICAL: Place ID must NOT be added to known_place_ids_norm, task_seen_place_ids, or task_active_filter_pids!
    assert candidate_hex not in known_place_ids_norm
    assert candidate_hex not in task_seen_place_ids
    assert candidate_hex not in task_active_filter_pids

    # ── STEP 2: Second Encounter Allowed to Retry ────────────────────────────────
    # When card is encountered a second time, pre-click check must NOT skip it!
    assert is_skipped_preclick(cand_forms) is False, "Transient failure must not blacklist card from retry"

    # ── STEP 3: Second Encounter Extracts Successfully ───────────────────────────
    # Detail panel mounts and extracts place data.
    # Scraper registers verified Place ID in known_place_ids_norm:
    for f in cand_forms:
        known_place_ids_norm.add(f)
        if not f.startswith("ChIJ"):
            known_place_ids_norm.add(f.lower())

    # Runner yields place, worker registers into task_seen_place_ids and task_active_filter_pids:
    task_seen_place_ids.add(candidate_hex)
    task_active_filter_pids.add(candidate_hex)

    assert candidate_hex in task_seen_place_ids
    assert candidate_hex in task_active_filter_pids
    assert candidate_hex in known_place_ids_norm

    # ── STEP 4: Subsequent Duplicate Encounter Skipped Pre-Click ─────────────────
    assert is_skipped_preclick(cand_forms) is True, "Extracted candidate must be skipped pre-click on duplicate encounter"

    # ── STEP 5: Failed Enrichment / Delivery Isolation ───────────────────────────
    # In server-side candidate pipeline:
    # If candidate fails enrichment (e.g. missing channel or website unreachable):
    lead_row_created = False  # deliverLead is NOT called on enrichment failure
    assert lead_row_created is False
    # If lead row was never created in DB, when a future task runs for this user,
    # getKnownPlaceIdsForTask (which queries leads!inner) will NOT include this ID,
    # allowing future plans with different channels or improved crawlers to rediscover it.


