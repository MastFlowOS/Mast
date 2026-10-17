import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  aiEnabled,
  AI_MODEL,
  AI_MODELS,
  getAiModel,
  getClient,
  generateJSON,
  setAiClient,
  resetAiClient,
  analyzeChoice,
  repairAndParseJson,
} from "../ai.js";
import { env } from "../../config/env.js";

test("OpenRouter provider configuration defaults", () => {
  assert.equal(env.OPENROUTER_BASE_URL, "https://openrouter.ai/api/v1");
  assert.equal(env.OPENROUTER_MODEL, "openrouter/free");
  assert.equal(AI_MODEL, "openrouter/free");
  assert.equal(AI_MODELS.fast, "openrouter/free");
  assert.equal(AI_MODELS.pro, "openrouter/free");
  assert.equal(getAiModel("fast"), "openrouter/free");
  assert.equal(getAiModel("pro"), "openrouter/free");
});

test("aiEnabled reflects OPENROUTER_API_KEY presence", () => {
  const origOpenRouter = env.OPENROUTER_API_KEY;
  const origDeepSeek = env.DEEPSEEK_API_KEY;
  try {
    delete (env as any).DEEPSEEK_API_KEY;
    (env as any).OPENROUTER_API_KEY = "sk-or-v1-testkey123456789";
    assert.equal(aiEnabled(), true);

    (env as any).OPENROUTER_API_KEY = "";
    assert.equal(aiEnabled(), false);

    delete (env as any).OPENROUTER_API_KEY;
    assert.equal(aiEnabled(), false);
  } finally {
    (env as any).OPENROUTER_API_KEY = origOpenRouter;
    (env as any).DEEPSEEK_API_KEY = origDeepSeek;
    resetAiClient();
  }
});

test("getClient throws when OPENROUTER_API_KEY is missing", () => {
  const origOpenRouter = env.OPENROUTER_API_KEY;
  const origDeepSeek = env.DEEPSEEK_API_KEY;
  try {
    delete (env as any).OPENROUTER_API_KEY;
    delete (env as any).DEEPSEEK_API_KEY;
    resetAiClient();
    assert.throws(() => getClient(), {
      message: /OPENROUTER_API_KEY not configured/,
    });
  } finally {
    (env as any).OPENROUTER_API_KEY = origOpenRouter;
    (env as any).DEEPSEEK_API_KEY = origDeepSeek;
    resetAiClient();
  }
});

test("getClient instantiates OpenAI client with base URL https://openrouter.ai/api/v1", () => {
  const origOpenRouter = env.OPENROUTER_API_KEY;
  try {
    (env as any).OPENROUTER_API_KEY = "sk-or-v1-test-openrouter-key";
    resetAiClient();
    const client = getClient();
    assert.ok(client, "client should be created");
    assert.equal(client.baseURL, "https://openrouter.ai/api/v1");
  } finally {
    (env as any).OPENROUTER_API_KEY = origOpenRouter;
    resetAiClient();
  }
});

test("OpenRouter free model routing and explicit model override", async () => {
  let capturedModel: string | undefined;
  let capturedMessages: any[] = [];

  const mockClient = {
    chat: {
      completions: {
        create: async (params: { model: string; messages: any[] }) => {
          capturedModel = params.model;
          capturedMessages = params.messages;
          return {
            choices: [
              {
                message: {
                  role: "assistant",
                  content: '{"routed": true}',
                },
              },
            ],
          };
        },
      },
    },
  } as any;

  setAiClient(mockClient);
  try {
    // Fast tier defaults to openrouter/free
    const fastRes = await generateJSON<{ routed: boolean }>({
      system: "system prompt",
      user: "user prompt",
      tier: "fast",
    });
    assert.equal(capturedModel, "openrouter/free");
    assert.equal(fastRes.routed, true);
    assert.equal(capturedMessages.length, 2);
    assert.equal(capturedMessages[0].role, "system");
    assert.equal(capturedMessages[0].content, "system prompt");
    assert.equal(capturedMessages[1].role, "user");
    assert.equal(capturedMessages[1].content, "user prompt");

    // Pro tier also routes through openrouter/free
    const proRes = await generateJSON<{ routed: boolean }>({
      system: "system prompt",
      user: "user prompt",
      tier: "pro",
    });
    assert.equal(capturedModel, "openrouter/free");
    assert.equal(proRes.routed, true);

    // Explicit model override is respected
    await generateJSON<{ routed: boolean }>({
      system: "system",
      user: "user",
      model: "meta-llama/llama-3.2-3b-instruct:free",
    });
    assert.equal(capturedModel, "meta-llama/llama-3.2-3b-instruct:free");
  } finally {
    resetAiClient();
  }
});

test("generateJSON parses clean JSON and removes markdown code fences", async () => {
  const mockClient = {
    chat: {
      completions: {
        create: async () => ({
          choices: [
            {
              message: {
                role: "assistant",
                content: '```json\n{\n  "headline": "Prime Opportunity",\n  "score": 98\n}\n```',
              },
            },
          ],
        }),
      },
    },
  } as any;

  setAiClient(mockClient);
  try {
    const res = await generateJSON<{ headline: string; score: number }>({
      system: "system",
      user: "user",
    });
    assert.equal(res.headline, "Prime Opportunity");
    assert.equal(res.score, 98);
  } finally {
    resetAiClient();
  }
});

test("generateJSON parses output with <think> reasoning tags and preambles", async () => {
  const mockClient = {
    chat: {
      completions: {
        create: async () => ({
          choices: [
            {
              message: {
                role: "assistant",
                content:
                  "<think>\nLet's evaluate the business niche and draft a suitable headline.\n</think>\n" +
                  'Here is the parsed opportunity:\n```json\n{\n  "headline": "Great local bakery",\n  "talkingPoints": ["Strong brand", "Active IG"]\n}\n```',
              },
            },
          ],
        }),
      },
    },
  } as any;

  setAiClient(mockClient);
  try {
    const res = await generateJSON<{ headline: string; talkingPoints: string[] }>({
      system: "system",
      user: "user",
    });
    assert.equal(res.headline, "Great local bakery");
    assert.equal(res.talkingPoints.length, 2);
    assert.equal(res.talkingPoints[0], "Strong brand");
  } finally {
    resetAiClient();
  }
});

test("generateJSON throws error on malformed JSON output", async () => {
  const mockClient = {
    chat: {
      completions: {
        create: async () => ({
          choices: [
            {
              message: {
                role: "assistant",
                content: "I am unable to provide JSON for this request.",
              },
            },
          ],
        }),
      },
    },
  } as any;

  setAiClient(mockClient);
  try {
    await assert.rejects(
      async () => {
        await generateJSON({ system: "system", user: "user" });
      },
      {
        message: /AI response was not valid JSON/,
      },
    );
  } finally {
    resetAiClient();
  }
});

test("generateJSON throws error with status 503 after bounded retry when response contains no text content", async () => {
  let callCount = 0;
  const mockClient = {
    chat: {
      completions: {
        create: async () => {
          callCount++;
          return {
            choices: [
              {
                message: {
                  role: "assistant",
                  content: null,
                },
              },
            ],
          };
        },
      },
    },
  } as any;

  setAiClient(mockClient);
  try {
    await assert.rejects(
      async () => {
        await generateJSON({ system: "system", user: "user", retryDelayMs: 1 });
      },
      (err: any) => {
        assert.equal(err.status, 503);
        assert.match(err.message, /AI response contained no text content/);
        return true;
      },
    );
    assert.equal(callCount, 2, "bounded retry should have attempted once more before failing");
  } finally {
    resetAiClient();
  }
});

test("generateJSON recovers when attempt 1 is empty and attempt 2 returns valid content", async () => {
  let callCount = 0;
  const mockClient = {
    chat: {
      completions: {
        create: async () => {
          callCount++;
          if (callCount === 1) {
            return {
              choices: [
                {
                  message: {
                    role: "assistant",
                    content: null,
                  },
                },
              ],
            };
          }
          return {
            choices: [
              {
                message: {
                  role: "assistant",
                  content: '{"recovered": true}',
                },
              },
            ],
          };
        },
      },
    },
  } as any;

  setAiClient(mockClient);
  try {
    const res = await generateJSON<{ recovered: boolean }>({
      system: "system",
      user: "user",
      retryDelayMs: 1,
    });
    assert.equal(res.recovered, true);
    assert.equal(callCount, 2, "should recover on attempt 2");
  } finally {
    resetAiClient();
  }
});

test("generateJSON handles rate limits (429) gracefully without exposing secrets", async () => {
  const mockClient = {
    chat: {
      completions: {
        create: async () => {
          const err = new Error("OpenRouter rate limit exceeded for key sk-or-v1-secretkey9999");
          (err as any).status = 429;
          throw err;
        },
      },
    },
  } as any;

  setAiClient(mockClient);
  try {
    await assert.rejects(
      async () => {
        await generateJSON({ system: "system", user: "user" });
      },
      (err: any) => {
        assert.equal(err.status, 429);
        assert.match(err.message, /rate limit/i);
        // Must never leak the secret key
        assert.ok(
          !err.message.includes("sk-or-v1-secretkey9999"),
          "Error must not leak secret API key",
        );
        return true;
      },
    );
  } finally {
    resetAiClient();
  }
});

test("generateJSON handles service unavailable (503) gracefully", async () => {
  const mockClient = {
    chat: {
      completions: {
        create: async () => {
          const err = new Error("No free models currently available in openrouter/free pool");
          (err as any).status = 503;
          throw err;
        },
      },
    },
  } as any;

  setAiClient(mockClient);
  try {
    await assert.rejects(
      async () => {
        await generateJSON({ system: "system", user: "user" });
      },
      (err: any) => {
        assert.equal(err.status, 503);
        assert.match(err.message, /temporarily unavailable/i);
        return true;
      },
    );
  } finally {
    resetAiClient();
  }
});

test("generateJSON handles timeout (504) honestly", async () => {
  const mockClient = {
    chat: {
      completions: {
        create: async () => {
          const timeoutError = new Error("Connection timed out after 30000ms");
          timeoutError.name = "APIConnectionTimeoutError";
          throw timeoutError;
        },
      },
    },
  } as any;

  setAiClient(mockClient);
  try {
    await assert.rejects(
      async () => {
        await generateJSON({ system: "system", user: "user", timeoutMs: 30000 });
      },
      (err: any) => {
        assert.equal(err.status, 504);
        assert.match(err.message, /AI request timed out/i);
        return true;
      },
    );
  } finally {
    resetAiClient();
  }
});

test("generateJSON redacts any raw API key from error messages", async () => {
  const mockClient = {
    chat: {
      completions: {
        create: async () => {
          const err = new Error(
            "Authorization failed: Bearer sk-or-v1-abcdef1234567890abcdef1234567890",
          );
          (err as any).status = 500;
          throw err;
        },
      },
    },
  } as any;

  setAiClient(mockClient);
  try {
    await assert.rejects(
      async () => {
        await generateJSON({ system: "system", user: "user" });
      },
      (err: any) => {
        assert.ok(!err.message.includes("sk-or-v1-abcdef1234567890abcdef1234567890"));
        assert.ok(err.message.includes("[Redacted"));
        return true;
      },
    );
  } finally {
    resetAiClient();
  }
});

test("analyzeChoice correctly analyzes all choice variants", () => {
  // 1. Plain string content
  const stringRes = analyzeChoice({
    message: { role: "assistant", content: '{"hello": "world"}' },
    finish_reason: "stop",
  });
  assert.equal(stringRes.hasContent, true);
  assert.equal(stringRes.contentType, "string");
  assert.equal(stringRes.text, '{"hello": "world"}');
  assert.equal(stringRes.finishReason, "stop");
  assert.equal(stringRes.hasReasoning, false);
  assert.equal(stringRes.hasRefusal, false);

  // 2. Multi-part array format
  const arrayRes = analyzeChoice({
    message: {
      role: "assistant",
      content: [
        { type: "text", text: '{"part":' },
        { type: "text", text: ' 1}' },
      ],
    },
    finish_reason: "stop",
  });
  assert.equal(arrayRes.hasContent, true);
  assert.equal(arrayRes.contentType, "array");
  assert.equal(arrayRes.text, '{"part": 1}');

  // 3. Legacy choice.text
  const legacyRes = analyzeChoice({
    text: '{"legacy": true}',
    finish_reason: "stop",
  });
  assert.equal(legacyRes.hasContent, true);
  assert.equal(legacyRes.contentType, "legacy_text");
  assert.equal(legacyRes.text, '{"legacy": true}');

  // 4. Model refusal
  const refusalRes = analyzeChoice({
    message: { role: "assistant", content: null, refusal: "Content policy refusal" },
    finish_reason: "stop",
  });
  assert.equal(refusalRes.hasContent, false);
  assert.equal(refusalRes.hasRefusal, true);
  assert.equal(refusalRes.refusalText, "Content policy refusal");

  // 5. Reasoning model with reasoning and null content
  const reasoningRes = analyzeChoice({
    message: {
      role: "assistant",
      content: null,
      reasoning: "Thinking about the strategy...",
    },
    finish_reason: "stop",
  });
  assert.equal(reasoningRes.hasContent, false);
  assert.equal(reasoningRes.hasReasoning, true);

  // 6. Token limit exhaustion
  const lengthRes = analyzeChoice({
    message: { role: "assistant", content: null },
    finish_reason: "length",
  });
  assert.equal(lengthRes.hasContent, false);
  assert.equal(lengthRes.finishReason, "length");

  // 7. Empty choice
  const emptyRes = analyzeChoice(undefined);
  assert.equal(emptyRes.hasContent, false);
  assert.equal(emptyRes.contentType, "empty");
});

test("generateJSON extracts and parses array text-part format", async () => {
  const mockClient = {
    chat: {
      completions: {
        create: async () => ({
          choices: [
            {
              message: {
                role: "assistant",
                content: [
                  { type: "text", text: '{"subject": "Array Subject",' },
                  { type: "text", text: ' "body": "Array Body"}' },
                ],
              },
            },
          ],
        }),
      },
    },
  } as any;

  setAiClient(mockClient);
  try {
    const res = await generateJSON<{ subject: string; body: string }>({
      system: "system",
      user: "user",
    });
    assert.equal(res.subject, "Array Subject");
    assert.equal(res.body, "Array Body");
  } finally {
    resetAiClient();
  }
});

test("generateJSON rejects reasoning-only responses and never exposes reasoning as text", async () => {
  const mockClient = {
    chat: {
      completions: {
        create: async () => ({
          choices: [
            {
              finish_reason: "stop",
              message: {
                role: "assistant",
                content: null,
                reasoning: "I should pitch a fast website redesign because 4s load time is too slow",
              },
            },
          ],
        }),
      },
    },
  } as any;

  setAiClient(mockClient);
  try {
    await assert.rejects(
      async () => {
        await generateJSON({ system: "system", user: "user", retryDelayMs: 1 });
      },
      (err: any) => {
        assert.equal(err.status, 503);
        assert.match(err.message, /reasoning without final text content/i);
        // Ensure reasoning text was never returned as a valid object
        assert.ok(!err.message.includes("fast website redesign"));
        return true;
      },
    );
  } finally {
    resetAiClient();
  }
});

test("generateJSON identifies token limit exhaustion when finish_reason is length and content is empty", async () => {
  const mockClient = {
    chat: {
      completions: {
        create: async () => ({
          choices: [
            {
              finish_reason: "length",
              message: {
                role: "assistant",
                content: null,
                reasoning: "Long chain of thought that ran out of tokens...",
              },
            },
          ],
        }),
      },
    },
  } as any;

  setAiClient(mockClient);
  try {
    await assert.rejects(
      async () => {
        await generateJSON({ system: "system", user: "user", retryDelayMs: 1 });
      },
      (err: any) => {
        assert.equal(err.status, 503);
        assert.match(err.message, /exceeded token limit \(finish_reason: length\)/i);
        return true;
      },
    );
  } finally {
    resetAiClient();
  }
});

test("generateJSON rejects model refusals with 400 error without retrying", async () => {
  let callCount = 0;
  const mockClient = {
    chat: {
      completions: {
        create: async () => {
          callCount++;
          return {
            choices: [
              {
                message: {
                  role: "assistant",
                  content: null,
                  refusal: "I cannot fulfill this request because of policy restrictions.",
                },
              },
            ],
          };
        },
      },
    },
  } as any;

  setAiClient(mockClient);
  try {
    await assert.rejects(
      async () => {
        await generateJSON({ system: "system", user: "user", retryDelayMs: 1 });
      },
      (err: any) => {
        assert.equal(err.status, 400);
        assert.match(err.message, /refused request: I cannot fulfill this request/i);
        return true;
      },
    );
    assert.equal(callCount, 1, "Refusal must not be retried");
  } finally {
    resetAiClient();
  }
});

test("generateJSON rejects response containing only <think> tags without final output", async () => {
  const mockClient = {
    chat: {
      completions: {
        create: async () => ({
          choices: [
            {
              message: {
                role: "assistant",
                content: "<think>Let me ponder about the lead's website and marketing.</think>",
              },
            },
          ],
        }),
      },
    },
  } as any;

  setAiClient(mockClient);
  try {
    await assert.rejects(
      async () => {
        await generateJSON({ system: "system", user: "user", retryDelayMs: 1 });
      },
      (err: any) => {
        assert.equal(err.status, 503);
        assert.match(err.message, /reasoning tags without final content/i);
        return true;
      },
    );
  } finally {
    resetAiClient();
  }
});

test("repairAndParseJson recovers unclosed strings and brackets from truncated output", () => {
  // Trailing commas
  const trailingComma = repairAndParseJson('{"label": "High", "reasons": ["one", "two",],}');
  assert.deepEqual(trailingComma, { label: "High", reasons: ["one", "two"] });

  // Unclosed string and brace
  const unclosedStr = repairAndParseJson('{"headline": "Dentists in your area');
  assert.deepEqual(unclosedStr, { headline: "Dentists in your area" });

  // Unclosed nested array and object
  const unclosedNested = repairAndParseJson('{"label": "Patterns", "patterns": ["item 1", "item 2"');
  assert.deepEqual(unclosedNested, { label: "Patterns", patterns: ["item 1", "item 2"] });

  // Completely invalid non-JSON returns null
  assert.equal(repairAndParseJson("not a json at all"), null);
});

test("getClient strips surrounding quotes and whitespace from OPENROUTER_API_KEY", () => {
  const origKey = env.OPENROUTER_API_KEY;
  const origBase = env.OPENROUTER_BASE_URL;
  try {
    (env as any).OPENROUTER_API_KEY = '  "sk-or-v1-quoted-secret"  ';
    (env as any).OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1///";
    resetAiClient();
    const client = getClient();
    assert.equal(client.apiKey, "sk-or-v1-quoted-secret");
    assert.equal(client.baseURL, "https://openrouter.ai/api/v1");
  } finally {
    (env as any).OPENROUTER_API_KEY = origKey;
    (env as any).OPENROUTER_BASE_URL = origBase;
    resetAiClient();
  }
});

test("generateJSON passes clean payload for openrouter/free (no reasoning parameter, no models array)", async () => {
  let capturedPayload: any = null;
  const mockClient = {
    chat: {
      completions: {
        create: async (params: any) => {
          capturedPayload = params;
          return {
            choices: [
              {
                message: {
                  role: "assistant",
                  content: '{"result": "ok"}',
                },
              },
            ],
          };
        },
      },
    },
  } as any;

  setAiClient(mockClient);
  const origKey = env.OPENROUTER_API_KEY;
  try {
    (env as any).OPENROUTER_API_KEY = "sk-or-v1-test-key";
    const result = await generateJSON<{ result: string }>({
      system: "system prompt",
      user: "user prompt",
      model: "openrouter/free",
    });
    assert.equal(result.result, "ok");
    assert.ok(capturedPayload);
    // openrouter/free must not have reasoning parameter (unsupported by standard free models)
    assert.equal(capturedPayload.reasoning, undefined);
    // openrouter/free must not have models array (it is already the meta-router)
    assert.equal(capturedPayload.models, undefined);
    assert.equal(capturedPayload.model, "openrouter/free");
  } finally {
    (env as any).OPENROUTER_API_KEY = origKey;
    resetAiClient();
  }
});

test("generateJSON passes fallback models for specific :free models (length <= 3)", async () => {
  let capturedPayload: any = null;
  const mockClient = {
    chat: {
      completions: {
        create: async (params: any) => {
          capturedPayload = params;
          return {
            choices: [
              {
                message: {
                  role: "assistant",
                  content: '{"result": "ok"}',
                },
              },
            ],
          };
        },
      },
    },
  } as any;

  setAiClient(mockClient);
  const origKey = env.OPENROUTER_API_KEY;
  try {
    (env as any).OPENROUTER_API_KEY = "sk-or-v1-test-key";
    const specificFreeModel = "google/gemma-4-26b-a4b-it:free";
    const result = await generateJSON<{ result: string }>({
      system: "system prompt",
      user: "user prompt",
      model: specificFreeModel,
    });
    assert.equal(result.result, "ok");
    assert.ok(capturedPayload);
    // Non-reasoning model must not have reasoning parameter
    assert.equal(capturedPayload.reasoning, undefined);
    // Fallback models must be set and strictly <= 3 items
    assert.ok(Array.isArray(capturedPayload.models));
    assert.ok(capturedPayload.models.length <= 3, "'models' array must have 3 items or fewer");
    assert.deepEqual(capturedPayload.models, [specificFreeModel, "openrouter/free"]);
  } finally {
    (env as any).OPENROUTER_API_KEY = origKey;
    resetAiClient();
  }
});

test("generateJSON passes reasoning: { effort: 'low' } only for reasoning models", async () => {
  let capturedPayload: any = null;
  const mockClient = {
    chat: {
      completions: {
        create: async (params: any) => {
          capturedPayload = params;
          return {
            choices: [
              {
                message: {
                  role: "assistant",
                  content: '{"result": "ok"}',
                },
              },
            ],
          };
        },
      },
    },
  } as any;

  setAiClient(mockClient);
  const origKey = env.OPENROUTER_API_KEY;
  try {
    (env as any).OPENROUTER_API_KEY = "sk-or-v1-test-key";
    const reasoningModel = "deepseek/deepseek-r1:free";
    const result = await generateJSON<{ result: string }>({
      system: "system prompt",
      user: "user prompt",
      model: reasoningModel,
    });
    assert.equal(result.result, "ok");
    assert.ok(capturedPayload);
    assert.equal(capturedPayload.reasoning?.effort, "low");
    assert.ok(Array.isArray(capturedPayload.models));
    assert.ok(capturedPayload.models.length <= 3, "'models' array must have 3 items or fewer");
    assert.deepEqual(capturedPayload.models, [reasoningModel, "openrouter/free"]);
  } finally {
    (env as any).OPENROUTER_API_KEY = origKey;
    resetAiClient();
  }
});

