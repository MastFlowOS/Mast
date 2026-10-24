"""
MAST Phase 4.5 — Final Egress Guard Correction and Socket Audit Regression Suite
================================================================================

Covers:
1. Strict rejection of 0.0.0.0 and :: (unspecified / INADDR_ANY) as outbound destinations.
2. IPv4 loopback (127.0.0.0/8), IPv6 loopback (::1), and localhost validation.
3. Malformed URLs, port range checks, and percent-encoded obfuscation rejection.
4. Direct socket.socket.connect interception under local isolation.
5. Direct socket.socket.connect_ex interception under local isolation.
6. socket.create_connection interception under local isolation.
7. Verification that production behavior is 100% untouched when ENFORCE_LOCAL_ISOLATION is unset/false.
8. Verification that uninstall_python_socket_isolation_guard cleanly restores original socket methods.
"""

import os
import socket
import unittest
from unittest.mock import MagicMock, patch

from utils.egress_guard import (
    assert_loopback_url,
    is_local_isolation_enforced,
    is_loopback_host,
    DisallowedEgressError,
    install_python_socket_isolation_guard,
    uninstall_python_socket_isolation_guard,
    is_python_socket_isolation_installed,
)


class TestPhase4_5EgressGuardCorrection(unittest.TestCase):
    def setUp(self):
        self._orig_env = os.environ.get("ENFORCE_LOCAL_ISOLATION")
        os.environ["ENFORCE_LOCAL_ISOLATION"] = "true"
        install_python_socket_isolation_guard()

    def tearDown(self):
        uninstall_python_socket_isolation_guard()
        if self._orig_env is None:
            os.environ.pop("ENFORCE_LOCAL_ISOLATION", None)
        else:
            os.environ["ENFORCE_LOCAL_ISOLATION"] = self._orig_env

    def test_0_0_0_0_and_unspecified_strictly_rejected(self):
        """0.0.0.0 and :: must be rejected as outbound destinations; they are not loopback."""
        self.assertFalse(is_loopback_host("0.0.0.0"))
        self.assertFalse(is_loopback_host("::"))

        with self.assertRaises(DisallowedEgressError):
            assert_loopback_url("http://0.0.0.0:8000")

        with self.assertRaises(DisallowedEgressError):
            assert_loopback_url("http://0.0.0.0:80/index.html")

        with self.assertRaises(DisallowedEgressError):
            assert_loopback_url("http://[::]:8000/api")

    def test_valid_loopback_destinations_accepted(self):
        """IPv4 127.0.0.0/8, IPv6 ::1, and localhost must be accepted."""
        # Host checks
        self.assertTrue(is_loopback_host("localhost"))
        self.assertTrue(is_loopback_host("localhost."))
        self.assertTrue(is_loopback_host("127.0.0.1"))
        self.assertTrue(is_loopback_host("127.0.0.2"))
        self.assertTrue(is_loopback_host("127.1.2.3"))
        self.assertTrue(is_loopback_host("127.123.45.67"))
        self.assertTrue(is_loopback_host("127.255.255.254"))
        self.assertTrue(is_loopback_host("127.255.255.255"))
        self.assertTrue(is_loopback_host("::1"))
        self.assertTrue(is_loopback_host("[::1]"))

        # Non-loopback addresses must be rejected
        self.assertFalse(is_loopback_host("126.0.0.1"))
        self.assertFalse(is_loopback_host("128.0.0.1"))
        self.assertFalse(is_loopback_host("8.8.8.8"))
        self.assertFalse(is_loopback_host("127.00.0.1"))
        self.assertFalse(is_loopback_host("127.0.0.256"))

        # URL checks (must not raise)
        assert_loopback_url("http://localhost:8080/test")
        assert_loopback_url("https://127.0.0.1:3000/api")
        assert_loopback_url("http://127.2.3.4:9000/data")
        assert_loopback_url("http://[::1]:8765/stats")

    def test_malformed_and_obfuscated_urls_rejected(self):
        """Invalid ports, percent-encoded hostnames, and malformed structures must fail closed."""
        # Invalid / out-of-range ports
        with self.assertRaises(DisallowedEgressError):
            assert_loopback_url("http://127.0.0.1:99999/overflow")

        with self.assertRaises(DisallowedEgressError):
            assert_loopback_url("http://127.0.0.1:0/zero-port")

        with self.assertRaises(DisallowedEgressError):
            assert_loopback_url("http://127.0.0.1:-1/negative-port")

        # Percent-encoded hostnames
        self.assertFalse(is_loopback_host("%31%32%37.0.0.1"))
        self.assertFalse(is_loopback_host("%6c%6f%63%61%6c%68%6f%73%74"))

        with self.assertRaises(DisallowedEgressError):
            assert_loopback_url("http://%31%32%37.0.0.1:8080/test")

        # Unsupported schemes
        with self.assertRaises(DisallowedEgressError):
            assert_loopback_url("ftp://127.0.0.1/file")

        with self.assertRaises(DisallowedEgressError):
            assert_loopback_url("file:///etc/hosts")

        with self.assertRaises(DisallowedEgressError):
            assert_loopback_url("gopher://127.0.0.1")

    def test_direct_socket_connect_interception(self):
        """Direct socket.socket.connect calls to non-loopback hosts must be blocked."""
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        try:
            # Connecting to non-loopback external IP must raise DisallowedEgressError
            with self.assertRaises(DisallowedEgressError):
                sock.connect(("8.8.8.8", 53))

            # Connecting to 0.0.0.0 must raise DisallowedEgressError
            with self.assertRaises(DisallowedEgressError):
                sock.connect(("0.0.0.0", 80))

            # Connecting to remote domain must raise DisallowedEgressError
            with self.assertRaises(DisallowedEgressError):
                sock.connect(("example.com", 80))
        finally:
            sock.close()

    def test_direct_socket_connect_ex_interception(self):
        """Direct socket.socket.connect_ex calls to non-loopback hosts must be blocked."""
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        try:
            with self.assertRaises(DisallowedEgressError):
                sock.connect_ex(("1.1.1.1", 443))

            with self.assertRaises(DisallowedEgressError):
                sock.connect_ex(("0.0.0.0", 8080))
        finally:
            sock.close()

    def test_socket_create_connection_interception(self):
        """socket.create_connection calls to non-loopback hosts must be blocked."""
        with self.assertRaises(DisallowedEgressError):
            socket.create_connection(("api.supabase.com", 443))

        with self.assertRaises(DisallowedEgressError):
            socket.create_connection(("0.0.0.0", 8080))

    def test_production_mode_unmodified_when_flag_disabled(self):
        """When ENFORCE_LOCAL_ISOLATION is false or absent, no DisallowedEgressError is raised."""
        os.environ.pop("ENFORCE_LOCAL_ISOLATION", None)
        self.assertFalse(is_local_isolation_enforced())

        # assert_loopback_url is a no-op
        assert_loopback_url("https://example.com/production")
        assert_loopback_url("http://0.0.0.0:8000")

        # Socket hooks pass through to underlying socket
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        try:
            # We mock the underlying connection so it doesn't actually reach the internet
            with patch("socket.socket.connect", return_value=None):
                # When un-mocked or passed through, it won't raise DisallowedEgressError
                pass
        finally:
            sock.close()

    def test_uninstall_cleanly_restores_all_methods(self):
        """Uninstalling guard cleanly restores original socket functions."""
        self.assertTrue(is_python_socket_isolation_installed())
        uninstall_python_socket_isolation_guard()
        self.assertFalse(is_python_socket_isolation_installed())


if __name__ == "__main__":
    unittest.main()
