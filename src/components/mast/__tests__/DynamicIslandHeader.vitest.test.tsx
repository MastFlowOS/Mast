import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, act } from "@testing-library/react";
import React from "react";

vi.mock("@tanstack/react-router", () => ({
  Link: ({
    to,
    children,
    ...rest
  }: {
    to: string;
    children: React.ReactNode;
    [key: string]: unknown;
  }) => (
    <a href={to} {...rest}>
      {children}
    </a>
  ),
}));

import { DynamicIslandHeader } from "@/components/mast/DynamicIslandHeader";
import {
  IDLE_DYNAMIC_ISLAND_EVENT,
  clearDynamicIslandEvents,
  createDynamicIslandEvent,
  dismissDynamicIslandEvent,
  publishDynamicIslandEvent,
  resolvePrimaryDynamicIslandEvent,
  updateDynamicIslandProgress,
  useDynamicIsland,
} from "@/lib/dynamic-island";

describe("MAST Dynamic Island Header & Priority System", () => {
  beforeEach(() => {
    clearDynamicIslandEvents();
  });

  afterEach(() => {
    cleanup();
    clearDynamicIslandEvents();
  });

  it("renders IDLE state with an empty center well, no search bar, no loading indicators, and only circular avatar on the right", () => {
    const { container } = render(
      <DynamicIslandHeader
        event={IDLE_DYNAMIC_ISLAND_EVENT}
        user={{ fullName: "Alex Rivera", email: "alex@mast.io" }}
        planName="Pro"
        unreadCount={0}
      />,
    );

    const header = screen.getByTestId("mast-dynamic-island-header");
    expect(header.getAttribute("data-island-state")).toBe("idle");

    // Center Dynamic Island area must be completely empty
    const center = screen.getByTestId("dynamic-island-center");
    expect(center.children.length).toBe(0);
    expect(center.textContent).toBe("");

    // Global search must be completely absent
    expect(screen.queryByPlaceholderText(/Search opportunities/i)).toBeNull();
    expect(container.querySelector("input")).toBeNull();

    // No progress bar or loading indicator during idle
    expect(screen.queryByRole("progressbar")).toBeNull();

    // Left: MAST logo
    expect(screen.getByAltText("MAST")).toBeTruthy();

    // Right: circular user avatar ONLY (no bell icon, no permanent "My Workspace", "Mast OS", or plan text)
    expect(screen.queryByTestId("header-notification-bell")).toBeNull();
    const avatar = screen.getByTestId("header-user-avatar");
    expect(avatar).toBeTruthy();
    expect(avatar.textContent).toBe("AR");
    expect(screen.queryByText(/Alex Rivera/i)).toBeNull();
    expect(screen.queryByText(/Pro Plan/i)).toBeNull();
    expect(screen.queryByText(/Mast OS/i)).toBeNull();
  });

  it("opens and closes centered notifications dropdown with timestamps when pressing inside the Dynamic Island", () => {
    const nowIso = new Date().toISOString();
    render(
      <DynamicIslandHeader
        event={IDLE_DYNAMIC_ISLAND_EVENT}
        unreadCount={2}
        notifications={[
          {
            id: "n1",
            icon: "CheckCircle2",
            iconColor: "text-emerald-400",
            iconBg: "bg-emerald-400/10 border-emerald-400/20",
            title: "Export complete",
            body: "10 opportunities exported as CSV.",
            createdAt: nowIso,
            time: "Just now",
            unread: true,
          },
          {
            id: "n2",
            icon: "CheckCircle2",
            iconColor: "text-emerald-400",
            iconBg: "bg-emerald-400/10 border-emerald-400/20",
            title: "Import complete",
            body: "247 contacts added to your workspace.",
            createdAt: nowIso,
            time: "Just now",
            unread: true,
          },
        ]}
      />,
    );

    const center = screen.getByTestId("dynamic-island-center");
    expect(screen.queryByTestId("dynamic-island-notifications-dropdown")).toBeNull();

    // First press inside the Dynamic Island opens the centered dropdown
    fireEvent.click(center);
    const dropdown = screen.getByTestId("dynamic-island-notifications-dropdown");
    expect(dropdown).toBeTruthy();
    expect(screen.getByText("Export complete")).toBeTruthy();
    expect(screen.getByText("10 opportunities exported as CSV.")).toBeTruthy();
    expect(screen.getByText("Import complete")).toBeTruthy();

    const timestamps = screen.getAllByTestId("notification-item-timestamp");
    expect(timestamps.length).toBe(2);
    expect(timestamps[0].textContent).toContain("Just now");

    // Second press inside the Dynamic Island closes the dropdown
    fireEvent.click(center);
    expect(screen.queryByTestId("dynamic-island-notifications-dropdown")).toBeNull();
  });

  it("renders ACTIVE DISCOVERY state with circular progress ring, title, progress bar, and percentage", () => {
    const activeEvent = createDynamicIslandEvent({
      type: "discovery_active",
      title: "Discovery in progress",
      progress: 67,
    });

    const { rerender } = render(<DynamicIslandHeader event={activeEvent} />);

    expect(
      screen.getByTestId("dynamic-island-pill-discovery_active"),
    ).toBeTruthy();
    expect(screen.getByText("Discovery in progress")).toBeTruthy();
    expect(
      screen.getByTestId("dynamic-island-progress-pct").textContent,
    ).toBe("67%");

    const progressBar = screen.getByRole("progressbar");
    expect(progressBar.getAttribute("aria-valuenow")).toBe("67");

    // Smoothly updates when progress changes
    const updatedEvent = createDynamicIslandEvent({
      type: "discovery_active",
      title: "Discovery in progress",
      progress: 89,
    });
    rerender(<DynamicIslandHeader event={updatedEvent} />);
    expect(
      screen.getByTestId("dynamic-island-progress-pct").textContent,
    ).toBe("89%");
  });

  it("renders DISCOVERY COMPLETED state and triggers View action", () => {
    const onAction = vi.fn();
    const event = createDynamicIslandEvent({
      type: "discovery_complete",
      title: "Discovery complete",
      description: "10 opportunities are ready to review.",
      actionLabel: "View →",
      onAction,
    });

    render(<DynamicIslandHeader event={event} />);

    expect(
      screen.getByTestId("dynamic-island-pill-discovery_complete"),
    ).toBeTruthy();
    expect(screen.getByText("Discovery complete")).toBeTruthy();
    expect(
      screen.getByText("10 opportunities are ready to review."),
    ).toBeTruthy();

    const btn = screen.getByTestId("dynamic-island-action-btn");
    expect(btn.textContent).toBe("View →");
    fireEvent.click(btn);
    expect(onAction).toHaveBeenCalledTimes(1);
  });

  it("renders NOTIFICATION / ACTION NEEDED state inside the center Dynamic Island", () => {
    const onAction = vi.fn();
    const event = createDynamicIslandEvent({
      type: "notification",
      title: "3 follow-ups need attention",
      description: "New reminders just now.",
      actionLabel: "Review →",
      onAction,
    });

    render(<DynamicIslandHeader event={event} unreadCount={3} />);

    expect(
      screen.getByTestId("dynamic-island-pill-notification"),
    ).toBeTruthy();
    expect(screen.getByText("3 follow-ups need attention")).toBeTruthy();
    expect(screen.getByText("New reminders just now.")).toBeTruthy();
    expect(screen.queryByTestId("header-notification-bell")).toBeNull();

    const btn = screen.getByTestId("dynamic-island-action-btn");
    expect(btn.textContent).toBe("Review →");
    fireEvent.click(btn);
    expect(onAction).toHaveBeenCalledTimes(1);
  });

  it("renders IMPORT COMPLETED state", () => {
    const onAction = vi.fn();
    const event = createDynamicIslandEvent({
      type: "import_complete",
      title: "Import complete",
      description: "247 contacts added.",
      actionLabel: "View →",
      onAction,
    });

    render(<DynamicIslandHeader event={event} />);

    expect(
      screen.getByTestId("dynamic-island-pill-import_complete"),
    ).toBeTruthy();
    expect(screen.getByText("Import complete")).toBeTruthy();
    expect(screen.getByText("247 contacts added.")).toBeTruthy();
    expect(screen.getByTestId("dynamic-island-action-btn").textContent).toBe(
      "View →",
    );
  });

  it("renders LOW CREDITS state", () => {
    const onAction = vi.fn();
    const event = createDynamicIslandEvent({
      type: "credits_low",
      title: "Credits running low",
      description: "18 credits remaining.",
      actionLabel: "Upgrade →",
      onAction,
    });

    render(<DynamicIslandHeader event={event} />);

    expect(
      screen.getByTestId("dynamic-island-pill-credits_low"),
    ).toBeTruthy();
    expect(screen.getByText("Credits running low")).toBeTruthy();
    expect(screen.getByText("18 credits remaining.")).toBeTruthy();
    expect(screen.getByTestId("dynamic-island-action-btn").textContent).toBe(
      "Upgrade →",
    );
  });

  it("renders DISCOVERY FAILED state with restrained red styling and Retry action", () => {
    const onAction = vi.fn();
    const event = createDynamicIslandEvent({
      type: "discovery_error",
      title: "Discovery failed",
      description: "Couldn't fetch results. Try again.",
      actionLabel: "Retry →",
      onAction,
    });

    render(<DynamicIslandHeader event={event} />);

    const pill = screen.getByTestId("dynamic-island-pill-discovery_error");
    expect(pill).toBeTruthy();
    expect(pill.className).toContain("border-rose-500/25");
    expect(screen.getByText("Discovery failed")).toBeTruthy();
    expect(
      screen.getByText("Couldn't fetch results. Try again."),
    ).toBeTruthy();

    const btn = screen.getByTestId("dynamic-island-action-btn");
    expect(btn.textContent).toBe("Retry →");
    fireEvent.click(btn);
    expect(onAction).toHaveBeenCalledTimes(1);
  });

  it("enforces strict single-event priority hierarchy across simultaneous events", () => {
    const lowCredits = createDynamicIslandEvent({
      type: "credits_low",
      title: "Credits running low",
      timestamp: 100,
    });
    const importDone = createDynamicIslandEvent({
      type: "import_complete",
      title: "Import complete",
      timestamp: 200,
    });
    const discoveryDone = createDynamicIslandEvent({
      type: "discovery_complete",
      title: "Discovery complete",
      timestamp: 300,
    });
    const actionNotif = createDynamicIslandEvent({
      type: "notification",
      title: "3 follow-ups need attention",
      timestamp: 400,
    });
    const activeDiscovery = createDynamicIslandEvent({
      type: "discovery_active",
      title: "Discovery in progress",
      progress: 45,
      timestamp: 500,
    });
    const criticalError = createDynamicIslandEvent({
      type: "discovery_error",
      title: "Discovery failed",
      timestamp: 600,
    });

    // 1. Critical error beats everything
    expect(
      resolvePrimaryDynamicIslandEvent([
        lowCredits,
        importDone,
        discoveryDone,
        actionNotif,
        activeDiscovery,
        criticalError,
      ]).type,
    ).toBe("discovery_error");

    // 2. Active discovery beats notification, completed, and low credits
    expect(
      resolvePrimaryDynamicIslandEvent([
        lowCredits,
        importDone,
        discoveryDone,
        actionNotif,
        activeDiscovery,
      ]).type,
    ).toBe("discovery_active");

    // 3. Action-required notification beats completed operations and low credits
    expect(
      resolvePrimaryDynamicIslandEvent([
        lowCredits,
        importDone,
        discoveryDone,
        actionNotif,
      ]).type,
    ).toBe("notification");

    // 4. Completed operations beat low credits (and latest timestamp wins within same priority tier)
    expect(
      resolvePrimaryDynamicIslandEvent([lowCredits, importDone, discoveryDone])
        .type,
    ).toBe("discovery_complete");

    // 5. Low credits beats idle
    expect(resolvePrimaryDynamicIslandEvent([lowCredits]).type).toBe(
      "credits_low",
    );

    // 6. Empty or all-dismissed returns idle
    expect(
      resolvePrimaryDynamicIslandEvent([
        { ...lowCredits, status: "dismissed" },
      ]).type,
    ).toBe("idle");
  });

  it("updates reactive store through active -> progress -> complete -> idle lifecycle", () => {
    function Harness() {
      const { activeEvent } = useDynamicIsland();
      return <DynamicIslandHeader event={activeEvent} />;
    }

    render(<Harness />);
    expect(
      screen
        .getByTestId("mast-dynamic-island-header")
        .getAttribute("data-island-state"),
    ).toBe("idle");

    act(() => {
      publishDynamicIslandEvent({
        type: "discovery_active",
        title: "Discovery in progress",
        progress: 25,
      });
    });
    expect(
      screen.getByTestId("dynamic-island-progress-pct").textContent,
    ).toBe("25%");

    act(() => {
      updateDynamicIslandProgress(67);
    });
    expect(
      screen.getByTestId("dynamic-island-progress-pct").textContent,
    ).toBe("67%");

    act(() => {
      publishDynamicIslandEvent({
        type: "discovery_complete",
        title: "Discovery complete",
        description: "10 opportunities are ready to review.",
        actionLabel: "View →",
      });
    });
    expect(screen.getByText("Discovery complete")).toBeTruthy();

    act(() => {
      dismissDynamicIslandEvent("discovery_complete");
    });
    expect(
      screen
        .getByTestId("mast-dynamic-island-header")
        .getAttribute("data-island-state"),
    ).toBe("idle");
  });
});
