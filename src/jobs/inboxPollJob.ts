/**
 * Background pg-boss job handler for polling enabled user IMAP inboxes.
 * Runs every 2 minutes in the worker process to detect new client email replies
 * and Instagram DM notification emails.
 */
import { supabaseAdmin } from "../lib/supabaseAdmin.js";
import { pollUserImapInbox } from "../lib/imapSync.js";
import { redactSensitiveData, serializeError } from "../lib/safeRequestLog.js";

export async function handleInboxPollSweepJob(): Promise<void> {
  const db = supabaseAdmin as any;
  const { data: connections, error } = await db
    .from("user_inbox_connections")
    .select(
      "user_id, provider, imap_host, imap_port, imap_username, imap_tls, password_ciphertext, ig_email_alerts_enabled, last_uid, uid_validity",
    )
    .eq("enabled", true)
    .eq("provider", "imap")
    .not("password_ciphertext", "is", null)
    .limit(100);

  if (error) {
    console.error("[inboxPollJob] failed to query active connections:", error.message);
    return;
  }

  if (!connections || connections.length === 0) return;

  for (const conn of connections) {
    if (!conn.imap_host || !conn.imap_port || !conn.imap_username || !conn.password_ciphertext) {
      continue;
    }

    try {
      const summary = await pollUserImapInbox({
        db,
        userId: conn.user_id,
        host: conn.imap_host,
        port: Number(conn.imap_port),
        username: conn.imap_username,
        passwordCiphertext: conn.password_ciphertext,
        tls: conn.imap_tls !== false,
        lastUid: Number(conn.last_uid ?? 0),
        uidValidity: conn.uid_validity !== null && conn.uid_validity !== undefined ? Number(conn.uid_validity) : null,
        igEmailAlertsEnabled: conn.ig_email_alerts_enabled !== false,
      });

      await db
        .from("user_inbox_connections")
        .update({
          last_uid: summary.lastUid,
          uid_validity: summary.uidValidity,
          last_synced_at: new Date().toISOString(),
          last_sync_status: "success",
          last_sync_error: null,
          updated_at: new Date().toISOString(),
        })
        .eq("user_id", conn.user_id);
    } catch (err) {
      const safeMsg = err instanceof Error ? err.message.slice(0, 240) : "IMAP sync failed";
      console.warn(
        `[inboxPollJob] poll failed for user ${conn.user_id}:`,
        redactSensitiveData(serializeError(err)),
      );
      await db
        .from("user_inbox_connections")
        .update({
          last_synced_at: new Date().toISOString(),
          last_sync_status: "failed",
          last_sync_error: safeMsg,
          updated_at: new Date().toISOString(),
        })
        .eq("user_id", conn.user_id);
    }
  }
}
