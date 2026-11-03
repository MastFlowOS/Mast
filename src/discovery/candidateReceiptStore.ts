/**
 * src/discovery/candidateReceiptStore.ts
 * ======================================
 *
 * MAST Phase 7.3 — Node-Owned Candidate Receipt Store.
 *
 * Responsibilities:
 * 1. Node-owned, in-memory store for single-use candidate admission receipts.
 * 2. Enforces non-repudiation: Python cannot fabricate or self-attest receipts.
 * 3. Place ID card receipts require a valid, non-fenced coordinator claim.
 * 4. Admission lifecycle enforcement: Candidate receipts (Place ID and Fallback) cannot be
 *    consumed while in PRE_CLICK; card click must have been started (CLICK_STARTED).
 * 5. Fallback receipts require Gate 1 MISSING Place ID classification (MALFORMED strictly rejected).
 * 6. Validates fallback card URLs via Google Maps URL policy (protocol, host, and path validation).
 * 7. Full binding validation at consumption (scout, request, token, Place ID / URL).
 * 8. Single-use enforcement (atomic transitions to consumed state).
 * 9. Readonly, frozen receipt snapshots to prevent external mutation.
 *
 * MEMORY LIFECYCLE & CLEANUP:
 * - This store is instantiated strictly per discovery plan and held in Node worker memory.
 * - Discovery plans in MAST are bounded in scope (targeting 10-50 businesses, typically lasting
 *   10-30 minutes); total receipt allocations per plan are at most a few hundred small objects (<1MB).
 * - Receipts are explicitly managed during plan execution via `abandonReceipt()` for failed cards
 *   and `clear()` for explicit reset.
 * - When the discovery plan job concludes, the store reference is dropped with the coordinator,
 *   allowing V8 to reclaim all memory naturally without background sweeps or persistent storage.
 */

import { randomUUID } from "node:crypto";
import {
  validateCoordinationPlaceId,
  type CoordinationPlaceIdResult,
} from "../lib/placeId.js";
import {
  PlanPlaceCoordinator,
  type TimeProvider,
  defaultTimeProvider,
  type ClaimPhase,
} from "./planPlaceCoordinator.js";

export type ReceiptKind = "PLACE_ID" | "FALLBACK";

const GOOGLE_CCTLD_RE = /^(?:(?:www|maps)\.)?google\.[a-z]{2,}(?:\.[a-z]{2,})?$/i;

/**
 * Validates that a card URL belongs to a legitimate Google Maps service endpoint.
 * Enforces protocol (http:/https:), authorized Google Maps domains, and valid Maps paths.
 */
export function validateGoogleMapsCardUrl(
  rawUrl: unknown
): { valid: true; url: string } | { valid: false; reason: string } {
  if (typeof rawUrl !== "string") {
    return { valid: false, reason: `Expected string URL, received ${typeof rawUrl}` };
  }

  const trimmed = rawUrl.trim();
  if (trimmed.length === 0) {
    return { valid: false, reason: "Card URL is missing or empty" };
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch (err) {
    return {
      valid: false,
      reason: `Malformed URL: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // 1. Protocol check: must be http or https
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return {
      valid: false,
      reason: `Unsupported URL protocol "${parsed.protocol}"; only http: and https: are allowed`,
    };
  }

  const hostname = parsed.hostname.toLowerCase();

  // 2. Hostname check: must be Google Maps domain
  // Matches:
  // - google.com, *.google.com (e.g. www.google.com, maps.google.com)
  // - google.<ccTLD> (e.g. google.co.uk, google.ca, google.de, google.com.au, maps.google.co.uk, www.google.fr)
  // - maps.app.goo.gl, goo.gl
  const isGoogleCom = hostname === "google.com" || hostname.endsWith(".google.com");
  const isGoogleCCTLD = GOOGLE_CCTLD_RE.test(hostname);
  const isGooGlShortLink = hostname === "maps.app.goo.gl" || hostname === "goo.gl";

  if (!isGoogleCom && !isGoogleCCTLD && !isGooGlShortLink) {
    return {
      valid: false,
      reason: `Host "${hostname}" is not a recognized Google Maps domain`,
    };
  }

  // 3. Path check:
  // If short-link domain (maps.app.goo.gl or goo.gl): must have a non-root token
  if (isGooGlShortLink) {
    if (parsed.pathname.length <= 1) {
      return { valid: false, reason: "Google short link must contain a path token" };
    }
    return { valid: true, url: trimmed };
  }

  // If maps.google.*: any path or root with query is valid (e.g. maps.google.com/?cid=...)
  if (hostname.startsWith("maps.google.")) {
    return { valid: true, url: trimmed };
  }

  // If main google domain (e.g. google.com, www.google.com, www.google.co.uk):
  // pathname must start with /maps (e.g. /maps/place/..., /maps/search/..., /maps?...)
  if (!parsed.pathname.startsWith("/maps")) {
    return {
      valid: false,
      reason: `Google URL path "${parsed.pathname}" is not a Google Maps path (must start with /maps)`,
    };
  }

  return { valid: true, url: trimmed };
}

export interface PlaceIdReceipt {
  readonly receiptId: string;
  readonly kind: "PLACE_ID";
  readonly scoutId: string;
  readonly requestId: string;
  readonly canonicalPlaceId: string;
  readonly claimToken: string;
  readonly claimPhase: ClaimPhase;
  readonly createdAt: number;
  readonly consumed: boolean;
  readonly consumedAt?: number;
  readonly abandoned: boolean;
  readonly abandonedAt?: number;
}

export interface FallbackReceipt {
  readonly receiptId: string;
  readonly kind: "FALLBACK";
  readonly scoutId: string;
  readonly requestId: string;
  readonly cardUrl: string;
  readonly claimPhase: ClaimPhase;
  readonly createdAt: number;
  readonly consumed: boolean;
  readonly consumedAt?: number;
  readonly abandoned: boolean;
  readonly abandonedAt?: number;
}

export type CandidateReceipt = PlaceIdReceipt | FallbackReceipt;

interface InternalPlaceIdReceipt {
  readonly receiptId: string;
  readonly kind: "PLACE_ID";
  readonly scoutId: string;
  readonly requestId: string;
  readonly canonicalPlaceId: string;
  readonly claimToken: string;
  readonly claimPhase: ClaimPhase;
  readonly createdAt: number;
  consumed: boolean;
  consumedAt?: number;
  abandoned: boolean;
  abandonedAt?: number;
}

interface InternalFallbackReceipt {
  readonly receiptId: string;
  readonly kind: "FALLBACK";
  readonly scoutId: string;
  readonly requestId: string;
  readonly cardUrl: string;
  claimPhase: ClaimPhase;
  readonly createdAt: number;
  consumed: boolean;
  consumedAt?: number;
  abandoned: boolean;
  abandonedAt?: number;
}

type InternalReceipt = InternalPlaceIdReceipt | InternalFallbackReceipt;

export type CreatePlaceIdReceiptResult =
  | {
      success: true;
      status: "CREATED";
      receipt: PlaceIdReceipt;
    }
  | {
      success: false;
      status:
        | "INVALID_CLAIM"
        | "MISSING_SCOUT_ID"
        | "MISSING_REQUEST_ID"
        | "MISSING_TOKEN"
        | "MISSING_PLACE_ID";
      reason: string;
    };

export type ConsumePlaceIdReceiptResult =
  | {
      success: true;
      status: "CONSUMED";
      receipt: PlaceIdReceipt;
    }
  | {
      success: false;
      status:
        | "UNKNOWN_RECEIPT"
        | "KIND_MISMATCH"
        | "ALREADY_CONSUMED"
        | "RECEIPT_ABANDONED"
        | "WRONG_SCOUT"
        | "WRONG_REQUEST"
        | "WRONG_PLACE_ID"
        | "WRONG_TOKEN"
        | "CLICK_NOT_STARTED"
        | "CLAIM_INVALID_AT_CONSUMPTION";
      reason: string;
    };

export type CreateFallbackReceiptResult =
  | {
      success: true;
      status: "CREATED";
      receipt: FallbackReceipt;
    }
  | {
      success: false;
      status:
        | "REJECTED_VALID_PLACE_ID_PRESENT"
        | "REJECTED_MALFORMED_PLACE_ID"
        | "MISSING_SCOUT_ID"
        | "MISSING_REQUEST_ID"
        | "INVALID_URL";
      reason: string;
    };

export type NotifyFallbackClickStartedResult =
  | {
      success: true;
      status: "CLICK_STARTED";
      receipt: FallbackReceipt;
    }
  | {
      success: false;
      status:
        | "UNKNOWN_RECEIPT"
        | "KIND_MISMATCH"
        | "WRONG_SCOUT"
        | "WRONG_REQUEST"
        | "ALREADY_CONSUMED"
        | "RECEIPT_ABANDONED";
      reason: string;
    };

export type ConsumeFallbackReceiptResult =
  | {
      success: true;
      status: "CONSUMED";
      receipt: FallbackReceipt;
    }
  | {
      success: false;
      status:
        | "UNKNOWN_RECEIPT"
        | "KIND_MISMATCH"
        | "ALREADY_CONSUMED"
        | "RECEIPT_ABANDONED"
        | "WRONG_SCOUT"
        | "WRONG_REQUEST"
        | "WRONG_URL"
        | "CLICK_NOT_STARTED"
        | "INVALID_URL";
      reason: string;
    };

export type AbandonReceiptResult =
  | {
      success: true;
      status: "ABANDONED" | "ALREADY_ABANDONED";
      receipt: CandidateReceipt;
    }
  | {
      success: false;
      status: "UNKNOWN_RECEIPT" | "WRONG_SCOUT" | "ALREADY_CONSUMED";
      reason: string;
    };

export interface CandidateReceiptStoreOptions {
  readonly timeProvider?: TimeProvider;
}

export class CandidateReceiptStore {
  private readonly coordinator: PlanPlaceCoordinator;
  private readonly timeProvider: TimeProvider;
  private readonly receipts = new Map<string, InternalReceipt>();

  constructor(coordinator: PlanPlaceCoordinator, options?: CandidateReceiptStoreOptions) {
    if (!coordinator) {
      throw new Error("CandidateReceiptStore requires a valid PlanPlaceCoordinator instance");
    }
    this.coordinator = coordinator;
    this.timeProvider = options?.timeProvider ?? defaultTimeProvider;
  }

  /**
   * Creates a single-use candidate receipt bound to an active coordinator claim.
   */
  public createPlaceIdReceipt(params: {
    scoutId: string;
    requestId: string;
    canonicalPlaceId: string;
    claimToken: string;
  }): CreatePlaceIdReceiptResult {
    const { scoutId, requestId, canonicalPlaceId, claimToken } = params;

    if (!scoutId || typeof scoutId !== "string" || scoutId.trim().length === 0) {
      return { success: false, status: "MISSING_SCOUT_ID", reason: "Scout ID is required" };
    }
    if (!requestId || typeof requestId !== "string" || requestId.trim().length === 0) {
      return { success: false, status: "MISSING_REQUEST_ID", reason: "Request ID is required" };
    }
    if (!claimToken || typeof claimToken !== "string" || claimToken.trim().length === 0) {
      return { success: false, status: "MISSING_TOKEN", reason: "Claim token is required" };
    }
    if (!canonicalPlaceId || typeof canonicalPlaceId !== "string" || canonicalPlaceId.trim().length === 0) {
      return { success: false, status: "MISSING_PLACE_ID", reason: "Canonical Place ID is required" };
    }

    const claimValidation = this.coordinator.validateActiveClaim(
      scoutId,
      requestId,
      claimToken,
      canonicalPlaceId
    );

    if (!claimValidation.valid) {
      return {
        success: false,
        status: "INVALID_CLAIM",
        reason: `Cannot create receipt for invalid claim: ${claimValidation.reason}`,
      };
    }

    const receiptId = randomUUID();
    const receipt: InternalPlaceIdReceipt = {
      receiptId,
      kind: "PLACE_ID",
      scoutId,
      requestId,
      canonicalPlaceId,
      claimToken,
      claimPhase: claimValidation.claim.phase,
      createdAt: this.timeProvider.now(),
      consumed: false,
      abandoned: false,
    };

    this.receipts.set(receiptId, receipt);

    return {
      success: true,
      status: "CREATED",
      receipt: this.snapshotPlaceIdReceipt(receipt),
    };
  }

  /**
   * Consumes a Place ID card receipt upon candidate admission.
   * STRICT ADMISSION LIFECYCLE:
   * 1. Requires coordinator claim to have reached CLICK_STARTED phase (rejects PRE_CLICK).
   * 2. Enforces all bindings, coordinator validity, and single-use.
   */
  public consumePlaceIdReceipt(params: {
    receiptId: string;
    scoutId: string;
    requestId: string;
    canonicalPlaceId: string;
    claimToken: string;
  }): ConsumePlaceIdReceiptResult {
    const { receiptId, scoutId, requestId, canonicalPlaceId, claimToken } = params;

    const receipt = this.receipts.get(receiptId);
    if (!receipt) {
      return {
        success: false,
        status: "UNKNOWN_RECEIPT",
        reason: "Receipt ID does not exist or was fabricated",
      };
    }

    if (receipt.kind !== "PLACE_ID") {
      return {
        success: false,
        status: "KIND_MISMATCH",
        reason: "Expected PLACE_ID receipt but found FALLBACK receipt",
      };
    }

    if (receipt.consumed) {
      return {
        success: false,
        status: "ALREADY_CONSUMED",
        reason: "Receipt has already been consumed; replay rejected",
      };
    }

    if (receipt.abandoned) {
      return {
        success: false,
        status: "RECEIPT_ABANDONED",
        reason: "Receipt was abandoned and cannot be consumed",
      };
    }

    // Verify bindings
    if (receipt.scoutId !== scoutId) {
      return { success: false, status: "WRONG_SCOUT", reason: "Receipt scout ID mismatch" };
    }
    if (receipt.requestId !== requestId) {
      return { success: false, status: "WRONG_REQUEST", reason: "Receipt request ID mismatch" };
    }
    if (receipt.canonicalPlaceId !== canonicalPlaceId) {
      return { success: false, status: "WRONG_PLACE_ID", reason: "Receipt canonical Place ID mismatch" };
    }
    if (receipt.claimToken !== claimToken) {
      return { success: false, status: "WRONG_TOKEN", reason: "Receipt claim token mismatch" };
    }

    // Verify claim is still active in coordinator (not expired or fenced)
    const claimCheck = this.coordinator.validateActiveClaim(
      scoutId,
      requestId,
      claimToken,
      canonicalPlaceId
    );

    if (!claimCheck.valid) {
      return {
        success: false,
        status: "CLAIM_INVALID_AT_CONSUMPTION",
        reason: `Coordinator rejected claim at consumption time: ${claimCheck.reason}`,
      };
    }

    // Enforce coordinator claim lifecycle: claim must have reached CLICK_STARTED phase
    if (claimCheck.claim.phase !== "CLICK_STARTED") {
      return {
        success: false,
        status: "CLICK_NOT_STARTED",
        reason: "Coordinator claim is in PRE_CLICK phase; card click must be started before candidate receipt consumption",
      };
    }

    // Atomic single-use consumption
    receipt.consumed = true;
    receipt.consumedAt = this.timeProvider.now();

    return {
      success: true,
      status: "CONSUMED",
      receipt: this.snapshotPlaceIdReceipt(receipt),
    };
  }

  /**
   * Creates a single-use fallback receipt for a card that legitimately lacks a Place ID.
   * Only Gate 1 MISSING classification is allowed. MALFORMED is strictly rejected.
   * Enforces Google Maps card URL policy.
   */
  public createFallbackReceipt(params: {
    scoutId: string;
    requestId: string;
    rawPlaceId: unknown;
    cardUrl: string;
  }): CreateFallbackReceiptResult {
    const { scoutId, requestId, rawPlaceId, cardUrl } = params;

    if (!scoutId || typeof scoutId !== "string" || scoutId.trim().length === 0) {
      return { success: false, status: "MISSING_SCOUT_ID", reason: "Scout ID is required" };
    }
    if (!requestId || typeof requestId !== "string" || requestId.trim().length === 0) {
      return { success: false, status: "MISSING_REQUEST_ID", reason: "Request ID is required" };
    }

    const urlValidation = validateGoogleMapsCardUrl(cardUrl);
    if (!urlValidation.valid) {
      return { success: false, status: "INVALID_URL", reason: urlValidation.reason };
    }

    const validation: CoordinationPlaceIdResult = validateCoordinationPlaceId(rawPlaceId);

    if (validation.status === "VALID") {
      return {
        success: false,
        status: "REJECTED_VALID_PLACE_ID_PRESENT",
        reason: "Card has a valid Place ID; must acquire Place ID claim and use Place ID receipt",
      };
    }

    if (validation.status === "MALFORMED") {
      return {
        success: false,
        status: "REJECTED_MALFORMED_PLACE_ID",
        reason: `Card Place ID is malformed (${validation.reason}); malformed values cannot enter fallback path`,
      };
    }

    // Only MISSING is allowed here. Created initially in PRE_CLICK phase.
    const receiptId = randomUUID();
    const receipt: InternalFallbackReceipt = {
      receiptId,
      kind: "FALLBACK",
      scoutId,
      requestId,
      cardUrl: urlValidation.url,
      claimPhase: "PRE_CLICK",
      createdAt: this.timeProvider.now(),
      consumed: false,
      abandoned: false,
    };

    this.receipts.set(receiptId, receipt);

    return {
      success: true,
      status: "CREATED",
      receipt: this.snapshotFallbackReceipt(receipt),
    };
  }

  /**
   * Transitions a fallback card receipt from PRE_CLICK to CLICK_STARTED.
   * Establishes equivalent lifecycle protection for missing-ID cards without inventing Place IDs.
   */
  public notifyFallbackClickStarted(params: {
    receiptId: string;
    scoutId: string;
    requestId: string;
  }): NotifyFallbackClickStartedResult {
    const { receiptId, scoutId, requestId } = params;

    const receipt = this.receipts.get(receiptId);
    if (!receipt) {
      return { success: false, status: "UNKNOWN_RECEIPT", reason: "Receipt does not exist" };
    }
    if (receipt.kind !== "FALLBACK") {
      return { success: false, status: "KIND_MISMATCH", reason: "Expected FALLBACK receipt" };
    }
    if (receipt.consumed) {
      return { success: false, status: "ALREADY_CONSUMED", reason: "Receipt has already been consumed" };
    }
    if (receipt.abandoned) {
      return { success: false, status: "RECEIPT_ABANDONED", reason: "Receipt was abandoned" };
    }
    if (receipt.scoutId !== scoutId) {
      return { success: false, status: "WRONG_SCOUT", reason: "Receipt scout ID mismatch" };
    }
    if (receipt.requestId !== requestId) {
      return { success: false, status: "WRONG_REQUEST", reason: "Receipt request ID mismatch" };
    }

    receipt.claimPhase = "CLICK_STARTED";

    return {
      success: true,
      status: "CLICK_STARTED",
      receipt: this.snapshotFallbackReceipt(receipt),
    };
  }

  /**
   * Consumes a fallback card receipt upon candidate admission.
   * STRICT ADMISSION LIFECYCLE:
   * 1. Requires receipt to have entered CLICK_STARTED phase (rejects PRE_CLICK).
   * 2. Enforces all bindings, URL validation, and single-use.
   */
  public consumeFallbackReceipt(params: {
    receiptId: string;
    scoutId: string;
    requestId: string;
    cardUrl: string;
  }): ConsumeFallbackReceiptResult {
    const { receiptId, scoutId, requestId, cardUrl } = params;

    const receipt = this.receipts.get(receiptId);
    if (!receipt) {
      return {
        success: false,
        status: "UNKNOWN_RECEIPT",
        reason: "Receipt ID does not exist or was fabricated",
      };
    }

    if (receipt.kind !== "FALLBACK") {
      return {
        success: false,
        status: "KIND_MISMATCH",
        reason: "Expected FALLBACK receipt but found PLACE_ID receipt",
      };
    }

    if (receipt.consumed) {
      return {
        success: false,
        status: "ALREADY_CONSUMED",
        reason: "Receipt has already been consumed; replay rejected",
      };
    }

    if (receipt.abandoned) {
      return {
        success: false,
        status: "RECEIPT_ABANDONED",
        reason: "Receipt was abandoned and cannot be consumed",
      };
    }

    // Verify bindings
    if (receipt.scoutId !== scoutId) {
      return { success: false, status: "WRONG_SCOUT", reason: "Receipt scout ID mismatch" };
    }
    if (receipt.requestId !== requestId) {
      return { success: false, status: "WRONG_REQUEST", reason: "Receipt request ID mismatch" };
    }

    const urlValidation = validateGoogleMapsCardUrl(cardUrl);
    if (!urlValidation.valid) {
      return { success: false, status: "INVALID_URL", reason: urlValidation.reason };
    }

    if (receipt.cardUrl !== urlValidation.url) {
      return { success: false, status: "WRONG_URL", reason: "Receipt card URL mismatch" };
    }

    // Enforce admission lifecycle: fallback receipt must be in CLICK_STARTED phase
    if (receipt.claimPhase !== "CLICK_STARTED") {
      return {
        success: false,
        status: "CLICK_NOT_STARTED",
        reason: "Fallback receipt is in PRE_CLICK phase; click must be started before consuming receipt",
      };
    }

    // Atomic single-use consumption
    receipt.consumed = true;
    receipt.consumedAt = this.timeProvider.now();

    return {
      success: true,
      status: "CONSUMED",
      receipt: this.snapshotFallbackReceipt(receipt),
    };
  }

  /**
   * Abandons a receipt (e.g., if card extraction fails or scout cancels).
   * Prevents any future consumption.
   */
  public abandonReceipt(params: { receiptId: string; scoutId: string }): AbandonReceiptResult {
    const { receiptId, scoutId } = params;

    const receipt = this.receipts.get(receiptId);
    if (!receipt) {
      return { success: false, status: "UNKNOWN_RECEIPT", reason: "Receipt ID does not exist" };
    }
    if (receipt.scoutId !== scoutId) {
      return { success: false, status: "WRONG_SCOUT", reason: "Receipt scout ID mismatch" };
    }
    if (receipt.consumed) {
      return { success: false, status: "ALREADY_CONSUMED", reason: "Cannot abandon already consumed receipt" };
    }

    if (receipt.abandoned) {
      return {
        success: true,
        status: "ALREADY_ABANDONED",
        receipt: this.snapshotReceipt(receipt),
      };
    }

    receipt.abandoned = true;
    receipt.abandonedAt = this.timeProvider.now();

    return {
      success: true,
      status: "ABANDONED",
      receipt: this.snapshotReceipt(receipt),
    };
  }

  public getReceipt(receiptId: string): CandidateReceipt | undefined {
    const receipt = this.receipts.get(receiptId);
    if (!receipt) return undefined;
    return this.snapshotReceipt(receipt);
  }

  public get size(): number {
    return this.receipts.size;
  }

  public clear(): void {
    this.receipts.clear();
  }

  // --- Snapshot Helpers (Strict Immutability) ---

  private snapshotPlaceIdReceipt(receipt: InternalPlaceIdReceipt): PlaceIdReceipt {
    return Object.freeze({
      receiptId: receipt.receiptId,
      kind: receipt.kind,
      scoutId: receipt.scoutId,
      requestId: receipt.requestId,
      canonicalPlaceId: receipt.canonicalPlaceId,
      claimToken: receipt.claimToken,
      claimPhase: receipt.claimPhase,
      createdAt: receipt.createdAt,
      consumed: receipt.consumed,
      consumedAt: receipt.consumedAt,
      abandoned: receipt.abandoned,
      abandonedAt: receipt.abandonedAt,
    });
  }

  private snapshotFallbackReceipt(receipt: InternalFallbackReceipt): FallbackReceipt {
    return Object.freeze({
      receiptId: receipt.receiptId,
      kind: receipt.kind,
      scoutId: receipt.scoutId,
      requestId: receipt.requestId,
      cardUrl: receipt.cardUrl,
      claimPhase: receipt.claimPhase,
      createdAt: receipt.createdAt,
      consumed: receipt.consumed,
      consumedAt: receipt.consumedAt,
      abandoned: receipt.abandoned,
      abandonedAt: receipt.abandonedAt,
    });
  }

  private snapshotReceipt(receipt: InternalReceipt): CandidateReceipt {
    if (receipt.kind === "PLACE_ID") {
      return this.snapshotPlaceIdReceipt(receipt);
    }
    return this.snapshotFallbackReceipt(receipt);
  }
}
