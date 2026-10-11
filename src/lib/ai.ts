import Anthropic from "@anthropic-ai/sdk";
import { env } from "../config/env.js";

/**
 * DeepSeek AI Provider wrapper using DeepSeek's Anthropic-compatible API endpoint
 * (https://api.deepseek.com/anthropic).
 *
 * Supported model IDs:
 * - Fast:  `deepseek-flash`  (default for routine drafting, intelligence)
 * - Pro:   `deepseek-v4-pro` (reserved for tasks configured for stronger tier)
 *
 * Grounded with real facts pulled from Postgres — the model is asked to
 * explain/prioritize/summarize/draft supplied facts, never to invent
 * business data.
 *
 * If DEEPSEEK_API_KEY isn't configured, AI routes degrade to 503 rather than
 * the gateway crashing on boot — Discover, CRM, Pipeline, and Mission do
 * not depend on this.
 */

export type ModelTier = "fast" | "pro";

export const AI_MODELS = {
  fast: env.DEEPSEEK_FAST_MODEL,
  pro: env.DEEPSEEK_PRO_MODEL,
} as const;

/** Resolves model identifier for given tier. */
export function getAiModel(tier: ModelTier = "fast"): string {
  return tier === "pro" ? env.DEEPSEEK_PRO_MODEL : env.DEEPSEEK_FAST_MODEL;
}

/** Default model alias for backwards compatibility. */
export const AI_MODEL = env.DEEPSEEK_FAST_MODEL;

let client: Anthropic | null = null;

export function aiEnabled(): boolean {
  return Boolean(env.DEEPSEEK_API_KEY);
}

export function getClient(): Anthropic {
  if (client) {
    return client;
  }
  if (!env.DEEPSEEK_API_KEY) {
    throw new Error("DEEPSEEK_API_KEY not configured");
  }
  client = new Anthropic({
    apiKey: env.DEEPSEEK_API_KEY,
    baseURL: env.DEEPSEEK_BASE_URL,
  });
  return client;
}

/** Allow mocking/resetting client in tests. */
export function setAiClient(mockClient: Anthropic | null): void {
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
  const deepseek = getClient();
  const model = params.model ?? getAiModel(params.tier ?? "fast");

  let response: Anthropic.Message;
  try {
    response = await deepseek.messages.create(
      {
        model,
        max_tokens: params.maxTokens ?? 1024,
        system: params.system,
        messages: [{ role: "user", content: params.user }],
      },
      params.timeoutMs ? { timeout: params.timeoutMs } : undefined,
    );
  } catch (err: unknown) {
    if (err && typeof err === "object" && (err as { name?: string }).name === "APIConnectionTimeoutError") {
      throw new Error(`AI request timed out: ${(err as Error).message}`);
    }
    throw err;
  }

  const textBlock = response.content.find((block) => block.type === "text");
  if (!textBlock || textBlock.type !== "text") {
    throw new Error("AI response contained no text content");
  }

  const cleaned = textBlock.text
    .trim()
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/```\s*$/i, "");

  try {
    return JSON.parse(cleaned) as T;
  } catch (err) {
    throw new Error(`AI response was not valid JSON: ${(err as Error).message}`);
  }
}
