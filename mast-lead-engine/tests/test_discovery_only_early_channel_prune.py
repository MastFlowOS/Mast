"""
Live Discovery (plan-based path) early channel pruning.

The plan-based Live Discovery endpoint runs the Python engine with
`discovery_only=True`, which bypasses ExecutionDriver._on_candidate. These
tests drive the REAL `service.run_query()` discovery_only loop (same seam as
tests/test_run_query_target_reached_lifecycle.py: only
`service.GoogleMapsProvider` is substituted) and pin:

  * `required_channels` reaches the provider request as `require_website`
    (so MapsScraper's detail-panel fast abort can run);
  * candidates PROVEN unable to satisfy a required channel are never
    yielded to Node, and never count toward the delivery target — in
    particular the minimal stub the website fast-abort emits;
  * with no required_channels behavior is exactly what it was before;
  * chain/cannabis rejection is unchanged.

Run: pytest tests/test_discovery_only_early_channel_prune.py -v
"""

from __future__ import annotations

import os
import sys
import time
from types import SimpleNamespace

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

import service
from engine.contracts import BusinessCandidate


def _cand(i, session_id, *, name=None, website=None, phone=None, category="Dentist"):
    return BusinessCandidate(
        pipeline_id=f"pid-{i}",
        session_id=session_id,
        provider="google_maps",
        name=name or f"Business {i}",
        category=category,
        address="123 Main St",
        city="Springfield",
        country="US",
        website=website,
        phone=phone,
        rating=4.5,
        review_count=10,
    )


class _ScriptedProvider:
    """Yields a scripted list of candidate specs and records the request."""

    def __init__(self, specs):
        self.specs = specs
        self.pulled = 0
        self.request = None

    def discover(self, request):
        self.request = request
        for i, spec in enumerate(self.specs, start=1):
            if request.should_stop is not None and request.should_stop():
                return
            self.pulled += 1
            yield _cand(i, request.session_id, **spec)
            time.sleep(0.005)


async def _run(monkeypatch, tmp_path, specs, **kwargs):
    provider = _ScriptedProvider(specs)
    monkeypatch.setattr(service, "GoogleMapsProvider", lambda: provider)
    kwargs.setdefault("deliver_target", 50)
    leads = [
        lead
        async for lead in service.run_query(
            query="dentist", city="Springfield", discovery_only=True,
            db_path=str(tmp_path / "leads.db"), **kwargs,
        )
    ]
    return provider, leads


def SITE_N(n):
    """Distinct website per candidate: upstream dedup is fingerprint-based, so
    sharing one URL across candidates would (correctly) collapse them."""
    return f"https://acme{n}.example"


SITE = SITE_N(0)


# ── helper: delegates to the existing rule, never prunes without opt-in ─────

class TestFirstUnsatisfiableChannel:
    def test_none_and_empty_never_prune(self):
        c = SimpleNamespace(website="", phone="")
        assert service._first_unsatisfiable_channel(c, None) is None
        assert service._first_unsatisfiable_channel(c, []) is None

    def test_website_required(self):
        assert service._first_unsatisfiable_channel(SimpleNamespace(website="", phone="1"), ["website"]) == "website"
        assert service._first_unsatisfiable_channel(SimpleNamespace(website=SITE, phone=""), ["website"]) is None

    def test_email_requires_a_website_to_be_obtainable(self):
        assert service._first_unsatisfiable_channel(SimpleNamespace(website=""), ["email"]) == "email"
        # website present => email may still be found downstream: do NOT prune
        assert service._first_unsatisfiable_channel(SimpleNamespace(website=SITE), ["email"]) is None

    def test_phone_is_lenient_when_a_website_could_supply_one(self):
        assert service._first_unsatisfiable_channel(SimpleNamespace(website="", phone=""), ["phone"]) == "phone"
        assert service._first_unsatisfiable_channel(SimpleNamespace(website=SITE, phone=""), ["phone"]) is None
        assert service._first_unsatisfiable_channel(SimpleNamespace(website="", phone="555"), ["phone"]) is None

    def test_unknown_channel_never_prunes(self):
        assert service._first_unsatisfiable_channel(SimpleNamespace(website=""), ["fax"]) is None


# ── the real discovery_only loop ────────────────────────────────────────────

class TestDiscoveryOnlyLoop:
    @pytest.mark.asyncio
    async def test_required_channels_reach_provider_request(self, monkeypatch, tmp_path):
        p, _ = await _run(monkeypatch, tmp_path, [dict(website=SITE)], required_channels=["website"])
        assert p.request.require_website is True

    @pytest.mark.asyncio
    async def test_email_requirement_also_enables_fast_abort_flag(self, monkeypatch, tmp_path):
        # Pre-existing service rule (email is only discoverable via a website).
        p, _ = await _run(monkeypatch, tmp_path, [dict(website=SITE)], required_channels=["email"])
        assert p.request.require_website is True

    @pytest.mark.asyncio
    async def test_phone_only_requirement_does_not_enable_fast_abort_flag(self, monkeypatch, tmp_path):
        p, _ = await _run(monkeypatch, tmp_path, [dict(phone="555")], required_channels=["phone"])
        assert p.request.require_website is False

    @pytest.mark.asyncio
    async def test_no_required_channels_is_exactly_the_old_behavior(self, monkeypatch, tmp_path):
        specs = [dict(website=None), dict(website=SITE_N(1)), dict(website=None, phone="555")]
        p, leads = await _run(monkeypatch, tmp_path, specs)
        assert p.request.require_website is False
        assert len(leads) == 3, "no opt-in => nothing is early-pruned"

    @pytest.mark.asyncio
    async def test_candidate_without_website_is_not_yielded_when_website_required(self, monkeypatch, tmp_path):
        specs = [dict(website=None), dict(website=SITE, name="Has Site")]
        _, leads = await _run(monkeypatch, tmp_path, specs, required_channels=["website"])
        assert [l["name"] for l in leads] == ["Has Site"]

    @pytest.mark.asyncio
    async def test_candidate_with_website_is_not_wrongly_rejected(self, monkeypatch, tmp_path):
        specs = [dict(website=SITE_N(i), name=f"S{i}") for i in range(3)]
        _, leads = await _run(monkeypatch, tmp_path, specs, required_channels=["website"])
        assert len(leads) == 3

    @pytest.mark.asyncio
    async def test_fast_abort_stubs_do_not_consume_the_delivery_target(self, monkeypatch, tmp_path):
        # Stub = what MapsScraper yields when the detail panel has no website.
        specs = [dict(website=""), dict(website=""), dict(website=SITE_N(1), name="A"),
                 dict(website=""), dict(website=SITE_N(2), name="B"), dict(website=SITE_N(3), name="C")]
        p, leads = await _run(monkeypatch, tmp_path, specs, required_channels=["website"], deliver_target=2)
        assert [l["name"] for l in leads] == ["A", "B"], "stubs must not count toward / fill the target"
        assert p.pulled == 5, "stops right after the 2nd REAL lead, not earlier (stubs) or later"

    @pytest.mark.asyncio
    async def test_email_required_candidate_with_website_proceeds(self, monkeypatch, tmp_path):
        specs = [dict(website=SITE, name="Has Site"), dict(website=None, name="No Site")]
        _, leads = await _run(monkeypatch, tmp_path, specs, required_channels=["email"])
        assert [l["name"] for l in leads] == ["Has Site"]

    @pytest.mark.asyncio
    async def test_phone_required_resolvable_via_website_proceeds(self, monkeypatch, tmp_path):
        specs = [dict(website=None, phone=None, name="Nothing"),
                 dict(website=SITE_N(1), phone=None, name="Site only"),
                 dict(website=None, phone="555", name="Phone only")]
        _, leads = await _run(monkeypatch, tmp_path, specs, required_channels=["phone"])
        assert [l["name"] for l in leads] == ["Site only", "Phone only"]

    @pytest.mark.asyncio
    async def test_chain_and_cannabis_exclusions_unchanged(self, monkeypatch, tmp_path):
        specs = [dict(name="Starbucks", website=SITE_N(1)),
                 dict(name="Green Leaf Dispensary", website=SITE_N(2), category="Cannabis store"),
                 dict(name="Local Dental", website=SITE_N(3))]
        for rc in (None, ["website"]):
            _, leads = await _run(monkeypatch, tmp_path, specs, required_channels=rc)
            assert [l["name"] for l in leads] == ["Local Dental"], f"required_channels={rc}"

    @pytest.mark.asyncio
    async def test_pruned_candidates_get_one_terminal_reject_each(self, monkeypatch, tmp_path):
        rejects = []
        real = service.PipelineTracer

        class Spy(real):
            def reject(self, pid, reason, *a, **k):
                rejects.append((pid, reason))
                return super().reject(pid, reason, *a, **k)

        monkeypatch.setattr(service, "PipelineTracer", Spy)
        specs = [dict(website=""), dict(website=SITE), dict(website=None)]
        _, leads = await _run(monkeypatch, tmp_path, specs, required_channels=["website"])
        assert len(leads) == 1
        pruned = [r for r in rejects if r[1].startswith("early_channel_pruned")]
        assert [r[1] for r in pruned] == ["early_channel_pruned:website"] * 2
        assert len({pid for pid, _ in rejects}) == len(rejects), "no pipeline id rejected twice"
