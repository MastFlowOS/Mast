import type { SmtpSettings } from "@/lib/api";

export type SmtpDisplayStatus =
  | "loading"
  | "load_error"
  | "testing"
  | "not_configured"
  | "unsaved"
  | "untested"
  | "connected"
  | "failed";

export interface SmtpLocalFields {
  host: string;
  port: string;
  username: string;
  encryption: string;
  /** True when the user has typed a (new) password this session. */
  passwordTyped: boolean;
}

/** True when the form differs from the saved server configuration in a connection-relevant way. */
export function hasUnsavedSmtpChanges(
  server: SmtpSettings | undefined,
  local: SmtpLocalFields,
): boolean {
  if (!server || !server.configured) {
    return Boolean(
      local.host.trim() || local.port.trim() || local.username.trim() || local.passwordTyped,
    );
  }
  return (
    local.passwordTyped ||
    local.host.trim() !== server.host ||
    local.port.trim() !== server.port ||
    local.username.trim() !== server.username ||
    local.encryption !== server.encryption
  );
}

/**
 * What the Connection status indicator shows. The persisted server record is
 * the source of truth; "connected" is only ever returned for a saved,
 * successfully tested configuration that has no unsaved edits on top of it.
 */
export function deriveSmtpDisplayStatus(args: {
  server: SmtpSettings | undefined;
  isLoading: boolean;
  loadFailed: boolean;
  isTesting: boolean;
  local: SmtpLocalFields;
}): SmtpDisplayStatus {
  const { server, isLoading, loadFailed, isTesting, local } = args;
  if (isTesting) return "testing";
  if (isLoading) return "loading";
  if (loadFailed || !server) return "load_error";
  if (hasUnsavedSmtpChanges(server, local)) return "unsaved";
  if (!server.configured) return "not_configured";
  if (server.status === "connected") return "connected";
  if (server.status === "failed") return "failed";
  return "untested";
}
