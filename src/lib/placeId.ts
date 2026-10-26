/**
 * src/lib/placeId.ts
 * ==================
 *
 * Canonical Google Maps Place ID normalization and bi-directional conversion.
 * Matches `mast-lead-engine/utils/place_id.py` byte-for-byte in encoding semantics.
 *
 * Google Maps identifiers appear in two forms:
 * 1. Hex feature ID pair: `0x<hex1>:0x<hex2>` (e.g. `0x880fcd7f8fee01b5:0x89b38e817d796008`).
 * 2. Web Place ID token: `ChIJ...` string (27 characters, base64url encoded protobuf).
 *
 * Lowercasing a ChIJ token destroys the base64 case. Therefore, conversion from
 * ChIJ to the hex pair must occur BEFORE lowercasing.
 */

export function chijToHex(chij: string): string | null {
  if (!chij || !chij.startsWith("ChIJ") || chij.length !== 27) return null;
  try {
    const buf = Buffer.from(chij, "base64url");
    if (buf.length !== 20) return null;
    if (buf[0] !== 0x0a || buf[1] !== 0x12 || buf[2] !== 0x09 || buf[11] !== 0x11) return null;
    const v1 = buf.readBigUInt64LE(3);
    const v2 = buf.readBigUInt64LE(12);
    return `0x${v1.toString(16)}:0x${v2.toString(16)}`;
  } catch {
    return null;
  }
}

export function hexToChij(hexPair: string): string | null {
  if (!hexPair) return null;
  const match = hexPair.trim().match(/^0x([0-9a-fA-F]+):0x([0-9a-fA-F]+)$/);
  if (!match) return null;
  try {
    const v1 = BigInt(`0x${match[1]}`);
    const v2 = BigInt(`0x${match[2]}`);
    const buf = Buffer.alloc(20);
    buf[0] = 0x0a;
    buf[1] = 0x12;
    buf[2] = 0x09;
    buf.writeBigUInt64LE(v1, 3);
    buf[11] = 0x11;
    buf.writeBigUInt64LE(v2, 12);
    return buf.toString("base64url");
  } catch {
    return null;
  }
}

export function canonicalPlaceId(pid: string | null | undefined): string {
  if (!pid) return "";
  const clean = pid.trim();
  if (clean.startsWith("ChIJ")) {
    const hex = chijToHex(clean);
    if (hex) return hex;
  }
  const match = clean.match(/^0x([0-9a-fA-F]+):0x([0-9a-fA-F]+)$/);
  if (match) {
    try {
      const v1 = BigInt(`0x${match[1]}`);
      const v2 = BigInt(`0x${match[2]}`);
      return `0x${v1.toString(16)}:0x${v2.toString(16)}`;
    } catch {
      return clean.toLowerCase();
    }
  }
  return clean.toLowerCase();
}

export function expandPlaceIdForms(pid: string | null | undefined): Set<string> {
  const forms = new Set<string>();
  if (!pid) return forms;
  const raw = pid.trim();
  forms.add(raw);
  forms.add(raw.toLowerCase());
  if (raw.startsWith("ChIJ")) {
    const h = chijToHex(raw);
    if (h) {
      forms.add(h);
      forms.add(h.toLowerCase());
    }
  } else if (/^0x[0-9a-fA-F]+:0x[0-9a-fA-F]+$/.test(raw)) {
    const cHex = canonicalPlaceId(raw);
    forms.add(cHex);
    forms.add(cHex.toLowerCase());
    const chij = hexToChij(cHex);
    if (chij) {
      forms.add(chij);
      forms.add(chij.toLowerCase());
    }
  }
  return forms;
}
