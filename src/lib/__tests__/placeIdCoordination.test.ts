import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  validateCoordinationPlaceId,
  isValidCoordinationPlaceId,
  canonicalPlaceId,
  chijToHex,
  hexToChij,
  expandPlaceIdForms,
} from "../placeId.js";

const VERIFIED_PAIRS = [
  { name: "Café Calidá", hexPair: "0x880fcd7f8fee01b5:0x89b38e817d796008", chij: "ChIJtQHuj3_ND4gRCGB5fYGOs4k" },
  { name: "Two Mile", hexPair: "0x880e25d2309d7c1d:0xb7d6f52d9e2cd16", chij: "ChIJHXydMNIlDogRFs3i2VJvfQs" },
  { name: "Mate & Company", hexPair: "0x880fcd00123c18d3:0xb0dee2bb5ebf8429", chij: "ChIJ0xg8EgDND4gRKYS_Xrvi3rA" },
  { name: "LVL UP", hexPair: "0x880e2d8be7e51999:0x67a9389ccd491477", chij: "ChIJmRnl54stDogRdxRJzZw4qWc" },
  { name: "Pedestrian Coffee", hexPair: "0x880fd37e809c62a5:0xa3c8126d20326228", chij: "ChIJpWKcgH7TD4gRKGIyIG0SyKM" },
];

describe("Strict Coordination Place ID Validator (Gate 1)", () => {
  describe("1. Valid ChIJ tokens", () => {
    for (const pair of VERIFIED_PAIRS) {
      it(`validates and canonicalizes verified ChIJ: ${pair.name}`, () => {
        const res = validateCoordinationPlaceId(pair.chij);
        assert.equal(res.valid, true);
        assert.equal(res.status, "VALID");
        if (res.valid) {
          assert.equal(res.canonicalId, pair.hexPair);
          assert.equal(res.originalType, "chij");
        }
        assert.equal(isValidCoordinationPlaceId(res), true);
      });
    }

    it("accepts ChIJ with leading and trailing whitespace by trimming", () => {
      const res = validateCoordinationPlaceId("  ChIJtQHuj3_ND4gRCGB5fYGOs4k  \n");
      assert.equal(res.valid, true);
      assert.equal(res.status, "VALID");
      if (res.valid) {
        assert.equal(res.canonicalId, "0x880fcd7f8fee01b5:0x89b38e817d796008");
      }
    });
  });

  describe("2. Invalid ChIJ format, length, and characters", () => {
    it("rejects ChIJ with length < 27 characters", () => {
      const res = validateCoordinationPlaceId("ChIJshort");
      assert.equal(res.valid, false);
      assert.equal(res.status, "MALFORMED");
      if (!res.valid && res.status === "MALFORMED") {
        assert.match(res.reason, /length must be exactly 27 characters/);
      }
    });

    it("rejects ChIJ with length > 27 characters", () => {
      const res = validateCoordinationPlaceId("ChIJtQHuj3_ND4gRCGB5fYGOs4kEXTRA");
      assert.equal(res.valid, false);
      assert.equal(res.status, "MALFORMED");
      if (!res.valid && res.status === "MALFORMED") {
        assert.match(res.reason, /length must be exactly 27 characters/);
      }
    });

    it("rejects ChIJ containing non-Base64URL characters (e.g. +, /, =)", () => {
      // Replace valid base64url char with standard base64 '+'
      const withPlus = "ChIJtQHuj3+ND4gRCGB5fYGOs4k";
      const resPlus = validateCoordinationPlaceId(withPlus);
      assert.equal(resPlus.valid, false);
      assert.equal(resPlus.status, "MALFORMED");
      if (!resPlus.valid && resPlus.status === "MALFORMED") {
        assert.match(resPlus.reason, /invalid Base64URL characters/);
      }

      // With slash
      const withSlash = "ChIJtQHuj3/ND4gRCGB5fYGOs4k";
      const resSlash = validateCoordinationPlaceId(withSlash);
      assert.equal(resSlash.valid, false);
      assert.equal(resSlash.status, "MALFORMED");

      // With padding '='
      const withEquals = "ChIJtQHuj3_ND4gRCGB5fYGOs4=";
      const resEquals = validateCoordinationPlaceId(withEquals);
      assert.equal(resEquals.valid, false);
      assert.equal(resEquals.status, "MALFORMED");
    });

    it("rejects ChIJ with invalid protobuf field wire headers", () => {
      // Build a 20-byte buffer that starts with valid ChIJ bytes (0x0a, 0x12, 0x09)
      // but has byte 11 corrupted (expected 0x11 for field 2 fixed64)
      const buf = Buffer.alloc(20);
      buf[0] = 0x0a;
      buf[1] = 0x12;
      buf[2] = 0x09;
      buf.writeBigUInt64LE(12345n, 3);
      buf[11] = 0x99; // Corrupted byte 11 (expected 0x11)
      buf.writeBigUInt64LE(67890n, 12);

      const corruptedChij = buf.toString("base64url");
      assert.equal(corruptedChij.startsWith("ChIJ"), true);
      assert.equal(corruptedChij.length, 27);

      const res = validateCoordinationPlaceId(corruptedChij);
      assert.equal(res.valid, false);
      assert.equal(res.status, "MALFORMED");
      if (!res.valid && res.status === "MALFORMED") {
        assert.match(res.reason, /protobuf wire headers/);
      }
    });

    it("rejects ChIJ containing zero component (v1 === 0 or v2 === 0)", () => {
      const buf = Buffer.alloc(20);
      buf[0] = 0x0a;
      buf[1] = 0x12;
      buf[2] = 0x09;
      buf.writeBigUInt64LE(0n, 3); // v1 is 0
      buf[11] = 0x11;
      buf.writeBigUInt64LE(12345n, 12);
      const chijWithZero = buf.toString("base64url");
      const res = validateCoordinationPlaceId(chijWithZero);
      assert.equal(res.valid, false);
      assert.equal(res.status, "MALFORMED");
      if (!res.valid && res.status === "MALFORMED") {
        assert.match(res.reason, /zero feature ID component/);
      }
    });
  });

  describe("3. Valid hexadecimal feature ID pairs", () => {
    for (const pair of VERIFIED_PAIRS) {
      it(`validates verified hex pair: ${pair.name}`, () => {
        const res = validateCoordinationPlaceId(pair.hexPair);
        assert.equal(res.valid, true);
        assert.equal(res.status, "VALID");
        if (res.valid) {
          assert.equal(res.canonicalId, pair.hexPair);
          assert.equal(res.originalType, "hex");
        }
      });
    }

    it("canonicalizes uppercase 0X and uppercase hex digits to lowercase", () => {
      const uppercase = "0X880FCD7F8FEE01B5:0X89B38E817D796008";
      const res = validateCoordinationPlaceId(uppercase);
      assert.equal(res.valid, true);
      assert.equal(res.status, "VALID");
      if (res.valid) {
        assert.equal(res.canonicalId, "0x880fcd7f8fee01b5:0x89b38e817d796008");
      }
    });

    it("canonicalizes leading zeros in hex components", () => {
      // 0x0001:0x0002 has 4 hex digits each (<= 16 digits), canonicalizes to 0x1:0x2
      const res = validateCoordinationPlaceId("0x0001:0x0002");
      assert.equal(res.valid, true);
      assert.equal(res.status, "VALID");
      if (res.valid) {
        assert.equal(res.canonicalId, "0x1:0x2");
      }

      // Leading zero on 15-digit component
      const res15 = validateCoordinationPlaceId("0x880e25d2309d7c1d:0x0b7d6f52d9e2cd16");
      assert.equal(res15.valid, true);
      assert.equal(res15.status, "VALID");
      if (res15.valid) {
        assert.equal(res15.canonicalId, "0x880e25d2309d7c1d:0xb7d6f52d9e2cd16");
      }
    });

    it("proves equivalence between ChIJ and Hex pair canonical representations", () => {
      for (const pair of VERIFIED_PAIRS) {
        const resChij = validateCoordinationPlaceId(pair.chij);
        const resHex = validateCoordinationPlaceId(pair.hexPair);
        assert.equal(resChij.valid, true);
        assert.equal(resHex.valid, true);
        if (resChij.valid && resHex.valid) {
          assert.equal(resChij.canonicalId, resHex.canonicalId);
        }
      }
    });
  });

  describe("4. Invalid and out-of-bounds hexadecimal components", () => {
    it("rejects hex component exceeding 16 digits (oversized uint64)", () => {
      const oversized = "0x10000000000000000:0x89b38e817d796008"; // 17 digits
      const res = validateCoordinationPlaceId(oversized);
      assert.equal(res.valid, false);
      assert.equal(res.status, "MALFORMED");
      if (!res.valid && res.status === "MALFORMED") {
        assert.match(res.reason, /1 to 16 hex digits/);
      }
    });

    it("rejects empty hex components like 0x:0x1", () => {
      const res = validateCoordinationPlaceId("0x:0x89b38e817d796008");
      assert.equal(res.valid, false);
      assert.equal(res.status, "MALFORMED");
    });

    it("rejects zero hex components", () => {
      const resBothZero = validateCoordinationPlaceId("0x0:0x0");
      assert.equal(resBothZero.valid, false);
      assert.equal(resBothZero.status, "MALFORMED");
      if (!resBothZero.valid && resBothZero.status === "MALFORMED") {
        assert.match(resBothZero.reason, /cannot be zero/);
      }

      const resFirstZero = validateCoordinationPlaceId("0x0:0x89b38e817d796008");
      assert.equal(resFirstZero.valid, false);
      assert.equal(resFirstZero.status, "MALFORMED");

      const resSecondZero = validateCoordinationPlaceId("0x880fcd7f8fee01b5:0x0");
      assert.equal(resSecondZero.valid, false);
      assert.equal(resSecondZero.status, "MALFORMED");
    });

    it("rejects non-hex characters in components", () => {
      const res = validateCoordinationPlaceId("0xZZZZ:0x1234");
      assert.equal(res.valid, false);
      assert.equal(res.status, "MALFORMED");
    });
  });

  describe("5. Missing value classification", () => {
    it("classifies null as MISSING", () => {
      const res = validateCoordinationPlaceId(null);
      assert.equal(res.valid, false);
      assert.equal(res.status, "MISSING");
      if (!res.valid && res.status === "MISSING") {
        assert.equal(res.reason, "null_or_undefined");
      }
    });

    it("classifies undefined as MISSING", () => {
      const res = validateCoordinationPlaceId(undefined);
      assert.equal(res.valid, false);
      assert.equal(res.status, "MISSING");
      if (!res.valid && res.status === "MISSING") {
        assert.equal(res.reason, "null_or_undefined");
      }
    });

    it("classifies empty string as MISSING", () => {
      const res = validateCoordinationPlaceId("");
      assert.equal(res.valid, false);
      assert.equal(res.status, "MISSING");
      if (!res.valid && res.status === "MISSING") {
        assert.equal(res.reason, "empty_or_whitespace");
      }
    });

    it("classifies whitespace-only string as MISSING", () => {
      const res = validateCoordinationPlaceId("   \t  \n  ");
      assert.equal(res.valid, false);
      assert.equal(res.status, "MISSING");
      if (!res.valid && res.status === "MISSING") {
        assert.equal(res.reason, "empty_or_whitespace");
      }
    });
  });

  describe("6. Non-string runtime inputs classified as MALFORMED", () => {
    it("classifies number as MALFORMED (never missing)", () => {
      const res = validateCoordinationPlaceId(12345);
      assert.equal(res.valid, false);
      assert.equal(res.status, "MALFORMED");
      if (!res.valid && res.status === "MALFORMED") {
        assert.match(res.reason, /Expected string, received number/);
      }
    });

    it("classifies boolean as MALFORMED (never missing)", () => {
      const resTrue = validateCoordinationPlaceId(true);
      assert.equal(resTrue.valid, false);
      assert.equal(resTrue.status, "MALFORMED");

      const resFalse = validateCoordinationPlaceId(false);
      assert.equal(resFalse.valid, false);
      assert.equal(resFalse.status, "MALFORMED");
    });

    it("classifies object and array as MALFORMED", () => {
      const resObj = validateCoordinationPlaceId({ place_id: "ChIJtQHuj3_ND4gRCGB5fYGOs4k" });
      assert.equal(resObj.valid, false);
      assert.equal(resObj.status, "MALFORMED");

      const resArr = validateCoordinationPlaceId(["ChIJtQHuj3_ND4gRCGB5fYGOs4k"]);
      assert.equal(resArr.valid, false);
      assert.equal(resArr.status, "MALFORMED");
    });

    it("classifies symbol, bigint, and function as MALFORMED", () => {
      const resSym = validateCoordinationPlaceId(Symbol("pid"));
      assert.equal(resSym.valid, false);
      assert.equal(resSym.status, "MALFORMED");

      const resBig = validateCoordinationPlaceId(123456789n);
      assert.equal(resBig.valid, false);
      assert.equal(resBig.status, "MALFORMED");

      const resFn = validateCoordinationPlaceId(() => "ChIJtQHuj3_ND4gRCGB5fYGOs4k");
      assert.equal(resFn.valid, false);
      assert.equal(resFn.status, "MALFORMED");
    });
  });

  describe("7. Malformed non-empty string inputs", () => {
    it("classifies arbitrary non-Place-ID strings as MALFORMED (never missing)", () => {
      const malformedCases = [
        "not_a_place_id",
        "https://maps.google.com/?cid=123",
        "place:12345",
        "0x123",
        "0x123:0x456:0x789",
        "undefined",
        "null",
      ];

      for (const val of malformedCases) {
        const res = validateCoordinationPlaceId(val);
        assert.equal(res.valid, false, `Expected ${val} to be invalid`);
        assert.equal(res.status, "MALFORMED", `Expected ${val} to be MALFORMED`);
      }
    });
  });

  describe("8. Legacy normalizer regression preservation", () => {
    it("canonicalPlaceId preserves permissive fallback for non-Place-ID strings", () => {
      // Legacy behavior: non-hex, non-ChIJ strings are returned lowercased
      assert.equal(canonicalPlaceId("Legacy_Unstructured_Token"), "legacy_unstructured_token");
      assert.equal(canonicalPlaceId(""), "");
      assert.equal(canonicalPlaceId(null), "");
      assert.equal(canonicalPlaceId(undefined), "");
    });

    it("canonicalPlaceId continues normalizing valid hex and ChIJ tokens", () => {
      for (const pair of VERIFIED_PAIRS) {
        assert.equal(canonicalPlaceId(pair.chij), pair.hexPair);
        assert.equal(canonicalPlaceId(pair.hexPair), pair.hexPair);
        assert.equal(canonicalPlaceId(pair.hexPair.toUpperCase()), pair.hexPair);
      }
    });

    it("expandPlaceIdForms preserves exact behavior", () => {
      for (const pair of VERIFIED_PAIRS) {
        const fromChij = expandPlaceIdForms(pair.chij);
        assert.ok(fromChij.has(pair.hexPair));
        assert.ok(fromChij.has(pair.chij));
        assert.ok(fromChij.has(pair.hexPair.toLowerCase()));

        const fromHex = expandPlaceIdForms(pair.hexPair);
        assert.ok(fromHex.has(pair.hexPair));
        assert.ok(fromHex.has(pair.chij));
      }
    });

    it("chijToHex and hexToChij continue operating identically", () => {
      assert.equal(chijToHex(""), null);
      assert.equal(chijToHex("invalid"), null);
      assert.equal(hexToChij("not-hex"), null);
    });
  });
});
