import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../../middleware/auth.js";
import { createRateLimiter } from "../../middleware/rateLimit.js";
import { supabaseAdmin } from "../../lib/supabaseAdmin.js";
import { resolveWorkspaceContext } from "../../lib/workspaceContext.js";
import {
  checkDomainDeliverability,
  evaluatePacingGuardrails,
  matchesSuppression,
  normalizeSuppressionValue,
  signUnsubscribeToken,
  verifyUnsubscribeToken,
  type SuppressionEntry,
} from "../../lib/deliverability.js";

export const safetyRouter = Router();

const readLimiter = createRateLimiter({ windowMs: 60_000, max: 120 });
const writeLimiter = createRateLimiter({ windowMs: 60_000, max: 40 });
const dnsLimiter = createRateLimiter({ windowMs: 60_000, max: 15 });

export const safetyDeps = {
  db: supabaseAdmin as any,
  resolveWorkspaceContext,
  checkDomainDeliverability,
};

const AddSuppressionSchema = z.object({
  kind: z.enum(["email", "domain", "instagram"]),
  value: z.string().trim().min(2).max(320),
  reason: z.string().trim().max(300).optional().nullable(),
  source: z.enum(["manual", "bounce", "unsubscribe", "reply_optout"]).default("manual"),
});

const DomainCheckSchema = z.object({
  domainOrEmail: z.string().trim().min(3).max(320),
});

safetyRouter.get("/suppressions", requireAuth, readLimiter, async (req, res, next) => {
  try {
    const db = safetyDeps.db;
    const ctx = await safetyDeps.resolveWorkspaceContext(req.user!.id, db);
    const { data, error } = await db
      .from("workspace_suppressions")
      .select("id, kind, value, reason, source, created_at")
      .eq("owner_id", ctx.workspaceOwnerId)
      .order("created_at", { ascending: false })
      .limit(500);

    if (error) throw error;
    return res.json({ suppressions: data ?? [] });
  } catch (err) {
    next(err);
  }
});

safetyRouter.post("/suppressions", requireAuth, writeLimiter, async (req, res, next) => {
  try {
    const db = safetyDeps.db;
    const ctx = await safetyDeps.resolveWorkspaceContext(req.user!.id, db);
    const parsed = AddSuppressionSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ code: "invalid_input", message: "Valid suppression kind and value required." });
    }

    const normalized = normalizeSuppressionValue(parsed.data.kind, parsed.data.value);
    if (!normalized) {
      return res.status(400).json({ code: "invalid_value", message: "Suppression value cannot be empty." });
    }

    const { data, error } = await db
      .from("workspace_suppressions")
      .upsert(
        {
          owner_id: ctx.workspaceOwnerId,
          kind: parsed.data.kind,
          value: normalized,
          reason: parsed.data.reason || null,
          source: parsed.data.source,
        },
        { onConflict: "owner_id,kind,value" },
      )
      .select("id, kind, value, reason, source, created_at")
      .single();

    if (error) throw error;
    return res.status(201).json({ suppression: data });
  } catch (err) {
    next(err);
  }
});

safetyRouter.delete("/suppressions/:id", requireAuth, writeLimiter, async (req, res, next) => {
  try {
    const db = safetyDeps.db;
    const ctx = await safetyDeps.resolveWorkspaceContext(req.user!.id, db);
    const { error } = await db
      .from("workspace_suppressions")
      .delete()
      .eq("id", req.params.id)
      .eq("owner_id", ctx.workspaceOwnerId);

    if (error) throw error;
    return res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

safetyRouter.get("/check-lead/:leadId", requireAuth, readLimiter, async (req, res, next) => {
  try {
    const db = safetyDeps.db;
    const leadId = Number(req.params.leadId);
    if (!Number.isFinite(leadId) || leadId <= 0) {
      return res.status(400).json({ code: "invalid_lead_id", message: "Valid leadId required." });
    }
    const ctx = await safetyDeps.resolveWorkspaceContext(req.user!.id, db);

    const [{ data: lead, error: leadErr }, { data: suppressions, error: supErr }] = await Promise.all([
      db
        .from("leads")
        .select("id, email, website, instagram_handle")
        .eq("id", leadId)
        .eq("user_id", ctx.workspaceOwnerId)
        .maybeSingle(),
      db
        .from("workspace_suppressions")
        .select("id, kind, value, reason, source")
        .eq("owner_id", ctx.workspaceOwnerId),
    ]);

    if (leadErr) throw leadErr;
    if (supErr) throw supErr;
    if (!lead) return res.status(404).json({ code: "not_found", message: "Lead not found." });

    const match = matchesSuppression(
      {
        email: lead.email,
        website: lead.website,
        instagramHandle: lead.instagram_handle,
      },
      (suppressions ?? []) as SuppressionEntry[],
    );

    const unsubscribeToken = lead.email ? signUnsubscribeToken(ctx.workspaceOwnerId, lead.email) : null;

    return res.json({
      blocked: Boolean(match),
      match,
      unsubscribeToken,
    });
  } catch (err) {
    next(err);
  }
});

safetyRouter.get("/pacing", requireAuth, readLimiter, async (req, res, next) => {
  try {
    const db = safetyDeps.db;
    const ctx = await safetyDeps.resolveWorkspaceContext(req.user!.id, db);
    const now = Date.now();
    const oneHourAgo = new Date(now - 60 * 60 * 1000).toISOString();
    const oneDayAgo = new Date(now - 24 * 60 * 60 * 1000).toISOString();

    const { data: acts, error } = await db
      .from("lead_activities")
      .select("type, timestamp")
      .eq("user_id", ctx.workspaceOwnerId)
      .in("type", ["email_sent", "instagram_sent", "instagram_opened"])
      .gte("timestamp", oneDayAgo)
      .limit(1000);

    if (error) throw error;

    let emailsLast24h = 0;
    let igLast1h = 0;
    let igLast24h = 0;

    for (const row of acts ?? []) {
      if (row.type === "email_sent") {
        emailsLast24h++;
      } else if (row.type === "instagram_sent" || row.type === "instagram_opened") {
        igLast24h++;
        if (String(row.timestamp ?? "") >= oneHourAgo) {
          igLast1h++;
        }
      }
    }

    return res.json(evaluatePacingGuardrails({ emailsLast24h, igLast1h, igLast24h }));
  } catch (err) {
    next(err);
  }
});

safetyRouter.post("/domain-check", requireAuth, dnsLimiter, async (req, res, next) => {
  try {
    const parsed = DomainCheckSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ code: "invalid_input", message: "Provide a valid email address or domain." });
    }
    const report = await safetyDeps.checkDomainDeliverability(parsed.data.domainOrEmail);
    return res.json(report);
  } catch (err: any) {
    if (err instanceof Error && /valid sender email/i.test(err.message)) {
      return res.status(400).json({ code: "invalid_domain", message: err.message });
    }
    next(err);
  }
});

/**
 * GET /v1/safety/unsubscribe?token=...
 * Public 1-click opt-out endpoint signed with HMAC-SHA256.
 * Adds recipient to the workspace's Do-Not-Contact list and marks matching leads dead.
 */
safetyRouter.get("/unsubscribe", readLimiter, async (req, res, next) => {
  try {
    const token = typeof req.query.token === "string" ? req.query.token : "";
    const verified = verifyUnsubscribeToken(token);
    if (!verified) {
      return res
        .status(400)
        .type("html")
        .send(
          "<!doctype html><html><body style='font-family:sans-serif;padding:40px;background:#0b0f17;color:#e5e7eb'><h2>Invalid or expired opt-out link</h2><p>Please reply directly with 'stop' if you no longer wish to receive emails.</p></body></html>",
        );
    }

    const db = safetyDeps.db;
    await db.from("workspace_suppressions").upsert(
      {
        owner_id: verified.ownerId,
        kind: "email",
        value: verified.email,
        reason: "Recipient clicked 1-click unsubscribe link",
        source: "unsubscribe",
      },
      { onConflict: "owner_id,kind,value" },
    );

    try {
      await db
        .from("leads")
        .update({ status: "dead", updated_at: new Date().toISOString() })
        .eq("user_id", verified.ownerId)
        .ilike("email", verified.email);
    } catch {
      // Non-fatal
    }

    return res
      .status(200)
      .type("html")
      .send(
        `<!doctype html><html><body style='font-family:sans-serif;padding:40px;background:#0b0f17;color:#e5e7eb;max-width:520px;margin:0 auto'><h2>You've been unsubscribed</h2><p><strong>${verified.email}</strong> has been added to the Do-Not-Contact list and won't receive further outreach from this sender.</p></body></html>`,
      );
  } catch (err) {
    next(err);
  }
});
