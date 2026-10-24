"""
MAST Phase 4.4 — Python-Side Egress Restrictions for Local Isolation Mode
========================================================================

When ENFORCE_LOCAL_ISOLATION=true, this module enforces strict loopback-only
destinations for all outbound network requests across Engine 2.0 enrichment
workers (WebsiteWorker, ContactWorker, InstagramWorker).

Features:
- Validates initial target URLs (must be http/https on localhost/127.0.0.1/::1/0.0.0.0).
- Intercepts all redirect hops via LocalIsolationRedirectHandler (blocks redirects to external hosts).
- Intercepts contact page links discovered from HTML before fetching.
- Intercepts raw socket connections via socket.create_connection hook (defense-in-depth).
- Treats malformed URLs, unexpected schemes, and ambiguous hosts as failures closed.
- 100% opt-in: zero changes to normal production behavior when ENFORCE_LOCAL_ISOLATION is unset/false.
"""

from __future__ import annotations

import ipaddress
import os
import socket
import urllib.error
import urllib.parse
import urllib.request
from typing import Optional


class DisallowedEgressError(urllib.error.URLError):
    """Raised when an outbound network request targets a non-loopback destination in isolation mode."""

    def __init__(self, target: str, reason: str = "Outbound egress to non-loopback destination blocked in local isolation mode"):
        super().__init__(reason)
        self.target = target
        self.reason = reason

    def __str__(self) -> str:
        return f"[ISOLATION_EGRESS_BLOCKED] {self.reason}: {self.target}"


def is_local_isolation_enforced() -> bool:
    """True if local isolation mode is explicitly enabled via environment variable."""
    return os.environ.get("ENFORCE_LOCAL_ISOLATION", "").strip().lower() == "true"


def is_loopback_host(hostname: Optional[str]) -> bool:
    """
    Returns True only if the hostname is strictly a local loopback address:
    - 'localhost' (or 'localhost.')
    - '127.0.0.1' or any address in 127.0.0.0/8
    - '::1'

    Strictly rejects:
    - '0.0.0.0' or '::' (unspecified address / INADDR_ANY, NOT loopback)
    - Domain names, external IPs, ambiguous strings, or empty values.
    - Percent-encoded characters in hostnames.
    """
    if not hostname:
        return False

    clean = hostname.strip().lower().strip("[]").rstrip(".")
    if not clean:
        return False

    # Reject percent-encoded hostnames to prevent obfuscation attacks
    if "%" in clean:
        return False

    # Explicitly reject unspecified address (0.0.0.0 or ::) - not loopback
    if clean in ("0.0.0.0", "::"):
        return False

    if clean == "localhost":
        return True

    try:
        ip = ipaddress.ip_address(clean)
        # ip.is_loopback is True for 127.0.0.0/8 and ::1; False for 0.0.0.0 and ::
        return ip.is_loopback
    except ValueError:
        # Not a valid IP literal; domain names (e.g. 'google.com', 'localhost.evil.com') return False
        return False


def assert_loopback_url(url: Optional[str]) -> None:
    """
    Asserts that a given URL strictly targets a loopback destination.
    Raises DisallowedEgressError if isolation is enforced and target is non-loopback,
    malformed, or has an unsupported scheme.
    """
    if not is_local_isolation_enforced():
        return

    if not url or not isinstance(url, str) or not url.strip():
        raise DisallowedEgressError(str(url), "Empty or non-string URL in isolation mode")

    cleaned = url.strip()

    try:
        parsed = urllib.parse.urlsplit(cleaned)
    except Exception as exc:
        raise DisallowedEgressError(cleaned, f"Malformed URL: {exc}") from exc

    scheme = (parsed.scheme or "").lower()
    if scheme not in ("http", "https"):
        raise DisallowedEgressError(cleaned, f"Prohibited URL scheme '{scheme}'; only http/https allowed")

    # Validate port if present
    try:
        port = parsed.port
    except ValueError as exc:
        raise DisallowedEgressError(cleaned, f"Invalid port in URL: {exc}") from exc

    if port is not None and (port < 1 or port > 65535):
        raise DisallowedEgressError(cleaned, f"Port {port} out of valid range (1-65535)")

    hostname = parsed.hostname
    if not hostname:
        raise DisallowedEgressError(cleaned, "Missing hostname in URL")

    if not is_loopback_host(hostname):
        raise DisallowedEgressError(cleaned, f"Prohibited non-loopback host '{hostname}' in local isolation mode")


class LocalIsolationRedirectHandler(urllib.request.HTTPRedirectHandler):
    """
    Redirect handler that validates every redirect hop against loopback destinations.
    Prevents local mock endpoints from escaping to external servers via HTTP 3xx responses.
    """

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        if is_local_isolation_enforced():
            assert_loopback_url(newurl)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


_orig_create_connection = None
_orig_socket_connect = None
_orig_socket_connect_ex = None


def _check_socket_target(sock, address) -> None:
    """Validates destination address for socket connections under local isolation mode."""
    if not is_local_isolation_enforced():
        return
    family = getattr(sock, "family", None)
    if family in (socket.AF_INET, socket.AF_INET6):
        host = address[0] if isinstance(address, (tuple, list)) and len(address) > 0 else None
        if not is_loopback_host(host):
            raise DisallowedEgressError(
                str(host),
                f"Outbound TCP socket connection to non-loopback host '{host}' blocked by Python socket isolation guard",
            )


def install_python_socket_isolation_guard() -> None:
    """
    Installs socket interception hooks to block non-loopback outbound connections in isolation mode.
    Hooks:
    - socket.create_connection (used by urllib, http.client, urllib3)
    - socket.socket.connect (used by direct TCP clients)
    - socket.socket.connect_ex (used by non-blocking / probing clients)

    Note: This is application-level standard library interception. Native C extensions or external
    subprocesses (e.g., Chromium / Playwright) bypass Python monkey-patches and require OS-level isolation.
    """
    global _orig_create_connection, _orig_socket_connect, _orig_socket_connect_ex
    if _orig_create_connection is not None:
        return

    _orig_create_connection = socket.create_connection
    _orig_socket_connect = socket.socket.connect
    _orig_socket_connect_ex = socket.socket.connect_ex

    def _safe_create_connection(address, *args, **kwargs):
        if is_local_isolation_enforced():
            host = address[0] if isinstance(address, (tuple, list)) and len(address) > 0 else None
            if not is_loopback_host(host):
                raise DisallowedEgressError(
                    str(host),
                    f"Outbound TCP connection to non-loopback host '{host}' blocked by Python socket isolation guard",
                )
        return _orig_create_connection(address, *args, **kwargs)

    def _safe_connect(self, address):
        _check_socket_target(self, address)
        return _orig_socket_connect(self, address)

    def _safe_connect_ex(self, address):
        _check_socket_target(self, address)
        return _orig_socket_connect_ex(self, address)

    socket.create_connection = _safe_create_connection
    socket.socket.connect = _safe_connect
    socket.socket.connect_ex = _safe_connect_ex


def uninstall_python_socket_isolation_guard() -> None:
    """Restores all original socket functions."""
    global _orig_create_connection, _orig_socket_connect, _orig_socket_connect_ex
    if _orig_create_connection is not None:
        socket.create_connection = _orig_create_connection
        _orig_create_connection = None
    if _orig_socket_connect is not None:
        socket.socket.connect = _orig_socket_connect
        _orig_socket_connect = None
    if _orig_socket_connect_ex is not None:
        socket.socket.connect_ex = _orig_socket_connect_ex
        _orig_socket_connect_ex = None


def is_python_socket_isolation_installed() -> bool:
    """True if socket isolation hooks are currently active."""
    return _orig_create_connection is not None
