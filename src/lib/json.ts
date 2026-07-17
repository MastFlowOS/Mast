import type { Json } from "../types/database.types.js";

/**
 * Runtime-safe bridge from an arbitrary JS value to the Postgres/Supabase
 * `Json` column type.
 *
 * Several callers (business enrichment, in particular) hold values that are
 * *believed* JSON-shaped by contract — they came from `JSON.parse(stdout)`
 * on the Python scraper bridge's output (see `EngineVerifyResult` in
 * `src/scraperBridge/pythonBridge.ts`) — but are typed as `Record<string,
 * unknown>` on the TS side, which is not structurally assignable to `Json`
 * (an `unknown` value isn't provably a `Json` value). A blind `as Json`
 * cast would silence the compiler without actually guaranteeing the shape.
 *
 * `JSON.parse(JSON.stringify(...))` re-derives an actual `Json` value at
 * runtime — stripping `undefined`, functions, symbols, etc., exactly like
 * Postgres's own `jsonb` column would on write — so what we send really is
 * a `Json` value, not just something asserted to be one.
 */
export function toJson(value: unknown): Json {
  if (value === undefined) return null;
  return JSON.parse(JSON.stringify(value)) as Json;
}

/** Narrows a `Json` value to a plain (non-array, non-null) Json object. */
export function isJsonObject(value: Json | null | undefined): value is Record<string, Json | undefined> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
