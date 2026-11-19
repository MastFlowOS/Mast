import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import React from "react";

const h = vi.hoisted(() => ({
  desktop: false,
  status: null as any,
  connect: vi.fn(),
  checkNow: vi.fn(),
  disconnect: vi.fn(),
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

vi.mock("@/hooks/use-mast-api", () => ({
  useInboxSettings: () => ({
    data: {
      configured: true,
      provider: "imap",
      imapHost: "imap.gmail.com",
      imapPort: "993",
      imapUsername: "user@gmail.com",
      imapTls: true,
      hasPassword: true,
      inboundToken: "tok",
      inboundWebhookPath: "/v1/inbox/inbound/tok",
      igEmailAlertsEnabled: false,
      enabled: true,
      lastSyncedAt: null,
      lastSyncStatus: "success",
      lastSyncError: null,
      encryptionConfigured: true,
    },
    isLoading: false,
  }),
  useSaveInboxSettings: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useTestInboxConnection: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useSyncInboxNow: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useDeleteInboxSettings: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

vi.mock("@/lib/desktop/useDesktopIgWatcher", () => ({
  useDesktopIgWatcherControl: () => ({
    desktop: h.desktop,
    status: h.status,
    busy: false,
    connect: h.connect,
    checkNow: h.checkNow,
    disconnect: h.disconnect,
  }),
}));

import { ReplyObservationCard } from "../ReplyObservationCard";

describe("ReplyObservationCard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.desktop = false;
    h.status = null;
  });

  afterEach(() => {
    cleanup();
  });

  it("removes old Chrome extension and email-alert toggles and explains Desktop watcher on web", () => {
    render(
      <ReplyObservationCard
        smtpHost="smtp.gmail.com"
        smtpUser="user@gmail.com"
        smtpHasSavedPassword={true}
      />,
    );

    expect(screen.queryByText(/Copy Extension Config/i)).toBeNull();
    expect(screen.queryByText(/Detect Instagram DM email alerts/i)).toBeNull();
    expect(screen.getByText(/Connect once inside the MAST Desktop app/i)).toBeTruthy();
  });

  it("renders built-in Connect Instagram controls on Desktop and triggers connect", () => {
    h.desktop = true;
    h.status = {
      enabled: false,
      connected: false,
      windowOpen: false,
      windowVisible: false,
      state: "disabled",
      lastCheckedMs: null,
      lastError: null,
    };

    const { rerender } = render(
      <ReplyObservationCard smtpHost="smtp.gmail.com" smtpUser="user@gmail.com" />,
    );

    expect(screen.getByText("Not Connected")).toBeTruthy();
    const connectBtn = screen.getByRole("button", { name: /Connect Instagram/i });
    fireEvent.click(connectBtn);
    expect(h.connect).toHaveBeenCalledTimes(1);

    h.status = {
      enabled: true,
      connected: true,
      windowOpen: true,
      windowVisible: false,
      state: "watching",
      lastCheckedMs: Date.now(),
      lastError: null,
    };

    rerender(<ReplyObservationCard smtpHost="smtp.gmail.com" smtpUser="user@gmail.com" />);
    expect(screen.getByText("Connected & Watching")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Check Now/i }));
    expect(h.checkNow).toHaveBeenCalledTimes(1);
    const disconnectButtons = screen.getAllByRole("button", { name: /^Disconnect$/i });
    fireEvent.click(disconnectButtons[disconnectButtons.length - 1]);
    expect(h.disconnect).toHaveBeenCalledTimes(1);
  });
});
