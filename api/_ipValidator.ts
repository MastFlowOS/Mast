import dns from "node:dns/promises";
import net from "node:net";
import tls from "node:tls";
import { domainToASCII } from "node:url";
import { SmtpServiceError } from "./_smtpService.js";

/**
 * IPv4 Range definition: [startInt, endInt]
 */
interface Ipv4Range {
  name: string;
  start: number;
  end: number;
}

/**
 * Helper to convert dotted-quad string into 32-bit unsigned integer
 */
export function ipv4ToUint32(ip: string): number {
  const parts = ip.split(".");
  if (parts.length !== 4) return -1;
  let res = 0;
  for (let i = 0; i < 4; i++) {
    const p = parts[i];
    // Reject leading zeros unless "0"
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

/**
 * Complete list of prohibited IPv4 special-purpose & non-public ranges (RFC 6890, etc.)
 */
const PROHIBITED_IPV4_RANGES: Ipv4Range[] = [
  cidrToIpv4Range("This host on this network (RFC 1122)", "0.0.0.0/8"),
  cidrToIpv4Range("Private-Use (RFC 1918)", "10.0.0.0/8"),
  cidrToIpv4Range("Shared Address Space / CGNAT (RFC 6598)", "100.64.0.0/10"),
  cidrToIpv4Range("Loopback (RFC 1122)", "127.0.0.0/8"),
  cidrToIpv4Range("Link-Local / Cloud Metadata (RFC 3927)", "169.254.0.0/16"),
  cidrToIpv4Range("Private-Use (RFC 1918)", "172.16.0.0/12"),
  cidrToIpv4Range("IETF Protocol Assignments (RFC 6890)", "192.0.0.0/24"),
  cidrToIpv4Range("TEST-NET-1 (RFC 5737)", "192.0.2.0/24"),
  cidrToIpv4Range("6to4 Relay Anycast (RFC 7526)", "192.88.99.0/24"),
  cidrToIpv4Range("Private-Use (RFC 1918)", "192.168.0.0/16"),
  cidrToIpv4Range("Benchmarking (RFC 2544)", "198.18.0.0/15"),
  cidrToIpv4Range("TEST-NET-2 (RFC 5737)", "198.51.100.0/24"),
  cidrToIpv4Range("TEST-NET-3 (RFC 5737)", "203.0.113.0/24"),
  cidrToIpv4Range("Multicast (RFC 5771)", "224.0.0.0/4"),
  cidrToIpv4Range("Reserved for Future Use (RFC 1112)", "240.0.0.0/4"),
  cidrToIpv4Range("Limited Broadcast (RFC 919)", "255.255.255.255/32"),
];

/**
 * Checks whether an IPv4 address is in any prohibited range.
 * Returns null if allowed (public), or the range name if prohibited.
 */
export function classifyProhibitedIpv4(ip: string): string | null {
  const num = ipv4ToUint32(ip);
  if (num === -1) return "Malformed IPv4";
  for (const range of PROHIBITED_IPV4_RANGES) {
    if (num >= range.start && num <= range.end) {
      return range.name;
    }
  }
  return null;
}

/**
 * IPv6 Range definition using 128-bit BigInt
 */
interface Ipv6Range {
  name: string;
  prefix: bigint;
  mask: bigint;
}

/**
 * Converts any IPv6 address string into a 128-bit BigInt.
 * Returns null if invalid.
 */
export function ipv6ToBigInt(ipStr: string): bigint | null {
  let clean = ipStr.trim();
  // Strip optional brackets [::1] -> ::1
  if (clean.startsWith("[") && clean.endsWith("]")) {
    clean = clean.slice(1, -1);
  }

  // Handle embedded IPv4 at the end (e.g. ::ffff:192.0.2.1)
  const lastColon = clean.lastIndexOf(":");
  if (lastColon !== -1) {
    const afterColon = clean.slice(lastColon + 1);
    if (afterColon.includes(".")) {
      const v4Num = ipv4ToUint32(afterColon);
      if (v4Num === -1) return null;
      const hex1 = ((v4Num >>> 16) & 0xffff).toString(16);
      const hex2 = (v4Num & 0xffff).toString(16);
      clean = clean.slice(0, lastColon + 1) + hex1 + ":" + hex2;
    }
  }

  if (clean.split("::").length > 2) return null; // Only one "::" allowed

  let groups: string[];
  if (clean.includes("::")) {
    const [leftStr, rightStr] = clean.split("::");
    const left = leftStr ? leftStr.split(":") : [];
    const right = rightStr ? rightStr.split(":") : [];
    const missing = 8 - (left.length + right.length);
    if (missing < 1) return null;
    groups = [...left, ...Array(missing).fill("0"), ...right];
  } else {
    groups = clean.split(":");
    if (groups.length !== 8) return null;
  }

  if (groups.length !== 8) return null;

  let result = 0n;
  for (const g of groups) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
    const val = BigInt(parseInt(g, 16));
    result = (result << 16n) | val;
  }
  return result;
}

function cidrToIpv6Range(name: string, cidr: string): Ipv6Range {
  const [prefixStr, bitsStr] = cidr.split("/");
  const bits = Number(bitsStr);
  const prefix = ipv6ToBigInt(prefixStr)!;
  const mask = bits === 0 ? 0n : (((1n << 128n) - 1n) ^ ((1n << (128n - BigInt(bits))) - 1n));
  return { name, prefix: prefix & mask, mask };
}

/**
 * Complete list of prohibited IPv6 special-purpose ranges (RFC 6890, RFC 5156, etc.)
 */
const PROHIBITED_IPV6_RANGES: Ipv6Range[] = [
  cidrToIpv6Range("Unspecified Address (RFC 4291)", "::/128"),
  cidrToIpv6Range("Loopback Address (RFC 4291)", "::1/128"),
  cidrToIpv6Range("IPv4-Compatible Address (RFC 4291, Deprecated)", "::/96"),
  cidrToIpv6Range("IPv4-Mapped Address (RFC 4291)", "::ffff:0:0/96"),
  cidrToIpv6Range("IPv4-Translated Address (RFC 6052)", "::ffff:0:0:0/96"),
  cidrToIpv6Range("Well-Known IPv4/IPv6 Translation (RFC 6052)", "64:ff9b::/96"),
  cidrToIpv6Range("Local-Use IPv4/IPv6 Translation (RFC 8215)", "64:ff9b:1::/48"),
  cidrToIpv6Range("Discard-Only Address Block (RFC 6666)", "100::/64"),
  cidrToIpv6Range("IETF Protocol Assignments (RFC 2928 / RFC 6890)", "2001::/23"),
  cidrToIpv6Range("BMWG Benchmarking (RFC 5180)", "2001:2::/48"),
  cidrToIpv6Range("Documentation Prefix (RFC 3849)", "2001:db8::/32"),
  cidrToIpv6Range("ORCHIDv2 (RFC 7343)", "2001:10::/28"),
  cidrToIpv6Range("Drone Remote ID (RFC 9374)", "2001:20::/28"),
  cidrToIpv6Range("6to4 Scheme (RFC 3056)", "2002::/16"),
  cidrToIpv6Range("Unique Local Unicast / Private IPv6 (RFC 4193)", "fc00::/7"),
  cidrToIpv6Range("Link-Local Unicast (RFC 4291)", "fe80::/10"),
  cidrToIpv6Range("Multicast (RFC 4291)", "ff00::/8"),
];

/**
 * Checks whether an IPv6 address is in any prohibited range.
 * Returns null if allowed (public), or the range name if prohibited.
 */
export function classifyProhibitedIpv6(ipStr: string): string | null {
  const bi = ipv6ToBigInt(ipStr);
  if (bi === null) return "Malformed IPv6";

  // Check if IPv4-mapped IPv6 (::ffff:0:0/96): also check embedded IPv4
  const ipv4MappedMask = ((1n << 128n) - 1n) ^ ((1n << 32n) - 1n);
  const ipv4MappedPrefix = 0xffffn << 32n;
  if ((bi & ipv4MappedMask) === ipv4MappedPrefix) {
    const embeddedIpv4 = bi & 0xffffffffn;
    const o0 = Number((embeddedIpv4 >> 24n) & 0xffn);
    const o1 = Number((embeddedIpv4 >> 16n) & 0xffn);
    const o2 = Number((embeddedIpv4 >> 8n) & 0xffn);
    const o3 = Number(embeddedIpv4 & 0xffn);
    const v4Str = `${o0}.${o1}.${o2}.${o3}`;
    const v4Prohibited = classifyProhibitedIpv4(v4Str);
    if (v4Prohibited) {
      return `IPv4-Mapped IPv6 pointing to prohibited range: ${v4Prohibited} (${v4Str})`;
    }
    return "IPv4-Mapped IPv6 address (non-globally routable IPv6)";
  }

  for (const range of PROHIBITED_IPV6_RANGES) {
    if ((bi & range.mask) === range.prefix) {
      return range.name;
    }
  }
  return null;
}

/**
 * Validates syntax of an internet hostname (RFC 1123 / RFC 952).
 */
export function validateHostnameSyntax(hostname: string): { valid: boolean; normalized?: string; reason?: string } {
  if (!hostname || typeof hostname !== "string") {
    return { valid: false, reason: "Hostname must be a non-empty string." };
  }
  let clean = hostname.trim();

  // Normalize single trailing dot for root-anchored FQDNs (RFC 1034)
  if (clean.endsWith(".") && !clean.endsWith("..")) {
    clean = clean.slice(0, -1);
  }

  if (clean.length < 1 || clean.length > 253) {
    return { valid: false, reason: "Hostname length must be between 1 and 253 characters." };
  }

  // Reject URL characters, userinfo, ports, schemes, paths, queries
  if (/[/@:?#\\% \t\r\n]/.test(clean)) {
    return {
      valid: false,
      reason: "Hostname contains illegal characters, URL schemes, credentials, or embedded ports.",
    };
  }

  if (clean.startsWith(".")) {
    return { valid: false, reason: "Hostname cannot start with a dot." };
  }
  if (clean.includes("..")) {
    return { valid: false, reason: "Hostname cannot contain consecutive dots." };
  }

  // Convert Internationalized Domain Names (IDN) to ASCII / Punycode
  let asciiDomain = clean;
  try {
    asciiDomain = domainToASCII(clean);
    if (!asciiDomain) {
      return { valid: false, reason: "Hostname contains invalid internationalized domain characters." };
    }
  } catch {
    return { valid: false, reason: "Hostname contains invalid internationalized domain characters." };
  }

  const labels = asciiDomain.split(".");
  if (labels.length < 2) {
    return { valid: false, reason: "Hostname must contain at least a domain name and TLD." };
  }

  for (const label of labels) {
    if (label.length < 1 || label.length > 63) {
      return { valid: false, reason: "Hostname label length must be between 1 and 63 characters." };
    }
    if (label.startsWith("-") || label.endsWith("-")) {
      return { valid: false, reason: "Hostname label cannot start or end with a hyphen." };
    }
    if (!/^[a-zA-Z0-9-]+$/.test(label)) {
      return { valid: false, reason: `Hostname label "${label}" contains invalid characters.` };
    }
  }

  const tld = labels[labels.length - 1].toLowerCase();
  // Reject pure-numeric TLDs (prevents decimal IP evasion like 2130706433)
  if (/^\d+$/.test(tld)) {
    return { valid: false, reason: "Top-level domain cannot be purely numeric." };
  }

  // Prohibited internal TLDs
  const prohibitedTlds = new Set([
    "local",
    "localhost",
    "internal",
    "lan",
    "home",
    "arpa",
    "invalid",
    "test",
    "example",
    "corp",
  ]);
  if (prohibitedTlds.has(tld)) {
    return { valid: false, reason: `Top-level domain ".${tld}" is reserved for internal networks.` };
  }

  if (asciiDomain.toLowerCase() === "localhost") {
    return { valid: false, reason: "Destination cannot be localhost." };
  }

  return { valid: true, normalized: asciiDomain };
}

/**
 * Validates format of an SMTP host field (either IPv4, bracketed IPv6, bare IPv6, or DNS hostname).
 */
export function validateSmtpHostFormat(hostInput: unknown): {
  type: "ipv4" | "ipv6" | "hostname";
  cleanHost: string;
} {
  if (typeof hostInput !== "string" || !hostInput.trim()) {
    throw new SmtpServiceError(400, "smtp_invalid", "SMTP host is required.");
  }
  let clean = hostInput.trim();

  // Strip brackets if IPv6
  let isBracketed = false;
  if (clean.startsWith("[") && clean.endsWith("]")) {
    clean = clean.slice(1, -1).trim();
    isBracketed = true;
  }

  // Reject URL scheme indicators
  if (clean.includes("://")) {
    throw new SmtpServiceError(
      400,
      "smtp_invalid",
      "SMTP host must not contain URL schemes (e.g. smtp:// or http://).",
    );
  }

  // Reject embedded credentials
  if (clean.includes("@")) {
    throw new SmtpServiceError(
      400,
      "smtp_invalid",
      "SMTP host must not contain user credentials (use username and password fields).",
    );
  }

  // Reject path separators or query strings
  if (/[/?#\\ ]/.test(clean)) {
    throw new SmtpServiceError(
      400,
      "smtp_invalid",
      "SMTP host contains invalid path, query, or whitespace characters.",
    );
  }

  // Check IPv4
  if (/^\d+\.\d+\.\d+\.\d+$/.test(clean)) {
    if (ipv4ToUint32(clean) === -1) {
      throw new SmtpServiceError(400, "smtp_invalid", "Invalid IPv4 address format.");
    }
    return { type: "ipv4", cleanHost: clean };
  }

  // Check IPv6
  if (clean.includes(":") || isBracketed) {
    if (ipv6ToBigInt(clean) === null) {
      throw new SmtpServiceError(400, "smtp_invalid", "Invalid IPv6 address format.");
    }
    return { type: "ipv6", cleanHost: clean };
  }

  // Must be DNS hostname
  const hostCheck = validateHostnameSyntax(clean);
  if (!hostCheck.valid) {
    throw new SmtpServiceError(400, "smtp_invalid", hostCheck.reason || "Invalid hostname format.");
  }

  return { type: "hostname", cleanHost: hostCheck.normalized || clean };
}

export interface DnsResolver {
  resolve4(hostname: string): Promise<string[]>;
  resolve6(hostname: string): Promise<string[]>;
}

export const systemDnsResolver: DnsResolver = {
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

export interface PinnedHostResult {
  isIp: boolean;
  canonicalHost: string;
  pinnedIp: string;
  family: 4 | 6;
  allResolvedIps: string[];
}

/**
 * Resolves a host input, validates every returned IP address against prohibited ranges,
 * and returns the securely pinned destination IP.
 */
export async function resolveAndValidateHost(
  hostInput: string,
  resolver: DnsResolver = systemDnsResolver,
): Promise<PinnedHostResult> {
  const { type, cleanHost } = validateSmtpHostFormat(hostInput);

  if (type === "ipv4") {
    const prohibited = classifyProhibitedIpv4(cleanHost);
    if (prohibited) {
      throw new SmtpServiceError(
        400,
        "smtp_prohibited_destination",
        `SMTP host ${cleanHost} is in a prohibited private or reserved network range (${prohibited}).`,
      );
    }
    return {
      isIp: true,
      canonicalHost: cleanHost,
      pinnedIp: cleanHost,
      family: 4,
      allResolvedIps: [cleanHost],
    };
  }

  if (type === "ipv6") {
    const prohibited = classifyProhibitedIpv6(cleanHost);
    if (prohibited) {
      throw new SmtpServiceError(
        400,
        "smtp_prohibited_destination",
        `SMTP host [${cleanHost}] is in a prohibited private or reserved network range (${prohibited}).`,
      );
    }
    return {
      isIp: true,
      canonicalHost: cleanHost,
      pinnedIp: cleanHost,
      family: 6,
      allResolvedIps: [cleanHost],
    };
  }

  // Hostname resolution
  let ipv4Addrs: string[] = [];
  let ipv6Addrs: string[] = [];
  try {
    const [v4, v6] = await Promise.all([
      resolver.resolve4(cleanHost),
      resolver.resolve6(cleanHost),
    ]);
    ipv4Addrs = v4;
    ipv6Addrs = v6;
  } catch (err: any) {
    throw new SmtpServiceError(
      400,
      "smtp_dns_resolution_failed",
      `Failed to resolve SMTP host "${cleanHost}": ${err.message || "DNS error"}`,
    );
  }

  const allAddrs: { ip: string; family: 4 | 6 }[] = [
    ...ipv4Addrs.map((ip) => ({ ip, family: 4 as const })),
    ...ipv6Addrs.map((ip) => ({ ip, family: 6 as const })),
  ];

  if (allAddrs.length === 0) {
    throw new SmtpServiceError(
      400,
      "smtp_dns_resolution_failed",
      `SMTP host "${cleanHost}" could not be resolved (no A or AAAA records found).`,
    );
  }

  // Validate EVERY address returned. If even one address is prohibited, reject the entire host!
  for (const addr of allAddrs) {
    if (addr.family === 4) {
      const prohibited = classifyProhibitedIpv4(addr.ip);
      if (prohibited) {
        throw new SmtpServiceError(
          400,
          "smtp_prohibited_destination",
          `SMTP host "${cleanHost}" resolves to prohibited IP ${addr.ip} (${prohibited}).`,
        );
      }
    } else {
      const prohibited = classifyProhibitedIpv6(addr.ip);
      if (prohibited) {
        throw new SmtpServiceError(
          400,
          "smtp_prohibited_destination",
          `SMTP host "${cleanHost}" resolves to prohibited IPv6 ${addr.ip} (${prohibited}).`,
        );
      }
    }
  }

  // Pin the first validated IP address for the socket connection
  const chosen = allAddrs[0];
  return {
    isIp: false,
    canonicalHost: cleanHost,
    pinnedIp: chosen.ip,
    family: chosen.family,
    allResolvedIps: allAddrs.map((a) => a.ip),
  };
}
