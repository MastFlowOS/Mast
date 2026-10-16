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
    const apiKey = env.OPENROUTER_API_KEY.trim().replace(/^["']|["']$/g, "");
    const baseURL = (env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1")
      .trim()
      .replace(/\/+$/, "");
    client = new OpenAI({
      apiKey,
      baseURL,
      maxRetries: 0,
      defaultHeaders: {
        "HTTP-Referer": "https://mast.ai",
        "X-Title": "MAST OS",
      },
    });
    return client;
  }
  if (env.DEEPSEEK_API_KEY) {
    const apiKey = env.DEEPSEEK_API_KEY.trim().replace(/^["']|["']$/g, "");
    const baseURL = (env.DEEPSEEK_BASE_URL || "https://api.deepseek.com/anthropic")
      .trim()
      .replace(/\/+$/, "");
    client = new Anthropic({
      apiKey,
      baseURL,
      maxRetries: 0,
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
  tokenUsage?: {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
  };
}

/**
 * Extracts and analyzes choice payload from an OpenAI-compatible completion.
 * Handles strings, multi-part array content, legacy choice.text, refusal fields,
 * reasoning tokens, tool calls, and token usage counts.
 */
export function analyzeChoice(
  choice: any,
  responseModel?: string,
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number },
): ResponseAnalysis {
  const tokenUsage = usage
    ? {
        promptTokens: usage.prompt_tokens,
        completionTokens: usage.completion_tokens,
        totalTokens: usage.total_tokens,
      }
    : undefined;

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
      tokenUsage,
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
    tokenUsage,
  };
}

/**
 * Extracts and analyzes response payload from an Anthropic-compatible message.
 */
export function analyzeAnthropicResponse(response: any): ResponseAnalysis {
  const tokenUsage = response?.usage
    ? {
        promptTokens: response.usage.input_tokens,
        completionTokens: response.usage.output_tokens,
        totalTokens: (response.usage.input_tokens ?? 0) + (response.usage.output_tokens ?? 0),
      }
    : undefined;

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
      tokenUsage,
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
    tokenUsage,
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

export interface AiExecutionMetrics {
  correlationId: string;
  feature: string;
  model: string;
  responseModel?: string;
  cacheHit: boolean;
  contextPrepMs?: number;
  modelDurationMs: number;
  parseDurationMs: number;
  totalDurationMs: number;
  retryCount: number;
  retryReasons: string[];
  outcome:
    | "success"
    | "timeout"
    | "rate_limited"
    | "provider_failure"
    | "invalid_response"
    | "cancelled"
    | "refusal";
  tokenUsage?: {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
  };
}

export function logAiMetric(metric: AiExecutionMetrics): void {
  const safeData: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(metric)) {
    if (val !== undefined) {
      safeData[key] = val;
    }
  }
  console.info(`[ai:metric] ${JSON.stringify(safeData)}`);
}

/**
 * Sanitizes and maps provider SDK exceptions to honest HTTP status errors.
 */
export function handleProviderError(err: unknown, model: string): never {
  if (err && typeof err === "object") {
    const errObj = err as any;
    if (
      errObj.name === "APIConnectionTimeoutError" ||
      errObj.name === "TimeoutError" ||
      errObj.code === "ETIMEDOUT" ||
      errObj.name === "AbortError" ||
      errObj.code === "ABORT_ERR" ||
      (typeof errObj.message === "string" && /timed?\s*out|deadline/i.test(errObj.message))
    ) {
      const timeoutErr = new Error(`AI request timed out: ${errObj.message || "timeout"}`);
      (timeoutErr as any).status = 504;
      (timeoutErr as any).code = "ai_timeout";
      throw timeoutErr;
    }
    if (errObj.status === 429) {
      const rawMessage =
        typeof errObj.message === "string" ? errObj.message : "Too Many Requests";
      const sanitized = redactSensitiveData(rawMessage) as string;
      const rateLimitErr = new Error(`AI request rate limit reached: ${sanitized}`);
      (rateLimitErr as any).status = 429;
      (rateLimitErr as any).code = "rate_limit_exceeded";
      throw rateLimitErr;
    }
    if (errObj.status === 401 || errObj.status === 403) {
      const authErr = new Error(
        "AI service authentication error. Please verify backend configuration.",
      );
      (authErr as any).status = 503;
      (authErr as any).code = "ai_auth_error";
      throw authErr;
    }
    if (errObj.status === 404) {
      const notFoundErr = new Error(
        `Configured AI model '${model}' is currently unavailable on OpenRouter free router.`,
      );
      (notFoundErr as any).status = 503;
      (notFoundErr as any).code = "model_not_found";
      throw notFoundErr;
    }
    if (errObj.status === 502 || errObj.status === 503 || errObj.status === 504) {
      const unavailableErr = new Error(
        "AI service is temporarily unavailable. Please try again shortly.",
      );
      (unavailableErr as any).status = 503;
      (unavailableErr as any).code = "ai_provider_unavailable";
      throw unavailableErr;
    }
    const rawMessage = typeof errObj.message === "string" ? errObj.message : String(err);
    const sanitized = redactSensitiveData(rawMessage) as string;
    const genericErr = new Error(sanitized);
    (genericErr as any).status = errObj.status || 500;
    (genericErr as any).code = errObj.code || "ai_error";
    throw genericErr;
  }
  throw err;
}

/**
 * Attempts to repair common LLM JSON syntax errors:
 * 1. Trailing commas before closing braces/brackets (e.g. `[1, 2, ]`)
 * 2. Truncated output with unclosed strings (e.g. `{"headline": "Review your leads`)
 * 3. Truncated output with unclosed brackets and braces (e.g. `{"items": [{"name": "Foo"`)
 */
export function repairAndParseJson<T>(candidate: string): T | null {
  let text = candidate.trim();
  const startIdx = text.search(/[{\[]/);
  if (startIdx === -1) return null;
  text = text.slice(startIdx);

  // Strip trailing commas before } or ]
  let fixed = text.replace(/,(\s*[}\]])/g, "$1");

  try {
    return JSON.parse(fixed) as T;
  } catch {
    // Continue with structural repair
  }

  // Scan for unbalanced quotes, brackets, and braces
  let inString = false;
  let escaped = false;
  const stack: ("{" | "[")[] = [];

  for (let i = 0; i < fixed.length; i++) {
    const char = fixed[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (!inString) {
      if (char === "{" || char === "[") {
        stack.push(char);
      } else if (char === "}" && stack.length > 0 && stack[stack.length - 1] === "{") {
        stack.pop();
      } else if (char === "]" && stack.length > 0 && stack[stack.length - 1] === "[") {
        stack.pop();
      }
    }
  }

  // If ended mid-string, close the quote
  if (inString) {
    fixed += '"';
  }

  // Close remaining open brackets and braces in LIFO order
  while (stack.length > 0) {
    const open = stack.pop();
    if (open === "{") fixed += "}";
    else if (open === "[") fixed += "]";
  }

  // Clean trailing commas again if any were exposed before newly added closing tokens
  fixed = fixed.replace(/,(\s*[}\]])/g, "$1");

  try {
    return JSON.parse(fixed) as T;
  } catch {
    return null;
  }
}

/**
 * Sends a system + user prompt and parses the reply as JSON.
 * Features:
 * - Robust multi-part and string choice extraction.
 * - Distinguishes empty content, reasoning tokens, token exhaustion (finish_reason: length), and refusals.
 * - Bounded end-to-end deadline budget (defaults to ~18s; 15s in tests).
 * - AbortController socket cleanup to prevent hanging connections.
 * - Single bounded retry for transient empty completions or transient 502/503/504 errors within remaining budget.
 * - Never retries non-transient failures (400, 401, 403, 429).
 * - Safe diagnostic and performance metric logging without secrets or prompt data.
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
  feature?: string;
  contextPrepMs?: number;
  correlationId?: string;
}): Promise<T> {
  const ai = getClient();
  const feature = params.feature ?? "general";
  const model = params.model ?? getAiModel(params.tier ?? "fast");
  const maxTokens = params.maxTokens ?? (params.tier === "fast" ? 800 : 1200);
  const correlationId = params.correlationId ?? `ai-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
  const retryDelayMs = params.retryDelayMs ?? (process.env.NODE_ENV === "test" ? 10 : 500);

  // Total bounded execution deadline (default 28,000ms wall-clock budget for interactive AI across free routers)
  const totalTimeoutMs = params.timeoutMs ?? (process.env.NODE_ENV === "test" ? 15_000 : 28_000);
  const deadline = Date.now() + totalTimeoutMs;
  const overallStart = Date.now();

  let retryCount = 0;
  const retryReasons: string[] = [];
  let tokenUsage: { promptTokens?: number; completionTokens?: number; totalTokens?: number } | undefined;
  let responseModel: string | undefined;
  let modelDurationMs = 0;
  let rawText = "";

  for (let attempt = 1; attempt <= 2; attempt++) {
    const remainingMs = deadline - Date.now();
    if (attempt > 1 && remainingMs <= 2500) {
      logAiMetric({
        correlationId,
        feature,
        model,
        responseModel,
        cacheHit: false,
        contextPrepMs: params.contextPrepMs,
        modelDurationMs,
        parseDurationMs: 0,
        totalDurationMs: Date.now() - overallStart,
        retryCount,
        retryReasons,
        outcome: "timeout",
        tokenUsage,
      });
      const deadlineErr = new Error(
        `AI request exceeded total latency budget of ${totalTimeoutMs}ms before attempt ${attempt}`,
      );
      (deadlineErr as any).status = 504;
      (deadlineErr as any).code = "ai_timeout";
      throw deadlineErr;
    }

    const attemptTimeout = Math.max(1000, Math.min(remainingMs, 24_000));
    const abortController = new AbortController();
    const abortTimer = setTimeout(() => {
      abortController.abort(new Error(`AI attempt timed out after ${attemptTimeout}ms`));
    }, attemptTimeout);

    let lastAnalysis: ResponseAnalysis | null = null;
    const modelStart = Date.now();

    try {
      if (typeof ai.chat?.completions?.create === "function") {
        const completionParams: Record<string, unknown> = {
          model,
          messages: [
            { role: "system", content: params.system },
            { role: "user", content: params.user },
          ],
          max_tokens: maxTokens,
          temperature: 0.3,
        };

        // OpenRouter optimizations for free tier router
        if (env.OPENROUTER_API_KEY) {
          completionParams.reasoning = { effort: "low" };
          if (model === "openrouter/free" || model.includes(":free")) {
            completionParams.models = [
              model,
              "google/gemma-4-26b-a4b-it:free",
              "nvidia/nemotron-3.5-lightning:free",
              "openrouter/free",
            ];
          }
        }

        const completion = await ai.chat.completions.create(
          completionParams as any,
          {
            timeout: attemptTimeout,
            signal: abortController.signal,
          },
        );
        clearTimeout(abortTimer);
        modelDurationMs += Date.now() - modelStart;
        const choice = completion?.choices?.[0];
        lastAnalysis = analyzeChoice(choice, completion?.model, completion?.usage);
      } else if (typeof ai.messages?.create === "function") {
        const response = await ai.messages.create(
          {
            model,
            max_tokens: maxTokens,
            system: params.system,
            messages: [{ role: "user", content: params.user }],
          },
          {
            timeout: attemptTimeout,
            signal: abortController.signal,
          },
        );
        clearTimeout(abortTimer);
        modelDurationMs += Date.now() - modelStart;
        lastAnalysis = analyzeAnthropicResponse(response);
      } else {
        clearTimeout(abortTimer);
        throw new Error("AI client does not support chat completions or messages");
      }
    } catch (err: unknown) {
      clearTimeout(abortTimer);
      modelDurationMs += Date.now() - modelStart;

      const errObj = err as any;
      const isTransient =
        errObj?.status === 502 ||
        errObj?.status === 503 ||
        errObj?.status === 504 ||
        errObj?.name === "APIConnectionError" ||
        errObj?.name === "AbortError" ||
        errObj?.name === "TimeoutError" ||
        errObj?.name === "APIConnectionTimeoutError" ||
        errObj?.code === "ETIMEDOUT" ||
        errObj?.code === "ECONNRESET";
      const isRateLimitOrAuth =
        errObj?.status === 429 ||
        errObj?.status === 401 ||
        errObj?.status === 403 ||
        errObj?.status === 400;

      const timeRemaining = deadline - Date.now();
      if (attempt === 1 && isTransient && !isRateLimitOrAuth && timeRemaining >= 4000) {
        retryCount++;
        const reason = `transient_error_${errObj?.status || errObj?.name || errObj?.code || "unknown"}`;
        retryReasons.push(reason);
        logAiDiagnostic("ai:retry", {
          correlationId,
          attempt: 1,
          reason,
          delayMs: retryDelayMs,
        });
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
        continue;
      }

      const outcome =
        errObj?.status === 504 ||
        errObj?.name === "AbortError" ||
        errObj?.name === "TimeoutError" ||
        errObj?.name === "APIConnectionTimeoutError" ||
        errObj?.code === "ETIMEDOUT"
          ? "timeout"
          : errObj?.status === 429
            ? "rate_limited"
            : "provider_failure";

      logAiMetric({
        correlationId,
        feature,
        model,
        responseModel,
        cacheHit: false,
        contextPrepMs: params.contextPrepMs,
        modelDurationMs,
        parseDurationMs: 0,
        totalDurationMs: Date.now() - overallStart,
        retryCount,
        retryReasons,
        outcome,
        tokenUsage,
      });

      handleProviderError(err, model);
    }

    if (lastAnalysis) {
      responseModel = lastAnalysis.responseModel;
      if (lastAnalysis.tokenUsage) {
        tokenUsage = lastAnalysis.tokenUsage;
      }
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

    if (lastAnalysis?.hasRefusal) {
      logAiMetric({
        correlationId,
        feature,
        model,
        responseModel,
        cacheHit: false,
        contextPrepMs: params.contextPrepMs,
        modelDurationMs,
        parseDurationMs: 0,
        totalDurationMs: Date.now() - overallStart,
        retryCount,
        retryReasons,
        outcome: "refusal",
        tokenUsage,
      });
      const refusalErr = new Error(`AI model refused request: ${lastAnalysis.refusalText}`);
      (refusalErr as any).status = 400;
      (refusalErr as any).code = "model_refusal";
      throw refusalErr;
    }

    if (!lastAnalysis?.hasContent) {
      const timeRemaining = deadline - Date.now();
      if (attempt === 1 && timeRemaining >= 4000) {
        retryCount++;
        const reason =
          lastAnalysis?.finishReason === "length"
            ? "length_truncation_empty"
            : lastAnalysis?.hasReasoning
              ? "reasoning_without_content"
              : lastAnalysis?.hasToolCalls
                ? "tool_calls_without_content"
                : "empty_response";
        retryReasons.push(reason);
        logAiDiagnostic("ai:retry", {
          correlationId,
          attempt: 1,
          reason,
          delayMs: retryDelayMs,
        });
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
        continue;
      }

      logAiMetric({
        correlationId,
        feature,
        model,
        responseModel,
        cacheHit: false,
        contextPrepMs: params.contextPrepMs,
        modelDurationMs,
        parseDurationMs: 0,
        totalDurationMs: Date.now() - overallStart,
        retryCount,
        retryReasons,
        outcome: "invalid_response",
        tokenUsage,
      });

      if (lastAnalysis?.finishReason === "length") {
        const err = new Error(
          "AI response exceeded token limit (finish_reason: length). Please retry.",
        );
        (err as any).status = 503;
        (err as any).code = "token_limit_exceeded";
        throw err;
      }
      if (lastAnalysis?.hasReasoning) {
        const err = new Error(
          "AI model returned reasoning without final text content. Please retry.",
        );
        (err as any).status = 503;
        (err as any).code = "empty_content_reasoning";
        throw err;
      }
      if (lastAnalysis?.hasToolCalls) {
        const err = new Error("AI model returned unexpected tool call. Please retry.");
        (err as any).status = 503;
        (err as any).code = "unexpected_tool_call";
        throw err;
      }
      const err = new Error("AI response contained no text content. Please retry.");
      (err as any).status = 503;
      (err as any).code = "empty_response";
      throw err;
    }

    // Strip potential reasoning tags (e.g. <think>...</think> from reasoning models)
    const withoutThinking = lastAnalysis.text.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
    if (!withoutThinking) {
      const timeRemaining = deadline - Date.now();
      if (attempt === 1 && timeRemaining >= 4000) {
        retryCount++;
        const reason = "thinking_tags_only_without_content";
        retryReasons.push(reason);
        logAiDiagnostic("ai:retry", {
          correlationId,
          attempt: 1,
          reason,
          delayMs: retryDelayMs,
        });
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
        continue;
      }
      logAiMetric({
        correlationId,
        feature,
        model,
        responseModel,
        cacheHit: false,
        contextPrepMs: params.contextPrepMs,
        modelDurationMs,
        parseDurationMs: 0,
        totalDurationMs: Date.now() - overallStart,
        retryCount,
        retryReasons,
        outcome: "invalid_response",
        tokenUsage,
      });
      const err = new Error(
        "AI model returned reasoning tags without final content. Please retry.",
      );
      (err as any).status = 503;
      (err as any).code = "thinking_tags_only";
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

  const parseStart = Date.now();
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
    const parseDurationMs = Date.now() - parseStart;
    logAiDiagnostic("ai:success", {
      correlationId,
      stage: "json_parsed",
    });

    logAiMetric({
      correlationId,
      feature,
      model,
      responseModel,
      cacheHit: false,
      contextPrepMs: params.contextPrepMs,
      modelDurationMs,
      parseDurationMs,
      totalDurationMs: Date.now() - overallStart,
      retryCount,
      retryReasons,
      outcome: "success",
      tokenUsage,
    });

    return parsed;
  } catch (parseErr) {
    const trimmed = candidate.trim();
    const startsWithObj = trimmed.startsWith("{");
    const startsWithArr = trimmed.startsWith("[");

    // If candidate starts with { or [, attempt structural repair of the top-level entity first
    if (startsWithObj || startsWithArr) {
      const repaired = repairAndParseJson<T>(candidate);
      if (repaired && typeof repaired === "object") {
        const parseDurationMs = Date.now() - parseStart;
        logAiDiagnostic("ai:success", {
          correlationId,
          stage: "json_parsed_repaired",
        });

        logAiMetric({
          correlationId,
          feature,
          model,
          responseModel,
          cacheHit: false,
          contextPrepMs: params.contextPrepMs,
          modelDurationMs,
          parseDurationMs,
          totalDurationMs: Date.now() - overallStart,
          retryCount,
          retryReasons,
          outcome: "success",
          tokenUsage,
        });

        return repaired;
      }
    }

    const objectMatch = candidate.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
    if (objectMatch) {
      try {
        const parsed = JSON.parse(objectMatch[1]) as T;
        // Don't return an inner array if candidate began with an object
        if (!startsWithObj || (parsed && typeof parsed === "object" && !Array.isArray(parsed))) {
          const parseDurationMs = Date.now() - parseStart;
          logAiDiagnostic("ai:success", {
            correlationId,
            stage: "json_parsed_regex_fallback",
          });

          logAiMetric({
            correlationId,
            feature,
            model,
            responseModel,
            cacheHit: false,
            contextPrepMs: params.contextPrepMs,
            modelDurationMs,
            parseDurationMs,
            totalDurationMs: Date.now() - overallStart,
            retryCount,
            retryReasons,
            outcome: "success",
            tokenUsage,
          });

          return parsed;
        }
      } catch {
        // Fall through to repair
      }
    }

    const repaired = repairAndParseJson<T>(candidate);
    if (repaired) {
      const parseDurationMs = Date.now() - parseStart;
      logAiDiagnostic("ai:success", {
        correlationId,
        stage: "json_parsed_repaired",
      });

      logAiMetric({
        correlationId,
        feature,
        model,
        responseModel,
        cacheHit: false,
        contextPrepMs: params.contextPrepMs,
        modelDurationMs,
        parseDurationMs,
        totalDurationMs: Date.now() - overallStart,
        retryCount,
        retryReasons,
        outcome: "success",
        tokenUsage,
      });

      return repaired;
    }

    const parseDurationMs = Date.now() - parseStart;
    logAiMetric({
      correlationId,
      feature,
      model,
      responseModel,
      cacheHit: false,
      contextPrepMs: params.contextPrepMs,
      modelDurationMs,
      parseDurationMs,
      totalDurationMs: Date.now() - overallStart,
      retryCount,
      retryReasons,
      outcome: "invalid_response",
      tokenUsage,
    });

    if (candidate.length > 0 && candidate.endsWith("...")) {
      const cutErr = new Error("AI response was cut off before valid JSON could finish. Please retry.");
      (cutErr as any).status = 503;
      (cutErr as any).code = "incomplete_json";
      throw cutErr;
    }
    const jsonErr = new Error(`AI response was not valid JSON: ${(parseErr as Error).message}`);
    (jsonErr as any).status = 502;
    (jsonErr as any).code = "invalid_json";
    throw jsonErr;
  }
}
