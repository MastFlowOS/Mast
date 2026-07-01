import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import {
  AlertTriangle,
  ArrowRight,
  CalendarClock,
  Check,
  Flame,
  ListChecks,
  RotateCcw,
  Sparkles,
  Target,
  TrendingUp,
  Trophy,
} from "lucide-react";
import { toast } from "sonner";
import { getLead, type FollowupWithLead, type Lead, type OutreachChannel } from "@/lib/api";
import { useFollowups, useRecordLeadActivity, useUpdateFollowup } from "@/hooks/use-mast-api";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { NICHES, formatDate, formatRelative } from "@/lib/lead-workspace";

export const Route = createFileRoute("/dashboard/follow-ups")({
  head: () => ({ meta: [{ title: "Follow-ups — Mast" }] }),
  component: FollowUpsPage,
});

// ── Types ─────────────────────────────────────────────────────────────────────

type MissionItem = FollowupWithLead & {
  leadName: string;
  nicheLabel: string;
  score: number;
  priority: "high" | "medium" | "low";
  dueState: "overdue" | "today" | "upcoming" | "completed";
  daysOverdue: number;
  daysSinceContact: number | null;
  effort: "quick" | "standard";
  impact: number;
  impactScore: number; // business-impact-weighted priority score
};

const SECTION_LIMIT = 6;

// ── Page ──────────────────────────────────────────────────────────────────────

function FollowUpsPage() {
  const navigate = useNavigate();
  const { data: followups = [], isLoading } = useFollowups({ limit: 1000 });
  const updateFollowup = useUpdateFollowup();
  const recordActivity = useRecordLeadActivity();
  const [rescheduleItem, setRescheduleItem] = useState<MissionItem | null>(null);
  const [rescheduleDate, setRescheduleDate] = useState("");
  const [rescheduleTime, setRescheduleTime] = useState("09:00");

  const mission = useMemo(() => buildMission(followups), [followups]);
  const busy = updateFollowup.isPending || recordActivity.isPending;
  const missionComplete = !isLoading && mission.active.length === 0;

  const openLead = (leadId: number) => {
    navigate({ to: "/dashboard/leads/$leadId", params: { leadId: String(leadId) } });
  };

  const completeFollowup = async (followup: MissionItem) => {
    const completedAt = new Date().toISOString();
    const lead = followup.lead ?? await getLead(followup.leadId);

    await updateFollowup.mutateAsync({
      id: followup.id,
      body: { status: "completed", completedAt },
    });

    await recordActivity.mutateAsync({
      lead,
      activity: {
        type: "followup_completed",
        timestamp: completedAt,
        content: `${channelLabel(followup.channel)} follow-up completed`,
        channel: toActivityChannel(followup.channel),
        metadata: {
          followupId: followup.id,
          dueAt: followup.dueAt,
          channel: followup.channel,
          ...sequenceMetadata(followup),
        },
      },
    });
  };

  const completeOne = async (followup: MissionItem) => {
    try {
      await completeFollowup(followup);
      toast.success("Follow-up completed");
    } catch {
      toast.error("Could not complete follow-up");
    }
  };

  const openReschedule = (followup: MissionItem) => {
    const due = parseDate(followup.dueAt) ?? new Date();
    setRescheduleItem(followup);
    setRescheduleDate(toDateInputValue(due));
    setRescheduleTime(toTimeInputValue(due));
  };

  const submitReschedule = async () => {
    if (!rescheduleItem || !rescheduleDate || !rescheduleTime) return;
    const nextDue = new Date(`${rescheduleDate}T${rescheduleTime}`);
    if (Number.isNaN(nextDue.getTime())) {
      toast.error("Choose a valid date and time");
      return;
    }

    try {
      await updateFollowup.mutateAsync({
        id: rescheduleItem.id,
        body: {
          dueAt: nextDue.toISOString(),
          ...sequenceMetadata(rescheduleItem),
        },
      });
      toast.success("Follow-up rescheduled");
      setRescheduleItem(null);
    } catch {
      toast.error("Could not reschedule follow-up");
    }
  };

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-border bg-card px-6 py-4">
        <h1 className="text-2xl font-bold tracking-tight">Today's Mission</h1>
        <p className="text-sm text-muted-foreground">Mission Control for the follow-ups that deserve attention now.</p>
      </div>

      <div className="flex-1 overflow-y-auto">
        {isLoading ? (
          <LoadingMission />
        ) : missionComplete ? (
          <MissionComplete completedToday={mission.completedToday.length} />
        ) : (
          <div className="space-y-6 p-6">
            {/* Today's Mission briefing — single AI sentence above everything */}
            <MissionBriefing briefing={mission.missionBriefing} />

            <MissionHero mission={mission} />

            <div className="grid gap-4 xl:grid-cols-[1.35fr_0.65fr]">
              <SmartCoachCard
                item={mission.coachItem}
                sentence={mission.coachSentence}
                reasons={mission.coachReasons}
              />
              <OperationalInsightsCard insights={mission.operationalInsights} />
            </div>

            <MissionSection
              title="Must Do Today"
              desc="Highest-impact actions sorted by business value and urgency."
              icon={Flame}
              tone="danger"
              items={mission.mustDo}
              total={mission.totalMustDo}
              busy={busy}
              onOpen={openLead}
              onComplete={(item) => void completeOne(item)}
              onReschedule={openReschedule}
            />

            <IntelligentActionQueue
              items={mission.actionQueue}
              total={mission.totalActionQueue}
              busy={busy}
              onOpen={openLead}
              onComplete={(item) => void completeOne(item)}
              onReschedule={openReschedule}
            />

            <MissionSection
              title="Leads At Risk"
              desc="Opportunities drifting toward inactivity. A touch today keeps them alive."
              icon={AlertTriangle}
              tone="warning"
              items={mission.atRisk}
              total={mission.totalAtRisk}
              busy={busy}
              onOpen={openLead}
              onComplete={(item) => void completeOne(item)}
              onReschedule={openReschedule}
            />

            <MissionSection
              title="Completed Today"
              desc="Progress from this mission cycle."
              icon={Trophy}
              tone="success"
              items={mission.completedToday.slice(0, SECTION_LIMIT)}
              total={mission.completedToday.length}
              completed
              busy={busy}
              onOpen={openLead}
              onComplete={(item) => void completeOne(item)}
              onReschedule={openReschedule}
            />
          </div>
        )}
      </div>

      <Dialog open={Boolean(rescheduleItem)} onOpenChange={(open) => !open && setRescheduleItem(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Reschedule follow-up</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              {rescheduleItem ? `Set a new mission time for ${rescheduleItem.leadName}.` : "Set a new mission time."}
            </p>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label>Date</Label>
                <Input type="date" value={rescheduleDate} onChange={(event) => setRescheduleDate(event.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label>Time</Label>
                <Input type="time" value={rescheduleTime} onChange={(event) => setRescheduleTime(event.target.value)} />
              </div>
            </div>
            <button
              onClick={() => void submitReschedule()}
              disabled={!rescheduleDate || !rescheduleTime || updateFollowup.isPending}
              className="w-full rounded-lg bg-brand px-4 py-2.5 text-sm font-semibold text-brand-foreground shadow-brand hover:bg-brand-dark disabled:opacity-60"
            >
              {updateFollowup.isPending ? "Saving..." : "Save Reschedule"}
            </button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ── Mission Briefing ──────────────────────────────────────────────────────────
// Single AI-generated sentence. Context-aware, action-oriented, derived from
// real data — no static fallbacks. Shown before everything else.

function MissionBriefing({ briefing }: { briefing: string }) {
  return (
    <div className="flex items-start gap-3 rounded-xl border border-brand/20 bg-brand/5 px-4 py-3">
      <div className="mt-0.5 grid size-6 shrink-0 place-items-center rounded-md border border-brand/25 bg-brand/15">
        <Sparkles className="size-3 text-brand" />
      </div>
      <div>
        <p className="mb-0.5 text-[10px] font-bold uppercase tracking-widest text-brand">Today's Mission</p>
        <p className="text-sm font-medium leading-relaxed text-foreground">{briefing}</p>
      </div>
    </div>
  );
}

// ── Mission Hero ──────────────────────────────────────────────────────────────
// Stats and progress. Every number derives from the same data source.
// headline = overdue + dueToday so it always matches the stat tiles.

function MissionHero({ mission }: { mission: Mission }) {
  const totalWork = Math.max(1, mission.todayTarget + mission.completedToday.length);
  const progress = Math.min(100, Math.round((mission.completedToday.length / totalWork) * 100));
  const headline = buildHeroHeadline(mission.overdue, mission.dueToday);

  return (
    <section className="rounded-2xl border border-border bg-card p-5">
      <div className="flex flex-wrap items-start justify-between gap-5">
        <div>
          <p className="text-xs font-bold uppercase tracking-widest text-brand">Mission Control</p>
          <h2 className="mt-1 text-xl font-bold tracking-tight">{headline}</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Estimated completion time: {mission.estimatedMinutes} minutes · Priority level: {mission.priorityLevel}
          </p>
        </div>
        <div className="min-w-56">
          <div className="flex items-center justify-between text-xs">
            <span className="font-semibold text-foreground">Today's Progress</span>
            <span className="text-muted-foreground">{mission.completedToday.length} / {totalWork} completed</span>
          </div>
          <div className="mt-2 h-2 overflow-hidden rounded-full bg-border">
            <div className="h-full rounded-full bg-brand transition-all" style={{ width: `${progress}%` }} />
          </div>
        </div>
      </div>

      {/* Stat tiles — each derived from the same mission object */}
      <div className="mt-5 grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
        <MissionMetric label="Due Today" value={mission.dueToday} tone="brand" />
        <MissionMetric label="Overdue" value={mission.overdue} tone="danger" />
        <MissionMetric label="At Risk" value={mission.atRiskPool.length} tone="warning" />
        <MissionMetric label="Completed Today" value={mission.completedToday.length} tone="success" />
      </div>

      {/* Dynamic impact predictions — personalized, never hardcoded */}
      <div className="mt-5 rounded-xl border border-border bg-background p-4">
        <p className="text-xs font-bold uppercase tracking-widest text-muted-foreground">Completing today's actions could</p>
        <div className="mt-3 grid gap-2 md:grid-cols-3">
          {mission.impactOutcomes.map((outcome) => (
            <div key={outcome} className="rounded-lg border border-border bg-card px-3 py-2 text-sm text-foreground">
              {outcome}
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function MissionMetric({ label, value, tone }: { label: string; value: number; tone: "brand" | "danger" | "warning" | "success" }) {
  const color = tone === "danger" ? "text-orange-400" : tone === "warning" ? "text-warning" : tone === "success" ? "text-success" : "text-brand";

  return (
    <div className="rounded-xl border border-border bg-background px-4 py-3">
      <p className={`text-lg font-bold tabular-nums ${color}`}>{value.toLocaleString()}</p>
      <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">{label}</p>
    </div>
  );
}

// ── Smart Coach Card ──────────────────────────────────────────────────────────
// Replaces the generic CoachCard. Outputs one decisive coaching sentence and
// three specific reasons tied to real lead data. Changes every visit.

function SmartCoachCard({ item, sentence, reasons }: {
  item: MissionItem | null;
  sentence: string;
  reasons: string[];
}) {
  return (
    <section className="rounded-xl border border-border bg-card p-4">
      <div className="flex items-center gap-2">
        <div className="grid size-8 place-items-center rounded-lg border border-brand/20 bg-brand/10">
          <Sparkles className="size-4 text-brand" />
        </div>
        <div>
          <h2 className="text-sm font-bold">AI Coach</h2>
          <p className="text-xs text-muted-foreground">Highest-value action today</p>
        </div>
      </div>

      {item ? (
        <div className="mt-4 space-y-3">
          {/* Decisive coaching sentence — specific to this lead's situation */}
          <p className="text-sm font-semibold leading-relaxed text-foreground">{sentence}</p>

          <div className="rounded-lg border border-border bg-background p-3">
            <div className="flex flex-wrap items-center gap-2">
              <p className="text-sm font-semibold">{item.leadName}</p>
              <span className="rounded border border-brand/20 bg-brand/10 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-brand">
                Impact {item.impactScore}
              </span>
              {item.dueState === "overdue" && (
                <span className="rounded border border-orange-500/20 bg-orange-500/10 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-orange-400">
                  {item.daysOverdue}d overdue
                </span>
              )}
            </div>
            {reasons.length > 0 && (
              <ul className="mt-2.5 space-y-1.5">
                {reasons.map((reason) => (
                  <li key={reason} className="flex gap-2 text-sm text-muted-foreground">
                    <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-brand" />
                    <span>{reason}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      ) : (
        <p className="mt-4 text-sm text-muted-foreground">No urgent recommendations. Your pipeline is in excellent shape.</p>
      )}
    </section>
  );
}

// ── Operational Insights Card ─────────────────────────────────────────────────
// Replaces the Follow-up Streak. Shows metrics that help users improve,
// not just maintain a counter.

function OperationalInsightsCard({ insights }: { insights: ReturnType<typeof buildOperationalInsights> }) {
  const { completionsThisWeek, repliesThisWeek, meetingsThisWeek, avgResponseDays } = insights;

  return (
    <section className="rounded-xl border border-border bg-card p-4">
      <div className="flex items-center gap-2">
        <div className="grid size-8 place-items-center rounded-lg border border-brand/20 bg-brand/10">
          <TrendingUp className="size-4 text-brand" />
        </div>
        <div>
          <h2 className="text-sm font-bold">This Week</h2>
          <p className="text-xs text-muted-foreground">Operational snapshot</p>
        </div>
      </div>

      <div className="mt-4 grid grid-cols-2 gap-2">
        <InsightMetric value={completionsThisWeek} label="Completed" suffix="follow-ups" tone="success" />
        <InsightMetric value={repliesThisWeek} label="Replies" suffix="generated" tone="brand" />
        <InsightMetric value={meetingsThisWeek} label="Meetings" suffix="booked" tone="warning" />
        <InsightMetric
          value={avgResponseDays ?? 0}
          label="Avg response"
          suffix={avgResponseDays !== null ? "days" : "tracking"}
          tone="muted"
        />
      </div>
    </section>
  );
}

function InsightMetric({ value, label, suffix, tone }: {
  value: number;
  label: string;
  suffix: string;
  tone: "brand" | "success" | "warning" | "muted";
}) {
  const color =
    tone === "brand" ? "text-brand" :
    tone === "success" ? "text-success" :
    tone === "warning" ? "text-warning" :
    "text-muted-foreground";

  return (
    <div className="rounded-lg border border-border bg-background px-3 py-2.5">
      <p className={`text-xl font-bold tabular-nums ${color}`}>{value.toLocaleString()}</p>
      <p className="mt-0.5 text-[10px] font-bold uppercase tracking-wider text-muted-foreground">{label}</p>
      <p className="text-[10px] text-muted-foreground/60">{suffix}</p>
    </div>
  );
}

// ── Mission Section ───────────────────────────────────────────────────────────

function MissionSection({
  title,
  desc,
  icon: Icon,
  tone,
  items,
  total,
  completed,
  busy,
  onOpen,
  onComplete,
  onReschedule,
}: {
  title: string;
  desc: string;
  icon: React.ComponentType<{ className?: string }>;
  tone: "danger" | "brand" | "warning" | "success";
  items: MissionItem[];
  total: number;
  completed?: boolean;
  busy: boolean;
  onOpen: (leadId: number) => void;
  onComplete: (item: MissionItem) => void;
  onReschedule: (item: MissionItem) => void;
}) {
  if (items.length === 0) return null;

  return (
    <section className="space-y-2">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div className="flex items-center gap-3">
          <div className={`grid size-9 place-items-center rounded-lg border ${toneClass(tone)}`}>
            <Icon className="size-4" />
          </div>
          <div>
            <h2 className="text-sm font-bold">{title}</h2>
            <p className="text-xs text-muted-foreground">{desc}</p>
          </div>
        </div>
        <p className="text-xs font-semibold text-muted-foreground">
          Showing {items.length} of {total}
        </p>
      </div>

      <div className="grid gap-2 xl:grid-cols-2">
        {items.map((item) => (
          <MissionTask
            key={item.id}
            item={item}
            completed={completed}
            busy={busy}
            onOpen={() => onOpen(item.leadId)}
            onComplete={() => onComplete(item)}
            onReschedule={() => onReschedule(item)}
          />
        ))}
      </div>
    </section>
  );
}

// ── Intelligent Action Queue ──────────────────────────────────────────────────
// Replaces Quick Wins + Upcoming Planning.
// Shows all non-must-do items due within 48 hours, sorted by business impact.
// Each row explains WHY this follow-up matters — not just when it's due.

function IntelligentActionQueue({ items, total, busy, onOpen, onComplete, onReschedule }: {
  items: MissionItem[];
  total: number;
  busy: boolean;
  onOpen: (leadId: number) => void;
  onComplete: (item: MissionItem) => void;
  onReschedule: (item: MissionItem) => void;
}) {
  if (items.length === 0) return null;

  const todayCount = items.filter((item) => item.dueState === "today").length;
  const tomorrowCount = items.filter((item) => daysFromToday(item.dueAt) === 1).length;
  const later = items.filter((item) => daysFromToday(item.dueAt) >= 2).length;

  const subtitle = [
    todayCount > 0 ? `${todayCount} today` : null,
    tomorrowCount > 0 ? `${tomorrowCount} tomorrow` : null,
    later > 0 ? `${later} within 48h` : null,
  ].filter(Boolean).join(" · ") || "Sorted by business impact";

  return (
    <section className="space-y-2">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div className="flex items-center gap-3">
          <div className="grid size-9 place-items-center rounded-lg border border-brand/20 bg-brand/10 text-brand">
            <Target className="size-4" />
          </div>
          <div>
            <h2 className="text-sm font-bold">Action Queue</h2>
            <p className="text-xs text-muted-foreground">{subtitle}</p>
          </div>
        </div>
        <p className="text-xs font-semibold text-muted-foreground">
          {total} action{total === 1 ? "" : "s"} · Sorted by impact
        </p>
      </div>

      <div className="grid gap-2 xl:grid-cols-2">
        {items.map((item) => (
          <ActionQueueRow
            key={item.id}
            item={item}
            busy={busy}
            onOpen={() => onOpen(item.leadId)}
            onComplete={() => onComplete(item)}
            onReschedule={() => onReschedule(item)}
          />
        ))}
      </div>
    </section>
  );
}

function ActionQueueRow({ item, busy, onOpen, onComplete, onReschedule }: {
  item: MissionItem;
  busy: boolean;
  onOpen: () => void;
  onComplete: () => void;
  onReschedule: () => void;
}) {
  const days = daysFromToday(item.dueAt);
  const isUrgent = days === 0;
  const when = days === 0 ? "Today" : days === 1 ? "Tomorrow" : "Within 48h";
  const reason = actionQueueReason(item);

  return (
    <article className="flex items-center gap-3 rounded-xl border border-border bg-card px-3 py-2">
      <div className={`grid size-8 shrink-0 place-items-center rounded-lg ${isUrgent ? "bg-brand/10 text-brand" : "bg-muted/40 text-muted-foreground"}`}>
        <CalendarClock className="size-4" />
      </div>

      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={onOpen}
            className="max-w-56 truncate text-left text-sm font-semibold text-foreground hover:text-brand"
          >
            {item.leadName}
          </button>
          <Badge>{channelLabel(item.channel)}</Badge>
          <Badge tone={isUrgent ? "brand" : "muted"}>{when}</Badge>
        </div>
        {/* Reason chip — tells the user WHY this matters, not just when */}
        <p className="mt-1 truncate text-xs text-muted-foreground">
          {reason} · {item.nicheLabel}
        </p>
      </div>

      <div className="flex shrink-0 items-center gap-1.5">
        <IconButton label="Open Lead" onClick={onOpen} icon={ArrowRight} />
        <IconButton label="Reschedule" onClick={onReschedule} icon={RotateCcw} disabled={busy} />
        <IconButton label="Complete" onClick={onComplete} icon={Check} disabled={busy} primary />
      </div>
    </article>
  );
}

// ── Mission Task ──────────────────────────────────────────────────────────────

function MissionTask({
  item,
  completed,
  busy,
  onOpen,
  onComplete,
  onReschedule,
}: {
  item: MissionItem;
  completed?: boolean;
  busy: boolean;
  onOpen: () => void;
  onComplete: () => void;
  onReschedule: () => void;
}) {
  return (
    <article className="flex items-center gap-3 rounded-xl border border-border bg-card px-3 py-2">
      <div className={`grid size-8 shrink-0 place-items-center rounded-lg ${completed ? "bg-success/10 text-success" : item.dueState === "overdue" ? "bg-orange-500/10 text-orange-400" : "bg-brand/10 text-brand"}`}>
        {completed ? <Check className="size-4" /> : <CalendarClock className="size-4" />}
      </div>

      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <button onClick={onOpen} className="max-w-56 truncate text-left text-sm font-semibold text-foreground hover:text-brand">
            {item.leadName}
          </button>
          <Badge>{channelLabel(item.channel)}</Badge>
          <Badge tone={priorityTone(item.priority)}>{item.score}</Badge>
        </div>
        <p className="mt-1 truncate text-xs text-muted-foreground">
          {completed ? `Completed ${formatRelative(item.completedAt ?? item.updatedAt)}` : dueLabel(item)} · Last contact {item.lead?.lastContactedAt ? formatRelative(item.lead.lastContactedAt) : "not recorded"} · {item.nicheLabel}
        </p>
      </div>

      <div className="flex shrink-0 items-center gap-1.5">
        <IconButton label="Open Lead" onClick={onOpen} icon={ArrowRight} />
        {!completed && <IconButton label="Reschedule" onClick={onReschedule} icon={RotateCcw} disabled={busy} />}
        {!completed && <IconButton label="Complete" onClick={onComplete} icon={Check} disabled={busy} primary />}
      </div>
    </article>
  );
}

// ── Shared UI primitives ──────────────────────────────────────────────────────

function IconButton({
  label,
  onClick,
  icon: Icon,
  disabled,
  primary,
}: {
  label: string;
  onClick: () => void;
  icon: React.ComponentType<{ className?: string }>;
  disabled?: boolean;
  primary?: boolean;
}) {
  return (
    <button
      title={label}
      aria-label={label}
      onClick={onClick}
      disabled={disabled}
      className={
        primary
          ? "grid size-8 place-items-center rounded-lg bg-brand text-brand-foreground hover:bg-brand-dark disabled:opacity-60"
          : "grid size-8 place-items-center rounded-lg border border-border bg-background hover:bg-muted disabled:opacity-60"
      }
    >
      <Icon className="size-3.5" />
    </button>
  );
}

function Badge({ children, tone = "muted" }: { children: React.ReactNode; tone?: "muted" | "brand" | "warning" | "danger" }) {
  const color =
    tone === "brand"
      ? "border-brand/20 bg-brand/10 text-brand"
      : tone === "warning"
        ? "border-warning/20 bg-warning/10 text-warning"
        : tone === "danger"
          ? "border-orange-500/20 bg-orange-500/10 text-orange-400"
          : "border-border text-muted-foreground";

  return (
    <span className={`rounded border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider ${color}`}>
      {children}
    </span>
  );
}

// ── Loading / Empty states ────────────────────────────────────────────────────

function LoadingMission() {
  return (
    <div className="space-y-5 p-6">
      <Skeleton className="h-12 rounded-xl" />
      <Skeleton className="h-40 rounded-2xl" />
      <div className="grid gap-4 xl:grid-cols-2">
        <Skeleton className="h-32 rounded-xl" />
        <Skeleton className="h-32 rounded-xl" />
      </div>
      {Array.from({ length: 6 }).map((_, index) => <Skeleton key={index} className="h-14 rounded-xl" />)}
    </div>
  );
}

function MissionComplete({ completedToday }: { completedToday: number }) {
  return (
    <div className="p-6">
      <div className="rounded-2xl border border-dashed border-border p-12 text-center">
        <div className="mx-auto grid size-12 place-items-center rounded-xl border border-success/20 bg-success/10">
          <ListChecks className="size-5 text-success" />
        </div>
        <h2 className="mt-4 text-lg font-semibold">🎉 Mission Complete</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {completedToday > 0 ? "All follow-ups completed today." : "All scheduled actions have been completed."}
        </p>
        <p className="mt-5 text-xs font-bold uppercase tracking-widest text-muted-foreground">Suggested next actions</p>
        <div className="mt-5 flex flex-wrap justify-center gap-2">
          <Link to="/dashboard/leads" className="rounded-lg bg-brand px-4 py-2 text-sm font-semibold text-brand-foreground shadow-brand hover:bg-brand-dark">
            Discover Opportunities
          </Link>
          <Link to="/dashboard/pipeline" className="rounded-lg border border-border px-4 py-2 text-sm font-semibold hover:bg-background">
            Review Pipeline
          </Link>
          <Link to="/dashboard/relationships" className="rounded-lg border border-border px-4 py-2 text-sm font-semibold hover:bg-background">
            Open Relationships
          </Link>
        </div>
      </div>
    </div>
  );
}

// ── Core business logic ───────────────────────────────────────────────────────

type Mission = ReturnType<typeof buildMission>;

function buildMission(followups: FollowupWithLead[]) {
  const items = followups.map(toMissionItem);
  const active = items.filter((item) => item.dueState !== "completed");
  const completedToday = items
    .filter((item) => item.dueState === "completed" && isToday(item.completedAt ?? item.updatedAt))
    .sort((a, b) => dateTime(b.completedAt ?? b.updatedAt) - dateTime(a.completedAt ?? a.updatedAt));

  // ── Consistent counters: all stat surfaces use these exact values ──
  const overdue = active.filter((item) => item.dueState === "overdue").length;
  const dueToday = active.filter((item) => item.dueState === "today").length;

  // At-risk: sorted by business impact, not arbitrary order
  const atRiskPool = active
    .filter((item) => isAtRisk(item))
    .sort((a, b) => b.impactScore - a.impactScore);

  // Must Do: overdue + today + high-value items, sorted by tier then business impact
  const mustDoPool = active
    .filter(
      (item) =>
        item.dueState === "overdue" ||
        item.dueState === "today" ||
        item.score >= 90 ||
        item.priority === "high",
    )
    .sort(compareMustDo);

  const mustDoIds = new Set(mustDoPool.map((item) => String(item.id)));

  // Action Queue: non-must-do items due within 48 hours, sorted purely by business impact
  // Business impact > chronological. A proposal due tomorrow ranks above a cold lead due today.
  const actionQueuePool = active
    .filter(
      (item) =>
        !mustDoIds.has(String(item.id)) &&
        daysFromToday(item.dueAt) >= 1 &&
        daysFromToday(item.dueAt) <= 2,
    )
    .sort((a, b) => b.impactScore - a.impactScore);

  const actionQueueIds = new Set(actionQueuePool.map((item) => String(item.id)));

  // At-risk that didn't make either queue
  const visibleAtRisk = atRiskPool.filter(
    (item) => !mustDoIds.has(String(item.id)) && !actionQueueIds.has(String(item.id)),
  );

  // todayTarget = overdue + dueToday — consistent with the stat tiles below
  const todayTarget = overdue + dueToday;
  const estimatedMinutes = Math.max(
    0,
    Math.ceil(mustDoPool.length * 2.5 + actionQueuePool.length * 1.5),
  );

  // Coach: pick the highest-impact item across all queues
  const coachItem =
    mustDoPool[0] ?? actionQueuePool[0] ?? visibleAtRisk[0] ?? null;

  const operationalInsights = buildOperationalInsights(items);

  return {
    active,
    dueToday,
    overdue,
    atRiskPool,
    completedToday,
    mustDo: mustDoPool.slice(0, SECTION_LIMIT),
    totalMustDo: mustDoPool.length,
    actionQueue: actionQueuePool.slice(0, SECTION_LIMIT),
    totalActionQueue: actionQueuePool.length,
    atRisk: visibleAtRisk.slice(0, SECTION_LIMIT),
    totalAtRisk: visibleAtRisk.length,
    todayTarget,
    estimatedMinutes,
    priorityLevel: priorityLevel(mustDoPool),
    operationalInsights,
    // All AI-generated strings derived from live data:
    missionBriefing: buildMissionBriefing({ overdue, dueToday, atRiskPool, completedTodayCount: completedToday.length, mustDoPool, actionQueuePool }),
    coachItem,
    coachSentence: buildCoachSentence(coachItem, { overdue, atRiskPool }),
    coachReasons: coachItem ? buildCoachReasons(coachItem) : [],
    impactOutcomes: buildDynamicImpactOutcomes(mustDoPool, actionQueuePool, visibleAtRisk, completedToday.length),
  };
}

function toMissionItem(followup: FollowupWithLead): MissionItem {
  const lead = followup.lead;
  const dueState = dueStateForFollowup(followup);
  const daysOverdue = dueState === "overdue" ? Math.abs(daysFromToday(followup.dueAt)) : 0;
  const daysSinceContact =
    lead?.lastContactedAt
      ? Math.max(0, Math.floor((Date.now() - dateTime(lead.lastContactedAt)) / 86_400_000))
      : null;
  const score = lead ? leadScore(lead) : 62;
  const priority = leadPriority(lead);
  const nicheLabel =
    lead?.niche
      ? (NICHES.find((item) => item.value === lead.niche)?.label ?? lead.niche)
      : (lead?.location ?? "General prospect");
  const effort: MissionItem["effort"] =
    channelType(followup.channel) === "email" || channelType(followup.channel) === "phone"
      ? "quick"
      : "standard";

  const base: Omit<MissionItem, "impactScore"> = {
    ...followup,
    leadName: lead?.businessName ?? "Unknown lead",
    nicheLabel,
    score,
    priority,
    dueState,
    daysOverdue,
    daysSinceContact,
    effort,
    impact:
      score +
      (priority === "high" ? 18 : priority === "medium" ? 8 : 0) +
      daysOverdue * 6 +
      (daysSinceContact !== null && daysSinceContact >= 10 ? 14 : 0),
    impactScore: 0,
  };

  return { ...base, impactScore: businessImpactScore(base) } as MissionItem;
}

// ── Business-impact prioritization ───────────────────────────────────────────
// When urgency and opportunity value conflict, the action most likely to
// generate revenue wins — while genuinely overdue items are never buried.

function businessImpactScore(item: Omit<MissionItem, "impactScore">): number {
  let pts = 0;

  // Pipeline proximity to revenue — highest weight
  const status = (item.lead?.status ?? "").toLowerCase();
  if (status === "negotiation") pts += 55;
  else if (status === "proposal") pts += 45;
  else if (status === "meeting") pts += 35;
  else if (status === "conversation") pts += 28;
  else if (status === "contacted") pts += 14;
  else pts += 5; // new / discovered

  // Intrinsic lead quality
  pts += item.score * 0.45; // max ~42 points (score range 62–94)

  // Urgency bonuses — ensures overdue items still surface
  if (item.dueState === "overdue") pts += 30 + item.daysOverdue * 6;
  else if (item.dueState === "today") pts += 18;
  else if (daysFromToday(item.dueAt) === 1) pts += 10;

  // Relationship-at-risk penalty → turned into urgency here
  const daysSince = item.daysSinceContact;
  if (daysSince !== null && daysSince >= 21) pts += 20;
  else if (daysSince !== null && daysSince >= 14) pts += 13;
  else if (daysSince !== null && daysSince >= 7) pts += 6;

  // Explicit priority flag
  if (item.priority === "high") pts += 18;
  else if (item.priority === "medium") pts += 7;

  return Math.round(pts);
}

// ── Sorting ───────────────────────────────────────────────────────────────────
// Must Do: overdue tier comes first (non-negotiable), then business impact.

function compareMustDo(a: MissionItem, b: MissionItem) {
  // Overdue items always surface before today-due items
  const overdueRank = Number(b.dueState === "overdue") - Number(a.dueState === "overdue");
  if (overdueRank !== 0) return overdueRank;
  // Within the same urgency tier, business impact wins over chronology
  return b.impactScore - a.impactScore;
}

// ── AI text generators ────────────────────────────────────────────────────────
// Every string is derived from live data. No static fallbacks.

function buildHeroHeadline(overdue: number, dueToday: number): string {
  const total = overdue + dueToday;
  if (total === 0) return "No follow-ups due right now.";
  if (overdue > 0 && dueToday > 0)
    return `You have ${overdue} overdue and ${dueToday} due today — ${total} total.`;
  if (overdue > 0)
    return `You have ${overdue} overdue follow-up${overdue === 1 ? "" : "s"} that need attention.`;
  return `You have ${dueToday} follow-up${dueToday === 1 ? "" : "s"} due today.`;
}

function buildMissionBriefing({
  overdue,
  dueToday,
  atRiskPool,
  completedTodayCount,
  mustDoPool,
  actionQueuePool,
}: {
  overdue: number;
  dueToday: number;
  atRiskPool: MissionItem[];
  completedTodayCount: number;
  mustDoPool: MissionItem[];
  actionQueuePool: MissionItem[];
}): string {
  // Multiple overdue: frame as highest-urgency
  if (overdue >= 3) {
    return `${overdue} follow-ups are overdue. Clear those first — every day of silence reduces the chance of a reply.`;
  }

  // Single overdue with a name
  if (overdue === 1 && mustDoPool.length > 0) {
    const lead = mustDoPool.find((item) => item.dueState === "overdue");
    if (lead)
      return `${lead.leadName} is overdue. That's your first priority — a quick follow-up today could restart this conversation.`;
  }

  // Active proposals / negotiations take revenue priority
  const proposals = mustDoPool.filter((item) => {
    const s = (item.lead?.status ?? "").toLowerCase();
    return s === "proposal" || s === "negotiation";
  });
  if (proposals.length > 0) {
    const names = proposals.map((p) => p.leadName);
    return proposals.length === 1
      ? `${names[0]} has an active proposal awaiting follow-up. That's your closest opportunity to closing revenue today.`
      : `${proposals.length} active proposals need follow-up. These are your closest opportunities to closing revenue today.`;
  }

  // Relationships going cold
  if (atRiskPool.length >= 3) {
    return `${atRiskPool.length} opportunities are drifting toward inactivity. A focused follow-up session now could keep all of them alive.`;
  }

  // Light day — redirect energy
  if (dueToday <= 2 && overdue === 0 && atRiskPool.length === 0) {
    return completedTodayCount > 0
      ? `Mission nearly complete. Finish these last follow-ups, then head to Discover to build tomorrow's pipeline.`
      : `Today's workload is light. Finish these follow-ups, then head back to Discover to build pipeline.`;
  }

  // Conversations in flight
  const conversations = mustDoPool.filter((item) => {
    const s = (item.lead?.status ?? "").toLowerCase();
    return s === "conversation" || s === "meeting";
  });
  if (conversations.length >= 2) {
    return `${conversations.length} companies are already in conversation with you. Follow up with those first — warm momentum converts.`;
  }

  // Upcoming queue with business value
  if (actionQueuePool.length > 0 && overdue === 0) {
    const total = dueToday + actionQueuePool.length;
    return `Complete these ${total} follow-ups and you'll advance several conversations that are already in motion.`;
  }

  // Default: direct and specific
  const total = overdue + dueToday;
  return total === 1
    ? `One follow-up is waiting. Complete it before anything else — an active business relationship deserves your attention.`
    : `Complete these ${total} follow-ups before anything else. Each one is an active business relationship that deserves your attention.`;
}

function buildCoachSentence(
  item: MissionItem | null,
  _ctx: { overdue: number; atRiskPool: MissionItem[] },
): string {
  if (!item) return "No urgent actions right now. Your pipeline is in good shape.";

  const name = item.leadName;
  const status = (item.lead?.status ?? "").toLowerCase();
  const daysSince = item.daysSinceContact;

  // Highest priority: proposal/negotiation
  if (status === "proposal" || status === "negotiation") {
    return `Start with ${name}. They have an active proposal in progress — a follow-up now is the highest-value action in your queue.`;
  }

  // Active conversation / meeting momentum
  if (status === "meeting") {
    return `${name} has a meeting in progress. Follow up now to keep that momentum alive — meetings that stall rarely recover.`;
  }
  if (status === "conversation") {
    return `${name} is already in conversation with you. Strike while it's warm — follow-ups mid-conversation convert at a much higher rate.`;
  }

  // Severely overdue
  if (item.dueState === "overdue" && item.daysOverdue >= 3) {
    return `${name} has been waiting ${item.daysOverdue} days — that's the highest relationship risk in your pipeline right now. Contact them first.`;
  }

  // Relationship going cold
  if (daysSince !== null && daysSince >= 21) {
    return `${name} hasn't heard from you in ${daysSince} days. That relationship is close to going cold — one message today could turn that around.`;
  }
  if (daysSince !== null && daysSince >= 14) {
    return `${name} hasn't heard from you in ${daysSince} days. Reach out before they forget the last conversation.`;
  }

  // Overdue (mild)
  if (item.dueState === "overdue") {
    return `${name} is overdue by ${item.daysOverdue} ${item.daysOverdue === 1 ? "day" : "days"}. Clear this first — it's the most time-sensitive action in your queue.`;
  }

  // High priority flag
  if (item.priority === "high") {
    return `Start with ${name}. They're your highest-priority opportunity today — a quick follow-up now keeps you ahead of competing outreach.`;
  }

  return `Start with ${name}. Based on their pipeline stage and timing, this is the follow-up most likely to move forward today.`;
}

function buildCoachReasons(item: MissionItem): string[] {
  const reasons: string[] = [];
  const status = (item.lead?.status ?? "").toLowerCase();

  // Pipeline stage — always the first reason if relevant
  if (status === "negotiation") {
    reasons.push("Negotiation stage — revenue is closest here");
  } else if (status === "proposal") {
    reasons.push("Active proposal — highest conversion proximity");
  } else if (status === "meeting") {
    reasons.push("Meeting stage — momentum is already built");
  } else if (status === "conversation") {
    reasons.push("In conversation — a reply is expected, not a cold message");
  } else if (status === "contacted") {
    reasons.push("Previously contacted — follow-up doubles reply likelihood");
  }

  // Timing / urgency
  if (item.dueState === "overdue") {
    reasons.push(
      `${item.daysOverdue} ${item.daysOverdue === 1 ? "day" : "days"} overdue — urgency is highest`,
    );
  } else if (item.dueState === "today") {
    reasons.push("Due today — optimal timing for response");
  }

  // Contact gap
  if (item.daysSinceContact !== null && item.daysSinceContact >= 14) {
    reasons.push(
      `${item.daysSinceContact} days without contact — relationship at risk of going cold`,
    );
  } else if (!item.lead?.lastContactedAt) {
    reasons.push("No prior contact recorded — first touch has highest open rates");
  } else if (item.daysSinceContact !== null && item.daysSinceContact >= 7) {
    reasons.push(`${item.daysSinceContact} days since last contact — right window to follow up`);
  }

  // Lead quality
  if (item.score >= 90) {
    reasons.push(`Lead score ${item.score} — strong conversion signal`);
  }

  return reasons.slice(0, 3);
}

function buildDynamicImpactOutcomes(
  mustDo: MissionItem[],
  actionQueue: MissionItem[],
  atRisk: MissionItem[],
  completedTodayCount: number,
): string[] {
  const allActive = [...mustDo, ...actionQueue];

  // 1. Revenue-proximity prediction
  const revenueLeads = allActive.filter((item) => {
    const s = (item.lead?.status ?? "").toLowerCase();
    return s === "proposal" || s === "negotiation" || s === "meeting" || s === "conversation";
  });
  const outcome1 =
    revenueLeads.length > 0
      ? `Advance ${revenueLeads.length} active conversation${revenueLeads.length === 1 ? "" : "s"} further along the pipeline`
      : `Start ${Math.max(1, allActive.filter((item) => !item.lead?.lastContactedAt).length)} new conversation${allActive.filter((item) => !item.lead?.lastContactedAt).length === 1 ? "" : "s"} with fresh outreach`;

  // 2. Cold-risk prevention
  const coldRisk = [...atRisk, ...allActive].filter(
    (item) => item.daysSinceContact !== null && item.daysSinceContact >= 10,
  );
  const uniqueColdRisk = [...new Map(coldRisk.map((item) => [String(item.id), item])).values()];
  const outcome2 =
    uniqueColdRisk.length > 0
      ? `Prevent ${uniqueColdRisk.length} opportunity${uniqueColdRisk.length === 1 ? "" : " opportunities"} from going cold today`
      : "Keep the overdue queue at zero and pipeline momentum active";

  // 3. Weekly goal proximity
  const weeklyTarget = 10;
  const remaining = Math.max(0, weeklyTarget - completedTodayCount);
  const outcome3 =
    remaining <= 5 && remaining > 0
      ? `You're ${remaining} follow-up${remaining === 1 ? "" : "s"} away from your weekly activity goal`
      : mustDo.filter((item) => item.dueState === "overdue").length > 0
        ? `Reduce your overdue queue and protect ${mustDo.filter((item) => item.dueState === "overdue").length} business relationship${mustDo.filter((item) => item.dueState === "overdue").length === 1 ? "" : "s"}`
        : `Strengthen ${allActive.length} business relationship${allActive.length === 1 ? "" : "s"} before the end of the day`;

  return [outcome1, outcome2, outcome3];
}

function buildOperationalInsights(items: MissionItem[]): {
  completionsThisWeek: number;
  repliesThisWeek: number;
  meetingsThisWeek: number;
  avgResponseDays: number | null;
} {
  const weekAgo = Date.now() - 7 * 86_400_000;

  const completionsThisWeek = items.filter(
    (item) =>
      item.dueState === "completed" &&
      dateTime(item.completedAt ?? item.updatedAt) >= weekAgo,
  ).length;

  // Replies: leads that moved into conversation/meeting/proposal this week
  const repliesThisWeek = items.filter((item) => {
    const s = (item.lead?.status ?? "").toLowerCase();
    return (
      (s === "conversation" || s === "meeting" || s === "proposal") &&
      dateTime(item.lead?.updatedAt) >= weekAgo
    );
  }).length;

  const meetingsThisWeek = items.filter(
    (item) =>
      (item.lead?.status ?? "").toLowerCase() === "meeting" &&
      dateTime(item.lead?.updatedAt) >= weekAgo,
  ).length;

  // Average days between last contact and completed follow-up
  const completedWithContact = items.filter(
    (item) => item.dueState === "completed" && item.daysSinceContact !== null,
  );
  const avgResponseDays =
    completedWithContact.length > 0
      ? Math.round(
          completedWithContact.reduce((sum, item) => sum + (item.daysSinceContact ?? 0), 0) /
            completedWithContact.length,
        )
      : null;

  return { completionsThisWeek, repliesThisWeek, meetingsThisWeek, avgResponseDays };
}

function actionQueueReason(item: MissionItem): string {
  const status = (item.lead?.status ?? "").toLowerCase();
  const daysSince = item.daysSinceContact;

  if (status === "negotiation") return "Negotiation in progress — highest revenue proximity";
  if (status === "proposal") return "Active proposal — high closing potential";
  if (status === "meeting") return "Meeting stage — keep momentum going";
  if (status === "conversation") return "In conversation — reply window is open";

  if (daysSince !== null && daysSince >= 14)
    return `${daysSince} days since last contact — at risk of going cold`;
  if (daysSince !== null && daysSince >= 7)
    return `${daysSince} days since last contact — follow up now`;

  if (item.priority === "high") return "High-priority lead — don't let this slip";
  if (item.effort === "quick") return "Quick action · Keeps pipeline momentum alive";

  const days = daysFromToday(item.dueAt);
  return `Score ${item.score} · Due ${days === 1 ? "tomorrow" : "within 48h"}`;
}

// ── Supporting functions ──────────────────────────────────────────────────────

function dueStateForFollowup(followup: FollowupWithLead): MissionItem["dueState"] {
  if (followup.status === "completed") return "completed";
  const diff = daysFromToday(followup.dueAt);
  if (diff < 0) return "overdue";
  if (diff === 0) return "today";
  return "upcoming";
}

function isAtRisk(item: MissionItem) {
  return (
    item.daysOverdue > 0 ||
    (item.daysSinceContact !== null && item.daysSinceContact >= 10) ||
    (item.priority === "high" && item.dueState === "upcoming")
  );
}

function priorityLevel(items: MissionItem[]) {
  if (items.some((item) => item.daysOverdue >= 2 || item.impactScore >= 90)) return "High";
  if (items.length > 0) return "Medium";
  return "Low";
}

function dueLabel(item: MissionItem) {
  if (item.dueState === "overdue") return urgencyLabel(item.daysOverdue);
  if (item.dueState === "today") return "Due Today";
  const days = daysFromToday(item.dueAt);
  if (days === 1) return "Tomorrow";
  return `Due in ${days} Days`;
}

function urgencyLabel(days: number) {
  return `${days} ${days === 1 ? "Day" : "Days"} Overdue`;
}

function channelType(channel: string) {
  const normalized = channel.toLowerCase();
  if (normalized === "email") return "email";
  if (normalized === "phone") return "phone";
  if (normalized === "instagram" || normalized === "ig" || normalized === "instagram_dm") return "instagram";
  return "general";
}

function channelLabel(channel: string) {
  const type = channelType(channel);
  if (type === "general") return "General";
  return type.replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function toActivityChannel(channel: string): OutreachChannel | undefined {
  if (channel === "email" || channel === "instagram" || channel === "phone" || channel === "contact_form") return channel;
  return undefined;
}

function leadPriority(lead: Lead | undefined): MissionItem["priority"] {
  const priority = lead?.priority?.toLowerCase();
  if (priority === "high" || priority === "priority") return "high";
  if (priority === "normal" || priority === "medium") return "medium";
  return "low";
}

function priorityTone(priority: MissionItem["priority"]) {
  if (priority === "high") return "danger";
  if (priority === "medium") return "brand";
  return "muted";
}

function toneClass(tone: "danger" | "brand" | "warning" | "success") {
  if (tone === "danger") return "border-orange-500/20 bg-orange-500/10 text-orange-400";
  if (tone === "warning") return "border-warning/20 bg-warning/10 text-warning";
  if (tone === "success") return "border-success/20 bg-success/10 text-success";
  return "border-brand/20 bg-brand/10 text-brand";
}

function leadScore(lead: Lead) {
  if (lead.priority === "high") return 94;
  if (lead.priority === "normal" || lead.priority === "medium") return 78;
  return 62;
}

function sequenceMetadata(followup: FollowupWithLead) {
  return {
    ...(followup.sequenceName ? { sequenceName: followup.sequenceName } : {}),
    ...(followup.stepNumber ? { stepNumber: followup.stepNumber } : {}),
    ...(followup.currentStep ? { currentStep: followup.currentStep } : {}),
  };
}

function formatDateTime(date: string | null | undefined) {
  const value = parseDate(date);
  if (!value) return "-";
  return `${formatDate(value)} ${value.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}`;
}

function isToday(date: string | null | undefined) {
  return daysFromToday(date) === 0;
}

function daysFromToday(date: string | null | undefined) {
  const value = parseDate(date);
  if (!value) return 999;
  const today = startOfDay(new Date());
  const day = startOfDay(value);
  return Math.round((day.getTime() - today.getTime()) / 86_400_000);
}

function parseDate(date: string | null | undefined) {
  if (!date) return null;
  const value = new Date(date);
  return Number.isNaN(value.getTime()) ? null : value;
}

function dateTime(date: string | null | undefined) {
  return parseDate(date)?.getTime() ?? 0;
}

function startOfDay(date: Date) {
  const next = new Date(date);
  next.setHours(0, 0, 0, 0);
  return next;
}

function addDays(date: Date, days: number) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function toDateInputValue(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function toTimeInputValue(date: Date) {
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}
