/**
 * SSRF-safe IMAP host & DNS validator.
 * Rejects localhost, private RFC 1918 / RFC 6598 ranges, link-local / cloud
 * metadata IPs, and hostnames resolving to any prohibited IPv4 or IPv6 range.
 */
import dns from "node:dns/promises";
import net from "node:net";
import { domainToASCII } from "node:url";

export class InboxHostError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "InboxHostError";
    this.status = status;
    this.code = code;
  }
}

interface Ipv4Range {
  name: string;
  start: number;
  end: number;
}

export function ipv4ToUint32(ip: string): number {
  const parts = ip.split(".");
  if (parts.length !== 4) return -1;
  let res = 0;
  for (let i = 0; i < 4; i++) {
    const p = parts[i];
    if (!/^(0|[1-9]\d{0,2})$/.test(p)) return -1;
    const n = Number(p);
    if (n < 0 || n > 255) return -1;
    res = (res << 8) | n;
  }
  return res >>> 0;
}

function cidrToIpv4Range(name: string, cidr: string): Ipv4Range {
  const [ip, bitsStr] = cidr.split("/");
  const bits = Number(bitsStr);
  const ipNum = ipv4ToUint32(ip);
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  const start = (ipNum & mask) >>> 0;
  const end = (start | (~mask >>> 0)) >>> 0;
  return { name, start, end };
}

const PROHIBITED_IPV4_RANGES: Ipv4Range[] = [
  cidrToIpv4Range("This host on this network (RFC 1122)", "0.0.0.0/8"),
  cidrToIpv4Range("Private-Use (RFC 1918)", "10.0.0.0/8"),
  cidrToIpv4Range("Shared Address Space / CGNAT (RFC 6598)", "100.64.0.0/10"),
  cidrToIpv4Range("Loopback (RFC 1122)", "127.0.0.0/8"),
  cidrToIpv4Range("Link-Local / Cloud Metadata (RFC 3927)", "169.254.0.0/16"),
  cidrToIpv4Range("Private-Use (RFC 1918)", "172.16.0.0/12"),
  cidrToIpv4Range("IETF Protocol Assignments (RFC 6890)", "192.0.0.0/24"),
  cidrToIpv4Range("TEST-NET-1 (RFC 5737)", "192.0.2.0/24"),
  cidrToIpv4Range("Private-Use (RFC 1918)", "192.168.0.0/16"),
  cidrToIpv4Range("Benchmarking (RFC 2544)", "198.18.0.0/15"),
  cidrToIpv4Range("TEST-NET-2 (RFC 5737)", "198.51.100.0/24"),
  cidrToIpv4Range("TEST-NET-3 (RFC 5737)", "203.0.113.0/24"),
  cidrToIpv4Range("Multicast (RFC 5771)", "224.0.0.0/4"),
  cidrToIpv4Range("Reserved (RFC 1112)", "240.0.0.0/4"),
  cidrToIpv4Range("Broadcast", "255.255.255.255/32"),
];

export function classifyProhibitedIpv4(ip: string): string | null {
  const num = ipv4ToUint32(ip);
  if (num === -1) return "Malformed IPv4";
  for (const range of PROHIBITED_IPV4_RANGES) {
    if (num >= range.start && num <= range.end) return range.name;
  }
  return null;
}

export function classifyProhibitedIpv6(rawIp: string): string | null {
  const ip = rawIp.split("%")[0].toLowerCase().trim();
  if (ip === "::" || ip === "::1") return "Loopback / Unspecified IPv6";
  if (ip.startsWith("::ffff:")) {
    const mapped = ip.slice("::ffff:".length);
    if (net.isIPv4(mapped)) return classifyProhibitedIpv4(mapped);
  }
  // Unique Local (fc00::/7) and Link-Local (fe80::/10) and Multicast (ff00::/8)
  if (/^(fc|fd)[0-9a-f]{2}:/i.test(ip)) return "Unique Local IPv6 (fc00::/7)";
  if (/^fe[89ab][0-9a-f]:/i.test(ip)) return "Link-Local IPv6 (fe80::/10)";
  if (/^ff[0-9a-f]{2}:/i.test(ip)) return "Multicast IPv6 (ff00::/8)";
  return null;
}

export interface DnsResolver {
  resolve4(host: string): Promise<string[]>;
  resolve6(host: string): Promise<string[]>;
}

const systemDnsResolver: DnsResolver = {
  resolve4: async (host: string) => {
    try {
      return await dns.resolve4(host);
    } catch (err: any) {
      if (err.code === "ENODATA" || err.code === "ENOTFOUND") return [];
      throw err;
    }
  },
  resolve6: async (host: string) => {
    try {
      return await dns.resolve6(host);
    } catch (err: any) {
      if (err.code === "ENODATA" || err.code === "ENOTFOUND") return [];
      throw err;
    }
  },
};

export interface ValidatedImapHost {
  canonicalHost: string;
  pinnedIp: string;
  family: 4 | 6;
}

export async function validateImapHost(
  hostInput: string,
  resolver: DnsResolver = systemDnsResolver,
): Promise<ValidatedImapHost> {
  const trimmed = hostInput.trim();
  if (!trimmed || trimmed.length > 255 || /[\s/\\@:?#]/.test(trimmed)) {
    throw new InboxHostError(400, "imap_invalid_host", "Invalid IMAP hostname.");
  }

  const unbracketed =
    trimmed.startsWith("[") && trimmed.endsWith("]") ? trimmed.slice(1, -1) : trimmed;

  if (net.isIPv4(unbracketed)) {
    const prohibited = classifyProhibitedIpv4(unbracketed);
    if (prohibited) {
      throw new InboxHostError(
        400,
        "imap_prohibited_destination",
        `IMAP host ${unbracketed} is in a prohibited network range (${prohibited}).`,
      );
    }
    return { canonicalHost: unbracketed, pinnedIp: unbracketed, family: 4 };
  }

  if (net.isIPv6(unbracketed)) {
    const prohibited = classifyProhibitedIpv6(unbracketed);
    if (prohibited) {
      throw new InboxHostError(
        400,
        "imap_prohibited_destination",
        `IMAP host [${unbracketed}] is in a prohibited network range (${prohibited}).`,
      );
    }
    return { canonicalHost: unbracketed, pinnedIp: unbracketed, family: 6 };
  }

  const asciiHost = domainToASCII(unbracketed).toLowerCase().replace(/\.+$/, "");
  if (!asciiHost || asciiHost === "localhost" || asciiHost.endsWith(".localhost") || asciiHost.endsWith(".local")) {
    throw new InboxHostError(
      400,
      "imap_prohibited_destination",
      `IMAP host "${unbracketed}" is not allowed.`,
    );
  }

  let v4: string[] = [];
  let v6: string[] = [];
  try {
    [v4, v6] = await Promise.all([resolver.resolve4(asciiHost), resolver.resolve6(asciiHost)]);
  } catch (err: any) {
    throw new InboxHostError(
      400,
      "imap_dns_resolution_failed",
      `Failed to resolve IMAP host "${asciiHost}": ${err?.message || "DNS error"}`,
    );
  }

  const all = [
    ...v4.map((ip) => ({ ip, family: 4 as const })),
    ...v6.map((ip) => ({ ip, family: 6 as const })),
  ];
  if (all.length === 0) {
    throw new InboxHostError(
      400,
      "imap_dns_resolution_failed",
      `IMAP host "${asciiHost}" could not be resolved.`,
    );
  }

  for (const addr of all) {
    const prohibited =
      addr.family === 4 ? classifyProhibitedIpv4(addr.ip) : classifyProhibitedIpv6(addr.ip);
    if (prohibited) {
      throw new InboxHostError(
        400,
        "imap_prohibited_destination",
        `IMAP host "${asciiHost}" resolves to prohibited IP ${addr.ip} (${prohibited}).`,
      );
    }
  }

  return {
    canonicalHost: asciiHost,
    pinnedIp: all[0].ip,
    family: all[0].family,
  };
}
