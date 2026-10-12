import type { SmtpRow, SmtpStore } from "../_smtpService";

/** In-memory SmtpStore. One row per user id, mirroring the owner-scoped table. */
export function memoryStore(): SmtpStore & { rows: Map<string, SmtpRow> } {
  const rows = new Map<string, SmtpRow>();
  return {
    rows,
    async get(userId) {
      const r = rows.get(userId);
      return r ? { ...r } : null;
    },
    async put(row) {
      rows.set(row.user_id, { ...row });
    },
    async recordTest(userId, expectVersion, result) {
      const r = rows.get(userId);
      if (!r || r.config_version !== expectVersion) return false;
      r.last_test_status = result.status;
      r.last_tested_at = result.testedAt;
      r.last_test_error = result.error;
      return true;
    },
    async delete(userId) {
      rows.delete(userId);
    },
  };
}

/** Test-only 32-byte key. Never a real credential. */
export const TEST_KEY_B64 = Buffer.alloc(32, 7).toString("base64");
export const TEST_ENV = { SMTP_CREDENTIALS_KEY: TEST_KEY_B64 } as unknown as NodeJS.ProcessEnv;
export const NO_KEY_ENV = {} as unknown as NodeJS.ProcessEnv;

export const SECRET = "app-pass-SENTINEL-9f3k2";
export const USER_A = "11111111-1111-1111-1111-111111111111";
export const USER_B = "22222222-2222-2222-2222-222222222222";

export const BASE_INPUT = {
  host: "smtp.gmail.com",
  port: "587",
  username: "a@example.com",
  encryption: "TLS",
  password: SECRET,
};
