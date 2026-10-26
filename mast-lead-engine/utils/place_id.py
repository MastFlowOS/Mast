"""
utils/place_id.py
=================

Canonical Google Maps Place ID normalization and bi-directional conversion.

Google Maps identifies places using two representations:
1. Hex feature ID pair: `0x<hex1>:0x<hex2>` (e.g. `0x880fcd7f8fee01b5:0x89b38e817d796008`).
2. Web Place ID token: `ChIJ...` string (27 characters, base64url encoded protobuf).

Protobuf wire layout of `ChIJ...`:
- Byte 0-2: `0x0a 0x12 0x09` (Field 1: length-delimited, length 18 = 0x12, Field 1: fixed64 = 0x09)
- Byte 3-10: 64-bit integer 1 in little-endian
- Byte 11: `0x11` (Field 2: fixed64)
- Byte 12-19: 64-bit integer 2 in little-endian
Total: 20 bytes -> base64url encoded to 27 ASCII characters.

Lowercasing a ChIJ token destroys the base64 case. Therefore, conversion from
ChIJ to the hex pair must occur BEFORE lowercasing.
"""

from __future__ import annotations

import base64
import re
import struct
from typing import Optional, Set

_HEX_PAIR_RE = re.compile(r"^0x([0-9a-fA-F]+):0x([0-9a-fA-F]+)$")
_CHIJ_RE = re.compile(r"^ChIJ[a-zA-Z0-9_-]{23}$")


def chij_to_hex(chij: str) -> Optional[str]:
    """Convert a base64url-encoded 'ChIJ...' Google place ID to a canonical hex pair.

    Returns string formatted as '0x{v1:x}:0x{v2:x}' or None if invalid.
    """
    if not chij or not chij.startswith("ChIJ"):
        return None
    raw_str = chij.strip()
    if len(raw_str) != 27:
        return None
    try:
        pad = "=" * ((4 - len(raw_str) % 4) % 4)
        buf = base64.urlsafe_b64decode(raw_str + pad)
        if len(buf) != 20:
            return None
        if buf[:3] != b"\x0a\x12\x09" or buf[11:12] != b"\x11":
            return None
        v1 = struct.unpack("<Q", buf[3:11])[0]
        v2 = struct.unpack("<Q", buf[12:20])[0]
        return f"0x{v1:x}:0x{v2:x}"
    except Exception:
        return None


def hex_to_chij(hex_pair: str) -> Optional[str]:
    """Convert a hex pair '0x...:0x...' to a 'ChIJ...' Google place ID.

    Returns the 27-character base64url string or None if invalid.
    """
    if not hex_pair:
        return None
    m = _HEX_PAIR_RE.match(hex_pair.strip())
    if not m:
        return None
    try:
        v1 = int(m.group(1), 16)
        v2 = int(m.group(2), 16)
        buf = b"\x0a\x12\x09" + struct.pack("<Q", v1) + b"\x11" + struct.pack("<Q", v2)
        return base64.urlsafe_b64encode(buf).decode("ascii").rstrip("=")
    except Exception:
        return None


def canonical_place_id(pid: str | None) -> str:
    """Return the canonical hex pair representation if convertible, or clean string."""
    if not pid:
        return ""
    clean = pid.strip()
    # Check ChIJ format (must preserve case for base64 decoding)
    if clean.startswith("ChIJ"):
        converted = chij_to_hex(clean)
        if converted:
            return converted
    # Check hex pair format
    m = _HEX_PAIR_RE.match(clean)
    if m:
        try:
            v1 = int(m.group(1), 16)
            v2 = int(m.group(2), 16)
            return f"0x{v1:x}:0x{v2:x}"
        except Exception:
            return clean.lower()
    return clean.lower()


def expand_place_id_forms(pid: str | None) -> Set[str]:
    """Return all equivalent representations of a place ID (hex pair, ChIJ, and lowercase).

    This enables resilient O(1) membership testing across URL variants.
    """
    if not pid:
        return set()
    raw = pid.strip()
    forms: Set[str] = {raw, raw.lower()}

    if raw.startswith("ChIJ"):
        h = chij_to_hex(raw)
        if h:
            forms.add(h)
            forms.add(h.lower())
    else:
        m = _HEX_PAIR_RE.match(raw)
        if m:
            c_hex = canonical_place_id(raw)
            forms.add(c_hex)
            chij = hex_to_chij(c_hex)
            if chij:
                forms.add(chij)
                forms.add(chij.lower())

    return forms
