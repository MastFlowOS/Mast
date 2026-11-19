/**
 * Inbox Observation & Reply Sync Routes (/v1/inbox)
 *
 * - GET    /v1/inbox/settings       Safe connection status + inbound webhook token
 * - PUT    /v1/inbox/settings       Save encrypted IMAP credentials + IG email alert preference
 * - POST   /v1/inbox/test           Test IMAP connectivity (SSRF-safe)
 * - POST   /v1/inbox/sync-now       Immediate incremental IMAP poll for authenticated user
 * - DELETE /v1/inbox/settings       Remove stored IMAP credentials
 * - POST   /v1/inbox/inbound/:token Token-authenticated inbound email webhook (Forwarding / Reply-To)
 * - POST   /v1/inbox/ig-sync        Authenticated passive local Instagram DM observer sync
 */
import crypto from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../../middleware/auth.js";
import { createRateLimiter } from "../../middleware/rateLimit.js";
import { supabaseAdmin } from "../../lib/supabaseAdmin.js";
import {
  decryptInboxPassword,
  decryptSmtpPasswordForInbox,
  encryptInboxPassword,
  InboxCryptoError,
  isInboxKeyConfigured,
} from "../../lib/inboxCrypto.js";
import { InboxHostError, validateImapHost } from "../../lib/inboxHostValidator.js";
import { pollUserImapInbox, testImapConnection } from "../../lib/imapSync.js";
import {
  ingestEmailReply,
  ingestInstagramSyncEvents,
  type ReplyDbClient,
} from "../../lib/replyIngestion.js";

export const inboxRouter = Router();

const syncLimiter = createRateLimiter({ windowMs: 60_000, max: 12 });
const inboundLimiter = createRateLimiter({ windowMs: 60_000, max: 120 });
const igSyncLimiter = createRateLimiter({ windowMs: 60_000, max: 60 });

export const inboxDeps = {
  db: supabaseAdmin as ReplyDbClient,
  isEncryptionConfigured: () => isInboxKeyConfigured(),
  encryptPassword: encryptInboxPassword,
  decryptPassword: decryptInboxPassword,
  decryptSmtpPassword: decryptSmtpPasswordForInbox,
  validateImapHost,
  testImapConnection,
  pollUserImapInbox,
  ingestEmailReply,
  ingestInstagramSyncEvents,
};

async function resolveSavedSmtpPassword(userId: string): Promise<string | null> {
  const { data: smtpRow, error } = await inboxDeps.db
    .from("user_smtp_credentials")
    .select("password_ciphertext")
    .eq("user_id", userId)
    .maybeSingle();

  if (error || !smtpRow?.password_ciphertext) {
    return null;
  }
  return inboxDeps.decryptSmtpPassword(smtpRow.password_ciphertext, userId);
}

function generateInboundToken(): string {
  return crypto.randomBytes(24).toString("base64url");
}

const SaveInboxSettingsSchema = z.object({
  provider: z.enum(["imap", "inbound_only"]).default("imap"),
  imapHost: z.string().trim().max(255).optional().nullable(),
  imapPort: z.coerce.number().int().min(1).max(65535).optional().nullable(),
  imapUsername: z.string().trim().max(320).optional().nullable(),
  imapPassword: z.string().max(500).optional().nullable(),
  useSmtpPassword: z.boolean().optional().default(false),
  imapTls: z.boolean().optional().default(true),
  igEmailAlertsEnabled: z.boolean().optional().default(true),
  enabled: z.boolean().optional().default(true),
});

const TestImapSchema = z.object({
  imapHost: z.string().trim().min(1).max(255),
  imapPort: z.coerce.number().int().min(1).max(65535),
  imapUsername: z.string().trim().min(1).max(320),
  imapPassword: z.string().max(500).optional(),
  useSmtpPassword: z.boolean().optional().default(false),
  imapTls: z.boolean().optional().default(true),
});

const IgSyncSchema = z.object({
  events: z
    .array(
      z
        .object({
          handle: z.string().trim().max(120).optional().nullable(),
          displayName: z.string().trim().max(200).optional().nullable(),
          previewText: z.string().max(1000).optional().nullable(),
          threadUrl: z.string().max(500).optional().nullable(),
          observedAt: z.string().max(80).optional().nullable(),
          unread: z.boolean().optional(),
        })
        .refine((ev) => Boolean(ev.handle?.trim() || ev.displayName?.trim()), {
          message: "Either handle or displayName is required",
        }),
    )
    .min(1)
    .max(50),
});

function toSafeSettingsResponse(row: Record<string, any> | null, encryptionConfigured: boolean) {
  const inboundToken = row?.inbound_token ?? null;
  return {
    configured: Boolean(row?.provider === "imap" && row?.imap_host && row?.imap_username && row?.password_ciphertext),
    provider: (row?.provider as "imap" | "inbound_only") ?? "inbound_only",
    imapHost: row?.imap_host ?? "",
    imapPort: row?.imap_port ? String(row.imap_port) : "993",
    imapUsername: row?.imap_username ?? "",
    imapTls: row?.imap_tls !== false,
    hasPassword: Boolean(row?.password_ciphertext),
    inboundToken,
    inboundWebhookPath: inboundToken ? `/v1/inbox/inbound/${inboundToken}` : null,
    igEmailAlertsEnabled: row?.ig_email_alerts_enabled !== false,
    enabled: row?.enabled !== false,
    lastSyncedAt: row?.last_synced_at ?? null,
    lastSyncStatus: row?.last_sync_status ?? null,
    lastSyncError: row?.last_sync_error ?? null,
    encryptionConfigured,
  };
}

inboxRouter.get("/settings", requireAuth, async (req, res, next) => {
  try {
    const userId = req.user!.id;
    const encryptionConfigured = inboxDeps.isEncryptionConfigured();

    let { data: row, error } = await inboxDeps.db
      .from("user_inbox_connections")
      .select(
        "user_id, provider, imap_host, imap_port, imap_username, imap_tls, password_ciphertext, inbound_token, ig_email_alerts_enabled, enabled, last_synced_at, last_sync_status, last_sync_error",
      )
      .eq("user_id", userId)
      .maybeSingle();

    if (error) {
      return res.status(500).json({ code: "inbox_load_failed", message: "Could not load inbox settings." });
    }

    // Lazily provision an inbound_token row so forwarding/webhook + IG email
    // alert settings work even before the user configures IMAP.
    if (!row) {
      const token = generateInboundToken();
      const { data: inserted, error: insertErr } = await inboxDeps.db
        .from("user_inbox_connections")
        .insert({
          user_id: userId,
          provider: "inbound_only",
          inbound_token: token,
          ig_email_alerts_enabled: true,
          enabled: true,
        })
        .select(
          "user_id, provider, imap_host, imap_port, imap_username, imap_tls, password_ciphertext, inbound_token, ig_email_alerts_enabled, enabled, last_synced_at, last_sync_status, last_sync_error",
        )
        .single();
      if (!insertErr && inserted) {
        row = inserted;
      }
    }

    return res.json(toSafeSettingsResponse(row, encryptionConfigured));
  } catch (err) {
    return next(err);
  }
});

inboxRouter.put("/settings", requireAuth, async (req, res, next) => {
  try {
    const userId = req.user!.id;
    const parsed = SaveInboxSettingsSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({
        code: "invalid_inbox_settings",
        message: parsed.error.issues[0]?.message || "Invalid inbox settings payload.",
      });
    }

    const input = parsed.data;
    const encryptionConfigured = inboxDeps.isEncryptionConfigured();

    const { data: existing } = await inboxDeps.db
      .from("user_inbox_connections")
      .select("inbound_token, password_ciphertext, imap_host, imap_port, imap_username")
      .eq("user_id", userId)
      .maybeSingle();

    let passwordCiphertext: string | null = existing?.password_ciphertext ?? null;
    let imapHost: string | null = null;
    let imapPort: number | null = null;
    let imapUsername: string | null = null;

    if (input.provider === "imap") {
      if (!input.imapHost || !input.imapPort || !input.imapUsername) {
        return res.status(400).json({
          code: "incomplete_imap_settings",
          message: "IMAP host, port, and username are required.",
        });
      }

      await inboxDeps.validateImapHost(input.imapHost);

      if (input.imapPassword && input.imapPassword.length > 0) {
        if (!encryptionConfigured) {
          return res.status(503).json({
            code: "inbox_key_not_configured",
            message: "Server encryption key (SMTP_CREDENTIALS_KEY) is not configured.",
          });
        }
        passwordCiphertext = inboxDeps.encryptPassword(input.imapPassword, userId);
      } else if (input.useSmtpPassword) {
        if (!encryptionConfigured) {
          return res.status(503).json({
            code: "inbox_key_not_configured",
            message: "Server encryption key (SMTP_CREDENTIALS_KEY) is not configured.",
          });
        }
        const smtpPass = await resolveSavedSmtpPassword(userId);
        if (!smtpPass) {
          return res.status(400).json({
            code: "missing_imap_password",
            message: "No saved SMTP password found to reuse. Save SMTP settings first or enter your IMAP app password.",
          });
        }
        passwordCiphertext = inboxDeps.encryptPassword(smtpPass, userId);
      } else if (!passwordCiphertext) {
        return res.status(400).json({
          code: "missing_imap_password",
          message: "IMAP password or app password is required.",
        });
      }

      imapHost = input.imapHost;
      imapPort = input.imapPort;
      imapUsername = input.imapUsername;
    }

    const inboundToken = existing?.inbound_token || generateInboundToken();

    const { data: saved, error } = await inboxDeps.db
      .from("user_inbox_connections")
      .upsert(
        {
          user_id: userId,
          provider: input.provider,
          imap_host: imapHost,
          imap_port: imapPort,
          imap_username: imapUsername,
          imap_tls: input.imapTls,
          password_ciphertext: input.provider === "imap" ? passwordCiphertext : null,
          inbound_token: inboundToken,
          ig_email_alerts_enabled: input.igEmailAlertsEnabled,
          enabled: input.enabled,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "user_id" },
      )
      .select(
        "user_id, provider, imap_host, imap_port, imap_username, imap_tls, password_ciphertext, inbound_token, ig_email_alerts_enabled, enabled, last_synced_at, last_sync_status, last_sync_error",
      )
      .single();

    if (error) {
      return res.status(500).json({ code: "inbox_save_failed", message: "Could not save inbox settings." });
    }

    return res.json(toSafeSettingsResponse(saved, encryptionConfigured));
  } catch (err) {
    if (err instanceof InboxHostError) {
      return res.status(err.status).json({ code: err.code, message: err.message });
    }
    if (err instanceof InboxCryptoError) {
      return res.status(503).json({ code: err.code, message: err.message });
    }
    return next(err);
  }
});

inboxRouter.post("/test", requireAuth, syncLimiter, async (req, res, next) => {
  try {
    const userId = req.user!.id;
    const parsed = TestImapSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({
        code: "invalid_imap_test_payload",
        message: parsed.error.issues[0]?.message || "Valid IMAP host, port, and username are required.",
      });
    }

    const { imapHost, imapPort, imapUsername, imapPassword, useSmtpPassword, imapTls } = parsed.data;
    let resolvedPassword = imapPassword?.trim() ? imapPassword : "";

    if (!resolvedPassword && useSmtpPassword) {
      const smtpPass = await resolveSavedSmtpPassword(userId);
      if (!smtpPass) {
        return res.status(400).json({
          code: "missing_imap_password",
          message: "No saved SMTP password found to test. Save SMTP settings first or enter your IMAP app password.",
        });
      }
      resolvedPassword = smtpPass;
    }

    if (!resolvedPassword) {
      const { data: existing } = await inboxDeps.db
        .from("user_inbox_connections")
        .select("password_ciphertext")
        .eq("user_id", userId)
        .maybeSingle();

      if (!existing?.password_ciphertext) {
        return res.status(400).json({
          code: "missing_imap_password",
          message: "Enter your IMAP password or app password to test the connection.",
        });
      }
      resolvedPassword = inboxDeps.decryptPassword(existing.password_ciphertext, userId);
    }

    await inboxDeps.validateImapHost(imapHost);
    await inboxDeps.testImapConnection({
      host: imapHost,
      port: imapPort,
      username: imapUsername,
      password: resolvedPassword,
      tls: imapTls,
    });

    await inboxDeps.db
      .from("user_inbox_connections")
      .update({
        last_sync_status: "success",
        last_sync_error: null,
        last_synced_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("user_id", userId);

    return res.json({ success: true, message: "IMAP connection verified." });
  } catch (err: any) {
    if (err instanceof InboxHostError) {
      return res.status(err.status).json({ success: false, code: err.code, message: err.message });
    }
    if (err instanceof InboxCryptoError) {
      return res.status(503).json({ success: false, code: err.code, message: err.message });
    }
    const safeMsg = err?.message ? String(err.message).slice(0, 240) : "IMAP connection failed.";
    await inboxDeps.db
      .from("user_inbox_connections")
      .update({
        last_sync_status: "failed",
        last_sync_error: safeMsg,
        updated_at: new Date().toISOString(),
      })
      .eq("user_id", req.user!.id);

    return res.status(400).json({
      success: false,
      code: "imap_connection_failed",
      message: safeMsg,
    });
  }
});

inboxRouter.post("/sync-now", requireAuth, syncLimiter, async (req, res, next) => {
  try {
    const userId = req.user!.id;
    const { data: conn, error } = await inboxDeps.db
      .from("user_inbox_connections")
      .select(
        "user_id, provider, imap_host, imap_port, imap_username, imap_tls, password_ciphertext, ig_email_alerts_enabled, last_uid, uid_validity, enabled",
      )
      .eq("user_id", userId)
      .maybeSingle();

    if (error) {
      return res.status(500).json({ code: "inbox_load_failed", message: "Could not load inbox settings." });
    }

    if (!conn || conn.provider !== "imap" || !conn.imap_host || !conn.imap_port || !conn.imap_username || !conn.password_ciphertext) {
      return res.status(400).json({
        code: "imap_not_configured",
        message: "IMAP inbox observation is not configured yet.",
      });
    }

    const summary = await inboxDeps.pollUserImapInbox({
      db: inboxDeps.db,
      userId,
      host: conn.imap_host,
      port: Number(conn.imap_port),
      username: conn.imap_username,
      passwordCiphertext: conn.password_ciphertext,
      tls: conn.imap_tls !== false,
      lastUid: Number(conn.last_uid ?? 0),
      uidValidity: conn.uid_validity !== null && conn.uid_validity !== undefined ? Number(conn.uid_validity) : null,
      igEmailAlertsEnabled: conn.ig_email_alerts_enabled !== false,
    });

    await inboxDeps.db
      .from("user_inbox_connections")
      .update({
        last_uid: summary.lastUid,
        uid_validity: summary.uidValidity,
        last_synced_at: new Date().toISOString(),
        last_sync_status: "success",
        last_sync_error: null,
        updated_at: new Date().toISOString(),
      })
      .eq("user_id", userId);

    return res.json({ success: true, ...summary });
  } catch (err: any) {
    if (err instanceof InboxHostError) {
      return res.status(err.status).json({ code: err.code, message: err.message });
    }
    if (err instanceof InboxCryptoError) {
      return res.status(503).json({ code: err.code, message: err.message });
    }
    const safeMsg = err?.message ? String(err.message).slice(0, 240) : "IMAP sync failed.";
    await inboxDeps.db
      .from("user_inbox_connections")
      .update({
        last_synced_at: new Date().toISOString(),
        last_sync_status: "failed",
        last_sync_error: safeMsg,
        updated_at: new Date().toISOString(),
      })
      .eq("user_id", req.user!.id);
    return res.status(500).json({ code: "imap_sync_failed", message: safeMsg });
  }
});

inboxRouter.delete("/settings", requireAuth, async (req, res, next) => {
  try {
    const userId = req.user!.id;
    await inboxDeps.db
      .from("user_inbox_connections")
      .update({
        provider: "inbound_only",
        imap_host: null,
        imap_port: null,
        imap_username: null,
        password_ciphertext: null,
        last_uid: 0,
        uid_validity: null,
        last_sync_status: null,
        last_sync_error: null,
        updated_at: new Date().toISOString(),
      })
      .eq("user_id", userId);
    return res.json({ success: true });
  } catch (err) {
    return next(err);
  }
});

/**
 * Inbound Email Webhook (Postmark / Resend / Mailgun / Cloudflare Email Worker / Forwarding)
 * Authenticated strictly by the unguessable per-user `inbound_token`.
 */
inboxRouter.post("/inbound/:token", inboundLimiter, async (req, res, next) => {
  try {
    const token = String(req.params.token || "").trim();
    if (!token || token.length < 16) {
      return res.status(401).json({ code: "invalid_inbound_token", message: "Invalid inbound token." });
    }

    const { data: conn, error } = await inboxDeps.db
      .from("user_inbox_connections")
      .select("user_id, enabled, ig_email_alerts_enabled")
      .eq("inbound_token", token)
      .maybeSingle();

    if (error || !conn || conn.enabled === false) {
      return res.status(404).json({ code: "inbound_not_found", message: "Inbound endpoint not found or disabled." });
    }

    const body = (req.body || {}) as Record<string, any>;
    // Support common inbound JSON shapes (Postmark, Resend, Mailgun, generic)
    const from =
      body.from ||
      body.From ||
      body.sender ||
      body.FromFull?.Email ||
      body.data?.from ||
      null;
    const subject = body.subject || body.Subject || body.data?.subject || null;
    const text =
      body.text ||
      body.TextBody ||
      body["stripped-text"] ||
      body["body-plain"] ||
      body.data?.text ||
      null;
    const html =
      body.html ||
      body.HtmlBody ||
      body["body-html"] ||
      body.data?.html ||
      null;
    const messageId = body.messageId || body.MessageID || body["Message-Id"] || null;
    const inReplyTo = body.inReplyTo || body["In-Reply-To"] || null;
    const references = body.references || body.References || null;

    const headerObj: Record<string, string> = {};
    if (Array.isArray(body.Headers)) {
      for (const h of body.Headers) {
        if (h?.Name && h?.Value) headerObj[String(h.Name)] = String(h.Value);
      }
    } else if (body.headers && typeof body.headers === "object") {
      for (const [k, v] of Object.entries(body.headers)) {
        headerObj[k] = String(v ?? "");
      }
    }

    const result = await inboxDeps.ingestEmailReply(inboxDeps.db, {
      userId: conn.user_id,
      from: from ? String(from) : null,
      subject: subject ? String(subject) : null,
      text: text ? String(text) : null,
      html: html ? String(html) : null,
      messageId: messageId ? String(messageId) : null,
      inReplyTo: inReplyTo ? String(inReplyTo) : headerObj["In-Reply-To"] || null,
      references: references || headerObj["References"] || null,
      headers: headerObj,
      igEmailAlertsEnabled: conn.ig_email_alerts_enabled !== false,
      source: "inbound_webhook",
    });

    return res.json({ ok: true, ...result });
  } catch (err) {
    return next(err);
  }
});

/**
 * Passive Local Instagram DM Observer Sync (Chrome Extension / Desktop Webview)
 */
inboxRouter.post("/ig-sync", requireAuth, igSyncLimiter, async (req, res, next) => {
  try {
    const userId = req.user!.id;
    const parsed = IgSyncSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({
        code: "invalid_ig_sync_payload",
        message: parsed.error.issues[0]?.message || "Invalid Instagram sync payload.",
      });
    }

    const summary = await inboxDeps.ingestInstagramSyncEvents(
      inboxDeps.db,
      userId,
      parsed.data.events,
    );

    return res.json({ ok: true, ...summary });
  } catch (err) {
    return next(err);
  }
});
