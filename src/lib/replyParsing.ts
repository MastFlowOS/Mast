/**
 * Pure parsing helpers for Email reply correlation, quote stripping,
 * Instagram DM notification email extraction, and idempotent dedupe keys.
 */
import { createHash } from "node:crypto";
import { extractInstagramHandle } from "./instagram.js";

/**
 * Extracts a lowercase canonical email address from strings like:
 *   `"Jane Doe" <Jane@Bakery.com>` -> `jane@bakery.com`
 *   `jane@bakery.com` -> `jane@bakery.com`
 */
export function normalizeEmailAddress(raw?: string | null): string | null {
  if (!raw || typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const angleMatch = trimmed.match(/<([^<>\s@]+@[^<>\s@]+\.[^<>\s@]+)>/);
  const candidate = (angleMatch ? angleMatch[1] : trimmed).trim().toLowerCase();

  // Strip surrounding quotes/mailto prefix if present
  const cleaned = candidate.replace(/^mailto:/i, "").replace(/^["']+|["']+$/g, "").trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleaned)) return null;
  return cleaned;
}

/**
 * Extracts normalized `<message-id@domain>` identifiers from In-Reply-To / References headers.
 */
export function extractMessageIds(raw?: string | string[] | null): string[] {
  if (!raw) return [];
  const joined = Array.isArray(raw) ? raw.join(" ") : raw;
  const matches = joined.match(/<[^<>\s]+@[^<>\s]+>/g) || [];
  const unique = new Set<string>();
  for (const m of matches) {
    unique.add(m.trim().toLowerCase());
  }
  return Array.from(unique);
}

/**
 * Strips quoted reply history ("On Mon, ... wrote:", lines starting with ">",
 * and common signature delimiters) so previews & AI triage focus on the new reply.
 */
export function stripQuotedReplyText(raw?: string | null): string {
  if (!raw || typeof raw !== "string") return "";
  const lines = raw.replace(/\r\n/g, "\n").split("\n");
  const kept: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (/^On .+wrote:\s*$/i.test(trimmed)) break;
    if (/^-{2,}\s*Original Message\s*-{2,}$/i.test(trimmed)) break;
    if (/^From:\s+.+@.+$/i.test(trimmed) && kept.length > 0) break;
    if (trimmed.startsWith(">")) continue;
    kept.push(line);
  }

  return kept.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

export interface InstagramNotificationParseResult {
  isInstagramAlert: boolean;
  handle: string | null;
  previewText: string | null;
}

const IG_ALERT_SENDER_DOMAINS = new Set(["mail.instagram.com", "instagram.com"]);

/**
 * Parses Instagram's own "New Direct Message" email notifications so freelancers
 * with personal/new IG accounts get reply alerts via email without sharing
 * IG passwords or needing Meta Business API approval.
 */
export function parseInstagramNotificationEmail(input: {
  from?: string | null;
  subject?: string | null;
  text?: string | null;
  html?: string | null;
}): InstagramNotificationParseResult {
  const fromEmail = normalizeEmailAddress(input.from);
  const fromDomain = fromEmail ? fromEmail.split("@")[1] : "";
  const subject = (input.subject || "").trim();
  const bodyPlain = (input.text || "").trim();
  const bodyHtmlStripped = (input.html || "")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const combinedBody = bodyPlain || bodyHtmlStripped;

  const isFromIg = IG_ALERT_SENDER_DOMAINS.has(fromDomain);
  const looksLikeIgDmSubject =
    /(?:sent you a (?:direct )?message|new (?:direct )?message(?:\s+from)?|replied to your (?:message|story))/i.test(
      subject,
    );

  if (!isFromIg && !looksLikeIgDmSubject) {
    return { isInstagramAlert: false, handle: null, previewText: null };
  }

  const looksLikeDmContent =
    looksLikeIgDmSubject ||
    /(?:sent you a (?:direct )?message|direct message|view message|reply on instagram)/i.test(
      combinedBody,
    );

  if (!looksLikeDmContent) {
    return { isInstagramAlert: false, handle: null, previewText: null };
  }

  let handle: string | null = null;

  // Pattern 1: explicit @handle in subject or body (prefer subject first)
  const subjectAtMatch = subject.match(/@([A-Za-z0-9_][A-Za-z0-9_.]{1,29})/);
  if (subjectAtMatch) {
    handle = extractInstagramHandle(subjectAtMatch[1]);
  }

  // Pattern 2: "<handle> sent you a message" in subject
  if (!handle) {
    const sentMatch = subject.match(
      /^([A-Za-z0-9_][A-Za-z0-9_.]{1,29})\s+(?:sent you a|replied to)/i,
    );
    if (sentMatch) {
      handle = extractInstagramHandle(sentMatch[1]);
    }
  }

  // Pattern 3: "New message from Name (@handle)"
  if (!handle) {
    const parenAtMatch = `${subject}\n${combinedBody}`.match(
      /\(@([A-Za-z0-9_][A-Za-z0-9_.]{1,29})\)/,
    );
    if (parenAtMatch) {
      handle = extractInstagramHandle(parenAtMatch[1]);
    }
  }

  // Pattern 4: instagram.com/<handle> link inside email body/html
  if (!handle) {
    const urlMatches = `${bodyPlain}\n${input.html || ""}`.matchAll(
      /https?:\/\/(?:www\.)?instagram\.com\/([A-Za-z0-9_][A-Za-z0-9_.]{1,29})\/?/gi,
    );
    for (const match of urlMatches) {
      const candidate = extractInstagramHandle(match[1]);
      if (candidate) {
        handle = candidate;
        break;
      }
    }
  }

  // Pattern 5: body "@handle sent you a message" or "@handle:"
  if (!handle) {
    const bodyAtMatch = combinedBody.match(/@([A-Za-z0-9_][A-Za-z0-9_.]{1,29})/);
    if (bodyAtMatch) {
      handle = extractInstagramHandle(bodyAtMatch[1]);
    }
  }

  // Extract a clean short snippet if Instagram included message text
  let previewText: string | null = null;
  const quotedSnippet = combinedBody.match(/[""]([^""\n]{2,200})[""]/);
  if (quotedSnippet?.[1]) {
    previewText = quotedSnippet[1].trim();
  } else if (bodyPlain) {
    const firstUsefulLine = bodyPlain
      .split("\n")
      .map((l) => l.trim())
      .find(
        (l) =>
          l.length > 0 &&
          !/^(hi|hello|open instagram|view message|this email was sent)/i.test(l) &&
          !l.includes("http"),
      );
    if (firstUsefulLine) {
      previewText = firstUsefulLine.slice(0, 180);
    }
  }

  return {
    isInstagramAlert: true,
    handle,
    previewText,
  };
}

/**
 * Builds a deterministic, collision-resistant dedupe key for notification &
 * reply ingestion idempotency.
 */
export function buildReplyDedupeKey(input: {
  channel: string;
  leadId: number;
  externalId?: string | null;
  snippet?: string | null;
}): string {
  const raw = input.externalId?.trim()
    ? `${input.channel}:${input.leadId}:id:${input.externalId.trim().toLowerCase()}`
    : `${input.channel}:${input.leadId}:text:${(input.snippet || "").trim().toLowerCase().slice(0, 240)}`;
  const digest = createHash("sha256").update(raw).digest("hex").slice(0, 24);
  return `reply_${input.channel}_${input.leadId}_${digest}`;
}
