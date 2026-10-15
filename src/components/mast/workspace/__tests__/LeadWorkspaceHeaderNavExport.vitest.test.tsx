import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import React from "react";
import type { Lead } from "@/lib/api";
import {
  setLeadNavigationContext,
  clearLeadNavigationContext,
  type LeadNavigationContext,
} from "@/lib/leadNavigation";

const h = vi.hoisted(() => ({
  navigate: vi.fn(),
  updateLeadMutate: vi.fn(),
  recordActivityMutate: vi.fn(),
  createLeadMutate: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
  createdBlobs: [] as Array<{ content: string; filename: string }>,
}));

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => h.navigate,
}));

vi.mock("sonner", () => ({
  toast: {
    success: h.toastSuccess,
    error: h.toastError,
  },
}));

const now = new Date().toISOString();

const mockLead1: Lead = {
  id: 101,
  businessName: "Alpha Cafe",
  status: "new",
  priority: "normal",
  niche: "cafe",
  location: "New York, NY",
  email: "alpha@cafe.com",
  createdAt: now,
  updatedAt: now,
};

const mockLead2: Lead = {
  id: 102,
  businessName: "Beta Bakery",
  status: "email_sent",
  priority: "high",
  niche: "bakery",
  location: "Brooklyn, NY",
  email: "beta@bakery.com",
  lastContactedAt: "2026-10-14T10:00:00Z",
  createdAt: now,
  updatedAt: now,
};

const mockLead3: Lead = {
  id: 103,
  businessName: "Gamma Grill",
  status: "replied",
  priority: "normal",
  niche: "restaurant",
  location: "Queens, NY",
  email: "gamma@grill.com",
  createdAt: now,
  updatedAt: now,
};

const mockLeadsList: Lead[] = [mockLead1, mockLead2, mockLead3];

vi.mock("@/hooks/use-mast-api", () => ({
  useUpdateLead: () => ({ mutateAsync: h.updateLeadMutate, isPending: false }),
  useRecordLeadActivity: () => ({ mutateAsync: h.recordActivityMutate, isPending: false }),
  useCreateLead: () => ({ mutateAsync: h.createLeadMutate, isPending: false }),
  useLeads: () => ({ data: { leads: mockLeadsList }, isLoading: false }),
}));

import { LeadWorkspaceHeader } from "../LeadWorkspaceHeader";

describe("LeadWorkspaceHeader — Navigation & In-Place Lead Export", () => {
  let originalCreateObjectURL: typeof URL.createObjectURL;
  let originalRevokeObjectURL: typeof URL.revokeObjectURL;

  beforeEach(() => {
    vi.clearAllMocks();
    clearLeadNavigationContext();
    h.createdBlobs = [];

    originalCreateObjectURL = global.URL.createObjectURL;
    originalRevokeObjectURL = global.URL.revokeObjectURL;

    global.URL.createObjectURL = vi.fn((blob: Blob) => {
      return "blob:mock-url";
    });
    global.URL.revokeObjectURL = vi.fn();

    // Mock HTMLAnchorElement click
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      h.createdBlobs.push({
        content: this.href,
        filename: this.download,
      });
    });
  });

  afterEach(() => {
    cleanup();
    global.URL.createObjectURL = originalCreateObjectURL;
    global.URL.revokeObjectURL = originalRevokeObjectURL;
    vi.restoreAllMocks();
  });

  describe("1. Lead Navigation Context & Boundaries", () => {
    it("renders dynamic counter (e.g. 2 / 3) and enables both prev and next when in the middle of a collection", () => {
      setLeadNavigationContext({
        leadIds: [101, 102, 103],
        total: 3,
        source: "relationships",
        returnTo: "/dashboard/relationships",
      });

      render(<LeadWorkspaceHeader lead={mockLead2} />);

      expect(screen.getByText("2 / 3")).toBeTruthy();

      const prevBtn = screen.getByRole("button", { name: "Previous lead" }) as HTMLButtonElement;
      const nextBtn = screen.getByRole("button", { name: "Next lead" }) as HTMLButtonElement;

      expect(prevBtn.disabled).toBe(false);
      expect(nextBtn.disabled).toBe(false);

      // Click previous lead
      fireEvent.click(prevBtn);
      expect(h.navigate).toHaveBeenCalledWith({
        to: "/dashboard/leads/$leadId",
        params: { leadId: "101" },
      });

      // Click next lead
      fireEvent.click(nextBtn);
      expect(h.navigate).toHaveBeenCalledWith({
        to: "/dashboard/leads/$leadId",
        params: { leadId: "103" },
      });
    });

    it("disables previous button at first lead (boundary index 0) and never wraps", () => {
      setLeadNavigationContext({
        leadIds: [101, 102, 103],
        total: 3,
      });

      render(<LeadWorkspaceHeader lead={mockLead1} />);

      expect(screen.getByText("1 / 3")).toBeTruthy();

      const prevBtn = screen.getByRole("button", { name: "Previous lead" }) as HTMLButtonElement;
      const nextBtn = screen.getByRole("button", { name: "Next lead" }) as HTMLButtonElement;

      expect(prevBtn.disabled).toBe(true);
      expect(nextBtn.disabled).toBe(false);

      // Clicking disabled prev button does nothing
      fireEvent.click(prevBtn);
      expect(h.navigate).not.toHaveBeenCalled();
    });

    it("disables next button at last lead (boundary index 2) and never wraps", () => {
      setLeadNavigationContext({
        leadIds: [101, 102, 103],
        total: 3,
      });

      render(<LeadWorkspaceHeader lead={mockLead3} />);

      expect(screen.getByText("3 / 3")).toBeTruthy();

      const prevBtn = screen.getByRole("button", { name: "Previous lead" }) as HTMLButtonElement;
      const nextBtn = screen.getByRole("button", { name: "Next lead" }) as HTMLButtonElement;

      expect(prevBtn.disabled).toBe(false);
      expect(nextBtn.disabled).toBe(true);

      // Clicking disabled next button does nothing
      fireEvent.click(nextBtn);
      expect(h.navigate).not.toHaveBeenCalled();
    });

    it("handles direct open without navigation context gracefully (1 / 1 and both controls disabled)", () => {
      // No context in sessionStorage
      render(<LeadWorkspaceHeader lead={mockLead1} />);

      expect(screen.getByText("1 / 1")).toBeTruthy();

      const prevBtn = screen.getByRole("button", { name: "Previous lead" }) as HTMLButtonElement;
      const nextBtn = screen.getByRole("button", { name: "Next lead" }) as HTMLButtonElement;

      expect(prevBtn.disabled).toBe(true);
      expect(nextBtn.disabled).toBe(true);
    });

    it("navigates with keyboard left and right arrows when not focused in input fields", () => {
      setLeadNavigationContext({
        leadIds: [101, 102, 103],
        total: 3,
      });

      render(<LeadWorkspaceHeader lead={mockLead2} />);

      // Right arrow -> navigate to 103
      fireEvent.keyDown(window, { key: "ArrowRight" });
      expect(h.navigate).toHaveBeenCalledWith({
        to: "/dashboard/leads/$leadId",
        params: { leadId: "103" },
      });

      // Left arrow -> navigate to 101
      fireEvent.keyDown(window, { key: "ArrowLeft" });
      expect(h.navigate).toHaveBeenCalledWith({
        to: "/dashboard/leads/$leadId",
        params: { leadId: "101" },
      });
    });

    it("does not navigate with arrow keys when focus is inside an input field", () => {
      setLeadNavigationContext({
        leadIds: [101, 102, 103],
        total: 3,
      });

      render(
        <div>
          <input data-testid="test-input" />
          <LeadWorkspaceHeader lead={mockLead2} />
        </div>,
      );

      const input = screen.getByTestId("test-input");
      input.focus();

      fireEvent.keyDown(input, { key: "ArrowRight" });
      expect(h.navigate).not.toHaveBeenCalled();
    });

    it("back to leads button navigates to returnTo URL from navigation context", () => {
      setLeadNavigationContext({
        leadIds: [101, 102],
        total: 2,
        returnTo: "/dashboard/pipeline",
      });

      render(<LeadWorkspaceHeader lead={mockLead1} />);

      const backBtn = screen.getByRole("button", { name: /Back to leads/i });
      fireEvent.click(backBtn);

      expect(h.navigate).toHaveBeenCalledWith({ to: "/dashboard/pipeline" });
    });

    it("updates Saved and Sent indicators when moving to a different lead", () => {
      const { rerender } = render(<LeadWorkspaceHeader lead={mockLead1} channel="email" />);
      // mockLead1 has status "new", so Sent button should say "Mark as sent"
      expect(screen.getByText("Mark as sent")).toBeTruthy();

      // Rerender with mockLead2 (status "email_sent")
      rerender(<LeadWorkspaceHeader lead={mockLead2} channel="email" />);
      expect(screen.getByText("Sent")).toBeTruthy();
    });
  });

  describe("2. Direct Lead Export via Three-Dot Menu", () => {
    it("renders 'Export this lead' in the dropdown and triggers immediate CSV export", () => {
      render(<LeadWorkspaceHeader lead={mockLead1} />);

      const moreBtn = screen.getByTitle("More actions");
      fireEvent.click(moreBtn);

      const exportLeadBtn = screen.getByText("Export this lead");
      expect(exportLeadBtn).toBeTruthy();

      fireEvent.click(exportLeadBtn);

      expect(h.toastSuccess).toHaveBeenCalledWith(
        expect.stringContaining("Exported Alpha Cafe to CSV"),
      );
      expect(h.createdBlobs.length).toBe(1);
      expect(h.createdBlobs[0].filename).toMatch(/^mast-lead-alpha-cafe-\d{4}-\d{2}-\d{2}\.csv$/);
    });

    it("does not render 'Export selected leads…' option in the dropdown menu", () => {
      render(<LeadWorkspaceHeader lead={mockLead1} />);

      const moreBtn = screen.getByTitle("More actions");
      fireEvent.click(moreBtn);

      expect(screen.getByText("Export this lead")).toBeTruthy();
      expect(screen.queryByText("Export selected leads…")).toBeNull();
    });
  });
});
