import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import React from "react";

const h = vi.hoisted(() => ({
  removeMutateAsync: vi.fn(async () => ({ success: true })),
  teamData: {
    myRole: "owner" as const,
    isTeamMember: false,
    workspaceOwnerId: "owner-1",
    owner: {
      userId: "owner-1",
      fullName: "Agency Owner",
      email: "owner@agency.com",
      plan: "pro" as const,
    },
    members: [
      {
        id: "mem-1",
        userId: "rep-1",
        role: "member" as const,
        fullName: "Rep One",
        email: "rep1@agency.com",
        joinedAt: "2026-11-20T00:00:00Z",
      },
    ],
    pendingInvites: [
      {
        id: "inv-1",
        email: "pending@agency.com",
        role: "member" as const,
        token: "tok_abc123",
        expiresAt: "2026-11-27T00:00:00Z",
        createdAt: "2026-11-20T00:00:00Z",
      },
    ],
    incomingInvites: [],
    seatUsage: {
      plan: "pro" as const,
      seatLimit: 3,
      isUnlimitedSeats: false,
      activeSeats: 2,
      pendingInvites: 1,
      seatsReserved: 3,
      remainingSeats: 0,
      canInvite: false,
    },
  },
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

vi.mock("@/hooks/use-mast-api", () => ({
  useMe: () => ({
    data: { user: { id: "owner-1", email: "owner@agency.com" } },
  }),
  useTeamWorkspace: () => ({
    data: h.teamData,
    isLoading: false,
    isError: false,
    error: null,
    refetch: vi.fn(),
  }),
  useInviteTeamMember: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useRevokeTeamInvite: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useAcceptTeamInvite: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useUpdateTeamMemberRole: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useRemoveTeamMember: () => ({ mutateAsync: h.removeMutateAsync, isPending: false }),
}));

import { TeamSeatsCard } from "../TeamSeatsCard";

describe("TeamSeatsCard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete (window as any).__TAURI_INTERNALS__;
  });

  afterEach(() => {
    cleanup();
  });

  it("opens a confirmation dialog before removing a teammate and aborts on cancel", async () => {
    render(<TeamSeatsCard />);

    const removeBtn = screen.getByRole("button", { name: /Remove Rep One/i });
    fireEvent.click(removeBtn);

    expect(screen.getByText("Remove Rep One?")).toBeTruthy();
    expect(h.removeMutateAsync).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: /^Cancel$/i }));
    await waitFor(() => {
      expect(screen.queryByText("Remove Rep One?")).toBeNull();
    });
    expect(h.removeMutateAsync).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: /Remove Rep One/i }));
    fireEvent.click(screen.getByRole("button", { name: /^Remove teammate$/i }));
    await waitFor(() => {
      expect(h.removeMutateAsync).toHaveBeenCalledWith("rep-1");
    });
  });

  it("copies the https://mast-flow.vercel.app invite link on Desktop instead of tauri.localhost", async () => {
    (window as any).__TAURI_INTERNALS__ = { invoke: async () => null };
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });

    render(<TeamSeatsCard />);
    fireEvent.click(screen.getByRole("button", { name: /Copy Link/i }));

    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith(
        "https://mast-flow.vercel.app/invite?token=tok_abc123",
      );
    });
  });
});
