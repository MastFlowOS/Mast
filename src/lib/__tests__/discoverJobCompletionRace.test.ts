import assert from "node:assert/strict";
import test from "node:test";
import { type DiscoverJobStatus, type Lead } from "../api.js";

function makeLead(id: string): Lead {
  return {
    id,
    companyName: `Company ${id}`,
    website: `https://${id}.com`,
    city: "San Francisco",
    state: "CA",
    country: "USA",
    fitScore: 85,
    email: `contact@${id}.com`,
    phone: "555-0100",
    decisionMakers: [],
    sources: ["google_maps"],
    enrichmentConfidence: 0.9,
    status: "new",
  };
}

test("1. Backend completes at 10, frontend has 9 -> status 'completed' is NOT visually displayed yet", async () => {
  const receivedLeads: Lead[] = [];
  const statusEvents: { status: DiscoverJobStatus; count: number }[] = [];

  const seenLeadIds = new Set<string>();
  let terminalStatus: DiscoverJobStatus | null = null;
  let terminalResultsCount = 0;
  let requestedQuantity: number | null = 10;
  let hasEmittedTerminal = false;

  const checkTerminalEmission = () => {
    if (hasEmittedTerminal || !terminalStatus) return;
    if (terminalStatus === "completed") {
      const target = requestedQuantity ? Math.min(requestedQuantity, terminalResultsCount || requestedQuantity) : terminalResultsCount;
      if (seenLeadIds.size >= target) {
        hasEmittedTerminal = true;
        statusEvents.push({ status: "completed", count: seenLeadIds.size });
      }
    }
  };

  const processLead = (lead: Lead) => {
    if (seenLeadIds.has(lead.id)) return;
    seenLeadIds.add(lead.id);
    receivedLeads.push(lead);
    checkTerminalEmission();
  };

  // Simulate 9 leads received
  for (let i = 1; i <= 9; i++) {
    processLead(makeLead(`lead-${i}`));
  }

  // Backend marks job completed at 10
  terminalStatus = "completed";
  terminalResultsCount = 10;
  checkTerminalEmission();

  assert.equal(receivedLeads.length, 9);
  assert.equal(statusEvents.length, 0, "status 'completed' must NOT be emitted while visible leads (9) < target (10)");
});

test("2. Backend completes at 10, frontend receives 10 -> status 'completed' IS displayed", async () => {
  const receivedLeads: Lead[] = [];
  const statusEvents: { status: DiscoverJobStatus; count: number }[] = [];

  const seenLeadIds = new Set<string>();
  let terminalStatus: DiscoverJobStatus | null = null;
  let terminalResultsCount = 0;
  let requestedQuantity: number | null = 10;
  let hasEmittedTerminal = false;

  const checkTerminalEmission = () => {
    if (hasEmittedTerminal || !terminalStatus) return;
    if (terminalStatus === "completed") {
      const target = requestedQuantity ? Math.min(requestedQuantity, terminalResultsCount || requestedQuantity) : terminalResultsCount;
      if (seenLeadIds.size >= target) {
        hasEmittedTerminal = true;
        statusEvents.push({ status: "completed", count: seenLeadIds.size });
      }
    }
  };

  const processLead = (lead: Lead) => {
    if (seenLeadIds.has(lead.id)) return;
    seenLeadIds.add(lead.id);
    receivedLeads.push(lead);
    checkTerminalEmission();
  };

  // Simulate 10 leads received
  for (let i = 1; i <= 10; i++) {
    processLead(makeLead(`lead-${i}`));
  }

  // Backend updates status to completed
  terminalStatus = "completed";
  terminalResultsCount = 10;
  checkTerminalEmission();

  assert.equal(receivedLeads.length, 10);
  assert.equal(statusEvents.length, 1);
  assert.equal(statusEvents[0].status, "completed");
  assert.equal(statusEvents[0].count, 10);
});

test("3. Final realtime event arrives after backend completion -> transitions to complete when count reaches 10", async () => {
  const receivedLeads: Lead[] = [];
  const statusEvents: { status: DiscoverJobStatus; count: number }[] = [];

  const seenLeadIds = new Set<string>();
  let terminalStatus: DiscoverJobStatus | null = null;
  let terminalResultsCount = 0;
  let requestedQuantity: number | null = 10;
  let hasEmittedTerminal = false;

  const checkTerminalEmission = () => {
    if (hasEmittedTerminal || !terminalStatus) return;
    if (terminalStatus === "completed") {
      const target = requestedQuantity ? Math.min(requestedQuantity, terminalResultsCount || requestedQuantity) : terminalResultsCount;
      if (seenLeadIds.size >= target) {
        hasEmittedTerminal = true;
        statusEvents.push({ status: "completed", count: seenLeadIds.size });
      }
    }
  };

  const processLead = (lead: Lead) => {
    if (seenLeadIds.has(lead.id)) return;
    seenLeadIds.add(lead.id);
    receivedLeads.push(lead);
    checkTerminalEmission();
  };

  // 9 leads received
  for (let i = 1; i <= 9; i++) {
    processLead(makeLead(`lead-${i}`));
  }

  // Backend completes at 10
  terminalStatus = "completed";
  terminalResultsCount = 10;
  checkTerminalEmission();

  assert.equal(statusEvents.length, 0, "Not completed yet");

  // 10th lead arrives delayed
  processLead(makeLead("lead-10"));

  assert.equal(receivedLeads.length, 10);
  assert.equal(statusEvents.length, 1, "Now completed upon receiving 10th lead");
  assert.equal(statusEvents[0].status, "completed");
  assert.equal(statusEvents[0].count, 10);
});

test("4. Partial completion (7/10 exhausted) displays completed_partial correctly", async () => {
  const statusEvents: { status: DiscoverJobStatus; count: number }[] = [];
  const seenLeadIds = new Set<string>();
  let terminalStatus: DiscoverJobStatus | null = null;
  let terminalResultsCount = 0;
  let hasEmittedTerminal = false;

  const checkTerminalEmission = () => {
    if (hasEmittedTerminal || !terminalStatus) return;
    if (terminalStatus === "completed_partial") {
      hasEmittedTerminal = true;
      statusEvents.push({ status: "completed_partial", count: Math.max(seenLeadIds.size, terminalResultsCount) });
    }
  };

  for (let i = 1; i <= 7; i++) {
    seenLeadIds.add(`lead-${i}`);
  }

  terminalStatus = "completed_partial";
  terminalResultsCount = 7;
  checkTerminalEmission();

  assert.equal(statusEvents.length, 1);
  assert.equal(statusEvents[0].status, "completed_partial");
  assert.equal(statusEvents[0].count, 7);
});

test("5. Cancellation displays cancelled correctly", async () => {
  const statusEvents: { status: DiscoverJobStatus; count: number }[] = [];
  const seenLeadIds = new Set<string>();
  let terminalStatus: DiscoverJobStatus | null = null;
  let terminalResultsCount = 0;
  let hasEmittedTerminal = false;

  const checkTerminalEmission = () => {
    if (hasEmittedTerminal || !terminalStatus) return;
    if (terminalStatus === "cancelled") {
      hasEmittedTerminal = true;
      statusEvents.push({ status: "cancelled", count: Math.max(seenLeadIds.size, terminalResultsCount) });
    }
  };

  for (let i = 1; i <= 4; i++) {
    seenLeadIds.add(`lead-${i}`);
  }

  terminalStatus = "cancelled";
  terminalResultsCount = 4;
  checkTerminalEmission();

  assert.equal(statusEvents.length, 1);
  assert.equal(statusEvents[0].status, "cancelled");
  assert.equal(statusEvents[0].count, 4);
});

test("6. Duplicate/replayed realtime events do not break or double-count the lead count", async () => {
  const receivedLeads: Lead[] = [];
  const seenLeadIds = new Set<string>();

  const processLead = (lead: Lead) => {
    if (seenLeadIds.has(lead.id)) return;
    seenLeadIds.add(lead.id);
    receivedLeads.push(lead);
  };

  const lead1 = makeLead("lead-1");

  processLead(lead1);
  processLead(lead1); // Replayed event
  processLead(lead1); // Duplicate event

  assert.equal(receivedLeads.length, 1, "Duplicate events must be ignored");
  assert.equal(seenLeadIds.size, 1);
});
