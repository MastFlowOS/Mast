import { useMemo, useRef } from "react";
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
 * TODAY'S GOALS — the user's agenda for the local day.
 *
 * Renders the persisted set of exactly four Daily Goals, in slot order.
 * Completing a goal only changes that row (progress / COMPLETE / claim state):
 * rows never disappear, move, or get replaced, and there is never a fifth.
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
  const remaining = dailyGoalRemaining(goal);
  const shown = Math.min(goal.progress, goal.target);
  const pct = goalPercent(goal);
  const actionLabel = goal.metadata.actionLabel || "Continue";

  return (
    <li
      ref={rowRef}
      className={cn("fdg-row", complete && "fdg-row-complete")}
      data-testid="daily-goal-row"
      data-goal-id={goal.id}
      data-slot={goal.slot}
      data-state={complete ? (claimed ? "claimed" : "complete") : "active"}
    >
      <span className="fdg-index" aria-hidden="true">
        {String(goal.slot).padStart(2, "0")}
      </span>

      <div className="fdg-body">
        <div className="fdg-top">
          <h3 className="fdg-title">{goal.title}</h3>
          <span className="fdg-fraction" aria-label={`${shown} of ${goal.target}`}>
            {shown} / {goal.target}
          </span>
        </div>

        {goal.description && <p className="fdg-desc">{goal.description}</p>}

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

        <div className="fdg-foot">
          {complete ? (
            <span className="fdg-status fdg-status-complete">
              <Check className="fdg-check" aria-hidden="true" />
              COMPLETE
            </span>
          ) : (
            <span className="fdg-status">{remaining} remaining</span>
          )}

          <div className="fdg-actions">
            {!complete && (
              <>
                <span className="fdg-xp">+{goal.xp} XP</span>
                <Link to={goal.metadata.actionTo} className="fdg-link">
                  <span>{actionLabel}</span>
                  <ArrowRight className="fdg-arrow" aria-hidden="true" />
                </Link>
              </>
            )}
            {complete && !claimed && (
              <button
                type="button"
                className="fdg-btn fdg-btn-claim"
                disabled={claiming}
                onClick={() => onClaim(goal, rowRef.current)}
              >
                CLAIM +{goal.xp} XP
              </button>
            )}
            {complete && claimed && <span className="fdg-claimed">+{goal.xp} XP CLAIMED</span>}
          </div>
        </div>
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
          <div
            className="mast-skeleton"
            style={{ height: "0.875rem", width: "55%", borderRadius: "4px" }}
          />
          <div
            className="mast-skeleton"
            style={{ height: "4px", width: "100%", borderRadius: "99px" }}
          />
        </div>
      ))}
    </div>
  );
}

function InsufficientState({ diagnostic }: { diagnostic: InsufficientGoalsDiagnostic | null }) {
  // Only real, currently-available actions: the routes of goals that could
  // legitimately be formed today. No diagnostics, codes, or filler goals.
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

      .fdg-row {
        display: flex;
        align-items: flex-start;
        gap: 0.875rem;
        padding: 1rem 1.375rem;
        border-bottom: 1px solid rgba(255, 255, 255, 0.05);
        min-width: 0;
      }
      .fdg-row:last-child { border-bottom: none; }
      .fdg-row-skeleton { flex-direction: column; gap: 0.75rem; }

      .fdg-index {
        flex-shrink: 0;
        width: 1.5rem;
        padding-top: 0.125rem;
        font-family: var(--font-mono, monospace);
        font-size: 0.6875rem;
        font-weight: 700;
        letter-spacing: 0.04em;
        color: rgba(255, 255, 255, 0.35);
        font-variant-numeric: tabular-nums;
      }

      .fdg-body {
        flex: 1;
        min-width: 0;
        display: flex;
        flex-direction: column;
        gap: 0.4375rem;
      }

      .fdg-top {
        display: flex;
        align-items: baseline;
        justify-content: space-between;
        gap: 0.75rem;
      }

      .fdg-title {
        margin: 0;
        min-width: 0;
        font-size: 0.875rem;
        font-weight: 600;
        line-height: 1.3;
        color: #ffffff;
        overflow-wrap: anywhere;
      }

      .fdg-fraction {
        flex-shrink: 0;
        font-family: var(--font-mono, monospace);
        font-size: 0.75rem;
        color: rgba(255, 255, 255, 0.55);
        font-variant-numeric: tabular-nums;
      }

      .fdg-desc {
        margin: 0;
        font-size: 0.75rem;
        line-height: 1.45;
        color: rgba(255, 255, 255, 0.5);
        overflow-wrap: anywhere;
      }

      .fdg-track {
        height: 4px;
        border-radius: 99px;
        background: rgba(255, 255, 255, 0.08);
        overflow: hidden;
      }

      .fdg-fill {
        height: 100%;
        border-radius: 99px;
        transition: width 350ms ease;
      }
      .fdg-fill-active { background: var(--brand, #7c3aed); }
      .fdg-fill-complete { background: #10b981; }

      .fdg-foot {
        display: flex;
        align-items: center;
        justify-content: space-between;
        flex-wrap: wrap;
        gap: 0.5rem 0.75rem;
        min-height: 1.5rem;
      }

      .fdg-status {
        display: inline-flex;
        align-items: center;
        gap: 0.3rem;
        font-family: var(--font-mono, monospace);
        font-size: 0.6875rem;
        color: rgba(255, 255, 255, 0.45);
      }
      .fdg-status-complete {
        font-weight: 700;
        letter-spacing: 0.04em;
        color: #34d399;
      }
      .fdg-check { width: 0.75rem; height: 0.75rem; }

      .fdg-actions {
        display: flex;
        align-items: center;
        flex-wrap: wrap;
        justify-content: flex-end;
        gap: 0.5rem 0.875rem;
        min-width: 0;
      }

      .fdg-xp {
        font-family: var(--font-mono, monospace);
        font-size: 0.6875rem;
        font-weight: 600;
        color: rgba(255, 255, 255, 0.4);
      }

      .fdg-claimed {
        font-family: var(--font-mono, monospace);
        font-size: 0.625rem;
        font-weight: 700;
        letter-spacing: 0.04em;
        color: #fbbf24;
      }

      .fdg-link {
        display: inline-flex;
        align-items: center;
        gap: 0.3rem;
        font-size: 0.75rem;
        font-weight: 600;
        color: rgba(255, 255, 255, 0.85);
        text-decoration: none;
        transition: color 150ms ease;
      }
      .fdg-link:hover { color: #ffffff; }
      .fdg-link:focus-visible,
      .fdg-btn:focus-visible {
        outline: 2px solid var(--brand, #7c3aed);
        outline-offset: 2px;
        border-radius: 4px;
      }
      .fdg-arrow { width: 0.75rem; height: 0.75rem; transition: transform 150ms ease; }
      .fdg-link:hover .fdg-arrow { transform: translateX(2px); }

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
      .fdg-btn:hover:not(:disabled) { background: rgba(255, 255, 255, 0.06); }
      .fdg-btn:disabled { opacity: 0.5; cursor: default; }

      .fdg-btn-claim {
        font-family: var(--font-mono, monospace);
        font-size: 0.625rem;
        font-weight: 700;
        letter-spacing: 0.04em;
        color: #34d399;
        background: rgba(52, 211, 153, 0.1);
        border: 1px solid rgba(52, 211, 153, 0.25);
        padding: 0.25rem 0.625rem;
        border-radius: 4px;
      }
      .fdg-btn-claim:hover:not(:disabled) {
        background: rgba(52, 211, 153, 0.2);
        border-color: rgba(52, 211, 153, 0.4);
      }

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

      @media (max-width: 640px) {
        .fdg-row { padding: 0.875rem 1rem; gap: 0.625rem; }
      }
    `}</style>
  );
}
