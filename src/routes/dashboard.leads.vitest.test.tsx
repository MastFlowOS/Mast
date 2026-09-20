import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, within, waitFor } from "@testing-library/react";
import type { PlanId } from "@/lib/plans";

/**
 * Behavior tests for the redesigned Discover page. These pin the things the
 * redesign must NOT change (request payload, plan gating, credit amount,
 * multi-niche) and the things it MUST change (no Business Currency, no
 * speed/quality/cost bars, compact channel chips, corrected time labels).
 */

const h = vi.hoisted(() => ({
  plan: "free" as string,
  defaultRegions: "" as string,
  mutateAsync: vi.fn(),
  toastError: vi.fn(),
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

vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));

vi.mock("sonner", () => ({ toast: { error: h.toastError, success: vi.fn(), info: vi.fn() } }));
vi.mock("@/lib/notifications", () => ({ addNotification: vi.fn() }));

vi.mock("@/lib/api", () => ({
  ApiError: class ApiError extends Error {},
  subscribeToDiscoverJob: vi.fn(() => () => {}),
  cancelDiscoverJob: vi.fn(),
}));

vi.mock("@/hooks/use-live-discovery", () => ({ useLiveDiscoveryState: () => ({}) }));
vi.mock("@/components/mast/LiveDiscoveryScreen", () => ({ LiveDiscoveryScreen: () => null }));

vi.mock("@/lib/discover-insights", () => ({
  buildDiscoverInsights: () => [
    {
      id: "a",
      title: "Run a discovery now",
      reason: "Capacity is fresh.",
      tone: "brand",
      confidence: "Recommended",
      actionLabel: "View strategy →",
      actionHref: "/dashboard/analytics",
    },
    {
      id: "b",
      title: "Second insight",
      reason: "More detail.",
      tone: "neutral",
      confidence: "Worth Testing",
      actionLabel: "Open →",
      actionHref: "/dashboard/pipeline",
    },
  ],
}));

vi.mock("@/hooks/use-mast-api", () => ({
  queryKeys: { account: ["a"], analytics: ["b"], progressionEvents: ["c"] },
  useAccount: () => ({
    data: {
      dailyUsage: { remaining: 280 },
      monthlyUsage: { remaining: 2780 },
      limits: { allowInstantPool: h.plan === "pro" || h.plan === "premium", allowPremiumPool: h.plan !== "free" },
      subscription: { plan: h.plan },
    },
  }),
  useSettings: () => ({ data: { defaultRegions: h.defaultRegions } }),
  useAnalytics: () => ({ data: {} }),
  useLeads: () => ({ data: [] }),
  useGenerateLeads: () => ({ mutateAsync: h.mutateAsync }),
}));

vi.mock("@/hooks/use-permissions", async () => {
  const { buildPermissionsManager } = await import("@/lib/permissions");
  return {
    usePermissions: () => ({ permissions: buildPermissionsManager(h.plan as PlanId), isLoading: false }),
  };
});

async function renderDiscover(plan: string = "free") {
  h.plan = plan;
  const { Route } = await import("./dashboard.leads");
  const Page = (Route as unknown as { options: { component: React.ComponentType } }).options.component;
  return render(<Page />);
}

async function pickNiche(name: string) {
  const input = screen.getByPlaceholderText(/search niches/i);
  fireEvent.focus(input);
  fireEvent.change(input, { target: { value: name } });
  fireEvent.click(await screen.findByRole("option", { name: new RegExp(`^${name}`, "i") }));
}

beforeEach(() => {
  h.mutateAsync.mockReset();
  h.toastError.mockReset();
  h.defaultRegions = "";
});
afterEach(cleanup);

describe("Discover redesign — removed / replaced UI", () => {
  it("has no Business Currency setting at all", async () => {
    await renderDiscover("pro");
    expect(screen.queryByText(/currency/i)).toBeNull();
    for (const code of ["USD", "EUR", "GBP", "CAD", "AUD", "AED"]) {
      expect(screen.queryByRole("button", { name: code })).toBeNull();
    }
  });

  it("Discovery Method is a real, plan-gated selector — PLAN badge and SELECTED are separate signals, locked methods stay unselectable", async () => {
    await renderDiscover("starter");
    const list = screen.getByRole("list", { name: /discovery methods/i });
    const options = within(list).getAllByRole("option");
    expect(options).toHaveLength(3);

    const live = options.find((o) => /Live Scraping/.test(o.textContent ?? ""))!;
    const pool = options.find((o) => /Instant Pool Access/.test(o.textContent ?? ""))!;
    const ranked = options.find((o) => /Ranked Instant Results/.test(o.textContent ?? ""))!;

    // Starter's default (ceiling) method, Instant Pool Access, is preselected.
    expect(pool.getAttribute("aria-selected")).toBe("true");
    expect(pool.textContent).toMatch(/selected/i);
    expect(live.getAttribute("aria-selected")).toBe("false");
    expect(ranked.getAttribute("aria-selected")).toBe("false");

    // PLAN badge (minimum plan required) is shown on every row, regardless
    // of selection — never conflated with the SELECTED indicator above.
    expect(live.textContent).toMatch(/free/i);
    expect(pool.textContent).toMatch(/starter/i);
    expect(ranked.textContent).toMatch(/pro/i);

    // Time labels, unchanged.
    expect(within(list).getByText("10–30 min")).toBeTruthy();
    expect(within(list).getAllByText("Instant").length).toBeGreaterThan(0);

    // Ranked Instant Results is above Starter's ceiling: visibly locked and
    // NOT selectable — clicking it shows the upgrade toast instead of
    // changing the selection (mirrors the existing locked-chip behavior).
    expect(ranked.querySelector("svg[aria-label*='Locked']")).not.toBeNull();
    fireEvent.click(ranked);
    expect(h.toastError).toHaveBeenCalledTimes(1);
    expect(ranked.getAttribute("aria-selected")).toBe("false");
    expect(pool.getAttribute("aria-selected")).toBe("true"); // selection unchanged

    // Live Scraping is below the ceiling and IS eligible: fully clickable.
    expect(live.querySelector("svg[aria-label*='Locked']")).toBeNull();
    fireEvent.click(live);
    expect(live.getAttribute("aria-selected")).toBe("true");
    expect(pool.getAttribute("aria-selected")).toBe("false");

    expect(screen.getByText(/choose how mast finds your opportunities/i)).toBeTruthy();
    expect(screen.getByText(/1 credit per opportunity/i)).toBeTruthy();
    // Nothing the backend does not run.
    expect(screen.queryByText(/mobile.?verified/i)).toBeNull();
  });

  it.each([
    ["free", "Live Scraping", "Live scraping · 10–30 min"],
    ["starter", "Instant Pool Access", "Instant pool · Instant"],
    ["pro", "Ranked Instant Results", "Ranked instant · Instant"],
    ["premium", "Ranked Instant Results", "Ranked instant · Instant"],
  ])("%s plan → active method %s, reflected in the summary", async (plan, label, summary) => {
    await renderDiscover(plan);
    const active = screen.getByRole("list", { name: /discovery methods/i }).querySelector('[aria-current="true"]')!;
    expect(active.textContent).toContain(label);
    expect(screen.getByText(summary)).toBeTruthy();
  });

  it("renders Contact Channels as compact chips, locking plan-restricted ones", async () => {
    await renderDiscover("free");
    const email = screen.getByRole("button", { name: /^Email/ });
    const ig = screen.getByRole("button", { name: /Instagram/ });
    expect(ig.querySelector("svg[aria-label='Locked on your plan']")).not.toBeNull();
    expect(email.querySelector("svg[aria-label='Locked on your plan']")).toBeNull();

    fireEvent.click(ig);
    expect(h.toastError).toHaveBeenCalledTimes(1);
    expect(ig.getAttribute("aria-pressed")).toBe("false");

    fireEvent.click(email);
    expect(email.getAttribute("aria-pressed")).toBe("true");
  });
});

describe("Discover redesign — Target Region is a country selector", () => {
  it("Top Picks are the three countries; continents are not top picks", async () => {
    await renderDiscover("pro");
    for (const c of ["United States", "United Kingdom", "Canada"]) {
      expect(screen.getByRole("button", { name: new RegExp(`^${c}`) })).toBeTruthy();
    }
    for (const r of ["North America", "Europe", "Asia"]) {
      expect(screen.queryByRole("button", { name: new RegExp(`^${r}`) })).toBeNull();
    }
    // Defaults to the first top pick.
    expect(screen.getByRole("button", { name: /^United States/ }).getAttribute("aria-pressed")).toBe("true");
  });

  it("country search selects any supported country; regions appear only as a secondary group", async () => {
    await renderDiscover("pro");
    const search = screen.getByPlaceholderText(/search countries/i);
    fireEvent.focus(search);
    fireEvent.change(search, { target: { value: "un" } });
    // Prefix matches lead: United … before names that merely contain "un".
    const first = (await screen.findAllByRole("option"))[0];
    expect(first.textContent).toMatch(/^Un/);
    fireEvent.change(search, { target: { value: "germ" } });
    fireEvent.click(await screen.findByRole("option", { name: /Germany/ }));
    expect(screen.getByRole("button", { name: /^Germany/ }).getAttribute("aria-pressed")).toBe("true");

    fireEvent.change(search, { target: { value: "eur" } });
    expect(await screen.findByText("Regions")).toBeTruthy();
    expect(screen.getByRole("option", { name: /^Europe/ })).toBeTruthy();
  });

  it("a saved default (country or continent) is honoured and shown as a selected chip", async () => {
    h.defaultRegions = "North America";
    await renderDiscover("pro");
    expect(screen.getByRole("button", { name: /^North America/ }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: /^United States/ }).getAttribute("aria-pressed")).toBe("false");
  });

  it("Free plan: North-American countries selectable, others locked (server rule)", async () => {
    await renderDiscover("free");
    const uk = screen.getByRole("button", { name: /^United Kingdom/ });
    expect(uk.querySelector("svg[aria-label='Locked on your plan']")).not.toBeNull();
    fireEvent.click(uk);
    expect(h.toastError).toHaveBeenCalledTimes(1);
    expect(uk.getAttribute("aria-pressed")).toBe("false");

    const ca = screen.getByRole("button", { name: /^Canada/ });
    expect(ca.querySelector("svg[aria-label='Locked on your plan']")).toBeNull();
    fireEvent.click(ca);
    expect(ca.getAttribute("aria-pressed")).toBe("true");
    expect(h.toastError).toHaveBeenCalledTimes(1);
  });
});

describe("Discover redesign — preserved behavior", () => {
  it("summary + credits reflect real state; no standing red warning when merely incomplete", async () => {
    await renderDiscover("pro");
    expect(screen.getByText("Discovery Summary")).toBeTruthy();
    expect(screen.getByText("10 credits")).toBeTruthy();
    // Once as the selected chip, once as the summary line.
    expect(screen.getAllByText("United States").length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText(/Today:/).textContent).toContain("280");
    expect(screen.getByText(/Month:/).textContent).toContain("2,780");
    const launch = screen.getByRole("button", { name: /Launch Discovery/ }) as HTMLButtonElement;
    expect(launch.disabled).toBe(true);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByText(/select a niche to launch/i)).toBeTruthy();
  });

  it("launches with the selected COUNTRY (not a continent) and multi-niche intact", async () => {
    h.mutateAsync.mockResolvedValue({ leads: [], pending: false, generated: 0, jobId: "j" });
    await renderDiscover("pro");
    await pickNiche("Coffee Shop");
    await pickNiche("Gym");
    fireEvent.click(screen.getByRole("button", { name: /^Email/ }));
    fireEvent.click(screen.getByRole("button", { name: /^Phone/ }));
    // Switch the selection from the default (United States) to Canada only.
    fireEvent.click(screen.getByRole("button", { name: /^Canada/ }));
    fireEvent.click(screen.getByRole("button", { name: /^United States/ }));

    const launch = screen.getByRole("button", { name: /Launch Discovery/ }) as HTMLButtonElement;
    await waitFor(() => expect(launch.disabled).toBe(false));
    fireEvent.click(launch);

    await waitFor(() => expect(h.mutateAsync).toHaveBeenCalledTimes(1));
    expect(h.mutateAsync.mock.calls[0][0]).toEqual({
      quantity: 10,
      region: "Canada",
      niche: "Coffee Shop, Gym",
      mode: "premium", // legacy/informational only
      method: "instant_pool_ranked", // real field: Pro's default (ceiling) method, unchanged
      channels: ["email", "phone"],
      currencies: [],
    });
  });

  it("several countries are sent together, in selection order", async () => {
    h.mutateAsync.mockResolvedValue({ leads: [], pending: false, generated: 0, jobId: "j" });
    await renderDiscover("starter");
    await pickNiche("Coffee Shop");
    fireEvent.click(screen.getByRole("button", { name: /^Email/ }));
    fireEvent.click(screen.getByRole("button", { name: /^United Kingdom/ }));
    const launch = screen.getByRole("button", { name: /Launch Discovery/ }) as HTMLButtonElement;
    await waitFor(() => expect(launch.disabled).toBe(false));
    fireEvent.click(launch);
    await waitFor(() => expect(h.mutateAsync).toHaveBeenCalledTimes(1));
    expect(h.mutateAsync.mock.calls[0][0].region).toBe("United States, United Kingdom");
    expect(h.mutateAsync.mock.calls[0][0].mode).toBe("pool");
  });

  it("upgrade strip advertises the NEXT real method, driven by plan", async () => {
    await renderDiscover("free");
    expect(screen.getByText(/pre-verified businesses, delivered instantly/i)).toBeTruthy();
    expect(screen.getByRole("link", { name: /Upgrade/ }).getAttribute("href")).toBe("/dashboard/subscription");
    cleanup();
    await renderDiscover("starter");
    expect(screen.getByText(/pro\+ · best-scoring opportunities first/i)).toBeTruthy();
    cleanup();
    await renderDiscover("pro");
    expect(screen.queryByRole("link", { name: /Upgrade/ })).toBeNull();
  });

  it("AI Overview leads with the top insight and reveals the rest on demand", async () => {
    await renderDiscover("pro");
    expect(screen.getByText("Run a discovery now")).toBeTruthy();
    expect(screen.queryByText("Second insight")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /1 more insight/ }));
    expect(screen.getByText("Second insight")).toBeTruthy();
  });
});
