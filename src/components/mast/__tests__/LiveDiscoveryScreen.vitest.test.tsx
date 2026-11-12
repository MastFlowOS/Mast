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
  it("renders the three-column layout: Scouts container, Scanning the web + 3D map, Delivered/Rejected counters + Search Brief, and the bottom Target Journey", () => {
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

    // 1. Left column: Scouts container with individual Scout cards
    const scoutsSection = screen.getByRole("region", { name: /scouts/i });
    expect(within(scoutsSection).getByText("Scouts")).toBeTruthy();
    expect(within(scoutsSection).getByText("3 active")).toBeTruthy();
    expect(screen.getByTestId("scout-card-1")).toBeTruthy();
    expect(screen.getByTestId("scout-card-2")).toBeTruthy();
    expect(screen.getByTestId("scout-card-3")).toBeTruthy();
    expect(screen.getByTestId("scout-feed-1")).toBeTruthy();
    expect(screen.getByTestId("scout-feed-2")).toBeTruthy();
    expect(screen.getByTestId("scout-feed-3")).toBeTruthy();

    // 2. Center column: DISCOVERY eyebrow, "Scanning the web" heading, 3D isometric map
    expect(screen.getByText("DISCOVERY")).toBeTruthy();
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Scanning the web");
    expect(
      screen.getByText("Our AI scouts are finding and collecting the best opportunities for you."),
    ).toBeTruthy();
    expect(screen.getByTestId("discovery-isometric-map")).toBeTruthy();

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

  it("updates Scout live statuses, independent activity feeds, counters, and raft position in real time", () => {
    const planId = "plan-test";
    let state = createInitialLiveDiscoveryState(10);
    const onCancel = vi.fn();

    const { rerender } = render(
      <LiveDiscoveryScreen state={state} onCancel={onCancel} isCancelling={false} />,
    );

    const raftBefore = screen.getByTestId("discovery-mast-raft").getAttribute("style") ?? "";

    // Scout 1 starts exploring an area, then checks a business, then delivers a lead
    state = reduceLiveDiscoveryEvent(state, scoutStartedEvent(planId, 1, "Downtown Cairo"));
    rerender(<LiveDiscoveryScreen state={state} onCancel={onCancel} isCancelling={false} />);
    expect(within(screen.getByTestId("scout-card-1")).getByText("Exploring Downtown Cairo...")).toBeTruthy();

    state = reduceLiveDiscoveryEvent(
      state,
      candidateDiscoveredEvent(planId, 1, "#1", "Nile Roasters", "Downtown Cairo"),
    );
    rerender(<LiveDiscoveryScreen state={state} onCancel={onCancel} isCancelling={false} />);
    expect(within(screen.getByTestId("scout-card-1")).getByText("Checking Nile Roasters...")).toBeTruthy();
    // Scout 1's independent activity feed retains the earlier sentence
    expect(within(screen.getByTestId("scout-feed-1")).getByText("Exploring Downtown Cairo...")).toBeTruthy();

    // Scout 2 rejects a candidate while Scout 1 delivers a lead
    state = reduceLiveDiscoveryEvent(
      state,
      candidateRejectedEvent(planId, 2, "#2", "duplicate_already_owned_by_user", "Zamalek"),
    );
    state = reduceLiveDiscoveryEvent(
      state,
      leadDeliveredEvent(planId, 1, "#1", "Nile Roasters", "Downtown Cairo"),
    );
    rerender(<LiveDiscoveryScreen state={state} onCancel={onCancel} isCancelling={false} />);

    expect(within(screen.getByTestId("discovery-delivered-card")).getByText("1")).toBeTruthy();
    expect(within(screen.getByTestId("discovery-rejected-card")).getByText("1")).toBeTruthy();
    expect(within(screen.getByTestId("discovery-target-journey")).getByText("1 / 10")).toBeTruthy();

    // Raft advances toward the island as progressPercent increases
    const raftAfter = screen.getByTestId("discovery-mast-raft").getAttribute("style") ?? "";
    expect(raftAfter).not.toBe(raftBefore);

    // Terminal state hides Cancel Search button
    state = reduceLiveDiscoveryEvent(state, discoveryCompletedEvent(planId, 10, 10));
    rerender(<LiveDiscoveryScreen state={state} onCancel={onCancel} isCancelling={false} />);
    expect(screen.queryByRole("button", { name: /cancel search/i })).toBeNull();
  });
});
