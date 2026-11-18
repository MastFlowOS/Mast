/**
 * Reply Noise Filtering & AI Triage.
 *
 * Step 1 (deterministic, zero cost): Filters obvious bounces, DSNs, and
 * auto-responders via RFC headers (`Auto-Submitted`, `X-Autoreply`, etc.) and
 * sender/subject patterns.
 *
 * Step 2 (AI, when configured): Distinguishes real human replies from subtle
 * Out-of-Office messages, extracts intent, 1-line summary, and a suggested
 * follow-up draft. Falls back cleanly if AI is disabled or errors out.
 */
import { aiEnabled, generateJSON, getAiModel } from "./ai.js";
import { normalizeEmailAddress, stripQuotedReplyText } from "./replyParsing.js";

export type ReplyIntent =
  | "interested"
  | "question"
  | "pricing"
  | "objection"
  | "not_interested"
  | "ooo"
  | "bounce"
  | "other";

export interface ReplyTriageResult {
  isHumanReply: boolean;
  intent: ReplyIntent;
  summary: string;
  suggestedReply: string | null;
  usedAi: boolean;
}

const VALID_INTENTS = new Set<ReplyIntent>([
  "interested",
  "question",
  "pricing",
  "objection",
  "not_interested",
  "ooo",
  "bounce",
  "other",
]);

const BOUNCE_SENDERS = /^(mailer-daemon|postmaster|noreply|no-reply|bounce|bounces)@/i;
const BOUNCE_SUBJECT_RE =
  /(undeliverable|delivery status notification|mail delivery failed|returned mail|delivery failure|address not found)/i;
const OOO_SUBJECT_RE =
  /(automatic reply|auto-reply|autoreply|out of office|away from (?:the )?office|vacation reply|abwesenheitsnotiz)/i;

export function detectDeterministicNonReply(input: {
  from?: string | null;
  subject?: string | null;
  text?: string | null;
  headers?: Record<string, string | string[] | undefined>;
}): { isNonReply: boolean; reason: "bounce" | "ooo" | null } {
  const headers = input.headers || {};
  const normalizedHeaders: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    normalizedHeaders[k.toLowerCase()] = Array.isArray(v) ? v.join(" ") : String(v || "");
  }

  const autoSubmitted = (normalizedHeaders["auto-submitted"] || "").toLowerCase();
  if (autoSubmitted && autoSubmitted !== "no") {
    return {
      isNonReply: true,
      reason: autoSubmitted.includes("auto-replied") ? "ooo" : "bounce",
    };
  }

  if (
    normalizedHeaders["x-autoreply"] ||
    normalizedHeaders["x-autorespond"] ||
    /^(auto_reply|bulk|junk)$/i.test(normalizedHeaders["precedence"] || "")
  ) {
    return { isNonReply: true, reason: "ooo" };
  }

  const fromEmail = normalizeEmailAddress(input.from) || "";
  const subject = (input.subject || "").trim();
  if (BOUNCE_SENDERS.test(fromEmail) || BOUNCE_SUBJECT_RE.test(subject)) {
    return { isNonReply: true, reason: "bounce" };
  }
  if (OOO_SUBJECT_RE.test(subject)) {
    return { isNonReply: true, reason: "ooo" };
  }

  const bodyHead = (input.text || "").slice(0, 400);
  if (/^(?:thank you for your email|i am currently out of the office)/i.test(bodyHead.trim())) {
    return { isNonReply: true, reason: "ooo" };
  }

  return { isNonReply: false, reason: null };
}

export interface ReplyTriageDeps {
  aiEnabled: () => boolean;
  generateJSON: typeof generateJSON;
  getAiModel: typeof getAiModel;
}

const defaultDeps: ReplyTriageDeps = {
  aiEnabled,
  generateJSON,
  getAiModel,
};

export async function triageClientReply(
  input: {
    channel: "email" | "instagram";
    businessName: string;
    from?: string | null;
    subject?: string | null;
    text?: string | null;
    headers?: Record<string, string | string[] | undefined>;
  },
  deps: ReplyTriageDeps = defaultDeps,
): Promise<ReplyTriageResult> {
  const cleanText = stripQuotedReplyText(input.text);

  if (input.channel === "email") {
    const det = detectDeterministicNonReply({
      from: input.from,
      subject: input.subject,
      text: cleanText,
      headers: input.headers,
    });
    if (det.isNonReply) {
      return {
        isHumanReply: false,
        intent: det.reason === "bounce" ? "bounce" : "ooo",
        summary: det.reason === "bounce" ? "Delivery bounce notification" : "Automated out-of-office reply",
        suggestedReply: null,
        usedAi: false,
      };
    }
  }

  const fallbackSummary =
    cleanText.replace(/\s+/g, " ").trim().slice(0, 140) ||
    (input.subject ? `Replied: ${input.subject.slice(0, 120)}` : "Client replied to your message");

  if (!deps.aiEnabled() || !cleanText) {
    return {
      isHumanReply: true,
      intent: "other",
      summary: fallbackSummary,
      suggestedReply: null,
      usedAi: false,
    };
  }

  try {
    const parsed = await deps.generateJSON<{
      isHumanReply?: boolean;
      intent?: string;
      summary?: string;
      suggestedReply?: string | null;
    }>({
      tier: "fast",
      model: deps.getAiModel("fast"),
      feature: "reply_triage",
      maxTokens: 300,
      system:
        "You classify inbound client replies to freelancer outreach. Return strict JSON with keys: " +
        "`isHumanReply` (boolean; false ONLY for out-of-office, bounce notices, spam, or automated receipts), " +
        "`intent` (one of: interested, question, pricing, objection, not_interested, ooo, bounce, other), " +
        "`summary` (concise <= 120 char summary of what the client said), " +
        "`suggestedReply` (short friendly 1-3 sentence next reply for the freelancer, or null if not human).",
      user: JSON.stringify({
        channel: input.channel,
        businessName: input.businessName,
        subject: input.subject || "",
        replyText: cleanText.slice(0, 2000),
      }),
    });

    if (!parsed || typeof parsed !== "object") {
      throw new Error("Empty AI triage response");
    }

    const isHumanReply = parsed.isHumanReply !== false;
    const rawIntent = String(parsed.intent || "other").toLowerCase() as ReplyIntent;
    const intent: ReplyIntent = VALID_INTENTS.has(rawIntent) ? rawIntent : "other";
    const summary =
      typeof parsed.summary === "string" && parsed.summary.trim()
        ? parsed.summary.trim().slice(0, 160)
        : fallbackSummary;
    const suggestedReply =
      isHumanReply && typeof parsed.suggestedReply === "string" && parsed.suggestedReply.trim()
        ? parsed.suggestedReply.trim().slice(0, 1000)
        : null;

    return {
      isHumanReply,
      intent,
      summary,
      suggestedReply,
      usedAi: true,
    };
  } catch {
    // Graceful degradation: never drop a real reply just because AI failed
    return {
      isHumanReply: true,
      intent: "other",
      summary: fallbackSummary,
      suggestedReply: null,
      usedAi: false,
    };
  }
}
