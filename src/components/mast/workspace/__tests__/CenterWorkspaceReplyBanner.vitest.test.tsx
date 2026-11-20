import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import React from "react";
import type { Lead, LeadActivity } from "@/lib/api";

const h = vi.hoisted(() => ({
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
  activities: [] as LeadActivity[],
}));

vi.mock("sonner", () => ({
  toast: {
    success: h.toastSuccess,
    error: h.toastError,
    info: vi.fn(),
    warning: vi.fn(),
  },
}));

vi.mock("@/hooks/use-mast-api", () => ({
  useSendLeadEmail: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useRecordLeadActivity: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useLeadActivities: () => ({ data: h.activities, isLoading: false, isError: false }),
  useLeadSafetyCheck: () => ({ data: { blocked: false, match: null, unsubscribeToken: null }, isLoading: false }),
  useOutreachPacing: () => ({
    data: {
      email: { sentLast24h: 0, softLimit: 35, hardLimit: 50, level: "ok", message: null },
      instagram: { last1h: 0, last24h: 0, hourlyLimit: 15, dailyLimit: 40, level: "ok", message: null },
    },
    isLoading: false,
  }),
  useAddSuppression: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

import { CenterWorkspace } from "../CenterWorkspace";

const mockLead: Lead = {
  id: 42,
  businessName: "Luna Bakery",
  email: "owner@lunabakery.com",
  instagramHandle: "luna_bakery",
  status: "replied",
  createdAt: "2026-11-17T00:00:00Z",
  updatedAt: "2026-11-18T00:00:00Z",
};

describe("CenterWorkspace Client Reply Banner", () => {
  afterEach(() => {
    cleanup();
    h.activities = [];
    vi.clearAllMocks();
  });

  it("displays the client reply banner with intent badge and inserts suggested reply on click", () => {
    h.activities = [
      {
        id: "act-1",
        leadId: 42,
        type: "reply_received",
        channel: "instagram",
        timestamp: "2026-11-18T20:00:00Z",
        content: "Instagram reply from @luna_bakery: Asked for pricing",
        body: "Hey! How much do you charge for a brand refresh?",
        metadata: {
          intent: "pricing",
          suggestedReply: "Thanks for reaching out! Brand refresh packages start at $600.",
        },
      },
    ];

    const setBody = vi.fn();

    render(
      <CenterWorkspace
        lead={mockLead}
        channel="instagram"
        setChannel={vi.fn()}
        subject=""
        setSubject={vi.fn()}
        body=""
        setBody={setBody}
        template="initial"
        setTemplate={vi.fn()}
        tone="friendly"
        setTone={vi.fn()}
        onGenerate={vi.fn(async () => {})}
        isGenerating={false}
        onRewrite={vi.fn(async () => {})}
      />,
    );

    const banner = screen.getByTestId("client-reply-banner");
    expect(banner.textContent).toContain("Client replied via Instagram");
    expect(banner.textContent).toContain("pricing");
    expect(banner.textContent).toContain("How much do you charge for a brand refresh?");

    fireEvent.click(screen.getByText("Use Suggested Reply"));
    expect(setBody).toHaveBeenCalledWith(
      "Thanks for reaching out! Brand refresh packages start at $600.",
    );
  });
});
