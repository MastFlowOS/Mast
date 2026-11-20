import crypto from "node:crypto";
import dns from "node:dns/promises";
import { env } from "../config/env.js";

export type SuppressionKind = "email" | "domain" | "instagram";

export interface SuppressionEntry {
  id: string;
  kind: SuppressionKind;
  value: string;
  reason?: string | null;
  source?: string | null;
}

export function extractDomain(input: string | null | undefined): string | null {
  if (!input || typeof input !== "string") return null;
  const trimmed = input.trim().toLowerCase();
  if (!trimmed) return null;
  if (trimmed.includes("@")) {
    const domain = trimmed.split("@")[1]?.trim() || "";
    return domain.replace(/^www\./, "") || null;
  }
  const stripped = trimmed
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .split(/[/?#:]/)[0]
    ?.replace(/\.+$/, "");
  return stripped || null;
}

export function normalizeSuppressionValue(kind: SuppressionKind, raw: string): string {
  const trimmed = raw.trim().toLowerCase();
  if (kind === "email") return trimmed;
  if (kind === "domain") return extractDomain(trimmed) ?? trimmed;
  // instagram
  return trimmed
    .replace(/^https?:\/\/(www\.)?instagram\.com\//, "")
    .replace(/^@/, "")
    .split(/[/?#]/)[0]
    .trim();
}

export function matchesSuppression(
  lead: { email?: string | null; website?: string | null; instagramHandle?: string | null },
  suppressions: SuppressionEntry[],
): SuppressionEntry | null {
  if (!suppressions.length) return null;
  const email = lead.email ? normalizeSuppressionValue("email", lead.email) : null;
  const emailDomain = email ? extractDomain(email) : null;
  const websiteDomain = lead.website ? extractDomain(lead.website) : null;
  const ig = lead.instagramHandle ? normalizeSuppressionValue("instagram", lead.instagramHandle) : null;

  for (const s of suppressions) {
    const v = normalizeSuppressionValue(s.kind, s.value);
    if (!v) continue;
    if (s.kind === "email" && email && v === email) return s;
    if (s.kind === "domain" && ((emailDomain && v === emailDomain) || (websiteDomain && v === websiteDomain))) {
      return s;
    }
    if (s.kind === "instagram" && ig && v === ig) return s;
  }
  return null;
}

// ─── Signed 1-Click Unsubscribe Tokens ───────────────────────────────────────

function getUnsubscribeSecret(): string {
  return process.env.SMTP_CREDENTIALS_KEY || env.SUPABASE_JWT_SECRET || "mast-unsub-fallback-key";
}

export function signUnsubscribeToken(ownerId: string, email: string): string {
  const normalizedEmail = normalizeSuppressionValue("email", email);
  const payload = Buffer.from(JSON.stringify({ o: ownerId, e: normalizedEmail }), "utf8").toString("base64url");
  const sig = crypto
    .createHmac("sha256", getUnsubscribeSecret())
    .update(payload)
    .digest("base64url");
  return `${payload}.${sig}`;
}

export function verifyUnsubscribeToken(token: string): { ownerId: string; email: string } | null {
  if (!token || typeof token !== "string" || !token.includes(".")) return null;
  const [payload, sig] = token.split(".");
  if (!payload || !sig) return null;
  const expected = crypto
    .createHmac("sha256", getUnsubscribeSecret())
    .update(payload)
    .digest("base64url");

  const sigBuf = Buffer.from(sig);
  const expBuf = Buffer.from(expected);
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
    return null;
  }

  try {
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (typeof parsed?.o === "string" && typeof parsed?.e === "string" && parsed.e.includes("@")) {
      return { ownerId: parsed.o, email: normalizeSuppressionValue("email", parsed.e) };
    }
    return null;
  } catch {
    return null;
  }
}

// ─── Spam & Ban Pacing Guardrails ────────────────────────────────────────────

export interface PacingAssessment {
  email: {
    sentLast24h: number;
    softLimit: number;
    hardLimit: number;
    level: "ok" | "warning" | "danger";
    message: string | null;
  };
  instagram: {
    last1h: number;
    last24h: number;
    hourlyLimit: number;
    dailyLimit: number;
    level: "ok" | "warning" | "danger";
    message: string | null;
  };
}

export function evaluatePacingGuardrails(counts: {
  emailsLast24h: number;
  igLast1h: number;
  igLast24h: number;
}): PacingAssessment {
  const emailSoft = 35;
  const emailHard = 60;
  const igHourly = 15;
  const igDaily = 40;

  let emailLevel: "ok" | "warning" | "danger" = "ok";
  let emailMsg: string | null = null;
  if (counts.emailsLast24h >= emailHard) {
    emailLevel = "danger";
    emailMsg = `You've sent ${counts.emailsLast24h} emails in the last 24h. Pause or slow down so your domain doesn't land in spam.`;
  } else if (counts.emailsLast24h >= emailSoft) {
    emailLevel = "warning";
    emailMsg = `Heads up: ${counts.emailsLast24h} emails sent in the last 24h. Keeping cold volume under ~${emailHard}/day per mailbox protects deliverability.`;
  }

  let igLevel: "ok" | "warning" | "danger" = "ok";
  let igMsg: string | null = null;
  if (counts.igLast1h >= igHourly || counts.igLast24h >= igDaily) {
    igLevel = "danger";
    igMsg = `High Instagram DM pace (${counts.igLast1h}/hr, ${counts.igLast24h}/24h). Take a break to avoid an Instagram action block or shadowban.`;
  } else if (counts.igLast1h >= 10 || counts.igLast24h >= 25) {
    igLevel = "warning";
    igMsg = `Moderate Instagram DM pace (${counts.igLast1h}/hr, ${counts.igLast24h}/24h). Space out DMs naturally to keep your account safe.`;
  }

  return {
    email: {
      sentLast24h: counts.emailsLast24h,
      softLimit: emailSoft,
      hardLimit: emailHard,
      level: emailLevel,
      message: emailMsg,
    },
    instagram: {
      last1h: counts.igLast1h,
      last24h: counts.igLast24h,
      hourlyLimit: igHourly,
      dailyLimit: igDaily,
      level: igLevel,
      message: igMsg,
    },
  };
}

// ─── Domain Deliverability Check (SPF / DMARC / DKIM / MX) ───────────────────

export interface DeliverabilityRecordCheck {
  status: "pass" | "warn" | "fail";
  record: string | null;
  detail: string;
}

export interface DomainDeliverabilityReport {
  domain: string;
  overall: "good" | "needs_attention" | "at_risk";
  mx: DeliverabilityRecordCheck;
  spf: DeliverabilityRecordCheck;
  dmarc: DeliverabilityRecordCheck;
  dkim: DeliverabilityRecordCheck;
  checkedAt: string;
}

export interface DeliverabilityDnsResolver {
  resolveTxt(host: string): Promise<string[][]>;
  resolveMx(host: string): Promise<Array<{ exchange: string; priority: number }>>;
}

const defaultDnsResolver: DeliverabilityDnsResolver = {
  resolveTxt: async (host) => {
    try {
      return await dns.resolveTxt(host);
    } catch {
      return [];
    }
  },
  resolveMx: async (host) => {
    try {
      return await dns.resolveMx(host);
    } catch {
      return [];
    }
  },
};

const COMMON_DKIM_SELECTORS = ["google", "default", "selector1", "selector2", "k1", "s1", "mail", "zoho"];

export async function checkDomainDeliverability(
  emailOrDomain: string,
  resolver: DeliverabilityDnsResolver = defaultDnsResolver,
): Promise<DomainDeliverabilityReport> {
  const domain = extractDomain(emailOrDomain);
  if (!domain || !/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(domain)) {
    throw new Error("Please enter a valid sender email or domain (e.g. you@youragency.com).");
  }

  const safeMx = async (host: string) => {
    try {
      return await resolver.resolveMx(host);
    } catch {
      return [];
    }
  };
  const safeTxt = async (host: string) => {
    try {
      return await resolver.resolveTxt(host);
    } catch {
      return [];
    }
  };

  const [mxRecords, rootTxt, dmarcTxt, ...dkimResults] = await Promise.all([
    safeMx(domain),
    safeTxt(domain),
    safeTxt(`_dmarc.${domain}`),
    ...COMMON_DKIM_SELECTORS.map(async (sel) => {
      const txts = await safeTxt(`${sel}._domainkey.${domain}`);
      const joined = txts.map((parts) => parts.join("")).find((r) => /v=dkim1|p=/i.test(r));
      return joined ? { selector: sel, record: joined } : null;
    }),
  ]);

  const flatRootTxt = rootTxt.map((parts) => parts.join(""));
  const spfRecord = flatRootTxt.find((r) => /^v=spf1\b/i.test(r.trim())) ?? null;

  const flatDmarcTxt = dmarcTxt.map((parts) => parts.join(""));
  const dmarcRecord = flatDmarcTxt.find((r) => /^v=dmarc1\b/i.test(r.trim())) ?? null;

  const dkimFound = dkimResults.find(Boolean) ?? null;

  const mx: DeliverabilityRecordCheck =
    mxRecords.length > 0
      ? {
          status: "pass",
          record: mxRecords.map((m) => m.exchange).slice(0, 2).join(", "),
          detail: "Mail servers (MX) are properly configured to receive replies.",
        }
      : {
          status: "fail",
          record: null,
          detail: "No MX records found — replies may bounce and spam filters penalize domains without MX.",
        };

  const spf: DeliverabilityRecordCheck = spfRecord
    ? {
        status: "pass",
        record: spfRecord,
        detail: "SPF record found — tells inboxes which servers are allowed to send email for your domain.",
      }
    : {
        status: "fail",
        record: null,
        detail: "Missing SPF TXT record. Add a `v=spf1` record in your domain DNS so Gmail/Outlook don't mark you as spam.",
      };

  const dmarc: DeliverabilityRecordCheck = dmarcRecord
    ? {
        status: "pass",
        record: dmarcRecord,
        detail: "DMARC policy detected — helps protect your domain reputation.",
      }
    : {
        status: "warn",
        record: null,
        detail: "Missing `_dmarc` TXT record. Adding `v=DMARC1; p=none;` improves Gmail & Yahoo inbox placement.",
      };

  const dkim: DeliverabilityRecordCheck = dkimFound
    ? {
        status: "pass",
        record: `${dkimFound.selector}._domainkey.${domain}`,
        detail: `DKIM signing key detected (selector: ${dkimFound.selector}).`,
      }
    : {
        status: "warn",
        record: null,
        detail: "No standard DKIM selector detected automatically. Verify DKIM is enabled in your email host (Google Workspace, Zoho, etc.).",
      };

  const overall: DomainDeliverabilityReport["overall"] =
    mx.status === "fail" || spf.status === "fail"
      ? "at_risk"
      : dmarc.status === "warn" || dkim.status === "warn"
        ? "needs_attention"
        : "good";

  return {
    domain,
    overall,
    mx,
    spf,
    dmarc,
    dkim,
    checkedAt: new Date().toISOString(),
  };
}

// ─── Booking Webhook Parser (Calendly / Cal.com / Custom) ────────────────────

export interface ParsedBookingEvent {
  provider: "calendly" | "calcom" | "custom";
  isBooked: boolean;
  inviteeEmail: string | null;
  inviteeName: string | null;
  startTime: string | null;
  meetingTitle: string | null;
}

export function parseBookingWebhookPayload(raw: any): ParsedBookingEvent {
  if (!raw || typeof raw !== "object") {
    return {
      provider: "custom",
      isBooked: false,
      inviteeEmail: null,
      inviteeName: null,
      startTime: null,
      meetingTitle: null,
    };
  }

  // Calendly webhook v2: { event: "invitee.created", payload: { email, name, scheduled_event: { name, start_time } } }
  if (typeof raw.event === "string" && raw.payload && typeof raw.payload === "object") {
    const evt = raw.event.toLowerCase();
    const isBooked = evt === "invitee.created";
    const p = raw.payload;
    return {
      provider: "calendly",
      isBooked,
      inviteeEmail: typeof p.email === "string" ? normalizeSuppressionValue("email", p.email) : null,
      inviteeName: typeof p.name === "string" ? p.name.trim() : null,
      startTime: typeof p.scheduled_event?.start_time === "string" ? p.scheduled_event.start_time : null,
      meetingTitle: typeof p.scheduled_event?.name === "string" ? p.scheduled_event.name : null,
    };
  }

  // Cal.com webhook: { triggerEvent: "BOOKING_CREATED", payload: { title, startTime, attendees: [{ email, name }] } }
  if (typeof raw.triggerEvent === "string" && raw.payload && typeof raw.payload === "object") {
    const evt = raw.triggerEvent.toUpperCase();
    const isBooked = evt === "BOOKING_CREATED" || evt === "BOOKING_RESCHEDULED";
    const p = raw.payload;
    const attendee = Array.isArray(p.attendees) ? p.attendees[0] : null;
    const email =
      typeof attendee?.email === "string"
        ? attendee.email
        : typeof p.responses?.email?.value === "string"
          ? p.responses.email.value
          : typeof p.email === "string"
            ? p.email
            : null;
    const name =
      typeof attendee?.name === "string"
        ? attendee.name
        : typeof p.responses?.name?.value === "string"
          ? p.responses.name.value
          : null;
    return {
      provider: "calcom",
      isBooked,
      inviteeEmail: email ? normalizeSuppressionValue("email", email) : null,
      inviteeName: name ? String(name).trim() : null,
      startTime: typeof p.startTime === "string" ? p.startTime : null,
      meetingTitle: typeof p.title === "string" ? p.title : null,
    };
  }

  // Generic JSON webhook: { email, name?, startTime?, title? }
  const email = typeof raw.email === "string" ? normalizeSuppressionValue("email", raw.email) : null;
  return {
    provider: "custom",
    isBooked: Boolean(email),
    inviteeEmail: email,
    inviteeName: typeof raw.name === "string" ? raw.name.trim() : null,
    startTime: typeof raw.startTime === "string" ? raw.startTime : null,
    meetingTitle: typeof raw.title === "string" ? raw.title : "Discovery Call",
  };
}
