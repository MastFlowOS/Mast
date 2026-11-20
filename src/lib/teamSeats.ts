import { getPlan, type PlanId } from "../config/plans.js";

export type WorkspaceRole = "owner" | "admin" | "member";

export interface SeatUsageSummary {
  plan: PlanId;
  seatLimit: number;
  isUnlimitedSeats: boolean;
  activeSeats: number;
  pendingInvites: number;
  /** Total reserved seats (owner + active members + pending invites). */
  seatsReserved: number;
  seatsRemaining: number;
  canInvite: boolean;
}

export function normalizeInviteEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function isValidInviteEmail(email: string): boolean {
  const normalized = normalizeInviteEmail(email);
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized) && normalized.length <= 320;
}

/**
 * Computes seat usage against the workspace owner's plan ceiling.
 * Owner always occupies 1 seat; each active teammate occupies 1 seat;
 * each pending invite reserves 1 seat so an owner cannot bypass a 3-seat cap
 * by issuing 20 concurrent pending invites.
 */
export function computeSeatUsage(params: {
  plan: string | null | undefined;
  activeMemberCount: number;
  pendingInviteCount: number;
}): SeatUsageSummary {
  const planCfg = getPlan(params.plan);
  const activeMembers = Math.max(0, Math.floor(params.activeMemberCount));
  const pendingInvites = Math.max(0, Math.floor(params.pendingInviteCount));
  const activeSeats = 1 + activeMembers;
  const seatsReserved = activeSeats + pendingInvites;
  const isUnlimitedSeats = planCfg.isUnlimitedSeats;
  const seatLimit = planCfg.teamSeats;
  const seatsRemaining = isUnlimitedSeats ? 999999 : Math.max(0, seatLimit - seatsReserved);

  return {
    plan: planCfg.id,
    seatLimit,
    isUnlimitedSeats,
    activeSeats,
    pendingInvites,
    seatsReserved,
    seatsRemaining,
    canInvite: isUnlimitedSeats || seatsReserved < seatLimit,
  };
}

/**
 * Checks whether accepting an existing pending invite can proceed under the
 * owner's active seat count (the pending invite itself already reserved a slot,
 * so acceptance checks `activeSeats < seatLimit`).
 */
export function canAcceptSeatInvite(params: {
  plan: string | null | undefined;
  activeMemberCount: number;
}): boolean {
  const planCfg = getPlan(params.plan);
  if (planCfg.isUnlimitedSeats) return true;
  const activeSeats = 1 + Math.max(0, Math.floor(params.activeMemberCount));
  return activeSeats < planCfg.teamSeats;
}
