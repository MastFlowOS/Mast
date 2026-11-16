import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { supabase as originalSupabase, setSupabaseClient } from "@/lib/supabase";
import {
  ApiError,
  getMe,
  invalidateProfileCache,
  isFutureIatApiError,
} from "@/lib/api";

type QueryResult = { data: unknown; error: unknown };

function createMockSession(accessToken: string, userId = "user-123") {
  return {
    access_token: accessToken,
    refresh_token: "refresh-token-abc",
    expires_in: 3600,
    token_type: "bearer",
    user: {
      id: userId,
      email: "user@example.com",
      user_metadata: { name: "Test User" },
      created_at: "2026-01-01T00:00:00.000Z",
    },
  };
}

function createProfileRow(userId = "user-123") {
  const nowIso = new Date().toISOString();
  return {
    id: userId,
    name: "Test User",
    company: "MAST",
    avatar_url: null,
    tier: "free",
    search_limit: 5,
    searches_used: 0,
    searches_reset_at: nowIso,
    usage_reset_at: nowIso,
    settings: { onboardingCompleted: "true" },
    created_at: nowIso,
    updated_at: nowIso,
  };
}

function createMockSupabase(options: {
  session: ReturnType<typeof createMockSession> | null;
  profileSequence: QueryResult[];
  refreshResult?: { data: { session: ReturnType<typeof createMockSession> | null }; error: unknown };
  refreshThrows?: unknown;
}) {
  let profileCallIdx = 0;

  const getSession = vi.fn().mockResolvedValue({
    data: { session: options.session },
    error: null,
  });

  const refreshSession = options.refreshThrows
    ? vi.fn().mockRejectedValue(options.refreshThrows)
    : vi.fn().mockResolvedValue(
        options.refreshResult ?? { data: { session: null }, error: null },
      );

  const signOut = vi.fn().mockResolvedValue({ error: null });

  const from = vi.fn(() => {
    const chain: Record<string, unknown> = {};
    const resolveNext = () => {
      const idx = Math.min(profileCallIdx, options.profileSequence.length - 1);
      profileCallIdx += 1;
      return Promise.resolve(options.profileSequence[idx]);
    };

    chain.select = vi.fn(() => chain);
    chain.update = vi.fn(() => chain);
    chain.upsert = vi.fn(() => chain);
    chain.eq = vi.fn(() => chain);
    chain.single = vi.fn(resolveNext);
    chain.maybeSingle = vi.fn(resolveNext);

    return chain;
  });

  const client = {
    auth: {
      getSession,
      refreshSession,
      signOut,
    },
    from,
  };

  return {
    client: client as unknown as NonNullable<typeof originalSupabase>,
    getSession,
    refreshSession,
    signOut,
    from,
  };
}

describe("getMe session recovery on auth rejection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    invalidateProfileCache();
  });

  afterEach(() => {
    invalidateProfileCache();
    setSupabaseClient(originalSupabase);
  });

  it("refreshes session and retries profile fetch on PGRST301 without signing out", async () => {
    const staleSession = createMockSession("expired-jwt");
    const freshSession = createMockSession("fresh-jwt");
    const mock = createMockSupabase({
      session: staleSession,
      profileSequence: [
        {
          data: null,
          error: { code: "PGRST301", message: "JWT expired" },
        },
        {
          data: createProfileRow(),
          error: null,
        },
      ],
      refreshResult: {
        data: { session: freshSession },
        error: null,
      },
    });

    setSupabaseClient(mock.client);

    const result = await getMe();

    expect(mock.refreshSession).toHaveBeenCalledTimes(1);
    expect(mock.signOut).not.toHaveBeenCalled();
    expect(result.user).not.toBeNull();
    expect(result.user?.id).toBe("user-123");
    expect(result.user?.onboardingCompleted).toBe(true);
  });

  it("clears local session once and returns null user when refresh permanently fails", async () => {
    const staleSession = createMockSession("expired-jwt");
    const mock = createMockSupabase({
      session: staleSession,
      profileSequence: [
        {
          data: null,
          error: { code: "PGRST301", message: "JWT expired" },
        },
      ],
      refreshResult: {
        data: { session: null },
        error: { message: "Invalid Refresh Token", status: 400 },
      },
    });

    setSupabaseClient(mock.client);

    const result = await getMe();

    expect(mock.refreshSession).toHaveBeenCalledTimes(1);
    expect(mock.signOut).toHaveBeenCalledTimes(1);
    expect(mock.signOut).toHaveBeenCalledWith({ scope: "local" });
    expect(result).toEqual({ user: null });
  });

  it("preserves session and throws 503 ApiError on transient refresh network error", async () => {
    const staleSession = createMockSession("expired-jwt");
    const mock = createMockSupabase({
      session: staleSession,
      profileSequence: [
        {
          data: null,
          error: { code: "PGRST301", message: "JWT expired" },
        },
      ],
      refreshResult: {
        data: { session: null },
        error: { name: "AuthRetryableFetchError", message: "Failed to fetch", status: 0 },
      },
    });

    setSupabaseClient(mock.client);

    let caught: unknown;
    try {
      await getMe();
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(ApiError);
    expect((caught as ApiError).status).toBe(503);
    expect(mock.refreshSession).toHaveBeenCalledTimes(1);
    expect(mock.signOut).not.toHaveBeenCalled();
  });

  it("preserves session and throws future-iat ApiError on PGRST303 without refreshing or signing out", async () => {
    const session = createMockSession("future-iat-jwt");
    const mock = createMockSupabase({
      session,
      profileSequence: [
        {
          data: null,
          error: { code: "PGRST303", message: "JWT issued at future" },
        },
      ],
    });

    setSupabaseClient(mock.client);

    let caught: unknown;
    try {
      await getMe();
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(ApiError);
    expect(isFutureIatApiError(caught)).toBe(true);
    expect(mock.refreshSession).not.toHaveBeenCalled();
    expect(mock.signOut).not.toHaveBeenCalled();
  });
});
