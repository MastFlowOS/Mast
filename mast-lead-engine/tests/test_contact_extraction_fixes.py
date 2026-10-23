"""
Regression tests for the contact-extraction audit fixes.

One section per fix category. Everything is deterministic: no network
(``_fetch`` / ``urlopen`` are stubbed), no production services.

  1. Email validation / extraction / selection
  2. Instagram URL validation / canonicalization / provider propagation
  3. Phone normalization / dedup / false positives
  4. ContactWorker: homepage-first, demand-driven, request counts
  5. Fetch behavior: permanent errors, transient retry, size cap
  6. Execution driver: Instagram enqueue, provider fields survive intake
  7. InstagramWorker verification semantics
  8. Channel satisfaction validates real data
  9. Lead payload (Python -> Node): channels, provenance, ordering
"""

from __future__ import annotations

import io
import urllib.error
from datetime import datetime, timezone
from typing import Tuple
from unittest.mock import MagicMock, patch

import pytest

from engine.contracts import (
    BusinessCandidate,
    ContactIntel,
    EnrichedBusiness,
    InstagramIntel,
    OpportunityScore,
    QualificationResult,
    QualifiedOpportunity,
    StoredOpportunity,
    WebsiteIntel,
)
from utils.http_limits import (
    MAX_RESPONSE_BYTES,
    is_permanent_http_error,
    read_capped,
)
from utils.parsing import (
    decode_entities,
    extract_ig_urls_with_source,
    extract_obfuscated_emails,
    extract_phones,
    ig_url_from_provider_value,
    is_valid_email,
    is_valid_ig_handle,
    normalize_phone,
    phone_dedup_key,
    resolve_region,
    select_primary_email,
    strip_scripts_and_styles,
)
from workers.contact_worker import ContactWorker
from workers.instagram_worker import InstagramWorker


# ---------------------------------------------------------------------------
# 1. Email
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "bad",
    [
        "logo@2x.png",
        "hero@3x.jpg",
        "a@b.png",
        "icon@2x.svg",
        "x@sub.2x.com",
        "0123456789abcdef0123456789abcdef@host.com",
    ],
)
def test_asset_and_hash_strings_are_not_emails(bad):
    assert is_valid_email(bad) is False


@pytest.mark.parametrize("ok", ["info@shop.com", "john.smith@shop.co.uk", "hello@my-cafe.io"])
def test_real_emails_stay_valid(ok):
    assert is_valid_email(ok) is True


def test_obfuscated_emails_are_decoded_but_prose_is_not():
    text = "sales [at] shop [dot] com, bob(at)cafe(dot)co(dot)uk and meet us at home. Visit soon"
    assert extract_obfuscated_emails(text) == ["sales@shop.com", "bob@cafe.co.uk"]


def test_html_entity_obfuscation_is_decoded():
    assert decode_entities("info&#64;shop.com") == "info@shop.com"
    assert decode_entities("info&commat;shop.com") == "info@shop.com"
    assert decode_entities("info%40shop.com") == "info@shop.com"


def test_primary_email_prefers_own_domain_and_drops_invalid():
    ordered = select_primary_email(
        ["credit@webagency.com", "logo@2x.png", "info@wondercafe.com"],
        "www.wondercafe.com",
    )
    assert ordered[0] == "info@wondercafe.com"
    assert "logo@2x.png" not in ordered


def test_www_prefix_is_removed_not_character_stripped():
    # str.lstrip("www.") used to turn "wondercafe.com" into "ondercafe.com".
    ordered = select_primary_email(["a@other.com", "b@wondercafe.com"], "wondercafe.com")
    assert ordered[0] == "b@wondercafe.com"


# ---------------------------------------------------------------------------
# 2. Instagram
# ---------------------------------------------------------------------------


def test_non_profile_instagram_paths_are_rejected():
    html = (
        '<script async src="//www.instagram.com/embed.js"></script>'
        '<a href="https://www.instagram.com/sharer.php?u=x">share</a>'
        '<a href="https://instagram.com/static/images/x.png">x</a>'
        '<a href="https://www.instagram.com/p/ABC/">post</a>'
    )
    assert extract_ig_urls_with_source(html) == []


def test_a_false_positive_never_outranks_the_real_profile():
    html = (
        '<a href="https://www.instagram.com/sharer.php">share</a>'
        '<a href="https://www.instagram.com/joesbarber/">follow</a>'
    )
    urls = [u for u, _src in extract_ig_urls_with_source(html)]
    assert urls == ["https://www.instagram.com/joesbarber/"]


def test_mobile_instagram_urls_are_recognized():
    html = '<a href="https://m.instagram.com/joesbarber/?hl=en&utm_source=x">m</a>'
    assert extract_ig_urls_with_source(html) == [
        ("https://www.instagram.com/joesbarber/", "anchor_href")
    ]


@pytest.mark.parametrize(
    "value, expected",
    [
        ("@joes.barber", "https://www.instagram.com/joes.barber/"),
        ("joesbarber", "https://www.instagram.com/joesbarber/"),
        ("https://www.instagram.com/joes_cafe/?igshid=1", "https://www.instagram.com/joes_cafe/"),
        ("https://m.instagram.com/joesbarber", "https://www.instagram.com/joesbarber/"),
        ("7eleven", "https://www.instagram.com/7eleven/"),
        ("instagram.com/embed.js", None),
        ("https://instagram.com/p/ABC", None),
        ("@x", None),
        ("not a handle", None),
        ("", None),
        (None, None),
    ],
)
def test_provider_instagram_values_are_canonicalized_or_rejected(value, expected):
    assert ig_url_from_provider_value(value) == expected


def test_handle_validation():
    assert is_valid_ig_handle("business") is True  # real businesses use such names
    assert is_valid_ig_handle("embed.js") is False
    assert is_valid_ig_handle("sharer.php") is False
    assert is_valid_ig_handle("name.") is False
    assert is_valid_ig_handle("12345") is False


def _foursquare_provider():
    from providers.foursquare_provider import FoursquareProvider

    return FoursquareProvider(api_key="test-key")


def test_foursquare_instagram_handle_and_email_are_preserved():
    cand = _foursquare_provider()._to_business_candidate(
        {
            "fsq_place_id": "abc",
            "name": "Cafe Sol",
            "social_media": {"instagram": "cafesol"},
            "email": "Hello@CafeSol.com",
        },
        "s1",
    )
    assert cand.instagram_url == "https://www.instagram.com/cafesol/"
    assert cand.provider_email == "hello@cafesol.com"


def test_foursquare_invalid_social_values_become_none():
    cand = _foursquare_provider()._to_business_candidate(
        {"name": "X", "social_media": {"instagram": "embed.js"}, "email": "logo@2x.png"},
        "s1",
    )
    assert cand.instagram_url is None
    assert cand.provider_email is None


def _overpass_candidate(tags):
    from providers.overpass_provider import OverpassDiscoveryRequest, OverpassProvider

    req = OverpassDiscoveryRequest(session_id="s", tags={"amenity": "cafe"})
    return OverpassProvider()._to_business_candidate(
        {"type": "node", "id": 1, "tags": {"name": "Cafe", "amenity": "cafe", **tags}}, req, "s"
    )


def test_osm_instagram_and_email_tags_are_preserved():
    cand = _overpass_candidate(
        {"contact:instagram": "https://www.instagram.com/cafesol/", "contact:email": "info@cafesol.com"}
    )
    assert cand.instagram_url == "https://www.instagram.com/cafesol/"
    assert cand.provider_email == "info@cafesol.com"


def test_osm_plain_email_tag_and_multiple_values():
    cand = _overpass_candidate({"email": "logo@2x.png; Owner@CafeSol.com", "instagram": "@cafesol"})
    assert cand.provider_email == "owner@cafesol.com"
    assert cand.instagram_url == "https://www.instagram.com/cafesol/"


def test_osm_without_contact_tags_is_unchanged():
    cand = _overpass_candidate({})
    assert cand.instagram_url is None
    assert cand.provider_email is None


def test_business_candidate_still_has_no_email_attribute():
    # Existing contract tests pin this; the provider email lives elsewhere.
    cand = BusinessCandidate(pipeline_id="p", session_id="s", provider="x", name="n")
    assert not hasattr(cand, "email")
    assert cand.provider_email is None


# ---------------------------------------------------------------------------
# 3. Phone
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "raw, region, expected",
    [
        ("+20 2 2735 9999", None, "+20227359999"),
        ("(02) 2735 9999", "EG", "+20227359999"),
        ("(02) 2735 9999", "Egypt", "+20227359999"),
        ("010 0123 4567", "EG", "+201001234567"),
        ("0020 100 123 4567", None, "+201001234567"),
        ("+20 (0)100 123 4567", None, "+201001234567"),
        ("tel:+201001234567", None, "+201001234567"),
        ("+44 020 7946 0958", None, "+442079460958"),
        ("020 7946 0958", "GB", "+442079460958"),
        ("tel:+1-305-555-1234", None, "+1 (305) 555-1234"),
        ("3055551234", "US", "+1 (305) 555-1234"),
        ("(305) 555-1234 ext. 22", "US", "+1 (305) 555-1234"),
        ("+1 305 555 1234 x22", None, "+1 (305) 555-1234"),
    ],
)
def test_phone_normalization(raw, region, expected):
    assert normalize_phone(raw, region) == expected


def test_egyptian_numbers_must_match_egyptian_shapes():
    # 8 digits is not a valid Egyptian number.
    assert normalize_phone("2020-2024", "EG") == ""
    assert normalize_phone("0123", "EG") == ""


def test_region_is_resolved_from_codes_and_names():
    assert resolve_region("EG") == "EG"
    assert resolve_region("egypt") == "EG"
    assert resolve_region("United States") == "US"
    assert resolve_region("Atlantis") is None
    assert resolve_region(None) is None


def test_dates_times_and_ids_are_not_phone_numbers():
    html = "<p>Opened 2024-10-22 12:30. Order 123456789012. Years 2020-2024. 10/22/2026</p>"
    assert extract_phones(html, "EG") == []
    assert extract_phones(html) == []


def test_visible_phone_is_found_and_scripts_are_ignored():
    html = (
        "<p>Call +20 2 2735 9999 or 0100 123 4567</p>"
        '<script>var a="+1 555 123 4567"</script>'
        '<a href="tel:+201001234567">x</a>'
    )
    assert extract_phones(html, "EG") == ["+201001234567", "+20227359999"]


def test_equivalent_phone_numbers_deduplicate():
    assert phone_dedup_key("+20 100 123 4567") == phone_dedup_key("0100 123 4567")
    assert phone_dedup_key("+1 (305) 555-1234") == phone_dedup_key("305.555.1234")
    assert extract_phones('<a href="tel:+201001234567">a</a> 0100 123 4567', "EG") == ["+201001234567"]


def test_invalid_tel_links_are_dropped():
    html = '<a href="tel:0000">x</a><a href="tel:12">y</a><a href="tel:">z</a>'
    assert extract_phones(html, "EG") == []


def test_script_stripper_is_linear_and_handles_unclosed_tags():
    assert strip_scripts_and_styles("a<script>x()</script>b<style>p{}</style>c") == "a b c"
    # Unclosed <script: only the opening tag is dropped, the rest survives.
    assert "visible text" in strip_scripts_and_styles("<script src=x>visible text")
    big = "<script " * 20000 + "tail"
    assert "tail" in strip_scripts_and_styles(big)


# ---------------------------------------------------------------------------
# 4. ContactWorker: extraction, homepage-first, demand-driven, request counts
# ---------------------------------------------------------------------------


def _intel(**kw) -> WebsiteIntel:
    base = dict(
        pipeline_id="p1",
        website_reachable=True,
        final_url="https://shop.com",
        contact_page="https://shop.com/contact",
    )
    base.update(kw)
    return WebsiteIntel(**base)


def _worker_with_pages(pages: dict[str, str], **worker_kw) -> Tuple[ContactWorker, list[str]]:
    """A ContactWorker whose `_fetch` serves `pages` and records every URL."""
    fetched: list[str] = []
    worker = ContactWorker(**worker_kw)

    def _fake_fetch(url: str):
        fetched.append(url)
        if url in pages:
            return pages[url], url, 0.01
        raise urllib.error.HTTPError(url, 404, "Not Found", {}, None)  # type: ignore[arg-type]

    worker._fetch = _fake_fetch  # type: ignore[method-assign]
    return worker, fetched


def test_junk_is_not_extracted_and_obfuscated_is():
    html = (
        '<img src="/logo@2x.png"><img src="/hero@3x.jpg">'
        "<p>Mail sales [at] shop [dot] com</p>"
        '<a href="mailto:Info@Shop.com?subject=Hi">mail</a>'
        "<p>info&#64;shop.com</p>"
    )
    worker, _ = _worker_with_pages({}, required_channels=("email",))
    out = worker.process(_intel(homepage_html=html, contact_page=None))
    assert set(out.emails) == {"info@shop.com", "sales@shop.com"}
    assert not any("png" in e or "jpg" in e for e in out.emails)


def test_extraction_records_provenance_for_every_value():
    html = '<a href="mailto:info@shop.com">m</a><a href="tel:+201001234567">t</a>'
    worker, _ = _worker_with_pages({}, required_channels=("email",))
    out = worker.process(_intel(homepage_html=html, contact_page=None, region_hint="EG"))
    assert dict(out.email_provenance) == {"info@shop.com": "mailto"}
    assert dict(out.phone_provenance) == {"+201001234567": "tel"}


def test_homepage_satisfying_the_need_costs_zero_requests():
    """Previously the contact page was fetched BEFORE the free, already
    fetched homepage was even read."""
    html = '<a href="mailto:info@shop.com">m</a>'
    worker, fetched = _worker_with_pages(
        {"https://shop.com/contact": "<html>contact</html>"}, required_channels=("email",)
    )
    out = worker.process(_intel(homepage_html=html))
    assert out.emails == ("info@shop.com",)
    assert fetched == []  # zero network requests


def test_contact_page_is_fetched_only_when_homepage_is_not_enough():
    worker, fetched = _worker_with_pages(
        {"https://shop.com/contact": '<a href="mailto:info@shop.com">m</a>'},
        required_channels=("email",),
    )
    out = worker.process(_intel(homepage_html="<html>nothing</html>"))
    assert out.emails == ("info@shop.com",)
    assert fetched == ["https://shop.com/contact"]


def test_provider_known_channels_are_not_chased():
    """Maps already supplied the phone: a phone-only requirement needs no crawl."""
    worker, fetched = _worker_with_pages({}, required_channels=("phone",))
    out = worker.process(_intel(homepage_html="<html>x</html>", known_channels=("phone",)))
    assert fetched == []
    assert not out.phones


def test_known_channel_does_not_satisfy_a_different_requirement():
    worker, fetched = _worker_with_pages(
        {"https://shop.com/contact": '<a href="mailto:a@shop.com">m</a>'},
        required_channels=("email", "phone"),
    )
    worker.process(_intel(homepage_html="<html>x</html>", known_channels=("phone",)))
    assert fetched == ["https://shop.com/contact"]


def test_no_required_channels_never_crawls_secondary_pages():
    """An explicit empty requirement: primary pages only, no /about,
    /contact-us probing, and Instagram never drives extra fetches."""
    worker, fetched = _worker_with_pages({}, required_channels=())
    worker.process(_intel(homepage_html="<html>x</html>"))
    assert fetched == ["https://shop.com/contact"]  # primary page only


def test_no_required_channels_stops_once_email_or_phone_is_found():
    worker, fetched = _worker_with_pages({}, required_channels=())
    out = worker.process(
        _intel(homepage_html='<a href="mailto:info@shop.com">m</a><a href="tel:+201001234567">t</a>')
    )
    assert fetched == []
    assert out.emails and out.phones


def test_unspecified_requirement_keeps_legacy_all_channels_behavior():
    worker, fetched = _worker_with_pages({})  # required_channels=None
    worker.process(
        _intel(homepage_html='<a href="mailto:info@shop.com">m</a><a href="tel:+201001234567">t</a>')
    )
    # Instagram is still missing, so the legacy mode keeps looking.
    assert len(fetched) >= 1


def test_page_budget_is_never_exceeded():
    worker, fetched = _worker_with_pages({}, required_channels=("email",))
    worker.process(_intel(homepage_html="<html>x</html>"))
    assert len(fetched) <= 3


def test_invalid_tel_contact_target_is_dropped_not_stored_verbatim():
    worker, _ = _worker_with_pages({}, required_channels=("phone",))
    out = worker.process(_intel(homepage_html="<html>x</html>", contact_page="tel:0000"))
    assert not out.phones


def test_valid_tel_contact_target_is_normalized():
    worker, fetched = _worker_with_pages({}, required_channels=("phone",))
    out = worker.process(_intel(homepage_html="<html>x</html>", contact_page="tel:0100 123 4567", region_hint="EG"))
    assert out.phones == ("+201001234567",)
    assert fetched == []


def test_primary_email_is_ranked_best_first():
    html = (
        '<a href="mailto:credit@webagency.com">a</a>'
        '<a href="mailto:info@shop.com">b</a>'
    )
    worker, _ = _worker_with_pages({}, required_channels=("email",))
    out = worker.process(_intel(homepage_html=html, contact_page=None))
    assert out.emails[0] == "info@shop.com"
    assert out.email_source == "mailto"


# ---------------------------------------------------------------------------
# 5. Fetch behavior
# ---------------------------------------------------------------------------


class _Resp:
    def __init__(self, body: bytes = b"<html>ok</html>", url: str = "https://shop.com"):
        self._body = io.BytesIO(body)
        self._url = url
        self.headers = MagicMock()
        self.headers.get_content_charset.return_value = "utf-8"

    def read(self, amt=None):
        return self._body.read() if amt is None else self._body.read(amt)

    def geturl(self):
        return self._url

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


def _http_error(code: int):
    return urllib.error.HTTPError("https://shop.com", code, "err", MagicMock(get=lambda *_: None), None)  # type: ignore[arg-type]


@pytest.mark.parametrize("code", [400, 401, 403, 404, 410])
def test_permanent_http_errors_are_not_retried(code):
    worker = ContactWorker()
    with patch("urllib.request.urlopen", side_effect=_http_error(code)) as mock_open:
        with pytest.raises(urllib.error.HTTPError):
            worker._fetch("https://shop.com")
    assert mock_open.call_count == 1


@pytest.mark.parametrize("code", [500, 502, 503, 504])
def test_transient_http_errors_are_retried_exactly_once(code):
    worker = ContactWorker()
    with patch("urllib.request.urlopen", side_effect=[_http_error(code), _Resp()]) as mock_open, patch(
        "time.sleep"
    ):
        html, _url, _t = worker._fetch("https://shop.com")
    assert "ok" in html
    assert mock_open.call_count == 2


def test_persistent_transient_error_gives_up_after_one_retry():
    worker = ContactWorker()
    with patch("urllib.request.urlopen", side_effect=[_http_error(503), _http_error(503)]) as mock_open, patch(
        "time.sleep"
    ):
        with pytest.raises(urllib.error.HTTPError):
            worker._fetch("https://shop.com")
    assert mock_open.call_count == 2


def test_permanent_error_classification():
    assert is_permanent_http_error(404) and is_permanent_http_error(403) and is_permanent_http_error(400)
    assert not is_permanent_http_error(429) and not is_permanent_http_error(503)


def test_response_body_is_size_capped():
    big = b"a" * (MAX_RESPONSE_BYTES + 500_000)
    data = read_capped(io.BytesIO(big))
    assert len(data) == MAX_RESPONSE_BYTES
    assert len(read_capped(io.BytesIO(big), 1000)) == 1000
    # A reader whose read() takes no size argument is still capped.
    class NoArg:
        def read(self):
            return big

    assert len(read_capped(NoArg(), 2000)) == 2000


def test_fetch_never_buffers_more_than_the_cap():
    worker = ContactWorker()
    big = b"x" * (MAX_RESPONSE_BYTES + 100_000)
    with patch("urllib.request.urlopen", return_value=_Resp(big)):
        html, _u, _t = worker._fetch("https://shop.com")
    assert len(html) == MAX_RESPONSE_BYTES


# ---------------------------------------------------------------------------
# 6. Execution driver
# ---------------------------------------------------------------------------


def _setup(required_channels=None):
    from tests.test_phase4a_discovery_filters import _setup_pipeline

    return _setup_pipeline(required_channels)


def _candidate(pid, **kw) -> BusinessCandidate:
    base = dict(
        pipeline_id=pid,
        session_id="session-test",
        provider="google_maps",
        name="Joe's Bakery",
        category="Bakery",
        address="1 Main St",
        city="Cairo",
        country="EG",
        website="https://joesbakery.com",
        phone="02 2735 9999",
    )
    base.update(kw)
    return BusinessCandidate(**base)


def test_no_instagram_work_is_enqueued_without_a_url():
    on_candidate, fan_in, website_q, instagram_q = _setup()
    on_candidate(_candidate("p-none"))
    assert website_q.size() == 1
    assert instagram_q.size() == 0
    # The Instagram branch is still completed terminally for fan-in.
    acc_result = fan_in._pending["p-none"].instagram_intel  # type: ignore[attr-defined]
    assert acc_result is not None
    assert acc_result.profile_status == "no_url"
    assert acc_result.profile_reachable is False


def test_valid_provider_instagram_url_is_enqueued_and_canonicalized():
    on_candidate, fan_in, website_q, instagram_q = _setup()
    on_candidate(_candidate("p-ig", instagram_url="https://m.instagram.com/joesbakery/?hl=en"))
    assert instagram_q.size() == 1
    assert fan_in.get_business("p-ig").instagram_url == "https://www.instagram.com/joesbakery/"


def test_invalid_provider_instagram_url_is_dropped_without_rejecting_the_lead():
    on_candidate, fan_in, website_q, instagram_q = _setup()
    on_candidate(_candidate("p-badig", instagram_url="https://www.instagram.com/embed.js/"))
    assert fan_in.get_business("p-badig") is not None  # lead NOT rejected
    assert fan_in.get_business("p-badig").instagram_url is None
    assert instagram_q.size() == 0
    assert website_q.size() == 1


def test_provider_email_survives_social_website_relocation():
    """The relocation used to rebuild the candidate field by field, so any
    field it did not list (here: provider_email) was silently lost."""
    on_candidate, fan_in, website_q, instagram_q = _setup()
    on_candidate(
        _candidate(
            "p-reloc",
            website="https://www.instagram.com/joesbakery/",
            provider_email="Info@JoesBakery.com",
        )
    )
    biz = fan_in.get_business("p-reloc")
    assert biz.website is None
    assert biz.instagram_url == "https://www.instagram.com/joesbakery/"
    assert biz.provider_email == "info@joesbakery.com"


def test_invalid_provider_email_is_dropped():
    on_candidate, fan_in, *_ = _setup()
    on_candidate(_candidate("p-bademail", provider_email="logo@2x.png"))
    assert fan_in.get_business("p-bademail").provider_email is None


def test_email_required_provider_email_candidate_without_website_is_not_pruned():
    on_candidate, fan_in, website_q, instagram_q = _setup(required_channels=("email",))
    on_candidate(_candidate("p-osm", website=None, provider_email="info@joesbakery.com"))
    assert fan_in.get_business("p-osm") is not None


def test_email_required_candidate_without_website_or_email_is_still_pruned():
    on_candidate, fan_in, *_ = _setup(required_channels=("email",))
    on_candidate(_candidate("p-prune", website=None))
    assert fan_in.get_business("p-prune") is None


# ---------------------------------------------------------------------------
# 7. InstagramWorker verification
# ---------------------------------------------------------------------------


def _ig_candidate(url="https://www.instagram.com/somebiz/") -> BusinessCandidate:
    return BusinessCandidate(
        pipeline_id="p-ig", session_id="s", provider="x", name="n", instagram_url=url
    )


_PROFILE_HTML = (
    '<meta property="og:title" content="Some Biz (@somebiz) • Instagram photos and videos">'
    '<meta property="og:description" content="1,234 Followers, 56 Following, 78 Posts - hi">'
)


def test_a_retrieved_profile_page_is_found():
    with patch("urllib.request.urlopen", return_value=_Resp(_PROFILE_HTML.encode(), "https://www.instagram.com/somebiz/")):
        intel = InstagramWorker().process(_ig_candidate())
    assert intel.profile_reachable is True
    assert intel.profile_status == "found"
    assert intel.username == "somebiz"


def test_login_wall_is_never_proof_of_a_profile():
    wall = b"<html><title>Login \xe2\x80\xa2 Instagram</title><form id='loginForm'></form></html>"
    with patch("urllib.request.urlopen", return_value=_Resp(wall, "https://www.instagram.com/somebiz/")):
        intel = InstagramWorker().process(_ig_candidate())
    assert intel.profile_reachable is None
    assert intel.profile_status == "blocked"
    assert intel.profile_url is None


def test_redirect_to_login_is_blocked_not_found():
    with patch(
        "urllib.request.urlopen",
        return_value=_Resp(b"<html></html>", "https://www.instagram.com/accounts/login/?next=/somebiz/"),
    ):
        intel = InstagramWorker().process(_ig_candidate())
    assert intel.profile_reachable is None
    assert intel.profile_status == "blocked"


def test_unrecognizable_200_page_is_inconclusive():
    with patch("urllib.request.urlopen", return_value=_Resp(b"<html>hello</html>", "https://www.instagram.com/somebiz/")):
        intel = InstagramWorker().process(_ig_candidate())
    assert intel.profile_reachable is None
    assert intel.profile_status == "inconclusive"


def test_network_failure_is_not_a_profile():
    with patch("urllib.request.urlopen", side_effect=urllib.error.URLError("boom")):
        intel = InstagramWorker().process(_ig_candidate())
    assert intel.profile_reachable is False
    assert intel.profile_status == "error"


def test_no_url_short_circuits_without_a_request():
    with patch("urllib.request.urlopen") as mock_open:
        intel = InstagramWorker().process(_ig_candidate(url=None))
    assert mock_open.call_count == 0
    assert intel.profile_reachable is False
    assert intel.profile_status == "no_url"


# ---------------------------------------------------------------------------
# 8. Channel satisfaction validates real data
# ---------------------------------------------------------------------------


def _satisfied(channel, *, business=None, contact=None, instagram=None, website=None):
    from engine.prune_reason_taxonomy import is_channel_satisfied_post_enrichment

    return is_channel_satisfied_post_enrichment(
        channel=channel,
        business=business,
        website_intel=website,
        instagram_intel=instagram,
        contact_intel=contact,
    )


def test_junk_values_cannot_satisfy_channels():
    biz = BusinessCandidate(pipeline_id="p", session_id="s", provider="x", name="n", phone="abc")
    contact = ContactIntel(
        pipeline_id="p",
        emails=("logo@2x.png",),
        phones=("12",),
        instagram_url="https://www.instagram.com/embed.js/",
    )
    assert _satisfied("email", business=biz, contact=contact) is False
    assert _satisfied("phone", business=biz, contact=contact) is False
    assert _satisfied("instagram", business=biz, contact=contact) is False


def test_real_values_satisfy_channels():
    biz = BusinessCandidate(
        pipeline_id="p", session_id="s", provider="x", name="n", phone="02 2735 9999",
        provider_email="info@shop.com", instagram_url="https://www.instagram.com/shop/",
    )
    assert _satisfied("phone", business=biz) is True
    assert _satisfied("email", business=biz) is True
    assert _satisfied("instagram", business=biz) is True


def test_unverified_instagram_fetch_does_not_satisfy_the_channel():
    biz = BusinessCandidate(pipeline_id="p", session_id="s", provider="x", name="n")
    blocked = InstagramIntel(pipeline_id="p", profile_reachable=None, profile_status="blocked")
    missing = InstagramIntel(pipeline_id="p", profile_reachable=False, profile_status="missing")
    found = InstagramIntel(pipeline_id="p", profile_reachable=True, profile_status="found")
    assert _satisfied("instagram", business=biz, instagram=blocked) is False
    assert _satisfied("instagram", business=biz, instagram=missing) is False
    assert _satisfied("instagram", business=biz, instagram=found) is True


def test_optional_channels_do_not_become_mandatory():
    from engine.prune_reason_taxonomy import evaluate_required_channels

    biz = BusinessCandidate(pipeline_id="p", session_id="s", provider="x", name="n", phone="02 2735 9999")
    contact = ContactIntel(pipeline_id="p")
    satisfied, missing = evaluate_required_channels(
        required_channels=("phone",),
        business=biz,
        website_intel=None,
        instagram_intel=None,
        contact_intel=contact,
    )
    assert satisfied is True and missing == []  # only the phone was required


# ---------------------------------------------------------------------------
# 9. Lead payload (Python -> Node)
# ---------------------------------------------------------------------------


def _opportunity(candidate: BusinessCandidate, contact: ContactIntel, website_intel=None):
    from service import _opportunity_to_lead_dict

    enriched = EnrichedBusiness(
        pipeline_id="p1",
        business=candidate,
        website_intel=website_intel or WebsiteIntel(pipeline_id="p1", website_reachable=True, final_url=candidate.website),
        instagram_intel=None,
        contact_intel=contact,
    )
    opp = QualifiedOpportunity(
        pipeline_id="p1",
        session_id="s1",
        business=enriched,
        qualification=QualificationResult(pipeline_id="p1", qualified=True, reasons=()),
        score=OpportunityScore(pipeline_id="p1", opportunity_score=80.0, tier="A"),
    )
    stored = StoredOpportunity(
        opportunity_id="opp_1", pipeline_id="p1", created_at=datetime.now(timezone.utc).isoformat()
    )
    return _opportunity_to_lead_dict(opp, stored)


def test_extra_channels_reach_the_lead_payload():
    cand = _candidate("p1", website="https://shop.com")
    contact = ContactIntel(
        pipeline_id="p1",
        linkedin_url="https://linkedin.com/company/shop",
        whatsapp_link="https://wa.me/201001234567",
        messenger_link="https://m.me/shop",
        telegram_link="https://t.me/shop",
        contact_form_url="https://shop.com/contact",
    )
    lead = _opportunity(cand, contact)
    assert lead["linkedin"] == "https://linkedin.com/company/shop"
    assert lead["whatsapp"] == "https://wa.me/201001234567"
    assert lead["messenger"] == "https://m.me/shop"
    assert lead["telegram"] == "https://t.me/shop"
    assert lead["contact_form_url"] == "https://shop.com/contact"


def test_provider_email_is_included_and_invalid_emails_are_not():
    cand = _candidate("p1", website="https://shop.com", provider_email="owner@shop.com")
    contact = ContactIntel(pipeline_id="p1", emails=("logo@2x.png", "info@shop.com"))
    lead = _opportunity(cand, contact)
    assert set(lead["emails"]) == {"owner@shop.com", "info@shop.com"}
    assert "logo@2x.png" not in lead["emails"]
    assert lead["email"] == lead["emails"][0]


def test_best_email_is_primary():
    cand = _candidate("p1", website="https://shop.com")
    contact = ContactIntel(pipeline_id="p1", emails=("credit@webagency.com", "info@shop.com"))
    lead = _opportunity(cand, contact)
    assert lead["email"] == "info@shop.com"


def test_egyptian_phone_is_normalized_and_deduplicated():
    cand = _candidate("p1", website="https://shop.com", phone="(02) 2735 9999", country="Egypt")
    contact = ContactIntel(
        pipeline_id="p1", phones=("+20 2 2735 9999", "0100 123 4567", "+201001234567")
    )
    lead = _opportunity(cand, contact)
    assert lead["phone"] == "+20227359999"
    assert lead["phones"] == ["+20227359999", "+20100123456" + "7"]


def test_provider_phone_is_never_lost_when_it_cannot_be_normalized():
    cand = _candidate("p1", website="https://shop.com", phone="123 4567 890", country=None)
    lead = _opportunity(cand, ContactIntel(pipeline_id="p1"))
    assert lead["phone"]  # preserved as written, not dropped


def test_field_provenance_is_emitted_in_the_shape_node_reads():
    cand = _candidate("p1", website="https://shop.com")
    contact = ContactIntel(
        pipeline_id="p1",
        emails=("info@shop.com",),
        email_provenance=(("info@shop.com", "contact_page"),),
    )
    wi = WebsiteIntel(
        pipeline_id="p1", website_reachable=True, final_url="https://shop.com",
        contact_page="https://shop.com/contact",
    )
    lead = _opportunity(cand, contact, wi)
    prov = lead["field_provenance"]
    assert prov["email"] == {
        "value": "info@shop.com",
        "source": "https://shop.com/contact",
        "method": "website_crawl",
    }
    assert prov["phone"]["method"] == "google_maps"
    assert set(prov["email"]) == {"value", "source", "method"}


def test_jsonld_provenance_maps_to_schema_org():
    cand = _candidate("p1", website="https://shop.com")
    contact = ContactIntel(
        pipeline_id="p1", emails=("info@shop.com",), email_provenance=(("info@shop.com", "jsonld"),)
    )
    lead = _opportunity(cand, contact)
    assert lead["field_provenance"]["email"]["method"] == "schema_org"


def test_instagram_survives_serialization_from_every_source():
    cand = _candidate("p1", website="https://shop.com", instagram_url="https://www.instagram.com/prov/")
    lead = _opportunity(cand, ContactIntel(pipeline_id="p1"))
    assert lead["instagram"] == "https://www.instagram.com/prov/"
    cand2 = _candidate("p1", website="https://shop.com")
    lead2 = _opportunity(cand2, ContactIntel(pipeline_id="p1", instagram_url="https://www.instagram.com/site/"))
    assert lead2["instagram"] == "https://www.instagram.com/site/"
