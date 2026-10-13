/**
 * Maps Supabase/PostgREST errors to distinct, safe HTTP responses so a missing
 * row, an auth failure, and a database permission failure are never all
 * reported as "not found".
 */
export interface DbErrorLike {
  code?: string | null;
  message?: string | null;
  status?: number | null;
}

export type DbFailureKind =
  | "not_found"
  | "auth_failed"
  | "permission_denied"
  | "storage_unavailable"
  | "db_error";

export interface ClassifiedDbFailure {
  kind: DbFailureKind;
  status: number;
  code: string;
  message: string;
}

export function classifyDbError(
  err: DbErrorLike | null | undefined,
  subject: string,
): ClassifiedDbFailure | null {
  if (!err) return null;
  const code = String(err.code ?? "");
  const msg = String(err.message ?? "").toLowerCase();

  // PostgREST "JSON object requested, multiple (or no) rows returned" with 0 rows.
  if (code === "PGRST116") {
    return {
      kind: "not_found",
      status: 404,
      code: `${subject}_not_found`,
      message: `No ${subject} record exists for this account.`,
    };
  }
  if (code === "PGRST301" || code === "PGRST302" || err.status === 401 || msg.includes("jwt")) {
    return {
      kind: "auth_failed",
      status: 401,
      code: "auth_failed",
      message: "Your session is invalid or has expired. Please sign in again.",
    };
  }
  if (
    code === "42501" ||
    err.status === 403 ||
    msg.includes("permission denied") ||
    msg.includes("row-level security")
  ) {
    return {
      kind: "permission_denied",
      status: 403,
      code: "db_permission_denied",
      message: `The database denied access to your ${subject} (permission error). This is a server configuration problem, not a missing account.`,
    };
  }
  if (
    code === "42P01" ||
    code === "PGRST205" ||
    msg.includes("does not exist") ||
    msg.includes("schema cache")
  ) {
    return {
      kind: "storage_unavailable",
      status: 503,
      code: "storage_unavailable",
      message: `The ${subject} storage is not available on the server (a database migration may not have been applied).`,
    };
  }
  return {
    kind: "db_error",
    status: 500,
    code: "db_error",
    message: `Could not read your ${subject} due to a database error.`,
  };
}
