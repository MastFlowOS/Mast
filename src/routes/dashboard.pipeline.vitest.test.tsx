import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, within } from "@testing-library/react";

/**
 * Stage drawer data/logic contract. The api layer is mocked at the hook boundary with a
 * small hand-computed dataset; expectations are written out by hand (not derived from the
 * code under test). The activity mock behaves like the DB: it returns rows only for the
 * lead ids the route asks for (lead_activities.lead_id IN ...), so any name matching or
 * wrong-stage id set would show up as wrong rows.
 */

const DAY = 86_400_000;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

type L = {
  id: number;
  businessName: string;
  status: string;
  niche?: string | null;
  estimatedValue?: number | null;
  createdAt: string;
  updatedAt: string;
};
const lead = (id: number, businessName: string, status: string, updatedMsAgo = DAY, extra: Partial<L> = {}): L => ({
  id,
  businessName,
  status,
  niche: null,
  createdAt: ago(5 * DAY),
  updatedAt: ago(updatedMsAgo),
  ...extra,
});

const LEADS: L[] = [
  // New (7)
  lead(1, "Alpha One", "new", 3 * DAY),
  lead(2, "Alpha Two", "new", 2 * DAY),
  lead(3, "Beta One", "new", DAY, { estimatedValue: 1000 }),
  lead(4, "Beta Two", "new", DAY, { estimatedValue: 3000 }),
  lead(5, "Beta Three", "new", 4 * DAY),
  lead(6, "Beta Four", "new", 60 * 60 * 1000), // most recently updated
  lead(20, "Twin", "new"),
  // Contacted (3)
  lead(7, "Alpha Three", "email_sent", 10 * DAY), // overdue
  lead(8, "Beta Five", "email_sent", 4 * DAY), // stalled
  lead(9, "Alpha Four", "called", DAY),
  // Replied (3)
  lead(10, "Alpha Five", "replied"),
  lead(11, "Beta Six", "replied"),
  lead(21, "Twin", "replied"),
  // Meeting (1) / Closed (1)
  lead(12, "Alpha Six", "meeting_booked"),
  lead(13, "Beta Seven", "closed"),
  // Dead: never part of the pipeline
  lead(14, "Beta Eight", "dead"),
];

const STATS = [
  { status: "new", count: 7 },
  { status: "email_sent", count: 2 },
  { status: "called", count: 1 },
  { status: "replied", count: 3 },
  { status: "meeting_booked", count: 1 },
  { status: "closed", count: 1 },
  { status: "dead", count: 1 },
];

const ACTIVITIES = [
  { id: "a1", leadId: 21, type: "reply_received", description: "Replied: TWIN-IN-REPLIED", createdAt: ago(1 * DAY) },
  { id: "a2", leadId: 20, type: "email_sent", description: "TWIN-IN-NEW", createdAt: ago(2 * DAY) },
  { id: "a3", leadId: 10, type: "reply_received", description: "ALPHA-FIVE-REPLY", createdAt: ago(40 * DAY) }, // old, quiet stage
  { id: "a4", leadId: 6, type: "workspace_opened", description: "BETA-FOUR-OPENED", createdAt: ago(3 * DAY) },
];

const h = vi.hoisted(() => ({
  can: true,
  navigate: vi.fn(),
  recordMutate: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
  toastInfo: vi.fn(),
  stageActivityCalls: [] as { stage: string | null; ids: number[] }[],
}));

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (opts: unknown) => ({ options: opts }),
  Link: ({ children, to, ...rest }: { children: React.ReactNode; to: string }) => (
    <a href={to} {...rest}>
      {children}
    </a>
  ),
  useNavigate: () => h.navigate,
}));
vi.mock("sonner", () => ({ toast: { error: h.toastError, success: h.toastSuccess, info: h.toastInfo } }));
vi.mock("@/components/mast/FeatureGate", () => ({ FeatureGate: ({ children }: { children: React.ReactNode }) => <>{children}</> }));
vi.mock("@/hooks/use-permissions", () => ({
  usePermissions: () => ({ permissions: { can: () => h.can }, isLoading: false }),
}));
vi.mock("@/hooks/use-mast-api", () => ({
  useLeads: () => ({ data: { leads: LEADS }, isLoading: false }),
  usePipelineStats: () => ({ data: STATS, isLoading: false }),
  useRecentActivity: () => ({ data: [], isLoading: false }),
  useExecutiveBriefing: () => ({ data: undefined, isLoading: false }),
  usePipelineCoaching: () => ({ data: undefined, isLoading: false }),
  useRecordLeadActivity: () => ({ mutateAsync: h.recordMutate, isPending: false }),
  useStageActivity: (stage: string | null, ids: number[]) => {
    h.stageActivityCalls.push({ stage, ids });
    const set = new Set(ids);
    const rows = ACTIVITIES.filter((a) => set.has(a.leadId))
      .sort((a, b) => +new Date(b.createdAt) - +new Date(a.createdAt))
      .slice(0, 5);
    return { data: rows, isLoading: false };
  },
}));

import { Route } from "./dashboard.pipeline";

function Page() {
  const C = (Route as unknown as { options: { component: () => React.ReactElement } }).options.component;
  return <C />;
}

const NAMES = ["New", "Contacted", "Replied", "Meeting", "Closed"] as const;
const NEXT = ["Contacted", "Replied", "Meeting", "Closed", null] as const;

function flowButton(container: HTMLElement, label: string) {
  const b = container.querySelector(`button[aria-label^="${label}:"]`);
  if (!b) throw new Error(`no flow button for ${label}`);
  return b as HTMLButtonElement;
}
/** Count shown on the Flow pedestal (read from its accessible name, not the animated number). */
function flowCount(container: HTMLElement, label: string) {
  const m = /: (\d+) opportunities/.exec(flowButton(container, label).getAttribute("aria-label") ?? "");
  return Number(m?.[1]);
}
/** The Flow's own stage-to-next callout, e.g. "New to Contacted: 53%". */
function flowConversion(container: HTMLElement, label: string) {
  const el = container.querySelector(`[aria-label^="${label} to "]`);
  const m = /: (\d+)%/.exec(el?.getAttribute("aria-label") ?? "");
  return m ? Number(m[1]) : null;
}
function dialog() {
  return screen.getByRole("dialog");
}
function tile(label: RegExp | string) {
  const el = within(dialog()).getByText(label);
  return el.parentElement!.querySelector("h4")!.textContent!.trim();
}
function listedNames() {
  return Array.from(dialog().querySelectorAll("p.truncate.font-bold")).map((p) => p.textContent);
}

describe("Pipeline stage drawer (data + logic)", () => {
  beforeEach(() => {
    h.can = true;
    h.navigate.mockReset();
    h.recordMutate.mockReset().mockResolvedValue({});
    h.toastError.mockReset();
    h.toastSuccess.mockReset();
    h.toastInfo.mockReset();
    h.stageActivityCalls.length = 0;
    localStorage.setItem("mast-pipeline-view-mode", "flow");
  });
  afterEach(cleanup);

  it("A/B: for all five stages (unfiltered) the drawer count and conversion equal the Flow's", () => {
    const { container } = render(<Page />);
    const expectedCounts = [7, 3, 3, 1, 1];
    // hand-computed: reached = [15, 8, 5, 2, 1] -> 8/15, 5/8, 2/5, 1/2 ; closed 1/15
    const expectedPct = [53, 63, 40, 50, 7];
    NAMES.forEach((name, i) => {
      expect(flowCount(container, name)).toBe(expectedCounts[i]);
      fireEvent.click(flowButton(container, name));
      expect(tile("Leads")).toBe(String(expectedCounts[i]));
      const convLabel = NEXT[i] ? `To ${NEXT[i]}` : "Win rate";
      expect(tile(convLabel)).toBe(`${expectedPct[i]}%`);
      const flowPct = flowConversion(container, name);
      if (NEXT[i]) expect(flowPct).toBe(expectedPct[i]); // Flow callout == drawer
    });
  });

  it("New never shows a 100% conversion any more", () => {
    const { container } = render(<Page />);
    fireEvent.click(flowButton(container, "New"));
    expect(tile("To Contacted")).not.toBe("100%");
    expect(tile("To Contacted")).toBe("53%");
  });

  it("I: with a search filter active the drawer reflects the SAME filtered dataset as the Flow", () => {
    const { container } = render(<Page />);
    fireEvent.change(screen.getByLabelText("Search opportunities"), { target: { value: "alpha" } });
    const expectedCounts = [2, 2, 1, 1, 0];
    // hand-computed: reached = [6, 4, 2, 1, 0] -> 4/6, 2/4, 1/2, 0/1 ; closed 0/6
    const expectedPct = [67, 50, 50, 0, 0];
    NAMES.forEach((name, i) => {
      expect(flowCount(container, name)).toBe(expectedCounts[i]);
      fireEvent.click(flowButton(container, name));
      expect(tile("Leads")).toBe(String(expectedCounts[i]));
      expect(tile(NEXT[i] ? `To ${NEXT[i]}` : "Win rate")).toBe(`${expectedPct[i]}%`);
      if (NEXT[i]) expect(flowConversion(container, name)).toBe(expectedPct[i]);
    });
    // global New is 7; under the filter it must read 2
    fireEvent.click(flowButton(container, "New"));
    expect(tile("Leads")).toBe("2");
    expect(listedNames().sort()).toEqual(["Alpha One", "Alpha Two"]);
  });

  it("C/D: no multiplier value; shows Unavailable when no real value exists, real total/average when it does", () => {
    const { container } = render(<Page />);
    // New has two real values: 1000 + 3000 (of 7 opportunities)
    fireEvent.click(flowButton(container, "New"));
    expect(tile("Opportunity")).toBe("$4.0k");
    expect(within(dialog()).getByText(/avg \$2\.0k · 2 of 7 valued/)).toBeTruthy();
    // old fake figures would have been 7*50=$350, 3*150=$450, 3*500=$1.5k, 1*1200=$1.2k, 1*8000=$8.0k
    for (const name of ["Contacted", "Replied", "Meeting", "Closed"]) {
      fireEvent.click(flowButton(container, name));
      expect(tile("Opportunity")).toBe("Unavailable");
      expect(within(dialog()).queryByText(/valued/)).toBeNull();
    }
  });

  it("E: insight is computed from real Flow numbers (idle counts, conversion) with no fabricated stats", () => {
    const { container } = render(<Page />);
    fireEvent.click(flowButton(container, "Contacted"));
    // 63% to Replied (5/8); idle: Alpha Three (10d) + Beta Five (4d) of 3
    expect(within(dialog()).getByText(/63% of opportunities that reached Contacted have moved on to Replied\. 2 of 3 have had no update for 3\+ days\./)).toBeTruthy();
    fireEvent.click(flowButton(container, "Closed"));
    expect(within(dialog()).getByText(/7% of your pipeline is closed\./)).toBeTruthy();
    const text = dialog().textContent ?? "";
    for (const fake of ["bounce rates", "follow-up messages", "8.4 days", "video breakdown", "pre-meeting summary", "5.2 days", "coffee shop", "Stage AI Insight"]) {
      expect(text).not.toContain(fake);
    }
  });

  it("E: filtered insight uses the filtered idle count", () => {
    const { container } = render(<Page />);
    fireEvent.change(screen.getByLabelText("Search opportunities"), { target: { value: "alpha" } });
    fireEvent.click(flowButton(container, "Contacted"));
    expect(within(dialog()).getByText(/50% of opportunities that reached Contacted have moved on to Replied\. 1 of 2 has had no update for 3\+ days\./)).toBeTruthy();
  });

  it("E: an empty stage shows the honest unavailable state", () => {
    const { container } = render(<Page />);
    fireEvent.change(screen.getByLabelText("Search opportunities"), { target: { value: "alpha" } });
    fireEvent.click(flowButton(container, "Closed"));
    expect(within(dialog()).getByText("Not enough activity yet.")).toBeTruthy();
  });

  it("F: no Bulk outreach button and no fake success toast", () => {
    const { container } = render(<Page />);
    NAMES.forEach((name) => {
      fireEvent.click(flowButton(container, name));
      expect(within(dialog()).queryByText(/bulk outreach/i)).toBeNull();
    });
    expect(h.toastInfo).not.toHaveBeenCalled();
    expect(h.toastSuccess).not.toHaveBeenCalled();
  });

  it("G: activity is requested by the stage's own lead ids (never by name) and shows only that stage", () => {
    const { container } = render(<Page />);

    fireEvent.click(flowButton(container, "New"));
    let call = [...h.stageActivityCalls].reverse().find((c) => c.stage === "new")!;
    expect(call.ids.sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 20]); // New leads only (no dead, no other stage)
    let text = dialog().textContent ?? "";
    expect(text).toContain("TWIN-IN-NEW");
    expect(text).toContain("BETA-FOUR-OPENED");
    expect(text).not.toContain("TWIN-IN-REPLIED"); // same business name, different lead_id
    expect(text).not.toContain("ALPHA-FIVE-REPLY");

    fireEvent.click(flowButton(container, "Replied"));
    call = [...h.stageActivityCalls].reverse().find((c) => c.stage === "replied")!;
    expect(call.ids.sort((a, b) => a - b)).toEqual([10, 11, 21]);
    text = dialog().textContent ?? "";
    expect(text).toContain("TWIN-IN-REPLIED");
    expect(text).toContain("ALPHA-FIVE-REPLY"); // 40 days old: a quiet stage still gets its real activity
    expect(text).not.toContain("TWIN-IN-NEW");

    fireEvent.click(flowButton(container, "Meeting"));
    expect(within(dialog()).getByText("No recent activity recorded for opportunities in this stage.")).toBeTruthy();
  });

  it("G: filtered drawer only asks for activity of leads that pass the filters", () => {
    const { container } = render(<Page />);
    fireEvent.change(screen.getByLabelText("Search opportunities"), { target: { value: "alpha" } });
    fireEvent.click(flowButton(container, "Replied"));
    const call = [...h.stageActivityCalls].reverse().find((c) => c.stage === "replied")!;
    expect(call.ids).toEqual([10]);
  });

  it("7: Recent Opportunities belong to the stage and are ordered by most recently updated", () => {
    const { container } = render(<Page />);
    fireEvent.click(flowButton(container, "New"));
    // updatedAt desc: Beta Four (1h), Twin & Beta One & Beta Two (1d), Alpha Two (2d), Alpha One (3d), Beta Three (4d)
    const names = listedNames();
    expect(names[0]).toBe("Beta Four");
    expect(names.slice(-1)[0]).toBe("Beta Three");
    expect(names).toHaveLength(7);
    expect(within(dialog()).getByText(/Recent Opportunities \(7 of 7\)/)).toBeTruthy();
    expect(names).not.toContain("Alpha Three"); // a Contacted lead
    expect(names).not.toContain("Beta Eight"); // dead
  });

  it("8: switching stages recomputes every section from the newly selected stage", () => {
    const { container } = render(<Page />);
    fireEvent.click(flowButton(container, "New"));
    expect(tile("Opportunity")).toBe("$4.0k");
    expect(dialog().textContent).toContain("BETA-FOUR-OPENED");
    fireEvent.click(flowButton(container, "Replied"));
    expect(tile("Leads")).toBe("3");
    expect(tile("To Meeting")).toBe("40%");
    expect(tile("Opportunity")).toBe("Unavailable");
    expect(dialog().textContent).not.toContain("BETA-FOUR-OPENED");
    expect(dialog().textContent).not.toContain("moved on to Contacted");
    expect(listedNames().sort()).toEqual(["Alpha Five", "Beta Six", "Twin"]);
  });

  it("9: moving a lead records a real status_changed activity AND the status patch, for the selected lead", async () => {
    const { container } = render(<Page />);
    fireEvent.click(flowButton(container, "Contacted"));
    const row = within(dialog()).getByText("Alpha Four").closest("div.cursor-pointer")!;
    fireEvent.change(row.querySelector("select")!, { target: { value: "replied" } });
    await vi.waitFor(() => expect(h.recordMutate).toHaveBeenCalledTimes(1));
    const arg = h.recordMutate.mock.calls[0][0];
    expect(arg.lead.id).toBe(9);
    expect(arg.patch).toEqual({ status: "replied" });
    expect(arg.activity.type).toBe("status_changed");
    expect(arg.activity.content).toBe("Moved from Called to Replied");
    expect(arg.activity.metadata).toMatchObject({ from: "called", to: "replied" });
    await vi.waitFor(() => expect(h.toastSuccess).toHaveBeenCalledWith("Moved lead to Replied"));
  });

  it("9: respects the pipeline permission (no write, no activity, clear error)", async () => {
    h.can = false;
    const { container } = render(<Page />);
    fireEvent.click(flowButton(container, "Contacted"));
    const row = within(dialog()).getByText("Alpha Four").closest("div.cursor-pointer")!;
    fireEvent.change(row.querySelector("select")!, { target: { value: "replied" } });
    await vi.waitFor(() => expect(h.toastError).toHaveBeenCalledWith("Upgrade your plan to reorder the pipeline"));
    expect(h.recordMutate).not.toHaveBeenCalled();
  });

  it("9: a failed move surfaces an error (never a success toast)", async () => {
    h.recordMutate.mockRejectedValueOnce(new Error("boom"));
    const { container } = render(<Page />);
    fireEvent.click(flowButton(container, "Contacted"));
    const row = within(dialog()).getByText("Alpha Four").closest("div.cursor-pointer")!;
    fireEvent.change(row.querySelector("select")!, { target: { value: "replied" } });
    await vi.waitFor(() => expect(h.toastError).toHaveBeenCalledWith("Could not move lead"));
    expect(h.toastSuccess).not.toHaveBeenCalled();
  });

  it("9: Discover and View Opportunity Network navigate to the real routes", () => {
    const { container } = render(<Page />);
    fireEvent.click(flowButton(container, "New"));
    fireEvent.click(within(dialog()).getByText("Discover"));
    expect(h.navigate).toHaveBeenCalledWith({ to: "/dashboard/leads" });
    fireEvent.click(within(dialog()).getByText("View Opportunity Network"));
    expect(h.navigate).toHaveBeenCalledWith({ to: "/dashboard/relationships" });
  });
});
