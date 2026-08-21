"""
Phase 11.3 — Identify early-pruned candidates (telemetry only)
================================================================

Regression coverage for `engine.execution_driver._log_discovery_early_prune`,
which fires exactly once, for the exact
"no valid email on Maps and no website to discover email" early-prune gate
inside `_on_candidate` (see Phase 4A-C / `test_phase4a_discovery_filters.py`
for the gate itself). This module never re-implements the prune condition —
it drives the real `_on_candidate` closure through the public
`build_seven_stage_pipeline()` composition root, exactly like
`tests/test_phase4a_discovery_filters.py` does, and asserts on:

    1. the candidate is still pruned exactly as before (no behavior change)
    2. no Website/Instagram/Contact work is ever triggered for it
    3. the new `[discovery-early-prune]` log line carries the required
       structured fields, with correct values, for both providers
    4. every other prune reason (closed, chain/cannabis, phone, instagram,
       website) does NOT emit this telemetry — it is scoped to this one gate
    5. the telemetry helper itself performs no network I/O
"""

from __future__ import annotations

import json
import logging

import pytest

from engine.contracts import BusinessCandidate
from engine.coordinator import EngineCoordinator
from engine.execution_driver import build_seven_stage_pipeline
from engine.interfaces import DiscoveryProviderInterface

LOGGER_NAME = "mast.engine.execution_driver"


class DummyDiscoveryProvider(DiscoveryProviderInterface):
    @property
    def provider_id(self) -> str:
        return "dummy"

    @property
    def display_name(self) -> str:
        return "Dummy"

    def discover(self, request):
        return iter([])


class DummyStorageBackend:
    def __init__(self):
        self.persisted = []

    def persist(self, opportunity):
        self.persisted.append(opportunity)
        return opportunity


def _make_candidate(
    pipeline_id: str,
    *,
    provider: str = "google_maps",
    name: str = "Example Coffee",
    category: str = "Cafe",
    address: str = "123 Main St, New York, NY",
    website: str = "",
    phone: str = "",
    maps_url: str | None = None,
    closed: bool = False,
) -> BusinessCandidate:
    return BusinessCandidate(
        pipeline_id=pipeline_id,
        session_id="session-test",
        provider=provider,
        name=name,
        category=category,
        address=address,
        city="New York",
        country="US",
        website=website,
        phone=phone,
        maps_url=maps_url,
        closed=closed,
    )


def _setup_pipeline(required_channels=None):
    """Mirrors tests/test_phase4a_discovery_filters.py::_setup_pipeline."""
    coordinator = EngineCoordinator()
    ctx = coordinator.create_session(
        user_id="test-user",
        provider="dummy",
        requested_count=10,
    )
    session_id = ctx.session.id
    coordinator.start_session(session_id)
    provider = DummyDiscoveryProvider()
    backend = DummyStorageBackend()

    stages, queue_ids, fan_in, on_stage_outcome = build_seven_stage_pipeline(
        coordinator,
        session_id,
        discovery_provider=provider,
        discovery_request=type("Req", (), {"session_id": session_id})(),
        storage_backend=backend,
        required_channels=required_channels,
    )
    stage_map = {s.name: s for s in stages}
    on_candidate = stage_map["discovery"].produce_worker_input().on_candidate

    session_ctx = coordinator.get_session(session_id)
    queue_manager = session_ctx.runtime.queue_manager
    website_queue = queue_manager.get_queue(queue_ids.website_in)
    instagram_queue = queue_manager.get_queue(queue_ids.instagram_in)

    return on_candidate, fan_in, website_queue, instagram_queue


def _prune_log_records(caplog):
    return [r for r in caplog.records if r.getMessage().startswith("[discovery-early-prune]")]


def _parse_prune_payload(record):
    message = record.getMessage()
    assert message.startswith("[discovery-early-prune] ")
    return json.loads(message[len("[discovery-early-prune] "):])


# ---------------------------------------------------------------------------
# 1 & 2. provider is recorded correctly for both real providers
# ---------------------------------------------------------------------------


def test_google_maps_candidate_with_no_website_logs_provider_google_maps(caplog):
    on_candidate, fan_in, website_queue, instagram_queue = _setup_pipeline(
        required_channels=["email"]
    )
    candidate = _make_candidate(
        "p-gmaps",
        provider="google_maps",
        website="",
        phone="+14165550199",
        maps_url="https://www.google.com/maps/place/?q=place_id:abc123",
    )

    with caplog.at_level(logging.INFO, logger=LOGGER_NAME):
        on_candidate(candidate)

    records = _prune_log_records(caplog)
    assert len(records) == 1
    payload = _parse_prune_payload(records[0])
    assert payload["provider"] == "google_maps"

    # candidate is still pruned exactly as before
    assert fan_in.get_business("p-gmaps") is None
    assert website_queue.size() == 0
    assert instagram_queue.size() == 0


def test_overpass_candidate_with_no_website_logs_provider_overpass(caplog):
    on_candidate, fan_in, website_queue, instagram_queue = _setup_pipeline(
        required_channels=["email"]
    )
    candidate = _make_candidate(
        "p-overpass",
        provider="overpass",
        website="",
        phone="",
        maps_url="https://www.openstreetmap.org/node/12345",
    )

    with caplog.at_level(logging.INFO, logger=LOGGER_NAME):
        on_candidate(candidate)

    records = _prune_log_records(caplog)
    assert len(records) == 1
    payload = _parse_prune_payload(records[0])
    assert payload["provider"] == "overpass"

    assert fan_in.get_business("p-overpass") is None
    assert website_queue.size() == 0
    assert instagram_queue.size() == 0


# ---------------------------------------------------------------------------
# 3. unknown provider safely logs "unknown"
# ---------------------------------------------------------------------------


def test_falsy_provider_safely_logs_unknown(caplog):
    on_candidate, fan_in, website_queue, instagram_queue = _setup_pipeline(
        required_channels=["email"]
    )
    candidate = _make_candidate("p-unknown-provider", provider="", website="")

    with caplog.at_level(logging.INFO, logger=LOGGER_NAME):
        on_candidate(candidate)

    records = _prune_log_records(caplog)
    assert len(records) == 1
    payload = _parse_prune_payload(records[0])
    assert payload["provider"] == "unknown"


# ---------------------------------------------------------------------------
# 4-10. field-level correctness of the telemetry payload
# ---------------------------------------------------------------------------


def test_telemetry_payload_preserves_all_required_fields(caplog):
    on_candidate, fan_in, website_queue, instagram_queue = _setup_pipeline(
        required_channels=["email"]
    )
    candidate = _make_candidate(
        "p-full",
        provider="overpass",
        name="Example Coffee",
        address="123 Main St, New York, NY",
        website="",
        phone="+15551234567",
        maps_url="https://www.openstreetmap.org/node/98765",
    )

    with caplog.at_level(logging.INFO, logger=LOGGER_NAME):
        on_candidate(candidate)

    records = _prune_log_records(caplog)
    assert len(records) == 1
    payload = _parse_prune_payload(records[0])

    # business_name preserved
    assert payload["business_name"] == "Example Coffee"
    # address preserved
    assert payload["address"] == "123 Main St, New York, NY"
    # phone preserved
    assert payload["phone"] == "+15551234567"
    # has_phone correct
    assert payload["has_phone"] is True
    # has_website is False for this exact gate
    assert payload["has_website"] is False
    # maps_place_id / source identifier preserved when available.
    # This candidate's maps_url carries no Google-style place id (no
    # ChIJ.../hex feature id), so the strongest available identifier
    # falls back to the normalized map link itself (matching
    # maps_place_id_from_keys' own documented fallback order) — never
    # fabricated.
    assert payload["maps_place_id"] == "https://www.openstreetmap.org/node/98765"
    assert payload["source_url"] == "https://www.openstreetmap.org/node/98765"
    # prune_reason is exactly the required constant
    assert payload["prune_reason"] == "no_email_and_no_website"


def test_has_phone_false_when_no_phone(caplog):
    on_candidate, fan_in, website_queue, instagram_queue = _setup_pipeline(
        required_channels=["email"]
    )
    candidate = _make_candidate("p-no-phone", website="", phone="")

    with caplog.at_level(logging.INFO, logger=LOGGER_NAME):
        on_candidate(candidate)

    payload = _parse_prune_payload(_prune_log_records(caplog)[0])
    assert payload["has_phone"] is False
    assert payload["phone"] in (None, "")


def test_google_style_place_id_extracted_when_present(caplog):
    """When the maps_url carries a canonical Google ChIJ... place id,
    maps_place_id reflects that extracted id (not just the raw URL)."""
    on_candidate, fan_in, website_queue, instagram_queue = _setup_pipeline(
        required_channels=["email"]
    )
    candidate = _make_candidate(
        "p-chij",
        provider="google_maps",
        website="",
        phone="+15551234567",
        maps_url="https://maps.google.com/?cid=1&q=place_id:ChIJN1t_tDeuEmsRUsoyG83frY4",
    )

    with caplog.at_level(logging.INFO, logger=LOGGER_NAME):
        on_candidate(candidate)

    payload = _parse_prune_payload(_prune_log_records(caplog)[0])
    # early_fingerprint_keys lowercases the extracted place id when
    # building its `place:` key — maps_place_id reflects that same,
    # already-established normalization rather than inventing a
    # different casing.
    assert payload["maps_place_id"] == "chijn1t_tdeuemsrusoyg83fry4"
    assert payload["source_url"] == candidate.maps_url


def test_maps_place_id_null_when_unavailable(caplog):
    """No maps_url at all -> no identifier can be derived; must be null,
    never fabricated."""
    on_candidate, fan_in, website_queue, instagram_queue = _setup_pipeline(
        required_channels=["email"]
    )
    candidate = _make_candidate("p-no-id", website="", maps_url=None)

    with caplog.at_level(logging.INFO, logger=LOGGER_NAME):
        on_candidate(candidate)

    payload = _parse_prune_payload(_prune_log_records(caplog)[0])
    assert payload["maps_place_id"] is None
    assert payload["source_url"] is None


# ---------------------------------------------------------------------------
# 11 & 12. candidate is still pruned; no downstream enrichment triggered
# ---------------------------------------------------------------------------


def test_candidate_is_still_pruned_and_no_enrichment_triggered(caplog):
    on_candidate, fan_in, website_queue, instagram_queue = _setup_pipeline(
        required_channels=["email"]
    )
    candidate = _make_candidate("p-pruned", website="", phone="")

    with caplog.at_level(logging.INFO, logger=LOGGER_NAME):
        on_candidate(candidate)

    assert fan_in.get_business("p-pruned") is None
    assert website_queue.size() == 0
    assert instagram_queue.size() == 0


# ---------------------------------------------------------------------------
# Telemetry is scoped to exactly this gate — no other prune reason emits it
# ---------------------------------------------------------------------------


def test_closed_business_prune_does_not_emit_early_prune_telemetry(caplog):
    on_candidate, fan_in, website_queue, instagram_queue = _setup_pipeline(
        required_channels=["email"]
    )
    candidate = _make_candidate("p-closed", website="", closed=True)

    with caplog.at_level(logging.INFO, logger=LOGGER_NAME):
        on_candidate(candidate)

    assert _prune_log_records(caplog) == []


def test_chain_keyword_prune_does_not_emit_early_prune_telemetry(caplog):
    on_candidate, fan_in, website_queue, instagram_queue = _setup_pipeline(
        required_channels=["email"]
    )
    candidate = _make_candidate(
        "p-chain", name="Starbucks Downtown", category="Cafe", website=""
    )

    with caplog.at_level(logging.INFO, logger=LOGGER_NAME):
        on_candidate(candidate)

    assert _prune_log_records(caplog) == []


def test_phone_channel_prune_does_not_emit_email_gate_telemetry(caplog):
    on_candidate, fan_in, website_queue, instagram_queue = _setup_pipeline(
        required_channels=["phone"]
    )
    candidate = _make_candidate("p-phone-gate", website="", phone="")

    with caplog.at_level(logging.INFO, logger=LOGGER_NAME):
        on_candidate(candidate)

    assert _prune_log_records(caplog) == []


def test_email_gate_not_pruned_and_no_telemetry_when_website_present(caplog):
    """The website fallback path (email required, website present) is not
    pruned at all, so no telemetry fires — matches
    test_phase4a_discovery_filters.py::
    test_email_required_channel_preserved_website_fallback_exactly."""
    on_candidate, fan_in, website_queue, instagram_queue = _setup_pipeline(
        required_channels=["email"]
    )
    candidate = _make_candidate("p-has-site", website="https://bakery.com")

    with caplog.at_level(logging.INFO, logger=LOGGER_NAME):
        on_candidate(candidate)

    assert _prune_log_records(caplog) == []
    assert fan_in.get_business("p-has-site") is not None
    assert website_queue.size() == 1
    assert instagram_queue.size() == 1


# ---------------------------------------------------------------------------
# 13. no network side effects — telemetry only serializes existing fields
# ---------------------------------------------------------------------------


def test_telemetry_helper_performs_no_network_calls(monkeypatch, caplog):
    """Patch socket.socket to explode on any attempted network connection;
    the telemetry call must not trigger it."""
    import socket

    def _forbidden(*args, **kwargs):
        raise AssertionError("telemetry must not perform network I/O")

    monkeypatch.setattr(socket, "socket", _forbidden)

    on_candidate, fan_in, website_queue, instagram_queue = _setup_pipeline(
        required_channels=["email"]
    )
    candidate = _make_candidate("p-no-network", website="", phone="+14165550199")

    with caplog.at_level(logging.INFO, logger=LOGGER_NAME):
        on_candidate(candidate)  # must not raise

    assert len(_prune_log_records(caplog)) == 1


def test_no_duplicate_telemetry_logs_for_single_prune_event(caplog):
    on_candidate, fan_in, website_queue, instagram_queue = _setup_pipeline(
        required_channels=["email"]
    )
    candidate = _make_candidate("p-single", website="")

    with caplog.at_level(logging.INFO, logger=LOGGER_NAME):
        on_candidate(candidate)

    assert len(_prune_log_records(caplog)) == 1
