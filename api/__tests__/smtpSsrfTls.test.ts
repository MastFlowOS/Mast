import assert from "node:assert/strict";
import test, { describe } from "node:test";
import tls from "node:tls";
import {
  classifyProhibitedIpv4,
  classifyProhibitedIpv6,
  validateHostnameSyntax,
  validateSmtpHostFormat,
  resolveAndValidateHost,
  type DnsResolver,
} from "../_ipValidator";
import { createSmtpTransport } from "../_smtp";
import { SmtpServiceError } from "../_smtpService";

describe("SEC-03: SMTP SSRF & TLS Hardening", () => {
  describe("IPv4 Range Classification & Prohibited Blocks", () => {
    const prohibitedIpv4Cases = [
      { ip: "0.0.0.0", reason: "current network" },
      { ip: "0.255.255.255", reason: "current network" },
      { ip: "127.0.0.1", reason: "loopback" },
      { ip: "127.255.255.255", reason: "loopback" },
      { ip: "10.0.0.1", reason: "RFC 1918 private" },
      { ip: "10.255.255.254", reason: "RFC 1918 private" },
      { ip: "100.64.0.1", reason: "CGNAT / shared space" },
      { ip: "100.127.255.254", reason: "CGNAT / shared space" },
      { ip: "169.254.169.254", reason: "link-local cloud metadata" },
      { ip: "169.254.1.1", reason: "link-local" },
      { ip: "172.16.0.1", reason: "RFC 1918 private" },
      { ip: "172.31.255.254", reason: "RFC 1918 private" },
      { ip: "192.0.0.1", reason: "IETF protocol assignments" },
      { ip: "192.0.2.1", reason: "TEST-NET-1" },
      { ip: "192.88.99.1", reason: "6to4 Relay Anycast" },
      { ip: "192.168.0.1", reason: "RFC 1918 private" },
      { ip: "192.168.255.254", reason: "RFC 1918 private" },
      { ip: "198.18.0.1", reason: "benchmarking" },
      { ip: "198.19.255.254", reason: "benchmarking" },
      { ip: "198.51.100.1", reason: "TEST-NET-2" },
      { ip: "203.0.113.1", reason: "TEST-NET-3" },
      { ip: "224.0.0.1", reason: "multicast" },
      { ip: "239.255.255.254", reason: "multicast" },
      { ip: "240.0.0.1", reason: "Class E reserved" },
      { ip: "255.255.255.255", reason: "limited broadcast" },
    ];

    for (const { ip, reason } of prohibitedIpv4Cases) {
      test(`rejects prohibited IPv4: ${ip} (${reason})`, () => {
        const prohibited = classifyProhibitedIpv4(ip);
        assert.ok(prohibited !== null, `Expected ${ip} to be prohibited, got null`);
      });
    }

    const allowedIpv4Cases = [
      "93.184.216.34", // example.com
      "142.250.185.109", // google.com
      "1.1.1.1", // cloudflare
      "8.8.8.8", // google dns
      "104.244.42.1", // twitter
      "151.101.1.140", // fastly
    ];

    for (const ip of allowedIpv4Cases) {
      test(`allows public routable IPv4: ${ip}`, () => {
        const prohibited = classifyProhibitedIpv4(ip);
        assert.equal(prohibited, null, `Expected ${ip} to be allowed public IP`);
      });
    }

    test("rejects malformed and non-canonical IPv4 representations", () => {
      assert.ok(classifyProhibitedIpv4("0177.0.0.1") !== null); // octal bypass attempt
      assert.ok(classifyProhibitedIpv4("127.0.0.01") !== null);
      assert.ok(classifyProhibitedIpv4("256.0.0.1") !== null);
      assert.ok(classifyProhibitedIpv4("1.2.3") !== null);
      assert.ok(classifyProhibitedIpv4("1.2.3.4.5") !== null);
    });
  });

  describe("IPv6 Range Classification & Prohibited Blocks", () => {
    const prohibitedIpv6Cases = [
      { ip: "::", reason: "unspecified" },
      { ip: "::1", reason: "loopback" },
      { ip: "0:0:0:0:0:0:0:1", reason: "expanded loopback" },
      { ip: "::127.0.0.1", reason: "IPv4-compatible loopback (RFC 4291 deprecated ::/96)" },
      { ip: "::10.0.0.1", reason: "IPv4-compatible private (RFC 4291 deprecated ::/96)" },
      { ip: "fe80::1", reason: "link-local" },
      { ip: "fe80:0:0:0:0:0:0:1", reason: "expanded link-local" },
      { ip: "fc00::1", reason: "unique local / private ULA" },
      { ip: "fd12:3456:789a::1", reason: "unique local / private ULA" },
      { ip: "ff02::1", reason: "multicast all-nodes" },
      { ip: "ff00::", reason: "multicast prefix" },
      { ip: "2001:db8::1", reason: "documentation prefix" },
      { ip: "2001::1", reason: "IETF protocol assignments / Teredo" },
      { ip: "2002::1", reason: "6to4 scheme" },
      { ip: "64:ff9b::1", reason: "well-known IPv4/IPv6 translation" },
      { ip: "100::1", reason: "discard-only prefix" },
    ];

    for (const { ip, reason } of prohibitedIpv6Cases) {
      test(`rejects prohibited IPv6: ${ip} (${reason})`, () => {
        const prohibited = classifyProhibitedIpv6(ip);
        assert.ok(prohibited !== null, `Expected IPv6 ${ip} to be prohibited, got null`);
      });
    }

    const ipv4MappedCases = [
      { ip: "::ffff:127.0.0.1", reason: "mapped loopback" },
      { ip: "::ffff:169.254.169.254", reason: "mapped metadata" },
      { ip: "::ffff:10.0.0.1", reason: "mapped RFC 1918 private" },
      { ip: "::ffff:192.168.1.1", reason: "mapped RFC 1918 private" },
      { ip: "::ffff:93.184.216.34", reason: "mapped public (non-routable IPv6 destination)" },
    ];

    for (const { ip, reason } of ipv4MappedCases) {
      test(`rejects IPv4-mapped IPv6 address: ${ip} (${reason})`, () => {
        const prohibited = classifyProhibitedIpv6(ip);
        assert.ok(prohibited !== null, `Expected mapped IPv6 ${ip} to be prohibited`);
      });
    }

    const allowedIpv6Cases = [
      "2607:f8b0:4005:805::200e", // google.com public IPv6
      "2606:4700:4700::1111", // cloudflare public IPv6
      "2a00:1450:4009:81f::200e", // google europe
      "2003:dead:beef::1", // global unicast
    ];

    for (const ip of allowedIpv6Cases) {
      test(`allows public routable IPv6: ${ip}`, () => {
        const prohibited = classifyProhibitedIpv6(ip);
        assert.equal(prohibited, null, `Expected ${ip} to be allowed public IPv6`);
      });
    }
  });

  describe("Hostname and Format Validation", () => {
    test("rejects URL schemes, credentials, embedded ports, and path injection", () => {
      const invalidInputs = [
        "smtp://smtp.gmail.com",
        "http://127.0.0.1",
        "https://example.com/",
        "tcp://smtp.sendgrid.net",
        "user:pass@smtp.gmail.com",
        "admin@internal.corp",
        "smtp.gmail.com:587",
        "127.0.0.1:25",
        "[::1]:25",
        "smtp.gmail.com/send",
        "smtp.gmail.com?debug=true",
        "smtp.gmail.com#anchor",
        "smtp.gmail.com\\path",
        "smtp.gmail.com\r\nHELO evil.com",
        "smtp.gmail.com; rm -rf /",
        "localhost",
        "server.local",
        "api.internal",
        "db.lan",
        "host.home",
        "2130706433", // decimal integer IP representation
        "0x7f000001", // hex representation
      ];

      for (const input of invalidInputs) {
        assert.throws(
          () => validateSmtpHostFormat(input),
          (err: any) => err instanceof SmtpServiceError && err.status === 400,
          `Expected input "${input}" to be rejected with 400`,
        );
      }
    });

    test("accepts valid canonical DNS hostnames and bracketed/bare IPv6", () => {
      assert.deepEqual(validateSmtpHostFormat("smtp.gmail.com"), {
        type: "hostname",
        cleanHost: "smtp.gmail.com",
      });
      // Trailing dot normalized per RFC 1034
      assert.deepEqual(validateSmtpHostFormat("smtp.gmail.com."), {
        type: "hostname",
        cleanHost: "smtp.gmail.com",
      });
      // Internationalized domain names normalized via Punycode
      assert.deepEqual(validateSmtpHostFormat("münchen.de"), {
        type: "hostname",
        cleanHost: "xn--mnchen-3ya.de",
      });
      assert.deepEqual(validateSmtpHostFormat("email-smtp.us-east-1.amazonaws.com"), {
        type: "hostname",
        cleanHost: "email-smtp.us-east-1.amazonaws.com",
      });
      assert.deepEqual(validateSmtpHostFormat("93.184.216.34"), {
        type: "ipv4",
        cleanHost: "93.184.216.34",
      });
      assert.deepEqual(validateSmtpHostFormat("[2607:f8b0:4005:805::200e]"), {
        type: "ipv6",
        cleanHost: "2607:f8b0:4005:805::200e",
      });
      assert.deepEqual(validateSmtpHostFormat("2607:f8b0:4005:805::200e"), {
        type: "ipv6",
        cleanHost: "2607:f8b0:4005:805::200e",
      });
    });
  });

  describe("DNS Resolution and Multi-IP Validation", () => {
    test("pins public IPv4 when hostname resolves to public addresses", async () => {
      const mockResolver: DnsResolver = {
        resolve4: async () => ["142.250.185.109"],
        resolve6: async () => [],
      };

      const result = await resolveAndValidateHost("smtp.gmail.com", mockResolver);
      assert.equal(result.isIp, false);
      assert.equal(result.canonicalHost, "smtp.gmail.com");
      assert.equal(result.pinnedIp, "142.250.185.109");
      assert.equal(result.family, 4);
    });

    test("pins public IPv6 when hostname resolves only to public IPv6", async () => {
      const mockResolver: DnsResolver = {
        resolve4: async () => [],
        resolve6: async () => ["2607:f8b0:4005:805::200e"],
      };

      const result = await resolveAndValidateHost("smtp.ipv6only.example.com", mockResolver);
      assert.equal(result.isIp, false);
      assert.equal(result.canonicalHost, "smtp.ipv6only.example.com");
      assert.equal(result.pinnedIp, "2607:f8b0:4005:805::200e");
      assert.equal(result.family, 6);
    });

    test("REJECTS hostname resolving to mixed public and prohibited IPv4", async () => {
      const mockResolver: DnsResolver = {
        // One public IP, one internal loopback IP
        resolve4: async () => ["93.184.216.34", "127.0.0.1"],
        resolve6: async () => [],
      };

      await assert.rejects(
        () => resolveAndValidateHost("mixed-records.attacker.com", mockResolver),
        (err: any) =>
          err instanceof SmtpServiceError &&
          err.code === "smtp_prohibited_destination" &&
          err.message.includes("127.0.0.1"),
      );
    });

    test("REJECTS hostname resolving to mixed public and private RFC 1918 IP", async () => {
      const mockResolver: DnsResolver = {
        resolve4: async () => ["93.184.216.34", "10.0.0.5"],
        resolve6: async () => [],
      };

      await assert.rejects(
        () => resolveAndValidateHost("private-mixed.attacker.com", mockResolver),
        (err: any) =>
          err instanceof SmtpServiceError &&
          err.code === "smtp_prohibited_destination" &&
          err.message.includes("10.0.0.5"),
      );
    });

    test("REJECTS hostname resolving to mixed public IPv4 and prohibited IPv6", async () => {
      const mockResolver: DnsResolver = {
        resolve4: async () => ["93.184.216.34"],
        resolve6: async () => ["::1"], // loopback IPv6
      };

      await assert.rejects(
        () => resolveAndValidateHost("ipv6-loopback-mixed.attacker.com", mockResolver),
        (err: any) =>
          err instanceof SmtpServiceError &&
          err.code === "smtp_prohibited_destination" &&
          err.message.includes("::1"),
      );
    });

    test("REJECTS hostname with no DNS records found", async () => {
      const mockResolver: DnsResolver = {
        resolve4: async () => [],
        resolve6: async () => [],
      };

      await assert.rejects(
        () => resolveAndValidateHost("nonexistent.example.com", mockResolver),
        (err: any) =>
          err instanceof SmtpServiceError && err.code === "smtp_dns_resolution_failed",
      );
    });

    test("REJECTS literal prohibited IP destinations directly", async () => {
      await assert.rejects(
        () => resolveAndValidateHost("127.0.0.1"),
        (err: any) =>
          err instanceof SmtpServiceError && err.code === "smtp_prohibited_destination",
      );
      await assert.rejects(
        () => resolveAndValidateHost("169.254.169.254"),
        (err: any) =>
          err instanceof SmtpServiceError && err.code === "smtp_prohibited_destination",
      );
      await assert.rejects(
        () => resolveAndValidateHost("::1"),
        (err: any) =>
          err instanceof SmtpServiceError && err.code === "smtp_prohibited_destination",
      );
    });
  });

  describe("DNS Rebinding & Socket Pinning Integration", () => {
    test("connection pins to validated IP and defeats DNS rebinding changes", async () => {
      let resolutionCount = 0;
      const mockResolver: DnsResolver = {
        resolve4: async () => {
          resolutionCount++;
          // First query returns public IP; subsequent queries simulate rebind to cloud metadata
          return resolutionCount === 1 ? ["142.250.185.109"] : ["169.254.169.254"];
        },
        resolve6: async () => [],
      };

      // Create transport with initial validation
      const transport = await createSmtpTransport({
        host: "rebind.attacker.com",
        port: 587,
        user: "test@example.com",
        pass: "secret",
        encryption: "TLS",
        resolver: mockResolver,
      });

      const options = (transport as any).options;

      // 1. Host passed to socket is pinned to the initial validated public IP
      assert.equal(options.host, "142.250.185.109");

      // 2. Lookup callback pins to the validated IP
      let lookupResultIp = "";
      options.lookup("rebind.attacker.com", {}, (err: any, address: string) => {
        assert.equal(err, null);
        lookupResultIp = address;
      });
      assert.equal(lookupResultIp, "142.250.185.109");

      // 3. Even though resolver now returns 169.254.169.254, socket remains pinned to 142.250.185.109
      assert.notEqual(options.host, "169.254.169.254");
    });
  });

  describe("TLS Certificate Hostname Verification & SNI", () => {
    test("sets SNI and checkServerIdentity for DNS hostnames connected via pinned IP", async () => {
      const mockResolver: DnsResolver = {
        resolve4: async () => ["142.250.185.109"],
        resolve6: async () => [],
      };

      const transport = await createSmtpTransport({
        host: "smtp.gmail.com",
        port: 587,
        user: "test@gmail.com",
        pass: "secret",
        encryption: "TLS",
        resolver: mockResolver,
      });

      const options = (transport as any).options;

      // Socket connects to pinned IP
      assert.equal(options.host, "142.250.185.109");

      // SNI is explicitly set to canonical hostname (NOT the IP)
      assert.equal(options.tls.servername, "smtp.gmail.com");

      // Certificate validation cannot be disabled
      assert.equal(options.tls.rejectUnauthorized, true);

      // checkServerIdentity verifies against canonicalHost
      const validCert = { subject: { CN: "smtp.gmail.com" }, subjectaltname: "DNS:smtp.gmail.com" } as any;
      const invalidCert = { subject: { CN: "attacker.com" }, subjectaltname: "DNS:attacker.com" } as any;

      const validCheck = options.tls.checkServerIdentity("142.250.185.109", validCert);
      assert.equal(validCheck, undefined, "Valid certificate for smtp.gmail.com must be accepted");

      const invalidCheck = options.tls.checkServerIdentity("142.250.185.109", invalidCert);
      assert.ok(invalidCheck instanceof Error, "Certificate for attacker.com must be rejected");
    });

    test("omits SNI for raw IP destinations per RFC 6066", async () => {
      const transport = await createSmtpTransport({
        host: "93.184.216.34",
        port: 465,
        user: "test@example.com",
        pass: "secret",
        encryption: "SSL",
      });

      const options = (transport as any).options;
      assert.equal(options.host, "93.184.216.34");
      assert.equal(options.tls.servername, undefined, "SNI servername must be omitted for IP addresses");
      assert.equal(options.tls.rejectUnauthorized, true);
    });

    test("unconditionally enforces rejectUnauthorized even if SMTP_ALLOW_INSECURE_TLS is set", async () => {
      const previous = process.env.SMTP_ALLOW_INSECURE_TLS;
      process.env.SMTP_ALLOW_INSECURE_TLS = "true";
      try {
        const mockResolver: DnsResolver = {
          resolve4: async () => ["142.250.185.109"],
          resolve6: async () => [],
        };

        const transport = await createSmtpTransport({
          host: "smtp.gmail.com",
          port: 587,
          user: "test@gmail.com",
          pass: "secret",
          encryption: "TLS",
          resolver: mockResolver,
        });

        const options = (transport as any).options;
        assert.equal(
          options.tls.rejectUnauthorized,
          true,
          "Certificate verification must remain strictly enabled",
        );
      } finally {
        if (previous === undefined) {
          delete process.env.SMTP_ALLOW_INSECURE_TLS;
        } else {
          process.env.SMTP_ALLOW_INSECURE_TLS = previous;
        }
      }
    });

    test("rejects invalid ports (< 1 or > 65535 or non-integers)", async () => {
      const badPorts = [0, -1, 65536, 70000, 25.5, NaN, "not_a_number"];
      for (const port of badPorts) {
        await assert.rejects(
          () =>
            createSmtpTransport({
              host: "smtp.gmail.com",
              port: port as any,
              user: "test@example.com",
              pass: "secret",
            }),
          (err: any) => err instanceof SmtpServiceError && err.status === 400,
        );
      }
    });
  });
});
