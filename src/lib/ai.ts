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

export interface ResponseAnalysis {
  text: string;
  hasContent: boolean;
  contentType: "string" | "array" | "legacy_text" | "empty";
  characterCount: number;
  finishReason: string | null;
  hasReasoning: boolean;
  hasRefusal: boolean;
  refusalText?: string;
  hasToolCalls: boolean;
  responseModel?: string;
}

/**
 * Extracts and analyzes choice payload from an OpenAI-compatible completion.
 * Handles strings, multi-part array content, legacy choice.text, refusal fields,
 * reasoning tokens, and tool calls.
 */
export function analyzeChoice(choice: any, responseModel?: string): ResponseAnalysis {
  if (!choice) {
    return {
      text: "",
      hasContent: false,
      contentType: "empty",
      characterCount: 0,
      finishReason: null,
      hasReasoning: false,
      hasRefusal: false,
      hasToolCalls: false,
      responseModel,
    };
  }

  const message = choice.message;
  const finishReason = choice.finish_reason ?? null;

  const refusal = message?.refusal || choice.refusal;
  const hasRefusal = Boolean(refusal && typeof refusal === "string" && refusal.trim().length > 0);
  const refusalText = hasRefusal ? refusal.trim() : undefined;

  const reasoning = message?.reasoning || message?.reasoning_content;
  const hasReasoning = Boolean(reasoning && typeof reasoning === "string" && reasoning.trim().length > 0);

  const hasToolCalls = Boolean(
    Array.isArray(message?.tool_calls) && message.tool_calls.length > 0,
  );

  let raw = message?.content;
  let contentType: ResponseAnalysis["contentType"] = "empty";
  let extractedText = "";

  if (typeof raw === "string") {
    extractedText = raw;
    contentType = "string";
  } else if (Array.isArray(raw)) {
    contentType = "array";
    extractedText = raw
      .map((part) => {
        if (typeof part === "string") return part;
        if (typeof part?.text === "string") return part.text;
        if (typeof part?.text?.value === "string") return part.text.value;
        return "";
      })
      .join("");
  } else if (typeof choice.text === "string") {
    extractedText = choice.text;
    contentType = "legacy_text";
  }

  const trimmed = extractedText.trim();
  const hasContent = trimmed.length > 0;

  return {
    text: trimmed,
    hasContent,
    contentType: hasContent ? contentType : "empty",
    characterCount: trimmed.length,
    finishReason,
    hasReasoning,
    hasRefusal,
    refusalText,
    hasToolCalls,
    responseModel,
  };
}

/**
 * Extracts and analyzes response payload from an Anthropic-compatible message.
 */
export function analyzeAnthropicResponse(response: any): ResponseAnalysis {
  if (!response) {
    return {
      text: "",
      hasContent: false,
      contentType: "empty",
      characterCount: 0,
      finishReason: null,
      hasReasoning: false,
      hasRefusal: false,
      hasToolCalls: false,
      responseModel: undefined,
    };
  }

  const finishReason = response.stop_reason ?? null;
  let extractedText = "";
  let contentType: ResponseAnalysis["contentType"] = "empty";

  if (Array.isArray(response.content)) {
    contentType = "array";
    const textBlocks = response.content.filter(
      (b: any) => b?.type === "text" && typeof b?.text === "string",
    );
    extractedText = textBlocks.map((b: any) => b.text).join("");
  }

  const trimmed = extractedText.trim();
  const hasContent = trimmed.length > 0;

  return {
    text: trimmed,
    hasContent,
    contentType: hasContent ? contentType : "empty",
    characterCount: trimmed.length,
    finishReason,
    hasReasoning: false,
    hasRefusal: false,
    hasToolCalls: false,
    responseModel: response.model,
  };
}

/**
 * Structured, safe diagnostic log helper.
 * Strictly avoids logging API keys, authorization headers, prompt bodies, full assistant replies,
 * or lead personal/business data.
 */
function logAiDiagnostic(
  tag: string,
  data: Record<string, string | number | boolean | null | undefined>,
): void {
  const safeData: Record<string, string | number | boolean | null | undefined> = {};
  for (const [key, val] of Object.entries(data)) {
    if (val !== undefined) {
      safeData[key] = val;
    }
  }
  console.info(`[${tag}] ${JSON.stringify(safeData)}`);
}

/**
 * Sanitizes and maps provider SDK exceptions to honest HTTP status errors.
 */
function handleProviderError(err: unknown, model: string): never {
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

/**
 * Sends a system + user prompt and parses the reply as JSON.
 * Features:
 * - Robust multi-part and string choice extraction.
 * - Distinguishes empty content, reasoning tokens, token exhaustion (finish_reason: length), and refusals.
 * - Single bounded retry for transient empty completions or length exhaustion during reasoning.
 * - Safe diagnostic structured logging without secrets or prompt data.
 * - Preserves honest errors when the API key is missing or the provider fails.
 */
export async function generateJSON<T>(params: {
  system: string;
  user: string;
  maxTokens?: number;
  tier?: ModelTier;
  model?: string;
  timeoutMs?: number;
  retryDelayMs?: number;
}): Promise<T> {
  const ai = getClient();
  const model = params.model ?? getAiModel(params.tier ?? "fast");
  const maxTokens = params.maxTokens ?? 2048;
  const correlationId = `ai-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
  const retryDelayMs = params.retryDelayMs ?? (process.env.NODE_ENV === "test" ? 10 : 500);

  let rawText = "";

  for (let attempt = 1; attempt <= 2; attempt++) {
    let lastAnalysis: ResponseAnalysis | null = null;

    try {
      if (typeof ai.chat?.completions?.create === "function") {
        const completion = await ai.chat.completions.create(
          {
            model,
            messages: [
              { role: "system", content: params.system },
              { role: "user", content: params.user },
            ],
            max_tokens: maxTokens,
          },
          params.timeoutMs ? { timeout: params.timeoutMs } : undefined,
        );
        const choice = completion?.choices?.[0];
        lastAnalysis = analyzeChoice(choice, completion?.model);
      } else if (typeof ai.messages?.create === "function") {
        const response = await ai.messages.create(
          {
            model,
            max_tokens: maxTokens,
            system: params.system,
            messages: [{ role: "user", content: params.user }],
          },
          params.timeoutMs ? { timeout: params.timeoutMs } : undefined,
        );
        lastAnalysis = analyzeAnthropicResponse(response);
      } else {
        throw new Error("AI client does not support chat completions or messages");
      }
    } catch (err: unknown) {
      handleProviderError(err, model);
    }

    logAiDiagnostic("ai:response", {
      correlationId,
      requestedModel: model,
      responseModel: lastAnalysis?.responseModel ?? "unknown",
      attempt,
      finishReason: lastAnalysis?.finishReason,
      contentType: lastAnalysis?.contentType,
      characterCount: lastAnalysis?.characterCount,
      hasContent: lastAnalysis?.hasContent,
      hasReasoning: lastAnalysis?.hasReasoning,
      hasRefusal: lastAnalysis?.hasRefusal,
      hasToolCalls: lastAnalysis?.hasToolCalls,
      stage: "extracted",
    });

    if (lastAnalysis.hasRefusal) {
      const refusalErr = new Error(`AI model refused request: ${lastAnalysis.refusalText}`);
      (refusalErr as any).status = 400;
      throw refusalErr;
    }

    if (!lastAnalysis.hasContent) {
      if (attempt === 1) {
        const reason =
          lastAnalysis.finishReason === "length"
            ? "length_truncation_empty"
            : lastAnalysis.hasReasoning
              ? "reasoning_without_content"
              : lastAnalysis.hasToolCalls
                ? "tool_calls_without_content"
                : "empty_response";
        logAiDiagnostic("ai:retry", {
          correlationId,
          attempt: 1,
          reason,
          delayMs: retryDelayMs,
        });
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
        continue;
      }

      // Final attempt failed
      if (lastAnalysis.finishReason === "length") {
        const err = new Error(
          "AI response exceeded token limit (finish_reason: length). Please retry.",
        );
        (err as any).status = 503;
        throw err;
      }
      if (lastAnalysis.hasReasoning) {
        const err = new Error(
          "AI model returned reasoning without final text content. Please retry.",
        );
        (err as any).status = 503;
        throw err;
      }
      if (lastAnalysis.hasToolCalls) {
        const err = new Error("AI model returned unexpected tool call. Please retry.");
        (err as any).status = 503;
        throw err;
      }
      const err = new Error("AI response contained no text content. Please retry.");
      (err as any).status = 503;
      throw err;
    }

    // Strip potential reasoning tags (e.g. <think>...</think> from reasoning models)
    const withoutThinking = lastAnalysis.text.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
    if (!withoutThinking) {
      if (attempt === 1) {
        logAiDiagnostic("ai:retry", {
          correlationId,
          attempt: 1,
          reason: "thinking_tags_only_without_content",
          delayMs: retryDelayMs,
        });
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
        continue;
      }
      const err = new Error(
        "AI model returned reasoning tags without final content. Please retry.",
      );
      (err as any).status = 503;
      throw err;
    }

    rawText = withoutThinking;
    break;
  }

  logAiDiagnostic("ai:stage", {
    correlationId,
    stage: "thinking_stripped",
    characterCount: rawText.length,
  });

  // Extract from markdown code fences if present, or strip fence tokens
  let candidate = rawText;
  const fenceMatch = rawText.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenceMatch && fenceMatch[1].trim()) {
    candidate = fenceMatch[1].trim();
  } else {
    candidate = rawText
      .replace(/^```json\s*/i, "")
      .replace(/^```\s*/i, "")
      .replace(/```\s*$/i, "")
      .trim();
  }

  logAiDiagnostic("ai:stage", {
    correlationId,
    stage: "code_fence_processed",
    characterCount: candidate.length,
  });

  try {
    const parsed = JSON.parse(candidate) as T;
    logAiDiagnostic("ai:success", {
      correlationId,
      stage: "json_parsed",
    });
    return parsed;
  } catch (parseErr) {
    const objectMatch = candidate.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
    if (objectMatch) {
      try {
        const parsed = JSON.parse(objectMatch[1]) as T;
        logAiDiagnostic("ai:success", {
          correlationId,
          stage: "json_parsed_regex_fallback",
        });
        return parsed;
      } catch {
        // Fall through
      }
    }
    if (candidate.length > 0 && candidate.endsWith("...")) {
      const cutErr = new Error("AI response was cut off before valid JSON could finish. Please retry.");
      (cutErr as any).status = 503;
      throw cutErr;
    }
    const jsonErr = new Error(`AI response was not valid JSON: ${(parseErr as Error).message}`);
    (jsonErr as any).status = 502;
    throw jsonErr;
  }
}
