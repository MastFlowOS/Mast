import { useState, useRef } from "react";
import { Link } from "@tanstack/react-router";
import {
  ArrowRight,
  Check,
  Sparkles,
  Zap,
  TrendingUp,
  Clock,
  Radio,
  Trophy,
  Activity,
  Compass,
} from "lucide-react";
import { cn } from "@/lib/utils";
import {
  goalProgress,
  isGoalComplete,
  MILESTONE_TIERS,
  type FocusGoal,
  type FocusPrimaryRecommendation,
  type FocusStackPriority,
  type FocusMomentumEvent,
  type FocusMastSignal,
  type FocusWeeklyPulse,
} from "@/lib/focus";
import { MILESTONE_XP_BADGE_ID } from "@/lib/xp-fly";

// ══════════════════════════════════════════════════════════════════════════════
// 1. WELCOME (Compact Greeting)
// ══════════════════════════════════════════════════════════════════════════════

type GreetingProps = {
  period: "morning" | "afternoon" | "evening" | "night";
  name: string;
  subtitle: string;
};

const PERIOD_LABELS: Record<GreetingProps["period"], string> = {
  morning: "Good morning",
  afternoon: "Good afternoon",
  evening: "Good evening",
  night: "Welcome back",
};

export function FocusGreeting({ period, name, subtitle }: GreetingProps) {
  const salutation = PERIOD_LABELS[period] || "Welcome back";

  return (
    <header className="focus-greeting-section animate-fade-in" aria-label="Command greeting">
      <div className="focus-greeting-container">
        <div className="focus-greeting-eyebrow">
          <span className="focus-status-beacon" aria-hidden="true" />
          <span className="focus-eyebrow-text">COMMAND LAYER · FOCUS</span>
        </div>
        <div className="focus-greeting-title-row">
          <h1 className="focus-greeting-heading">
            {salutation}, <span className="focus-greeting-name">{name || "MAST"}</span>.
          </h1>
          <p className="focus-greeting-sub">{subtitle}</p>
        </div>
      </div>

      <style>{`
        .focus-greeting-section {
          padding-top: 1.5rem;
          padding-bottom: 1.75rem;
        }

        .focus-greeting-container {
          display: flex;
          flex-direction: column;
          gap: 0.5rem;
        }

        .focus-greeting-eyebrow {
          display: inline-flex;
          align-items: center;
          gap: 0.5rem;
        }

        .focus-status-beacon {
          width: 6px;
          height: 6px;
          border-radius: 50%;
          background: #a855f7;
          box-shadow: 0 0 10px rgba(168, 85, 247, 0.7);
          animation: beacon-pulse 2.8s ease-in-out infinite;
        }

        @keyframes beacon-pulse {
          0%, 100% { opacity: 0.6; transform: scale(1); }
          50% { opacity: 1; transform: scale(1.15); box-shadow: 0 0 14px rgba(168, 85, 247, 0.9); }
        }

        .focus-eyebrow-text {
          font-size: 0.6875rem;
          font-weight: 700;
          letter-spacing: 0.14em;
          text-transform: uppercase;
          color: rgba(168, 85, 247, 0.9);
          font-family: var(--font-sans, system-ui);
        }

        .focus-greeting-title-row {
          display: flex;
          align-items: baseline;
          justify-content: space-between;
          flex-wrap: wrap;
          gap: 0.75rem 1.5rem;
        }

        .focus-greeting-heading {
          font-size: clamp(1.5rem, 3.2vw, 2.125rem);
          font-weight: 600;
          letter-spacing: -0.025em;
          line-height: 1.2;
          color: #ffffff;
          margin: 0;
        }

        .focus-greeting-name {
          color: #ffffff;
          font-weight: 700;
        }

        .focus-greeting-sub {
          font-size: 0.875rem;
          color: rgba(255, 255, 255, 0.55);
          margin: 0;
          max-width: 480px;
          line-height: 1.45;
        }

        @media (prefers-reduced-motion: reduce) {
          .focus-status-beacon {
            animation: none;
          }
        }
      `}</style>
    </header>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// 2. YOUR FOCUS (Dominant Primary Hero Module)
// ══════════════════════════════════════════════════════════════════════════════

type PrimaryHeroProps = {
  recommendation: FocusPrimaryRecommendation | null;
};

export function FocusPrimaryHero({ recommendation }: PrimaryHeroProps) {
  if (!recommendation) return null;

  return (
    <section className="focus-hero-module animate-fade-up" aria-labelledby="your-focus-heading">
      {/* Ambient restrained light glow */}
      <div className="focus-hero-ambient" aria-hidden="true" />

      <div className="focus-hero-grid">
        {/* LEFT: Dominant recommendation */}
        <div className="focus-hero-left">
          <div className="focus-hero-badge-row">
            <span className="focus-hero-eyebrow">
              <span className="focus-hero-dot" aria-hidden="true" />
              YOUR FOCUS
            </span>
            <span className="focus-hero-category">{recommendation.category}</span>
          </div>

          <h2 id="your-focus-heading" className="focus-hero-headline">
            {recommendation.headline}
          </h2>

          <p className="focus-hero-desc">{recommendation.description}</p>

          {/* WHY NOW Callout */}
          <div className="focus-why-callout">
            <span className="focus-why-tag">WHY NOW</span>
            <p className="focus-why-text">{recommendation.whyNow}</p>
          </div>

          {/* Primary Action Button */}
          <div className="focus-hero-action-row">
            <Link to={recommendation.to} className="focus-hero-cta">
              <span>{recommendation.actionLabel}</span>
              <ArrowRight className="focus-cta-arrow" aria-hidden="true" />
            </Link>
          </div>
        </div>

        {/* RIGHT: Supporting signal & context */}
        <div className="focus-hero-right">
          <div className="focus-context-card">
            <div className="focus-context-header">
              <span className="focus-context-title">SIGNAL CONTEXT</span>
              <span className="focus-context-status">LIVE</span>
            </div>

            <div className="focus-metrics-list">
              {recommendation.metrics.map((m) => (
                <div key={m.label} className="focus-metric-item">
                  <span className="focus-metric-label">{m.label}</span>
                  <span className="focus-metric-value">{m.value}</span>
                </div>
              ))}
            </div>

            <div className="focus-context-footer">
              <span className="focus-footer-pill">
                <Radio className="focus-footer-icon" aria-hidden="true" />
                Intelligent Filter Active
              </span>
            </div>
          </div>
        </div>
      </div>

      <style>{`
        .focus-hero-module {
          position: relative;
          background: linear-gradient(175deg, #15131f 0%, #0f0e15 50%, #0a090e 100%);
          border: 1px solid rgba(255, 255, 255, 0.08);
          border-radius: 20px;
          padding: 2.25rem 2.25rem 2rem;
          margin-bottom: 2rem;
          box-shadow: 0 20px 50px -15px rgba(0, 0, 0, 0.8),
                      inset 0 1px 0 rgba(255, 255, 255, 0.08);
          overflow: hidden;
        }

        .focus-hero-ambient {
          position: absolute;
          top: -40%;
          left: -10%;
          width: 70%;
          height: 90%;
          background: radial-gradient(ellipse at center, rgba(168, 85, 247, 0.12) 0%, transparent 70%);
          pointer-events: none;
          animation: ambient-drift 8s ease-in-out infinite alternate;
        }

        @keyframes ambient-drift {
          0% { transform: translateY(0) scale(1); opacity: 0.7; }
          100% { transform: translateY(12px) scale(1.08); opacity: 1; }
        }

        .focus-hero-grid {
          position: relative;
          z-index: 1;
          display: grid;
          grid-template-columns: 1fr 340px;
          gap: 2.5rem;
          align-items: stretch;
        }

        .focus-hero-left {
          display: flex;
          flex-direction: column;
          justify-content: space-between;
        }

        .focus-hero-badge-row {
          display: flex;
          align-items: center;
          gap: 0.75rem;
          margin-bottom: 1rem;
        }

        .focus-hero-eyebrow {
          display: inline-flex;
          align-items: center;
          gap: 0.45rem;
          font-size: 0.6875rem;
          font-weight: 700;
          letter-spacing: 0.14em;
          text-transform: uppercase;
          color: #c084fc;
        }

        .focus-hero-dot {
          width: 5px;
          height: 5px;
          border-radius: 50%;
          background: #c084fc;
          box-shadow: 0 0 8px rgba(192, 132, 252, 0.8);
        }

        .focus-hero-category {
          font-size: 0.625rem;
          font-weight: 600;
          letter-spacing: 0.1em;
          text-transform: uppercase;
          color: rgba(255, 255, 255, 0.4);
          padding: 0.15rem 0.5rem;
          border-radius: 4px;
          background: rgba(255, 255, 255, 0.04);
          border: 1px solid rgba(255, 255, 255, 0.06);
        }

        .focus-hero-headline {
          font-size: clamp(1.625rem, 2.8vw, 2.25rem);
          font-weight: 600;
          letter-spacing: -0.03em;
          line-height: 1.25;
          color: #ffffff;
          margin: 0 0 0.75rem;
          max-width: 620px;
        }

        .focus-hero-desc {
          font-size: 0.9375rem;
          color: rgba(255, 255, 255, 0.7);
          margin: 0 0 1.25rem;
          line-height: 1.55;
          max-width: 580px;
        }

        .focus-why-callout {
          display: flex;
          flex-direction: column;
          gap: 0.25rem;
          padding: 0.75rem 1rem;
          border-radius: 10px;
          background: rgba(168, 85, 247, 0.05);
          border: 1px solid rgba(168, 85, 247, 0.15);
          margin-bottom: 1.5rem;
          max-width: 580px;
        }

        .focus-why-tag {
          font-size: 0.625rem;
          font-weight: 700;
          font-family: var(--font-mono, monospace);
          letter-spacing: 0.12em;
          color: #c084fc;
        }

        .focus-why-text {
          font-size: 0.8125rem;
          color: rgba(255, 255, 255, 0.75);
          line-height: 1.5;
          margin: 0;
        }

        .focus-hero-action-row {
          margin-top: 0.5rem;
        }

        .focus-hero-cta {
          display: inline-flex;
          align-items: center;
          gap: 0.625rem;
          padding: 0.75rem 1.5rem;
          border-radius: 10px;
          background: #7c3aed;
          color: #ffffff;
          font-size: 0.875rem;
          font-weight: 600;
          letter-spacing: 0.01em;
          text-decoration: none;
          box-shadow: 0 4px 18px rgba(124, 58, 237, 0.45),
                      inset 0 1px 0 rgba(255, 255, 255, 0.2);
          transition: background 180ms ease, transform 180ms ease, box-shadow 180ms ease;
        }

        .focus-hero-cta:hover {
          background: #6d28d9;
          transform: translateY(-1px);
          box-shadow: 0 8px 25px rgba(124, 58, 237, 0.6);
        }

        .focus-hero-cta:active {
          transform: translateY(0);
        }

        .focus-hero-cta:focus-visible {
          outline: 2px solid #a855f7;
          outline-offset: 3px;
        }

        .focus-cta-arrow {
          width: 1rem;
          height: 1rem;
          transition: transform 180ms ease;
        }

        .focus-hero-cta:hover .focus-cta-arrow {
          transform: translateX(3px);
        }

        /* Context card on the right */
        .focus-hero-right {
          display: flex;
          flex-direction: column;
        }

        .focus-context-card {
          flex: 1;
          display: flex;
          flex-direction: column;
          justify-content: space-between;
          background: rgba(255, 255, 255, 0.02);
          border: 1px solid rgba(255, 255, 255, 0.06);
          border-radius: 14px;
          padding: 1.25rem 1.25rem 1rem;
        }

        .focus-context-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding-bottom: 0.875rem;
          border-bottom: 1px solid rgba(255, 255, 255, 0.06);
        }

        .focus-context-title {
          font-size: 0.6875rem;
          font-weight: 700;
          letter-spacing: 0.1em;
          text-transform: uppercase;
          color: rgba(255, 255, 255, 0.45);
        }

        .focus-context-status {
          font-size: 0.625rem;
          font-weight: 700;
          letter-spacing: 0.08em;
          color: #34d399;
          background: rgba(52, 211, 153, 0.1);
          padding: 0.15rem 0.45rem;
          border-radius: 4px;
          border: 1px solid rgba(52, 211, 153, 0.25);
        }

        .focus-metrics-list {
          display: flex;
          flex-direction: column;
          gap: 0.75rem;
          margin: 1.25rem 0;
        }

        .focus-metric-item {
          display: flex;
          align-items: center;
          justify-content: space-between;
        }

        .focus-metric-label {
          font-size: 0.75rem;
          color: rgba(255, 255, 255, 0.5);
          text-transform: capitalize;
        }

        .focus-metric-value {
          font-size: 0.8125rem;
          font-weight: 600;
          color: #ffffff;
          font-variant-numeric: tabular-nums;
        }

        .focus-context-footer {
          padding-top: 0.75rem;
          border-top: 1px solid rgba(255, 255, 255, 0.05);
        }

        .focus-footer-pill {
          display: inline-flex;
          align-items: center;
          gap: 0.35rem;
          font-size: 0.6875rem;
          color: rgba(255, 255, 255, 0.45);
        }

        .focus-footer-icon {
          width: 0.75rem;
          height: 0.75rem;
          color: #a855f7;
        }

        @media (max-width: 920px) {
          .focus-hero-grid {
            grid-template-columns: 1fr;
            gap: 1.75rem;
          }
        }

        @media (max-width: 640px) {
          .focus-hero-module {
            padding: 1.5rem 1.25rem 1.35rem;
          }
        }

        @media (prefers-reduced-motion: reduce) {
          .focus-hero-ambient {
            animation: none;
          }
        }
      `}</style>
    </section>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// 3. FOCUS STACK (3 Priorities)
// ══════════════════════════════════════════════════════════════════════════════

type StackProps = {
  priorities: FocusStackPriority[];
};

export function FocusStack({ priorities }: StackProps) {
  const [hoveredId, setHoveredId] = useState<string | null>(null);

  if (priorities.length === 0) return null;

  return (
    <section className="focus-stack-section animate-fade-up" aria-labelledby="focus-stack-title">
      <div className="focus-module-header">
        <div className="focus-module-title-wrap">
          <h2 id="focus-stack-title" className="focus-module-title">
            FOCUS STACK
          </h2>
          <span className="focus-module-badge">{priorities.length} PRIORITIES</span>
        </div>
        <span className="focus-module-hint">Intelligently filtered</span>
      </div>

      <div className="focus-stack-list" role="list">
        {priorities.map((item) => {
          const isHovered = hoveredId === item.id;
          return (
            <div
              key={item.id}
              role="listitem"
              className={cn("focus-stack-row", isHovered && "focus-stack-row-hovered")}
              onMouseEnter={() => setHoveredId(item.id)}
              onMouseLeave={() => setHoveredId(null)}
            >
              <div className="focus-stack-main">
                <span className="focus-stack-num">{item.number}</span>

                <div className="focus-stack-info">
                  <div className="focus-stack-top">
                    <span className="focus-stack-title">{item.title}</span>
                    <span className="focus-stack-meta">{item.metadata}</span>
                  </div>

                  {/* Context / Why Explanation */}
                  <div className={cn("focus-stack-why", isHovered && "focus-stack-why-visible")}>
                    <span className="focus-why-prefix">WHY:</span> {item.why}
                  </div>
                </div>
              </div>

              <div className="focus-stack-action">
                <Link
                  to={item.to}
                  className="focus-stack-link"
                  aria-label={`${item.actionLabel} for ${item.title}`}
                >
                  <span className="focus-link-text">{item.actionLabel}</span>
                  <ArrowRight className="focus-link-arrow" aria-hidden="true" />
                </Link>
              </div>
            </div>
          );
        })}
      </div>

      <style>{`
        .focus-stack-section {
          margin-bottom: 2.25rem;
        }

        .focus-module-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding-bottom: 0.875rem;
          border-bottom: 1px solid rgba(255, 255, 255, 0.08);
          margin-bottom: 0.25rem;
        }

        .focus-module-title-wrap {
          display: flex;
          align-items: center;
          gap: 0.75rem;
        }

        .focus-module-title {
          font-size: 0.8125rem;
          font-weight: 700;
          letter-spacing: 0.12em;
          text-transform: uppercase;
          color: rgba(255, 255, 255, 0.85);
          margin: 0;
        }

        .focus-module-badge {
          font-size: 0.625rem;
          font-weight: 700;
          font-family: var(--font-mono, monospace);
          letter-spacing: 0.08em;
          color: #c084fc;
          background: rgba(168, 85, 247, 0.1);
          border: 1px solid rgba(168, 85, 247, 0.25);
          padding: 0.15rem 0.5rem;
          border-radius: 4px;
        }

        .focus-module-hint {
          font-size: 0.75rem;
          color: rgba(255, 255, 255, 0.4);
        }

        .focus-stack-list {
          display: flex;
          flex-direction: column;
        }

        .focus-stack-row {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 1.25rem;
          padding: 1.125rem 0.75rem;
          border-bottom: 1px solid rgba(255, 255, 255, 0.06);
          border-radius: 8px;
          transition: background 150ms ease, transform 150ms ease, padding 150ms ease;
        }

        .focus-stack-row:last-child {
          border-bottom: none;
        }

        .focus-stack-row-hovered {
          background: rgba(255, 255, 255, 0.025);
        }

        .focus-stack-main {
          display: flex;
          align-items: flex-start;
          gap: 1.125rem;
          flex: 1;
          min-width: 0;
        }

        .focus-stack-num {
          font-family: var(--font-mono, monospace);
          font-size: 0.8125rem;
          font-weight: 600;
          color: rgba(255, 255, 255, 0.35);
          padding-top: 0.125rem;
          flex-shrink: 0;
        }

        .focus-stack-info {
          flex: 1;
          min-width: 0;
        }

        .focus-stack-top {
          display: flex;
          align-items: baseline;
          flex-wrap: wrap;
          gap: 0.5rem 1rem;
        }

        .focus-stack-title {
          font-size: 0.9375rem;
          font-weight: 600;
          color: #ffffff;
        }

        .focus-stack-meta {
          font-size: 0.75rem;
          color: rgba(255, 255, 255, 0.45);
        }

        .focus-stack-why {
          font-size: 0.75rem;
          color: rgba(255, 255, 255, 0.6);
          line-height: 1.45;
          margin-top: 0.35rem;
          transition: opacity 150ms ease, transform 150ms ease;
        }

        .focus-why-prefix {
          font-weight: 700;
          color: #c084fc;
        }

        .focus-stack-action {
          flex-shrink: 0;
        }

        .focus-stack-link {
          display: inline-flex;
          align-items: center;
          gap: 0.45rem;
          color: rgba(255, 255, 255, 0.65);
          text-decoration: none;
          font-size: 0.8125rem;
          font-weight: 600;
          padding: 0.4rem 0.75rem;
          border-radius: 6px;
          border: 1px solid transparent;
          transition: all 150ms ease;
        }

        .focus-stack-link:hover,
        .focus-stack-row-hovered .focus-stack-link {
          color: #c084fc;
          background: rgba(168, 85, 247, 0.08);
          border-color: rgba(168, 85, 247, 0.2);
        }

        .focus-stack-link:focus-visible {
          outline: 2px solid #a855f7;
          outline-offset: 2px;
        }

        .focus-link-arrow {
          width: 0.875rem;
          height: 0.875rem;
          transition: transform 150ms ease;
        }

        .focus-stack-link:hover .focus-link-arrow {
          transform: translateX(3px);
        }

        @media (max-width: 640px) {
          .focus-stack-row {
            flex-direction: column;
            align-items: flex-start;
            gap: 0.75rem;
            padding: 1rem 0.5rem;
          }
          .focus-stack-action {
            align-self: flex-end;
          }
        }
      `}</style>
    </section>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// 4. TODAY'S GOALS (Single Coherent Module)
// ══════════════════════════════════════════════════════════════════════════════

type GoalsProps = {
  goals: FocusGoal[];
  onClaim: (goal: FocusGoal, cardEl: HTMLElement | null) => void;
  claimedGoalIds: Set<string>;
  claimingGoalIds: Set<string>;
  exitingGoalIds: Set<string>;
};

export function FocusGoals({
  goals,
  onClaim,
  claimedGoalIds,
  claimingGoalIds,
  exitingGoalIds,
}: GoalsProps) {
  if (goals.length === 0) return null;

  const completedCount = goals.filter((g) => isGoalComplete(g)).length;
  const totalXp = goals.reduce((sum, g) => sum + g.xp, 0);

  return (
    <section className="focus-goals-section animate-fade-up" aria-labelledby="todays-goals-title">
      <div className="focus-module-header">
        <div className="focus-module-title-wrap">
          <h2 id="todays-goals-title" className="focus-module-title">
            TODAY'S GOALS
          </h2>
          <span className="focus-module-badge">
            {completedCount} / {goals.length} COMPLETED
          </span>
        </div>
        <span className="focus-goals-xp-summary">+{totalXp} XP Available</span>
      </div>

      <div className="focus-goals-card">
        <div className="focus-goals-table" role="list">
          {goals.map((goal, index) => {
            const pct = goalProgress(goal);
            const complete = isGoalComplete(goal);
            const isClaimed = claimedGoalIds.has(goal.id);
            const isClaiming = claimingGoalIds.has(goal.id);
            const isExiting = exitingGoalIds.has(goal.id);
            const claimable = complete && !isClaimed && !isClaiming;

            return (
              <GoalEditorialRow
                key={goal.id}
                goal={goal}
                index={index}
                pct={pct}
                complete={complete}
                claimable={claimable}
                isClaimed={isClaimed}
                isClaiming={isClaiming}
                isExiting={isExiting}
                onClaim={onClaim}
              />
            );
          })}
        </div>
      </div>

      <style>{`
        .focus-goals-section {
          margin-bottom: 2.25rem;
        }

        .focus-goals-xp-summary {
          font-size: 0.75rem;
          font-weight: 700;
          color: #fbbf24;
          font-family: var(--font-mono, monospace);
        }

        .focus-goals-card {
          background: rgba(255, 255, 255, 0.015);
          border: 1px solid rgba(255, 255, 255, 0.06);
          border-radius: 14px;
          overflow: hidden;
          margin-top: 0.75rem;
        }

        .focus-goals-table {
          display: flex;
          flex-direction: column;
        }
      `}</style>
    </section>
  );
}

function GoalEditorialRow({
  goal,
  index,
  pct,
  complete,
  claimable,
  isClaimed,
  isClaiming,
  isExiting,
  onClaim,
}: {
  goal: FocusGoal;
  index: number;
  pct: number;
  complete: boolean;
  claimable: boolean;
  isClaimed: boolean;
  isClaiming: boolean;
  isExiting: boolean;
  onClaim: (goal: FocusGoal, el: HTMLElement | null) => void;
}) {
  const rowRef = useRef<HTMLDivElement>(null);
  const numStr = String(index + 1).padStart(2, "0");

  function handleClick() {
    if (!claimable) return;
    onClaim(goal, rowRef.current);
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      handleClick();
    }
  }

  return (
    <div
      ref={rowRef}
      role={claimable ? "button" : "listitem"}
      tabIndex={claimable ? 0 : undefined}
      aria-label={claimable ? `Claim +${goal.xp} XP for ${goal.label}` : `${goal.label}, ${pct}% complete`}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      className={cn(
        "focus-goal-row",
        complete && "focus-goal-complete",
        claimable && "focus-goal-claimable",
        isClaiming && "focus-goal-claiming",
        isExiting && "focus-goal-exiting",
      )}
    >
      <div className="focus-goal-left">
        <span className="focus-goal-num">{numStr}</span>
        <span className="focus-goal-label">{goal.label}</span>
      </div>

      <div className="focus-goal-center">
        <div className="focus-goal-fraction">
          {Math.min(goal.current, goal.target)} / {goal.target}
        </div>
        <div className="focus-goal-track">
          <div
            className={cn("focus-goal-fill", complete ? "focus-fill-complete" : "focus-fill-active")}
            style={{ width: `${pct}%` }}
          />
        </div>
        <span className="focus-goal-pct">{pct}%</span>
      </div>

      <div className="focus-goal-right">
        {complete ? (
          <span className="focus-goal-badge-complete">
            <Check className="focus-goal-check" aria-hidden="true" />
            {claimable ? `CLAIM +${goal.xp} XP` : "COMPLETED"}
          </span>
        ) : (
          <span className="focus-goal-xp">+{goal.xp} XP</span>
        )}
      </div>

      <style>{`
        .focus-goal-row {
          display: grid;
          grid-template-columns: 240px 1fr 140px;
          align-items: center;
          gap: 1.5rem;
          padding: 1rem 1.25rem;
          border-bottom: 1px solid rgba(255, 255, 255, 0.05);
          transition: background 160ms ease, border-color 160ms ease;
        }

        .focus-goal-row:last-child {
          border-bottom: none;
        }

        .focus-goal-claimable {
          cursor: pointer;
        }

        .focus-goal-claimable:hover {
          background: rgba(168, 85, 247, 0.05);
        }

        .focus-goal-claimable:focus-visible {
          outline: 2px solid #a855f7;
          outline-offset: -2px;
        }

        .focus-goal-left {
          display: flex;
          align-items: center;
          gap: 1rem;
        }

        .focus-goal-num {
          font-family: var(--font-mono, monospace);
          font-size: 0.75rem;
          font-weight: 600;
          color: rgba(255, 255, 255, 0.35);
        }

        .focus-goal-label {
          font-size: 0.875rem;
          font-weight: 500;
          color: #ffffff;
        }

        .focus-goal-center {
          display: flex;
          align-items: center;
          gap: 1rem;
        }

        .focus-goal-fraction {
          font-family: var(--font-mono, monospace);
          font-size: 0.75rem;
          color: rgba(255, 255, 255, 0.5);
          min-width: 55px;
          text-align: right;
        }

        .focus-goal-track {
          flex: 1;
          height: 4px;
          border-radius: 99px;
          background: rgba(255, 255, 255, 0.08);
          overflow: hidden;
        }

        .focus-goal-fill {
          height: 100%;
          border-radius: 99px;
          transition: width 600ms cubic-bezier(0.16, 1, 0.3, 1);
        }

        .focus-fill-active {
          background: linear-gradient(90deg, #9333ea, #a855f7);
        }

        .focus-fill-complete {
          background: linear-gradient(90deg, #10b981, #34d399);
        }

        .focus-goal-pct {
          font-family: var(--font-mono, monospace);
          font-size: 0.75rem;
          color: rgba(255, 255, 255, 0.4);
          min-width: 36px;
          text-align: right;
        }

        .focus-goal-right {
          display: flex;
          justify-content: flex-end;
        }

        .focus-goal-xp {
          font-family: var(--font-mono, monospace);
          font-size: 0.75rem;
          font-weight: 700;
          color: rgba(255, 255, 255, 0.4);
        }

        .focus-goal-badge-complete {
          display: inline-flex;
          align-items: center;
          gap: 0.35rem;
          font-size: 0.6875rem;
          font-weight: 700;
          font-family: var(--font-mono, monospace);
          letter-spacing: 0.04em;
          color: #34d399;
          background: rgba(52, 211, 153, 0.1);
          border: 1px solid rgba(52, 211, 153, 0.25);
          padding: 0.2rem 0.5rem;
          border-radius: 6px;
        }

        .focus-goal-check {
          width: 0.75rem;
          height: 0.75rem;
        }

        .focus-goal-claiming {
          animation: goal-claim-rise 700ms cubic-bezier(0.16, 1, 0.3, 1) forwards;
        }

        @keyframes goal-claim-rise {
          0% { transform: translateY(0); opacity: 1; }
          40% { transform: translateY(-4px); background: rgba(168, 85, 247, 0.1); }
          100% { transform: translateY(-8px); opacity: 0; }
        }

        @media (max-width: 768px) {
          .focus-goal-row {
            grid-template-columns: 1fr;
            gap: 0.75rem;
            padding: 1rem;
          }
          .focus-goal-right {
            justify-content: flex-start;
          }
        }

        @media (prefers-reduced-motion: reduce) {
          .focus-goal-claiming {
            animation: none;
            opacity: 0.5;
          }
        }
      `}</style>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// 5. MOMENTUM + MILESTONE (Two-Column Section)
// ══════════════════════════════════════════════════════════════════════════════

type MomentumMilestoneProps = {
  events: FocusMomentumEvent[];
  xp: number;
  currentName: string;
  nextName: string | null;
  progressPct: number;
  leveledUpTier?: string | null;
};

export function FocusMomentumMilestone({
  events,
  xp,
  currentName,
  nextName,
  progressPct,
  leveledUpTier,
}: MomentumMilestoneProps) {
  const currentIndex = MILESTONE_TIERS.findIndex((t) => t.name === currentName);
  const nextTier = MILESTONE_TIERS.find((t) => t.name === nextName);

  return (
    <section className="focus-momentum-milestone animate-fade-up" aria-label="Momentum and Milestone">
      {/* LEFT: Momentum Activity */}
      <div className="focus-col-module">
        <div className="focus-module-header">
          <div className="focus-module-title-wrap">
            <h2 className="focus-module-title">MOMENTUM</h2>
            <span className="focus-module-badge">RECENT WINS</span>
          </div>
          <Activity className="focus-module-icon" aria-hidden="true" />
        </div>

        <div className="focus-momentum-card">
          <div className="focus-timeline-list" role="list">
            {events.map((evt) => (
              <div key={evt.id} className="focus-timeline-item" role="listitem">
                <div className="focus-timeline-dot" aria-hidden="true" />
                <div className="focus-timeline-content">
                  <div className="focus-timeline-row">
                    <span className="focus-timeline-delta">{evt.delta}</span>
                    <span className="focus-timeline-label">{evt.label}</span>
                  </div>
                  <p className="focus-timeline-detail">{evt.detail}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* RIGHT: Milestone Journey */}
      <div className="focus-col-module">
        <div className="focus-module-header">
          <div className="focus-module-title-wrap">
            <h2 className="focus-module-title">MILESTONE</h2>
            <span className="focus-module-badge">JOURNEY</span>
          </div>
          <div id={MILESTONE_XP_BADGE_ID} className="focus-xp-counter">
            {xp.toLocaleString()} <span className="focus-xp-unit">XP</span>
          </div>
        </div>

        <div className="focus-milestone-card">
          {/* Journey progress track */}
          <div className="focus-journey-track-wrap">
            <div className="focus-journey-track">
              <div
                className="focus-journey-fill"
                style={{ width: `${progressPct}%` }}
                aria-label={`Milestone progress: ${progressPct}%`}
              />
            </div>

            {/* Stages node indicators */}
            <div className="focus-journey-stages">
              {MILESTONE_TIERS.slice(0, 4).map((tier, idx) => {
                const isPassed = idx < currentIndex;
                const isCurrent = idx === currentIndex;
                const isFuture = idx > currentIndex;

                return (
                  <div
                    key={tier.id}
                    className={cn(
                      "focus-stage-node",
                      isCurrent && "focus-stage-current",
                      isPassed && "focus-stage-passed",
                      isFuture && "focus-stage-future",
                    )}
                  >
                    <div className="focus-node-circle">
                      {isPassed ? (
                        <Check className="focus-node-check" aria-hidden="true" />
                      ) : (
                        <span className="focus-node-inner" />
                      )}
                    </div>
                    <span className="focus-stage-name">{tier.name}</span>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Next unlock callout */}
          <div className="focus-unlock-box">
            <div className="focus-unlock-left">
              <span className="focus-unlock-tag">NEXT UNLOCK</span>
              <p className="focus-unlock-name">
                {nextTier ? nextTier.reward : "Tier completed — rewards banked"}
              </p>
            </div>
            {nextTier && (
              <span className="focus-unlock-xp-rem">
                {Math.max(0, nextTier.xpRequired - xp)} XP remaining
              </span>
            )}
          </div>
        </div>
      </div>

      <style>{`
        .focus-momentum-milestone {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 1.5rem;
          margin-bottom: 2.25rem;
        }

        .focus-col-module {
          display: flex;
          flex-direction: column;
        }

        .focus-module-icon {
          width: 0.875rem;
          height: 0.875rem;
          color: rgba(255, 255, 255, 0.4);
        }

        .focus-xp-counter {
          font-family: var(--font-mono, monospace);
          font-size: 0.875rem;
          font-weight: 700;
          color: #fbbf24;
          background: rgba(251, 191, 36, 0.08);
          border: 1px solid rgba(251, 191, 36, 0.2);
          padding: 0.2rem 0.55rem;
          border-radius: 6px;
        }

        .focus-xp-unit {
          font-size: 0.625rem;
          opacity: 0.8;
        }

        .focus-momentum-card,
        .focus-milestone-card {
          flex: 1;
          background: rgba(255, 255, 255, 0.015);
          border: 1px solid rgba(255, 255, 255, 0.06);
          border-radius: 14px;
          padding: 1.5rem;
          margin-top: 0.75rem;
          display: flex;
          flex-direction: column;
          justify-content: space-between;
        }

        /* Timeline in Momentum */
        .focus-timeline-list {
          display: flex;
          flex-direction: column;
          gap: 1rem;
        }

        .focus-timeline-item {
          position: relative;
          display: flex;
          align-items: flex-start;
          gap: 0.875rem;
        }

        .focus-timeline-dot {
          width: 6px;
          height: 6px;
          border-radius: 50%;
          background: #a855f7;
          margin-top: 0.4rem;
          box-shadow: 0 0 8px rgba(168, 85, 247, 0.5);
          flex-shrink: 0;
        }

        .focus-timeline-content {
          display: flex;
          flex-direction: column;
          gap: 0.15rem;
        }

        .focus-timeline-row {
          display: flex;
          align-items: baseline;
          gap: 0.4rem;
        }

        .focus-timeline-delta {
          font-family: var(--font-mono, monospace);
          font-size: 0.8125rem;
          font-weight: 700;
          color: #34d399;
        }

        .focus-timeline-label {
          font-size: 0.8125rem;
          font-weight: 600;
          color: #ffffff;
        }

        .focus-timeline-detail {
          font-size: 0.75rem;
          color: rgba(255, 255, 255, 0.45);
          margin: 0;
          line-height: 1.4;
        }

        /* Milestone Track */
        .focus-journey-track-wrap {
          position: relative;
          padding: 0.75rem 0 1.25rem;
        }

        .focus-journey-track {
          position: absolute;
          top: 1.4rem;
          left: 5%;
          right: 5%;
          height: 3px;
          background: rgba(255, 255, 255, 0.08);
          border-radius: 99px;
          z-index: 0;
        }

        .focus-journey-fill {
          height: 100%;
          background: linear-gradient(90deg, #9333ea, #c084fc);
          border-radius: 99px;
          transition: width 600ms cubic-bezier(0.16, 1, 0.3, 1);
        }

        .focus-journey-stages {
          position: relative;
          z-index: 1;
          display: flex;
          justify-content: space-between;
        }

        .focus-stage-node {
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 0.5rem;
        }

        .focus-node-circle {
          width: 22px;
          height: 22px;
          border-radius: 50%;
          background: #0f0e15;
          border: 1.5px solid rgba(255, 255, 255, 0.15);
          display: grid;
          place-items: center;
          transition: all 200ms ease;
        }

        .focus-stage-passed .focus-node-circle {
          border-color: #34d399;
          background: rgba(52, 211, 153, 0.15);
        }

        .focus-node-check {
          width: 0.625rem;
          height: 0.625rem;
          color: #34d399;
        }

        .focus-stage-current .focus-node-circle {
          border-color: #a855f7;
          background: #a855f7;
          box-shadow: 0 0 12px rgba(168, 85, 247, 0.8);
        }

        .focus-node-inner {
          width: 6px;
          height: 6px;
          border-radius: 50%;
          background: #ffffff;
        }

        .focus-stage-future {
          opacity: 0.35;
        }

        .focus-stage-name {
          font-size: 0.6875rem;
          font-weight: 600;
          color: rgba(255, 255, 255, 0.6);
        }

        .focus-stage-current .focus-stage-name {
          color: #ffffff;
          font-weight: 700;
        }

        /* Unlock box */
        .focus-unlock-box {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 0.75rem 1rem;
          border-radius: 10px;
          background: rgba(255, 255, 255, 0.02);
          border: 1px solid rgba(255, 255, 255, 0.06);
          margin-top: 1rem;
        }

        .focus-unlock-tag {
          font-size: 0.5625rem;
          font-weight: 700;
          letter-spacing: 0.12em;
          text-transform: uppercase;
          color: #fbbf24;
          display: block;
        }

        .focus-unlock-name {
          font-size: 0.8125rem;
          font-weight: 600;
          color: #ffffff;
          margin: 0.15rem 0 0;
        }

        .focus-unlock-xp-rem {
          font-family: var(--font-mono, monospace);
          font-size: 0.6875rem;
          color: rgba(255, 255, 255, 0.45);
        }

        @media (max-width: 860px) {
          .focus-momentum-milestone {
            grid-template-columns: 1fr;
          }
        }
      `}</style>
    </section>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// 6. MAST SIGNAL (Compact Intelligence Module)
// ══════════════════════════════════════════════════════════════════════════════

type SignalProps = {
  signal: FocusMastSignal;
};

export function FocusSignal({ signal }: SignalProps) {
  return (
    <section className="focus-signal-section animate-fade-up" aria-labelledby="mast-signal-title">
      <div className="focus-signal-card">
        <div className="focus-signal-left">
          <div className="focus-signal-eyebrow">
            <span className="focus-signal-indicator" aria-hidden="true" />
            <span id="mast-signal-title">MAST SIGNAL</span>
            {signal.isQuiet && <span className="focus-signal-quiet-tag">STEADY</span>}
          </div>
          <h3 className="focus-signal-headline">{signal.headline}</h3>
          <p className="focus-signal-detail">{signal.detail}</p>
        </div>

        <div className="focus-signal-right">
          <Link to={signal.to} className="focus-signal-link">
            <span>{signal.actionLabel}</span>
            <ArrowRight className="focus-signal-arrow" aria-hidden="true" />
          </Link>
        </div>
      </div>

      <style>{`
        .focus-signal-section {
          margin-bottom: 2.25rem;
        }

        .focus-signal-card {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 1.5rem;
          padding: 1.25rem 1.5rem;
          border-radius: 14px;
          background: rgba(168, 85, 247, 0.03);
          border: 1px solid rgba(168, 85, 247, 0.12);
        }

        .focus-signal-left {
          flex: 1;
          min-width: 0;
        }

        .focus-signal-eyebrow {
          display: inline-flex;
          align-items: center;
          gap: 0.5rem;
          font-size: 0.6875rem;
          font-weight: 700;
          letter-spacing: 0.12em;
          text-transform: uppercase;
          color: #c084fc;
          margin-bottom: 0.35rem;
        }

        .focus-signal-indicator {
          width: 5px;
          height: 5px;
          border-radius: 50%;
          background: #c084fc;
          box-shadow: 0 0 8px rgba(192, 132, 252, 0.8);
        }

        .focus-signal-quiet-tag {
          font-size: 0.5625rem;
          font-weight: 600;
          color: rgba(255, 255, 255, 0.4);
          background: rgba(255, 255, 255, 0.04);
          padding: 0.1rem 0.4rem;
          border-radius: 4px;
        }

        .focus-signal-headline {
          font-size: 0.9375rem;
          font-weight: 600;
          color: #ffffff;
          margin: 0 0 0.25rem;
          line-height: 1.35;
        }

        .focus-signal-detail {
          font-size: 0.8125rem;
          color: rgba(255, 255, 255, 0.5);
          margin: 0;
          line-height: 1.45;
        }

        .focus-signal-right {
          flex-shrink: 0;
        }

        .focus-signal-link {
          display: inline-flex;
          align-items: center;
          gap: 0.4rem;
          color: #c084fc;
          font-size: 0.8125rem;
          font-weight: 600;
          text-decoration: none;
          padding: 0.45rem 0.85rem;
          border-radius: 6px;
          background: rgba(168, 85, 247, 0.08);
          border: 1px solid rgba(168, 85, 247, 0.2);
          transition: all 160ms ease;
        }

        .focus-signal-link:hover {
          background: rgba(168, 85, 247, 0.15);
          transform: translateY(-1px);
        }

        .focus-signal-arrow {
          width: 0.875rem;
          height: 0.875rem;
          transition: transform 160ms ease;
        }

        .focus-signal-link:hover .focus-signal-arrow {
          transform: translateX(3px);
        }

        @media (max-width: 640px) {
          .focus-signal-card {
            flex-direction: column;
            align-items: flex-start;
          }
          .focus-signal-right {
            align-self: flex-end;
          }
        }
      `}</style>
    </section>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// 7. WEEKLY PULSE (Compact Preview of Analytics)
// ══════════════════════════════════════════════════════════════════════════════

type WeeklyPulseProps = {
  pulse: FocusWeeklyPulse;
};

export function FocusWeeklyPulse({ pulse }: WeeklyPulseProps) {
  return (
    <section className="focus-pulse-section animate-fade-up" aria-labelledby="weekly-pulse-title">
      <div className="focus-pulse-card">
        <div className="focus-pulse-header">
          <div className="focus-pulse-title-wrap">
            <Compass className="focus-pulse-icon" aria-hidden="true" />
            <h3 id="weekly-pulse-title" className="focus-pulse-title">
              WEEKLY PULSE
            </h3>
          </div>
          <div className="focus-pulse-momentum">
            <span className="focus-pulse-momentum-label">Momentum</span>
            <span className="focus-pulse-arrow">{pulse.momentum}</span>
          </div>
        </div>

        <div className="focus-pulse-grid">
          <div className="focus-pulse-stat">
            <span className="focus-pulse-label">Discovery</span>
            <span className="focus-pulse-num">{pulse.discovery}</span>
          </div>
          <div className="focus-pulse-stat">
            <span className="focus-pulse-label">Outreach</span>
            <span className="focus-pulse-num">{pulse.outreach}</span>
          </div>
          <div className="focus-pulse-stat">
            <span className="focus-pulse-label">Replies</span>
            <span className="focus-pulse-num">{pulse.replies}</span>
          </div>
          <div className="focus-pulse-stat">
            <span className="focus-pulse-label">Meetings</span>
            <span className="focus-pulse-num">{pulse.meetings}</span>
          </div>
        </div>

        <p className="focus-pulse-summary">{pulse.summary}</p>
      </div>

      <style>{`
        .focus-pulse-section {
          margin-bottom: 2.5rem;
        }

        .focus-pulse-card {
          background: rgba(255, 255, 255, 0.015);
          border: 1px solid rgba(255, 255, 255, 0.06);
          border-radius: 14px;
          padding: 1.25rem 1.5rem;
        }

        .focus-pulse-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding-bottom: 0.875rem;
          border-bottom: 1px solid rgba(255, 255, 255, 0.05);
          margin-bottom: 1rem;
        }

        .focus-pulse-title-wrap {
          display: flex;
          align-items: center;
          gap: 0.5rem;
        }

        .focus-pulse-icon {
          width: 0.875rem;
          height: 0.875rem;
          color: rgba(255, 255, 255, 0.4);
        }

        .focus-pulse-title {
          font-size: 0.75rem;
          font-weight: 700;
          letter-spacing: 0.12em;
          text-transform: uppercase;
          color: rgba(255, 255, 255, 0.6);
          margin: 0;
        }

        .focus-pulse-momentum {
          display: flex;
          align-items: center;
          gap: 0.35rem;
        }

        .focus-pulse-momentum-label {
          font-size: 0.6875rem;
          color: rgba(255, 255, 255, 0.4);
        }

        .focus-pulse-arrow {
          font-size: 0.875rem;
          font-weight: 700;
          color: #34d399;
        }

        .focus-pulse-grid {
          display: grid;
          grid-template-columns: repeat(4, 1fr);
          gap: 1rem;
          margin-bottom: 0.875rem;
        }

        .focus-pulse-stat {
          display: flex;
          flex-direction: column;
          gap: 0.25rem;
        }

        .focus-pulse-label {
          font-size: 0.6875rem;
          text-transform: uppercase;
          letter-spacing: 0.06em;
          color: rgba(255, 255, 255, 0.4);
        }

        .focus-pulse-num {
          font-family: var(--font-mono, monospace);
          font-size: 1.125rem;
          font-weight: 700;
          color: #ffffff;
          font-variant-numeric: tabular-nums;
        }

        .focus-pulse-summary {
          font-size: 0.8125rem;
          color: rgba(255, 255, 255, 0.5);
          margin: 0;
          line-height: 1.45;
        }

        @media (max-width: 640px) {
          .focus-pulse-grid {
            grid-template-columns: repeat(2, 1fr);
            gap: 1rem;
          }
        }
      `}</style>
    </section>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// 8. EMPTY STATES ("YOU'RE CLEAR.")
// ══════════════════════════════════════════════════════════════════════════════

type EmptyStateProps = {
  goalsCompleted: number;
  totalGoals: number;
  xpEarned: number;
};

export function FocusEmptyState({ goalsCompleted, totalGoals, xpEarned }: EmptyStateProps) {
  return (
    <section className="focus-empty-section animate-fade-in" aria-label="Command clear state">
      <div className="focus-empty-card">
        <div className="focus-empty-badge">
          <Sparkles className="focus-empty-icon" aria-hidden="true" />
          <span>ALL CLEAR</span>
        </div>

        <h2 className="focus-empty-headline">YOU'RE CLEAR.</h2>

        <p className="focus-empty-desc">
          Nothing important needs your attention right now. Your queues are quiet and momentum is locked in.
        </p>

        <div className="focus-empty-stats">
          <span className="focus-empty-stat-item">
            {goalsCompleted} / {totalGoals} goals complete
          </span>
          <span className="focus-empty-dot" aria-hidden="true">·</span>
          <span className="focus-empty-stat-item">
            {xpEarned} XP earned
          </span>
        </div>

        <div className="focus-empty-cta-wrap">
          <Link to="/dashboard/leads" className="focus-empty-cta">
            <span>Discover something new</span>
            <ArrowRight className="focus-empty-arrow" aria-hidden="true" />
          </Link>
        </div>
      </div>

      <style>{`
        .focus-empty-section {
          margin-bottom: 2.5rem;
        }

        .focus-empty-card {
          text-align: center;
          padding: 3.5rem 2rem;
          border-radius: 20px;
          background: linear-gradient(180deg, rgba(255, 255, 255, 0.02) 0%, rgba(255, 255, 255, 0.005) 100%);
          border: 1px solid rgba(255, 255, 255, 0.06);
          display: flex;
          flex-direction: column;
          align-items: center;
        }

        .focus-empty-badge {
          display: inline-flex;
          align-items: center;
          gap: 0.4rem;
          font-size: 0.6875rem;
          font-weight: 700;
          letter-spacing: 0.12em;
          color: #34d399;
          background: rgba(52, 211, 153, 0.1);
          border: 1px solid rgba(52, 211, 153, 0.25);
          padding: 0.2rem 0.6rem;
          border-radius: 99px;
          margin-bottom: 1.25rem;
        }

        .focus-empty-icon {
          width: 0.75rem;
          height: 0.75rem;
        }

        .focus-empty-headline {
          font-size: clamp(2rem, 4vw, 2.75rem);
          font-weight: 700;
          letter-spacing: -0.03em;
          color: #ffffff;
          margin: 0 0 0.75rem;
        }

        .focus-empty-desc {
          font-size: 0.9375rem;
          color: rgba(255, 255, 255, 0.55);
          max-width: 480px;
          margin: 0 0 1.5rem;
          line-height: 1.55;
        }

        .focus-empty-stats {
          display: inline-flex;
          align-items: center;
          gap: 0.6rem;
          font-family: var(--font-mono, monospace);
          font-size: 0.8125rem;
          color: rgba(255, 255, 255, 0.5);
          margin-bottom: 2rem;
        }

        .focus-empty-dot {
          opacity: 0.4;
        }

        .focus-empty-cta {
          display: inline-flex;
          align-items: center;
          gap: 0.5rem;
          padding: 0.75rem 1.625rem;
          border-radius: 99px;
          background: #7c3aed;
          color: #ffffff;
          font-size: 0.875rem;
          font-weight: 600;
          text-decoration: none;
          box-shadow: 0 4px 18px rgba(124, 58, 237, 0.45);
          transition: all 180ms ease;
        }

        .focus-empty-cta:hover {
          background: #6d28d9;
          transform: translateY(-1px);
          box-shadow: 0 8px 24px rgba(124, 58, 237, 0.6);
        }

        .focus-empty-arrow {
          width: 0.875rem;
          height: 0.875rem;
          transition: transform 180ms ease;
        }

        .focus-empty-cta:hover .focus-empty-arrow {
          transform: translateX(3px);
        }
      `}</style>
    </section>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// Preserved Legacy Discover CTA (for backward compatibility if imported)
// ══════════════════════════════════════════════════════════════════════════════

export function FocusDiscoverCta() {
  return null;
}

// Preserved Legacy Stubs (to prevent import breakage)
export { FocusGreeting as FocusHeroGreeting };
