import { test } from "node:test";
import assert from "node:assert/strict";
import { createSmtpTransport } from "../../../api/_smtp.js";

test("createSmtpTransport configures standard SMTP transport with TLS", () => {
  const transport = createSmtpTransport({
    host: "smtp.example.com",
    port: 587,
    user: "test@example.com",
    pass: "secret",
    encryption: "TLS",
  });

  assert.ok(transport);
  const options = (transport as any).options;
  assert.equal(options.host, "smtp.example.com");
  assert.equal(options.port, 587);
  assert.equal(options.secure, false);
  assert.equal(options.requireTLS, true);
  assert.equal(options.auth.user, "test@example.com");
  assert.equal(options.auth.pass, "secret");
  assert.equal(options.tls.rejectUnauthorized, false);
});

test("createSmtpTransport configures SSL correctly", () => {
  const transport = createSmtpTransport({
    host: "smtp.example.com",
    port: 465,
    user: "test@example.com",
    pass: "secret",
    encryption: "SSL",
    connectionTimeout: 10000,
  });

  const options = (transport as any).options;
  assert.equal(options.secure, true);
  assert.equal(options.requireTLS, false);
  assert.equal(options.connectionTimeout, 10000);
});

test("createSmtpTransport parses string port into number", () => {
  const transport = createSmtpTransport({
    host: "smtp.example.com",
    port: "587",
    user: "test@example.com",
    pass: "secret",
  });

  const options = (transport as any).options;
  assert.equal(options.port, 587);
  assert.equal(options.secure, false);
  assert.equal(options.requireTLS, false);
});
