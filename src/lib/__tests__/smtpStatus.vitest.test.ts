import { describe, expect, it } from "vitest";
import type { SmtpSettings } from "@/lib/api";
import { deriveSmtpDisplayStatus, hasUnsavedSmtpChanges } from "@/lib/smtpStatus";

const saved = (over: Partial<SmtpSettings> = {}): SmtpSettings => ({
  configured: true,
  host: "smtp.gmail.com",
  port: "587",
  username: "a@example.com",
  encryption: "TLS",
  hasPassword: true,
  status: "connected",
  lastTestedAt: "2026-10-13T10:00:00.000Z",
  lastTestError: null,
  updatedAt: "2026-10-13T09:00:00.000Z",
  encryptionConfigured: true,
  ...over,
});

const local = (over = {}) => ({
  host: "smtp.gmail.com",
  port: "587",
  username: "a@example.com",
  encryption: "TLS",
  passwordTyped: false,
  ...over,
});

const derive = (server: SmtpSettings | undefined, l = local(), over = {}) =>
  deriveSmtpDisplayStatus({
    server,
    isLoading: false,
    loadFailed: false,
    isTesting: false,
    local: l,
    ...over,
  });

describe("deriveSmtpDisplayStatus", () => {
  it("shows Connected from persisted state on a fresh mount (leave/return, refresh, new session)", () => {
    // Nothing in component state but the loaded server record.
    expect(derive(saved())).toBe("connected");
  });

  it("never shows Connected for an untested, failed, or unconfigured server record", () => {
    expect(derive(saved({ status: "untested", lastTestedAt: null }))).toBe("untested");
    expect(derive(saved({ status: "failed", lastTestError: "timeout" }))).toBe("failed");
    expect(
      derive(
        {
          ...saved(),
          configured: false,
          status: "not_configured",
          host: "",
          port: "",
          username: "",
          hasPassword: false,
        },
        local({ host: "", port: "", username: "", encryption: "None" }),
      ),
    ).toBe("not_configured");
  });

  it.each([
    ["host", { host: "smtp.other.com" }],
    ["port", { port: "465" }],
    ["username", { username: "b@example.com" }],
    ["encryption", { encryption: "None" }],
    ["password", { passwordTyped: true }],
  ])("editing %s drops Connected to 'unsaved' until saved and re-tested", (_n, change) => {
    expect(derive(saved(), local(change))).toBe("unsaved");
    expect(hasUnsavedSmtpChanges(saved(), local(change))).toBe(true);
  });

  it("surfaces load failures instead of silently reverting to 'Not tested'", () => {
    expect(derive(undefined, local(), { loadFailed: true })).toBe("load_error");
    expect(derive(undefined, local(), { isLoading: true })).toBe("loading");
  });

  it("testing takes precedence while a test is in flight", () => {
    expect(derive(saved(), local(), { isTesting: true })).toBe("testing");
  });

  it("treats whitespace-only differences as unchanged", () => {
    expect(hasUnsavedSmtpChanges(saved(), local({ host: " smtp.gmail.com " }))).toBe(false);
  });
});
