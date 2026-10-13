import type { SupabaseClient } from "@supabase/supabase-js";
import { classifyDbError } from "./_dbErrors";
import { SmtpServiceError, type SmtpRow, type SmtpStore } from "./_smtpService";

function fail(err: {
  code?: string | null;
  message?: string | null;
  status?: number | null;
}): never {
  const c = classifyDbError(err, "SMTP settings");
  // Do not forward raw DB messages; the classified message is safe.
  throw new SmtpServiceError(
    c?.status ?? 500,
    c?.code ?? "db_error",
    c?.message ?? "Database error.",
  );
}

/**
 * SmtpStore backed by public.user_smtp_credentials, accessed with the caller's
 * own JWT. Every query is additionally scoped by user_id; RLS enforces the same.
 */
export function createSupabaseSmtpStore(db: SupabaseClient): SmtpStore {
  return {
    async get(userId) {
      const { data, error } = await db
        .from("user_smtp_credentials")
        .select("*")
        .eq("user_id", userId)
        .maybeSingle();
      if (error) fail(error);
      return (data as SmtpRow | null) ?? null;
    },
    async put(row) {
      const { error } = await db
        .from("user_smtp_credentials")
        .upsert(row, { onConflict: "user_id" });
      if (error) fail(error);
    },
    async recordTest(userId, expectVersion, result) {
      const { data, error } = await db
        .from("user_smtp_credentials")
        .update({
          last_test_status: result.status,
          last_tested_at: result.testedAt,
          last_test_error: result.error,
        })
        .eq("user_id", userId)
        .eq("config_version", expectVersion)
        .select("user_id");
      if (error) fail(error);
      return Array.isArray(data) && data.length > 0;
    },
    async delete(userId) {
      const { error } = await db.from("user_smtp_credentials").delete().eq("user_id", userId);
      if (error) fail(error);
    },
  };
}
