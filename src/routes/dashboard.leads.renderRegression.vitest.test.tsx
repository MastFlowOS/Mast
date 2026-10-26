import React from "react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";

/**
 * Regression tests for the "This page didn't load" Discover failure.
 *
 * Root cause: commit f3977eb used `useCallback` inside GetLeads (startup
 * watchdog) without importing it from "react". GetLeads threw
 * `ReferenceError: useCallback is not defined` on its very first render, and
 * the root route errorComponent rendered the generic full-page error.
 *
 * These tests mount the REAL route component under a probe error boundary, so
 * any render-time exception (missing import, bad hook usage, ...) fails here
 * with the real error instead of surfacing only in the browser. They also pin
 * that a failed API request degrades to a recoverable in-page error rather
 * than crashing the route.
 */

const h = vi.hoisted(() => ({
  overview: {
    data: undefined as unknown,
    isLoading: false,
    isFetching: false,
    error: null as unknown,
    refetch: vi.fn(),
  },
  refetch: vi.fn(),
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

vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() } }));
vi.mock("@/lib/notifications", () => ({ addNotification: vi.fn() }));

vi.mock("@/lib/api", () => ({
  ApiError: class ApiError extends Error {},
  subscribeToDiscoverJob: vi.fn(() => () => {}),
  cancelDiscoverJob: vi.fn(),
}));

vi.mock("@/hooks/use-live-discovery", () => ({ useLiveDiscoveryState: () => ({}) }));
vi.mock("@/components/mast/LiveDiscoveryScreen", () => ({ LiveDiscoveryScreen: () => null }));

vi.mock("@/hooks/use-mast-api", () => ({
  queryKeys: { account: ["a"], analytics: ["b"] },
  useAccount: () => ({
    data: {
      dailyUsage: { remaining: 280 },
      monthlyUsage: { remaining: 2780 },
      limits: { allowInstantPool: true, allowPremiumPool: true },
      subscription: { plan: "pro" },
    },
  }),
  useSettings: () => ({ data: { defaultRegions: "" } }),
  useAnalytics: () => ({ data: {} }),
  useLeads: () => ({ data: [] }),
  useGenerateLeads: () => ({ mutateAsync: vi.fn() }),
  useDiscoverOverview: () => h.overview,
}));

vi.mock("@/hooks/use-permissions", async () => {
  const { buildPermissionsManager } = await import("@/lib/permissions");
  return {
    usePermissions: () => ({ permissions: buildPermissionsManager("pro"), isLoading: false }),
  };
});

/** Stand-in for the root errorComponent: records whatever the route throws. */
class ProbeBoundary extends React.Component<
  { children: React.ReactNode },
  { error: Error | null }
> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  componentDidCatch() {
    /* the error is shown below so the test failure names the real exception */
  }
  render() {
    if (this.state.error) {
      return <div data-testid="route-crashed">{`${this.state.error.name}: ${this.state.error.message}`}</div>;
    }
    return this.props.children;
  }
}

async function renderDiscover() {
  const { Route } = await import("./dashboard.leads");
  const Page = (Route as unknown as { options: { component: React.ComponentType } }).options
    .component;
  return render(
    <ProbeBoundary>
      <Page />
    </ProbeBoundary>,
  );
}

beforeEach(() => {
  // React logs caught render errors; keep failing-test output readable.
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  h.overview = {
    data: undefined,
    isLoading: false,
    isFetching: false,
    error: null,
    refetch: h.refetch,
  };
  h.refetch.mockReset();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("Discover route — render-time crash regression", () => {
  it("mounts the Discover form without throwing (no ReferenceError / missing import)", async () => {
    await renderDiscover();
    // If the route threw (e.g. `useCallback is not defined`) the probe boundary
    // renders the real exception here instead of the form.
    expect(screen.queryByTestId("route-crashed")?.textContent ?? null).toBeNull();
    expect(screen.getByPlaceholderText(/search niches/i)).toBeTruthy();
  });
});

describe("Discover route — failed API request is recoverable, not a crash", () => {
  it("a failed AI overview request shows an in-page error with Retry and keeps the form usable", async () => {
    h.overview = {
      data: undefined,
      isLoading: false,
      isFetching: false,
      error: Object.assign(new Error("Service exploded"), { status: 500 }),
      refetch: h.refetch,
    };

    await renderDiscover();

    expect(screen.queryByTestId("route-crashed")?.textContent ?? null).toBeNull();
    // The error is surfaced to the user (not swallowed) ...
    expect(screen.getByText(/AI Overview: Service exploded/i)).toBeTruthy();
    expect(screen.getByText(/Rule-based Fallback/i)).toBeTruthy();
    // ... the rest of the page still works ...
    expect(screen.getByPlaceholderText(/search niches/i)).toBeTruthy();
    // ... and the user can retry the failed request.
    fireEvent.click(screen.getByRole("button", { name: /retry ai/i }));
    expect(h.refetch).toHaveBeenCalledTimes(1);
  });
});
