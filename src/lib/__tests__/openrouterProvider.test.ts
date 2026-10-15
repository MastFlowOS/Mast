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

test("generateJSON throws error when response contains no text content", async () => {
  const mockClient = {
    chat: {
      completions: {
        create: async () => ({
          choices: [
            {
              message: {
                role: "assistant",
                content: null,
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
        message: /AI response contained no text content/,
      },
    );
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
