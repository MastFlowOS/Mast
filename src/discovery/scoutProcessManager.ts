/**
 * src/discovery/scoutProcessManager.ts
 * ====================================
 *
 * MAST Phase 7.3 Gate 4 — Dynamic IPC Handshake & Scout Process Manager.
 *
 * Responsibilities:
 * 1. Cryptographically secure scout session ID & startup nonce generation.
 * 2. Windows Job Object naming convention ("Local\\MAST_JOB_<scoutId>_<nonce>").
 * 3. Bidirectional Dynamic IPC handshake:
 *    - Validates incoming `MAST_JOB_READY` message (type, scoutId, nonce, jobName, pid).
 *    - Rejects malformed, missing, duplicated, stale, or mismatched READY messages.
 *    - Sends `MAST_JOB_ACK` with status "CONFIRMED" and matching nonce.
 * 4. Stdio ordering & query payload integrity:
 *    - Preserves query payload by holding stdin until ACK is confirmed.
 *    - Transmits ACK as a clean \n-delimited JSON line followed by JSON query params and EOF.
 * 5. Lifecycle and Gate 2 Coordinator Integration:
 *    - Tracks child process lifecycle and confirmed OS termination.
 *    - Invokes `PlanPlaceCoordinator.releaseAllForScout(scoutId, reason)` strictly AFTER
 *      authoritative process termination has been verified.
 *    - Prevents claim release if termination cannot be confirmed.
 *    - Enforces idempotent release and strict isolation across concurrent scouts.
 */

import { randomBytes, randomUUID } from "node:crypto";
import type { ChildProcess } from "node:child_process";
import type {
  PlanPlaceCoordinator,
  ReleaseAllScoutClaimsResult,
} from "./planPlaceCoordinator.js";

export const DEFAULT_HANDSHAKE_TIMEOUT_MS = 10_000;

export interface ScoutSessionIdentity {
  readonly scoutId: string;
  readonly startupNonce: string;
  readonly jobName: string;
}

export interface ReadyMessage {
  readonly type: "MAST_JOB_READY";
  readonly scoutId: string;
  readonly jobName: string;
  readonly nonce: string;
  readonly pid: number;
}

export interface AckMessage {
  readonly type: "MAST_JOB_ACK";
  readonly status: "CONFIRMED";
  readonly nonce: string;
}

export interface TerminatedMessage {
  readonly type: "MAST_JOB_TERMINATED";
  readonly scoutId: string;
  readonly nonce: string;
  readonly status: "CONFIRMED";
}

export class ScoutHandshakeError extends Error {
  public readonly scoutId: string;
  constructor(message: string, scoutId: string) {
    super(`[scout:${scoutId}] ${message}`);
    this.name = "ScoutHandshakeError";
    this.scoutId = scoutId;
  }
}

export class ScoutHandshakeTimeoutError extends ScoutHandshakeError {
  constructor(scoutId: string, timeoutMs: number) {
    super(`Timed out awaiting MAST_JOB_READY after ${timeoutMs}ms`, scoutId);
    this.name = "ScoutHandshakeTimeoutError";
  }
}

export class ScoutHandshakeMismatchedNonceError extends ScoutHandshakeError {
  constructor(scoutId: string) {
    super("Startup nonce mismatch in MAST_JOB_READY", scoutId);
    this.name = "ScoutHandshakeMismatchedNonceError";
  }
}

export class ScoutHandshakeMismatchedSessionError extends ScoutHandshakeError {
  constructor(scoutId: string, receivedScoutId: string) {
    super(`Scout ID mismatch in MAST_JOB_READY: expected ${scoutId}, received ${receivedScoutId}`, scoutId);
    this.name = "ScoutHandshakeMismatchedSessionError";
  }
}

export class ScoutHandshakeDuplicateReadyError extends ScoutHandshakeError {
  constructor(scoutId: string) {
    super("Duplicate MAST_JOB_READY message received", scoutId);
    this.name = "ScoutHandshakeDuplicateReadyError";
  }
}

export class ScoutTerminationError extends Error {
  public readonly scoutId: string;
  constructor(message: string, scoutId: string) {
    super(`[scout:${scoutId}] ${message}`);
    this.name = "ScoutTerminationError";
    this.scoutId = scoutId;
  }
}

export class ScoutTerminationMismatchedNonceError extends ScoutTerminationError {
  constructor(scoutId: string) {
    super("Startup nonce mismatch in MAST_JOB_TERMINATED", scoutId);
    this.name = "ScoutTerminationMismatchedNonceError";
  }
}

export class ScoutTerminationMismatchedSessionError extends ScoutTerminationError {
  constructor(scoutId: string, receivedScoutId: string) {
    super(`Scout ID mismatch in MAST_JOB_TERMINATED: expected ${scoutId}, received ${receivedScoutId}`, scoutId);
    this.name = "ScoutTerminationMismatchedSessionError";
  }
}

export class ScoutTerminationDuplicateError extends ScoutTerminationError {
  constructor(scoutId: string) {
    super("Duplicate MAST_JOB_TERMINATED message received", scoutId);
    this.name = "ScoutTerminationDuplicateError";
  }
}

/**
 * Generate cryptographically secure scout identity and Windows Job Object name.
 */
export function generateScoutSessionIdentity(options?: {
  scoutId?: string;
  nonce?: string;
}): ScoutSessionIdentity {
  const scoutId =
    options?.scoutId && options.scoutId.trim().length > 0
      ? options.scoutId.trim()
      : `scout_${randomUUID()}`;

  const startupNonce =
    options?.nonce && options.nonce.trim().length > 0
      ? options.nonce.trim()
      : randomBytes(16).toString("hex");

  // Format valid Windows Job Object name satisfying "Local\MAST_JOB_" prefix
  const sanitizedScoutId = scoutId.replace(/[^a-zA-Z0-9_]/g, "_");
  const jobName = `Local\\MAST_JOB_${sanitizedScoutId}_${startupNonce}`;

  return Object.freeze({
    scoutId,
    startupNonce,
    jobName,
  });
}

/**
 * Strictly validate the MAST_JOB_READY payload.
 */
export function validateReadyMessage(
  payload: unknown,
  expected: ScoutSessionIdentity,
  options?: { isWindows?: boolean }
): { valid: true; ready: ReadyMessage } | { valid: false; reason: string; errorClass?: typeof ScoutHandshakeError } {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return { valid: false, reason: "MAST_JOB_READY must be a valid JSON object" };
  }

  const rec = payload as Record<string, unknown>;

  if (rec.type !== "MAST_JOB_READY") {
    return { valid: false, reason: `Expected type 'MAST_JOB_READY', received '${rec.type}'` };
  }

  if (typeof rec.scoutId !== "string" || rec.scoutId.length === 0) {
    return { valid: false, reason: "MAST_JOB_READY is missing required scoutId" };
  }

  if (rec.scoutId !== expected.scoutId) {
    return {
      valid: false,
      reason: `Scout ID mismatch: expected ${expected.scoutId}, got ${rec.scoutId}`,
      errorClass: ScoutHandshakeMismatchedSessionError,
    };
  }

  if (typeof rec.nonce !== "string" || rec.nonce.length === 0) {
    return { valid: false, reason: "MAST_JOB_READY is missing required startup nonce" };
  }

  if (rec.nonce !== expected.startupNonce) {
    return {
      valid: false,
      reason: "Startup nonce mismatch",
      errorClass: ScoutHandshakeMismatchedNonceError,
    };
  }

  const isWin = options?.isWindows ?? process.platform === "win32";
  if (isWin) {
    if (typeof rec.jobName !== "string" || !rec.jobName.startsWith("Local\\MAST_JOB_")) {
      return { valid: false, reason: `Invalid or missing jobName: ${rec.jobName}` };
    }
    if (rec.jobName !== expected.jobName) {
      return { valid: false, reason: `Job Object name mismatch: expected ${expected.jobName}, got ${rec.jobName}` };
    }
  }

  if (typeof rec.pid !== "number" || !Number.isInteger(rec.pid) || rec.pid <= 0) {
    return { valid: false, reason: `Invalid process PID in MAST_JOB_READY: ${rec.pid}` };
  }

  return {
    valid: true,
    ready: {
      type: "MAST_JOB_READY",
      scoutId: rec.scoutId,
      jobName: typeof rec.jobName === "string" ? rec.jobName : expected.jobName,
      nonce: rec.nonce,
      pid: rec.pid,
    },
  };
}

/**
 * Creates the formatted MAST_JOB_ACK payload.
 */
export function createAckMessage(nonce: string): AckMessage {
  return {
    type: "MAST_JOB_ACK",
    status: "CONFIRMED",
    nonce,
  };
}

/**
 * Strictly validate the MAST_JOB_TERMINATED payload.
 */
export function validateTerminatedMessage(
  payload: unknown,
  expected: ScoutSessionIdentity
): { valid: true; terminated: TerminatedMessage } | { valid: false; reason: string; errorClass?: typeof ScoutTerminationError } {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return { valid: false, reason: "MAST_JOB_TERMINATED must be a valid JSON object" };
  }

  const rec = payload as Record<string, unknown>;

  if (rec.type !== "MAST_JOB_TERMINATED") {
    return { valid: false, reason: `Expected type 'MAST_JOB_TERMINATED', received '${rec.type}'` };
  }

  if (typeof rec.scoutId !== "string" || rec.scoutId.length === 0) {
    return { valid: false, reason: "MAST_JOB_TERMINATED is missing required scoutId" };
  }

  if (rec.scoutId !== expected.scoutId) {
    return {
      valid: false,
      reason: `Scout ID mismatch in termination: expected ${expected.scoutId}, got ${rec.scoutId}`,
      errorClass: ScoutTerminationMismatchedSessionError,
    };
  }

  if (typeof rec.nonce !== "string" || rec.nonce.length === 0) {
    return { valid: false, reason: "MAST_JOB_TERMINATED is missing required startup nonce" };
  }

  if (rec.nonce !== expected.startupNonce) {
    return {
      valid: false,
      reason: "Startup nonce mismatch in termination",
      errorClass: ScoutTerminationMismatchedNonceError,
    };
  }

  if (rec.status !== "CONFIRMED") {
    return { valid: false, reason: `Termination status must be 'CONFIRMED', received '${rec.status}'` };
  }

  return {
    valid: true,
    terminated: {
      type: "MAST_JOB_TERMINATED",
      scoutId: rec.scoutId,
      nonce: rec.nonce,
      status: "CONFIRMED",
    },
  };
}

export type HandshakeStatus = "IDLE" | "READY_RECEIVED" | "ACK_SENT" | "FAILED";

export interface ScoutSessionOptions {
  readonly identity?: ScoutSessionIdentity;
  readonly scoutId?: string;
  readonly requestId?: string;
  readonly planId?: string;
  readonly coordinator?: PlanPlaceCoordinator;
  readonly handshakeTimeoutMs?: number;
  readonly isWindows?: boolean;
}

/**
 * Represents a single coordinated scout process session and its coordination lifecycle.
 */
export class ScoutSession {
  public readonly identity: ScoutSessionIdentity;
  public readonly requestId?: string;
  public readonly planId?: string;
  public readonly coordinator?: PlanPlaceCoordinator;
  public readonly handshakeTimeoutMs: number;
  public readonly isWindows: boolean;

  private _status: HandshakeStatus = "IDLE";
  private _childPid?: number;
  private _readyMessage?: ReadyMessage;
  private _terminationMessageReceived: boolean = false;
  private _terminatedMessage?: TerminatedMessage;
  private _terminationConfirmed: boolean = false;
  private _claimsReleased: boolean = false;

  constructor(options: ScoutSessionOptions = {}) {
    this.identity = options.identity ?? generateScoutSessionIdentity({ scoutId: options.scoutId });
    this.requestId = options.requestId;
    this.planId = options.planId;
    this.coordinator = options.coordinator;
    this.handshakeTimeoutMs = options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS;
    this.isWindows = options.isWindows ?? process.platform === "win32";
  }

  public get scoutId(): string {
    return this.identity.scoutId;
  }

  public get status(): HandshakeStatus {
    return this._status;
  }

  public get childPid(): number | undefined {
    return this._childPid;
  }

  public get readyMessage(): ReadyMessage | undefined {
    return this._readyMessage;
  }

  public get isTerminationMessageReceived(): boolean {
    return this._terminationMessageReceived;
  }

  public get terminatedMessage(): TerminatedMessage | undefined {
    return this._terminatedMessage;
  }

  public get isTerminationConfirmed(): boolean {
    return this._terminationConfirmed;
  }

  public get areClaimsReleased(): boolean {
    return this._claimsReleased;
  }

  /**
   * Returns environment variables to be passed to the spawned Python process.
   */
  public getEnv(): Record<string, string> {
    const env: Record<string, string> = {
      MAST_SCOUT_SESSION_ID: this.identity.scoutId,
      MAST_STARTUP_NONCE: this.identity.startupNonce,
      MAST_COORDINATION_REQUIRED: "1",
    };

    if (this.isWindows) {
      env.MAST_JOB_NAME = this.identity.jobName;
    }

    if (this.requestId) {
      env.MAST_REQUEST_ID = this.requestId;
    }
    if (this.planId) {
      env.MAST_PLAN_ID = this.planId;
    }

    return env;
  }

  /**
   * Process a single line received from stdout during the handshake phase.
   */
  public processReadyLine(line: string): ReadyMessage {
    if (this._status === "ACK_SENT" || this._status === "READY_RECEIVED") {
      try {
        const parsed = JSON.parse(line.trim());
        if (parsed && typeof parsed === "object" && (parsed as any).type === "MAST_JOB_READY") {
          this._status = "FAILED";
          throw new ScoutHandshakeDuplicateReadyError(this.scoutId);
        }
      } catch (err) {
        if (err instanceof ScoutHandshakeDuplicateReadyError) throw err;
      }
      throw new ScoutHandshakeError("Unexpected stdout line after handshake completion", this.scoutId);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(line.trim());
    } catch (parseErr: any) {
      this._status = "FAILED";
      throw new ScoutHandshakeError(`Malformed JSON in MAST_JOB_READY: ${parseErr?.message ?? parseErr}`, this.scoutId);
    }

    const validation = validateReadyMessage(parsed, this.identity, { isWindows: this.isWindows });
    if (!validation.valid) {
      this._status = "FAILED";
      if (validation.errorClass) {
        if (validation.errorClass === ScoutHandshakeMismatchedSessionError) {
          throw new ScoutHandshakeMismatchedSessionError(this.scoutId, String((parsed as any)?.scoutId));
        }
        if (validation.errorClass === ScoutHandshakeMismatchedNonceError) {
          throw new ScoutHandshakeMismatchedNonceError(this.scoutId);
        }
      }
      throw new ScoutHandshakeError(validation.reason, this.scoutId);
    }

    this._readyMessage = validation.ready;
    this._childPid = validation.ready.pid;
    this._status = "READY_RECEIVED";
    return validation.ready;
  }

  /**
   * Sends MAST_JOB_ACK to the child's stdin stream.
   */
  public async sendAck(child: ChildProcess): Promise<void> {
    if (this._status !== "READY_RECEIVED") {
      throw new ScoutHandshakeError(
        `Cannot send MAST_JOB_ACK in state '${this._status}': MAST_JOB_READY must be received and validated first`,
        this.scoutId
      );
    }

    if (!child.stdin || child.stdin.destroyed || !child.stdin.writable) {
      this._status = "FAILED";
      throw new ScoutHandshakeError("Child stdin stream is not writable for MAST_JOB_ACK", this.scoutId);
    }

    const ackPayload = createAckMessage(this.identity.startupNonce);
    const ackLine = JSON.stringify(ackPayload) + "\n";

    await new Promise<void>((resolve, reject) => {
      child.stdin!.write(ackLine, "utf-8", (err) => {
        if (err) {
          this._status = "FAILED";
          reject(new ScoutHandshakeError(`Failed to write MAST_JOB_ACK: ${err.message}`, this.scoutId));
        } else {
          this._status = "ACK_SENT";
          resolve();
        }
      });
    });
  }

  /**
   * Delivers the query payload to the child's stdin stream and closes stdin.
   * Can ONLY be called after MAST_JOB_ACK has been confirmed.
   */
  public async writeQueryPayload(child: ChildProcess, params: Record<string, unknown>): Promise<void> {
    if (this._status !== "ACK_SENT") {
      throw new ScoutHandshakeError(
        `Cannot write query payload in state '${this._status}': handshake must complete first`,
        this.scoutId
      );
    }

    if (!child.stdin || child.stdin.destroyed || !child.stdin.writable) {
      throw new ScoutHandshakeError("Child stdin stream is not writable for query payload", this.scoutId);
    }

    const payload = JSON.stringify(params);

    await new Promise<void>((resolve, reject) => {
      child.stdin!.write(payload, "utf-8", (err) => {
        if (err) {
          reject(new ScoutHandshakeError(`Failed to write query payload: ${err.message}`, this.scoutId));
        } else {
          try {
            child.stdin!.end();
            resolve();
          } catch (endErr: any) {
            reject(new ScoutHandshakeError(`Failed to close stdin: ${endErr?.message ?? endErr}`, this.scoutId));
          }
        }
      });
    });
  }

  /**
   * Process a single line received from stdout for MAST_JOB_TERMINATED.
   * Strictly validates session ID, nonce, and status. Rejects duplicates.
   */
  public processTerminatedLine(line: string): TerminatedMessage {
    if (this._terminationMessageReceived) {
      throw new ScoutTerminationDuplicateError(this.scoutId);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(line.trim());
    } catch (parseErr: any) {
      throw new ScoutTerminationError(`Malformed JSON in MAST_JOB_TERMINATED: ${parseErr?.message ?? parseErr}`, this.scoutId);
    }

    const validation = validateTerminatedMessage(parsed, this.identity);
    if (!validation.valid) {
      if (validation.errorClass) {
        if (validation.errorClass === ScoutTerminationMismatchedSessionError) {
          throw new ScoutTerminationMismatchedSessionError(this.scoutId, String((parsed as any)?.scoutId));
        }
        if (validation.errorClass === ScoutTerminationMismatchedNonceError) {
          throw new ScoutTerminationMismatchedNonceError(this.scoutId);
        }
      }
      throw new ScoutTerminationError(validation.reason, this.scoutId);
    }

    this._terminationMessageReceived = true;
    this._terminatedMessage = validation.terminated;
    return validation.terminated;
  }

  /**
   * Authoritatively confirms process termination and releases uncompleted claims for this scout.
   * Requires BOTH:
   * 1. childExitConfirmed (Python child process has exited)
   * 2. this._terminationMessageReceived (authoritative tree termination confirmed by Python)
   *
   * If either is false, termination is UNCONFIRMED, claims are preserved and NOT released.
   * Idempotent: Subsequent calls return null without re-executing.
   */
  public confirmTerminationAndReleaseClaims(
    childExitConfirmed: boolean,
    reason: string
  ): ReleaseAllScoutClaimsResult | null {
    if (this._claimsReleased) {
      return null;
    }

    const isFullyConfirmed = childExitConfirmed && this._terminationMessageReceived;

    if (!isFullyConfirmed) {
      console.warn(
        `[scout-manager] Termination UNCONFIRMED for scout ${this.scoutId} (childExit=${childExitConfirmed}, termMsgReceived=${this._terminationMessageReceived}) — claims will NOT be released`
      );
      this._terminationConfirmed = false;
      return null;
    }

    this._terminationConfirmed = true;

    if (this.coordinator) {
      try {
        const result = this.coordinator.releaseAllForScout(this.scoutId, reason);
        this._claimsReleased = true;
        return result;
      } catch (err: any) {
        console.error(
          `[scout-manager] releaseAllForScout threw for scout ${this.scoutId}: ${err?.message ?? err}`
        );
        this._claimsReleased = true;
        return null;
      }
    }

    this._claimsReleased = true;
    return null;
  }
}

/**
 * Singleton / manager tracking active ScoutSessions and providing concurrency safety.
 */
export class ScoutProcessManager {
  private static instance: ScoutProcessManager | null = null;
  private readonly activeSessions: Map<string, ScoutSession> = new Map();

  public static getInstance(): ScoutProcessManager {
    if (!ScoutProcessManager.instance) {
      ScoutProcessManager.instance = new ScoutProcessManager();
    }
    return ScoutProcessManager.instance;
  }

  public registerSession(session: ScoutSession): void {
    if (this.activeSessions.has(session.scoutId)) {
      throw new Error(`Scout session '${session.scoutId}' is already registered`);
    }
    this.activeSessions.set(session.scoutId, session);
  }

  public getSession(scoutId: string): ScoutSession | undefined {
    return this.activeSessions.get(scoutId);
  }

  public unregisterSession(scoutId: string): boolean {
    return this.activeSessions.delete(scoutId);
  }

  public getActiveCount(): number {
    return this.activeSessions.size;
  }

  public clearAll(): void {
    this.activeSessions.clear();
  }
}

export const scoutProcessManager = ScoutProcessManager.getInstance();
