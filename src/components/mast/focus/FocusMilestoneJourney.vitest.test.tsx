import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { FocusMilestoneJourney } from "./FocusMilestoneJourney";
import { FocusStack } from "./FocusSections";
import { MILESTONE_TIERS } from "@/lib/focus";

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, to: _to, hash: _hash, ...rest }: any) => <a {...rest}>{children}</a>,
}));

afterEach(() => {
  cleanup();
});

describe("FocusMilestoneJourney — peak popups & Next Tier Rewards", () => {
  it("replaces XP TO NEXT TIER with NEXT TIER REWARDS in the stats strip", () => {
    render(
      <FocusMilestoneJourney
        xp={700}
        currentName="Rainmaker"
        nextName="Operator"
        claimedTierIds={[]}
        onClaimReward={vi.fn()}
      />,
    );

    expect(screen.getByText("NEXT TIER REWARDS")).toBeTruthy();
    expect(screen.getByText("+400 Credits & +50 Daily Cap")).toBeTruthy();
    expect(screen.queryByText("XP TO NEXT TIER")).toBeNull();
    expect(screen.queryByText("TIER REWARDS")).toBeNull();
  });

  it("opens a popup when clicking a mountain tier peak and calls onClaimReward when Claim is clicked", () => {
    const onClaimReward = vi.fn();
    render(
      <FocusMilestoneJourney
        xp={700}
        currentName="Rainmaker"
        nextName="Operator"
        claimedTierIds={["explorer", "prospector"]}
        onClaimReward={onClaimReward}
      />,
    );

    // No popup open initially
    expect(screen.queryByRole("dialog")).toBeNull();

    // Press the Closer peak on the mountain
    fireEvent.click(screen.getByRole("button", { name: /Closer:/i }));
    expect(screen.getByRole("dialog", { name: "Closer reward" })).toBeTruthy();

    const claimBtn = screen.getByRole("button", { name: /Claim \+100 Credits & \+20 Daily Cap/i });
    fireEvent.click(claimBtn);
    expect(onClaimReward).toHaveBeenCalledTimes(1);
    expect(onClaimReward).toHaveBeenCalledWith("closer");
  });

  it("shows Claimed state for claimed peaks and XP needed for locked peaks", () => {
    render(
      <FocusMilestoneJourney
        xp={700}
        currentName="Rainmaker"
        nextName="Operator"
        claimedTierIds={["prospector"]}
        onClaimReward={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /Prospector:/i }));
    expect(screen.getByText("Claimed")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /Operator:/i }));
    expect(screen.getByText("100 XP to unlock")).toBeTruthy();
  });
});

describe("FocusStack — missed tier rewards", () => {
  it("renders missed tier rewards with a working Claim button even when other priorities are empty", () => {
    const onClaimReward = vi.fn();
    const missed = [MILESTONE_TIERS[0], MILESTONE_TIERS[1]];

    render(
      <FocusStack
        priorities={[]}
        missedRewards={missed}
        onClaimReward={onClaimReward}
      />,
    );

    expect(screen.getByText("You missed your Explorer reward")).toBeTruthy();
    expect(screen.getByText("You missed your Prospector reward")).toBeTruthy();

    const claimBtn = screen.getByRole("button", { name: /Claim Prospector reward/i });
    fireEvent.click(claimBtn);
    expect(onClaimReward).toHaveBeenCalledTimes(1);
    expect(onClaimReward).toHaveBeenCalledWith("prospector");
  });
});
