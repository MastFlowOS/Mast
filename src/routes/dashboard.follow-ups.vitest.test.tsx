import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";

/**
 * Mission page must run on the user's real follow-ups: no seeded demo rows,
 * every number derived from data, and failures must surface (never fake
 * a success toast).
 */

const h = vi.hoisted(() => ({
  followups: [] as unknown[],
  updateMutate: vi.fn(),
  activityMutate: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
  navigate: vi.fn(),
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
vi.mock("sonner", () => ({ toast: { error: h.toastError, success: h.toastSuccess, info: vi.fn() } }));
vi.mock("@/components/mast/FeatureGate", () => ({ FeatureGate: ({ children }: { children: React.ReactNode }) => <>{children}</> }));
vi.mock("@/lib/api", () => ({ getLead: vi.fn() }));
vi.mock("@/hooks/use-mast-api", () => ({
  useFollowups: () => ({ data: h.followups, isLoading: false, isError: false, isFetching: false, refetch: vi.fn() }),
  useAnalytics: () => ({ data: { replyRate: 50 } }),
  useMissionWeekStats: () => ({
    data: { actions: 7, replies: 3, meetings: 1, closed: 0, daily: { actions: [0, 1, 2, 0, 1, 2, 1], replies: [0, 0, 1, 0, 1, 0, 1], meetings: [0, 0, 0, 0, 0, 0, 1], closed: [0, 0, 0, 0, 0, 0, 0] } },
  }),
  useUpdateFollowup: () => ({ mutateAsync: h.updateMutate, isPending: false }),
  useRecordLeadActivity: () => ({ mutateAsync: h.activityMutate, isPending: false }),
}));

import { Route } from "./dashboard.follow-ups";

const DAY = 86_400_000;
function mk(id: number, name: string, dueAt: Date, extra: Record<string, unknown> = {}, leadExtra: Record<string, unknown> = {}) {
  return {
    id,
    leadId: id,
    channel: "email",
    dueAt: dueAt.toISOString(),
    status: "pending",
    notes: null,
    createdAt: new Date(Date.now() - DAY).toISOString(),
    updatedAt: new Date(Date.now() - DAY).toISOString(),
    lead: { id, businessName: name, status: "email_sent", priority: "normal", niche: "web_design", createdAt: "", updatedAt: "", ...leadExtra },
    ...extra,
  };
}

function Page() {
  const C = (Route as unknown as { options: { component: () => JSX.Element } }).options.component;
  return <C />;
}

function noonToday() {
  const d = new Date();
  d.setHours(12, 0, 0, 0);
  return d;
}

describe("Mission page (real data)", () => {
  beforeEach(() => {
    h.updateMutate.mockReset().mockResolvedValue({});
    h.activityMutate.mockReset().mockResolvedValue({});
    h.toastError.mockReset();
    h.toastSuccess.mockReset();
    h.navigate.mockReset();
  });
  afterEach(cleanup);

  it("shows an honest empty state (no demo leads) when there are no follow-ups", () => {
    h.followups = [];
    render(<Page />);
    expect(screen.getByText("No missions yet")).toBeTruthy();
    expect(screen.queryByText("Nova Creative Studio")).toBeNull();
    expect(screen.queryByText(/Today's mission/i)).toBeNull();
  });

  it("derives every counter from the user's follow-ups", () => {
    h.followups = [
      mk(1, "Overdue One", new Date(Date.now() - 3 * DAY), {}, { status: "replied" }),
      mk(2, "Overdue Two", new Date(Date.now() - 2 * DAY)),
      mk(3, "Due Today", noonToday()),
      mk(4, "Next Week", new Date(Date.now() + 5 * DAY)),
      mk(5, "Done Today", noonToday(), { status: "completed", completedAt: new Date().toISOString() }),
    ];
    render(<Page />);
    expect(screen.getByRole("button", { name: "Today (3)" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Upcoming (1)" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Overdue (2)" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Completed (1)" })).toBeTruthy();
    // hero: 3 pending + 1 completed today = 4 actions, 1 done
    expect(screen.getByText("1/4")).toBeTruthy();
    expect(screen.getByText("Follow up on 2 overdue leads")).toBeTruthy();
    expect(screen.getByText("Nurture 1 warm conversation")).toBeTruthy();
    // weekly stats come from the API hook, not constants
    expect(screen.getByText("7")).toBeTruthy();
    // replied lead outranks the rest; seeded names never appear
    expect(screen.getAllByText("Overdue One").length).toBeGreaterThan(0);
    expect(screen.queryByText("Nova Creative Studio")).toBeNull();
  });

  it("completes a follow-up through the API and logs the activity", async () => {
    h.followups = [mk(10, "Acme Co", noonToday())];
    render(<Page />);
    fireEvent.click(screen.getByTitle("Mark as completed"));
    await waitFor(() => expect(h.updateMutate).toHaveBeenCalled());
    expect(h.updateMutate.mock.calls[0][0]).toMatchObject({ id: 10, body: { status: "completed" } });
    await waitFor(() => expect(h.activityMutate).toHaveBeenCalled());
    expect(h.activityMutate.mock.calls[0][0].activity.type).toBe("followup_completed");
    await waitFor(() => expect(h.toastSuccess).toHaveBeenCalledWith("Completed: Acme Co"));
  });

  it("surfaces a failure instead of faking success, and rolls the row back", async () => {
    h.followups = [mk(11, "Broken Co", noonToday())];
    h.updateMutate.mockRejectedValue(new Error("db down"));
    render(<Page />);
    fireEvent.click(screen.getByTitle("Mark as completed"));
    await waitFor(() => expect(h.toastError).toHaveBeenCalled());
    expect(h.toastSuccess).not.toHaveBeenCalled();
    // row is back in the Today list and still actionable
    expect(screen.getByTitle("Mark as completed")).toBeTruthy();
  });

  it("Take Action opens the lead workspace instead of silently completing", () => {
    h.followups = [mk(12, "Open Me", noonToday())];
    render(<Page />);
    fireEvent.click(screen.getByRole("button", { name: "Take Action" }));
    expect(h.navigate).toHaveBeenCalledWith({ to: "/dashboard/leads/$leadId", params: { leadId: "12" } });
    expect(h.updateMutate).not.toHaveBeenCalled();
  });
});
