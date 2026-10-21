const SENSITIVE_HEADER_NAMES = new Set([
  "authorization",
  "proxy-authorization",
  "authentication",
  "cookie",
  "set-cookie",
  "x-api-key",
  "api-key",
  "apikey",
  "x-auth-token",
  "x-access-token",
  "x-auth",
  "auth-token",
  "access-token",
  "session-token",
  "x-session-id",
  "x-supabase-api-key",
  "x-service-key",
  "refresh-token",
  "x-refresh-token",
]);

const SENSITIVE_FIELD =
  /(?:auth(?:orization)?|proxy-authorization|cookie|set-cookie|token|secret|password|api[-_]?key|access[-_]?key|signature|credential|rawheaders|_header|session)/i;

const SENSITIVE_QUERY_PARAM =
  /(?:authorization|token|secret|password|api[-_]?key|access[-_]?key|signature|session|code|auth)/i;

const BEARER_VALUE = /\bBearer\s+[^\s,;]+/gi;
const BASIC_AUTH_VALUE = /\bBasic\s+[A-Za-z0-9+/=]+/gi;
const JWT_VALUE = /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b/g;
const API_KEY_VALUE = /\b(?:sk-(?:or-v1-)?|key-|ghp_|glpat-)[A-Za-z0-9_-]{10,}\b/gi;
const URL_BASIC_AUTH = /(https?:\/\/)([^:\/\s@]+):([^@\/\s]+)@/gi;
const SENSITIVE_QUERY_STRING = /([?&](?:authorization|access_token|refresh_token|api_key|apikey|key|token|secret|password|session|code)=)[^&\s]+/gi;
const INLINE_CREDENTIAL_KV = /(?<=(?:^|[\s,;{]))(?:"?)(?:password|secret|token|api_key|apikey|access_token|refresh_token)(?:"?)\s*[:=]\s*(?:"?)([^"'\s,;}]+)(?:"?)/gi;

export function redactSensitiveHeaders(headers: Record<string, unknown>): Record<string, unknown> {
  const sanitized: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (SENSITIVE_HEADER_NAMES.has(name.toLowerCase()) || SENSITIVE_FIELD.test(name)) {
      sanitized[name] = "[Redacted]";
    } else {
      sanitized[name] = redactSensitiveData(value);
    }
  }
  return sanitized;
}

function redactStringValues(text: string): string {
  let res = text
    .replace(URL_BASIC_AUTH, "$1[Redacted]:[Redacted]@")
    .replace(BEARER_VALUE, "Bearer [Redacted]")
    .replace(BASIC_AUTH_VALUE, "Basic [Redacted]")
    .replace(JWT_VALUE, "[Redacted JWT]")
    .replace(API_KEY_VALUE, "[Redacted API Key]")
    .replace(SENSITIVE_QUERY_STRING, "$1%5BRedacted%5D");

  res = res.replace(INLINE_CREDENTIAL_KV, (match) => {
    const sepIdx = match.search(/[:=]/);
    if (sepIdx !== -1) {
      const prefix = match.slice(0, sepIdx + 1);
      return `${prefix} [Redacted]`;
    }
    return match;
  });

  return res;
}

export function redactRawHeaders(rawHeaders: unknown[]): string[] {
  const result: string[] = [];
  for (let i = 0; i < rawHeaders.length; i += 2) {
    const name = String(rawHeaders[i]);
    const val = rawHeaders[i + 1] !== undefined ? String(rawHeaders[i + 1]) : "";
    result.push(name);
    if (SENSITIVE_HEADER_NAMES.has(name.toLowerCase()) || SENSITIVE_FIELD.test(name)) {
      result.push("[Redacted]");
    } else {
      result.push(redactStringValues(val));
    }
  }
  return result;
}

export function redactHeaderString(headerStr: string): string {
  return headerStr.replace(/^([A-Za-z0-9-_]+):\s*(.+)$/gim, (match, name, value) => {
    if (SENSITIVE_HEADER_NAMES.has(name.toLowerCase()) || SENSITIVE_FIELD.test(name)) {
      return `${name}: [Redacted]`;
    }
    return `${name}: ${redactStringValues(value)}`;
  });
}

/**
 * Sanitizes a worker-provided error string for persistence in the DB and SSE broadcast.
 * Bounded to 500 characters, with credentials, bearer tokens, basic auth, API keys, and sensitive query params stripped.
 */
export function sanitizeWorkerError(rawError?: string | null): string | undefined {
  if (!rawError || typeof rawError !== "string") return undefined;
  const trimmed = rawError.trim();
  if (!trimmed) return undefined;
  const bounded = trimmed.length > 500 ? `${trimmed.slice(0, 497)}...` : trimmed;
  return redactSensitiveData(bounded) as string;
}

/** Redact credential-like fields recursively, including nested HTTP client errors. */
export function redactSensitiveData(value: unknown): unknown {
  if (typeof value === "string") {
    return redactStringValues(value);
  }
  if (Array.isArray(value)) {
    return value.map(redactSensitiveData);
  }
  if (value && typeof value === "object") {
    const sanitized: Record<string, unknown> = {};
    for (const [key, fieldValue] of Object.entries(value)) {
      const lowerKey = key.toLowerCase();

      // Skip internal stream/socket/circular fields entirely
      if (
        lowerKey === "socket" ||
        lowerKey === "client" ||
        lowerKey === "agent" ||
        lowerKey === "_events" ||
        lowerKey === "_eventscount" ||
        lowerKey === "_readablestate" ||
        lowerKey === "_writablestate"
      ) {
        continue;
      }

      // Safe allowlisted extraction for HTTP request objects
      if ((lowerKey === "request" || lowerKey === "req") && typeof fieldValue === "object" && fieldValue !== null) {
        const reqObj = fieldValue as Record<string, unknown>;
        const safeReq: Record<string, unknown> = {};
        if (typeof reqObj.method === "string") safeReq.method = reqObj.method;
        const rawUrl = typeof reqObj.url === "string" ? reqObj.url : (typeof reqObj.path === "string" ? reqObj.path : undefined);
        if (rawUrl) safeReq.url = sanitizeRequestUrl(rawUrl);
        if (reqObj.headers && typeof reqObj.headers === "object") {
          safeReq.headers = redactSensitiveHeaders(reqObj.headers as Record<string, unknown>);
        }
        if (Array.isArray(reqObj.rawHeaders)) {
          safeReq.rawHeaders = redactRawHeaders(reqObj.rawHeaders);
        }
        sanitized[key] = safeReq;
        continue;
      }

      // Safe allowlisted extraction for HTTP response objects
      if ((lowerKey === "response" || lowerKey === "res") && typeof fieldValue === "object" && fieldValue !== null) {
        const resObj = fieldValue as Record<string, unknown>;
        const safeRes: Record<string, unknown> = {};
        const status = typeof resObj.status === "number" ? resObj.status : (typeof resObj.statusCode === "number" ? resObj.statusCode : undefined);
        if (status !== undefined) safeRes.status = status;
        if (typeof resObj.statusText === "string") safeRes.statusText = resObj.statusText;
        if (resObj.headers && typeof resObj.headers === "object") {
          safeRes.headers = redactSensitiveHeaders(resObj.headers as Record<string, unknown>);
        }
        sanitized[key] = safeRes;
        continue;
      }

      // Safe allowlisted extraction for Axios config objects
      if (lowerKey === "config" && typeof fieldValue === "object" && fieldValue !== null) {
        const cfgObj = fieldValue as Record<string, unknown>;
        const safeCfg: Record<string, unknown> = {};
        if (typeof cfgObj.method === "string") safeCfg.method = cfgObj.method;
        if (typeof cfgObj.url === "string") safeCfg.url = sanitizeRequestUrl(cfgObj.url);
        if (cfgObj.headers && typeof cfgObj.headers === "object") {
          safeCfg.headers = redactSensitiveHeaders(cfgObj.headers as Record<string, unknown>);
        }
        sanitized[key] = safeCfg;
        continue;
      }

      // rawHeaders array handling
      if (lowerKey === "rawheaders" && Array.isArray(fieldValue)) {
        sanitized[key] = redactRawHeaders(fieldValue);
        continue;
      }

      // _header string handling
      if (lowerKey === "_header" && typeof fieldValue === "string") {
        sanitized[key] = redactHeaderString(fieldValue);
        continue;
      }

      // Headers object handling
      if (lowerKey === "headers" && typeof fieldValue === "object" && fieldValue !== null) {
        sanitized[key] = redactSensitiveHeaders(fieldValue as Record<string, unknown>);
        continue;
      }

      if (SENSITIVE_FIELD.test(key) || SENSITIVE_HEADER_NAMES.has(lowerKey)) {
        sanitized[key] = "[Redacted]";
      } else {
        sanitized[key] = redactSensitiveData(fieldValue);
      }
    }
    return sanitized;
  }
  return value;
}

/**
 * Serializes an unknown thrown error value into a plain object with only safe allowlisted fields.
 * Strips raw request/response/socket/agent objects and custom nested state.
 */
export function serializeError(err: unknown): Record<string, unknown> {
  if (err instanceof Error) {
    const serialized: Record<string, unknown> = {
      name: err.name,
      message: err.message,
      stack: err.stack,
      code: (err as { code?: string }).code,
      details: (err as { details?: string }).details,
      hint: (err as { hint?: string }).hint,
    };
    if (typeof (err as any).status === "number") serialized.status = (err as any).status;
    if (typeof (err as any).statusCode === "number") serialized.statusCode = (err as any).statusCode;
    return serialized;
  }
  if (err && typeof err === "object") {
    const obj = err as Record<string, unknown>;
    const serialized: Record<string, unknown> = {};
    const ALLOWED_ERROR_KEYS = new Set([
      "name",
      "message",
      "code",
      "details",
      "hint",
      "status",
      "statusCode",
      "statusText",
      "reason",
      "category",
      "field",
      "path",
    ]);

    for (const [k, v] of Object.entries(obj)) {
      if (ALLOWED_ERROR_KEYS.has(k)) {
        serialized[k] = v;
      }
    }

    if (Object.keys(serialized).length === 0) {
      serialized.message = typeof obj.message === "string" ? obj.message : String(err);
    }
    return serialized;
  }
  return { message: String(err) };
}

/** Keep useful paths and ordinary query params while removing auth-like values. */
export function sanitizeRequestUrl(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl, "https://log-redaction.invalid");
    if (parsed.username || parsed.password) {
      parsed.username = "[Redacted]";
      parsed.password = "[Redacted]";
    }
    for (const key of Array.from(new Set(parsed.searchParams.keys()))) {
      if (SENSITIVE_QUERY_PARAM.test(key)) parsed.searchParams.set(key, "[Redacted]");
    }
    const origin = rawUrl.startsWith("http://") || rawUrl.startsWith("https://") ? parsed.origin : "";
    const cleanAuth = origin.includes("@") ? origin.replace(/\/\/[^@]+@/, "//[Redacted]:[Redacted]@") : origin;
    return (cleanAuth ? cleanAuth : "") + parsed.pathname + parsed.search;
  } catch {
    const stripped = rawUrl.split("?", 1)[0];
    return stripped.replace(/(https?:\/\/)[^:\/\s@]+:[^@\/\s]+@/gi, "$1[Redacted]:[Redacted]@");
  }
}
