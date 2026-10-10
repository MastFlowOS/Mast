import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, within, waitFor } from "@testing-library/react";
import type { PlanId } from "@/lib/plans";

/**
 * Discover page flow tests: what the user SEES must agree with what the run
 * actually did.
 *
 *  - Instant Pool / Ranked Instant never show the live scouting screen and
 *    never auto-start Live Discovery; a partial result is reported truthfully
 *    (requested / delivered / shortfall) with an EXPLICIT follow-up button.
 *  - The follow-up is its own request (method "live", followsJobId, only the
 *    shortfall) and its progress target is the server's `requested`.
 *  - Success toasts only when delivered >= requested.
 *  - Contact icons reflect the saved record; AI Overview's "Your search"
 *    reflects the active form state and equals the request actually sent.
 */

const h = vi.hoisted(() => ({
  plan: "starter" as string,
  mutateAsync: vi.fn(),
  toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() },
  subscribe: vi.fn(),
  sub: null as null | { jobId: string; handlers: any; options: any },
  liveHookArgs: [] as Array<[string | null, number, number]>,
}));

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (opts: unknown) => ({ options: opts }),
  Link: ({ children, to, ...rest }: { children: React.ReactNode; to: string }) => (
    <a href={to} {...rest}>
      {children}
    </a>
  ),
  Outlet: () => null,
  useNavigate: () => vi.fn(),
  useRouterState: () => "/dashboard/leads",
}));
vi.mock("@tanstack/react-query", () => ({ useQueryClient: () => ({ invalidateQueries: vi.fn() }) }));
vi.mock("sonner", () => ({ toast: h.toast }));
vi.mock("@/lib/notifications", () => ({ addNotification: vi.fn() }));
vi.mock("@/lib/api", () => ({
  ApiError: class ApiError extends Error {},
  subscribeToDiscoverJob: (jobId: string, handlers: any, options: any) => {
    h.subscribe(jobId, handlers, options);
    h.sub = { jobId, handlers, options };
    return () => {};
  },
  cancelDiscoverJob: vi.fn(),
}));
vi.mock("@/hooks/use-live-discovery", () => ({
  useLiveDiscoveryState: (planId: string | null, target: number, initial: number) => {
    h.liveHookArgs.push([planId, target, initial]);
    return { delivered: initial, target, rejected: 0, progressPercent: 0, status: "discovering", scouts: {} };
  },
}));
vi.mock("@/components/mast/LiveDiscoveryScreen", () => ({
  LiveDiscoveryScreen: ({ state }: { state: { delivered: number; target: number } }) => (
    <div data-testid="live-screen">
      {state.delivered}/{state.target}
    </div>
  ),
}));
vi.mock("@/lib/discover-insights", () => ({
  buildDiscoverInsights: () => [
    { id: "a", title: "Run a discovery now", reason: "Capacity is fresh.", tone: "brand", confidence: "Recommended", actionLabel: "View →", actionHref: "/dashboard/analytics" },
  ],
}));
vi.mock("@/hooks/use-mast-api", () => ({
  queryKeys: { account: ["a"], analytics: ["b"] },
  useAccount: () => ({
    data: {
      dailyUsage: { remaining: 280 },
      monthlyUsage: { remaining: 2780 },
      limits: { allowInstantPool: true, allowPremiumPool: true },
      subscription: { plan: h.plan },
    },
  }),
  useSettings: () => ({ data: { defaultRegions: "" } }),
  useAnalytics: () => ({ data: {} }),
  useLeads: () => ({ data: [] }),
  useGenerateLeads: () => ({ mutateAsync: h.mutateAsync }),
}));
vi.mock("@/hooks/use-permissions", async () => {
  const { buildPermissionsManager } = await import("@/lib/permissions");
  return { usePermissions: () => ({ permissions: buildPermissionsManager(h.plan as PlanId), isLoading: false }) };
});

const lead = (id: number, over: Record<string, unknown> = {}) => ({
  id,
  businessName: `Biz ${id}`,
  location: "Austin, TX",
  email: `b${id}@x.test`,
  phone: "+15550001111",
  instagramHandle: `@b${id}`,
  website: `https://b${id}.test`,
  ...over,
});

async function renderDiscover(plan = "starter") {
  h.plan = plan;
  const { Route } = await import("./dashboard.leads");
  const Page = (Route as unknown as { options: { component: React.ComponentType } }).options.component;
  return render(<Page />);
}
async function pickNiche(name: string) {
  fireEvent.change(screen.getByPlaceholderText(/search niches/i), { target: { value: name } });
  fireEvent.click(await screen.findByRole("button", { name: new RegExp(`^${name}`, "i") }));
}
async function launch() {
  const btn = screen.getByRole("button", { name: /Launch Discovery/ }) as HTMLButtonElement;
  await waitFor(() => expect(btn.disabled).toBe(false));
  fireEvent.click(btn);
}
async function setupAndLaunch(plan = "starter") {
  await renderDiscover(plan);
  await pickNiche("Coffee Shop");
  fireEvent.click(screen.getByRole("button", { name: /^Email/ }));
  fireEvent.click(screen.getByRole("button", { name: /^Phone/ }));
  await launch();
}
const WAIT = { timeout: 4000 };

const partialInstant = (over: Record<string, unknown> = {}) => ({
  leads: [lead(1), lead(2), lead(3), lead(4), lead(5), lead(6), lead(7)],
  requested: 10,
  delivered: 7,
  shortfall: 3,
  status: "completed_partial",
  shortfallReason: "pool_exhausted",
  liveFollowUp: { available: true, remaining: 3 },
  jobId: "job-pool-1",
  planId: undefined,
  pending: false,
  generated: 7,
  ...over,
});

beforeEach(() => {
  h.mutateAsync.mockReset();
  h.subscribe.mockReset();
  h.sub = null;
  h.liveHookArgs = [];
  h.toast.error.mockReset();
  h.toast.success.mockReset();
  h.toast.info.mockReset();
});
afterEach(cleanup);

describe("Instant Pool / Ranked Instant results", () => {
  it("a PARTIAL pool result shows the real counts and the pool-shortfall reason — never the scouting screen, never a success toast, never a live subscription", async () => {
    h.mutateAsync.mockResolvedValue(partialInstant());
    await setupAndLaunch("starter");

    const outcome = await screen.findByTestId("discover-outcome", undefined, WAIT);
    expect(outcome.getAttribute("data-kind")).toBe("partial");
    expect(outcome.textContent).toMatch(/7 of 10 opportunities delivered/);
    expect(outcome.textContent).toMatch(/pool did not contain enough qualifying matches/i);
    expect(screen.getByTestId("discover-counts").textContent).toBe("Requested 10 · Delivered 7 · Shortfall 3");

    expect(screen.queryByTestId("live-screen")).toBeNull();
    expect(h.subscribe).not.toHaveBeenCalled();
    expect(h.toast.success).not.toHaveBeenCalled();
    expect(h.toast.info).toHaveBeenCalledWith(expect.stringMatching(/7 of 10/), expect.anything());
    // The request is a plain instant request, with no follow-up id.
    expect(h.mutateAsync).toHaveBeenCalledTimes(1);
    expect(h.mutateAsync.mock.calls[0][0].method).toBe("instant_pool");
    expect(h.mutateAsync.mock.calls[0][0].followsJobId).toBeUndefined();
  });

  it("a FULL pool result is the only case that shows success wording and a success toast; no follow-up is offered", async () => {
    h.mutateAsync.mockResolvedValue(
      partialInstant({ delivered: 10, shortfall: 0, status: "completed", shortfallReason: null, liveFollowUp: { available: false, remaining: 0 }, leads: Array.from({ length: 10 }, (_, i) => lead(i + 1)), generated: 10 }),
    );
    await setupAndLaunch("starter");
    const outcome = await screen.findByTestId("discover-outcome", undefined, WAIT);
    expect(outcome.getAttribute("data-kind")).toBe("complete");
    expect(outcome.textContent).toMatch(/10 opportunities prepared/);
    expect(h.toast.success).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("find-remaining-live")).toBeNull();
  });

  it("an EMPTY pool says so honestly and offers the explicit Live action (does not start it)", async () => {
    h.mutateAsync.mockResolvedValue(
      partialInstant({ leads: [], delivered: 0, shortfall: 10, liveFollowUp: { available: true, remaining: 10 }, generated: 0 }),
    );
    await setupAndLaunch("starter");
    const outcome = await screen.findByTestId("discover-outcome", undefined, WAIT);
    expect(outcome.getAttribute("data-kind")).toBe("empty");
    expect(outcome.textContent).toMatch(/No qualifying opportunities found/);
    expect(screen.getByTestId("find-remaining-live")).toBeTruthy();
    expect(h.mutateAsync).toHaveBeenCalledTimes(1);
  });

  it("a plan-limit stop is explained as the plan limit and offers NO live follow-up", async () => {
    h.mutateAsync.mockResolvedValue(
      partialInstant({ delivered: 4, shortfall: 6, shortfallReason: "plan_limit_reached", liveFollowUp: { available: false, remaining: 6 }, leads: [lead(1), lead(2), lead(3), lead(4)], generated: 4 }),
    );
    await setupAndLaunch("starter");
    const outcome = await screen.findByTestId("discover-outcome", undefined, WAIT);
    expect(outcome.textContent).toMatch(/plan's lead limit/i);
    expect(screen.queryByTestId("find-remaining-live")).toBeNull();
  });

  it("Ranked Instant that is not fully ranked says so; it never claims full ranking", async () => {
    h.mutateAsync.mockResolvedValue(
      partialInstant({ ranking: { requested: true, status: "partial", scored: 5, unscored: 2, policy: "unscored_last", reason: null } }),
    );
    await setupAndLaunch("pro");
    const note = await screen.findByTestId("discover-ranking-note", undefined, WAIT);
    expect(note.textContent).toMatch(/Not fully ranked: 2 of 7/);
  });

  it("Ranked Instant with no focus area reports ranking as unavailable", async () => {
    h.mutateAsync.mockResolvedValue(
      partialInstant({ ranking: { requested: true, status: "unavailable", scored: 0, unscored: 7, policy: "unscored_last", reason: "no_profession_focus" } }),
    );
    await setupAndLaunch("pro");
    const note = await screen.findByTestId("discover-ranking-note", undefined, WAIT);
    expect(note.textContent).toMatch(/Ranking unavailable/);
  });
});

describe("explicit Live Discovery follow-up", () => {
  it("starts its OWN live request (method live, followsJobId, only the shortfall) and shows a 0/shortfall live screen using the SERVER's requested count", async () => {
    h.mutateAsync.mockResolvedValueOnce(partialInstant());
    await setupAndLaunch("starter");
    fireEvent.click(await screen.findByTestId("find-remaining-live", undefined, WAIT));

    await waitFor(() => expect(h.mutateAsync).toHaveBeenCalledTimes(2));
    const first = h.mutateAsync.mock.calls[0][0];
    const second = h.mutateAsync.mock.calls[1][0];
    expect(second).toMatchObject({
      method: "live",
      mode: "scrape",
      quantity: 3,
      followsJobId: "job-pool-1",
      region: first.region,
      niche: first.niche,
      channels: first.channels,
    });
    expect(second.quantity).not.toBe(first.quantity);
  });

  it("while the live follow-up runs, its counters are its own: target = server requested (3, not the slider's 10), starting at 0", async () => {
    h.mutateAsync
      .mockResolvedValueOnce(partialInstant())
      .mockResolvedValueOnce({ leads: [], requested: 3, delivered: 0, shortfall: 3, status: "queued", jobId: "job-live-2", planId: "plan-live-2", pending: true, generated: 0 });
    await setupAndLaunch("starter");
    fireEvent.click(await screen.findByTestId("find-remaining-live", undefined, WAIT));

    const screenEl = await screen.findByTestId("live-screen", undefined, WAIT);
    expect(screenEl.textContent).toBe("0/3");
    const last = h.liveHookArgs[h.liveHookArgs.length - 1];
    expect(last).toEqual(["plan-live-2", 3, 0]);
    expect(h.sub!.jobId).toBe("job-live-2");
    expect(h.sub!.options).toEqual({ requestedQuantity: 3 });
  });

  it("the live screen's delivered count never lags leads that are actually saved", async () => {
    h.mutateAsync.mockResolvedValue({ leads: [], requested: 5, delivered: 0, shortfall: 5, status: "queued", jobId: "job-live-1", planId: "plan-1", pending: true, generated: 0 });
    await setupAndLaunch("free");
    await screen.findByTestId("live-screen", undefined, WAIT);
    h.sub!.handlers.onLead(lead(1));
    h.sub!.handlers.onLead(lead(2));
    h.sub!.handlers.onLead(lead(2)); // duplicate event
    await waitFor(() => expect(screen.getByTestId("live-screen").textContent).toBe("2/5"));
  });
});

describe("Live Discovery outcomes", () => {
  const startLive = async () => {
    h.mutateAsync.mockResolvedValue({ leads: [], requested: 5, delivered: 0, shortfall: 5, status: "queued", jobId: "job-live-1", planId: "plan-1", pending: true, generated: 0 });
    await setupAndLaunch("free");
    await screen.findByTestId("live-screen", undefined, WAIT);
  };

  it("exhausted with 2 of 5: reported as partial with real counts, NOT 'success'", async () => {
    await startLive();
    h.sub!.handlers.onLead(lead(1));
    h.sub!.handlers.onLead(lead(2));
    h.sub!.handlers.onStatusChange("completed_partial", 2);
    const outcome = await screen.findByTestId("discover-outcome", undefined, WAIT);
    expect(outcome.getAttribute("data-kind")).toBe("partial");
    expect(outcome.textContent).toMatch(/2 of 5/);
    expect(screen.getByTestId("discover-counts").textContent).toBe("Requested 5 · Delivered 2 · Shortfall 3");
    expect(h.toast.success).not.toHaveBeenCalled();
    // A live run's shortfall does not offer another live follow-up.
    expect(screen.queryByTestId("find-remaining-live")).toBeNull();
  });

  it("a completed run with all 5 is the only live success", async () => {
    await startLive();
    for (let i = 1; i <= 5; i++) h.sub!.handlers.onLead(lead(i));
    h.sub!.handlers.onStatusChange("completed", 5);
    const outcome = await screen.findByTestId("discover-outcome", undefined, WAIT);
    expect(outcome.getAttribute("data-kind")).toBe("complete");
    expect(h.toast.success).toHaveBeenCalledTimes(1);
  });

  it("a failed run with nothing delivered ends visibly: error toast, back to the form, no results screen", async () => {
    await startLive();
    h.sub!.handlers.onStatusChange("failed", 0);
    await waitFor(() => expect(h.toast.error).toHaveBeenCalled(), WAIT);
    await waitFor(() => expect(screen.queryByTestId("live-screen")).toBeNull(), WAIT);
    expect(screen.queryByTestId("discover-outcome")).toBeNull();
    expect(h.toast.success).not.toHaveBeenCalled();
  });

  it("a failed run that had delivered leads reports the interruption with the real count", async () => {
    await startLive();
    h.sub!.handlers.onLead(lead(1));
    h.sub!.handlers.onLead(lead(2));
    h.sub!.handlers.onStatusChange("failed", 2);
    const outcome = await screen.findByTestId("discover-outcome", undefined, WAIT);
    expect(outcome.getAttribute("data-kind")).toBe("failed");
    expect(outcome.textContent).toMatch(/2 of 5 delivered/);
    expect(h.toast.success).not.toHaveBeenCalled();
  });
});

describe("contact-channel icons", () => {
  it("every delivered record shows all four icons when all four were requested and present", async () => {
    h.mutateAsync.mockResolvedValue(partialInstant({ leads: [lead(1)], delivered: 1, requested: 1 }));
    await renderDiscover("pro");
    await pickNiche("Coffee Shop");
    for (const name of [/^Email/, /^Phone/, /^Instagram/, /^Website/]) fireEvent.click(screen.getByRole("button", { name }));
    await launch();
    const icons = await screen.findByTestId("contact-channel-icons", undefined, WAIT);
    const all = within(icons).getAllByTitle(/available|missing/);
    expect(all).toHaveLength(4);
    expect(all.every((el) => el.getAttribute("data-present") === "true")).toBe(true);
  });

  it("a record missing a REQUESTED channel is visibly flagged instead of silently showing fewer icons; unrequested absent channels stay hidden", async () => {
    h.mutateAsync.mockResolvedValue(
      partialInstant({ leads: [lead(1, { email: null, instagramHandle: null })], delivered: 1, requested: 1 }),
    );
    await renderDiscover("pro");
    await pickNiche("Coffee Shop");
    fireEvent.click(screen.getByRole("button", { name: /^Email/ }));
    fireEvent.click(screen.getByRole("button", { name: /^Phone/ }));
    await launch();
    const icons = await screen.findByTestId("contact-channel-icons", undefined, WAIT);
    const byChannel = Object.fromEntries(
      Array.from(icons.querySelectorAll("[data-channel]")).map((el) => [el.getAttribute("data-channel"), el.getAttribute("data-present")]),
    );
    // requested: email (missing -> flagged), phone (present). Website is present so it shows; Instagram is absent AND unrequested so it's hidden.
    expect(byChannel.email).toBe("false");
    expect(byChannel.phone).toBe("true");
    expect(byChannel.website).toBe("true");
    expect("instagram" in byChannel).toBe(false);
  });
});

describe("AI Overview", () => {
  it("'Your search' reflects the ACTIVE form state, and equals the request that is actually sent", async () => {
    h.mutateAsync.mockResolvedValue(partialInstant());
    await renderDiscover("starter");
    await pickNiche("Coffee Shop");
    fireEvent.click(screen.getByRole("button", { name: /^Email/ }));

    let setup = within(screen.getByTestId("ai-current-setup"));
    expect(setup.getByText("Coffee Shop")).toBeTruthy();
    expect(setup.getByText("United States")).toBeTruthy();
    expect(setup.getByText("10")).toBeTruthy();
    expect(setup.getByText("email")).toBeTruthy();
    expect(setup.getByText("Instant pool")).toBeTruthy();

    // changing the form changes the overview immediately (no stale/hardcoded config)
    fireEvent.click(screen.getByRole("button", { name: /^Phone/ }));
    setup = within(screen.getByTestId("ai-current-setup"));
    expect(setup.getByText("email + phone")).toBeTruthy();

    const shown = {
      niche: screen.getByTestId("ai-current-setup").querySelector('[data-field="niche"]')!.textContent,
      region: screen.getByTestId("ai-current-setup").querySelector('[data-field="region"]')!.textContent,
      amount: screen.getByTestId("ai-current-setup").querySelector('[data-field="amount"]')!.textContent,
      channels: screen.getByTestId("ai-current-setup").querySelector('[data-field="channels"]')!.textContent,
    };
    await launch();
    await waitFor(() => expect(h.mutateAsync).toHaveBeenCalledTimes(1));
    const sent = h.mutateAsync.mock.calls[0][0];
    expect(shown).toEqual({
      niche: sent.niche,
      region: sent.region,
      amount: String(sent.quantity),
      channels: sent.channels.join(" + "),
    });
  });

  it("recommendation tiles are labelled as suggestions, not as the configured search", async () => {
    await renderDiscover("starter");
    const overviewText = screen.getByTestId("ai-current-setup").closest("section")!.textContent ?? "";
    expect(overviewText).toMatch(/Suggested niche/);
    expect(overviewText).toMatch(/Suggested region/);
    expect(overviewText).toMatch(/Suggested amount/);
    expect(overviewText).toMatch(/Suggested channel/);
    expect(overviewText).toMatch(/recommendations for what to try next/i);
    expect(overviewText).not.toMatch(/analysis of your current discovery setup/i);
  });
});
