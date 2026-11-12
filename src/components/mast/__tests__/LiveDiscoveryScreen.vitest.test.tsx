import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, within } from "@testing-library/react";
import { LiveDiscoveryScreen } from "../LiveDiscoveryScreen";
import {
  createInitialLiveDiscoveryState,
  reduceLiveDiscoveryEvent,
} from "@/discovery/liveDiscoveryState";
import {
  scoutStartedEvent,
  candidateDiscoveredEvent,
  candidateRejectedEvent,
  leadDeliveredEvent,
  discoveryCompletedEvent,
} from "@/discovery/liveDiscoveryEvent";

afterEach(cleanup);

describe("LiveDiscoveryScreen — 3-Column Discovery Workspace", () => {
  it("starts with 0 active scouts before any worker slot is used, and renders the 3D map asset, compact right counters/Search Brief, and bottom Target Journey", () => {
    const state = createInitialLiveDiscoveryState(10);
    const onCancel = vi.fn();

    render(
      <LiveDiscoveryScreen
        state={state}
        onCancel={onCancel}
        isCancelling={false}
        searchBrief={{
          region: "Egypt",
          niche: "Coffee Shops",
          channels: ["email", "phone", "website", "instagram"],
          method: "live",
        }}
      />,
    );

    // 1. Left column: Scouts starts at 0 active and shows no fixed scout cards before scouts work
    const scoutsSection = screen.getByRole("region", { name: /scouts/i });
    expect(within(scoutsSection).getByText("Scouts")).toBeTruthy();
    expect(screen.getByTestId("scouts-active-badge").textContent).toBe("0 active");
    expect(screen.getByTestId("scouts-empty-state")).toBeTruthy();
    expect(within(scoutsSection).getByText("Waiting to start...")).toBeTruthy();
    expect(screen.queryByTestId("scout-card-1")).toBeNull();
    expect(screen.queryByTestId("scout-card-2")).toBeNull();
    expect(screen.queryByTestId("scout-card-3")).toBeNull();

    // 2. Center column: DISCOVERY eyebrow, "Scanning the web" heading, 3D isometric map PNG asset
    expect(screen.getByText("DISCOVERY")).toBeTruthy();
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Scanning the web");
    expect(
      screen.getByText("Our AI scouts are finding and collecting the best opportunities for you."),
    ).toBeTruthy();
    const mapContainer = screen.getByTestId("discovery-isometric-map");
    const mapImg = within(mapContainer).getByRole("img", {
      name: /3d isometric business location discovery map/i,
    });
    expect(mapImg.getAttribute("src")).toBe("/images/discover-isometric-map.png");

    // 3. Right column: Delivered and Rejected counters + Search Brief
    const deliveredCard = screen.getByTestId("discovery-delivered-card");
    expect(within(deliveredCard).getByText("0")).toBeTruthy();
    expect(within(deliveredCard).getByText("Delivered")).toBeTruthy();

    const rejectedCard = screen.getByTestId("discovery-rejected-card");
    expect(within(rejectedCard).getByText("0")).toBeTruthy();
    expect(within(rejectedCard).getByText("Rejected")).toBeTruthy();

    const brief = screen.getByTestId("discovery-search-brief");
    expect(within(brief).getByText("Search Brief")).toBeTruthy();
    expect(within(brief).getByText("Country")).toBeTruthy();
    expect(within(brief).getByText("Egypt")).toBeTruthy();
    expect(within(brief).getByText("Niche")).toBeTruthy();
    expect(within(brief).getByText("Coffee Shops")).toBeTruthy();
    expect(within(brief).getByText("Channels")).toBeTruthy();
    expect(within(brief).getByText("Discovery Method")).toBeTruthy();
    expect(within(brief).getByText("Live Discovery")).toBeTruthy();

    // 4. Bottom Target Journey underneath the central map
    const journey = screen.getByTestId("discovery-target-journey");
    expect(within(journey).getByText("Target")).toBeTruthy();
    expect(within(journey).getByText("10")).toBeTruthy();
    expect(within(journey).getByText(/Opportunities/)).toBeTruthy();
    expect(within(journey).getByText("0 / 10")).toBeTruthy();
    expect(screen.getByTestId("discovery-mast-raft")).toBeTruthy();

    // 5. Accessible cancellation functionality
    const cancelBtn = screen.getByRole("button", { name: /cancel search/i });
    fireEvent.click(cancelBtn);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("spawns Scout containers only as scouts are used, shows a single-line live feed per scout, and scales dynamically from 1 to 10 scouts", () => {
    const planId = "plan-test";
    let state = createInitialLiveDiscoveryState(10);
    const onCancel = vi.fn();

    const { rerender } = render(
      <LiveDiscoveryScreen state={state} onCancel={onCancel} isCancelling={false} />,
    );

    const raftBefore = screen.getByTestId("discovery-mast-raft").getAttribute("style") ?? "";

    // Only Scout 1 starts working -> only Scout (1) appears ("1 active")
    state = reduceLiveDiscoveryEvent(state, scoutStartedEvent(planId, 1, "Downtown Cairo"));
    rerender(<LiveDiscoveryScreen state={state} onCancel={onCancel} isCancelling={false} />);
    expect(screen.getByTestId("scouts-active-badge").textContent).toBe("1 active");
    expect(screen.getByTestId("scout-card-1")).toBeTruthy();
    expect(screen.queryByTestId("scout-card-2")).toBeNull();
    expect(
      within(screen.getByTestId("scout-feed-1")).getByText("Exploring Downtown Cairo..."),
    ).toBeTruthy();

    // Scout 1 updates its single-line live feed (replaces previous line in place)
    state = reduceLiveDiscoveryEvent(
      state,
      candidateDiscoveredEvent(planId, 1, "#1", "Nile Roasters", "Downtown Cairo"),
    );
    rerender(<LiveDiscoveryScreen state={state} onCancel={onCancel} isCancelling={false} />);
    expect(
      within(screen.getByTestId("scout-feed-1")).getByText("Checking Nile Roasters..."),
    ).toBeTruthy();
    expect(
      within(screen.getByTestId("scout-card-1")).queryByText("Exploring Downtown Cairo..."),
    ).toBeNull();

    // Scout 2 starts working + rejects a candidate while Scout 1 delivers a lead -> "2 active"
    state = reduceLiveDiscoveryEvent(
      state,
      candidateRejectedEvent(planId, 2, "#2", "duplicate_already_owned_by_user", "Zamalek"),
    );
    state = reduceLiveDiscoveryEvent(
      state,
      leadDeliveredEvent(planId, 1, "#1", "Nile Roasters", "Downtown Cairo"),
    );
    rerender(<LiveDiscoveryScreen state={state} onCancel={onCancel} isCancelling={false} />);

    expect(screen.getByTestId("scouts-active-badge").textContent).toBe("2 active");
    expect(screen.getByTestId("scout-card-1")).toBeTruthy();
    expect(screen.getByTestId("scout-card-2")).toBeTruthy();
    expect(screen.queryByTestId("scout-card-3")).toBeNull();

    // Scale up to 6 concurrent scouts (e.g. Scout 3..6 start working) -> "6 active"
    for (let id = 3; id <= 6; id += 1) {
      state = reduceLiveDiscoveryEvent(state, scoutStartedEvent(planId, id, `District ${id}`));
    }
    rerender(<LiveDiscoveryScreen state={state} onCancel={onCancel} isCancelling={false} />);
    expect(screen.getByTestId("scouts-active-badge").textContent).toBe("6 active");
    for (let id = 1; id <= 6; id += 1) {
      expect(screen.getByTestId(`scout-card-${id}`)).toBeTruthy();
    }

    expect(within(screen.getByTestId("discovery-delivered-card")).getByText("1")).toBeTruthy();
    expect(within(screen.getByTestId("discovery-rejected-card")).getByText("1")).toBeTruthy();
    expect(within(screen.getByTestId("discovery-target-journey")).getByText("1 / 10")).toBeTruthy();

    // Raft advances toward the island as progressPercent increases
    const raftAfter = screen.getByTestId("discovery-mast-raft").getAttribute("style") ?? "";
    expect(raftAfter).not.toBe(raftBefore);

    // Terminal state hides Cancel Search button and marks active scouts finished
    state = reduceLiveDiscoveryEvent(state, discoveryCompletedEvent(planId, 10, 10));
    rerender(<LiveDiscoveryScreen state={state} onCancel={onCancel} isCancelling={false} />);
    expect(screen.queryByRole("button", { name: /cancel search/i })).toBeNull();
    expect(screen.getByTestId("scouts-active-badge").textContent).toBe("Finished");
  });
});
