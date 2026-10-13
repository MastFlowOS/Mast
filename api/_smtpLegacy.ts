/**
 * Transitional support for the OLD storage location: SMTP settings (including a
 * plaintext smtpPassword) inside profiles.settings. New passwords are never
 * written there. See docs/smtp-credentials.md for the cleanup procedure.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { classifyDbError } from "./_dbErrors";
import { isSmtpKeyConfigured } from "./_smtpCrypto";
import { saveSmtpSettings, type SmtpStore } from "./_smtpService";

export interface LegacySmtp {
  host: string;
  port: string;
  user: string;
  pass: string;
  encryption: string;
}

export function readLegacySmtp(
  settings: Record<string, unknown> | null | undefined,
): LegacySmtp | null {
  if (!settings) return null;
  const s = (k: string) => (typeof settings[k] === "string" ? (settings[k] as string).trim() : "");
  const host = s("smtpHost");
  const port = s("smtpPort");
  const user = s("smtpUser");
  const pass = typeof settings.smtpPassword === "string" ? (settings.smtpPassword as string) : "";
  if (!host || !port || !user || !pass) return null;
  return { host, port, user, pass, encryption: s("smtpEncryption") || "None" };
}

/** Removes only the plaintext password key from the caller's own profile settings. */
export async function stripLegacyPassword(db: SupabaseClient, userId: string): Promise<void> {
  const { data, error } = await db.from("profiles").select("settings").eq("id", userId).single();
  if (error || !data) return;
  const settings = { ...((data.settings as Record<string, unknown>) ?? {}) };
  if (!("smtpPassword" in settings)) return;
  delete settings.smtpPassword;
  await db.from("profiles").update({ settings }).eq("id", userId);
}

/**
 * If the user has no secure record but has legacy plaintext SMTP settings,
 * move them into encrypted storage (untested status) and drop the plaintext
 * password. Idempotent; a no-op without the encryption key or legacy data.
 */
export async function adoptLegacySmtpIfNeeded(
  db: SupabaseClient,
  store: SmtpStore,
  userId: string,
): Promise<void> {
  if (!isSmtpKeyConfigured()) return;
  if (await store.get(userId)) return;
  const { data, error } = await db.from("profiles").select("settings").eq("id", userId).single();
  if (error || !data) return;
  const legacy = readLegacySmtp(data.settings as Record<string, unknown>);
  if (!legacy) return;
  await saveSmtpSettings(store, userId, {
    host: legacy.host,
    port: legacy.port,
    username: legacy.user,
    encryption: legacy.encryption,
    password: legacy.pass,
  });
  await stripLegacyPassword(db, userId);
}

export { classifyDbError };
