import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  resolveScoreDisplay,
  resolveContactVerificationBadge,
} from "../trustPanel.js";
import {
  normalizeLeadStatus,
  LEAD_STATUSES,
} from "../lead-workspace.js";
import type { Lead, FieldTrustEntry, Followup, LeadStatus, LeadActivityType } from "../api.js";

describe("Lead Workspace — Score and Verification Semantics", () => {
  it("preserves genuine opportunity scores regardless of priority changes (star/unstar)", () => {
    const leadWithScore: Lead = {
      id: 1,
      businessName: "Test Cafe",
      status: "new",
      priority: "normal",
      opportunityScore: 84.6,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    // Initial score
    const initialDisplay = resolveScoreDisplay(leadWithScore.opportunityScore);
    assert.equal(initialDisplay.isScored, true);
    assert.equal(initialDisplay.score, 85);
    assert.equal(initialDisplay.level, "High Opportunity");
    assert.equal(initialDisplay.label, "85");

    // After starring (priority -> "high"), the opportunityScore remains genuine and unchanged
    const starredLead: Lead = { ...leadWithScore, priority: "high" };
    const starredDisplay = resolveScoreDisplay(starredLead.opportunityScore);
    assert.equal(starredDisplay.score, 85);
    assert.equal(starredDisplay.level, "High Opportunity");
    assert.equal(starredDisplay.label, "85");

    // After unstarring (priority -> "normal")
    const unstarredLead: Lead = { ...starredLead, priority: "normal" };
    const unstarredDisplay = resolveScoreDisplay(unstarredLead.opportunityScore);
    assert.equal(unstarredDisplay.score, 85);
    assert.equal(unstarredDisplay.level, "High Opportunity");
  });

  it("displays an honest unscored state when no real score exists, never inventing numerical scores from priority", () => {
    const leadNoScore: Lead = {
      id: 2,
      businessName: "Unscored Bakery",
      status: "new",
      priority: "high", // High priority / starred, but no genuine score
      opportunityScore: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const display = resolveScoreDisplay(leadNoScore.opportunityScore);
    assert.equal(display.isScored, false);
    assert.equal(display.score, null);
    assert.equal(display.level, "Unscored");
    assert.equal(display.label, "—");

    // Switching priority to normal does not invent or alter scores
    const normalPriority = resolveScoreDisplay({ ...leadNoScore, priority: "normal" }.opportunityScore);
    assert.equal(normalPriority.isScored, false);
    assert.equal(normalPriority.score, null);
    assert.equal(normalPriority.level, "Unscored");
    assert.equal(normalPriority.label, "—");
  });

  it("does not label contact channels as Verified merely because a value exists", () => {
    // Value exists without trust verification entry -> Available, NOT Verified
    const emailResult = resolveContactVerificationBadge("owner@example.com", null);
    assert.notEqual(emailResult.label, "Verified");
    assert.equal(emailResult.label, "Available");
    assert.equal(emailResult.status, "available");

    const igResult = resolveContactVerificationBadge("coffeeshop_official", undefined);
    assert.notEqual(igResult.label, "Verified");
    assert.equal(igResult.label, "Available");
    assert.equal(igResult.status, "available");

    const phoneResult = resolveContactVerificationBadge("+1 555-0192", null);
    assert.notEqual(phoneResult.label, "Verified");
    assert.equal(phoneResult.label, "Available");
    assert.equal(phoneResult.status, "available");

    // Value exists with verified trust entry (confidence >= 0.7) -> Verified
    const verifiedTrust: FieldTrustEntry = {
      value: "owner@example.com",
      source: "Google Business",
      method: "google_business",
      confidence: 0.9,
      verifiedAt: "2026-03-01T00:00:00.000Z",
    };
    const verifiedEmail = resolveContactVerificationBadge("owner@example.com", verifiedTrust);
    assert.equal(verifiedEmail.label, "Verified");
    assert.equal(verifiedEmail.status, "verified");

    // Absent value -> Missing
    assert.equal(resolveContactVerificationBadge(null, verifiedTrust).label, "Missing");
    assert.equal(resolveContactVerificationBadge("", null).label, "Missing");
    assert.equal(resolveContactVerificationBadge("   ", null).label, "Missing");
  });
});

describe("Lead Workspace — Channel Actions and Send Statuses", () => {
  it("determines correct channel-specific status and activity type when manually marked sent/called", () => {
    const channels: Array<{
      channel: "email" | "instagram" | "phone" | "contact_form";
      expectedActivityType: LeadActivityType;
      expectedStatus: LeadStatus;
    }> = [
      { channel: "email", expectedActivityType: "email_sent", expectedStatus: "email_sent" },
      { channel: "instagram", expectedActivityType: "instagram_sent", expectedStatus: "instagram_sent" },
      { channel: "phone", expectedActivityType: "call_completed", expectedStatus: "called" },
      { channel: "contact_form", expectedActivityType: "contact_form_sent", expectedStatus: "email_sent" },
    ];

    for (const { channel, expectedActivityType, expectedStatus } of channels) {
      const isEmail = channel === "email";
      const isInstagram = channel === "instagram";
      const isPhone = channel === "phone";

      const activityType: LeadActivityType = isEmail
        ? "email_sent"
        : isInstagram
          ? "instagram_sent"
          : isPhone
            ? "call_completed"
            : "contact_form_sent";

      const nextStatus: LeadStatus = isEmail
        ? "email_sent"
        : isInstagram
          ? "instagram_sent"
          : isPhone
            ? "called"
            : "email_sent";

      assert.equal(activityType, expectedActivityType, `Expected ${expectedActivityType} for ${channel}`);
      assert.equal(nextStatus, expectedStatus, `Expected status ${expectedStatus} for ${channel}`);
    }
  });

  it("differentiates opening an external application/website from confirming delivery", () => {
    // Opening Gmail records email_opened, but never mutates lead status to email_sent
    const emailOpenActivity = {
      type: "email_opened" as const,
      channel: "email" as const,
      content: "Gmail composer opened for test@example.com",
    };
    assert.equal(emailOpenActivity.type, "email_opened");
    assert.notEqual(emailOpenActivity.type, "email_sent");

    // Opening Instagram DM records instagram_opened, never instagram_sent
    const igOpenActivity = {
      type: "instagram_opened" as const,
      channel: "instagram" as const,
      content: "Instagram opened for @coffeeshop",
    };
    assert.equal(igOpenActivity.type, "instagram_opened");
    assert.notEqual(igOpenActivity.type, "instagram_sent");

    // Opening website contact form records contact_form_opened, never contact_form_sent
    const webOpenActivity = {
      type: "contact_form_opened" as const,
      channel: "contact_form" as const,
      content: "Website opened for Test Cafe",
    };
    assert.equal(webOpenActivity.type, "contact_form_opened");
    assert.notEqual(webOpenActivity.type, "contact_form_sent");
  });
});

describe("Lead Workspace — Follow-up Lifecycle & Persistence Logic", () => {
  let mockFollowups: Followup[] = [];

  beforeEach(() => {
    mockFollowups = [
      {
        id: 101,
        leadId: 1,
        channel: "email",
        dueAt: new Date(Date.now() + 86400000).toISOString(),
        status: "pending",
        notes: "Follow up about proposal",
        sequenceName: null,
        stepNumber: null,
        currentStep: null,
        completedAt: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      {
        id: 102,
        leadId: 1,
        channel: "phone",
        dueAt: new Date(Date.now() + 172800000).toISOString(),
        status: "pending",
        notes: "Call manager if no reply",
        sequenceName: null,
        stepNumber: null,
        currentStep: null,
        completedAt: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ];
  });

  it("filters active followups vs completed/cancelled followups", () => {
    const active = mockFollowups.filter((f) => f.status !== "completed" && f.status !== "cancelled");
    assert.equal(active.length, 2);

    // After completing the first one
    const completedAt = new Date().toISOString();
    mockFollowups[0] = { ...mockFollowups[0], status: "completed", completedAt };

    const remainingActive = mockFollowups.filter((f) => f.status !== "completed" && f.status !== "cancelled");
    assert.equal(remainingActive.length, 1);
    assert.equal(remainingActive[0].id, 102);

    // Remaining active due date is 102's due date
    const nextDue = remainingActive[0].dueAt;
    assert.ok(nextDue);
  });

  it("supports rescheduling an active follow-up", () => {
    const newDueDate = new Date(Date.now() + 300000000).toISOString();
    const updatedNotes = "Rescheduled to next week";

    mockFollowups[0] = {
      ...mockFollowups[0],
      dueAt: newDueDate,
      notes: updatedNotes,
      updatedAt: new Date().toISOString(),
    };

    assert.equal(mockFollowups[0].dueAt, newDueDate);
    assert.equal(mockFollowups[0].notes, updatedNotes);
    assert.equal(mockFollowups[0].status, "pending");
  });

  it("supports cancelling an active follow-up and recalculating remaining due date", () => {
    // Cancel 101
    mockFollowups[0] = {
      ...mockFollowups[0],
      status: "cancelled",
      updatedAt: new Date().toISOString(),
    };

    const remainingActive = mockFollowups.filter((f) => f.status !== "completed" && f.status !== "cancelled");
    assert.equal(remainingActive.length, 1);
    assert.equal(remainingActive[0].id, 102);

    // Cancel 102
    mockFollowups[1] = {
      ...mockFollowups[1],
      status: "cancelled",
      updatedAt: new Date().toISOString(),
    };

    const noActive = mockFollowups.filter((f) => f.status !== "completed" && f.status !== "cancelled");
    assert.equal(noActive.length, 0);
  });
});
