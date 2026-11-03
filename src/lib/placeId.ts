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

const HEX_PAIR_RE = /^0x([0-9a-fA-F]+):0x([0-9a-fA-F]+)$/;
const HEX_PAIR_ANY_CASE_RE = /^0[xX]([0-9a-fA-F]+):0[xX]([0-9a-fA-F]+)$/;
const HEX_PAIR_TEST_RE = /^0x[0-9a-fA-F]+:0x[0-9a-fA-F]+$/;

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
  const match = hexPair.trim().match(HEX_PAIR_RE);
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
  const match = clean.match(HEX_PAIR_RE);
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
  } else if (HEX_PAIR_TEST_RE.test(raw)) {
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

/**
 * ============================================================================
 * MAST Phase 7.3: Strict Coordination Place ID Validator
 * ============================================================================
 *
 * Dedicated validator for cross-scout deduplication and dynamic IPC coordination.
 * Enforces strict typing, binary protobuf wire verification, 64-bit bounds, and
 * three-way runtime classification (VALID, MISSING, MALFORMED).
 *
 * Does NOT alter or replace permissive legacy normalizers (canonicalPlaceId, expandPlaceIdForms).
 */

export type CoordinationPlaceIdResult =
  | {
      valid: true;
      status: "VALID";
      canonicalId: string;
      originalType: "chij" | "hex";
    }
  | {
      valid: false;
      status: "MISSING";
      reason: "null_or_undefined" | "empty_or_whitespace";
    }
  | {
      valid: false;
      status: "MALFORMED";
      reason: string;
    };

const STRICT_CHIJ_CHARSET = /^[a-zA-Z0-9_-]{23}$/;
const STRICT_HEX_COMPONENT = /^[0-9a-fA-F]{1,16}$/;
const MAX_UINT64 = 0xFFFFFFFFFFFFFFFFn;

/**
 * Validates a candidate Place ID strictly for coordination purposes.
 *
 * Guaranteed invariants:
 * 1. Never throws on any runtime input type.
 * 2. Discriminated union guarantees callers cannot confuse missing with malformed.
 * 3. Canonical representation is always formatted as `0x<hex1>:0x<hex2>` (lowercase, no unnecessary leading zeros).
 * 4. Validates protobuf wire layout and 64-bit bounds.
 * 5. Rejects zero components (`0x0`).
 */
export function validateCoordinationPlaceId(raw: unknown): CoordinationPlaceIdResult {
  if (raw === null || raw === undefined) {
    return { valid: false, status: "MISSING", reason: "null_or_undefined" };
  }

  if (typeof raw !== "string") {
    return {
      valid: false,
      status: "MALFORMED",
      reason: `Expected string, received ${typeof raw}`,
    };
  }

  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return { valid: false, status: "MISSING", reason: "empty_or_whitespace" };
  }

  // 1. ChIJ Token Validation
  if (trimmed.startsWith("ChIJ")) {
    if (trimmed.length !== 27) {
      return {
        valid: false,
        status: "MALFORMED",
        reason: `ChIJ token length must be exactly 27 characters (got ${trimmed.length})`,
      };
    }

    const payload = trimmed.slice(4);
    if (!STRICT_CHIJ_CHARSET.test(payload)) {
      return {
        valid: false,
        status: "MALFORMED",
        reason: "ChIJ token contains invalid Base64URL characters",
      };
    }

    try {
      const buf = Buffer.from(trimmed, "base64url");
      if (buf.length !== 20) {
        return {
          valid: false,
          status: "MALFORMED",
          reason: `Decoded ChIJ buffer length must be 20 bytes (got ${buf.length})`,
        };
      }

      // Protobuf wire layout:
      // Byte 0-2: 0x0a 0x12 0x09 (Field 1: length-delimited, length 18, Field 1: fixed64)
      // Byte 11: 0x11 (Field 2: fixed64)
      if (buf[0] !== 0x0a || buf[1] !== 0x12 || buf[2] !== 0x09 || buf[11] !== 0x11) {
        return {
          valid: false,
          status: "MALFORMED",
          reason: "Invalid protobuf wire headers in ChIJ token",
        };
      }

      const v1 = buf.readBigUInt64LE(3);
      const v2 = buf.readBigUInt64LE(12);

      if (v1 === 0n || v2 === 0n) {
        return {
          valid: false,
          status: "MALFORMED",
          reason: "ChIJ token contains zero feature ID component",
        };
      }

      const canonicalId = `0x${v1.toString(16)}:0x${v2.toString(16)}`;
      return {
        valid: true,
        status: "VALID",
        canonicalId,
        originalType: "chij",
      };
    } catch (err) {
      return {
        valid: false,
        status: "MALFORMED",
        reason: `Base64URL decode failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  // 2. Hexadecimal Feature ID Pair Validation
  const hexMatch = trimmed.match(HEX_PAIR_ANY_CASE_RE);
  if (hexMatch) {
    const rawH1 = hexMatch[1];
    const rawH2 = hexMatch[2];

    if (!STRICT_HEX_COMPONENT.test(rawH1) || !STRICT_HEX_COMPONENT.test(rawH2)) {
      return {
        valid: false,
        status: "MALFORMED",
        reason: "Hexadecimal feature ID components must each contain 1 to 16 hex digits",
      };
    }

    try {
      const v1 = BigInt(`0x${rawH1}`);
      const v2 = BigInt(`0x${rawH2}`);

      if (v1 < 0n || v1 > MAX_UINT64 || v2 < 0n || v2 > MAX_UINT64) {
        return {
          valid: false,
          status: "MALFORMED",
          reason: "Hexadecimal feature ID component exceeds unsigned 64-bit bounds",
        };
      }

      if (v1 === 0n || v2 === 0n) {
        return {
          valid: false,
          status: "MALFORMED",
          reason: "Hexadecimal feature ID component cannot be zero",
        };
      }

      const canonicalId = `0x${v1.toString(16)}:0x${v2.toString(16)}`;
      return {
        valid: true,
        status: "VALID",
        canonicalId,
        originalType: "hex",
      };
    } catch {
      return {
        valid: false,
        status: "MALFORMED",
        reason: "Failed to parse hexadecimal feature ID as 64-bit integer",
      };
    }
  }

  return {
    valid: false,
    status: "MALFORMED",
    reason: "Input does not match supported Google Maps Place ID formats (ChIJ... or 0x...:0x...)",
  };
}

/**
 * Type guard for valid coordination Place ID results.
 */
export function isValidCoordinationPlaceId(
  res: CoordinationPlaceIdResult
): res is CoordinationPlaceIdResult & { valid: true; status: "VALID" } {
  return res.valid === true;
}
