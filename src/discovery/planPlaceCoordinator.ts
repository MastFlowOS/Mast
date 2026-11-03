/**
 * src/discovery/planPlaceCoordinator.ts
 * =====================================
 *
 * MAST Phase 7.3 — In-Memory, Plan-Scoped Place ID Coordinator.
 *
 * Responsibilities:
 * 1. Coordinates Place ID ownership and leases across concurrent scouts within a discovery plan.
 * 2. Enforces strict claim lifecycle: PRE_CLICK -> CLICK_STARTED -> COMPLETED.
 * 3. Enforces monotonic lease expiration and fencing via performance.now().
 * 4. Fences uncompleted claims on lease expiration, preventing competing claims until confirmed process termination.
 * 5. Rejects voluntary release once CLICK_STARTED phase is entered.
 * 6. Idempotent completion for authorized scout and claim token (strictly requires CLICK_STARTED phase).
 * 7. Integrates Gate 1 strict Place ID validator (validateCoordinationPlaceId) for canonicalization and failure closure.
 * 8. Validates all lease durations against explicit minimum and maximum bounds.
 */

import { randomUUID } from "node:crypto";
import {
  validateCoordinationPlaceId,
  type CoordinationPlaceIdResult,
} from "../lib/placeId.js";

export type ClaimPhase = "PRE_CLICK" | "CLICK_STARTED";

export const MIN_LEASE_DURATION_MS = 1_000;         // 1 second minimum
export const MAX_LEASE_DURATION_MS = 300_000;       // 5 minutes maximum
export const DEFAULT_LEASE_DURATION_MS = 30_000;    // 30 seconds default

/**
 * Validates a lease duration or extension in milliseconds.
 * Rejects non-finite, NaN, zero, negative, and excessively large durations.
 */
export function validateLeaseDuration(
  ms: unknown,
  fieldName: string
): { valid: true; durationMs: number } | { valid: false; reason: string } {
  if (typeof ms !== "number" || !Number.isFinite(ms) || Number.isNaN(ms)) {
    return { valid: false, reason: `${fieldName} must be a finite number` };
  }
  if (ms < MIN_LEASE_DURATION_MS || ms > MAX_LEASE_DURATION_MS) {
    return {
      valid: false,
      reason: `${fieldName} must be between ${MIN_LEASE_DURATION_MS}ms and ${MAX_LEASE_DURATION_MS}ms (received ${ms}ms)`,
    };
  }
  return { valid: true, durationMs: ms };
}

export interface TimeProvider {
  now(): number;
  setTimeout(callback: () => void, ms: number): any;
  clearTimeout(handle: any): void;
}

export const defaultTimeProvider: TimeProvider = {
  now: () => performance.now(),
  setTimeout: (cb, ms) => setTimeout(cb, ms),
  clearTimeout: (handle) => clearTimeout(handle),
};

export interface ReadonlyClaim {
  readonly canonicalPlaceId: string;
  readonly scoutId: string;
  readonly requestId: string;
  readonly claimToken: string;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly phase: ClaimPhase;
  readonly fenced: boolean;
  readonly completed: boolean;
  readonly hasNotifiedExpiry: boolean;
}

interface InternalClaim {
  readonly canonicalPlaceId: string;
  readonly scoutId: string;
  readonly requestId: string;
  readonly claimToken: string;
  readonly createdAt: number;
  expiresAt: number;
  phase: ClaimPhase;
  fenced: boolean;
  completed: boolean;
  hasNotifiedExpiry: boolean;
  timerHandle: any | null;
  leaseGeneration: number;
}

export interface PlanPlaceCoordinatorOptions {
  readonly planId: string;
  readonly initialKnownPlaceIds?: Iterable<unknown>;
  readonly defaultLeaseDurationMs?: number;
  readonly timeProvider?: TimeProvider;
  readonly onClaimExpired?: (claim: ReadonlyClaim) => void;
}

export type TryClaimResult =
  | {
      valid: true;
      success: true;
      status: "CLAIM_ACQUIRED";
      canonicalPlaceId: string;
      claimToken: string;
      expiresAt: number;
      claim: ReadonlyClaim;
    }
  | {
      valid: false;
      success: false;
      status:
        | "ALREADY_KNOWN"
        | "ALREADY_CLAIMED"
        | "ALREADY_CLAIMED_BY_SELF"
        | "ALREADY_COMPLETED"
        | "FENCED"
        | "MISSING_PLACE_ID"
        | "MALFORMED_PLACE_ID"
        | "INVALID_LEASE_DURATION";
      canonicalPlaceId?: string;
      owningScoutId?: string;
      reason: string;
    };

export type RenewClaimResult =
  | {
      success: true;
      status: "RENEWED";
      canonicalPlaceId: string;
      newExpiresAt: number;
      claim: ReadonlyClaim;
    }
  | {
      success: false;
      status:
        | "CLAIM_NOT_FOUND"
        | "WRONG_SCOUT"
        | "WRONG_REQUEST"
        | "CLAIM_FENCED"
        | "CLAIM_ALREADY_COMPLETED"
        | "INVALID_LEASE_DURATION";
      reason: string;
    };

export type ClickStartedResult =
  | {
      success: true;
      status: "CLICK_STARTED";
      canonicalPlaceId: string;
      claim: ReadonlyClaim;
    }
  | {
      success: false;
      status:
        | "CLAIM_NOT_FOUND"
        | "WRONG_SCOUT"
        | "WRONG_REQUEST"
        | "CLAIM_FENCED"
        | "CLAIM_ALREADY_COMPLETED";
      reason: string;
    };

export type ValidateActiveClaimResult =
  | {
      valid: true;
      status: "VALID";
      claim: ReadonlyClaim;
    }
  | {
      valid: false;
      status:
        | "CLAIM_NOT_FOUND"
        | "WRONG_SCOUT"
        | "WRONG_REQUEST"
        | "PLACE_ID_MISMATCH"
        | "CLAIM_FENCED"
        | "CLAIM_ALREADY_COMPLETED";
      reason: string;
    };

export type ReleaseClaimResult =
  | {
      success: true;
      status: "RELEASED";
      canonicalPlaceId: string;
    }
  | {
      success: false;
      status:
        | "CLAIM_NOT_FOUND"
        | "WRONG_SCOUT"
        | "WRONG_REQUEST"
        | "CLAIM_FENCED"
        | "CLAIM_ALREADY_COMPLETED"
        | "CANNOT_RELEASE_CLICK_STARTED";
      reason: string;
    };

export type CompleteClaimResult =
  | {
      success: true;
      status: "COMPLETED" | "ALREADY_COMPLETED";
      canonicalPlaceId: string;
      claim: ReadonlyClaim;
    }
  | {
      success: false;
      status:
        | "CLAIM_NOT_FOUND"
        | "WRONG_SCOUT"
        | "WRONG_REQUEST"
        | "CLAIM_FENCED"
        | "CLICK_NOT_STARTED";
      reason: string;
    };

export interface ReleaseAllScoutClaimsResult {
  readonly success: true;
  readonly scoutId: string;
  readonly releasedCount: number;
  readonly releasedPlaceIds: string[];
  readonly reason: string;
}

export class PlanPlaceCoordinator {
  public readonly planId: string;
  private readonly defaultLeaseDurationMs: number;
  private readonly timeProvider: TimeProvider;
  private readonly onClaimExpired?: (claim: ReadonlyClaim) => void;

  private readonly knownPlaceIds = new Set<string>();
  private readonly completedPlaceIds = new Set<string>();
  private readonly claimsByPlaceId = new Map<string, InternalClaim>();
  private readonly claimsByToken = new Map<string, InternalClaim>();

  constructor(options: PlanPlaceCoordinatorOptions) {
    if (!options.planId || typeof options.planId !== "string" || options.planId.trim().length === 0) {
      throw new Error("PlanPlaceCoordinator requires a valid non-empty planId");
    }
    this.planId = options.planId.trim();

    if (options.defaultLeaseDurationMs !== undefined) {
      const durationCheck = validateLeaseDuration(options.defaultLeaseDurationMs, "defaultLeaseDurationMs");
      if (!durationCheck.valid) {
        throw new Error(`PlanPlaceCoordinator initialization failed: ${durationCheck.reason}`);
      }
      this.defaultLeaseDurationMs = durationCheck.durationMs;
    } else {
      this.defaultLeaseDurationMs = DEFAULT_LEASE_DURATION_MS;
    }

    this.timeProvider = options.timeProvider ?? defaultTimeProvider;
    this.onClaimExpired = options.onClaimExpired;

    if (options.initialKnownPlaceIds) {
      for (const raw of options.initialKnownPlaceIds) {
        const res = validateCoordinationPlaceId(raw);
        if (res.status === "MALFORMED") {
          throw new Error(
            `PlanPlaceCoordinator initialization failed: malformed initial known Place ID "${String(raw)}": ${res.reason}`
          );
        }
        if (res.status === "VALID") {
          this.knownPlaceIds.add(res.canonicalId);
        }
        // MISSING values are ignored gracefully; they do not become known Place IDs.
      }
    }
  }

  /**
   * Attempts to claim a Place ID for a scout.
   * Synchronously checks expiration of any existing claim before deciding.
   * Validates custom lease duration if provided.
   */
  public tryClaim(
    scoutId: string,
    requestId: string,
    rawPlaceId: unknown,
    leaseDurationMs?: number
  ): TryClaimResult {
    if (!scoutId || typeof scoutId !== "string" || scoutId.trim().length === 0) {
      return {
        valid: false,
        success: false,
        status: "MALFORMED_PLACE_ID",
        reason: "Invalid scoutId provided to tryClaim",
      };
    }
    if (!requestId || typeof requestId !== "string" || requestId.trim().length === 0) {
      return {
        valid: false,
        success: false,
        status: "MALFORMED_PLACE_ID",
        reason: "Invalid requestId provided to tryClaim",
      };
    }

    let duration = this.defaultLeaseDurationMs;
    if (leaseDurationMs !== undefined) {
      const durationCheck = validateLeaseDuration(leaseDurationMs, "leaseDurationMs");
      if (!durationCheck.valid) {
        return {
          valid: false,
          success: false,
          status: "INVALID_LEASE_DURATION",
          reason: durationCheck.reason,
        };
      }
      duration = durationCheck.durationMs;
    }

    const validation: CoordinationPlaceIdResult = validateCoordinationPlaceId(rawPlaceId);
    if (validation.status === "MISSING") {
      return {
        valid: false,
        success: false,
        status: "MISSING_PLACE_ID",
        reason: "Candidate has missing Place ID; cannot acquire Place ID coordinator claim",
      };
    }
    if (validation.status === "MALFORMED") {
      return {
        valid: false,
        success: false,
        status: "MALFORMED_PLACE_ID",
        reason: validation.reason,
      };
    }

    const canonicalPlaceId = validation.canonicalId;

    // Check if initial known Place ID in plan
    if (this.knownPlaceIds.has(canonicalPlaceId)) {
      return {
        valid: false,
        success: false,
        status: "ALREADY_KNOWN",
        canonicalPlaceId,
        reason: "Place ID is already known in discovery plan",
      };
    }

    // Check existing claims
    const existing = this.claimsByPlaceId.get(canonicalPlaceId);
    if (existing) {
      this.checkAndApplyExpiration(existing);

      if (existing.completed) {
        return {
          valid: false,
          success: false,
          status: "ALREADY_COMPLETED",
          canonicalPlaceId,
          owningScoutId: existing.scoutId,
          reason: `Place ID already completed by scout ${existing.scoutId}`,
        };
      }

      if (existing.fenced) {
        return {
          valid: false,
          success: false,
          status: "FENCED",
          canonicalPlaceId,
          owningScoutId: existing.scoutId,
          reason: `Place ID is fenced under scout ${existing.scoutId} and cannot be claimed until process termination`,
        };
      }

      if (existing.scoutId === scoutId) {
        return {
          valid: false,
          success: false,
          status: "ALREADY_CLAIMED_BY_SELF",
          canonicalPlaceId,
          owningScoutId: scoutId,
          reason: "Scout already holds active claim for this Place ID",
        };
      }

      return {
        valid: false,
        success: false,
        status: "ALREADY_CLAIMED",
        canonicalPlaceId,
        owningScoutId: existing.scoutId,
        reason: `Place ID already claimed by competing scout ${existing.scoutId}`,
      };
    }

    // Place ID is free. Create new PRE_CLICK claim.
    const now = this.timeProvider.now();
    const expiresAt = now + duration;
    const claimToken = randomUUID();

    const claim: InternalClaim = {
      canonicalPlaceId,
      scoutId,
      requestId,
      claimToken,
      createdAt: now,
      expiresAt,
      phase: "PRE_CLICK",
      fenced: false,
      completed: false,
      hasNotifiedExpiry: false,
      timerHandle: null,
      leaseGeneration: 1,
    };

    this.scheduleClaimTimer(claim);
    this.claimsByPlaceId.set(canonicalPlaceId, claim);
    this.claimsByToken.set(claimToken, claim);

    return {
      valid: true,
      success: true,
      status: "CLAIM_ACQUIRED",
      canonicalPlaceId,
      claimToken,
      expiresAt,
      claim: this.snapshotClaim(claim),
    };
  }

  /**
   * Renews an active claim before expiration.
   * Synchronously rejects expired/fenced claims and validates extension duration.
   */
  public renewClaim(
    scoutId: string,
    requestId: string,
    claimToken: string,
    extensionMs?: number
  ): RenewClaimResult {
    const claim = this.claimsByToken.get(claimToken);
    if (!claim) {
      return { success: false, status: "CLAIM_NOT_FOUND", reason: "Claim token not found" };
    }

    this.checkAndApplyExpiration(claim);

    if (claim.scoutId !== scoutId) {
      return { success: false, status: "WRONG_SCOUT", reason: "Claim is owned by a different scout" };
    }
    if (claim.requestId !== requestId) {
      return { success: false, status: "WRONG_REQUEST", reason: "Request ID mismatch on renewal" };
    }
    if (claim.completed) {
      return { success: false, status: "CLAIM_ALREADY_COMPLETED", reason: "Claim is already completed" };
    }
    if (claim.fenced) {
      return { success: false, status: "CLAIM_FENCED", reason: "Cannot renew an expired or fenced claim" };
    }

    let duration = this.defaultLeaseDurationMs;
    if (extensionMs !== undefined) {
      const durationCheck = validateLeaseDuration(extensionMs, "extensionMs");
      if (!durationCheck.valid) {
        return {
          success: false,
          status: "INVALID_LEASE_DURATION",
          reason: durationCheck.reason,
        };
      }
      duration = durationCheck.durationMs;
    }

    const now = this.timeProvider.now();
    claim.expiresAt = now + duration;
    claim.leaseGeneration++;

    this.clearClaimTimer(claim);
    this.scheduleClaimTimer(claim);

    return {
      success: true,
      status: "RENEWED",
      canonicalPlaceId: claim.canonicalPlaceId,
      newExpiresAt: claim.expiresAt,
      claim: this.snapshotClaim(claim),
    };
  }

  /**
   * Notifies the coordinator that card click/navigation has started.
   * Transitions phase from PRE_CLICK to CLICK_STARTED.
   */
  public notifyClickStarted(
    scoutId: string,
    requestId: string,
    claimToken: string
  ): ClickStartedResult {
    const claim = this.claimsByToken.get(claimToken);
    if (!claim) {
      return { success: false, status: "CLAIM_NOT_FOUND", reason: "Claim token not found" };
    }

    this.checkAndApplyExpiration(claim);

    if (claim.scoutId !== scoutId) {
      return { success: false, status: "WRONG_SCOUT", reason: "Claim is owned by a different scout" };
    }
    if (claim.requestId !== requestId) {
      return { success: false, status: "WRONG_REQUEST", reason: "Request ID mismatch" };
    }
    if (claim.completed) {
      return { success: false, status: "CLAIM_ALREADY_COMPLETED", reason: "Claim is already completed" };
    }
    if (claim.fenced) {
      return { success: false, status: "CLAIM_FENCED", reason: "Cannot transition an expired or fenced claim" };
    }

    claim.phase = "CLICK_STARTED";

    return {
      success: true,
      status: "CLICK_STARTED",
      canonicalPlaceId: claim.canonicalPlaceId,
      claim: this.snapshotClaim(claim),
    };
  }

  /**
   * Validates that a claim is active, valid, and owned by the specified scout and request.
   */
  public validateActiveClaim(
    scoutId: string,
    requestId: string,
    claimToken: string,
    canonicalPlaceId?: string
  ): ValidateActiveClaimResult {
    const claim = this.claimsByToken.get(claimToken);
    if (!claim) {
      return { valid: false, status: "CLAIM_NOT_FOUND", reason: "Claim token not found" };
    }

    this.checkAndApplyExpiration(claim);

    if (claim.scoutId !== scoutId) {
      return { valid: false, status: "WRONG_SCOUT", reason: "Claim owned by different scout" };
    }
    if (claim.requestId !== requestId) {
      return { valid: false, status: "WRONG_REQUEST", reason: "Request ID mismatch" };
    }
    if (canonicalPlaceId && claim.canonicalPlaceId !== canonicalPlaceId) {
      return { valid: false, status: "PLACE_ID_MISMATCH", reason: "Canonical Place ID mismatch" };
    }
    if (claim.completed) {
      return { valid: false, status: "CLAIM_ALREADY_COMPLETED", reason: "Claim has already been completed" };
    }
    if (claim.fenced) {
      return { valid: false, status: "CLAIM_FENCED", reason: "Claim is expired or fenced" };
    }

    return {
      valid: true,
      status: "VALID",
      claim: this.snapshotClaim(claim),
    };
  }

  /**
   * Voluntarily releases a claim by the owning scout.
   * Permitted ONLY in PRE_CLICK phase. Rejected in CLICK_STARTED phase.
   */
  public releaseClaim(
    scoutId: string,
    requestId: string,
    claimToken: string
  ): ReleaseClaimResult {
    const claim = this.claimsByToken.get(claimToken);
    if (!claim) {
      return { success: false, status: "CLAIM_NOT_FOUND", reason: "Claim token not found" };
    }

    this.checkAndApplyExpiration(claim);

    if (claim.scoutId !== scoutId) {
      return { success: false, status: "WRONG_SCOUT", reason: "Claim owned by different scout" };
    }
    if (claim.requestId !== requestId) {
      return { success: false, status: "WRONG_REQUEST", reason: "Request ID mismatch" };
    }
    if (claim.completed) {
      return { success: false, status: "CLAIM_ALREADY_COMPLETED", reason: "Completed claim cannot be released" };
    }
    if (claim.fenced) {
      return { success: false, status: "CLAIM_FENCED", reason: "Fenced or expired claim cannot be voluntarily released" };
    }
    if (claim.phase === "CLICK_STARTED") {
      return {
        success: false,
        status: "CANNOT_RELEASE_CLICK_STARTED",
        reason: "Claim in CLICK_STARTED phase cannot be voluntarily released; requires verified process termination",
      };
    }

    // PRE_CLICK clean voluntary release
    this.clearClaimTimer(claim);
    this.claimsByPlaceId.delete(claim.canonicalPlaceId);
    this.claimsByToken.delete(claimToken);

    return {
      success: true,
      status: "RELEASED",
      canonicalPlaceId: claim.canonicalPlaceId,
    };
  }

  /**
   * Completes a claim upon successful candidate extraction and delivery.
   * STRICT LIFECYCLE ENFORCEMENT:
   * 1. Requires claim to have entered CLICK_STARTED phase (rejects PRE_CLICK with CLICK_NOT_STARTED).
   * 2. Idempotent for authorized scout and token if already completed.
   * 3. Rejects expired or fenced claims.
   */
  public completeClaim(
    scoutId: string,
    requestId: string,
    claimToken: string
  ): CompleteClaimResult {
    const claim = this.claimsByToken.get(claimToken);
    if (!claim) {
      return { success: false, status: "CLAIM_NOT_FOUND", reason: "Claim token not found" };
    }

    this.checkAndApplyExpiration(claim);

    if (claim.scoutId !== scoutId) {
      return { success: false, status: "WRONG_SCOUT", reason: "Claim owned by different scout" };
    }
    if (claim.requestId !== requestId) {
      return { success: false, status: "WRONG_REQUEST", reason: "Request ID mismatch" };
    }
    if (claim.fenced) {
      return { success: false, status: "CLAIM_FENCED", reason: "Cannot complete an expired or fenced claim" };
    }

    if (claim.completed) {
      return {
        success: true,
        status: "ALREADY_COMPLETED",
        canonicalPlaceId: claim.canonicalPlaceId,
        claim: this.snapshotClaim(claim),
      };
    }

    if (claim.phase !== "CLICK_STARTED") {
      return {
        success: false,
        status: "CLICK_NOT_STARTED",
        reason: `Cannot complete claim in ${claim.phase} phase; card click must be started first`,
      };
    }

    this.clearClaimTimer(claim);
    claim.completed = true;
    this.completedPlaceIds.add(claim.canonicalPlaceId);

    return {
      success: true,
      status: "COMPLETED",
      canonicalPlaceId: claim.canonicalPlaceId,
      claim: this.snapshotClaim(claim),
    };
  }

  /**
   * Privileged administrative operation: Releases all uncompleted/fenced claims owned by a scout
   * strictly after verified OS process-tree termination.
   *
   * IMPORTANT CONTRACT FOR CALLERS:
   * 1. This method is strictly reserved for the Gate 4 OS Process Manager.
   * 2. The caller MUST establish and verify that zero processes remain alive in the scout's
   *    process tree (e.g. via Windows Job Object active process count or POSIX killpg(pgid, 0) probing)
   *    BEFORE calling this method.
   * 3. This coordinator does NOT have OS process visibility and CANNOT verify termination itself;
   *    the `reason` parameter is strictly an audit trail annotation, NOT proof of termination.
   * 4. Does NOT release completed claims, preserving permanent deduplication for delivered candidates.
   */
  public releaseAllForScout(scoutId: string, reason: string): ReleaseAllScoutClaimsResult {
    if (!scoutId || typeof scoutId !== "string" || scoutId.trim().length === 0) {
      throw new Error("releaseAllForScout requires a valid non-empty scoutId");
    }
    if (!reason || typeof reason !== "string" || reason.trim().length === 0) {
      throw new Error("releaseAllForScout requires a valid non-empty reason string for audit logging");
    }

    const releasedPlaceIds: string[] = [];

    for (const [canonicalId, claim] of Array.from(this.claimsByPlaceId.entries())) {
      if (claim.scoutId === scoutId) {
        if (!claim.completed) {
          this.clearClaimTimer(claim);
          this.claimsByPlaceId.delete(canonicalId);
          this.claimsByToken.delete(claim.claimToken);
          releasedPlaceIds.push(canonicalId);
        }
      }
    }

    return {
      success: true,
      scoutId,
      releasedCount: releasedPlaceIds.length,
      releasedPlaceIds,
      reason,
    };
  }

  // --- Inspection / Diagnostics ---

  /**
   * Returns the count of claims that are currently active (uncompleted and unfenced).
   */
  public getActiveClaimsCount(): number {
    let count = 0;
    for (const claim of this.claimsByPlaceId.values()) {
      this.checkAndApplyExpiration(claim);
      if (!claim.completed && !claim.fenced) {
        count++;
      }
    }
    return count;
  }

  /**
   * Returns the count of claims that are currently expired and fenced.
   */
  public getFencedClaimsCount(): number {
    let count = 0;
    for (const claim of this.claimsByPlaceId.values()) {
      this.checkAndApplyExpiration(claim);
      if (claim.fenced && !claim.completed) {
        count++;
      }
    }
    return count;
  }

  /**
   * Returns the count of initial known Place IDs loaded into this discovery plan.
   */
  public getKnownPlaceIdsCount(): number {
    return this.knownPlaceIds.size;
  }

  /**
   * Returns the count of claims that have been successfully completed in this discovery plan.
   */
  public getCompletedPlaceIdsCount(): number {
    return this.completedPlaceIds.size;
  }

  /**
   * Returns the total count of all claims currently tracked in coordinator state (active, fenced, and completed).
   */
  public getTotalTrackedClaimsCount(): number {
    return this.claimsByPlaceId.size;
  }

  public getClaimByPlaceId(canonicalPlaceId: string): ReadonlyClaim | undefined {
    const claim = this.claimsByPlaceId.get(canonicalPlaceId);
    if (!claim) return undefined;
    this.checkAndApplyExpiration(claim);
    return this.snapshotClaim(claim);
  }

  public getClaimByToken(claimToken: string): ReadonlyClaim | undefined {
    const claim = this.claimsByToken.get(claimToken);
    if (!claim) return undefined;
    this.checkAndApplyExpiration(claim);
    return this.snapshotClaim(claim);
  }

  public destroy(): void {
    for (const claim of this.claimsByPlaceId.values()) {
      this.clearClaimTimer(claim);
    }
    this.claimsByPlaceId.clear();
    this.claimsByToken.clear();
  }

  // --- Private Helpers ---

  private checkAndApplyExpiration(claim: InternalClaim): void {
    if (claim.completed) return;
    if (!claim.fenced && this.timeProvider.now() >= claim.expiresAt) {
      claim.fenced = true;
      this.maybeNotifyExpiry(claim);
    }
  }

  private maybeNotifyExpiry(claim: InternalClaim): void {
    if (!claim.hasNotifiedExpiry) {
      claim.hasNotifiedExpiry = true;
      if (this.onClaimExpired) {
        try {
          this.onClaimExpired(this.snapshotClaim(claim));
        } catch {
          // Coordinator must never crash from listener exceptions
        }
      }
    }
  }

  private scheduleClaimTimer(claim: InternalClaim): void {
    const remainingMs = Math.max(0, claim.expiresAt - this.timeProvider.now());
    const generation = claim.leaseGeneration;

    claim.timerHandle = this.timeProvider.setTimeout(() => {
      this.handleTimerExpiry(claim.claimToken, generation);
    }, remainingMs);
  }

  private handleTimerExpiry(claimToken: string, generation: number): void {
    const claim = this.claimsByToken.get(claimToken);
    if (!claim) return;
    if (claim.leaseGeneration !== generation) return; // Stale timer from renewed lease
    if (claim.completed) return;

    this.checkAndApplyExpiration(claim);
  }

  private clearClaimTimer(claim: InternalClaim): void {
    if (claim.timerHandle !== null) {
      this.timeProvider.clearTimeout(claim.timerHandle);
      claim.timerHandle = null;
    }
  }

  private snapshotClaim(claim: InternalClaim): ReadonlyClaim {
    return Object.freeze({
      canonicalPlaceId: claim.canonicalPlaceId,
      scoutId: claim.scoutId,
      requestId: claim.requestId,
      claimToken: claim.claimToken,
      createdAt: claim.createdAt,
      expiresAt: claim.expiresAt,
      phase: claim.phase,
      fenced: claim.fenced,
      completed: claim.completed,
      hasNotifiedExpiry: claim.hasNotifiedExpiry,
    });
  }
}
