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
  Trophy,
  Zap,
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
};

const SECTION_LIMIT = 6;

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
            <MissionHero mission={mission} />

            <div className="grid gap-4 xl:grid-cols-[1.35fr_0.65fr]">
              <CoachCard item={mission.coachPick} />
              <StreakCard streak={mission.streak} completedToday={mission.completedToday.length} />
            </div>

            <MissionSection
              title="Must Do Today"
              desc="The highest value actions to clear before anything else."
              icon={Flame}
              tone="danger"
              items={mission.mustDo}
              total={mission.totalMustDo}
              busy={busy}
              onOpen={openLead}
              onComplete={(item) => void completeOne(item)}
              onReschedule={openReschedule}
            />

            <MissionSection
              title="Quick Wins"
              desc="Low-friction follow-ups that keep momentum moving."
              icon={Zap}
              tone="brand"
              items={mission.quickWins}
              total={mission.totalQuickWins}
              busy={busy}
              onOpen={openLead}
              onComplete={(item) => void completeOne(item)}
              onReschedule={openReschedule}
            />

            <MissionSection
              title="Leads At Risk"
              desc="Stale or drifting opportunities that need a touch."
              icon={AlertTriangle}
              tone="warning"
              items={mission.atRisk}
              total={mission.totalAtRisk}
              busy={busy}
              onOpen={openLead}
              onComplete={(item) => void completeOne(item)}
              onReschedule={openReschedule}
            />

            <PlanningSections tomorrow={mission.tomorrow} next7Days={mission.next7Days} onOpen={openLead} />

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

function MissionHero({ mission }: { mission: Mission }) {
  const total = Math.max(1, mission.todayTarget + mission.completedToday.length);
  const progress = Math.min(100, Math.round((mission.completedToday.length / total) * 100));

  return (
    <section className="rounded-2xl border border-border bg-card p-5">
      <div className="flex flex-wrap items-start justify-between gap-5">
        <div>
          <p className="text-xs font-bold uppercase tracking-widest text-brand">Mission Control</p>
          <h2 className="mt-1 text-xl font-bold tracking-tight">
            You have {mission.todayTarget.toLocaleString()} action{mission.todayTarget === 1 ? "" : "s"} due now.
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Estimated completion time: {mission.estimatedMinutes} minutes · Priority level: {mission.priorityLevel}
          </p>
        </div>
        <div className="min-w-56">
          <div className="flex items-center justify-between text-xs">
            <span className="font-semibold text-foreground">Today's Mission</span>
            <span className="text-muted-foreground">{mission.completedToday.length} / {total} completed</span>
          </div>
          <div className="mt-2 h-2 overflow-hidden rounded-full bg-border">
            <div className="h-full rounded-full bg-brand transition-all" style={{ width: `${progress}%` }} />
          </div>
        </div>
      </div>

      <div className="mt-5 grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
        <MissionMetric label="Due Today" value={mission.dueToday} tone="brand" />
        <MissionMetric label="Overdue" value={mission.overdue} tone="danger" />
        <MissionMetric label="At Risk" value={mission.atRiskPool.length} tone="warning" />
        <MissionMetric label="Completed Today" value={mission.completedToday.length} tone="success" />
      </div>

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

function CoachCard({ item }: { item: MissionItem | null }) {
  return (
    <section className="rounded-xl border border-border bg-card p-4">
      <div className="flex items-center gap-2">
        <div className="grid size-8 place-items-center rounded-lg border border-brand/20 bg-brand/10">
          <Sparkles className="size-4 text-brand" />
        </div>
        <div>
          <h2 className="text-sm font-bold">AI Coach</h2>
          <p className="text-xs text-muted-foreground">Highest value action today</p>
        </div>
      </div>

      {item ? (
        <div className="mt-4 rounded-lg border border-border bg-background p-3">
          <div className="flex flex-wrap items-center gap-2">
            <p className="font-semibold">{item.leadName}</p>
            <span className="rounded border border-brand/20 bg-brand/10 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-brand">
              Score {item.score}
            </span>
          </div>
          <p className="mt-3 text-xs font-bold uppercase tracking-widest text-muted-foreground">Why this lead?</p>
          <ul className="mt-2 space-y-1.5 text-sm text-muted-foreground">
            {coachReasons(item).map((reason) => (
              <li key={reason} className="flex gap-2">
                <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-brand" />
                <span>{reason}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <p className="mt-4 text-sm text-muted-foreground">No urgent recommendation. Keep the mission clear.</p>
      )}
    </section>
  );
}

function StreakCard({ streak, completedToday }: { streak: number; completedToday: number }) {
  const hasStreak = streak > 0;

  return (
    <section className="rounded-xl border border-border bg-card p-4">
      <div className="flex items-center gap-2">
        <div className="grid size-8 place-items-center rounded-lg border border-success/20 bg-success/10">
          <Trophy className="size-4 text-success" />
        </div>
        <div>
          <h2 className="text-sm font-bold">Follow-Up Streak</h2>
          <p className="text-xs text-muted-foreground">Keep your streak alive.</p>
        </div>
      </div>
      <div className="mt-4 flex items-end gap-2">
        <span className="text-3xl font-bold tabular-nums">{hasStreak ? streak : "Start"}</span>
        {hasStreak && <span className="pb-1 text-sm font-semibold text-muted-foreground">Days</span>}
      </div>
      <p className="mt-2 text-xs text-muted-foreground">
        {hasStreak
          ? completedToday > 0
            ? `${completedToday} completed today. Momentum is active.`
            : "Complete one follow-up today to protect the streak."
          : "Complete 1 follow-up to begin."}
      </p>
    </section>
  );
}

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

function PlanningSections({
  tomorrow,
  next7Days,
  onOpen,
}: {
  tomorrow: MissionItem[];
  next7Days: MissionItem[];
  onOpen: (leadId: number) => void;
}) {
  if (tomorrow.length === 0 && next7Days.length === 0) return null;

  return (
    <section className="space-y-2">
      <div className="flex items-center gap-3">
        <div className="grid size-9 place-items-center rounded-lg border border-border bg-card text-muted-foreground">
          <CalendarClock className="size-4" />
        </div>
        <div>
          <h2 className="text-sm font-bold">Upcoming Planning</h2>
          <p className="text-xs text-muted-foreground">Light preview only. Today's mission stays the focus.</p>
        </div>
      </div>

      <div className="grid gap-2 xl:grid-cols-2">
        <PlanningBucket title="Tomorrow" items={tomorrow} onOpen={onOpen} />
        <PlanningBucket title="Next 7 Days" items={next7Days} onOpen={onOpen} />
      </div>
    </section>
  );
}

function PlanningBucket({ title, items, onOpen }: { title: string; items: MissionItem[]; onOpen: (leadId: number) => void }) {
  if (items.length === 0) return null;

  return (
    <details className="rounded-xl border border-border bg-card">
      <summary className="cursor-pointer px-4 py-3 text-sm font-semibold hover:bg-background">
        {title} <span className="text-muted-foreground">({items.length})</span>
      </summary>
      <div className="border-t border-border p-2">
        {items.slice(0, 4).map((item) => (
          <button
            key={item.id}
            onClick={() => onOpen(item.leadId)}
            className="flex w-full items-center justify-between gap-3 rounded-lg px-2 py-2 text-left hover:bg-background"
          >
            <span className="min-w-0">
              <span className="block truncate text-sm font-semibold">{item.leadName}</span>
              <span className="text-xs text-muted-foreground">{dueLabel(item)} · Score {item.score}</span>
            </span>
            <ArrowRight className="size-3.5 shrink-0 text-muted-foreground" />
          </button>
        ))}
      </div>
    </details>
  );
}

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

function LoadingMission() {
  return (
    <div className="space-y-5 p-6">
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
          <Link to="/dashboard/crm" className="rounded-lg border border-border px-4 py-2 text-sm font-semibold hover:bg-background">
            Open Relationships
          </Link>
        </div>
      </div>
    </div>
  );
}

type Mission = ReturnType<typeof buildMission>;

function buildMission(followups: FollowupWithLead[]) {
  const items = followups.map(toMissionItem);
  const active = items.filter((item) => item.dueState !== "completed");
  const completedToday = items
    .filter((item) => item.dueState === "completed" && isToday(item.completedAt ?? item.updatedAt))
    .sort((a, b) => dateTime(b.completedAt ?? b.updatedAt) - dateTime(a.completedAt ?? a.updatedAt));

  const overdue = active.filter((item) => item.dueState === "overdue").length;
  const dueToday = active.filter((item) => item.dueState === "today").length;
  const atRiskPool = active
    .filter((item) => isAtRisk(item))
    .sort((a, b) => b.impact - a.impact);
  const mustDoPool = active
    .filter((item) => item.dueState === "overdue" || item.dueState === "today" || item.score >= 90 || item.priority === "high")
    .sort(compareMustDo);
  const mustDoIds = new Set(mustDoPool.map((item) => String(item.id)));
  const quickWinsPool = active
    .filter((item) => !mustDoIds.has(String(item.id)) && item.effort === "quick")
    .sort((a, b) => dateTime(a.dueAt) - dateTime(b.dueAt) || b.score - a.score);
  const quickWinIds = new Set(quickWinsPool.map((item) => String(item.id)));
  const visibleAtRisk = atRiskPool.filter((item) => !mustDoIds.has(String(item.id)) && !quickWinIds.has(String(item.id)));
  const tomorrow = active
    .filter((item) => daysFromToday(item.dueAt) === 1)
    .sort((a, b) => b.score - a.score || dateTime(a.dueAt) - dateTime(b.dueAt));
  const next7Days = active
    .filter((item) => {
      const days = daysFromToday(item.dueAt);
      return days > 1 && days <= 7;
    })
    .sort((a, b) => dateTime(a.dueAt) - dateTime(b.dueAt) || b.score - a.score);
  const todayTarget = mustDoPool.length + quickWinsPool.length + visibleAtRisk.length;
  const estimatedMinutes = Math.max(0, Math.ceil((mustDoPool.length * 2.5) + (quickWinsPool.length * 1.25) + (visibleAtRisk.length * 2)));

  return {
    active,
    dueToday,
    overdue,
    atRiskPool,
    completedToday,
    mustDo: mustDoPool.slice(0, SECTION_LIMIT),
    totalMustDo: mustDoPool.length,
    quickWins: quickWinsPool.slice(0, SECTION_LIMIT),
    totalQuickWins: quickWinsPool.length,
    atRisk: visibleAtRisk.slice(0, SECTION_LIMIT),
    totalAtRisk: visibleAtRisk.length,
    tomorrow,
    next7Days,
    todayTarget,
    estimatedMinutes,
    impactOutcomes: impactOutcomes(mustDoPool, quickWinsPool, visibleAtRisk, overdue),
    priorityLevel: priorityLevel(mustDoPool),
    streak: followupStreak(items),
    coachPick: mustDoPool[0] ?? quickWinsPool[0] ?? visibleAtRisk[0] ?? null,
  };
}

function toMissionItem(followup: FollowupWithLead): MissionItem {
  const lead = followup.lead;
  const dueState = dueStateForFollowup(followup);
  const daysOverdue = dueState === "overdue" ? Math.abs(daysFromToday(followup.dueAt)) : 0;
  const daysSinceContact = lead?.lastContactedAt ? Math.max(0, Math.floor((Date.now() - dateTime(lead.lastContactedAt)) / 86_400_000)) : null;
  const score = lead ? leadScore(lead) : 62;
  const priority = leadPriority(lead);
  const nicheLabel = lead?.niche ? NICHES.find((item) => item.value === lead.niche)?.label ?? lead.niche : lead?.location ?? "General prospect";
  const effort = channelType(followup.channel) === "email" || channelType(followup.channel) === "phone" ? "quick" : "standard";

  return {
    ...followup,
    leadName: lead?.businessName ?? "Unknown lead",
    nicheLabel,
    score,
    priority,
    dueState,
    daysOverdue,
    daysSinceContact,
    effort,
    impact: score + (priority === "high" ? 18 : priority === "medium" ? 8 : 0) + (daysOverdue * 6) + (daysSinceContact && daysSinceContact >= 10 ? 14 : 0),
  };
}

function dueStateForFollowup(followup: FollowupWithLead): MissionItem["dueState"] {
  if (followup.status === "completed") return "completed";
  const diff = daysFromToday(followup.dueAt);
  if (diff < 0) return "overdue";
  if (diff === 0) return "today";
  return "upcoming";
}

function isAtRisk(item: MissionItem) {
  return item.daysOverdue > 0 || (item.daysSinceContact !== null && item.daysSinceContact >= 10) || (item.priority === "high" && item.dueState === "upcoming");
}

function compareMustDo(a: MissionItem, b: MissionItem) {
  const overdueRank = Number(b.dueState === "overdue") - Number(a.dueState === "overdue");
  if (overdueRank !== 0) return overdueRank;
  if (b.score !== a.score) return b.score - a.score;
  return priorityRank(a.priority) - priorityRank(b.priority) || dateTime(a.dueAt) - dateTime(b.dueAt);
}

function priorityRank(priority: MissionItem["priority"]) {
  return priority === "high" ? 0 : priority === "medium" ? 1 : 2;
}

function impactOutcomes(mustDo: MissionItem[], quickWins: MissionItem[], atRisk: MissionItem[], overdue: number) {
  const stalePrevention = [...mustDo, ...atRisk].filter((item) => isAtRisk(item)).length;
  const contactedMoves = [...mustDo, ...quickWins].filter((item) => item.lead?.status === "new" || !item.lead?.lastContactedAt).length;
  const overdueReduction = overdue > 0 ? Math.round((mustDo.filter((item) => item.dueState === "overdue").length / overdue) * 100) : 0;
  const staleCount = Math.max(1, stalePrevention);
  const contactedCount = Math.max(1, contactedMoves);

  return [
    `Prevent ${staleCount} lead${staleCount === 1 ? "" : "s"} from becoming stale`,
    `Move ${contactedCount} lead${contactedCount === 1 ? "" : "s"} into active follow-up`,
    overdue > 0 ? `Reduce overdue queue by ${overdueReduction}%` : "Keep the overdue queue at zero",
  ];
}

function priorityLevel(items: MissionItem[]) {
  if (items.some((item) => item.daysOverdue >= 2 || item.score >= 90)) return "High";
  if (items.length > 0) return "Medium";
  return "Low";
}

function coachReasons(item: MissionItem) {
  const reasons = [
    `Lead score ${item.score}`,
    item.dueState === "today" ? "Due today" : item.daysOverdue > 0 ? urgencyLabel(item.daysOverdue) : dueLabel(item),
  ];

  if (!item.lead?.lastContactedAt) {
    reasons.push("No previous follow-up recorded");
  } else if (item.daysSinceContact !== null && item.daysSinceContact >= 7) {
    reasons.push(`No contact in ${item.daysSinceContact} days`);
  }

  if (item.priority === "high" || item.score >= 90) {
    reasons.push("High conversion potential");
  } else if (item.effort === "quick") {
    reasons.push("Low effort action with near-term pipeline value");
  } else {
    reasons.push("Best next action based on urgency and priority");
  }

  return reasons;
}

function followupStreak(items: MissionItem[]) {
  const completedDays = new Set(
    items
      .filter((item) => item.dueState === "completed")
      .map((item) => toDateInputValue(parseDate(item.completedAt ?? item.updatedAt) ?? new Date())),
  );
  let streak = 0;
  let cursor = startOfDay(new Date());
  if (!completedDays.has(toDateInputValue(cursor))) cursor = addDays(cursor, -1);

  while (completedDays.has(toDateInputValue(cursor))) {
    streak += 1;
    cursor = addDays(cursor, -1);
  }

  return streak;
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
