import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { FocusMilestoneJourney } from "./FocusMilestoneJourney";

afterEach(() => {
  cleanup();
});

describe("FocusMilestoneJourney — tier rewards", () => {
  it("highlights the first unlocked unclaimed tier and invokes onClaimReward on Claim click", () => {
    const onClaimReward = vi.fn();
    render(
      <FocusMilestoneJourney
        xp={120}
        currentName="Prospector"
        nextName="Closer"
        claimedTierIds={["explorer"]}
        onClaimReward={onClaimReward}
      />,
    );

    // Prospector (100 XP) is unlocked and unclaimed -> selected automatically
    expect(screen.getByText("Prospector Reward")).toBeTruthy();
    expect(screen.getByText("+50 Bonus Credits")).toBeTruthy();
    expect(screen.getByText("+10 Daily Lead Cap")).toBeTruthy();

    const claimBtn = screen.getByRole("button", { name: /Claim Reward/i });
    fireEvent.click(claimBtn);
    expect(onClaimReward).toHaveBeenCalledTimes(1);
    expect(onClaimReward).toHaveBeenCalledWith("prospector");
  });

  it("shows Claimed state for claimed tiers and XP lock state for future tiers", () => {
    render(
      <FocusMilestoneJourney
        xp={120}
        currentName="Prospector"
        nextName="Closer"
        claimedTierIds={["explorer", "prospector"]}
        onClaimReward={vi.fn()}
      />,
    );

    // Defaults to nextTier (Closer, 250 XP) when all unlocked tiers are claimed
    expect(screen.getByText("Closer Reward")).toBeTruthy();
    expect(screen.getByText("130 XP to unlock")).toBeTruthy();

    // Selecting Explorer via peak button shows Claimed state
    const explorerPeak = screen.getByRole("button", { name: /Explorer:/i });
    fireEvent.click(explorerPeak);
    expect(screen.getByText("Explorer Reward")).toBeTruthy();
    expect(screen.getByText("Claimed")).toBeTruthy();
  });

  it("shows peak reward tooltip on hover and expands all 7 tiers on toggle", () => {
    render(
      <FocusMilestoneJourney
        xp={120}
        currentName="Prospector"
        nextName="Closer"
        claimedTierIds={["explorer"]}
        onClaimReward={vi.fn()}
      />,
    );

    const closerPeak = screen.getByRole("button", { name: /Closer:/i });
    fireEvent.mouseEnter(closerPeak);
    expect(screen.getByText("+100 Credits & +20 Daily Cap")).toBeTruthy();
    expect(screen.getByText("130 XP needed to unlock")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /View all 7 tiers/i }));
    expect(screen.getByText("Revenue Architect")).toBeTruthy();
    expect(screen.getByText("Operator")).toBeTruthy();
  });
});
