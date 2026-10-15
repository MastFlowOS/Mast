import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import React from "react";
import type { Lead } from "@/lib/api";
import { RelationshipRow } from "./dashboard.relationships";

const mockLead: Lead = {
  id: 42,
  businessName: "Acme Design Co",
  status: "new",
  priority: "normal",
  niche: "design",
  location: "San Francisco, CA",
  email: "hello@acmedesign.com",
  createdAt: "2026-10-14T10:00:00Z",
  updatedAt: "2026-10-14T10:00:00Z",
};

describe("RelationshipRow — Outside Lead 3-Dot Actions Menu", () => {
  afterEach(() => {
    cleanup();
  });
  it("renders 3-dot menu matching the workspace inside menu with real actions", () => {
    const onOpen = vi.fn();
    const onToggleSelect = vi.fn();
    const onToggleStar = vi.fn();
    const onExport = vi.fn();
    const onArchive = vi.fn();
    const onDuplicate = vi.fn();
    const onDelete = vi.fn();

    render(
      <RelationshipRow
        lead={mockLead}
        selected={false}
        starred={false}
        onOpen={onOpen}
        onToggleSelect={onToggleSelect}
        onToggleStar={onToggleStar}
        onExport={onExport}
        onArchive={onArchive}
        onDuplicate={onDuplicate}
        onDelete={onDelete}
      />,
    );

    const trigger = screen.getByRole("button", { name: `More actions for ${mockLead.businessName}` });
    fireEvent.pointerDown(trigger, { button: 0 });

    // Verify all 4 actions matching the inside workspace menu
    expect(screen.getByText("Export this lead")).toBeTruthy();
    expect(screen.getByText("Download this lead as CSV")).toBeTruthy();

    expect(screen.getByText("Close Opportunity")).toBeTruthy();
    expect(screen.getByText("Mark as no longer active")).toBeTruthy();

    expect(screen.getByText("Duplicate")).toBeTruthy();
    expect(screen.getByText("Create a copy of this opportunity")).toBeTruthy();

    expect(screen.getByText("Remove")).toBeTruthy();
    expect(screen.getByText("Permanently remove")).toBeTruthy();

    // Verify redundant items are removed
    expect(screen.queryByText("Open relationship")).toBeNull();
    expect(screen.queryByText("Star relationship")).toBeNull();
    expect(screen.queryByText("Remove from starred")).toBeNull();
  });

  it("calls onExport when 'Export this lead' is clicked", () => {
    const onExport = vi.fn();
    render(
      <RelationshipRow
        lead={mockLead}
        selected={false}
        starred={false}
        onOpen={vi.fn()}
        onToggleSelect={vi.fn()}
        onToggleStar={vi.fn()}
        onExport={onExport}
        onArchive={vi.fn()}
        onDuplicate={vi.fn()}
        onDelete={vi.fn()}
      />,
    );

    fireEvent.pointerDown(screen.getByRole("button", { name: `More actions for ${mockLead.businessName}` }), { button: 0 });
    fireEvent.click(screen.getByText("Export this lead"));

    expect(onExport).toHaveBeenCalledWith(mockLead);
  });

  it("calls onArchive when 'Close Opportunity' is clicked", () => {
    const onArchive = vi.fn();
    render(
      <RelationshipRow
        lead={mockLead}
        selected={false}
        starred={false}
        onOpen={vi.fn()}
        onToggleSelect={vi.fn()}
        onToggleStar={vi.fn()}
        onExport={vi.fn()}
        onArchive={onArchive}
        onDuplicate={vi.fn()}
        onDelete={vi.fn()}
      />,
    );

    fireEvent.pointerDown(screen.getByRole("button", { name: `More actions for ${mockLead.businessName}` }), { button: 0 });
    fireEvent.click(screen.getByText("Close Opportunity"));

    expect(onArchive).toHaveBeenCalledWith(mockLead);
  });

  it("calls onDuplicate when 'Duplicate' is clicked", () => {
    const onDuplicate = vi.fn();
    render(
      <RelationshipRow
        lead={mockLead}
        selected={false}
        starred={false}
        onOpen={vi.fn()}
        onToggleSelect={vi.fn()}
        onToggleStar={vi.fn()}
        onExport={vi.fn()}
        onArchive={vi.fn()}
        onDuplicate={onDuplicate}
        onDelete={vi.fn()}
      />,
    );

    fireEvent.pointerDown(screen.getByRole("button", { name: `More actions for ${mockLead.businessName}` }), { button: 0 });
    fireEvent.click(screen.getByText("Duplicate"));

    expect(onDuplicate).toHaveBeenCalledWith(mockLead);
  });

  it("calls onDelete when 'Remove' is clicked", () => {
    const onDelete = vi.fn();
    render(
      <RelationshipRow
        lead={mockLead}
        selected={false}
        starred={false}
        onOpen={vi.fn()}
        onToggleSelect={vi.fn()}
        onToggleStar={vi.fn()}
        onExport={vi.fn()}
        onArchive={vi.fn()}
        onDuplicate={vi.fn()}
        onDelete={onDelete}
      />,
    );

    fireEvent.pointerDown(screen.getByRole("button", { name: `More actions for ${mockLead.businessName}` }), { button: 0 });
    fireEvent.click(screen.getByText("Remove"));

    expect(onDelete).toHaveBeenCalledWith(mockLead);
  });
});
