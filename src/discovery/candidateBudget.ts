/**
 * City-Wide Candidate Budget Coordinator (Phase 3).
 *
 * Scope & Purpose:
 * `candidate_budget` (computed by computeCandidateBudget in planner.ts and
 * stored on discovery_tasks.candidate_budget) is an AGGREGATE CITY-WIDE
 * allowance, NOT a per-area allowance.
 *
 * For example, with a target of 10 and candidate budget of 40:
 *   - All areas combined must admit no more than 40 raw candidate records
 *     into the Node candidate pipeline.
 *   - Multiple concurrent area workers share the same budget coordinator.
 *   - Candidate admission is synchronous and atomic in the Node event loop,
 *     preventing overshoot even under heavy concurrency.
 *   - Once the budget is reached (admittedCount >= budget), further admissions
 *     are refused, new area attempts are prevented from starting, and active
 *     workers are cleanly stopped via cooperative consumer-stop signals.
 *   - Already admitted candidates finish their pipeline processing (backpressure
 *     drain) without being dropped.
 *   - Budget exhaustion is treated as normal planned completion
 *     (SUCCESS_CONSUMER_STOPPED), never as USER_CANCELLED or WATCHDOG_TIMEOUT.
 */

export interface CandidateBudgetCoordinator {
  /** The total city-wide aggregate budget limit. */
  readonly initialBudget: number;

  /** Total number of candidates admitted across all areas for this city task. */
  readonly admittedCount: number;

  /** Remaining admissions available in the city-wide budget. */
  readonly remainingBudget: number;

  /** Returns true if the budget has been fully consumed. */
  isExhausted(): boolean;

  /**
   * Synchronously and atomically attempts to admit one candidate.
   * Returns true if budget was available and has been reserved.
   * Returns false if the budget was already exhausted.
   */
  tryAdmitCandidate(): boolean;

  /**
   * Returns the maximum results that a newly starting area should be allowed
   * to request (clamped to remaining budget).
   */
  getRemainingBudget(): number;

  /**
   * Registers an active area worker's stop handler.
   * When the budget is exhausted, all registered active workers are signaled to stop.
   * Returns an unregister function to call when the area worker finishes.
   */
  registerActiveWorker(workerId: string, stopFn: () => Promise<void> | void): () => void;

  /**
   * Registers a listener to be called when the budget becomes exhausted.
   */
  onExhausted(listener: () => void): () => void;

  /**
   * Signals all active workers to stop cleanly.
   */
  stopAllWorkers(reason?: string): Promise<void>;
}

export class CityCandidateBudgetCoordinator implements CandidateBudgetCoordinator {
  private readonly budget: number;
  private admitted = 0;
  private exhausted = false;
  private readonly activeWorkers = new Map<string, () => Promise<void> | void>();
  private readonly exhaustedListeners = new Set<() => void>();

  constructor(budget: number) {
    this.budget = Math.max(0, budget);
    if (this.budget === 0) {
      this.exhausted = true;
    }
  }

  get initialBudget(): number {
    return this.budget;
  }

  get admittedCount(): number {
    return this.admitted;
  }

  get remainingBudget(): number {
    return Math.max(0, this.budget - this.admitted);
  }

  isExhausted(): boolean {
    return this.exhausted || this.admitted >= this.budget;
  }

  tryAdmitCandidate(): boolean {
    if (this.isExhausted()) {
      return false;
    }
    this.admitted += 1;
    if (this.admitted >= this.budget) {
      this.exhausted = true;
      this.notifyExhausted();
      void this.stopAllWorkers("budget_exhausted");
    }
    return true;
  }

  getRemainingBudget(): number {
    return this.remainingBudget;
  }

  registerActiveWorker(workerId: string, stopFn: () => Promise<void> | void): () => void {
    if (this.isExhausted()) {
      try {
        void stopFn();
      } catch {}
      return () => {};
    }
    this.activeWorkers.set(workerId, stopFn);
    return () => {
      this.activeWorkers.delete(workerId);
    };
  }

  onExhausted(listener: () => void): () => void {
    if (this.isExhausted()) {
      try {
        listener();
      } catch {}
      return () => {};
    }
    this.exhaustedListeners.add(listener);
    return () => {
      this.exhaustedListeners.delete(listener);
    };
  }

  private notifyExhausted(): void {
    for (const listener of this.exhaustedListeners) {
      try {
        listener();
      } catch (err) {
        console.warn("[candidateBudget] error in exhausted listener:", err);
      }
    }
  }

  async stopAllWorkers(reason?: string): Promise<void> {
    const stops = Array.from(this.activeWorkers.values()).map(async (stopFn) => {
      try {
        await stopFn();
      } catch (err) {
        console.warn(`[candidateBudget] error stopping worker (${reason ?? "unknown"}):`, err);
      }
    });
    await Promise.all(stops);
  }
}
