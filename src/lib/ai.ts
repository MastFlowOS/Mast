import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";
import { env } from "../config/env.js";
import { redactSensitiveData } from "./safeRequestLog.js";

/**
 * OpenRouter AI Provider wrapper using OpenRouter's OpenAI-compatible API endpoint
 * (https://openrouter.ai/api/v1).
 *
 * Supported model IDs:
 * - Free router: `openrouter/free` (routes dynamically to compatible free models with zero prompt/completion charges)
 *
 * Grounded with real facts pulled from Postgres — the model is asked to
 * explain/prioritize/summarize/draft supplied facts, never to invent
 * business data.
 *
 * If OPENROUTER_API_KEY isn't configured, AI routes degrade to 503 rather than
 * the gateway crashing on boot — Discover, CRM, Pipeline, and Mission do
 * not depend on this.
 */

export type ModelTier = "fast" | "pro";

/** Default model alias for backwards compatibility. */
export const AI_MODEL = env.OPENROUTER_MODEL || "openrouter/free";

export const AI_MODELS = {
  fast: env.OPENROUTER_FAST_MODEL || env.OPENROUTER_MODEL || "openrouter/free",
  pro: env.OPENROUTER_PRO_MODEL || env.OPENROUTER_MODEL || "openrouter/free",
} as const;

/** Resolves model identifier for given tier. */
export function getAiModel(tier: ModelTier = "fast"): string {
  if (env.OPENROUTER_API_KEY || !env.DEEPSEEK_API_KEY) {
    return tier === "pro"
      ? env.OPENROUTER_PRO_MODEL || env.OPENROUTER_MODEL || "openrouter/free"
      : env.OPENROUTER_FAST_MODEL || env.OPENROUTER_MODEL || "openrouter/free";
  }
  return tier === "pro" ? env.DEEPSEEK_PRO_MODEL : env.DEEPSEEK_FAST_MODEL;
}

export type AiClient = OpenAI | Anthropic | any;

let client: AiClient | null = null;

export function aiEnabled(): boolean {
  return Boolean(env.OPENROUTER_API_KEY || env.DEEPSEEK_API_KEY);
}

export function getClient(): AiClient {
  if (client) {
    return client;
  }
  if (env.OPENROUTER_API_KEY) {
    client = new OpenAI({
      apiKey: env.OPENROUTER_API_KEY,
      baseURL: env.OPENROUTER_BASE_URL,
      defaultHeaders: {
        "HTTP-Referer": "https://mast.ai",
        "X-Title": "MAST OS",
      },
    });
    return client;
  }
  if (env.DEEPSEEK_API_KEY) {
    client = new Anthropic({
      apiKey: env.DEEPSEEK_API_KEY,
      baseURL: env.DEEPSEEK_BASE_URL,
    });
    return client;
  }
  throw new Error("OPENROUTER_API_KEY not configured");
}

/** Allow mocking/resetting client in tests. */
export function setAiClient(mockClient: AiClient | null): void {
  client = mockClient;
}

export function resetAiClient(): void {
  client = null;
}

/**
 * Sends a system + user prompt and parses the reply as JSON.
 * Preserves honest errors when the API key is missing, the provider fails,
 * request times out, or output is not valid JSON. Never falls back to canned responses.
 */
export async function generateJSON<T>(params: {
  system: string;
  user: string;
  maxTokens?: number;
  tier?: ModelTier;
  model?: string;
  timeoutMs?: number;
}): Promise<T> {
  const ai = getClient();
  const model = params.model ?? getAiModel(params.tier ?? "fast");

  let rawText: string | null | undefined = null;

  try {
    if (typeof ai.chat?.completions?.create === "function") {
      // OpenAI-compatible format (OpenRouter)
      const completion = await ai.chat.completions.create(
        {
          model,
          messages: [
            { role: "system", content: params.system },
            { role: "user", content: params.user },
          ],
          max_tokens: params.maxTokens ?? 1024,
        },
        params.timeoutMs ? { timeout: params.timeoutMs } : undefined,
      );
      rawText = completion.choices?.[0]?.message?.content;
    } else if (typeof ai.messages?.create === "function") {
      // Anthropic-compatible format (legacy / tests)
      const response = await ai.messages.create(
        {
          model,
          max_tokens: params.maxTokens ?? 1024,
          system: params.system,
          messages: [{ role: "user", content: params.user }],
        },
        params.timeoutMs ? { timeout: params.timeoutMs } : undefined,
      );
      const textBlock = response.content?.find((block: any) => block.type === "text");
      rawText = textBlock?.text;
    } else {
      throw new Error("AI client does not support chat completions or messages");
    }
  } catch (err: unknown) {
    if (err && typeof err === "object") {
      const errObj = err as any;
      if (errObj.name === "APIConnectionTimeoutError" || errObj.code === "ETIMEDOUT") {
        const timeoutErr = new Error(`AI request timed out: ${errObj.message || "timeout"}`);
        (timeoutErr as any).status = 504;
        throw timeoutErr;
      }
      if (errObj.status === 429) {
        const rawMessage =
          typeof errObj.message === "string" ? errObj.message : "Too Many Requests";
        const sanitized = redactSensitiveData(rawMessage) as string;
        const rateLimitErr = new Error(`AI request rate limit reached: ${sanitized}`);
        (rateLimitErr as any).status = 429;
        throw rateLimitErr;
      }
      if (errObj.status === 401 || errObj.status === 403) {
        const authErr = new Error(
          "AI service authentication error. Please verify backend configuration.",
        );
        (authErr as any).status = 503;
        throw authErr;
      }
      if (errObj.status === 404) {
        const notFoundErr = new Error(
          `Configured AI model '${model}' is currently unavailable on OpenRouter free router.`,
        );
        (notFoundErr as any).status = 503;
        throw notFoundErr;
      }
      if (errObj.status === 502 || errObj.status === 503 || errObj.status === 504) {
        const unavailableErr = new Error(
          "AI service is temporarily unavailable. Please try again shortly.",
        );
        (unavailableErr as any).status = 503;
        throw unavailableErr;
      }
      const rawMessage = typeof errObj.message === "string" ? errObj.message : String(err);
      const sanitized = redactSensitiveData(rawMessage) as string;
      const genericErr = new Error(sanitized);
      (genericErr as any).status = errObj.status || 500;
      throw genericErr;
    }
    throw err;
  }

  if (!rawText || typeof rawText !== "string" || !rawText.trim()) {
    throw new Error("AI response contained no text content");
  }

  // Strip potential reasoning tags (e.g. <think>...</think> from reasoning models)
  const withoutThinking = rawText.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();

  // Extract from markdown code fences if present, or strip fence tokens
  const fenceMatch = withoutThinking.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  const candidate = fenceMatch
    ? fenceMatch[1].trim()
    : withoutThinking
        .replace(/^```json\s*/i, "")
        .replace(/^```\s*/i, "")
        .replace(/```\s*$/i, "")
        .trim();

  try {
    return JSON.parse(candidate) as T;
  } catch (err) {
    const objectMatch = candidate.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
    if (objectMatch) {
      try {
        return JSON.parse(objectMatch[1]) as T;
      } catch {
        // Fall through
      }
    }
    throw new Error(`AI response was not valid JSON: ${(err as Error).message}`);
  }
}
