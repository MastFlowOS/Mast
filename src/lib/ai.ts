import Anthropic from "@anthropic-ai/sdk";
import { env } from "../config/env.js";

/**
 * Thin wrapper around the Anthropic API for Phase 8 (AI Opportunity
 * Intelligence). Every call in this module is JSON-structured and grounded
 * with real numbers pulled from Postgres by the caller — the model is
 * asked to explain/prioritize/summarize supplied facts, never to invent
 * business data. See lib/intelligenceContext.ts for what gets passed in.
 *
 * If ANTHROPIC_API_KEY isn't configured (e.g. local dev without it), AI
 * routes degrade to 503 rather than the gateway crashing on boot — the
 * rest of MAST (Discover, CRM, Pipeline, Mission) does not depend on this.
 */

let client: Anthropic | null = null;

export function aiEnabled(): boolean {
  return Boolean(env.ANTHROPIC_API_KEY);
}

function getClient(): Anthropic {
  if (!env.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY not configured");
  }
  if (!client) {
    client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  }
  return client;
}

export const AI_MODEL = env.ANTHROPIC_MODEL;

/**
 * Sends a system + user prompt and parses the reply as JSON. The system
 * prompt is expected to instruct the model to respond with ONLY a JSON
 * object matching the given shape — callers own their own schema/validation
 * (kept untyped here to avoid a runtime JSON-schema dependency for what's
 * currently a handful of call sites).
 */
export async function generateJSON<T>(params: {
  system: string;
  user: string;
  maxTokens?: number;
}): Promise<T> {
  const anthropic = getClient();

  const response = await anthropic.messages.create({
    model: AI_MODEL,
    max_tokens: params.maxTokens ?? 1024,
    system: params.system,
    messages: [{ role: "user", content: params.user }],
  });

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
