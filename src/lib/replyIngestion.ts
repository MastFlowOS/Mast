/**
 * Unified Client Reply Ingestion & Real-Time Notification Dispatcher.
 *
 * Consumed by:
 *   1. IMAP background polling worker (`src/lib/imapSync.ts`)
 *   2. Inbound Reply-To / forwarding webhook (`POST /v1/inbox/inbound/:token`)
 *   3. Passive local Instagram inbox observer (`POST /v1/inbox/ig-sync`)
 */
import { extractInstagramHandle } from "./instagram.js";
import {
  buildReplyDedupeKey,
  extractMessageIds,
  normalizeEmailAddress,
  parseInstagramNotificationEmail,
  stripQuotedReplyText,
} from "./replyParsing.js";
import { triageClientReply, type ReplyIntent } from "./replyTriage.js";

export interface MatchedLeadRow {
  id: number;
  user_id: string;
  business_name: string;
  email?: string | null;
  instagram_handle?: string | null;
  status?: string | null;
  last_contacted_at?: string | null;
}

export interface EmailReplyInput {
  userId: string;
  from?: string | null;
  subject?: string | null;
  text?: string | null;
  html?: string | null;
  messageId?: string | null;
  inReplyTo?: string | null;
  references?: string | string[] | null;
  headers?: Record<string, string | string[] | undefined>;
  receivedAt?: string;
  igEmailAlertsEnabled?: boolean;
  source?: "imap" | "inbound_webhook";
}

export interface InstagramSyncEventInput {
  handle?: string | null;
  displayName?: string | null;
  previewText?: string | null;
  threadUrl?: string | null;
  observedAt?: string | null;
  unread?: boolean;
}

export interface ReplyIngestionResult {
  matched: boolean;
  recorded: boolean;
  duplicate: boolean;
  filteredNonReply: boolean;
  channel?: "email" | "instagram";
  leadId?: number;
  businessName?: string;
  intent?: ReplyIntent;
  reason?: string;
}

export interface ReplyDbClient {
  from(table: string): any;
}

const CONTACTED_STATUSES = new Set([
  "email_sent",
  "instagram_sent",
  "called",
  "replied",
  "meeting_booked",
  "contacted",
  "conversation",
  "proposal",
  "negotiation",
]);

const UPGRADEABLE_TO_REPLIED_STATUSES = new Set([
  "new",
  "discovered",
  "ready",
  "email_sent",
  "instagram_sent",
  "called",
  "contacted",
  "contact_form_sent",
  "outreach",
]);

function chooseBestLead(leads: MatchedLeadRow[]): MatchedLeadRow | null {
  if (!Array.isArray(leads) || leads.length === 0) return null;
  const nonDead = leads.filter((l) => String(l.status || "").toLowerCase() !== "dead");
  const pool = nonDead.length > 0 ? nonDead : leads;
  const sorted = [...pool].sort((a, b) => {
    const aContacted = a.last_contacted_at ? new Date(a.last_contacted_at).getTime() : 0;
    const bContacted = b.last_contacted_at ? new Date(b.last_contacted_at).getTime() : 0;
    if (bContacted !== aContacted) return bContacted - aContacted;
    return b.id - a.id;
  });
  return sorted[0] ?? null;
}

async function shouldCreateReplyNotification(db: ReplyDbClient, userId: string): Promise<boolean> {
  try {
    const { data } = await db
      .from("profiles")
      .select("settings")
      .eq("id", userId)
      .maybeSingle();
    const settings = (data?.settings as Record<string, unknown> | null) || null;
    if (!settings) return true;
    return settings.notifyOutreachReplies !== "false" && settings.notifyOutreachReplies !== false;
  } catch {
    return true;
  }
}

async function matchLeadByThreadHeaders(
  db: ReplyDbClient,
  userId: string,
  refIds: string[],
): Promise<MatchedLeadRow | null> {
  if (refIds.length === 0) return null;
  try {
    const { data: msgRows } = await db
      .from("lead_messages")
      .select("lead_id")
      .eq("user_id", userId)
      .in("external_message_id", refIds)
      .limit(5);
    const leadIds = Array.from(
      new Set((msgRows || []).map((r: any) => Number(r.lead_id)).filter((id: number) => Number.isFinite(id))),
    );
    if (leadIds.length === 0) return null;
    const { data: leads } = await db
      .from("leads")
      .select("id, user_id, business_name, email, instagram_handle, status, last_contacted_at")
      .eq("user_id", userId)
      .in("id", leadIds);
    return chooseBestLead(leads || []);
  } catch {
    return null;
  }
}

async function matchLeadByEmail(
  db: ReplyDbClient,
  userId: string,
  fromEmail: string,
): Promise<MatchedLeadRow | null> {
  const { data: leads } = await db
    .from("leads")
    .select("id, user_id, business_name, email, instagram_handle, status, last_contacted_at")
    .eq("user_id", userId)
    .ilike("email", fromEmail)
    .limit(10);
  return chooseBestLead(leads || []);
}

async function matchLeadByInstagramHandle(
  db: ReplyDbClient,
  userId: string,
  canonicalHandle: string | null,
  requireContacted: boolean,
  displayName?: string | null,
): Promise<MatchedLeadRow | null> {
  // Fetch user's leads that have a non-null instagram_handle and filter via canonical normalizer
  // because stored handles can be "@foo", "foo", or "https://instagram.com/foo".
  const { data: leads } = await db
    .from("leads")
    .select("id, user_id, business_name, email, instagram_handle, status, last_contacted_at")
    .eq("user_id", userId)
    .not("instagram_handle", "is", null)
    .limit(500);

  const candidates = (leads || []).filter((lead: MatchedLeadRow) => {
    if (!requireContacted) return true;
    const st = String(lead.status || "").toLowerCase();
    return Boolean(lead.last_contacted_at) || CONTACTED_STATUSES.has(st);
  });

  if (canonicalHandle) {
    const byHandle = candidates.filter(
      (lead: MatchedLeadRow) => extractInstagramHandle(lead.instagram_handle) === canonicalHandle,
    );
    if (byHandle.length > 0) return chooseBestLead(byHandle);
  }

  const normalizedName = (displayName || "").trim().toLowerCase().replace(/\s+/g, " ");
  if (normalizedName) {
    const byName = candidates.filter(
      (lead: MatchedLeadRow) =>
        (lead.business_name || "").trim().toLowerCase().replace(/\s+/g, " ") === normalizedName,
    );
    // Only auto-match by display name when unambiguous among contacted leads
    if (byName.length === 1) return byName[0];
  }

  return null;
}

export async function recordVerifiedClientReply(params: {
  db: ReplyDbClient;
  userId: string;
  lead: MatchedLeadRow;
  channel: "email" | "instagram";
  senderLabel: string;
  subject?: string | null;
  bodyText: string;
  summary: string;
  intent: ReplyIntent;
  suggestedReply?: string | null;
  externalId?: string | null;
  dedupeKey: string;
  receivedAt: string;
  source: string;
  threadUrl?: string | null;
}): Promise<{ recorded: boolean; duplicate: boolean }> {
  const {
    db,
    userId,
    lead,
    channel,
    senderLabel,
    subject,
    bodyText,
    summary,
    intent,
    suggestedReply,
    externalId,
    dedupeKey,
    receivedAt,
    source,
    threadUrl,
  } = params;

  const businessName = lead.business_name || senderLabel || "Client";
  const channelLabel = channel === "instagram" ? "Instagram" : "Email";
  const actionUrl = `/dashboard/leads/${lead.id}?channel=${channel}`;
  const notifTitle = `${businessName} replied on ${channelLabel}`;
  const notifBody = summary || `New ${channelLabel.toLowerCase()} response from ${senderLabel}.`;

  // 1. Dedupe & persist server notification (even if notification toast pref is off,
  // we still log the lead activity, or check preference before inserting notification).
  const notifyEnabled = await shouldCreateReplyNotification(db, userId);

  // Check dedupe against user_notifications or lead_activities metadata
  const { data: existingNotif } = await db
    .from("user_notifications")
    .select("id")
    .eq("user_id", userId)
    .eq("dedupe_key", dedupeKey)
    .maybeSingle();

  if (existingNotif) {
    return { recorded: false, duplicate: true };
  }

  if (notifyEnabled) {
    const { error: notifErr } = await db.from("user_notifications").insert({
      user_id: userId,
      lead_id: lead.id,
      type: "reply_received",
      channel,
      title: notifTitle,
      body: notifBody,
      action_url: actionUrl,
      dedupe_key: dedupeKey,
      metadata: {
        leadId: lead.id,
        businessName,
        channel,
        intent,
        summary,
        suggestedReply: suggestedReply || null,
        senderLabel,
        source,
        threadUrl: threadUrl || null,
      },
    });
    if (notifErr) {
      // 23505 = unique violation on dedupe_key (race-safe idempotency)
      if (notifErr.code === "23505") {
        return { recorded: false, duplicate: true };
      }
      throw notifErr;
    }
  }

  // 2. Log inbound reply on lead_activities timeline
  await db.from("lead_activities").insert({
    lead_id: lead.id,
    user_id: userId,
    type: "reply_received",
    timestamp: receivedAt,
    channel,
    subject: subject || null,
    body: bodyText.slice(0, 4000),
    content: `${channelLabel} reply from ${senderLabel}: ${summary}`,
    metadata: {
      source,
      intent,
      summary,
      suggestedReply: suggestedReply || null,
      externalId: externalId || null,
      dedupeKey,
      senderLabel,
      threadUrl: threadUrl || null,
    },
  });

  // 3. Log inbound message in lead_messages (best-effort for older schemas)
  try {
    await db.from("lead_messages").insert({
      lead_id: lead.id,
      user_id: userId,
      channel,
      template: "reply",
      subject: subject || null,
      content: bodyText.slice(0, 8000),
      status: "received",
      direction: "inbound",
      external_message_id: externalId || null,
      metadata: {
        intent,
        summary,
        suggestedReply: suggestedReply || null,
        source,
      },
    });
  } catch {
    // Non-fatal if migration 054 columns aren't applied yet
  }

  // 4. Advance lead status to 'replied' if appropriate (never downgrade meeting_booked/closed)
  const currentStatus = String(lead.status || "new").toLowerCase();
  if (UPGRADEABLE_TO_REPLIED_STATUSES.has(currentStatus)) {
    await db
      .from("leads")
      .update({
        status: "replied",
        updated_at: new Date().toISOString(),
      })
      .eq("id", lead.id)
      .eq("user_id", userId);
  }

  return { recorded: true, duplicate: false };
}

export async function ingestEmailReply(
  db: ReplyDbClient,
  input: EmailReplyInput,
  triageFn: typeof triageClientReply = triageClientReply,
): Promise<ReplyIngestionResult> {
  const receivedAt = input.receivedAt || new Date().toISOString();
  const source = input.source || "imap";

  // Layer 3A: Check if this email is an Instagram DM alert first
  if (input.igEmailAlertsEnabled !== false) {
    const igAlert = parseInstagramNotificationEmail({
      from: input.from,
      subject: input.subject,
      text: input.text,
      html: input.html,
    });

    if (igAlert.isInstagramAlert) {
      if (!igAlert.handle) {
        return {
          matched: false,
          recorded: false,
          duplicate: false,
          filteredNonReply: false,
          channel: "instagram",
          reason: "ig_alert_missing_handle",
        };
      }

      const lead = await matchLeadByInstagramHandle(db, input.userId, igAlert.handle, false);
      if (!lead) {
        return {
          matched: false,
          recorded: false,
          duplicate: false,
          filteredNonReply: false,
          channel: "instagram",
          reason: "no_matching_ig_lead",
        };
      }

      const snippet = igAlert.previewText || `@${igAlert.handle} sent you a message on Instagram`;
      const triage = await triageFn({
        channel: "instagram",
        businessName: lead.business_name,
        subject: input.subject,
        text: snippet,
      });

      const dedupeKey = buildReplyDedupeKey({
        channel: "instagram",
        leadId: lead.id,
        externalId: input.messageId || null,
        snippet,
      });

      const res = await recordVerifiedClientReply({
        db,
        userId: input.userId,
        lead,
        channel: "instagram",
        senderLabel: `@${igAlert.handle}`,
        subject: input.subject,
        bodyText: snippet,
        summary: triage.summary,
        intent: triage.intent,
        suggestedReply: triage.suggestedReply,
        externalId: input.messageId || null,
        dedupeKey,
        receivedAt,
        source: `${source}_ig_email_alert`,
      });

      return {
        matched: true,
        recorded: res.recorded,
        duplicate: res.duplicate,
        filteredNonReply: false,
        channel: "instagram",
        leadId: lead.id,
        businessName: lead.business_name,
        intent: triage.intent,
      };
    }
  }

  // Standard Email reply correlation
  const fromEmail = normalizeEmailAddress(input.from);
  const headerIds = [
    ...extractMessageIds(input.inReplyTo),
    ...extractMessageIds(input.references),
  ];

  let lead = await matchLeadByThreadHeaders(db, input.userId, headerIds);
  if (!lead && fromEmail) {
    lead = await matchLeadByEmail(db, input.userId, fromEmail);
  }

  if (!lead) {
    return {
      matched: false,
      recorded: false,
      duplicate: false,
      filteredNonReply: false,
      channel: "email",
      reason: "no_matching_email_lead",
    };
  }

  const rawBody = (input.text || "").trim() || (input.html || "").replace(/<[^>]+>/g, " ").trim();
  const cleanBody = stripQuotedReplyText(rawBody) || rawBody;

  const triage = await triageFn({
    channel: "email",
    businessName: lead.business_name,
    from: input.from,
    subject: input.subject,
    text: cleanBody,
    headers: input.headers,
  });

  if (!triage.isHumanReply) {
    return {
      matched: true,
      recorded: false,
      duplicate: false,
      filteredNonReply: true,
      channel: "email",
      leadId: lead.id,
      businessName: lead.business_name,
      intent: triage.intent,
      reason: `filtered_${triage.intent}`,
    };
  }

  const dedupeKey = buildReplyDedupeKey({
    channel: "email",
    leadId: lead.id,
    externalId: input.messageId || null,
    snippet: `${input.subject || ""}:${cleanBody}`,
  });

  const res = await recordVerifiedClientReply({
    db,
    userId: input.userId,
    lead,
    channel: "email",
    senderLabel: fromEmail || lead.email || lead.business_name,
    subject: input.subject,
    bodyText: cleanBody || "(Empty reply body)",
    summary: triage.summary,
    intent: triage.intent,
    suggestedReply: triage.suggestedReply,
    externalId: input.messageId || null,
    dedupeKey,
    receivedAt,
    source,
  });

  return {
    matched: true,
    recorded: res.recorded,
    duplicate: res.duplicate,
    filteredNonReply: false,
    channel: "email",
    leadId: lead.id,
    businessName: lead.business_name,
    intent: triage.intent,
  };
}

export async function ingestInstagramSyncEvents(
  db: ReplyDbClient,
  userId: string,
  events: InstagramSyncEventInput[],
  triageFn: typeof triageClientReply = triageClientReply,
): Promise<{ processed: number; recorded: number; duplicates: number; unmatched: number }> {
  let processed = 0;
  let recorded = 0;
  let duplicates = 0;
  let unmatched = 0;

  for (const ev of events) {
    processed++;
    const canonicalHandle = extractInstagramHandle(ev.handle);
    const displayName = (ev.displayName || "").trim();
    if (!canonicalHandle && !displayName) {
      unmatched++;
      continue;
    }

    // Require that the lead was actually contacted so personal/unrelated IG DMs
    // from friends never leak into Mast notifications.
    const lead = await matchLeadByInstagramHandle(db, userId, canonicalHandle, true, displayName);
    if (!lead) {
      unmatched++;
      continue;
    }

    const resolvedHandle = canonicalHandle || extractInstagramHandle(lead.instagram_handle) || lead.business_name;
    const senderLabel = resolvedHandle.startsWith("@") ? resolvedHandle : `@${resolvedHandle}`;
    const preview = (ev.previewText || "").trim() || `${senderLabel} replied in Instagram DMs`;
    const triage = await triageFn({
      channel: "instagram",
      businessName: lead.business_name,
      text: preview,
    });

    const dedupeKey = buildReplyDedupeKey({
      channel: "instagram",
      leadId: lead.id,
      externalId: null,
      snippet: preview,
    });

    const res = await recordVerifiedClientReply({
      db,
      userId,
      lead,
      channel: "instagram",
      senderLabel,
      subject: null,
      bodyText: preview,
      summary: triage.summary,
      intent: triage.intent,
      suggestedReply: triage.suggestedReply,
      externalId: null,
      dedupeKey,
      receivedAt: ev.observedAt || new Date().toISOString(),
      source: "ig_local_observer",
      threadUrl: ev.threadUrl || null,
    });

    if (res.recorded) recorded++;
    else if (res.duplicate) duplicates++;
  }

  return { processed, recorded, duplicates, unmatched };
}
