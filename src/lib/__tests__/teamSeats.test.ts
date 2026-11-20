import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { canAcceptSeatInvite, computeSeatUsage, isValidInviteEmail } from "../teamSeats.js";

describe("teamSeats", () => {
  it("enforces 1 seat on Free and Starter plans", () => {
    const free = computeSeatUsage({ plan: "free", activeMemberCount: 0, pendingInviteCount: 0 });
    assert.equal(free.seatLimit, 1);
    assert.equal(free.activeSeats, 1);
    assert.equal(free.canInvite, false);
    assert.equal(free.seatsRemaining, 0);

    const starter = computeSeatUsage({ plan: "starter", activeMemberCount: 0, pendingInviteCount: 0 });
    assert.equal(starter.seatLimit, 1);
    assert.equal(starter.canInvite, false);
  });

  it("enforces 3 seats on Pro and reserves pending invites against the cap", () => {
    const initial = computeSeatUsage({ plan: "pro", activeMemberCount: 0, pendingInviteCount: 0 });
    assert.equal(initial.seatLimit, 3);
    assert.equal(initial.seatsReserved, 1);
    assert.equal(initial.seatsRemaining, 2);
    assert.equal(initial.canInvite, true);

    const withTwoInvites = computeSeatUsage({ plan: "pro", activeMemberCount: 1, pendingInviteCount: 1 });
    assert.equal(withTwoInvites.seatsReserved, 3);
    assert.equal(withTwoInvites.seatsRemaining, 0);
    assert.equal(withTwoInvites.canInvite, false);

    assert.equal(canAcceptSeatInvite({ plan: "pro", activeMemberCount: 1 }), true);
    assert.equal(canAcceptSeatInvite({ plan: "pro", activeMemberCount: 2 }), false);
  });

  it("enforces a max of 7 seats on Premium", () => {
    const prem = computeSeatUsage({ plan: "premium", activeMemberCount: 4, pendingInviteCount: 1 });
    assert.equal(prem.seatLimit, 7);
    assert.equal(prem.isUnlimitedSeats, false);
    assert.equal(prem.seatsReserved, 6);
    assert.equal(prem.seatsRemaining, 1);
    assert.equal(prem.canInvite, true);

    const full = computeSeatUsage({ plan: "premium", activeMemberCount: 6, pendingInviteCount: 0 });
    assert.equal(full.seatsReserved, 7);
    assert.equal(full.canInvite, false);
    assert.equal(canAcceptSeatInvite({ plan: "premium", activeMemberCount: 5 }), true);
    assert.equal(canAcceptSeatInvite({ plan: "premium", activeMemberCount: 6 }), false);
  });

  it("validates invite emails", () => {
    assert.equal(isValidInviteEmail("rep@agency.com"), true);
    assert.equal(isValidInviteEmail("not-an-email"), false);
  });
});
