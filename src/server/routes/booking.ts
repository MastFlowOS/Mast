import crypto from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../../middleware/auth.js";
import { createRateLimiter } from "../../middleware/rateLimit.js";
import { supabaseAdmin } from "../../lib/supabaseAdmin.js";
import { resolveWorkspaceContext } from "../../lib/workspaceContext.js";
import { parseBookingWebhookPayload } from "../../lib/deliverability.js";

export const bookingRouter = Router();

const readLimiter = createRateLimiter({ windowMs: 60_000, max: 120 });
const writeLimiter = createRateLimiter({ windowMs: 60_000, max: 30 });
const webhookLimiter = createRateLimiter({ windowMs: 60_000, max: 120 });

export const bookingDeps = {
  db: supabaseAdmin as any,
  resolveWorkspaceContext,
};

const SaveBookingSchema = z.object({
  provider: z.enum(["calcom", "calendly", "custom"]).default("calcom"),
  bookingUrl: z
    .string()
    .trim()
    .max(500)
    .optional()
    .nullable()
    .refine(
      (v) => !v || /^https?:\/\/[^\s]+$/i.test(v),
      "Booking URL must start with http:// or https://",
    ),
  autoMoveStage: z.boolean().default(true),
});

function newWebhookToken(): string {
  return crypto.randomBytes(24).toString("base64url");
}

async function ensureBookingRow(ownerId: string, db: any) {
  const { data: existing, error } = await db
    .from("workspace_booking_settings")
    .select("*")
    .eq("owner_id", ownerId)
    .maybeSingle();

  if (error) throw error;
  if (existing) return existing;

  const token = newWebhookToken();
  const { data: created, error: insErr } = await db
    .from("workspace_booking_settings")
    .insert({
      owner_id: ownerId,
      provider: "calcom",
      booking_url: null,
      webhook_token: token,
      auto_move_stage: true,
    })
    .select("*")
    .single();
  if (insErr) throw insErr;
  return created;
}

bookingRouter.get("/settings", requireAuth, readLimiter, async (req, res, next) => {
  try {
    const db = bookingDeps.db;
    const ctx = await bookingDeps.resolveWorkspaceContext(req.user!.id, db);
    const row = await ensureBookingRow(ctx.workspaceOwnerId, db);

    return res.json({
      provider: row.provider,
      bookingUrl: row.booking_url ?? "",
      webhookToken: row.webhook_token,
      autoMoveStage: Boolean(row.auto_move_stage),
      lastEventAt: row.last_event_at ?? null,
    });
  } catch (err) {
    next(err);
  }
});

bookingRouter.put("/settings", requireAuth, writeLimiter, async (req, res, next) => {
  try {
    const db = bookingDeps.db;
    const ctx = await bookingDeps.resolveWorkspaceContext(req.user!.id, db);
    if (ctx.role !== "owner" && ctx.role !== "admin") {
      return res.status(403).json({
        code: "forbidden",
        message: "Only workspace owners or admins can edit booking settings.",
      });
    }

    const parsed = SaveBookingSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({
        code: "invalid_input",
        message: parsed.error.issues[0]?.message || "Invalid booking settings.",
      });
    }

    const existing = await ensureBookingRow(ctx.workspaceOwnerId, db);
    const { data: updated, error } = await db
      .from("workspace_booking_settings")
      .update({
        provider: parsed.data.provider,
        booking_url: parsed.data.bookingUrl ? parsed.data.bookingUrl.trim() : null,
        auto_move_stage: parsed.data.autoMoveStage,
        updated_at: new Date().toISOString(),
      })
      .eq("owner_id", ctx.workspaceOwnerId)
      .select("*")
      .single();

    if (error) throw error;

    return res.json({
      provider: updated.provider,
      bookingUrl: updated.booking_url ?? "",
      webhookToken: updated.webhook_token ?? existing.webhook_token,
      autoMoveStage: Boolean(updated.auto_move_stage),
      lastEventAt: updated.last_event_at ?? null,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /v1/booking/webhook/:token
 * Public webhook receiver for Calendly (invitee.created), Cal.com (BOOKING_CREATED),
 * or custom booking webhooks. Matches the invitee email against workspace leads
 * and automatically moves them to "meeting_booked" + fires a real-time alert.
 */
bookingRouter.post("/webhook/:token", webhookLimiter, async (req, res, next) => {
  try {
    const token = String(req.params.token ?? "").trim();
    if (!token || token.length < 16) {
      return res.status(400).json({ code: "invalid_token", message: "Invalid booking webhook token." });
    }

    const db = bookingDeps.db;
    const { data: settings, error: setErr } = await db
      .from("workspace_booking_settings")
      .select("*")
      .eq("webhook_token", token)
      .maybeSingle();

    if (setErr) throw setErr;
    if (!settings) {
      return res.status(404).json({ code: "not_found", message: "Booking webhook not found." });
    }

    const parsed = parseBookingWebhookPayload(req.body);
    const nowIso = new Date().toISOString();

    await db
      .from("workspace_booking_settings")
      .update({ last_event_at: nowIso, updated_at: nowIso })
      .eq("owner_id", settings.owner_id);

    if (!parsed.isBooked || !parsed.inviteeEmail) {
      return res.status(200).json({ ok: true, ignored: true, reason: "Not a booking creation event or missing email." });
    }

    const { data: lead, error: leadErr } = await db
      .from("leads")
      .select("id, business_name, email, status")
      .eq("user_id", settings.owner_id)
      .ilike("email", parsed.inviteeEmail)
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (leadErr) throw leadErr;
    if (!lead) {
      return res.status(200).json({
        ok: true,
        matched: false,
        email: parsed.inviteeEmail,
      });
    }

    const shouldMoveStage =
      Boolean(settings.auto_move_stage) && String(lead.status ?? "").toLowerCase() !== "closed";
    if (shouldMoveStage) {
      await db
        .from("leads")
        .update({ status: "meeting_booked", updated_at: nowIso })
        .eq("id", lead.id)
        .eq("user_id", settings.owner_id);
    }

    const whenText = parsed.startTime
      ? ` for ${new Date(parsed.startTime).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" })}`
      : "";
    const summary = `${parsed.inviteeName || parsed.inviteeEmail} booked ${parsed.meetingTitle || "a call"}${whenText} via ${parsed.provider}`;

    try {
      await db.from("lead_activities").insert({
        lead_id: lead.id,
        user_id: settings.owner_id,
        type: "meeting_booked",
        channel: "email",
        timestamp: nowIso,
        content: summary,
        metadata: {
          provider: parsed.provider,
          inviteeEmail: parsed.inviteeEmail,
          inviteeName: parsed.inviteeName,
          startTime: parsed.startTime,
          meetingTitle: parsed.meetingTitle,
        },
      });
    } catch {
      // Non-fatal
    }

    try {
      await db.from("user_notifications").insert({
        user_id: settings.owner_id,
        lead_id: lead.id,
        type: "meeting_booked",
        channel: "email",
        title: `Meeting booked: ${lead.business_name}`,
        body: summary,
        action_url: `/dashboard/leads/${lead.id}`,
        dedupe_key: `booking:${lead.id}:${parsed.startTime || nowIso.slice(0, 16)}`,
        metadata: { provider: parsed.provider, startTime: parsed.startTime },
      });
    } catch {
      // Non-fatal
    }

    return res.status(200).json({
      ok: true,
      matched: true,
      leadId: lead.id,
      statusUpdated: shouldMoveStage,
    });
  } catch (err) {
    next(err);
  }
});
