import React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase", () => ({
  supabase: { auth: { getSession: async () => ({ data: { session: { access_token: "tok" } } }) } },
}));

import { useSmtpSettings } from "@/hooks/use-mast-api";

const persisted = {
  configured: true,
  host: "smtp.gmail.com",
  port: "587",
  username: "a@example.com",
  encryption: "TLS",
  hasPassword: true,
  status: "connected",
  lastTestedAt: "2026-10-13T10:00:00.000Z",
  lastTestError: null,
  updatedAt: "2026-10-13T09:00:00.000Z",
  encryptionConfigured: true,
};

function mount() {
  // A brand-new QueryClient == a page refresh / new session: no cached state.
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return renderHook(() => useSmtpSettings(), { wrapper });
}

describe("SMTP status is loaded from the backend, not component state", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ settings: persisted }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("restores Connected and the last-tested timestamp after unmount + remount (leave and return)", async () => {
    const first = mount();
    await waitFor(() => expect(first.result.current.data?.status).toBe("connected"));
    first.unmount();

    const second = mount();
    await waitFor(() => expect(second.result.current.data?.status).toBe("connected"));
    expect(second.result.current.data?.lastTestedAt).toBe(persisted.lastTestedAt);
    expect(fetchMock).toHaveBeenCalledTimes(2); // each mount re-reads persisted state
    expect(fetchMock.mock.calls[0][0]).toBe("/api/smtp-settings");
    expect((fetchMock.mock.calls[0][1] as RequestInit).method).toBe("GET");
  });

  it("surfaces a meaningful error when loading fails, instead of reverting to 'Not tested'", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ error: "Secure SMTP storage unavailable.", code: "storage_unavailable" }),
        { status: 503 },
      ),
    );
    const view = mount();
    await waitFor(() => expect(view.result.current.isError).toBe(true));
    expect((view.result.current.error as Error).message).toContain(
      "Secure SMTP storage unavailable",
    );
    expect(view.result.current.data).toBeUndefined();
  });

  it("the response shape the UI relies on carries no password field", async () => {
    const view = mount();
    await waitFor(() => expect(view.result.current.data).toBeDefined());
    expect(
      Object.keys(view.result.current.data as object).some(
        (k) => /pass/i.test(k) && k !== "hasPassword",
      ),
    ).toBe(false);
  });
});
