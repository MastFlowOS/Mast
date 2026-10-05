import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { Lead } from "@/lib/api";
import { countryOf, scoreBandOf, sourceLabel, timeAgo } from "./kanbanHelpers";
import { KanbanBoard, KanbanColumn, KanbanCoachPanel } from "./PipelineKanbanView";
import type { FlowNode } from "./pipelineFlowModel";

afterEach(cleanup);

const lead = (id: number, over: Partial<Lead> = {}): Lead => ({
  id,
  businessName: `Biz ${id}`,
  status: "new",
  createdAt: "2026-09-01T00:00:00Z",
  updatedAt: "2026-10-04T00:00:00Z",
  niche: "coffee_shop",
  source: "google_maps",
  location: "Austin, TX, United States",
  opportunityScore: 90 - id,
  ...over,
});

const node: FlowNode = {
  stage: "contacted",
  label: "Contacted",
  color: "#4f6bff",
  count: 36,
  toNextPct: 41,
  nextLabel: "Replied",
  alert: null,
};

const baseColumn = (over: Partial<React.ComponentProps<typeof KanbanColumn>> = {}) => ({
  node,
  count: 36,
  leads: [1, 2, 3, 4, 5, 6, 7].map((i) => lead(i)),
  loading: false,
  shown: 5,
  loadedTotal: 7,
  density: "comfortable" as const,
  draggingId: null,
  isOver: false,
  onShowMore: vi.fn(),
  onViewAll: vi.fn(),
  onOpenLead: vi.fn(),
  onMoveLead: vi.fn(),
  onDragStartLead: vi.fn(),
  onDragEnd: vi.fn(),
  onDragOver: vi.fn(),
  onDragLeave: vi.fn(),
  onDrop: vi.fn(),
  ...over,
});

describe("kanban helpers", () => {
  it("buckets scores, treating a missing score as unscored (never 0)", () => {
    expect(scoreBandOf(92)).toBe("hot");
    expect(scoreBandOf(80)).toBe("hot");
    expect(scoreBandOf(79)).toBe("good");
    expect(scoreBandOf(59)).toBe("low");
    expect(scoreBandOf(null)).toBe("unscored");
    expect(scoreBandOf(undefined)).toBe("unscored");
  });

  it("formats relative time like the reference (2h ago, 1d ago, 1w ago)", () => {
    const now = new Date("2026-10-05T12:00:00Z").getTime();
    expect(timeAgo("2026-10-05T10:00:00Z", now)).toBe("2h ago");
    expect(timeAgo("2026-10-04T12:00:00Z", now)).toBe("1d ago");
    expect(timeAgo("2026-09-28T12:00:00Z", now)).toBe("1w ago");
    expect(timeAgo("not a date", now)).toBe("");
  });

  it("only reports a country when it is sure, so a US state is never shown as one", () => {
    expect(countryOf("Austin, TX, United States")).toBe("USA");
    expect(countryOf("London, England, UK")).toBe("UK");
    expect(countryOf("Toronto, Canada")).toBe("Canada");
    expect(countryOf("Austin, Texas")).toBeNull();
    expect(countryOf("Cairo")).toBeNull();
    expect(countryOf(null)).toBeNull();
  });

  it("prettifies lead sources", () => {
    expect(sourceLabel("google_maps")).toBe("Google Maps");
    expect(sourceLabel("live_scrape")).toBe("Live Scrape");
    expect(sourceLabel("")).toBeNull();
    expect(sourceLabel(null)).toBeNull();
  });
});

describe("KanbanColumn", () => {
  it("shows header count, hand-off %, only `shown` cards, and an expandable remainder", () => {
    const props = baseColumn();
    render(
      <KanbanBoard>
        <KanbanColumn {...props} />
      </KanbanBoard>,
    );
    expect(screen.getByText("36")).toBeTruthy();
    expect(screen.getByText("41%")).toBeTruthy();
    expect(screen.getAllByRole("article")).toHaveLength(5);

    fireEvent.click(screen.getByText("+ 2 more opportunities"));
    expect(props.onShowMore).toHaveBeenCalledTimes(1);
  });

  it("falls back to 'View all' when more exist on the server than are loaded", () => {
    const props = baseColumn({ leads: [lead(1)], shown: 5, loadedTotal: 1, count: 1200 });
    render(<KanbanColumn {...props} />);
    fireEvent.click(screen.getByText("View all 1,200 →"));
    expect(props.onViewAll).toHaveBeenCalledTimes(1);
  });

  it("opens a lead on click and drags with the lead id", () => {
    const props = baseColumn();
    render(<KanbanColumn {...props} />);
    const card = screen.getAllByRole("article")[0];
    fireEvent.dragStart(card);
    expect(props.onDragStartLead).toHaveBeenCalledWith(1);
    fireEvent.click(card);
    expect(props.onOpenLead).toHaveBeenCalledWith(1);
  });

  it("is a drop target: reports dragover and drop on the column", () => {
    const props = baseColumn();
    render(<KanbanColumn {...props} />);
    const col = screen.getByLabelText("Contacted stage");
    fireEvent.dragOver(col);
    fireEvent.drop(col);
    expect(props.onDragOver).toHaveBeenCalled();
    expect(props.onDrop).toHaveBeenCalledTimes(1);
  });

  it("renders an empty state and skeletons while loading", () => {
    const { rerender } = render(<KanbanColumn {...baseColumn({ leads: [], count: 0 })} />);
    expect(screen.getByText("No opportunities in this stage.")).toBeTruthy();
    rerender(<KanbanColumn {...baseColumn({ loading: true })} />);
    expect(screen.queryAllByRole("article")).toHaveLength(0);
  });

  it("shows an unscored lead as an en dash, not a fake number", () => {
    render(<KanbanColumn {...baseColumn({ leads: [lead(1, { opportunityScore: null })] })} />);
    expect(screen.getByLabelText("Not scored yet")).toBeTruthy();
  });
});

describe("KanbanCoachPanel", () => {
  const panel = (over: Partial<React.ComponentProps<typeof KanbanCoachPanel>> = {}) => (
    <KanbanCoachPanel
      insights={[
        {
          id: "a",
          tone: "priority",
          title: "Contacted is your main bottleneck",
          body: "12 stalled",
          action: "Review 12 opportunities",
          onAction: vi.fn(),
        },
      ]}
      actions={[
        { id: 1, name: "Café Stella", reason: "Replied · last update 5d ago", onOpen: vi.fn() },
      ]}
      actionsTotal={7}
      strategy={[{ id: "s", title: "Follow up within two days", body: "Replies arrive early." }]}
      suggestions={[
        {
          id: "q",
          icon: "send",
          title: "Send follow-up messages",
          sub: "7 opportunities",
          onClick: vi.fn(),
        },
      ]}
      loading={false}
      onClose={vi.fn()}
      {...over}
    />
  );

  it("switches between Insights, Actions (n) and Strategy, and closes", () => {
    const onClose = vi.fn();
    render(panel({ onClose }));
    expect(screen.getByText("Contacted is your main bottleneck")).toBeTruthy();

    fireEvent.click(screen.getByRole("tab", { name: "Actions (7)" }));
    expect(screen.getByText("Café Stella")).toBeTruthy();
    expect(screen.getByText("+ 6 more need a follow-up")).toBeTruthy();

    fireEvent.click(screen.getByRole("tab", { name: "Strategy" }));
    expect(screen.getByText("Follow up within two days")).toBeTruthy();

    fireEvent.click(screen.getByLabelText("Close AI Sales Coach"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
