import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import { ArrowRight, Check } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  DAILY_GOAL_COUNT,
  goalPercent,
  type DailyGoalInstance,
  type InsufficientGoalsDiagnostic,
} from "@/lib/dailyGoals";
import {
  dailyGoalRemaining,
  isDailyGoalComplete,
  summarizeDailyGoals,
} from "@/lib/focusDailyGoals";
import type { DailyGoalsStatus } from "@/hooks/use-daily-goals";

/**
 * TODAY'S GOALS — Compact Executive Agenda
 *
 * Minimal, precision-crafted daily agenda native to MAST's command layer.
 * Focuses on high-information density, quiet typography, and satisfying,
 * non-gamified micro-interactions.
 */

type Props = {
  status: DailyGoalsStatus;
  goals: DailyGoalInstance[];
  diagnostic: InsufficientGoalsDiagnostic | null;
  claimingGoalIds: Set<string>;
  onClaim: (goal: DailyGoalInstance, cardEl: HTMLElement | null) => void;
  onRetry: () => void;
};

export function FocusDailyGoals({
  status,
  goals,
  diagnostic,
  claimingGoalIds,
  onClaim,
  onRetry,
}: Props) {
  const summary = useMemo(() => summarizeDailyGoals(goals), [goals]);
  const showCount = status === "ready" && goals.length === DAILY_GOAL_COUNT;

  return (
    <section id="focus-goals" className="focus-goals-module" aria-labelledby="todays-goals-title">
      <div className="focus-module-header">
        <div className="focus-module-title-wrap">
          <h2 id="todays-goals-title" className="focus-module-title">
            TODAY'S GOALS
          </h2>
          {showCount && (
            <span className="focus-module-badge" data-testid="goals-complete-count">
              {summary.completedCount} / {DAILY_GOAL_COUNT} COMPLETE
            </span>
          )}
        </div>
      </div>

      <div className="focus-goals-card">
        {status === "ready" && goals.length === DAILY_GOAL_COUNT && (
          <ol className="fdg-list">
            {goals.map((goal) => (
              <DailyGoalRow
                key={goal.id}
                goal={goal}
                claiming={claimingGoalIds.has(goal.id)}
                onClaim={onClaim}
              />
            ))}
          </ol>
        )}

        {status === "loading" && <GoalsSkeleton />}

        {status === "error" && (
          <div className="fdg-message" role="status">
            <p className="fdg-message-text">We couldn't load today's goals.</p>
            <button type="button" className="fdg-btn" onClick={onRetry}>
              Try again
            </button>
          </div>
        )}

        {status === "insufficient" && <InsufficientState diagnostic={diagnostic} />}
      </div>

      <GoalStyles />
    </section>
  );
}

// ─── Row ─────────────────────────────────────────────────────────────────────

function DailyGoalRow({
  goal,
  claiming,
  onClaim,
}: {
  goal: DailyGoalInstance;
  claiming: boolean;
  onClaim: (goal: DailyGoalInstance, el: HTMLElement | null) => void;
}) {
  const rowRef = useRef<HTMLLIElement>(null);
  const complete = isDailyGoalComplete(goal);
  const claimed = Boolean(goal.claimed);
  const shown = Math.min(goal.progress, goal.target);
  const pct = goalPercent(goal);
  const actionLabel = goal.metadata.actionLabel || "Continue";

  const prevCompleteRef = useRef(complete);
  const [justCompleted, setJustCompleted] = useState(false);
  const [replayTick, setReplayTick] = useState(0);

  useEffect(() => {
    if (!prevCompleteRef.current && complete) {
      setJustCompleted(true);
      const timer = window.setTimeout(() => {
        setJustCompleted(false);
      }, 700);
      return () => window.clearTimeout(timer);
    }
    prevCompleteRef.current = complete;
  }, [complete]);

  const handleRowClick = (e: React.MouseEvent) => {
    // Prevent interfering with nested interactive buttons / links
    const target = e.target as HTMLElement;
    if (target.closest("a") || target.closest("button")) {
      return;
    }

    if (complete) {
      if (!claimed) {
        onClaim(goal, rowRef.current);
      } else {
        setReplayTick((t) => t + 1);
      }
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") {
      if (complete && claimed) {
        e.preventDefault();
        setReplayTick((t) => t + 1);
      }
    }
  };

  return (
    <li
      ref={rowRef}
      className={cn(
        "fdg-row",
        complete && "fdg-row-complete",
        claimed && "fdg-row-claimed",
        justCompleted && "fdg-row-just-completed",
        replayTick > 0 && "fdg-row-replaying"
      )}
      key={replayTick > 0 ? `r-${replayTick}` : undefined}
      data-testid="daily-goal-row"
      data-goal-id={goal.id}
      data-slot={goal.slot}
      data-state={complete ? (claimed ? "claimed" : "complete") : "active"}
      onClick={handleRowClick}
      onKeyDown={handleKeyDown}
      tabIndex={complete && claimed ? 0 : undefined}
      role={complete && claimed ? "button" : undefined}
      aria-label={
        complete && claimed
          ? `${goal.title}, completed. Tap to confirm.`
          : undefined
      }
    >
      {/* 1. Leading Slot Index / Checkmark */}
      <div className="fdg-leading">
        {complete ? (
          <div
            className={cn(
              "fdg-check-wrap",
              (justCompleted || replayTick > 0) && "fdg-check-pop"
            )}
          >
            <Check className="fdg-check-icon" aria-hidden="true" strokeWidth={2.5} />
          </div>
        ) : (
          <span className="fdg-index" aria-hidden="true">
            {String(goal.slot).padStart(2, "0")}
          </span>
        )}
      </div>

      {/* 2. Middle Content: Title + Subtitle/Description */}
      <div className="fdg-body">
        <div className="fdg-header-line">
          <h3 className="fdg-title">{goal.title}</h3>
        </div>

        {complete ? (
          <div className="fdg-status-line">
            <span className="fdg-status-complete">COMPLETE</span>
            <span className="fdg-status-dot" aria-hidden="true" />
            <span className="fdg-status-note">Persisted today</span>
          </div>
        ) : (
          goal.description && <p className="fdg-desc">{goal.description}</p>
        )}
      </div>

      {/* 3. Aside Metadata & Actions */}
      <div className="fdg-aside">
        <span
          className={cn("fdg-fraction", complete && "fdg-fraction-complete")}
          aria-label={`${shown} of ${goal.target}`}
        >
          {shown} / {goal.target}
        </span>

        {!complete && (
          <>
            <span className="fdg-xp">+{goal.xp} XP</span>
            <Link
              to={goal.metadata.actionTo}
              className="fdg-link"
              aria-label={`${actionLabel} for ${goal.title}`}
            >
              <span>{actionLabel}</span>
              <ArrowRight className="fdg-arrow" aria-hidden="true" />
            </Link>
          </>
        )}

        {complete && !claimed && (
          <button
            type="button"
            className={cn("fdg-btn fdg-btn-claim", claiming && "opacity-60")}
            disabled={claiming}
            onClick={(e) => {
              e.stopPropagation();
              onClaim(goal, rowRef.current);
            }}
          >
            CLAIM +{goal.xp} XP
          </button>
        )}

        {complete && claimed && (
          <span className="fdg-claimed">+{goal.xp} XP CLAIMED</span>
        )}
      </div>

      {/* 4. Precision 1.5px Integrated Track */}
      <div
        className="fdg-track"
        role="progressbar"
        aria-label={goal.title}
        aria-valuemin={0}
        aria-valuemax={goal.target}
        aria-valuenow={shown}
      >
        <div
          className={cn("fdg-fill", complete ? "fdg-fill-complete" : "fdg-fill-active")}
          style={{ width: `${pct}%` }}
        />
      </div>
    </li>
  );
}

// ─── Non-ready states ────────────────────────────────────────────────────────

function GoalsSkeleton() {
  return (
    <div className="fdg-list" aria-busy="true" aria-label="Loading today's goals">
      {Array.from({ length: DAILY_GOAL_COUNT }, (_, i) => (
        <div key={i} className="fdg-row fdg-row-skeleton">
          <div className="fdg-leading">
            <div
              className="mast-skeleton"
              style={{ height: "0.75rem", width: "1rem", borderRadius: "3px" }}
            />
          </div>
          <div className="fdg-body">
            <div
              className="mast-skeleton"
              style={{ height: "0.8125rem", width: "55%", borderRadius: "3px", marginBottom: "4px" }}
            />
            <div
              className="mast-skeleton"
              style={{ height: "0.625rem", width: "35%", borderRadius: "3px" }}
            />
          </div>
          <div className="fdg-aside">
            <div
              className="mast-skeleton"
              style={{ height: "0.6875rem", width: "3.25rem", borderRadius: "3px" }}
            />
          </div>
        </div>
      ))}
    </div>
  );
}

function InsufficientState({ diagnostic }: { diagnostic: InsufficientGoalsDiagnostic | null }) {
  const actions = useMemo(() => {
    const seen = new Set<string>();
    const out: { to: string; label: string }[] = [];
    for (const draft of diagnostic?.drafts ?? []) {
      const { actionTo, actionLabel } = draft.metadata;
      if (!actionTo || seen.has(actionTo)) continue;
      seen.add(actionTo);
      out.push({ to: actionTo, label: actionLabel });
    }
    return out;
  }, [diagnostic]);

  return (
    <div className="fdg-message">
      <p className="fdg-message-text">
        Your workspace needs a little more activity before MAST can build today's full agenda.
      </p>
      {actions.length > 0 && (
        <div className="fdg-message-actions">
          {actions.map((a) => (
            <Link key={a.to} to={a.to} className="fdg-link">
              <span>{a.label}</span>
              <ArrowRight className="fdg-arrow" aria-hidden="true" />
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Styles ──────────────────────────────────────────────────────────────────

function GoalStyles() {
  return (
    <style>{`
      .focus-goals-module {
        display: flex;
        flex-direction: column;
        height: 100%;
        min-width: 0;
      }

      .focus-goals-card {
        flex: 1;
        min-width: 0;
        background: var(--card, #12151e);
        border: 1px solid var(--border, rgba(255, 255, 255, 0.08));
        border-radius: 14px;
        overflow: hidden;
      }

      .fdg-list {
        list-style: none;
        margin: 0;
        padding: 0;
        display: flex;
        flex-direction: column;
      }

      /* Compact agenda item row (~46px tall, elegant precision) */
      .fdg-row {
        position: relative;
        display: flex;
        align-items: center;
        gap: 0.875rem;
        padding: 0.5625rem 1.125rem;
        border-bottom: 1px solid rgba(255, 255, 255, 0.05);
        min-width: 0;
        transition: background 150ms ease;
      }
      .fdg-row:last-child {
        border-bottom: none;
      }
      .fdg-row:hover {
        background: rgba(255, 255, 255, 0.02);
      }
      .fdg-row-claimed {
        cursor: pointer;
      }
      .fdg-row-claimed:hover {
        background: rgba(255, 255, 255, 0.025);
      }
      .fdg-row-claimed:focus-visible {
        outline: 1.5px solid var(--brand, #7c3aed);
        outline-offset: -1px;
      }

      /* Completion & Replay Sheen (Subtle, rewarding ambient wash) */
      .fdg-row-just-completed {
        animation: fdg-ambient-wash 700ms cubic-bezier(0.16, 1, 0.3, 1) forwards;
      }
      .fdg-row-replaying {
        animation: fdg-ambient-tap 350ms ease-out forwards;
      }

      @keyframes fdg-ambient-wash {
        0% { background: rgba(16, 185, 129, 0.08); }
        100% { background: transparent; }
      }
      @keyframes fdg-ambient-tap {
        0% { background: rgba(255, 255, 255, 0.035); }
        100% { background: transparent; }
      }

      /* Leading Slot Index / Checkmark */
      .fdg-leading {
        flex-shrink: 0;
        width: 1.25rem;
        display: flex;
        align-items: center;
        justify-content: center;
      }

      .fdg-index {
        font-family: var(--font-mono, monospace);
        font-size: 0.6875rem;
        font-weight: 600;
        letter-spacing: 0.04em;
        color: rgba(255, 255, 255, 0.3);
        font-variant-numeric: tabular-nums;
      }

      .fdg-check-wrap {
        width: 1.125rem;
        height: 1.125rem;
        border-radius: 50%;
        background: rgba(16, 185, 129, 0.12);
        border: 1px solid rgba(16, 185, 129, 0.3);
        color: #34d399;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        transition: transform 200ms cubic-bezier(0.34, 1.56, 0.64, 1);
      }

      .fdg-check-icon {
        width: 0.6875rem;
        height: 0.6875rem;
      }

      .fdg-check-pop {
        animation: fdg-micro-spring 450ms cubic-bezier(0.34, 1.56, 0.64, 1) forwards;
      }
      @keyframes fdg-micro-spring {
        0% { transform: scale(0.8); opacity: 0.7; }
        60% { transform: scale(1.18); }
        100% { transform: scale(1); opacity: 1; }
      }

      /* Middle Content */
      .fdg-body {
        flex: 1;
        min-width: 0;
        display: flex;
        flex-direction: column;
        gap: 0.1rem;
      }

      .fdg-header-line {
        display: flex;
        align-items: baseline;
        gap: 0.5rem;
        min-width: 0;
      }

      .fdg-title {
        margin: 0;
        font-size: 0.8125rem;
        font-weight: 550;
        line-height: 1.3;
        color: #ffffff;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        transition: color 200ms ease;
      }
      .fdg-row-complete .fdg-title {
        color: rgba(255, 255, 255, 0.78);
      }

      .fdg-desc {
        margin: 0;
        font-size: 0.6875rem;
        line-height: 1.35;
        color: rgba(255, 255, 255, 0.4);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }

      /* Clean, native completion metadata */
      .fdg-status-line {
        display: inline-flex;
        align-items: center;
        gap: 0.35rem;
      }

      .fdg-status-complete {
        font-family: var(--font-mono, monospace);
        font-size: 0.625rem;
        font-weight: 700;
        letter-spacing: 0.06em;
        color: #34d399;
      }

      .fdg-status-dot {
        width: 3px;
        height: 3px;
        border-radius: 50%;
        background: rgba(255, 255, 255, 0.2);
      }

      .fdg-status-note {
        font-size: 0.65rem;
        color: rgba(255, 255, 255, 0.35);
      }

      /* Aside Metadata */
      .fdg-aside {
        flex-shrink: 0;
        display: flex;
        align-items: center;
        gap: 0.75rem;
      }

      .fdg-fraction {
        font-family: var(--font-mono, monospace);
        font-size: 0.6875rem;
        color: rgba(255, 255, 255, 0.5);
        font-variant-numeric: tabular-nums;
      }
      .fdg-fraction-complete {
        color: rgba(255, 255, 255, 0.3);
      }

      .fdg-xp {
        font-family: var(--font-mono, monospace);
        font-size: 0.6875rem;
        font-weight: 600;
        color: rgba(255, 255, 255, 0.55);
      }

      .fdg-claimed {
        font-family: var(--font-mono, monospace);
        font-size: 0.625rem;
        font-weight: 600;
        letter-spacing: 0.04em;
        color: rgba(255, 255, 255, 0.4);
      }

      .fdg-link {
        display: inline-flex;
        align-items: center;
        gap: 0.25rem;
        font-size: 0.6875rem;
        font-weight: 550;
        color: rgba(255, 255, 255, 0.75);
        text-decoration: none;
        padding: 0.2rem 0.45rem;
        border-radius: 4px;
        background: rgba(255, 255, 255, 0.04);
        border: 1px solid rgba(255, 255, 255, 0.08);
        transition: color 150ms ease, background 150ms ease, border-color 150ms ease;
      }
      .fdg-link:hover {
        color: #ffffff;
        background: rgba(255, 255, 255, 0.08);
        border-color: rgba(255, 255, 255, 0.16);
      }
      .fdg-arrow {
        width: 0.6875rem;
        height: 0.6875rem;
        transition: transform 150ms ease;
      }
      .fdg-link:hover .fdg-arrow {
        transform: translateX(2px);
      }

      .fdg-btn {
        font-size: 0.75rem;
        font-weight: 600;
        color: rgba(255, 255, 255, 0.85);
        background: transparent;
        border: 1px solid var(--border, rgba(255, 255, 255, 0.16));
        padding: 0.3rem 0.75rem;
        border-radius: 6px;
        cursor: pointer;
        transition: background 150ms ease, border-color 150ms ease;
      }
      .fdg-btn:hover:not(:disabled) {
        background: rgba(255, 255, 255, 0.06);
      }
      .fdg-btn:disabled {
        opacity: 0.5;
        cursor: default;
      }

      .fdg-btn-claim {
        font-family: var(--font-mono, monospace);
        font-size: 0.625rem;
        font-weight: 700;
        letter-spacing: 0.04em;
        color: #34d399;
        background: rgba(16, 185, 129, 0.1);
        border: 1px solid rgba(16, 185, 129, 0.25);
        padding: 0.2rem 0.55rem;
        border-radius: 4px;
        cursor: pointer;
        transition: background 150ms ease, border-color 150ms ease;
      }
      .fdg-btn-claim:hover:not(:disabled) {
        background: rgba(16, 185, 129, 0.18);
        border-color: rgba(16, 185, 129, 0.4);
      }

      /* Precision 1.5px Hairline Integrated Track */
      .fdg-track {
        position: absolute;
        bottom: 0;
        left: 0;
        right: 0;
        height: 1.5px;
        background: rgba(255, 255, 255, 0.04);
        overflow: hidden;
      }

      .fdg-fill {
        height: 100%;
        transition: width 450ms cubic-bezier(0.16, 1, 0.3, 1), background-color 300ms ease;
      }
      .fdg-fill-active {
        background: var(--brand, #7c3aed);
      }
      .fdg-fill-complete {
        background: #10b981;
      }

      /* Skeleton */
      .fdg-row-skeleton {
        gap: 0.875rem;
      }

      /* Messages */
      .fdg-message {
        display: flex;
        flex-direction: column;
        align-items: flex-start;
        gap: 0.875rem;
        padding: 1.25rem 1.375rem;
      }
      .fdg-message-text {
        margin: 0;
        font-size: 0.8125rem;
        line-height: 1.5;
        color: rgba(255, 255, 255, 0.65);
      }
      .fdg-message-actions {
        display: flex;
        flex-wrap: wrap;
        gap: 0.5rem 1.25rem;
      }

      /* Responsive adjustments */
      @media (max-width: 640px) {
        .fdg-row {
          padding: 0.5rem 0.875rem;
          gap: 0.625rem;
        }
        .fdg-aside {
          gap: 0.5rem;
        }
        .fdg-title {
          font-size: 0.775rem;
        }
        .fdg-desc {
          font-size: 0.65rem;
        }
      }

      @media (max-width: 420px) {
        .fdg-row {
          padding: 0.45rem 0.625rem;
          gap: 0.5rem;
        }
        .fdg-aside {
          gap: 0.375rem;
        }
        .fdg-link span {
          display: none;
        }
        .fdg-link {
          padding: 0.2rem 0.35rem;
        }
      }

      @media (prefers-reduced-motion: reduce) {
        .fdg-check-pop,
        .fdg-row-just-completed,
        .fdg-row-replaying,
        .fdg-fill {
          animation: none !important;
          transition: none !important;
        }
      }
    `}</style>
  );
}
