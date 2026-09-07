"""
Unit tests for WebsiteWorker HTTPS TLS fallback:
- ONLY for TLS/certificate verification failures.
- For an explicit HTTPS URL, try HTTP before declaring unreachable.
- Do not broaden unrelated timeout/DNS/HTTP failures into automatic HTTP fallback.
- Schemeless URLs still try HTTP fallback.
"""

import socket
import ssl
import urllib.error
from unittest.mock import MagicMock, patch

from engine.contracts import BusinessCandidate
from workers.website_worker import WebsiteWorker


def _make_fake_response(url: str, body: bytes = b"<html><head><title>Test</title></head><body>Hello</body></html>"):
    mock_resp = MagicMock()
    mock_resp.geturl.return_value = url
    mock_resp.status = 200
    mock_resp.read.return_value = body
    mock_resp.headers.get_content_charset.return_value = "utf-8"
    mock_resp.__enter__.return_value = mock_resp
    mock_resp.__exit__.return_value = None
    return mock_resp


def test_explicit_https_tls_cert_failure_falls_back_to_http_success():
    """Explicit https:// with SSLError attempts HTTP fallback and returns reachable WebsiteIntel."""
    worker = WebsiteWorker(timeout=5.0)
    candidate = BusinessCandidate(
        pipeline_id="p1",
        session_id="s1",
        provider="maps",
        name="Test Biz",
        website="https://cert-fail.example.com",
    )

    cert_error = urllib.error.URLError(ssl.SSLError("certificate verify failed: self signed certificate"))
    http_resp = _make_fake_response("http://cert-fail.example.com")

    call_urls = []

    def fake_open(req, timeout):
        call_urls.append(req.full_url)
        if req.full_url.startswith("https://"):
            raise cert_error
        return http_resp

    with patch("urllib.request.OpenerDirector.open", side_effect=fake_open):
        intel = worker.process(candidate)

    assert intel.website_reachable is True
    assert intel.final_url == "http://cert-fail.example.com"
    assert intel.https is False
    assert call_urls == ["https://cert-fail.example.com", "http://cert-fail.example.com"]


def test_explicit_https_non_tls_error_does_not_fall_back_to_http():
    """Explicit https:// with timeout/DNS failure does NOT attempt HTTP fallback."""
    worker = WebsiteWorker(timeout=5.0)
    candidate = BusinessCandidate(
        pipeline_id="p1",
        session_id="s1",
        provider="maps",
        name="Test Biz",
        website="https://timeout.example.com",
    )

    dns_error = urllib.error.URLError(socket.gaierror(11001, "getaddrinfo failed"))
    call_urls = []

    def fake_open(req, timeout):
        call_urls.append(req.full_url)
        raise dns_error

    with patch("urllib.request.OpenerDirector.open", side_effect=fake_open):
        intel = worker.process(candidate)

    assert intel.website_reachable is False
    # Verified: only called HTTPS once, no HTTP fallback attempted!
    assert call_urls == ["https://timeout.example.com"]


def test_explicit_https_socket_timeout_does_not_fall_back_to_http():
    """Explicit https:// with socket.timeout does NOT attempt HTTP fallback."""
    worker = WebsiteWorker(timeout=5.0)
    candidate = BusinessCandidate(
        pipeline_id="p1",
        session_id="s1",
        provider="maps",
        name="Test Biz",
        website="https://timedout.example.com",
    )

    call_urls = []

    def fake_open(req, timeout):
        call_urls.append(req.full_url)
        raise socket.timeout("timed out")

    with patch("urllib.request.OpenerDirector.open", side_effect=fake_open):
        intel = worker.process(candidate)

    assert intel.website_reachable is False
    assert call_urls == ["https://timedout.example.com"]


def test_schemeless_url_still_falls_back_to_http_on_any_error():
    """Schemeless URL tries https first, and on failure tries http fallback."""
    worker = WebsiteWorker(timeout=5.0)
    candidate = BusinessCandidate(
        pipeline_id="p1",
        session_id="s1",
        provider="maps",
        name="Test Biz",
        website="example.com",
    )

    timeout_error = urllib.error.URLError(socket.timeout("timed out"))
    http_resp = _make_fake_response("http://example.com")
    call_urls = []

    def fake_open(req, timeout):
        call_urls.append(req.full_url)
        if req.full_url.startswith("https://"):
            raise timeout_error
        return http_resp

    with patch("urllib.request.OpenerDirector.open", side_effect=fake_open):
        intel = worker.process(candidate)

    assert intel.website_reachable is True
    assert intel.final_url == "http://example.com"
    assert call_urls == ["https://example.com", "http://example.com"]
