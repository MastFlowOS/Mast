import { describe, it, expect } from "vitest";
import type { Lead } from "@/lib/api";
import {
  buildPipelineFlowModel,
  buildStageInsight,
  summarizeStageValue,
  STAGE_ORDER,
} from "./pipelineFlowModel";

const counts = (n: number, c: number, r: number, m: number, w: number) => ({
  new: n,
  contacted: c,
  replied: r,
  meeting: m,
  won: w,
});

describe("summarizeStageValue (real values only)", () => {
  it("is unavailable (null) when no opportunity has a value — never a default", () => {
    const s = summarizeStageValue([{ estimatedValue: null }, {}, { estimatedValue: undefined }]);
    expect(s).toEqual({ total: null, average: null, valuedCount: 0 });
  });

  it("is unavailable for an empty stage", () => {
    expect(summarizeStageValue([]).total).toBeNull();
  });

  it("sums and averages only the records that actually carry a value", () => {
    const s = summarizeStageValue([
      { estimatedValue: 1000 },
      { estimatedValue: 3000 },
      { estimatedValue: null },
      {},
    ]);
    expect(s.total).toBe(4000);
    expect(s.valuedCount).toBe(2);
    expect(s.average).toBe(2000);
  });

  it("treats a real 0 as a value, and ignores NaN / negatives", () => {
    expect(summarizeStageValue([{ estimatedValue: 0 }]).total).toBe(0);
    expect(summarizeStageValue([{ estimatedValue: Number.NaN }, { estimatedValue: -5 }]).total).toBeNull();
  });

  it("does not depend on stage or count (no multipliers)", () => {
    const one = summarizeStageValue([{ estimatedValue: null }]);
    const many = summarizeStageValue(Array.from({ length: 500 }, () => ({ estimatedValue: null })));
    expect(one.total).toBeNull();
    expect(many.total).toBeNull();
  });
});

describe("buildStageInsight (computed from the Flow model only)", () => {
  const model = buildPipelineFlowModel(counts(7, 3, 3, 1, 1), [] as Lead[]);

  it("uses the Flow node's own stage-to-next percentage and next stage name", () => {
    const contacted = model.nodes[1];
    const i = buildStageInsight(contacted, 2);
    expect(i.available).toBe(true);
    expect(i.text).toContain(`${contacted.toNextPct}%`);
    expect(i.text).toContain("Contacted");
    expect(i.text).toContain("Replied");
    expect(i.text).toContain("2 of 3 have had no update for 3+ days");
  });

  it("reports zero idle truthfully", () => {
    expect(buildStageInsight(model.nodes[2], 0).text).toContain("None have gone 3+ days without an update");
  });

  it("New and Closed make no idle claim (the model doesn't track it for them)", () => {
    expect(buildStageInsight(model.nodes[0], 0).text).not.toMatch(/update/);
    const closed = buildStageInsight(model.nodes[4], 0);
    expect(closed.text).toContain(`${model.nodes[4].toNextPct}% of your pipeline is closed`);
  });

  it("shows an honest unavailable state for an empty stage or empty pipeline", () => {
    const empty = buildPipelineFlowModel(counts(0, 0, 0, 0, 0), [] as Lead[]);
    for (const n of empty.nodes) expect(buildStageInsight(n, 0)).toEqual({ available: false, text: "Not enough activity yet." });
    const noReplies = buildPipelineFlowModel(counts(5, 2, 0, 0, 0), [] as Lead[]);
    expect(buildStageInsight(noReplies.nodes[2], 0).available).toBe(false);
  });

  it("contains none of the previously fabricated statistics", () => {
    const all = model.nodes.map((n) => buildStageInsight(n, 1).text).join(" ");
    for (const fake of ["bounce", "follow-up messages", "8.4 days", "video breakdown", "pre-meeting", "5.2 days", "coffee"]) expect(all).not.toContain(fake);
  });
});

describe("stage-to-next conversion is defined once (the Flow's node)", () => {
  it("New → Contacted = leads past New / all leads", () => {
    const m = buildPipelineFlowModel(counts(7, 3, 3, 1, 1), [] as Lead[]);
    expect(STAGE_ORDER).toHaveLength(5);
    expect(m.nodes.map((n) => n.toNextPct)).toEqual([53, 63, 40, 50, 7]);
    expect(m.nodes.map((n) => n.nextLabel)).toEqual(["Contacted", "Replied", "Meeting", "Closed", null]);
  });
});
