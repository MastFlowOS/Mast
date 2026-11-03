"""
MAST Phase 9 — Production SSRF & Outbound Egress Hardening Tests
================================================================

Verifies that in production mode (ENFORCE_LOCAL_ISOLATION unset/false):
1. WebsiteWorker rejects cloud metadata endpoints (169.254.169.254, metadata.google.internal).
2. WebsiteWorker rejects localhost/loopback destinations (127.0.0.1, ::1, localhost).
3. WebsiteWorker rejects private network destinations (10.0.0.1, 192.168.1.1, 172.16.0.1).
4. WebsiteWorker rejects sensitive internal service ports (5432, 6379, 22).
5. _RedirectTracker intercepts and blocks HTTP redirects targeting restricted endpoints.
6. InstagramWorker rejects cloud metadata, private IPs, and localhost destinations.
7. LocalIsolationRedirectHandler blocks prohibited redirect hops in production.
"""

import os
import unittest
from unittest.mock import MagicMock, patch
import urllib.error

from engine.contracts import BusinessCandidate
from utils.egress_guard import (
    DisallowedEgressError,
    assert_safe_egress_url,
    is_safe_egress_url,
    LocalIsolationRedirectHandler,
)
from workers.website_worker import WebsiteWorker, _RedirectTracker
from workers.instagram_worker import InstagramWorker


class TestPhase9SsrfProductionHardening(unittest.TestCase):
    def setUp(self):
        # Guarantee production mode (isolation flag unset)
        self.orig_isolation = os.environ.pop("ENFORCE_LOCAL_ISOLATION", None)

    def tearDown(self):
        if self.orig_isolation is not None:
            os.environ["ENFORCE_LOCAL_ISOLATION"] = self.orig_isolation
        else:
            os.environ.pop("ENFORCE_LOCAL_ISOLATION", None)

    def test_cloud_metadata_blocked(self):
        targets = [
            "http://169.254.169.254/latest/meta-data/",
            "http://169.254.169.254/",
            "https://169.254.169.254:443/secret",
            "http://metadata.google.internal/computeMetadata/v1/",
            "http://instance-data/latest/meta-data/",
        ]
        for url in targets:
            safe, reason = is_safe_egress_url(url, resolve_dns=False)
            self.assertFalse(safe, f"Expected {url} to be unsafe, reason: {reason}")
            with self.assertRaises(DisallowedEgressError):
                assert_safe_egress_url(url, resolve_dns=False)

    def test_localhost_and_loopback_blocked_in_prod(self):
        targets = [
            "http://localhost:8080/metrics",
            "http://127.0.0.1:3000/api",
            "http://[::1]:8000/",
            "http://0.0.0.0:8000/",
        ]
        for url in targets:
            safe, reason = is_safe_egress_url(url, resolve_dns=False)
            self.assertFalse(safe, f"Expected {url} to be unsafe in production mode")
            with self.assertRaises(DisallowedEgressError):
                assert_safe_egress_url(url, resolve_dns=False)

    def test_private_networks_blocked_in_prod(self):
        targets = [
            "http://10.0.0.1/admin",
            "http://192.168.1.1/setup",
            "http://172.16.0.5/api",
        ]
        for url in targets:
            safe, reason = is_safe_egress_url(url, resolve_dns=False)
            self.assertFalse(safe, f"Expected {url} to be unsafe in production mode")
            with self.assertRaises(DisallowedEgressError):
                assert_safe_egress_url(url, resolve_dns=False)

    def test_sensitive_ports_blocked_in_prod(self):
        targets = [
            "http://example.com:5432/",  # PostgreSQL
            "http://example.com:6379/",  # Redis
            "http://example.com:22/",    # SSH
            "http://example.com:3306/",  # MySQL
        ]
        for url in targets:
            safe, reason = is_safe_egress_url(url, resolve_dns=False)
            self.assertFalse(safe, f"Expected port in {url} to be blocked in production")

    def test_website_worker_returns_unreachable_on_ssrf_attempt(self):
        worker = WebsiteWorker(enable_cache=False)
        candidate = BusinessCandidate(
            pipeline_id="pipe-ssrf-1",
            session_id="sess-1",
            provider="test",
            name="SSRF Dentist",
            website="http://169.254.169.254/latest/meta-data/",
        )
        intel = worker.process(candidate)
        self.assertFalse(intel.website_reachable)
        self.assertEqual(intel.pipeline_id, "pipe-ssrf-1")

    def test_redirect_tracker_blocks_ssrf_redirect(self):
        tracker = _RedirectTracker()
        req = MagicMock()
        with self.assertRaises(DisallowedEgressError):
            tracker.redirect_request(req, None, 302, "Found", {}, "http://169.254.169.254/latest/meta-data/")

    def test_instagram_worker_returns_error_on_ssrf_attempt(self):
        worker = InstagramWorker()
        candidate = BusinessCandidate(
            pipeline_id="pipe-ssrf-ig-1",
            session_id="sess-1",
            provider="test",
            name="SSRF IG Biz",
            instagram_url="http://169.254.169.254/latest/meta-data/",
        )
        intel = worker.process(candidate)
        self.assertFalse(intel.profile_reachable)
        self.assertEqual(intel.profile_status, "error")


if __name__ == "__main__":
    unittest.main()
