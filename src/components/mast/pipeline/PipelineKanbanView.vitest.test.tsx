import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { Lead } from "@/lib/api";
import { countryOf, scoreBandOf, sourceLabel, timeAgo } from "./kanbanHelpers";
import { KanbanBoard, KanbanColumn, KanbanCoachPanel } from "./PipelineKanbanView";
import {
  buildPipelineFlowModel,
  flowBriefingText,
  flowHeadlineText,
  flowTone,
  stageCountsFromStats,
  type FlowNode,
} from "./pipelineFlowModel";

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
  pageSize: 5,
  loadedTotal: 7,
  density: "comfortable" as const,
  draggingId: null,
  isOver: false,
  onShowMore: vi.fn(),
  onShowLess: vi.fn(),
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

describe("KanbanColumn show more / show less", () => {
  const twelve = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map((i) => lead(i));

  it("offers no 'Show less' while collapsed", () => {
    render(
      <KanbanColumn {...baseColumn({ leads: twelve, loadedTotal: 12, count: 12, shown: 5 })} />,
    );
    expect(screen.getByText("+ 7 more opportunities")).toBeTruthy();
    expect(screen.queryByText("Show less")).toBeNull();
  });

  it("offers 'Show less' once expanded past the page size, alongside the remainder", () => {
    const props = baseColumn({ leads: twelve, loadedTotal: 12, count: 12, shown: 10 });
    render(<KanbanColumn {...props} />);
    expect(screen.getAllByRole("article")).toHaveLength(10);
    expect(screen.getByText("+ 2 more opportunities")).toBeTruthy();
    fireEvent.click(screen.getByText("Show less"));
    expect(props.onShowLess).toHaveBeenCalledTimes(1);
  });

  it("keeps 'Show less' when everything is showing and nothing remains", () => {
    render(
      <KanbanColumn {...baseColumn({ leads: twelve, loadedTotal: 12, count: 12, shown: 12 })} />,
    );
    expect(screen.getAllByRole("article")).toHaveLength(12);
    expect(screen.queryByText(/more opportunities/)).toBeNull();
    expect(screen.getByText("Show less")).toBeTruthy();
  });

  it("labels the Closed column's percentage as a win share", () => {
    render(
      <KanbanColumn
        {...baseColumn({
          node: { ...node, stage: "won", label: "Closed", nextLabel: null, toNextPct: 9 },
        })}
      />,
    );
    expect(screen.getByText(/9%\s*won/)).toBeTruthy();
  });
});

describe("pipeline numbers", () => {
  const day = 24 * 60 * 60 * 1000;
  const now = Date.now();
  const mk = (id: number, status: string, idleDays: number): Lead =>
    lead(id, {
      status,
      updatedAt: new Date(now - idleDays * day).toISOString(),
      createdAt: new Date(now - 10 * day).toISOString(),
    });

  it("does not count dead leads (they would otherwise land in New and inflate everything)", () => {
    const c = stageCountsFromStats([
      { status: "new", count: 10 },
      { status: "dead", count: 6 },
      { status: "lost", count: 2 },
      { status: "email_sent", count: 4 },
      { status: "called", count: 1 },
      { status: "closed", count: 3 },
    ]);
    expect(c).toEqual({ new: 10, contacted: 5, replied: 0, meeting: 0, won: 3 });
  });

  it("calls the pipeline healthy / steady / under pressure from the stalled share, not a made-up score", () => {
    const build = (stalled: number, fresh: number) => {
      const leads = [
        ...Array.from({ length: stalled }, (_, i) => mk(i + 1, "email_sent", 5)),
        ...Array.from({ length: fresh }, (_, i) => mk(100 + i, "email_sent", 0)),
      ];
      return buildPipelineFlowModel(
        { new: 0, contacted: stalled + fresh, replied: 0, meeting: 0, won: 0 },
        leads,
      );
    };
    expect(flowTone(build(1, 19))).toBe("healthy"); // 5%
    expect(flowTone(build(5, 15))).toBe("steady"); // 25%
    expect(flowTone(build(12, 8))).toBe("pressure"); // 60%
    expect(flowTone(build(0, 0))).toBe("healthy"); // nothing in conversation
  });

  it("headline and body come from the same model, so they agree on the bottleneck and counts", () => {
    const leads = [
      ...Array.from({ length: 3 }, (_, i) => mk(i + 1, "email_sent", 5)),
      ...Array.from({ length: 17 }, (_, i) => mk(50 + i, "email_sent", 0)),
      mk(90, "replied", 1),
      mk(91, "meeting_booked", 1),
    ];
    const model = buildPipelineFlowModel(
      { new: 0, contacted: 20, replied: 1, meeting: 1, won: 0 },
      leads,
    );
    expect(model.bottleneckStage).toBe("contacted");
    expect(flowHeadlineText(model)).toContain("Contacted is becoming a bottleneck");
    const body = flowBriefingText(model);
    expect(body).toContain("3 opportunities have been in Contacted for 3+ days.");
    expect(body).toContain("1 high-potential opportunity is ready for a follow-up.");
    expect(body).toContain("1 meeting to prepare for.");
  });

  it("says so plainly when nothing is stalled or the pipeline is empty", () => {
    const calm = buildPipelineFlowModel({ new: 0, contacted: 1, replied: 0, meeting: 0, won: 0 }, [
      mk(1, "email_sent", 0),
    ]);
    expect(flowBriefingText(calm)).toContain("Nothing has stalled");
    const empty = buildPipelineFlowModel(
      { new: 0, contacted: 0, replied: 0, meeting: 0, won: 0 },
      [],
    );
    expect(flowHeadlineText(empty)).toContain("empty");
  });
});
