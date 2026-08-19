"""
Phase 3A (candidate-extraction audit, optimization #1) — regression proof
that the batched, single-`page.evaluate()` extractor (`_extract_place_data`
in scraper/maps_scraper.py) is behaviorally equivalent to the original,
many-round-trip implementation (kept, unmodified, as
`_extract_place_data_legacy`).

Both implementations are driven against the SAME fake Playwright `Page`,
backed by a real HTML tree (BeautifulSoup/lxml, already a project
dependency) built from fixtures that use the actual Google-Maps-panel
selectors this module looks for (h1.DUwDvf, div.F7nice, data-item-id
attributes, etc.) — not mocked return values. This means both extractors
run their real selector-fallback logic, their real phone/rating/review/
website parsing, and their real HTML-signals regexes against the same DOM,
so `assert legacy_result.to_dict() == new_result.to_dict()` is a genuine
equivalence check, not a tautology.

`FakePage.evaluate()` special-cases the module's `_PLACE_EXTRACT_JS`
constant (matched by identity — it's the literal object the production
code passes to `page.evaluate()`) and runs `_simulate_place_extract_js()`,
a hand-audited Python port of that JS, against the same BeautifulSoup tree
`query_selector`/`query_selector_all` use for the legacy path. Every field
name and code path in `_simulate_place_extract_js()` should be checked
against `_PLACE_EXTRACT_JS`'s source by a human reviewer whenever the JS
constant changes — `test_js_source_mentions_all_expected_fields` is a
best-effort drift guard for that, not a substitute for review.

Run: pytest tests/test_place_extraction_equivalence.py -v
"""

from __future__ import annotations

import os
import sys

import pytest
from bs4 import BeautifulSoup

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

import scraper.maps_scraper as maps_scraper_module
from scraper.maps_scraper import (
    RawPlace,
    _extract_place_data,
    _extract_place_data_legacy,
    _PLACE_EXTRACT_JS,
)
from utils.runtime import ScraperConfig

CONFIG = ScraperConfig()


# ──────────────────────────────────────────────────────────────────────────────
# Fake Playwright Page/Element, backed by a real DOM (BeautifulSoup + lxml)
# ──────────────────────────────────────────────────────────────────────────────


class FakeElement:
    """Enough of Playwright's ElementHandle for the legacy extractor."""

    def __init__(self, tag):
        self._tag = tag

    async def get_attribute(self, name: str) -> str | None:
        val = self._tag.get(name)
        if val is None:
            return None
        return val if isinstance(val, str) else " ".join(val)

    async def inner_text(self) -> str:
        return self._tag.get_text()


class FakePage:
    """Enough of Playwright's Page for both extractors — CSS selector
    queries backed by BeautifulSoup's soupsieve engine (real CSS,
    including the `i` case-insensitive attribute flag this module's
    selectors rely on), plus a evaluate() that special-cases the one
    script the batched extractor actually runs.
    """

    def __init__(self, html: str, url: str = "https://www.google.com/maps/place/Test/@0,0,17z"):
        self._soup = BeautifulSoup(html, "lxml")
        self.url = url

    async def query_selector(self, sel: str):
        el = self._soup.select_one(sel)
        return FakeElement(el) if el is not None else None

    async def query_selector_all(self, sel: str):
        return [FakeElement(el) for el in self._soup.select(sel)]

    async def content(self) -> str:
        return str(self._soup)

    async def evaluate(self, script, arg=None):
        if script is _PLACE_EXTRACT_JS:
            return _simulate_place_extract_js(self._soup, arg)
        if "querySelectorAll('button, div[role=tab]')" in script:
            # The legacy path's own separate evaluate() call for the
            # photos-tab textContent join.
            texts = [el.get_text() for el in self._soup.select("button, div[role=tab]")]
            return " ".join(texts)
        raise NotImplementedError(f"FakePage.evaluate: unhandled script {script[:80]!r}")


def _simulate_place_extract_js(soup: BeautifulSoup, sel: dict) -> dict:
    """Hand-audited Python port of `_PLACE_EXTRACT_JS`, run against the
    same BeautifulSoup tree the legacy path's query_selector* calls use.
    Field-for-field, this must track the JS constant exactly.
    """

    def first_non_empty_text(selectors):
        for s in selectors:
            try:
                el = soup.select_one(s)
                if el is not None:
                    t = el.get_text().strip()
                    if t:
                        return t
            except Exception:
                pass
        return ""

    name = first_non_empty_text(sel["name"])
    category = first_non_empty_text(sel["category"])
    address = first_non_empty_text(sel["address"])
    rating_raw = first_non_empty_text(sel["rating"])
    review_raw = first_non_empty_text(sel["review"])

    phone_candidates = []
    for s in sel["phone"]:
        try:
            els = soup.select(s)
        except Exception:
            els = []
        for el in els:
            phone_candidates.append(
                {
                    "ariaLabel": el.get("aria-label") or "",
                    "href": el.get("href") or "",
                    "innerText": el.get_text().strip(),
                }
            )

    website_candidates = []
    for s in sel["website"]:
        try:
            el = soup.select_one(s)
        except Exception:
            el = None
        if el is None:
            website_candidates.append(None)
            continue
        website_candidates.append(
            {"href": el.get("href") or "", "innerText": el.get_text().strip()}
        )

    review_fallback_aria = []
    if not review_raw:
        try:
            els = soup.select("[aria-label*='review' i]")
        except Exception:
            els = []
        review_fallback_aria = [el.get("aria-label") or "" for el in els]

    hours_summary = ""
    hours_el = soup.select_one("div[aria-label*='Hours'] .OMl5r")
    if hours_el is not None:
        hours_summary = hours_el.get_text().strip()

    photos_els = soup.select("button, div[role=tab]")
    photos_tab_text = " ".join(el.get_text() for el in photos_els)

    html = str(soup)

    return {
        "name": name,
        "category": category,
        "address": address,
        "ratingRaw": rating_raw,
        "reviewRaw": review_raw,
        "phoneCandidates": phone_candidates,
        "websiteCandidates": website_candidates,
        "reviewFallbackAria": review_fallback_aria,
        "hoursSummary": hours_summary,
        "photosTabText": photos_tab_text,
        "html": html,
    }


async def _run_both(html: str, **kwargs) -> tuple[RawPlace | None, RawPlace | None]:
    legacy_place = await _extract_place_data_legacy(
        FakePage(html), config=CONFIG, **kwargs
    )
    new_place = await _extract_place_data(FakePage(html), config=CONFIG, **kwargs)
    return legacy_place, new_place


def _assert_equivalent(legacy: RawPlace | None, new: RawPlace | None) -> None:
    if legacy is None or new is None:
        assert legacy is None and new is None, (
            f"one extractor returned None and the other didn't: "
            f"legacy={legacy!r} new={new!r}"
        )
        return
    assert legacy.to_dict() == new.to_dict()


# ──────────────────────────────────────────────────────────────────────────────
# Fixtures
# ──────────────────────────────────────────────────────────────────────────────

COMPLETE_PLACE_HTML = """
<html><body>
  <h1 class="DUwDvf">Joe's Pizza</h1>
  <button class="DkEaL">Pizza restaurant</button>
  <div data-item-id="address">
    <div class="fontBodyMedium">123 Main St, Brooklyn, NY 11201</div>
  </div>
  <div data-item-id="phone:tel:+15551234567">
    <div class="fontBodyMedium">(555) 123-4567</div>
  </div>
  <a data-item-id="authority" href="https://joespizza.com">
    <span class="rogA2c">joespizza.com</span>
  </a>
  <div class="F7nice">
    <span aria-hidden="true">4.5</span>
    <span aria-label="123 reviews">(123)</span>
  </div>
  <div aria-label="Hours"><div class="OMl5r">Open 9AM-9PM</div></div>
  <button role="tab">Photos</button>
  <span aria-label="Claimed">Claimed</span>
  <div>Popular times: busiest around noon</div>
  <div>Owner responded to this review last week</div>
  <span aria-label="Price: $$">$$</span>
</body></html>
"""

MISSING_PHONE_HTML = """
<html><body>
  <h1 class="DUwDvf">The Book Nook</h1>
  <button class="DkEaL">Bookstore</button>
  <div data-item-id="address">
    <div class="fontBodyMedium">45 Park Ave, Queens, NY 11375</div>
  </div>
  <a data-item-id="authority" href="https://thebooknook.example.com">
    <span class="rogA2c">thebooknook.example.com</span>
  </a>
  <div class="F7nice">
    <span aria-hidden="true">4.8</span>
    <span aria-label="9 reviews">(9)</span>
  </div>
</body></html>
"""

MISSING_WEBSITE_HTML = """
<html><body>
  <h1 class="DUwDvf">Corner Barber Shop</h1>
  <button class="DkEaL">Barber shop</button>
  <div data-item-id="address">
    <div class="fontBodyMedium">9 Elm St, Staten Island, NY 10301</div>
  </div>
  <div data-item-id="phone:tel:+17185551212">
    <div class="fontBodyMedium">(718) 555-1212</div>
  </div>
  <div class="F7nice">
    <span aria-hidden="true">4.2</span>
    <span aria-label="60 reviews">(60)</span>
  </div>
</body></html>
"""

# Name/category/address only match the 2nd/3rd selector in their
# precedence lists, not the 1st — exercises the fallback ordering itself.
FALLBACK_SELECTORS_HTML = """
<html><body>
  <h1 class="fontHeadlineLarge">Second Selector Cafe</h1>
  <span class="DkEaL">Cafe</span>
  <span aria-label="Address: 500 Fallback Rd, Manhattan, NY">500 Fallback Rd, Manhattan, NY</span>
  <button data-item-id="phone:+12125550100"><span class="rogA2c">(212) 555-0100</span></button>
  <a data-tooltip="Open website" href="https://secondselector.example.com">Visit</a>
  <div class="fontDisplayLarge">3.9</div>
  <span aria-label="reviews 42">42 reviews</span>
</body></html>
"""

RATING_REVIEWS_MISSING_HTML = """
<html><body>
  <h1 class="DUwDvf">No Reviews Yet Diner</h1>
  <div data-item-id="address">
    <div class="fontBodyMedium">1 New Business Blvd, Bronx, NY</div>
  </div>
</body></html>
"""

ORDERING_PLATFORM_WEBSITE_HTML = """
<html><body>
  <h1 class="DUwDvf">Fresh Sushi Spot</h1>
  <div data-item-id="address">
    <div class="fontBodyMedium">77 Ocean Ave, Brooklyn, NY</div>
  </div>
  <a data-item-id="authority" href="https://www.doordash.com/store/fresh-sushi-spot-123">
    <span class="rogA2c">Order on DoorDash</span>
  </a>
  <a data-tooltip="Open website" href="https://freshsushispot.example.com">Real site</a>
  <div class="F7nice">
    <span aria-hidden="true">4.1</span>
    <span aria-label="200 reviews">(200)</span>
  </div>
</body></html>
"""

PHOTOS_SIGNALS_HTML = """
<html><body>
  <h1 class="DUwDvf">Signal Rich Gym</h1>
  <div data-item-id="address"><div class="fontBodyMedium">10 Fit St, Queens, NY</div></div>
  <div role="tab">Photos</div>
  <div>This business has 3 locations in NYC (a chain)</div>
  <div>Permanently closed</div>
  <span aria-label="Price: $$$">$$$</span>
  <div>Popular times shown below</div>
  <div>Owner response to this review: thanks!</div>
  <span aria-label="Claimed">Verified badge</span>
</body></html>
"""

# Extra whitespace/newlines inside text nodes — checks .strip()/get_text()
# handling doesn't diverge between the two implementations.
WHITESPACE_HTML = """
<html><body>
  <h1 class="DUwDvf">
      Weird   Whitespace   Place
  </h1>
  <div data-item-id="address">
    <div class="fontBodyMedium">

        200   Odd Spacing Ln,   Manhattan,   NY

    </div>
  </div>
  <div data-item-id="phone:tel:+19175550199">
    <div class="fontBodyMedium">
        (917) 555-0199
    </div>
  </div>
  <div class="F7nice">
    <span aria-hidden="true">
        4.0
    </span>
    <span aria-label="   7 reviews  ">(7)</span>
  </div>
</body></html>
"""

NO_NAME_HTML = """
<html><body>
  <div data-item-id="address"><div class="fontBodyMedium">No name here</div></div>
</body></html>
"""


FIXTURES = {
    "complete_place": COMPLETE_PLACE_HTML,
    "missing_phone": MISSING_PHONE_HTML,
    "missing_website": MISSING_WEBSITE_HTML,
    "fallback_selectors": FALLBACK_SELECTORS_HTML,
    "rating_reviews_missing": RATING_REVIEWS_MISSING_HTML,
    "ordering_platform_website": ORDERING_PLATFORM_WEBSITE_HTML,
    "photos_signals": PHOTOS_SIGNALS_HTML,
    "unusual_whitespace": WHITESPACE_HTML,
    "no_name": NO_NAME_HTML,
}


# ──────────────────────────────────────────────────────────────────────────────
# Tests — field / fallback / parsing / missing-field / signals equivalence
# ──────────────────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
@pytest.mark.parametrize("fixture_name", list(FIXTURES.keys()))
async def test_extractor_equivalence(fixture_name):
    """For every fixture, the batched extractor must produce a RawPlace
    identical (field-for-field, via to_dict()) to the legacy extractor —
    or both must return None. This is the core Phase 3A equivalence proof.
    """
    html = FIXTURES[fixture_name]
    legacy, new = await _run_both(
        html, query="pizza", niche="food", region="ny", city="Brooklyn", country="US"
    )
    _assert_equivalent(legacy, new)


@pytest.mark.asyncio
async def test_complete_place_fields_are_actually_populated():
    """Guards against a vacuous pass (both sides returning None/empty)."""
    legacy, new = await _run_both(COMPLETE_PLACE_HTML)
    assert new is not None
    assert new.name == "Joe's Pizza"
    assert new.category == "Pizza restaurant"
    assert "Main St" in new.address
    assert new.phone == "+1 (555) 123-4567"  # tel: href branch, normalized
    assert new.website == "https://joespizza.com"
    assert new.rating == 4.5
    assert new.reviews == 123
    assert new.has_photos is True
    assert new.is_google_verified is True
    assert new.has_popular_times is True
    assert new.owner_responds_to_reviews is True
    assert new.price_range == "$$"
    assert new.hours_summary == "Open 9AM-9PM"
    _assert_equivalent(legacy, new)


@pytest.mark.asyncio
async def test_missing_phone_yields_empty_string_both_sides():
    legacy, new = await _run_both(MISSING_PHONE_HTML)
    assert new.phone == ""
    assert legacy.phone == ""


@pytest.mark.asyncio
async def test_missing_website_yields_empty_string_both_sides():
    legacy, new = await _run_both(MISSING_WEBSITE_HTML)
    assert new.website == ""
    assert legacy.website == ""


@pytest.mark.asyncio
async def test_fallback_selector_precedence_matches():
    """Name/category/address/phone/website/rating/reviews all only match
    a NON-first selector in their precedence list here — proves the
    batched JS's `firstNonEmptyText`/candidate-flattening preserves the
    exact fallback order the legacy per-selector loop used.
    """
    legacy, new = await _run_both(FALLBACK_SELECTORS_HTML)
    assert new.name == "Second Selector Cafe"
    assert new.category == "Cafe"
    assert new.rating == 3.9
    assert new.reviews == 42
    _assert_equivalent(legacy, new)


@pytest.mark.asyncio
async def test_rating_and_reviews_missing_default_correctly():
    legacy, new = await _run_both(RATING_REVIEWS_MISSING_HTML)
    assert new.rating is None
    assert new.reviews == 0
    assert legacy.rating is None
    assert legacy.reviews == 0


@pytest.mark.asyncio
async def test_ordering_platform_website_is_skipped_for_real_site():
    """The website loop must skip a DoorDash href (ordering platform) and
    fall through to a later selector's real domain — this is the one case
    most likely to regress if the JS candidate ordering doesn't exactly
    match the legacy per-selector `query_selector` (single-match) loop.
    """
    legacy, new = await _run_both(ORDERING_PLATFORM_WEBSITE_HTML)
    assert new.website == "https://freshsushispot.example.com"
    assert "doordash" not in new.website
    _assert_equivalent(legacy, new)


@pytest.mark.asyncio
async def test_photos_and_html_signals_equivalence():
    legacy, new = await _run_both(PHOTOS_SIGNALS_HTML)
    assert new.has_photos is True
    assert new.multi_location is True
    assert new.closed is True
    assert new.price_range == "$$$"
    assert new.has_popular_times is True
    assert new.owner_responds_to_reviews is True
    assert new.is_google_verified is True
    _assert_equivalent(legacy, new)


@pytest.mark.asyncio
async def test_unusual_whitespace_is_normalized_identically():
    legacy, new = await _run_both(WHITESPACE_HTML)
    assert new.name == "Weird   Whitespace   Place"
    assert new.phone == "+1 (917) 555-0199"
    _assert_equivalent(legacy, new)


@pytest.mark.asyncio
async def test_missing_name_returns_none_both_sides():
    legacy, new = await _run_both(NO_NAME_HTML)
    assert legacy is None
    assert new is None


@pytest.mark.asyncio
async def test_html_fallback_phone_scan_matches():
    """Neither extractor's selector list matches, but a raw tel: href
    exists elsewhere in the HTML — exercises `_extract_phone`'s /
    `_phone_from_html_fallback`'s page.content()-scan fallback path,
    including that the batched version reuses the ALREADY-fetched html
    blob instead of a second page.content() call.
    """
    html = """
    <html><body>
      <h1 class="DUwDvf">Hole In The Wall</h1>
      <footer>Call us: <a href="tel:+13475550123">+1 (347) 555-0123</a></footer>
    </body></html>
    """
    legacy, new = await _run_both(html)
    assert new.phone == "+13475550123"
    _assert_equivalent(legacy, new)


def test_js_source_mentions_all_expected_fields():
    """Best-effort drift guard: if `_PLACE_EXTRACT_JS` is edited and a
    field name/selector-list key is dropped, this fails loudly. NOT a
    substitute for updating `_simulate_place_extract_js()` and this test
    file's fixtures — it only catches gross omissions.
    """
    expected_tokens = [
        "sel.name", "sel.category", "sel.address", "sel.rating", "sel.review",
        "sel.phone", "sel.website",
        "phoneCandidates", "websiteCandidates", "reviewFallbackAria",
        "hoursSummary", "photosTabText", "html",
        "getAttribute(\"aria-label\")", "getAttribute(\"href\")",
    ]
    for token in expected_tokens:
        assert token in _PLACE_EXTRACT_JS, f"expected token missing from JS: {token!r}"


def test_only_one_page_evaluate_call_per_extraction():
    """Structural proof of the round-trip reduction: the batched extractor
    must call page.evaluate() exactly once per candidate (vs. the legacy
    path's ~25-40 query_selector*/get_attribute/inner_text/content calls).
    """
    calls = {"evaluate": 0, "query_selector": 0, "query_selector_all": 0, "content": 0}

    class CountingPage(FakePage):
        async def evaluate(self, script, arg=None):
            calls["evaluate"] += 1
            return await super().evaluate(script, arg)

        async def query_selector(self, sel):
            calls["query_selector"] += 1
            return await super().query_selector(sel)

        async def query_selector_all(self, sel):
            calls["query_selector_all"] += 1
            return await super().query_selector_all(sel)

        async def content(self):
            calls["content"] += 1
            return await super().content()

    import asyncio

    async def _run():
        page = CountingPage(COMPLETE_PLACE_HTML)
        return await _extract_place_data(page, config=CONFIG)

    # `asyncio.get_event_loop()` is deprecated (and, depending on what ran
    # earlier in the process / thread, can raise outright) when there is no
    # running loop in Python 3.12 — see https://github.com/python/cpython/issues/100160.
    # `asyncio.run()` always creates a fresh loop for this coroutine and tears
    # it down afterwards, so the test no longer depends on event-loop state
    # left behind by other tests. Same coroutine, same assertions below.
    result = asyncio.run(_run())
    assert result is not None
    assert calls["evaluate"] == 1
    assert calls["query_selector"] == 0
    assert calls["query_selector_all"] == 0
    assert calls["content"] == 0
