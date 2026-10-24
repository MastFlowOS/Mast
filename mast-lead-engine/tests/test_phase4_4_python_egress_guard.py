"""
MAST Phase 4.4 — Python-Side Egress Restrictions Adversarial Tests
==================================================================

Verifies that when ENFORCE_LOCAL_ISOLATION=true:
1. Initial target URLs to non-loopback hosts are rejected before opening connections.
2. HTTP redirects to external domains are intercepted and blocked in _RedirectTracker.
3. Discovered contact links with absolute external hosts are blocked before fetching.
4. Instagram worker blocks non-loopback profile requests.
5. Supported loopback schemes (http/https on localhost/127.0.0.1) succeed.
6. Malformed and unexpected schemes (ftp, file, javascript) fail closed.
7. When ENFORCE_LOCAL_ISOLATION is unset/false, restrictions are disabled.
"""

import os
import unittest
from unittest.mock import MagicMock, patch
import urllib.error

from engine.contracts import BusinessCandidate, WebsiteIntel
from utils.egress_guard import (
    assert_loopback_url,
    is_local_isolation_enforced,
    is_loopback_host,
    DisallowedEgressError,
    LocalIsolationRedirectHandler,
    install_python_socket_isolation_guard,
    uninstall_python_socket_isolation_guard,
)
from workers.website_worker import WebsiteWorker, _RedirectTracker
from workers.contact_worker import ContactWorker
from workers.instagram_worker import InstagramWorker


class TestPythonEgressGuard(unittest.TestCase):
    def setUp(self):
        self._orig_env = os.environ.get("ENFORCE_LOCAL_ISOLATION")
        os.environ["ENFORCE_LOCAL_ISOLATION"] = "true"

    def tearDown(self):
        if self._orig_env is None:
            os.environ.pop("ENFORCE_LOCAL_ISOLATION", None)
        else:
            os.environ["ENFORCE_LOCAL_ISOLATION"] = self._orig_env
        uninstall_python_socket_isolation_guard()

    def test_is_loopback_host_validation(self):
        # Strictly loopback destinations must return True
        self.assertTrue(is_loopback_host("localhost"))
        self.assertTrue(is_loopback_host("127.0.0.1"))
        self.assertTrue(is_loopback_host("127.0.0.2"))
        self.assertTrue(is_loopback_host("127.255.255.254"))
        self.assertTrue(is_loopback_host("::1"))
        self.assertTrue(is_loopback_host("[::1]"))

        # Explicitly reject 0.0.0.0 and :: (unspecified / INADDR_ANY, NOT loopback destinations)
        self.assertFalse(is_loopback_host("0.0.0.0"))
        self.assertFalse(is_loopback_host("::"))

        # Non-loopback domains and IPs must return False
        self.assertFalse(is_loopback_host("google.com"))
        self.assertFalse(is_loopback_host("example.com"))
        self.assertFalse(is_loopback_host("xyz.supabase.co"))
        self.assertFalse(is_loopback_host("railway.app"))
        self.assertFalse(is_loopback_host("8.8.8.8"))
        self.assertFalse(is_loopback_host("192.168.1.1"))
        self.assertFalse(is_loopback_host("10.0.0.1"))

        # Adversarial / spoofed loopback strings must return False
        self.assertFalse(is_loopback_host("localhost.evil.com"))
        self.assertFalse(is_loopback_host("127.0.0.1.nip.io"))
        self.assertFalse(is_loopback_host("127.0.0.1.com"))
        self.assertFalse(is_loopback_host(""))
        self.assertFalse(is_loopback_host(None))

    def test_assert_loopback_url_enforcement(self):
        # Permitted local loopback URLs
        assert_loopback_url("http://127.0.0.1:8080/test")
        assert_loopback_url("https://localhost:3000/api")
        assert_loopback_url("http://[::1]:8765/stats")

        # Prohibited 0.0.0.0 and :: (unspecified address)
        with self.assertRaises(DisallowedEgressError):
            assert_loopback_url("http://0.0.0.0:8000/doc.html")

        with self.assertRaises(DisallowedEgressError):
            assert_loopback_url("http://[::]:8000/doc.html")

        # Prohibited external destinations
        with self.assertRaises(DisallowedEgressError):
            assert_loopback_url("https://example.com/page")

        with self.assertRaises(DisallowedEgressError):
            assert_loopback_url("http://google.com")

        with self.assertRaises(DisallowedEgressError):
            assert_loopback_url("https://xyz.supabase.co/rest/v1/")

        with self.assertRaises(DisallowedEgressError):
            assert_loopback_url("https://api.openai.com/v1/chat")

        # Prohibited schemes
        with self.assertRaises(DisallowedEgressError):
            assert_loopback_url("ftp://127.0.0.1/file.txt")

        with self.assertRaises(DisallowedEgressError):
            assert_loopback_url("file:///etc/passwd")

        with self.assertRaises(DisallowedEgressError):
            assert_loopback_url("javascript:alert(1)")

        # Malformed URLs
        with self.assertRaises(DisallowedEgressError):
            assert_loopback_url("http://")

        with self.assertRaises(DisallowedEgressError):
            assert_loopback_url("")

    def test_disabled_when_isolation_flag_absent(self):
        # When ENFORCE_LOCAL_ISOLATION is unset or false, production behavior is preserved
        os.environ.pop("ENFORCE_LOCAL_ISOLATION", None)
        self.assertFalse(is_local_isolation_enforced())

        # Should not raise for external URLs when isolation is disabled
        assert_loopback_url("https://example.com/production-website")

    def test_website_worker_redirect_tracker_blocks_external_redirect(self):
        tracker = _RedirectTracker()
        req = MagicMock()

        # Redirect to local loopback is allowed
        allowed_url = "http://127.0.0.1:8765/redirect/2"
        with patch.object(urllib.request.HTTPRedirectHandler, "redirect_request", return_value=req):
            res = tracker.redirect_request(req, None, 302, "Found", {}, allowed_url)
            self.assertEqual(res, req)
            self.assertIn(allowed_url, tracker.chain)

        # Redirect to external domain is blocked
        external_url = "https://external-prohibited-destination.example.com/login"
        with self.assertRaises(DisallowedEgressError):
            tracker.redirect_request(req, None, 302, "Found", {}, external_url)

    def test_website_worker_process_blocks_external_target_url(self):
        worker = WebsiteWorker(enable_cache=False)
        candidate = BusinessCandidate(
            pipeline_id="pipe-1",
            session_id="sess-1",
            provider="test",
            name="Test Biz",
            website="https://prohibited-external-host.example.com/home",
        )

        # In isolation mode, process() intercepts DisallowedEgressError and returns unreachable WebsiteIntel
        intel = worker.process(candidate)
        self.assertFalse(intel.website_reachable)
        self.assertEqual(intel.pipeline_id, "pipe-1")

    def test_contact_worker_fetch_blocks_external_url(self):
        worker = ContactWorker()

        # _fetch must raise DisallowedEgressError before making any network call
        with self.assertRaises(DisallowedEgressError):
            worker._fetch("https://external-contact-provider.example.com/contact-page")

    def test_instagram_worker_blocks_external_profile(self):
        worker = InstagramWorker()
        candidate = BusinessCandidate(
            pipeline_id="pipe-ig",
            session_id="sess-ig",
            provider="test",
            name="Test IG",
            instagram_url="https://www.instagram.com/real_profile/",
        )

        # In isolation mode, InstagramWorker catches DisallowedEgressError and returns unreachable
        intel = worker.process(candidate)
        self.assertFalse(intel.profile_reachable)
        self.assertEqual(intel.profile_status, "error")


if __name__ == "__main__":
    unittest.main()
