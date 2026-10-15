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

test("DeepSeek provider backward-compatibility configuration", () => {
  const origKey = env.DEEPSEEK_API_KEY;
  const origOr = env.OPENROUTER_API_KEY;
  try {
    delete (env as any).OPENROUTER_API_KEY;
    (env as any).DEEPSEEK_API_KEY = "test-deepseek-key";
    assert.equal(getAiModel("fast"), "deepseek-flash");
    assert.equal(getAiModel("pro"), "deepseek-v4-pro");
    assert.equal(env.DEEPSEEK_BASE_URL, "https://api.deepseek.com/anthropic");
  } finally {
    (env as any).DEEPSEEK_API_KEY = origKey;
    (env as any).OPENROUTER_API_KEY = origOr;
  }
});

test("aiEnabled reflects DEEPSEEK_API_KEY presence", () => {
  const originalKey = env.DEEPSEEK_API_KEY;
  const originalOr = env.OPENROUTER_API_KEY;
  try {
    delete (env as any).OPENROUTER_API_KEY;
    (env as any).DEEPSEEK_API_KEY = "test-deepseek-key";
    assert.equal(aiEnabled(), true);

    (env as any).DEEPSEEK_API_KEY = "";
    assert.equal(aiEnabled(), false);

    delete (env as any).DEEPSEEK_API_KEY;
    assert.equal(aiEnabled(), false);
  } finally {
    (env as any).DEEPSEEK_API_KEY = originalKey;
    (env as any).OPENROUTER_API_KEY = originalOr;
    resetAiClient();
  }
});

test("getClient throws when API keys are missing", () => {
  const originalKey = env.DEEPSEEK_API_KEY;
  const originalOr = env.OPENROUTER_API_KEY;
  try {
    delete (env as any).OPENROUTER_API_KEY;
    delete (env as any).DEEPSEEK_API_KEY;
    resetAiClient();
    assert.throws(() => getClient(), {
      message: /(?:OPENROUTER|DEEPSEEK)_API_KEY not configured/,
    });
  } finally {
    (env as any).DEEPSEEK_API_KEY = originalKey;
    (env as any).OPENROUTER_API_KEY = originalOr;
    resetAiClient();
  }
});

test("Fast and Pro model selection with DeepSeek fallback", async () => {
  const origKey = env.DEEPSEEK_API_KEY;
  const origOr = env.OPENROUTER_API_KEY;
  (env as any).DEEPSEEK_API_KEY = "test-deepseek-key";
  delete (env as any).OPENROUTER_API_KEY;
  let capturedModel: string | undefined;

  const mockClient = {
    messages: {
      create: async (params: { model: string; messages: any[] }) => {
        capturedModel = params.model;
        return {
          content: [{ type: "text", text: '{"success": true}' }],
        };
      },
    },
  } as any;

  setAiClient(mockClient);
  try {
    // Fast tier (default)
    const resFast = await generateJSON<{ success: boolean }>({
      system: "system prompt",
      user: "user prompt",
      tier: "fast",
    });
    assert.equal(capturedModel, "deepseek-flash");
    assert.equal(resFast.success, true);

    // Pro tier
    const resPro = await generateJSON<{ success: boolean }>({
      system: "system prompt",
      user: "user prompt",
      tier: "pro",
    });
    assert.equal(capturedModel, "deepseek-v4-pro");
    assert.equal(resPro.success, true);

    // Explicit model override
    await generateJSON<{ success: boolean }>({
      system: "system prompt",
      user: "user prompt",
      model: "custom-deepseek-model",
    });
    assert.equal(capturedModel, "custom-deepseek-model");
  } finally {
    resetAiClient();
    (env as any).DEEPSEEK_API_KEY = origKey;
    (env as any).OPENROUTER_API_KEY = origOr;
  }
});

test("generateJSON parses clean JSON and removes markdown code fences", async () => {
  const mockClient = {
    messages: {
      create: async () => ({
        content: [
          {
            type: "text",
            text: '```json\n{\n  "headline": "Great opportunity",\n  "score": 95\n}\n```',
          },
        ],
      }),
    },
  } as any;

  setAiClient(mockClient);
  try {
    const res = await generateJSON<{ headline: string; score: number }>({
      system: "system",
      user: "user",
    });
    assert.equal(res.headline, "Great opportunity");
    assert.equal(res.score, 95);
  } finally {
    resetAiClient();
  }
});

test("generateJSON throws error on malformed JSON output", async () => {
  const mockClient = {
    messages: {
      create: async () => ({
        content: [{ type: "text", text: "This is not valid JSON at all" }],
      }),
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
    messages: {
      create: async () => ({
        content: [],
      }),
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

test("generateJSON honestly propagates provider errors", async () => {
  const mockClient = {
    messages: {
      create: async () => {
        const error = new Error("DeepSeek upstream error: 429 Too Many Requests");
        (error as any).status = 429;
        throw error;
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
        message: /429 Too Many Requests/,
      },
    );
  } finally {
    resetAiClient();
  }
});

test("generateJSON handles timeout honestly", async () => {
  const mockClient = {
    messages: {
      create: async () => {
        const timeoutError = new Error("Request timed out after 30000ms");
        timeoutError.name = "APIConnectionTimeoutError";
        throw timeoutError;
      },
    },
  } as any;

  setAiClient(mockClient);
  try {
    await assert.rejects(
      async () => {
        await generateJSON({ system: "system", user: "user", timeoutMs: 30000 });
      },
      {
        message: /AI request timed out/,
      },
    );
  } finally {
    resetAiClient();
  }
});
