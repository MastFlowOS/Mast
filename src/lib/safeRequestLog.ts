const SENSITIVE_HEADER_NAMES = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "set-cookie",
  "x-api-key",
  "api-key",
  "x-auth-token",
  "x-access-token",
  "x-supabase-api-key",
]);

const SENSITIVE_FIELD = /(?:authorization|cookie|token|secret|password|api[-_]?key|access[-_]?key|signature)/i;
const SENSITIVE_QUERY_PARAM = /(?:authorization|token|secret|password|api[-_]?key|access[-_]?key|signature|session|code)/i;
const BEARER_VALUE = /\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi;
const JWT_VALUE = /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b/g;

export function redactSensitiveHeaders(headers: Record<string, unknown>): Record<string, unknown> {
  const sanitized = { ...headers };
  for (const name of Object.keys(sanitized)) {
    if (SENSITIVE_HEADER_NAMES.has(name.toLowerCase())) {
      sanitized[name] = "[Redacted]";
    }
  }
  return sanitized;
}

/** Redact credential-like fields recursively, including nested HTTP client errors. */
export function redactSensitiveData(value: unknown): unknown {
  if (typeof value === "string") {
    return value.replace(BEARER_VALUE, "Bearer [Redacted]").replace(JWT_VALUE, "[Redacted JWT]");
  }
  if (Array.isArray(value)) return value.map(redactSensitiveData);
  if (value && typeof value === "object") {
    const sanitized: Record<string, unknown> = {};
    for (const [key, fieldValue] of Object.entries(value)) {
      sanitized[key] = SENSITIVE_FIELD.test(key) ? "[Redacted]" : redactSensitiveData(fieldValue);
    }
    return sanitized;
  }
  return value;
}

/** Keep useful paths and ordinary query params while removing auth-like values. */
export function sanitizeRequestUrl(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl, "https://log-redaction.invalid");
    for (const key of parsed.searchParams.keys()) {
      if (SENSITIVE_QUERY_PARAM.test(key)) parsed.searchParams.set(key, "[Redacted]");
    }
    return parsed.pathname + parsed.search;
  } catch {
    // Fail closed: never retain an unparseable query string in logs.
    return rawUrl.split("?", 1)[0];
  }
}
