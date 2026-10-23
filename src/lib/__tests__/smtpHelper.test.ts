import { test } from "node:test";
import assert from "node:assert/strict";
import { createSmtpTransport } from "../../../api/_smtp.js";
import type { DnsResolver } from "../../../api/_ipValidator.js";

const mockResolver: DnsResolver = {
  resolve4: async () => ["93.184.216.34"],
  resolve6: async () => [],
};

test("createSmtpTransport configures standard SMTP transport with TLS and pinned IP", async () => {
  const transport = await createSmtpTransport({
    host: "smtp.example.com",
    port: 587,
    user: "test@example.com",
    pass: "secret",
    encryption: "TLS",
    resolver: mockResolver,
  });

  assert.ok(transport);
  const options = (transport as any).options;
  // Socket host is pinned to the validated IP to defeat DNS rebinding
  assert.equal(options.host, "93.184.216.34");
  assert.equal(options.port, 587);
  assert.equal(options.secure, false);
  assert.equal(options.requireTLS, true);
  assert.equal(options.auth.user, "test@example.com");
  assert.equal(options.auth.pass, "secret");
  // TLS verifies canonical hostname and enforces certificate validation
  assert.equal(options.tls.servername, "smtp.example.com");
  assert.equal(options.tls.rejectUnauthorized, true);
});

test("createSmtpTransport configures SSL correctly", async () => {
  const transport = await createSmtpTransport({
    host: "smtp.example.com",
    port: 465,
    user: "test@example.com",
    pass: "secret",
    encryption: "SSL",
    connectionTimeout: 10000,
    resolver: mockResolver,
  });

  const options = (transport as any).options;
  assert.equal(options.secure, true);
  assert.equal(options.requireTLS, false);
  assert.equal(options.connectionTimeout, 10000);
  assert.equal(options.tls.servername, "smtp.example.com");
  assert.equal(options.tls.rejectUnauthorized, true);
});

test("createSmtpTransport parses string port into number", async () => {
  const transport = await createSmtpTransport({
    host: "smtp.example.com",
    port: "587",
    user: "test@example.com",
    pass: "secret",
    resolver: mockResolver,
  });

  const options = (transport as any).options;
  assert.equal(options.port, 587);
  assert.equal(options.secure, false);
  assert.equal(options.requireTLS, false);
});

test("createSmtpTransport strictly enforces rejectUnauthorized: true even if SMTP_ALLOW_INSECURE_TLS is set", async () => {
  const previous = process.env.SMTP_ALLOW_INSECURE_TLS;
  process.env.SMTP_ALLOW_INSECURE_TLS = "true";
  try {
    const transport = await createSmtpTransport({
      host: "smtp.example.com",
      port: 587,
      user: "test@example.com",
      pass: "secret",
      encryption: "TLS",
      resolver: mockResolver,
    });
    const options = (transport as any).options;
    // SEC-03: Certificate validation cannot be disabled in production
    assert.equal(options.tls.rejectUnauthorized, true);
  } finally {
    if (previous === undefined) {
      delete process.env.SMTP_ALLOW_INSECURE_TLS;
    } else {
      process.env.SMTP_ALLOW_INSECURE_TLS = previous;
    }
  }
});
