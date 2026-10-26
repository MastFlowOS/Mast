"""
Tests verifying that RETURN_TO_RESULTS_FAILED propagates as a distinct scraper failure
and is never converted to SUCCESS_EXHAUSTED across single or composite providers.
"""

from __future__ import annotations

import io
import json
import os
import sys
import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

import service
from engine.contracts import BusinessCandidate
from engine.interfaces import DiscoveryProviderInterface
from exceptions import DiscoveryFailure, DiscoveryFailureReason
from providers.parallel_composite_provider import ParallelCompositeDiscoveryProvider, ParallelDiscoveryRequest


def _candidate(i: int, session_id: str, provider: str = "google_maps") -> BusinessCandidate:
    return BusinessCandidate(
        pipeline_id=f"pid-{i}",
        session_id=session_id,
        provider=provider,
        name=f"Business {i}",
        category="Coffee Shop",
        address=f"{100 + i} Main St",
        city="New York",
        country="US",
        website=f"https://example{i}.com",
        phone=f"+1212555{1000 + i}",
        rating=4.5,
        review_count=10,
    )


class _FailingMapsProvider(DiscoveryProviderInterface):
    def __init__(self, fail_after: int = 1) -> None:
        self.fail_after = fail_after
        self.yielded = 0

    @property
    def provider_id(self) -> str:
        return "google_maps"

    @property
    def display_name(self) -> str:
        return "Google Maps"

    def discover(self, request):
        for i in range(self.fail_after):
            self.yielded += 1
            yield _candidate(self.yielded, getattr(request, "session_id", "s1"), "google_maps")
        raise DiscoveryFailure(
            DiscoveryFailureReason.RETURN_TO_RESULTS_FAILED,
            "return_to_results failed 3 consecutive times",
        )


class _WorkingOverpassProvider(DiscoveryProviderInterface):
    def __init__(self, count: int = 2) -> None:
        self.count = count

    @property
    def provider_id(self) -> str:
        return "overpass"

    @property
    def display_name(self) -> str:
        return "Overpass"

    def discover(self, request):
        for i in range(self.count):
            yield _candidate(100 + i, getattr(request, "session_id", "s1"), "overpass")


@pytest.mark.asyncio
async def test_single_provider_return_to_results_failed_sentinel(monkeypatch, tmp_path):
    """When MapsScraper fails with RETURN_TO_RESULTS_FAILED, __done__ must report failure, not exhaustion."""
    monkeypatch.setattr(service, "GoogleMapsProvider", lambda **kwargs: _FailingMapsProvider(fail_after=1))
    
    out = io.StringIO()
    monkeypatch.setattr(sys, "stdout", out)
    monkeypatch.setattr(sys, "argv", [
        "service.py",
        json.dumps({
            "query": "coffee",
            "city": "New York",
            "deliver_target": 10,
            "discovery_only": True,
            "street_mode": True,
            "street": "Main Street",
            "db_path": str(tmp_path / "leads.db"),
        }),
    ])

    await service._main_cli()

    lines = [json.loads(l) for l in out.getvalue().splitlines() if l.strip()]
    done_line = next((l for l in lines if l.get("__done__")), None)
    assert done_line is not None
    assert done_line["success"] is False
    assert done_line["exhausted"] is False
    assert done_line["target_reached"] is False
    assert done_line["termination_reason"] == "RETURN_TO_RESULTS_FAILED"
    assert done_line["failure_reason"] == "RETURN_TO_RESULTS_FAILED"


@pytest.mark.asyncio
async def test_composite_provider_preserves_return_to_results_failed(monkeypatch, tmp_path):
    """Even in composite discovery where errors are isolated during streaming, overall outcome must not be SUCCESS_EXHAUSTED."""
    # When street_mode is False, composition may compose multiple providers
    monkeypatch.setattr(service, "GoogleMapsProvider", lambda **kwargs: _FailingMapsProvider(fail_after=1))
    monkeypatch.setattr(service, "OverpassProvider", lambda **kwargs: _WorkingOverpassProvider(count=2))
    
    out = io.StringIO()
    monkeypatch.setattr(sys, "stdout", out)
    monkeypatch.setattr(sys, "argv", [
        "service.py",
        json.dumps({
            "query": "coffee",
            "city": "New York",
            "deliver_target": 10,
            "discovery_only": True,
            "street_mode": False,
            "db_path": str(tmp_path / "leads_comp.db"),
        }),
    ])

    await service._main_cli()

    lines = [json.loads(l) for l in out.getvalue().splitlines() if l.strip()]
    done_line = next((l for l in lines if l.get("__done__")), None)
    assert done_line is not None
    assert done_line["success"] is False
    assert done_line["exhausted"] is False
    assert done_line["termination_reason"] == "RETURN_TO_RESULTS_FAILED"


@pytest.mark.asyncio
async def test_composite_provider_target_reached_beats_error(monkeypatch, tmp_path):
    """If deliver_target was already satisfied, target_reached wins even if a provider failed afterwards."""
    monkeypatch.setattr(service, "GoogleMapsProvider", lambda **kwargs: _FailingMapsProvider(fail_after=2))
    
    out = io.StringIO()
    monkeypatch.setattr(sys, "stdout", out)
    monkeypatch.setattr(sys, "argv", [
        "service.py",
        json.dumps({
            "query": "coffee",
            "city": "New York",
            "deliver_target": 2,  # Exactly 2 leads requested and satisfied before failure
            "discovery_only": True,
            "street_mode": True,
            "db_path": str(tmp_path / "leads_target.db"),
        }),
    ])

    await service._main_cli()

    lines = [json.loads(l) for l in out.getvalue().splitlines() if l.strip()]
    done_line = next((l for l in lines if l.get("__done__")), None)
    assert done_line is not None
    assert done_line["success"] is True
    assert done_line["target_reached"] is True
    assert done_line["termination_reason"] == "SUCCESS_TARGET_REACHED"
