import assert from "node:assert/strict";
import test from "node:test";

import {
  redactSensitiveData,
  redactSensitiveHeaders,
  redactRawHeaders,
  redactHeaderString,
  sanitizeWorkerError,
  sanitizeRequestUrl,
  serializeError,
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

test("redacts rawHeaders array containing sensitive header pairs and preserves safe headers", () => {
  const rawHeaders = [
    "Host", "api.example.com",
    "Authorization", "Basic dXNlcjpwYXNzd29yZDEyMw==",
    "User-Agent", "MastEngine/1.0",
    "Cookie", "session_id=fake_secret_session_abc123",
    "X-Service-Key", "sk-fake-secret-service-key-xyz987",
    "Accept", "application/json",
  ];

  const sanitized = redactRawHeaders(rawHeaders);
  assert.equal(sanitized[0], "Host");
  assert.equal(sanitized[1], "api.example.com");
  assert.equal(sanitized[2], "Authorization");
  assert.equal(sanitized[3], "[Redacted]");
  assert.equal(sanitized[4], "User-Agent");
  assert.equal(sanitized[5], "MastEngine/1.0");
  assert.equal(sanitized[6], "Cookie");
  assert.equal(sanitized[7], "[Redacted]");
  assert.equal(sanitized[8], "X-Service-Key");
  assert.equal(sanitized[9], "[Redacted]");
  assert.equal(sanitized[10], "Accept");
  assert.equal(sanitized[11], "application/json");

  // Verify none of the secret tokens remain in sanitized
  const serialized = JSON.stringify(sanitized);
  assert.ok(!serialized.includes("dXNlcjpwYXNzd29yZDEyMw=="));
  assert.ok(!serialized.includes("fake_secret_session_abc123"));
  assert.ok(!serialized.includes("sk-fake-secret-service-key-xyz987"));
});

test("redacts _header string lines containing sensitive credentials", () => {
  const headerStr =
    "POST /v1/ingest HTTP/1.1\r\n" +
    "Host: ingest.example.com\r\n" +
    "Authorization: Bearer fake-secret-bearer-token-12345\r\n" +
    "Proxy-Authorization: Basic ZmFrZTpwcm94eXBhc3M=\r\n" +
    "Cookie: sb-access-token=fake-supabase-cookie-val\r\n" +
    "X-Api-Key: fake-api-key-value-999\r\n" +
    "Accept: application/json\r\n\r\n";

  const sanitized = redactHeaderString(headerStr);
  assert.ok(sanitized.includes("Host: ingest.example.com"));
  assert.ok(sanitized.includes("Authorization: [Redacted]"));
  assert.ok(sanitized.includes("Proxy-Authorization: [Redacted]"));
  assert.ok(sanitized.includes("Cookie: [Redacted]"));
  assert.ok(sanitized.includes("X-Api-Key: [Redacted]"));
  assert.ok(sanitized.includes("Accept: application/json"));

  assert.ok(!sanitized.includes("fake-secret-bearer-token-12345"));
  assert.ok(!sanitized.includes("ZmFrZTpwcm94eXBhc3M="));
  assert.ok(!sanitized.includes("fake-supabase-cookie-val"));
  assert.ok(!sanitized.includes("fake-api-key-value-999"));
});

test("redacts basic-auth credentials and sensitive query parameters in URLs", () => {
  const sanitizedUrl = sanitizeRequestUrl("https://admin:fake_secret_pass_888@backend.internal/v1?token=fake_tok_999&normal_param=ok_val");
  assert.ok(!sanitizedUrl.includes("fake_secret_pass_888"));
  assert.ok(!sanitizedUrl.includes("fake_tok_999"));
  assert.ok(sanitizedUrl.includes("%5BRedacted%5D") || sanitizedUrl.includes("[Redacted]"));
  assert.ok(sanitizedUrl.includes("normal_param=ok_val"));
});

test("redacts nested HTTP client error objects and strips internal sockets", () => {
  const errorObj = {
    name: "AxiosError",
    message: "Request failed with status 401 on https://user:fake_pass_xyz@api.example.com?secret=fake_secret_key_777",
    status: 401,
    request: {
      method: "POST",
      url: "https://api.example.com/v1/resource?token=fake_request_token_555",
      headers: {
        authorization: "Bearer fake_req_token_aaa",
        "x-custom-auth": "fake_custom_auth_bbb",
      },
      rawHeaders: [
        "Authorization", "Bearer fake_req_token_aaa",
        "X-Custom-Auth", "fake_custom_auth_bbb",
        "Host", "api.example.com",
      ],
      socket: {
        _handle: { fd: 12 },
        remoteAddress: "127.0.0.1",
      },
    },
    response: {
      status: 401,
      statusText: "Unauthorized",
      headers: {
        "set-cookie": "session=fake_response_cookie_ccc",
        "content-type": "application/json",
      },
    },
  };

  const sanitized = redactSensitiveData(errorObj) as any;
  const serialized = JSON.stringify(sanitized);

  // Assert secrets are gone
  assert.ok(!serialized.includes("fake_pass_xyz"));
  assert.ok(!serialized.includes("fake_secret_key_777"));
  assert.ok(!serialized.includes("fake_request_token_555"));
  assert.ok(!serialized.includes("fake_req_token_aaa"));
  assert.ok(!serialized.includes("fake_custom_auth_bbb"));
  assert.ok(!serialized.includes("fake_response_cookie_ccc"));

  // Assert internal socket was stripped
  assert.equal(sanitized.request.socket, undefined);

  // Assert safe allowlisted fields remain
  assert.equal(sanitized.name, "AxiosError");
  assert.equal(sanitized.status, 401);
  assert.equal(sanitized.request.method, "POST");
  assert.equal(sanitized.response.status, 401);
  assert.equal(sanitized.response.statusText, "Unauthorized");
  assert.equal(sanitized.response.headers["content-type"], "application/json");
});

test("sanitizeWorkerError preserves safe diagnostic text while scrubbing secrets and bounding length", () => {
  // 1. Safe error is preserved
  const safeErr = "RuntimeError: Browser launch crashed with code -1073741819";
  assert.equal(sanitizeWorkerError(safeErr), safeErr);

  // 2. Sensitive error has credentials redacted
  const sensitiveErr = "Error connecting to https://admin:fake_pwd_111@maps.google.com?key=fake_map_key_222 with Bearer fake_tok_333 and Basic fake_basic_444";
  const sanitizedSensitive = sanitizeWorkerError(sensitiveErr)!;
  assert.ok(!sanitizedSensitive.includes("fake_pwd_111"));
  assert.ok(!sanitizedSensitive.includes("fake_map_key_222"));
  assert.ok(!sanitizedSensitive.includes("fake_tok_333"));
  assert.ok(!sanitizedSensitive.includes("fake_basic_444"));
  assert.ok(sanitizedSensitive.includes("[Redacted]"));

  // 3. Unbounded long error string is truncated to <= 500 characters
  const longErr = "A".repeat(1000);
  const boundedErr = sanitizeWorkerError(longErr)!;
  assert.ok(boundedErr.length <= 500);
  assert.ok(boundedErr.endsWith("..."));
});

test("redacts sensitive URL query parameters while preserving useful query values", () => {
  assert.equal(
    sanitizeRequestUrl("/v1/callback?state=known&access_token=secret123&code=authcode"),
    "/v1/callback?state=known&access_token=%5BRedacted%5D&code=%5BRedacted%5D",
  );
});

test("fails closed on malformed URLs with query strings", () => {
  assert.equal(sanitizeRequestUrl("http://[invalid?token=secret"), "http://[invalid");
});

test("serializeError uses safe allowlisted fields and strips custom attached request/response trees", () => {
  const err = new Error("Database connection refused");
  (err as any).code = "ECONNREFUSED";
  (err as any).details = "TCP connection to host failed";
  (err as any).hint = "Check network connectivity";
  (err as any).request = {
    method: "POST",
    headers: { authorization: "Bearer fake_secret_bearer_token" },
  };
  (err as any).response = {
    status: 503,
    data: { error: "upstream unavailable" },
  };
  (err as any).config = {
    url: "https://db.internal?secret=fake_super_secret",
  };

  const serialized = serializeError(err);

  // Safe allowlisted fields are retained
  assert.equal(serialized.name, "Error");
  assert.equal(serialized.message, "Database connection refused");
  assert.equal(serialized.code, "ECONNREFUSED");
  assert.equal(serialized.details, "TCP connection to host failed");
  assert.equal(serialized.hint, "Check network connectivity");

  // Raw request/response/config properties are excluded from allowlist
  assert.equal(serialized.request, undefined);
  assert.equal(serialized.response, undefined);
  assert.equal(serialized.config, undefined);
});

test("redacts synthetic fake credentials: JWTs, refresh tokens, cookies, passwords, API keys, and authorization headers", () => {
  const fakePayload = {
    authorization: "Bearer fake_bearer_token_xyz123",
    "x-refresh-token": "fake_refresh_token_abc789",
    cookie: "session=fake_cookie_session_val; sb-access-token=fake_supabase_cookie",
    "set-cookie": "refresh_token=fake_new_refresh_token_456; Path=/; HttpOnly",
    password: "fake_plaintext_password_999",
    "x-api-key": "sk-fake-api-key-abcdef1234567890",
    url: "https://app.mast.internal/v1/auth/callback?code=fake_auth_code_111&refresh_token=fake_query_refresh_222&api_key=fake_query_key_333",
    nestedError: {
      message: "Authentication failed for user with Bearer fake_nested_bearer_444 and refresh_token: fake_nested_refresh_555",
      jwt: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c",
    },
  };

  const sanitized = redactSensitiveData(fakePayload) as any;
  const jsonStr = JSON.stringify(sanitized);

  // Assert all synthetic credentials are completely scrubbed
  assert.ok(!jsonStr.includes("fake_bearer_token_xyz123"));
  assert.ok(!jsonStr.includes("fake_refresh_token_abc789"));
  assert.ok(!jsonStr.includes("fake_cookie_session_val"));
  assert.ok(!jsonStr.includes("fake_supabase_cookie"));
  assert.ok(!jsonStr.includes("fake_new_refresh_token_456"));
  assert.ok(!jsonStr.includes("fake_plaintext_password_999"));
  assert.ok(!jsonStr.includes("sk-fake-api-key-abcdef1234567890"));
  assert.ok(!jsonStr.includes("fake_auth_code_111"));
  assert.ok(!jsonStr.includes("fake_query_refresh_222"));
  assert.ok(!jsonStr.includes("fake_query_key_333"));
  assert.ok(!jsonStr.includes("fake_nested_bearer_444"));
  assert.ok(!jsonStr.includes("fake_nested_refresh_555"));
  assert.ok(!jsonStr.includes("SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c"));

  // Check expected redacted placeholders
  assert.equal(sanitized.authorization, "[Redacted]");
  assert.equal(sanitized["x-refresh-token"], "[Redacted]");
  assert.equal(sanitized.cookie, "[Redacted]");
  assert.equal(sanitized["set-cookie"], "[Redacted]");
  assert.equal(sanitized.password, "[Redacted]");
  assert.equal(sanitized["x-api-key"], "[Redacted]");
});

test("serializeError recursively sanitizes nested cause errors and scrubs sensitive fields inside cause", () => {
  const causeErr = new Error("Underlying network timeout on https://api.internal?token=fake_underlying_token_777");
  (causeErr as any).request = {
    headers: { authorization: "Bearer fake_cause_bearer_888" },
    socket: { remoteAddress: "127.0.0.1" },
  };

  const topErr = new Error("Upstream service failed", { cause: causeErr });
  const serialized = serializeError(topErr);
  const sanitized = redactSensitiveData(serialized) as any;

  assert.equal(sanitized.name, "Error");
  assert.equal(sanitized.message, "Upstream service failed");
  assert.ok(sanitized.cause !== undefined);
  assert.equal(sanitized.cause.name, "Error");
  assert.ok(!JSON.stringify(sanitized).includes("fake_underlying_token_777"));
  assert.ok(!JSON.stringify(sanitized).includes("fake_cause_bearer_888"));
  assert.equal(sanitized.cause.request, undefined);
  assert.equal(sanitized.cause.socket, undefined);
});
