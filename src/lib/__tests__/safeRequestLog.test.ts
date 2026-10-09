import assert from "node:assert/strict";
import test from "node:test";

import {
  redactSensitiveData,
  redactSensitiveHeaders,
  sanitizeRequestUrl,
} from "../safeRequestLog.js";

test("redacts authorization and cookie headers case-insensitively", () => {
  const result = redactSensitiveHeaders({
    Authorization: "Bearer secret-access-token",
    cookie: "session=private",
    "X-API-Key": "private-api-key",
    "content-type": "application/json",
  });

  assert.equal(result.Authorization, "[Redacted]");
  assert.equal(result.cookie, "[Redacted]");
  assert.equal(result["X-API-Key"], "[Redacted]");
  assert.equal(result["content-type"], "application/json");
});

test("redacts nested credentials and bearer/JWT strings in error payloads", () => {
  const result = redactSensitiveData({
    message: "request failed with Bearer super-secret-token",
    request: {
      headers: {
        authorization: "Bearer secret-token",
        cookie: "session=private",
      },
    },
    responseText: "invalid token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnopqrstuv",
  }) as {
    message: string;
    request: { headers: { authorization: string; cookie: string } };
    responseText: string;
  };

  assert.equal(result.message, "request failed with Bearer [Redacted]");
  assert.equal(result.request.headers.authorization, "[Redacted]");
  assert.equal(result.request.headers.cookie, "[Redacted]");
  assert.ok(!result.responseText.includes("eyJhbGci"));
  assert.ok(!result.responseText.includes("abcdefghijklmnopqrstuv"));
});

test("redacts sensitive URL query parameters while preserving useful query values", () => {
  assert.equal(
    sanitizeRequestUrl("/v1/callback?state=known&access_token=secret123&code=authcode"),
    "/v1/callback?state=known&access_token=%5BRedacted%5D&code=%5BRedacted%5D",
  );
});

test("fails closed on malformed URLs with query strings", () => {
  assert.equal(sanitizeRequestUrl("%not-a-url?token=secret"), "%not-a-url");
});
