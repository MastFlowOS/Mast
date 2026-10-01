import { useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import {
  ArrowRight,
  CalendarCheck,
  CalendarPlus,
  Check,
  FileText,
  Globe,
  MessagesSquare,
  Search,
  Send,
  Sparkles,
  Users,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import {
  DAILY_GOAL_COUNT,
  goalPercent,
  type DailyGoalInstance,
  type InsufficientGoalsDiagnostic,
} from "@/lib/dailyGoals";
import { isDailyGoalComplete, summarizeDailyGoals } from "@/lib/focusDailyGoals";
import type { DailyGoalsStatus } from "@/hooks/use-daily-goals";

/**
 * TODAY'S GOALS
 *
 * Three visual states per goal, matching the design reference:
 *   active    -> indigo icon tile, progress, XP, arrow to the action
 *   complete  -> gold, glowing, collectible row with a CLAIM +XP button
 *   claimed   -> dimmed dark-grey row, struck-through title, CLAIMED pill
 *
 * Visual redesign only: props, claim flow, replay-on-tap and data attributes
 * are unchanged.
 */

type Props = {
  status: DailyGoalsStatus;
  goals: DailyGoalInstance[];
  diagnostic: InsufficientGoalsDiagnostic | null;
  claimingGoalIds: Set<string>;
  onClaim: (goal: DailyGoalInstance, cardEl: HTMLElement | null) => void;
  onRetry: () => void;
};

const ICON_BY_DEFINITION: Record<string, LucideIcon> = {
  "discovery.discover_new": Search,
  "discovery.explore_country": Globe,
  "outreach.start_conversations": Send,
  "outreach.reconnect": MessagesSquare,
  "relationships.add_relationship": Users,
  "workspace.add_context": FileText,
  "follow_through.clear_due": CalendarCheck,
  "follow_through.schedule_next_steps": CalendarPlus,
};

const ICON_BY_FAMILY: Record<string, LucideIcon> = {
  discovery: Search,
  outreach: Send,
  relationships: Users,
  workspace: FileText,
  follow_through: CalendarCheck,
};

const goalIcon = (goal: DailyGoalInstance): LucideIcon =>
  ICON_BY_DEFINITION[goal.definitionId] ?? ICON_BY_FAMILY[goal.family] ?? Send;


// ─── Claim ordering ──────────────────────────────────────────────────────────

/** After the claim, let the row dim in place, then send it to the bottom. */
const MOVE_DELAY_MS = 700;
const MOVE_DURATION_MS = 650;

/**
 * Collected goals sink to the bottom of the list.
 *
 * Active -> Completed (stays in place, CLAIM visible) -> CLAIM -> dim -> move.
 *
 * - A goal that is merely completed never moves; it waits for you to claim it.
 * - Goals already claimed when first seen (page load, new day) are placed at
 *   the bottom immediately, with no animation.
 * - A goal claimed while you watch dims in place, then moves to the very bottom
 *   after MOVE_DELAY_MS (the FLIP animation lives in the list).
 * - Unclaimed goals keep their persisted slot order; claimed goals stay in the
 *   order they were claimed. Display order only: data is never touched.
 */
function useCompletionOrder(goals: DailyGoalInstance[]): DailyGoalInstance[] {
  const [, force] = useReducer((n: number) => n + 1, 0);
  const seen = useRef(new Set<string>());
  const moved = useRef<string[]>([]);
  const prevClaimed = useRef(new Map<string, boolean>());
  const timers = useRef(new Map<string, number>());

  // Render phase (idempotent): drop goals from other days, place goals that
  // were already claimed the first time we see them.
  const idSet = new Set(goals.map((g) => g.id));
  moved.current = moved.current.filter((id) => idSet.has(id));
  const initial = goals
    .filter((g) => !seen.current.has(g.id) && Boolean(g.claimed))
    .sort(
      (a, b) =>
        (a.completedAt ? Date.parse(a.completedAt) : Infinity) -
          (b.completedAt ? Date.parse(b.completedAt) : Infinity) || a.slot - b.slot,
    );
  goals.forEach((g) => seen.current.add(g.id));
  for (const g of initial) if (!moved.current.includes(g.id)) moved.current.push(g.id);

  // Effect: schedule the move for goals claimed while mounted.
  useEffect(() => {
    const reduce =
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    for (const g of goals) {
      const claimed = Boolean(g.claimed);
      const was = prevClaimed.current.get(g.id);
      prevClaimed.current.set(g.id, claimed);
      if (was !== false || !claimed) continue;
      if (moved.current.includes(g.id) || timers.current.has(g.id)) continue;
      const t = window.setTimeout(
        () => {
          timers.current.delete(g.id);
          if (!moved.current.includes(g.id)) moved.current = [...moved.current, g.id];
          force();
        },
        reduce ? 0 : MOVE_DELAY_MS,
      );
      timers.current.set(g.id, t);
    }
  }, [goals]);

  useEffect(
    () => () => {
      timers.current.forEach((t) => window.clearTimeout(t));
      timers.current.clear();
    },
    [],
  );

  const byId = new Map(goals.map((g) => [g.id, g]));
  const rest = goals.filter((g) => !moved.current.includes(g.id));
  const tail = moved.current.map((id) => byId.get(id)).filter(Boolean) as DailyGoalInstance[];
  return [...rest, ...tail];
}

/** FLIP: when the order changes, slide every row from its old spot to its new one. */
function useFlipList(listRef: React.RefObject<HTMLOListElement | null>, orderKey: string) {
  const prevTops = useRef(new Map<string, number>());
  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const reduce =
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const next = new Map<string, number>();
    const rows = Array.from(list.children).filter(
      (el): el is HTMLElement => el instanceof HTMLElement && el.hasAttribute("data-goal-id"),
    );
    // Largest drop = the row that was just claimed; keep it above the others.
    let maxDrop = 0;
    for (const el of rows) {
      const prev = prevTops.current.get(el.dataset.goalId!);
      if (prev !== undefined) maxDrop = Math.max(maxDrop, el.offsetTop - prev);
    }
    for (const el of rows) {
      const id = el.dataset.goalId!;
      const top = el.offsetTop;
      next.set(id, top);
      const prev = prevTops.current.get(id);
      if (reduce || prev === undefined || prev === top || typeof el.animate !== "function") continue;
      const dy = prev - top;
      const isMover = dy < 0 && -dy === maxDrop;
      el.getAnimations?.().forEach((a) => (a as Animation & { id: string }).id === "fdg-flip" && a.cancel());
      const anim = el.animate(
        isMover
          ? [
              { translate: `0 ${dy}px`, scale: "1" },
              { translate: `0 ${dy * 0.5}px`, scale: "0.975", offset: 0.5 },
              { translate: "0 0", scale: "1" },
            ]
          : [{ translate: `0 ${dy}px` }, { translate: "0 0" }],
        { duration: MOVE_DURATION_MS, easing: "cubic-bezier(0.22, 1, 0.36, 1)" },
      );
      anim.id = "fdg-flip";
      if (isMover) {
        el.style.zIndex = "2";
        const clear = () => {
          el.style.zIndex = "";
        };
        anim.onfinish = clear;
        anim.oncancel = clear;
      }
    }
    prevTops.current = next;
  }, [listRef, orderKey]);
}

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
  const orderedGoals = useCompletionOrder(goals);
  const listRef = useRef<HTMLOListElement>(null);
  useFlipList(listRef, orderedGoals.map((g) => g.id).join("|"));

  return (
    <section id="focus-goals" className="focus-goals-module" aria-labelledby="todays-goals-title">
      <div className="focus-goals-card">
        <div className="fdg-head">
          <h2 id="todays-goals-title" className="fdg-head-title">
            TODAY'S GOALS
          </h2>
          {showCount && (
            <span className="fdg-head-count" data-testid="goals-complete-count">
              {summary.completedCount} / {DAILY_GOAL_COUNT}{" "}
              <span className="fdg-head-count-label">COMPLETE</span>
            </span>
          )}
        </div>

        {status === "ready" && goals.length === DAILY_GOAL_COUNT && (
          <ol className="fdg-list" ref={listRef}>
            {orderedGoals.map((goal) => (
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
  const Icon = goalIcon(goal);

  const prevCompleteRef = useRef(complete);
  const prevClaimedRef = useRef(claimed);
  const [justCompleted, setJustCompleted] = useState(false);
  const [justClaimed, setJustClaimed] = useState(false);
  const [replayTick, setReplayTick] = useState(0);

  // active -> complete: animate into the highlighted, collectible state.
  useEffect(() => {
    const was = prevCompleteRef.current;
    prevCompleteRef.current = complete;
    if (!was && complete) {
      setJustCompleted(true);
      const timer = window.setTimeout(() => setJustCompleted(false), 1100);
      return () => window.clearTimeout(timer);
    }
  }, [complete]);

  // complete -> claimed: animate into the dimmed state.
  useEffect(() => {
    const was = prevClaimedRef.current;
    prevClaimedRef.current = claimed;
    if (!was && claimed) {
      setJustClaimed(true);
      const timer = window.setTimeout(() => setJustClaimed(false), 1100);
      return () => window.clearTimeout(timer);
    }
  }, [claimed]);

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
        claiming && "fdg-row-claiming",
        justCompleted && "fdg-row-just-completed",
        justClaimed && "fdg-row-just-claimed",
        replayTick > 0 && "fdg-row-replaying",
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
        complete && claimed ? `${goal.title}, completed. Tap to confirm.` : undefined
      }
    >
      <span className="fdg-sheen" aria-hidden="true" />

      {/* 1. Leading tile: goal icon morphs into the check badge */}
      <div className="fdg-tile">
        <Icon className="fdg-tile-icon" aria-hidden="true" strokeWidth={1.75} />
        <span
          className={cn(
            "fdg-badge",
            (justCompleted || replayTick > 0) && "fdg-badge-pop",
          )}
          aria-hidden="true"
        >
          <Check className="fdg-badge-check" strokeWidth={3} />
        </span>
      </div>

      {/* 2. Title + description */}
      <div className="fdg-body">
        <h3 className="fdg-title">{goal.title}</h3>
        {goal.description && <p className="fdg-desc">{goal.description}</p>}
      </div>

      {/* 3. Progress + XP */}
      <div className="fdg-meta">
        <span className="fdg-fraction" aria-label={`${shown} of ${goal.target}`}>
          {shown} / {goal.target}
        </span>
        <span className="fdg-xp">+{goal.xp} XP</span>
      </div>

      {/* 4. Action */}
      <div className="fdg-action">
        {!complete && (
          <Link
            to={goal.metadata.actionTo}
            className="fdg-go"
            aria-label={`${actionLabel} for ${goal.title}`}
            title={actionLabel}
          >
            <ArrowRight className="fdg-go-arrow" aria-hidden="true" />
          </Link>
        )}

        {complete && !claimed && (
          <button
            type="button"
            className={cn("fdg-claim-btn", claiming && "fdg-claim-btn-busy")}
            disabled={claiming}
            onClick={(e) => {
              e.stopPropagation();
              onClaim(goal, rowRef.current);
            }}
          >
            <Sparkles className="fdg-claim-spark" aria-hidden="true" strokeWidth={2} />
            <span>CLAIM +{goal.xp} XP</span>
          </button>
        )}

        {complete && claimed && (
          <span className="fdg-claimed-pill" aria-label={`${goal.xp} XP claimed`}>
            <Check className="fdg-claimed-check" aria-hidden="true" strokeWidth={2} />
            <span>CLAIMED</span>
          </span>
        )}
      </div>

      {/* Hairline progress (only shows for partial progress) */}
      <div
        className="fdg-track"
        role="progressbar"
        aria-label={goal.title}
        aria-valuemin={0}
        aria-valuemax={goal.target}
        aria-valuenow={shown}
      >
        <div className="fdg-fill" style={{ width: `${pct}%` }} />
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
          <div className="fdg-tile fdg-tile-skeleton">
            <div className="mast-skeleton" style={{ height: "100%", width: "100%", borderRadius: "8px" }} />
          </div>
          <div className="fdg-body">
            <div
              className="mast-skeleton"
              style={{ height: "0.875rem", width: "50%", borderRadius: "4px", marginBottom: "6px" }}
            />
            <div className="mast-skeleton" style={{ height: "0.6875rem", width: "70%", borderRadius: "4px" }} />
          </div>
          <div className="fdg-meta">
            <div className="mast-skeleton" style={{ height: "0.75rem", width: "2.5rem", borderRadius: "4px" }} />
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
        --fdg-gold: #f7c948;
        --fdg-gold-soft: rgba(247, 201, 72, 0.14);
        --fdg-indigo: rgba(129, 140, 248, 0.42);
        --fdg-ease: cubic-bezier(0.22, 1, 0.36, 1);
        display: flex;
        flex-direction: column;
        height: 100%;
        min-width: 0;
      }

      .focus-goals-card {
        flex: 1;
        min-width: 0;
        padding: 0.75rem 0.75rem 0.75rem;
        background:
          radial-gradient(120% 80% at 50% -10%, rgba(99, 102, 241, 0.06), transparent 60%),
          linear-gradient(180deg, rgba(17, 21, 34, 0.96), rgba(11, 14, 24, 0.98));
        border: 1px solid rgba(255, 255, 255, 0.07);
        border-radius: 14px;
        box-shadow: 0 1px 0 rgba(255, 255, 255, 0.03) inset, 0 12px 28px -20px rgba(0, 0, 0, 0.7);
      }

      /* Header */
      .fdg-head {
        display: flex;
        align-items: baseline;
        justify-content: space-between;
        gap: 1rem;
        padding: 0.125rem 0.375rem 0.625rem;
      }
      .fdg-head-title {
        margin: 0;
        font-size: 0.75rem;
        font-weight: 500;
        letter-spacing: 0.18em;
        line-height: 1.2;
        color: rgba(255, 255, 255, 0.92);
      }
      .fdg-head-count {
        font-size: 0.6875rem;
        font-weight: 450;
        letter-spacing: 0.04em;
        color: rgba(255, 255, 255, 0.82);
        font-variant-numeric: tabular-nums;
        white-space: nowrap;
      }
      .fdg-head-count-label {
        font-size: 0.625rem;
        letter-spacing: 0.08em;
        color: rgba(255, 255, 255, 0.5);
      }

      .fdg-list {
        position: relative;
        list-style: none;
        margin: 0;
        padding: 0;
        display: flex;
        flex-direction: column;
        gap: 0.3125rem;
      }

      /* ── Row: ACTIVE ───────────────────────────────────────────── */
      .fdg-row {
        position: relative;
        display: grid;
        grid-template-columns: 2rem minmax(0, 1fr) auto 6.25rem;
        align-items: center;
        column-gap: 0.625rem;
        min-height: 2.75rem;
        padding: 0.3125rem 0.5rem 0.3125rem 0.3125rem;
        border-radius: 10px;
        border: 1px solid rgba(255, 255, 255, 0.06);
        background: linear-gradient(90deg, rgba(255, 255, 255, 0.03), rgba(255, 255, 255, 0.018));
        overflow: hidden;
        min-width: 0;
        transition:
          background 650ms var(--fdg-ease),
          border-color 650ms var(--fdg-ease),
          box-shadow 650ms var(--fdg-ease);
      }
      .fdg-row:not(.fdg-row-complete):hover {
        border-color: rgba(255, 255, 255, 0.11);
      }

      /* Sheen sweep (idle: off-canvas) */
      .fdg-sheen {
        position: absolute;
        inset: 0;
        pointer-events: none;
        opacity: 0;
        transform: translateX(-110%);
        background: linear-gradient(105deg, transparent 32%, rgba(255, 220, 120, 0.22) 50%, transparent 68%);
      }

      /* Leading tile */
      .fdg-tile {
        position: relative;
        width: 2rem;
        height: 2rem;
        border-radius: 8px;
        display: grid;
        place-items: center;
        background: rgba(99, 102, 241, 0.07);
        border: 1px solid var(--fdg-indigo);
        box-shadow: 0 0 10px -4px rgba(129, 140, 248, 0.45);
        color: rgba(255, 255, 255, 0.95);
        transition:
          background 600ms var(--fdg-ease),
          border-color 600ms var(--fdg-ease),
          box-shadow 600ms var(--fdg-ease);
      }
      .fdg-tile-icon {
        grid-area: 1 / 1;
        width: 1rem;
        height: 1rem;
        transition: opacity 320ms ease, transform 420ms var(--fdg-ease);
      }
      .fdg-badge {
        grid-area: 1 / 1;
        position: relative;
        width: 1.25rem;
        height: 1.25rem;
        border-radius: 50%;
        display: grid;
        place-items: center;
        background: var(--fdg-gold);
        color: #2a1f05;
        opacity: 0;
        transform: scale(0.4);
        transition:
          opacity 380ms ease 80ms,
          transform 520ms cubic-bezier(0.34, 1.56, 0.64, 1) 80ms,
          background 650ms var(--fdg-ease),
          color 650ms var(--fdg-ease),
          box-shadow 650ms var(--fdg-ease);
      }
      .fdg-badge-check {
        width: 0.6875rem;
        height: 0.6875rem;
      }
      /* Ring burst (idle: invisible) */
      .fdg-badge::after {
        content: "";
        position: absolute;
        inset: -1px;
        border-radius: 50%;
        border: 1.5px solid var(--fdg-gold);
        opacity: 0;
        pointer-events: none;
      }

      /* Title / description */
      .fdg-body {
        min-width: 0;
        display: flex;
        flex-direction: column;
        gap: 0.0625rem;
      }
      .fdg-title {
        margin: 0;
        width: fit-content;
        max-width: 100%;
        font-size: 0.8125rem;
        font-weight: 500;
        line-height: 1.25;
        color: #f4f6fb;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        /* animatable strike-through */
        background: linear-gradient(currentColor, currentColor) no-repeat 0 56% / 0% 1px;
        transition: color 600ms var(--fdg-ease), background-size 520ms var(--fdg-ease) 120ms;
      }
      .fdg-desc {
        margin: 0;
        font-size: 0.6875rem;
        line-height: 1.3;
        color: rgba(255, 255, 255, 0.5);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        transition: color 600ms var(--fdg-ease);
      }

      /* Progress + XP */
      .fdg-meta {
        display: grid;
        grid-template-columns: 2.5rem 3.25rem;
        align-items: center;
        justify-items: center;
        column-gap: 0.25rem;
      }
      .fdg-fraction {
        font-size: 0.75rem;
        color: rgba(255, 255, 255, 0.78);
        font-variant-numeric: tabular-nums;
        transition: color 600ms var(--fdg-ease);
      }
      .fdg-xp {
        font-size: 0.75rem;
        font-weight: 600;
        letter-spacing: 0.01em;
        color: var(--fdg-gold);
        white-space: nowrap;
        font-variant-numeric: tabular-nums;
        transition: color 600ms var(--fdg-ease), opacity 600ms var(--fdg-ease);
      }

      /* Action column */
      .fdg-action {
        display: flex;
        justify-content: flex-end;
        align-items: center;
      }
      .fdg-go {
        width: 1.75rem;
        height: 1.75rem;
        display: grid;
        place-items: center;
        border-radius: 8px;
        color: rgba(255, 255, 255, 0.9);
        background: rgba(255, 255, 255, 0.035);
        border: 1px solid rgba(255, 255, 255, 0.1);
        text-decoration: none;
        transition: background 160ms ease, border-color 160ms ease, transform 160ms ease;
      }
      .fdg-go:hover {
        background: rgba(255, 255, 255, 0.08);
        border-color: rgba(255, 255, 255, 0.2);
      }
      .fdg-go:focus-visible,
      .fdg-claim-btn:focus-visible {
        outline: 2px solid rgba(165, 180, 252, 0.8);
        outline-offset: 2px;
      }
      .fdg-go-arrow {
        width: 0.875rem;
        height: 0.875rem;
        transition: transform 160ms ease;
      }
      .fdg-go:hover .fdg-go-arrow {
        transform: translateX(2px);
      }

      /* Hairline progress (hidden at 0 and when complete) */
      .fdg-track {
        position: absolute;
        left: 0.375rem;
        right: 0.375rem;
        bottom: 0;
        height: 1.5px;
        border-radius: 2px;
        overflow: hidden;
        opacity: 0;
        transition: opacity 400ms ease;
      }
      .fdg-fill {
        height: 100%;
        background: linear-gradient(90deg, rgba(129, 140, 248, 0.2), rgba(129, 140, 248, 0.9));
        transition: width 450ms var(--fdg-ease);
      }
      .fdg-row:not(.fdg-row-complete) .fdg-track {
        opacity: 1;
      }

      /* ── Row: COMPLETE (before collection) ─────────────────────── */
      .fdg-row-complete:not(.fdg-row-claimed) {
        cursor: pointer;
        border-color: rgba(247, 201, 72, 0.5);
        background:
          linear-gradient(90deg, rgba(247, 201, 72, 0.12), rgba(247, 201, 72, 0.045) 60%, rgba(247, 201, 72, 0.07));
        box-shadow: 0 0 0 1px rgba(247, 201, 72, 0.08) inset, 0 0 16px -6px rgba(247, 190, 60, 0.26);
        animation: fdg-glow-breathe 3.2s ease-in-out 1.2s infinite;
      }
      .fdg-row-complete:not(.fdg-row-claimed) .fdg-tile {
        background: rgba(247, 201, 72, 0.06);
        border-color: rgba(247, 201, 72, 0.22);
        box-shadow: none;
      }
      .fdg-row-complete .fdg-tile-icon {
        opacity: 0;
        transform: scale(0.5) rotate(-20deg);
      }
      .fdg-row-complete .fdg-badge {
        opacity: 1;
        transform: scale(1);
        box-shadow: 0 0 18px rgba(247, 201, 72, 0.55);
      }
      .fdg-row-complete .fdg-fraction {
        color: rgba(255, 255, 255, 0.82);
      }
      .fdg-row-complete .fdg-track {
        opacity: 0;
      }

      /* Claim button */
      .fdg-claim-btn {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 0.3125rem;
        width: 100%;
        height: 1.75rem;
        padding: 0 0.5rem;
        font-size: 0.625rem;
        font-weight: 600;
        letter-spacing: 0.04em;
        white-space: nowrap;
        color: var(--fdg-gold);
        background: rgba(247, 201, 72, 0.07);
        border: 1px solid rgba(247, 201, 72, 0.85);
        border-radius: 7px;
        box-shadow: 0 0 12px -4px rgba(247, 190, 60, 0.45);
        cursor: pointer;
        transition: background 180ms ease, box-shadow 180ms ease, transform 120ms ease;
      }
      .fdg-claim-btn:hover:not(:disabled) {
        background: rgba(247, 201, 72, 0.16);
        box-shadow: 0 0 16px -2px rgba(247, 190, 60, 0.55);
      }
      .fdg-claim-btn:active:not(:disabled) {
        transform: scale(0.97);
      }
      .fdg-claim-btn:disabled {
        cursor: default;
      }
      .fdg-claim-btn-busy {
        animation: fdg-btn-busy 900ms ease-in-out infinite;
      }
      .fdg-claim-spark {
        width: 0.75rem;
        height: 0.75rem;
      }

      /* ── Row: CLAIMED (dimmed, dark grey) ──────────────────────── */
      .fdg-row-claimed {
        cursor: pointer;
        border-color: rgba(255, 255, 255, 0.07);
        background: linear-gradient(90deg, rgba(255, 255, 255, 0.028), rgba(255, 255, 255, 0.016));
        box-shadow: none;
      }
      .fdg-row-claimed .fdg-tile {
        background: rgba(255, 255, 255, 0.025);
        border-color: rgba(255, 255, 255, 0.05);
        box-shadow: none;
      }
      .fdg-row-claimed .fdg-badge {
        background: #6b7080;
        color: #1b1e29;
        box-shadow: none;
      }
      .fdg-row-claimed .fdg-title {
        color: rgba(255, 255, 255, 0.52);
        background-size: 100% 1px;
      }
      .fdg-row-claimed .fdg-desc {
        color: rgba(255, 255, 255, 0.36);
      }
      .fdg-row-claimed .fdg-fraction {
        color: rgba(255, 255, 255, 0.45);
      }
      .fdg-row-claimed .fdg-xp {
        color: rgba(247, 201, 72, 0.55);
      }
      .fdg-row-claimed:hover {
        background: linear-gradient(90deg, rgba(255, 255, 255, 0.04), rgba(255, 255, 255, 0.022));
      }
      .fdg-row-claimed:focus-visible {
        outline: 1.5px solid rgba(165, 180, 252, 0.7);
        outline-offset: -1px;
      }

      .fdg-claimed-pill {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 0.3125rem;
        width: 100%;
        height: 1.75rem;
        font-size: 0.625rem;
        font-weight: 500;
        letter-spacing: 0.08em;
        color: rgba(255, 255, 255, 0.4);
        background: rgba(255, 255, 255, 0.03);
        border: 1px solid rgba(255, 255, 255, 0.06);
        border-radius: 7px;
      }
      .fdg-claimed-check {
        width: 0.75rem;
        height: 0.75rem;
      }

      /* ── Motion ────────────────────────────────────────────────── */

      /* active -> complete */
      .fdg-row-just-completed .fdg-sheen {
        animation: fdg-sheen-gold 950ms var(--fdg-ease) 120ms forwards;
      }
      .fdg-row-just-completed .fdg-badge::after {
        animation: fdg-ring 800ms ease-out 200ms forwards;
      }
      .fdg-row-just-completed .fdg-claim-btn {
        animation: fdg-btn-in 520ms cubic-bezier(0.34, 1.4, 0.64, 1) 350ms backwards;
      }
      .fdg-row-complete.fdg-row-just-completed:not(.fdg-row-claimed) {
        animation: fdg-glow-breathe 3.2s ease-in-out 1.2s infinite;
      }

      /* complete -> claimed */
      .fdg-row-just-claimed .fdg-sheen {
        background: linear-gradient(105deg, transparent 32%, rgba(255, 255, 255, 0.12) 50%, transparent 68%);
        animation: fdg-sheen-gold 800ms var(--fdg-ease) forwards;
      }
      .fdg-row-just-claimed .fdg-badge {
        animation: fdg-badge-settle 650ms var(--fdg-ease) both;
      }
      .fdg-row-just-claimed .fdg-claimed-pill {
        animation: fdg-pill-in 520ms var(--fdg-ease) both;
      }
      .fdg-row-just-claimed .fdg-xp {
        animation: fdg-xp-release 700ms var(--fdg-ease) both;
      }

      /* replay (tap a claimed row) */
      .fdg-row-replaying { animation: fdg-tap 350ms ease-out; }
      .fdg-badge-pop { animation: fdg-micro-spring 450ms cubic-bezier(0.34, 1.56, 0.64, 1) both; }

      @keyframes fdg-row-lift {
        0% { transform: scale(0.992); }
        55% { transform: scale(1.006); }
        100% { transform: scale(1); }
      }
      @keyframes fdg-sheen-gold {
        0% { opacity: 0; transform: translateX(-110%); }
        15% { opacity: 1; }
        100% { opacity: 0; transform: translateX(110%); }
      }
      @keyframes fdg-ring {
        0% { opacity: 0.85; transform: scale(1); }
        100% { opacity: 0; transform: scale(1.9); }
      }
      @keyframes fdg-btn-in {
        0% { opacity: 0; transform: translateX(10px) scale(0.92); }
        100% { opacity: 1; transform: none; }
      }
      @keyframes fdg-glow-breathe {
        0%, 100% { box-shadow: 0 0 0 1px rgba(247, 201, 72, 0.08) inset, 0 0 22px -6px rgba(247, 190, 60, 0.24); }
        50% { box-shadow: 0 0 0 1px rgba(247, 201, 72, 0.12) inset, 0 0 32px -4px rgba(247, 190, 60, 0.4); }
      }
      @keyframes fdg-btn-busy {
        0%, 100% { opacity: 0.55; }
        50% { opacity: 0.9; }
      }
      @keyframes fdg-badge-settle {
        0% { transform: scale(1.18); }
        100% { transform: scale(1); }
      }
      @keyframes fdg-pill-in {
        0% { opacity: 0; transform: scale(0.9); }
        100% { opacity: 1; transform: scale(1); }
      }
      @keyframes fdg-xp-release {
        0% { transform: translateY(0); opacity: 1; }
        35% { transform: translateY(-4px); }
        100% { transform: translateY(0); }
      }
      @keyframes fdg-tap {
        0% { background: rgba(255, 255, 255, 0.07); }
        100% { background: linear-gradient(90deg, rgba(255, 255, 255, 0.028), rgba(255, 255, 255, 0.016)); }
      }
      @keyframes fdg-micro-spring {
        0% { transform: scale(0.8); }
        60% { transform: scale(1.18); }
        100% { transform: scale(1); }
      }

      /* Skeleton */
      .fdg-row-skeleton {
        grid-template-columns: 2rem minmax(0, 1fr) auto;
        pointer-events: none;
      }
      .fdg-tile-skeleton {
        background: transparent;
        border-color: transparent;
        box-shadow: none;
        overflow: hidden;
      }

      /* Messages + insufficient-state links */
      .fdg-message {
        display: flex;
        flex-direction: column;
        align-items: flex-start;
        gap: 0.875rem;
        padding: 0.25rem 0.375rem 0.125rem;
      }
      .fdg-message-text {
        margin: 0;
        font-size: 0.75rem;
        line-height: 1.5;
        color: rgba(255, 255, 255, 0.6);
      }
      .fdg-message-actions {
        display: flex;
        flex-wrap: wrap;
        gap: 0.5rem 1.25rem;
      }
      .fdg-link {
        display: inline-flex;
        align-items: center;
        gap: 0.35rem;
        font-size: 0.6875rem;
        font-weight: 500;
        color: rgba(255, 255, 255, 0.85);
        text-decoration: none;
        padding: 0.3rem 0.55rem;
        border-radius: 8px;
        background: rgba(255, 255, 255, 0.04);
        border: 1px solid rgba(255, 255, 255, 0.1);
        transition: background 150ms ease, border-color 150ms ease;
      }
      .fdg-link:hover {
        background: rgba(255, 255, 255, 0.08);
        border-color: rgba(255, 255, 255, 0.2);
      }
      .fdg-arrow {
        width: 0.8125rem;
        height: 0.8125rem;
      }
      .fdg-btn {
        font-size: 0.6875rem;
        font-weight: 600;
        color: rgba(255, 255, 255, 0.85);
        background: transparent;
        border: 1px solid rgba(255, 255, 255, 0.16);
        padding: 0.4rem 0.85rem;
        border-radius: 8px;
        cursor: pointer;
      }
      .fdg-btn:hover { background: rgba(255, 255, 255, 0.06); }

      /* ── Responsive ────────────────────────────────────────────── */
      @media (max-width: 900px) {
        .fdg-row { grid-template-columns: 2rem minmax(0, 1fr) auto 5.5rem; column-gap: 0.5rem; }
        .fdg-meta { grid-template-columns: 2.25rem 3rem; }
      }

      @media (max-width: 640px) {
        .fdg-row {
          grid-template-columns: 2rem minmax(0, 1fr) auto;
          grid-template-areas: "tile body action" "tile meta action";
          row-gap: 0;
          column-gap: 0.5rem;
        }
        .fdg-tile { grid-area: tile; }
        .fdg-body { grid-area: body; }
        .fdg-meta { grid-area: meta; display: flex; gap: 0.5rem; justify-content: flex-start; }
        .fdg-action { grid-area: action; min-width: 1.75rem; }
        .fdg-claim-btn, .fdg-claimed-pill { width: auto; padding: 0 0.5rem; }
        .fdg-desc { display: none; }
      }

      @media (max-width: 380px) {
        .fdg-claimed-pill span { display: none; }
        .fdg-claimed-pill { width: 1.75rem; padding: 0; }
      }

      @media (prefers-reduced-motion: reduce) {
        .fdg-row, .fdg-row *, .fdg-row::after, .fdg-badge::after {
          animation: none !important;
          transition: none !important;
        }
      }
    `}</style>
  );
}
