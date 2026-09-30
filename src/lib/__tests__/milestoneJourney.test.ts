import assert from "node:assert/strict";
import test from "node:test";
import {
  getTimeOfDayPeriod,
  buildGreeting,
  MILESTONE_TIERS,
  type FocusContext,
} from "../focus.js";
import {
  cubicBezier,
  splitCubicBezier,
  MOUNTAIN_PEAKS,
  MOUNTAIN_SEGMENTS,
} from "../../components/mast/focus/FocusMilestoneJourney.js";

function makeContext(hour: number): FocusContext {
  const date = new Date(2026, 8, 28, hour, 30, 0);
  return {
    leads: [],
    followups: [],
    dailyDiscoverUsed: 0,
    dailyDiscoverLimit: 10,
    monthlyRemaining: 100,
    plan: "starter",
    xp: 100,
    goalsClaimedToday: 0,
    now: date,
  };
}

test("time-of-day boundaries partition 24 hours deterministically", () => {
  assert.equal(getTimeOfDayPeriod(new Date(2026, 8, 28, 2, 0)), "night");
  assert.equal(getTimeOfDayPeriod(new Date(2026, 8, 28, 6, 59)), "night");
  assert.equal(getTimeOfDayPeriod(new Date(2026, 8, 28, 7, 0)), "morning");
  assert.equal(getTimeOfDayPeriod(new Date(2026, 8, 28, 11, 30)), "morning");
  assert.equal(getTimeOfDayPeriod(new Date(2026, 8, 28, 13, 59)), "morning");
  assert.equal(getTimeOfDayPeriod(new Date(2026, 8, 28, 14, 0)), "afternoon");
  assert.equal(getTimeOfDayPeriod(new Date(2026, 8, 28, 17, 45)), "afternoon");
  assert.equal(getTimeOfDayPeriod(new Date(2026, 8, 28, 18, 59)), "afternoon");
  assert.equal(getTimeOfDayPeriod(new Date(2026, 8, 28, 19, 0)), "evening");
  assert.equal(getTimeOfDayPeriod(new Date(2026, 8, 28, 23, 59)), "evening");
});

test("greeting period and mountain environment time period always agree", () => {
  const hours = [3, 8, 15, 21];
  for (const h of hours) {
    const ctx = makeContext(h);
    const greeting = buildGreeting("Ibrahim", ctx);
    const mountainPeriod = getTimeOfDayPeriod(ctx.now);
    assert.equal(greeting.period, mountainPeriod);
  }
});

test("mountain peaks strictly satisfy Explorer < Prospector < Closer < Rainmaker height progression", () => {
  // In screen/SVG coordinates, a smaller Y coordinate means higher elevation
  const explorerY = MOUNTAIN_PEAKS[0].y;
  const prospectorY = MOUNTAIN_PEAKS[1].y;
  const closerY = MOUNTAIN_PEAKS[2].y;
  const rainmakerY = MOUNTAIN_PEAKS[3].y;

  assert.ok(explorerY > prospectorY, "Prospector sits higher than Explorer");
  assert.ok(prospectorY > closerY, "Closer sits higher than Prospector");
  assert.ok(closerY > rainmakerY, "Rainmaker sits higher than Closer");
});

test("cubic Bézier matches segment endpoints at t=0 and t=1", () => {
  for (const seg of MOUNTAIN_SEGMENTS) {
    const start = cubicBezier(seg.p0, seg.c0, seg.c1, seg.p1, 0);
    assert.equal(Math.round(start.x), seg.p0.x);
    assert.equal(Math.round(start.y), seg.p0.y);

    const end = cubicBezier(seg.p0, seg.c0, seg.c1, seg.p1, 1);
    assert.equal(Math.round(end.x), seg.p1.x);
    assert.equal(Math.round(end.y), seg.p1.y);
  }
});

test("XP interpolation moves the active progress position physically along the route", () => {
  // Segment 1 connects Prospector (100 XP) to Closer (250 XP)
  const seg1 = MOUNTAIN_SEGMENTS[1];

  // At 100 XP: active position begins at Prospector summit
  const at100 = cubicBezier(seg1.p0, seg1.c0, seg1.c1, seg1.p1, 0);
  assert.equal(Math.round(at100.x), 400);
  assert.equal(Math.round(at100.y), 168);

  // At 150 XP: (150 - 100) / (250 - 100) = 50 / 150 ≈ 0.333
  const t150 = 50 / 150;
  const at150 = cubicBezier(seg1.p0, seg1.c0, seg1.c1, seg1.p1, t150);
  assert.ok(at150.x > 400 && at150.x < 656, "Position moves horizontally towards Closer");
  assert.ok(at150.y > 168, "Path dips into the valley between Prospector and Closer");

  // At 200 XP: (200 - 100) / 150 ≈ 0.667
  const t200 = 100 / 150;
  const at200 = cubicBezier(seg1.p0, seg1.c0, seg1.c1, seg1.p1, t200);
  assert.ok(at200.x > at150.x, "Position progresses further towards Closer");
  assert.ok(at200.y < at150.y, "Position climbs out of valley towards Closer summit");

  // At 250 XP: reaches Closer summit
  const at250 = cubicBezier(seg1.p0, seg1.c0, seg1.c1, seg1.p1, 1);
  assert.equal(Math.round(at250.x), 656);
  assert.equal(Math.round(at250.y), 128);
});

test("de Casteljau curve splitting preserves continuity at the active split point", () => {
  const seg = MOUNTAIN_SEGMENTS[1];
  const t = 0.45;
  const { left, right } = splitCubicBezier(seg.p0, seg.c0, seg.c1, seg.p1, t);

  // Endpoint of left equals start point of right
  assert.equal(left[3].x, right[0].x);
  assert.equal(left[3].y, right[0].y);

  // Split point matches direct bezier evaluation
  const direct = cubicBezier(seg.p0, seg.c0, seg.c1, seg.p1, t);
  assert.ok(Math.abs(left[3].x - direct.x) < 0.001);
  assert.ok(Math.abs(left[3].y - direct.y) < 0.001);
});
