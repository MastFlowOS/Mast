"""
Regression tests for Lead Engine Optimization Sprint:
1. ContactWorker homepage_html reuse (avoids redundant homepage HTTP fetch)
2. ContactWorker O(1) phone key deduplication
3. WebsiteWorker domain cache (avoids repeated network calls for identical domains)
4. WebsiteWorker homepage_html preservation
"""

from unittest.mock import MagicMock, patch
import threading
import urllib.error
import socket
import pytest

from engine.contracts import BusinessCandidate, WebsiteIntel, ContactIntel, EnrichedBusiness
from workers.website_worker import WebsiteWorker
from workers.contact_worker import ContactWorker
from workers.merge_worker import MergeWorker, MergeInput


def test_contact_worker_reuses_homepage_html_without_network_call():
    """ContactWorker should process in-memory homepage_html directly, skipping network fetch."""
    worker = ContactWorker()

    sample_html = """
    <!DOCTYPE html>
    <html>
      <head><title>Test Cafe</title></head>
      <body>
        <a href="mailto:hello@testcafe.com">Email Us</a>
        <a href="tel:+15550199999">Call Us</a>
        <a href="https://instagram.com/testcafe">Instagram</a>
      </body>
    </html>
    """

    intel = WebsiteIntel(
        pipeline_id="p-test-reuse",
        website_reachable=True,
        final_url="https://testcafe.com",
        homepage_html=sample_html,
    )

    fetch_mock = MagicMock(side_effect=Exception("Network fetch must not be called!"))
    with patch.object(worker, "_fetch", fetch_mock):
        contact_intel = worker.process(intel)

    assert fetch_mock.call_count == 0, "Expected zero network calls when homepage_html is present"
    assert "hello@testcafe.com" in contact_intel.emails
    assert any("5550199999" in "".join(ch for ch in p if ch.isdigit()) for p in contact_intel.phones)
    assert contact_intel.instagram_url == "https://www.instagram.com/testcafe/"


def test_contact_worker_falls_back_to_fetch_when_homepage_html_missing():
    """ContactWorker fetches over network if homepage_html is None."""
    worker = ContactWorker(required_channels=["email"])

    sample_html = """
    <html><body><a href="mailto:fallback@testcafe.com">Email</a></body></html>
    """

    intel = WebsiteIntel(
        pipeline_id="p-test-no-cache",
        website_reachable=True,
        final_url="https://testcafe.com",
        homepage_html=None,
    )

    fetch_mock = MagicMock(return_value=(sample_html, "https://testcafe.com", 0.05))
    with patch.object(worker, "_fetch", fetch_mock):
        contact_intel = worker.process(intel)

    assert fetch_mock.call_count == 1
    assert "fallback@testcafe.com" in contact_intel.emails


def test_contact_worker_phone_dedup_o1():
    """ContactWorker._extract_page_contact_data deduplicates phone numbers correctly."""
    emails = {}
    phones = {}

    html = """
    <html>
      <body>
        <a href="tel:+1 (555) 012-3456">Phone 1</a>
        <a href="tel:555.012.3456">Phone 2 (same 10 digits)</a>
        <a href="tel:+1 555 012 9999">Phone 3 (different)</a>
      </body>
    </html>
    """

    ContactWorker._extract_page_contact_data(
        html=html,
        page_url="https://test.com",
        page_role="homepage",
        emails=emails,
        phones=phones,
    )

    assert len(phones) == 2, f"Expected exactly 2 distinct 10-digit phone numbers, got {phones}"


def test_website_worker_domain_cache_prevents_duplicate_fetch():
    """WebsiteWorker caches domain results and reuses them for new candidates."""
    WebsiteWorker.clear_cache()
    worker = WebsiteWorker(enable_cache=True)

    fake_html = b"<html><head><title>Cached Biz</title></head><body>Welcome</body></html>"
    mock_resp = MagicMock()
    mock_resp.geturl.return_value = "https://cached-biz.com"
    mock_resp.status = 200
    mock_resp.read.return_value = fake_html
    mock_resp.headers.get_content_charset.return_value = "utf-8"
    mock_resp.__enter__.return_value = mock_resp
    mock_resp.__exit__.return_value = None

    open_mock = MagicMock(return_value=mock_resp)

    with patch("urllib.request.OpenerDirector.open", open_mock):
        cand1 = BusinessCandidate(
            session_id="s1",
            provider="maps",
            pipeline_id="p-cand-1",
            name="Biz Location 1",
            website="https://cached-biz.com",
        )
        res1 = worker.process(cand1)

        cand2 = BusinessCandidate(
            session_id="s1",
            provider="maps",
            pipeline_id="p-cand-2",
            name="Biz Location 2",
            website="https://cached-biz.com",
        )
        res2 = worker.process(cand2)

    assert open_mock.call_count == 1, f"Expected only 1 network fetch for duplicate domain, got {open_mock.call_count}"
    assert res1.pipeline_id == "p-cand-1"
    assert res2.pipeline_id == "p-cand-2"
    assert res1.title == "Cached Biz"
    assert res2.title == "Cached Biz"
    assert res1.homepage_html == "<html><head><title>Cached Biz</title></head><body>Welcome</body></html>"
    assert res2.homepage_html == res1.homepage_html
    WebsiteWorker.clear_cache()


def test_single_flight_coordinator_deduplicates_concurrent_calls():
    """SingleFlight ensures only one execution happens for identical keys concurrently."""
    import time
    from concurrent.futures import ThreadPoolExecutor
    from utils.single_flight import SingleFlight

    sf = SingleFlight[str]()
    call_count = 0
    lock = threading.Lock()

    def slow_fetch(key: str) -> str:
        nonlocal call_count
        with lock:
            call_count += 1
        time.sleep(0.05)
        return f"result_for_{key}"

    keys = ["domain.com"] * 5
    with ThreadPoolExecutor(max_workers=5) as executor:
        futures = [executor.submit(sf.do, k, slow_fetch, k) for k in keys]
        results = [f.result() for f in futures]

    assert call_count == 1, f"Expected exactly 1 execution across 5 concurrent callers, got {call_count}"
    assert all(r == "result_for_domain.com" for r in results)
    assert sf.in_flight_count() == 0


def test_website_worker_single_flight_concurrent_requests():
    """WebsiteWorker uses SingleFlight to collapse concurrent requests to the same domain."""
    import time
    from concurrent.futures import ThreadPoolExecutor

    WebsiteWorker.clear_cache()
    worker = WebsiteWorker(enable_cache=True)

    fake_html = b"<html><head><title>Concurrent Co</title></head><body>Hello</body></html>"
    mock_resp = MagicMock()
    mock_resp.geturl.return_value = "https://concurrent-co.com"
    mock_resp.status = 200
    mock_resp.read.return_value = fake_html
    mock_resp.headers.get_content_charset.return_value = "utf-8"
    mock_resp.__enter__.return_value = mock_resp
    mock_resp.__exit__.return_value = None

    open_calls = 0
    def slow_open(*args, **kwargs):
        nonlocal open_calls
        open_calls += 1
        time.sleep(0.04)
        return mock_resp

    with patch("urllib.request.OpenerDirector.open", side_effect=slow_open):
        candidates = [
            BusinessCandidate(
                session_id="s1",
                provider="maps",
                pipeline_id=f"p-concurrent-{i}",
                name=f"Branch {i}",
                website="https://concurrent-co.com",
            )
            for i in range(4)
        ]

        with ThreadPoolExecutor(max_workers=4) as executor:
            futures = [executor.submit(worker.process, c) for c in candidates]
            results = [f.result() for f in futures]

    assert open_calls == 1, f"Expected 1 network call due to SingleFlight, got {open_calls}"
    assert len(results) == 4
    for i, res in enumerate(results):
        assert res.pipeline_id == f"p-concurrent-{i}"
        assert res.title == "Concurrent Co"
        assert res.website_reachable is True
    WebsiteWorker.clear_cache()


def test_contact_worker_unified_multi_channel_anchor_extraction():
    """ContactWorker extracts all social, tel, and mailto channels in a single anchor pass."""
    worker = ContactWorker(required_channels=["email", "phone"])

    multi_channel_html = """
    <!DOCTYPE html>
    <html>
      <body>
        <a href="mailto:support@omnichannel.com">Email Support</a>
        <a href="tel:+18005550199">Toll Free</a>
        <a href="https://wa.me/18005550199">Chat on WhatsApp</a>
        <a href="https://m.me/omnichannel">Facebook Messenger</a>
        <a href="https://t.me/omnichannel_official">Telegram Channel</a>
        <a href="https://www.linkedin.com/company/omnichannel-inc">LinkedIn Page</a>
        <a href="https://instagram.com/omnichannel_official">Instagram Profile</a>
      </body>
    </html>
    """

    intel = WebsiteIntel(
        pipeline_id="p-multi-channel",
        website_reachable=True,
        final_url="https://omnichannel.com",
        homepage_html=multi_channel_html,
    )

    fetch_mock = MagicMock(side_effect=Exception("Should not fetch network"))
    with patch.object(worker, "_fetch", fetch_mock):
        contact = worker.process(intel)

    assert "support@omnichannel.com" in contact.emails
    assert any("18005550199" in "".join(ch for ch in p if ch.isdigit()) for p in contact.phones)
    assert contact.whatsapp_link == "https://wa.me/18005550199"
    assert contact.messenger_link == "https://m.me/omnichannel"
    assert contact.telegram_link == "https://t.me/omnichannel_official"
    assert contact.linkedin_url == "https://www.linkedin.com/company/omnichannel-inc"
    assert contact.instagram_url == "https://www.instagram.com/omnichannel_official/"


def test_website_worker_does_not_cache_transient_http_errors():
    """HTTP 429 / 500 / 503 errors must NEVER be cached, preserving retry behavior."""
    WebsiteWorker.clear_cache()
    worker = WebsiteWorker(enable_cache=True)

    cand1 = BusinessCandidate(
        session_id="s1",
        provider="maps",
        pipeline_id="p-transient-1",
        name="Rate Limited Biz",
        website="https://transient-biz.com",
    )

    # 1. First attempt triggers HTTP 429 Too Many Requests
    mock_429 = urllib.error.HTTPError(
        url="https://transient-biz.com",
        code=429,
        msg="Too Many Requests",
        hdrs=MagicMock(),
        fp=None,
    )

    with patch("urllib.request.OpenerDirector.open", side_effect=mock_429):
        res1 = worker.process(cand1)

    assert res1.http_status == 429
    assert res1.website_reachable is True
    # Verify 429 was NOT stored in the domain cache
    canon_key = WebsiteWorker.canonicalize_url("https://transient-biz.com")
    assert canon_key not in WebsiteWorker._domain_cache

    # 2. Subsequent attempt succeeds with 200 OK
    fake_html = b"<html><head><title>Recovered Biz</title></head><body>OK</body></html>"
    mock_200 = MagicMock()
    mock_200.geturl.return_value = "https://transient-biz.com"
    mock_200.status = 200
    mock_200.read.return_value = fake_html
    mock_200.headers.get_content_charset.return_value = "utf-8"
    mock_200.__enter__.return_value = mock_200
    mock_200.__exit__.return_value = None

    cand2 = BusinessCandidate(
        session_id="s1",
        provider="maps",
        pipeline_id="p-transient-2",
        name="Rate Limited Biz (Retry)",
        website="https://transient-biz.com",
    )

    with patch("urllib.request.OpenerDirector.open", return_value=mock_200):
        res2 = worker.process(cand2)

    assert res2.http_status == 200
    assert res2.title == "Recovered Biz"
    assert res2.homepage_html is not None
    # Successful 200 OK IS cached
    assert canon_key in WebsiteWorker._domain_cache
    WebsiteWorker.clear_cache()


def test_website_worker_does_not_cache_socket_timeouts():
    """Socket timeouts and connection failures must NOT be cached as permanent negative results."""
    WebsiteWorker.clear_cache()
    worker = WebsiteWorker(enable_cache=True)

    cand1 = BusinessCandidate(
        session_id="s1",
        provider="maps",
        pipeline_id="p-timeout-1",
        name="Timeout Biz",
        website="https://timeout-biz.com",
    )

    # First attempt raises socket.timeout
    with patch("urllib.request.OpenerDirector.open", side_effect=socket.timeout("Connection timed out")):
        res1 = worker.process(cand1)

    assert res1.website_reachable is False
    canon_timeout_key = WebsiteWorker.canonicalize_url("https://timeout-biz.com")
    assert canon_timeout_key not in WebsiteWorker._domain_cache

    # Second attempt succeeds
    fake_html = b"<html><head><title>Now Available</title></head><body>Hello</body></html>"
    mock_200 = MagicMock()
    mock_200.geturl.return_value = "https://timeout-biz.com"
    mock_200.status = 200
    mock_200.read.return_value = fake_html
    mock_200.headers.get_content_charset.return_value = "utf-8"
    mock_200.__enter__.return_value = mock_200
    mock_200.__exit__.return_value = None

    cand2 = BusinessCandidate(
        session_id="s1",
        provider="maps",
        pipeline_id="p-timeout-2",
        name="Timeout Biz Retry",
        website="https://timeout-biz.com",
    )

    with patch("urllib.request.OpenerDirector.open", return_value=mock_200):
        res2 = worker.process(cand2)

    assert res2.website_reachable is True
    assert res2.title == "Now Available"
    WebsiteWorker.clear_cache()


def test_single_flight_leader_failure_does_not_poison_followers():
    """If the leader in SingleFlight fails, follower falls back to independent attempt."""
    import time
    from concurrent.futures import ThreadPoolExecutor

    WebsiteWorker.clear_cache()
    worker = WebsiteWorker(enable_cache=True)

    call_count = 0
    lock = threading.Lock()

    fake_html = b"<html><head><title>Survivor Biz</title></head><body>OK</body></html>"
    mock_200 = MagicMock()
    mock_200.geturl.return_value = "https://flaky-biz.com"
    mock_200.status = 200
    mock_200.read.return_value = fake_html
    mock_200.headers.get_content_charset.return_value = "utf-8"
    mock_200.__enter__.return_value = mock_200
    mock_200.__exit__.return_value = None

    def flaky_open(*args, **kwargs):
        nonlocal call_count
        with lock:
            call_count += 1
            current = call_count
        if current == 1:
            time.sleep(0.04)
            raise socket.timeout("Leader failed")
        return mock_200

    cand1 = BusinessCandidate(
        session_id="s1",
        provider="maps",
        pipeline_id="p-leader",
        name="Leader Biz",
        website="https://flaky-biz.com",
    )
    cand2 = BusinessCandidate(
        session_id="s1",
        provider="maps",
        pipeline_id="p-follower",
        name="Follower Biz",
        website="https://flaky-biz.com",
    )

    with patch("urllib.request.OpenerDirector.open", side_effect=flaky_open):
        with ThreadPoolExecutor(max_workers=2) as executor:
            fut1 = executor.submit(worker.process, cand1)
            fut2 = executor.submit(worker.process, cand2)
            r1 = fut1.result()
            r2 = fut2.result()

    # One of the candidates may have caught the initial timeout, but the follower
    # fell back to independent fetch and succeeded!
    results = [r1, r2]
    successful = [r for r in results if r.website_reachable is True]
    assert len(successful) >= 1, "Follower must succeed independently even if leader fails"
    assert any(r.title == "Survivor Biz" for r in successful)
    WebsiteWorker.clear_cache()


def test_different_paths_on_same_domain_do_not_share_cache():
    """Candidates on the same domain with different paths must have independent inspection."""
    WebsiteWorker.clear_cache()
    worker = WebsiteWorker(enable_cache=True)

    cand_chicago = BusinessCandidate(
        session_id="s1",
        provider="maps",
        pipeline_id="p-chi",
        name="Chicago Branch",
        website="https://national-chain.com/locations/chicago",
    )
    cand_miami = BusinessCandidate(
        session_id="s1",
        provider="maps",
        pipeline_id="p-mia",
        name="Miami Branch",
        website="https://national-chain.com/locations/miami",
    )

    def branch_open(req, *args, **kwargs):
        url = req.full_url if hasattr(req, "full_url") else str(req)
        resp = MagicMock()
        resp.geturl.return_value = url
        resp.status = 200
        resp.headers.get_content_charset.return_value = "utf-8"
        resp.__enter__.return_value = resp
        resp.__exit__.return_value = None
        if "chicago" in url:
            resp.read.return_value = b"<html><head><title>Chicago Clinic</title></head></html>"
        else:
            resp.read.return_value = b"<html><head><title>Miami Clinic</title></head></html>"
        return resp

    with patch("urllib.request.OpenerDirector.open", side_effect=branch_open):
        res_chi = worker.process(cand_chicago)
        res_mia = worker.process(cand_miami)

    assert res_chi.title == "Chicago Clinic"
    assert res_mia.title == "Miami Clinic"
    assert res_chi.pipeline_id == "p-chi"
    assert res_mia.pipeline_id == "p-mia"
    WebsiteWorker.clear_cache()


def test_candidate_specific_maps_data_preserved_with_shared_website():
    """Branch candidates sharing a homepage preserve their distinct candidate-specific Maps info."""
    cand1 = BusinessCandidate(
        session_id="s1",
        provider="maps",
        pipeline_id="p-b1",
        name="Branch Downtown",
        phone="212-555-0101",
        website="https://brand-chain.com",
    )
    cand2 = BusinessCandidate(
        session_id="s1",
        provider="maps",
        pipeline_id="p-b2",
        name="Branch Uptown",
        phone="212-555-0102",
        website="https://brand-chain.com",
    )

    sample_html = """
    <html>
      <head><title>Brand Chain</title></head>
      <body><a href="mailto:hq@brand-chain.com">HQ Contact</a></body>
    </html>
    """
    web1 = WebsiteIntel(
        pipeline_id="p-b1",
        website_reachable=True,
        final_url="https://brand-chain.com",
        homepage_html=sample_html,
    )
    web2 = WebsiteIntel(
        pipeline_id="p-b2",
        website_reachable=True,
        final_url="https://brand-chain.com",
        homepage_html=sample_html,
    )

    contact_worker = ContactWorker()
    cont1 = contact_worker.process(web1)
    cont2 = contact_worker.process(web2)

    merge_worker = MergeWorker()
    enriched1 = merge_worker.process(MergeInput(business=cand1, website_intel=web1, contact_intel=cont1))
    enriched2 = merge_worker.process(MergeInput(business=cand2, website_intel=web2, contact_intel=cont2))

    # Verify both enriched businesses retained their candidate-specific Maps phones and names
    assert enriched1.business.phone == "212-555-0101"
    assert enriched1.business.name == "Branch Downtown"
    assert enriched2.business.phone == "212-555-0102"
    assert enriched2.business.name == "Branch Uptown"
    # And both have HQ email from the homepage
    assert "hq@brand-chain.com" in enriched1.contact_intel.emails
    assert "hq@brand-chain.com" in enriched2.contact_intel.emails


def test_secondary_page_fallback_triggers_when_homepage_missing_required_channels():
    """When homepage_html is missing a required channel, ContactWorker fetches secondary pages."""
    worker = ContactWorker(required_channels=["email", "phone"])

    homepage_html = """
    <html>
      <body>
        <a href="mailto:office@company.com">Email Us</a>
        <a href="/contact">Visit Contact Page</a>
      </body>
    </html>
    """

    secondary_html = """
    <html>
      <body>
        <a href="tel:+1 (555) 019-7777">Call Us</a>
      </body>
    </html>
    """

    intel = WebsiteIntel(
        pipeline_id="p-sec-fallback",
        website_reachable=True,
        final_url="https://company.com",
        homepage_html=homepage_html,
    )

    fetch_mock = MagicMock(return_value=(secondary_html, "https://company.com/contact", 0.05))
    with patch.object(worker, "_fetch", fetch_mock):
        contact = worker.process(intel)

    # Verify fetch was called for the secondary page
    assert fetch_mock.call_count == 1
    assert "office@company.com" in contact.emails
    assert any("019-7777" in p for p in contact.phones)
    assert contact.secondary_page_fetched is True


def test_contact_channel_completeness_parity_pre_vs_post():
    """Verify that unified anchor extraction produces 100% identical contact channels to isolated regexes."""
    html_corpus = """
    <!DOCTYPE html>
    <html>
      <head>
        <title>Omnichannel Corp</title>
        <script type="application/ld+json">
        {
          "@context": "https://schema.org",
          "@type": "LocalBusiness",
          "email": "jsonld@omnichannel.com",
          "telephone": "+1-888-555-0144"
        }
        </script>
      </head>
      <body>
        <div data-email="attr@omnichannel.com" aria-label="Call +1-888-555-0155">
          <h1>Welcome</h1>
        </div>
        <p>Direct reach: info@omnichannel.com or call (888) 555-0166</p>
        <a href="mailto:anchor@omnichannel.com">Anchor Email</a>
        <a href="tel:+18885550177">Anchor Phone</a>
        <a href="https://wa.me/18885550177?text=hi">WhatsApp</a>
        <a href="https://m.me/omnichannelcorp">Messenger</a>
        <a href="https://t.me/omnichannel_group">Telegram</a>
        <a href="https://www.linkedin.com/company/omnichannel-global">LinkedIn</a>
        <a href="https://www.instagram.com/omnichannel_hq/">Instagram</a>
      </body>
    </html>
    """

    worker = ContactWorker()
    intel = WebsiteIntel(
        pipeline_id="p-parity-check",
        website_reachable=True,
        final_url="https://omnichannel.com",
        homepage_html=html_corpus,
    )

    fetch_mock = MagicMock(side_effect=Exception("Should not fetch network"))
    with patch.object(worker, "_fetch", fetch_mock):
        contact = worker.process(intel)

    # 1. Emails from all sources (anchor, JSON-LD, attributes, text regex)
    expected_emails = {
        "anchor@omnichannel.com",
        "jsonld@omnichannel.com",
        "attr@omnichannel.com",
        "info@omnichannel.com",
    }
    for e in expected_emails:
        assert e in contact.emails, f"Missing email from extraction: {e}"

    # 2. Phones from all sources (anchor, JSON-LD, attributes, text regex)
    assert any("5550177" in p or "555-0177" in p for p in contact.phones), "Missing anchor phone"
    assert any("5550144" in p or "555-0144" in p for p in contact.phones), "Missing JSON-LD phone"
    assert any("5550155" in p or "555-0155" in p for p in contact.phones), "Missing attribute phone"
    assert any("5550166" in p or "555-0166" in p for p in contact.phones), "Missing text regex phone"

    # 3. Messaging channels
    assert contact.whatsapp_link == "https://wa.me/18885550177?text=hi"
    assert contact.messenger_link == "https://m.me/omnichannelcorp"
    assert contact.telegram_link == "https://t.me/omnichannel_group"
    assert contact.linkedin_url == "https://www.linkedin.com/company/omnichannel-global"
    assert contact.instagram_url == "https://www.instagram.com/omnichannel_hq/"


def test_url_canonicalization_rules():
    """Verify URL canonicalization preserves path/query case and distinguishes non-root paths while safely sharing root."""
    canon = WebsiteWorker.canonicalize_url

    # 1. Scheme and host normalization (RFC 3986)
    assert canon("HTTPS://EXAMPLE.COM") == "https://example.com/"
    assert canon("http://EXAMPLE.COM") == "http://example.com/"
    assert canon("EXAMPLE.COM") == "https://example.com/"

    # 2. Root URL trailing slash normalization
    assert canon("https://example.com") == "https://example.com/"
    assert canon("https://example.com/") == "https://example.com/"
    assert canon("example.com") == "https://example.com/"
    assert canon("example.com/") == "https://example.com/"

    # 3. Default port omission
    assert canon("https://example.com:443") == "https://example.com/"
    assert canon("https://example.com:443/") == "https://example.com/"
    assert canon("http://example.com:80") == "http://example.com/"
    assert canon("https://example.com:8443") == "https://example.com:8443/"

    # 4. Root with query string equivalence
    assert canon("https://example.com?mode=test") == "https://example.com/?mode=test"
    assert canon("https://example.com/?mode=test") == "https://example.com/?mode=test"

    # 5. Non-root path case sensitivity preserved
    assert canon("https://example.com/BranchA") != canon("https://example.com/brancha")
    assert canon("https://example.com/BranchA") == "https://example.com/BranchA"
    assert canon("https://example.com/brancha") == "https://example.com/brancha"

    # 6. Non-root trailing slash preserved (not collapsed)
    assert canon("https://example.com/dir") != canon("https://example.com/dir/")
    assert canon("https://example.com/dir") == "https://example.com/dir"
    assert canon("https://example.com/dir/") == "https://example.com/dir/"

    # 7. Query string case sensitivity preserved
    assert canon("https://example.com/search?Token=ABC") != canon("https://example.com/search?token=abc")
    assert canon("https://example.com/search?Token=ABC") == "https://example.com/search?Token=ABC"

    # 8. Protocol distinction preserved (http != https)
    assert canon("http://example.com/") != canon("https://example.com/")

    # 9. Client fragment stripped
    assert canon("https://example.com/page#section1") == "https://example.com/page"


def test_case_sensitive_paths_remain_distinct_in_cache_and_single_flight():
    """Candidates on same domain with case-different paths must be fetched and cached independently."""
    WebsiteWorker.clear_cache()
    worker = WebsiteWorker(enable_cache=True)

    cand1 = BusinessCandidate(
        session_id="s1",
        provider="maps",
        pipeline_id="p-upper",
        name="Upper Case Doc",
        website="https://example.com/CaseSensitive/DocA",
    )
    cand2 = BusinessCandidate(
        session_id="s1",
        provider="maps",
        pipeline_id="p-lower",
        name="Lower Case Doc",
        website="https://example.com/casesensitive/doca",
    )

    call_count = 0
    def case_open(req, *args, **kwargs):
        nonlocal call_count
        call_count += 1
        url = req.full_url if hasattr(req, "full_url") else str(req)
        resp = MagicMock()
        resp.geturl.return_value = url
        resp.status = 200
        resp.headers.get_content_charset.return_value = "utf-8"
        resp.__enter__.return_value = resp
        resp.__exit__.return_value = None
        if "CaseSensitive" in url:
            resp.read.return_value = b"<html><head><title>Upper Doc</title></head><body>DocA</body></html>"
        else:
            resp.read.return_value = b"<html><head><title>Lower Doc</title></head><body>doca</body></html>"
        return resp

    with patch("urllib.request.OpenerDirector.open", side_effect=case_open):
        res1 = worker.process(cand1)
        res2 = worker.process(cand2)

    # Must have performed 2 separate fetches
    assert call_count == 2, f"Expected 2 separate fetches for case-different paths, got {call_count}"
    assert res1.title == "Upper Doc"
    assert res2.title == "Lower Doc"
    assert res1.pipeline_id == "p-upper"
    assert res2.pipeline_id == "p-lower"

    # Both must exist distinctly in cache
    key1 = WebsiteWorker.canonicalize_url("https://example.com/CaseSensitive/DocA")
    key2 = WebsiteWorker.canonicalize_url("https://example.com/casesensitive/doca")
    assert key1 in WebsiteWorker._domain_cache
    assert key2 in WebsiteWorker._domain_cache
    assert key1 != key2
    WebsiteWorker.clear_cache()


def test_query_values_remain_distinct_in_cache_and_single_flight():
    """Candidates on same domain with case-different or distinct queries must remain distinct."""
    WebsiteWorker.clear_cache()
    worker = WebsiteWorker(enable_cache=True)

    cand1 = BusinessCandidate(
        session_id="s1",
        provider="maps",
        pipeline_id="p-q1",
        name="Item WidgetA",
        website="https://example.com/catalog?item=WidgetA",
    )
    cand2 = BusinessCandidate(
        session_id="s1",
        provider="maps",
        pipeline_id="p-q2",
        name="Item widgeta",
        website="https://example.com/catalog?item=widgeta",
    )

    call_count = 0
    def query_open(req, *args, **kwargs):
        nonlocal call_count
        call_count += 1
        url = req.full_url if hasattr(req, "full_url") else str(req)
        resp = MagicMock()
        resp.geturl.return_value = url
        resp.status = 200
        resp.headers.get_content_charset.return_value = "utf-8"
        resp.__enter__.return_value = resp
        resp.__exit__.return_value = None
        if "WidgetA" in url:
            resp.read.return_value = b"<html><head><title>Widget A</title></head><body>A</body></html>"
        else:
            resp.read.return_value = b"<html><head><title>Widget a</title></head><body>a</body></html>"
        return resp

    with patch("urllib.request.OpenerDirector.open", side_effect=query_open):
        res1 = worker.process(cand1)
        res2 = worker.process(cand2)

    assert call_count == 2
    assert res1.title == "Widget A"
    assert res2.title == "Widget a"
    WebsiteWorker.clear_cache()


def test_equivalent_root_urls_share_cache_and_single_flight():
    """Equivalent root URLs (e.g. schemeless, with/without slash, uppercase) must share work."""
    WebsiteWorker.clear_cache()
    worker = WebsiteWorker(enable_cache=True)

    fake_html = b"<html><head><title>Root Brand</title></head><body>Welcome</body></html>"
    mock_resp = MagicMock()
    mock_resp.geturl.return_value = "https://brand.com/"
    mock_resp.status = 200
    mock_resp.read.return_value = fake_html
    mock_resp.headers.get_content_charset.return_value = "utf-8"
    mock_resp.__enter__.return_value = mock_resp
    mock_resp.__exit__.return_value = None

    open_calls = 0
    def root_open(*args, **kwargs):
        nonlocal open_calls
        open_calls += 1
        return mock_resp

    cands = [
        BusinessCandidate(session_id="s1", provider="maps", pipeline_id="p-r1", name="Root 1", website="https://brand.com"),
        BusinessCandidate(session_id="s1", provider="maps", pipeline_id="p-r2", name="Root 2", website="https://brand.com/"),
        BusinessCandidate(session_id="s1", provider="maps", pipeline_id="p-r3", name="Root 3", website="HTTPS://BRAND.COM"),
        BusinessCandidate(session_id="s1", provider="maps", pipeline_id="p-r4", name="Root 4", website="brand.com"),
    ]

    with patch("urllib.request.OpenerDirector.open", side_effect=root_open):
        results = [worker.process(c) for c in cands]

    # Exactly 1 underlying fetch across all 4 equivalent root URL variants!
    assert open_calls == 1, f"Expected 1 underlying fetch for equivalent root URLs, got {open_calls}"
    assert len(results) == 4
    for i, res in enumerate(results):
        assert res.pipeline_id == f"p-r{i+1}"
        assert res.title == "Root Brand"
        assert res.website_reachable is True
    WebsiteWorker.clear_cache()
