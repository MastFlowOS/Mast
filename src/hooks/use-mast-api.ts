import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  awardGoalXp,
  bulkDeleteLeads,
  bulkImportLeads,
  bulkUpdateLeads,
  createLead,
  createLeadActivity,
  createFollowup,
  createMessage,
  generateOutreachDraft,
  generateLeads,
  getAccount,
  getAnalyticsSummary,
  getCompletedGoalIds,
  getFollowups,
  getGoalClaims,
  getLead,
  getLeadActivities,
  getLeadFollowups,
  getLeadMessages,
  getLeads,
  getMe,
  getPipelineStats,
  getProgressionEventTotals,
  getRecentActivity,
  getSettings,
  getXp,
  getOpportunityExplanation,
  getOpportunityInsight,
  getExecutiveBriefing,
  getWeeklyIntelligence,
  getPipelineCoaching,
  login,
  logout,
  sendLeadEmail,
  signup,
  startGoogleLogin,
  updateLead,
  updateFollowup,
  updateSettings,
  updateSubscription,
  pauseWorkspace,
  recordProgressionEvent,
  enableWorkspace,
  deleteWorkspace,
  testSmtpConnection,
  type AuthUser,
  type CreateLeadBody,
  type Followup,
  type Lead,
  type LeadActivity,
  type LeadGenerationRequest,
  type OutreachDraftRequest,
  type PlanId,
  type ProgressionEventType,
  type SendEmailRequest,
  type SettingsMap,
  type UpdateLeadBody,
  type OpportunityExplanation,
  type OpportunityInsight,
  type ExecutiveBriefing,
  type WeeklyIntelligence,
  type PipelineCoaching,
} from "@/lib/api";
import { appendActivityToNotes, buildActivitiesFromLead, normalizeActivitiesPayload, type WorkspaceActivityInput } from "@/lib/lead-workspace";

export const queryKeys = {
  me: ["mast", "me"] as const,
  account: ["mast", "account"] as const,
  leads: (params?: Record<string, string | number | undefined>) => ["mast", "leads", params ?? {}] as const,
  analytics: ["mast", "analytics"] as const,
  settings: ["mast", "settings"] as const,
  xp: ["mast", "xp"] as const,
  goalClaims: (date: string) => ["mast", "goalClaims", date] as const,
  completedGoalIds: ["mast", "completedGoalIds"] as const,
  progressionEvents: ["mast", "progressionEvents"] as const,
  lead: (id: number | string | undefined) => ["mast", "lead", String(id)] as const,
  leadActivities: (id: number | string | undefined) => ["mast", "lead", String(id), "activities"] as const,
  leadMessages: (id: number | string | undefined) => ["mast", "lead", String(id), "messages"] as const,
  leadFollowups: (id: number | string | undefined) => ["mast", "lead", String(id), "followups"] as const,
  followups: (params?: Record<string, string | number | undefined>) => ["mast", "followups", params ?? {}] as const,
  pipeline: ["mast", "analytics", "pipeline"] as const,
  activity: ["mast", "analytics", "activity"] as const,
  opportunityExplanation: (leadId: number | string | undefined) => ["mast", "intelligence", "explain", String(leadId)] as const,
  opportunityInsight: (businessId: string | undefined) => ["mast", "intelligence", "opportunity", businessId ?? ""] as const,
  executiveBriefing: ["mast", "intelligence", "briefing"] as const,
  weeklyIntelligence: ["mast", "intelligence", "weekly"] as const,
  pipelineCoaching: ["mast", "intelligence", "coaching"] as const,
};

export function useMe() {
  return useQuery({
    queryKey: queryKeys.me,
    queryFn: getMe,
    retry: false,
    staleTime: 60_000,
  });
}

export function useAccount(enabled = true) {
  return useQuery({
    queryKey: queryKeys.account,
    queryFn: getAccount,
    retry: false,
    enabled,
    staleTime: 30_000,
  });
}

export function useLeads(params?: Record<string, string | number | undefined>, enabled = true) {
  return useQuery({
    queryKey: queryKeys.leads(params),
    queryFn: () => getLeads(params),
    enabled,
  });
}

export function useAnalytics(enabled = true) {
  return useQuery({
    queryKey: queryKeys.analytics,
    queryFn: getAnalyticsSummary,
    enabled,
  });
}

export function usePipelineStats(enabled = true) {
  return useQuery({
    queryKey: queryKeys.pipeline,
    queryFn: getPipelineStats,
    enabled,
  });
}

export function useRecentActivity(enabled = true) {
  return useQuery({
    queryKey: queryKeys.activity,
    queryFn: getRecentActivity,
    enabled,
  });
}

export function useSettings(enabled = true) {
  return useQuery({
    queryKey: queryKeys.settings,
    queryFn: getSettings,
    enabled,
  });
}

/** Persistent, server-side XP total. Never resets — only ever increases via `useAwardGoalXp`. */
export function useXp(enabled = true) {
  return useQuery({
    queryKey: queryKeys.xp,
    queryFn: getXp,
    enabled,
    staleTime: 15_000,
  });
}

/** Goal ids that have already had XP awarded for the given YYYY-MM-DD (local) day. */
export function useGoalClaims(date: string, enabled = true) {
  return useQuery({
    queryKey: queryKeys.goalClaims(date),
    queryFn: () => getGoalClaims(date),
    enabled,
    staleTime: 15_000,
  });
}

export function useCompletedGoalIds(enabled = true) {
  return useQuery({
    queryKey: queryKeys.completedGoalIds,
    queryFn: getCompletedGoalIds,
    enabled,
    staleTime: 15_000,
  });
}

export function useProgressionEventTotals(enabled = true) {
  return useQuery({
    queryKey: queryKeys.progressionEvents,
    queryFn: getProgressionEventTotals,
    enabled,
    staleTime: 15_000,
  });
}

export function useRecordProgressionEvent() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ eventType, quantity = 1, metadata = {} }: { eventType: ProgressionEventType; quantity?: number; metadata?: Record<string, unknown> }) =>
      recordProgressionEvent(eventType, quantity, metadata),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.progressionEvents });
    },
  });
}

/**
 * Award XP for completing a goal on a given day. The server enforces
 * exactly-once-per-goal-per-day; `awarded` in the result tells the caller
 * whether this call is what actually granted the XP (vs. already claimed).
 */
export function useAwardGoalXp() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ goalId, date, xp }: { goalId: string; date: string; xp: number }) =>
      awardGoalXp(goalId, date, xp),
    onSuccess: (result, variables) => {
      queryClient.setQueryData(queryKeys.xp, result.xp);
      queryClient.setQueryData(queryKeys.goalClaims(variables.date), (prev: string[] | undefined) =>
        prev?.includes(variables.goalId) ? prev : [...(prev ?? []), variables.goalId],
      );
      queryClient.setQueryData(queryKeys.completedGoalIds, (prev: string[] | undefined) =>
        prev?.includes(variables.goalId) ? prev : [...(prev ?? []), variables.goalId],
      );
    },
  });
}

export function useLogin() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: login,
    onSuccess: ({ user }) => {
      queryClient.setQueryData(queryKeys.me, { user });
      queryClient.invalidateQueries({ queryKey: queryKeys.account });
    },
  });
}

export function useSignup() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: signup,
    onSuccess: ({ user, needsEmailVerification }) => {
      if (user && !needsEmailVerification) {
        queryClient.setQueryData(queryKeys.me, { user });
        queryClient.invalidateQueries({ queryKey: queryKeys.account });
      }
    },
  });
}

export function useLogout() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: logout,
    onSettled: () => {
      queryClient.clear();
    },
  });
}

export function useGoogleLogin() {
  return useMutation({
    mutationFn: startGoogleLogin,
    onSuccess: ({ url }) => {
      window.location.assign(url);
    },
  });
}

export function useGenerateLeads() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: LeadGenerationRequest) => generateLeads(body),
    onSuccess: (result, body) => {
      queryClient.invalidateQueries({ queryKey: ["mast", "leads"] });
      queryClient.invalidateQueries({ queryKey: queryKeys.account });
      queryClient.invalidateQueries({ queryKey: queryKeys.analytics });
      queryClient.invalidateQueries({ queryKey: queryKeys.progressionEvents });
      void recordProgressionEvent("searches_performed", 1, { source: "lead_generation" });
      if (body.niche) void recordProgressionEvent("industries_searched", 1, { niche: body.niche });
      if (body.region) void recordProgressionEvent("regions_searched", 1, { region: body.region });
      if (result.generated > 0) void recordProgressionEvent("opportunities_discovered", result.generated, { source: "lead_generation" });
    },
  });
}

export function useCreateLead() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateLeadBody) => createLead(body),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["mast", "leads"] });
      queryClient.invalidateQueries({ queryKey: queryKeys.analytics });
      queryClient.invalidateQueries({ queryKey: queryKeys.pipeline });
      queryClient.invalidateQueries({ queryKey: queryKeys.progressionEvents });
      void recordProgressionEvent("relationships_created", 1, { source: "manual_create" });
    },
  });
}

export function useBulkUpdateLeads() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: { ids: number[]; updates: UpdateLeadBody }) => bulkUpdateLeads(body),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["mast", "leads"] });
      queryClient.invalidateQueries({ queryKey: queryKeys.analytics });
      queryClient.invalidateQueries({ queryKey: queryKeys.pipeline });
      queryClient.invalidateQueries({ queryKey: queryKeys.activity });
      queryClient.invalidateQueries({ queryKey: queryKeys.progressionEvents });
    },
  });
}

export function useBulkDeleteLeads() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: { ids: number[] }) => bulkDeleteLeads(body),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["mast", "leads"] });
      queryClient.invalidateQueries({ queryKey: queryKeys.analytics });
      queryClient.invalidateQueries({ queryKey: queryKeys.pipeline });
    },
  });
}

export function useBulkImportLeads() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: { leads: CreateLeadBody[] }) => bulkImportLeads(body),
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ["mast", "leads"] });
      queryClient.invalidateQueries({ queryKey: queryKeys.analytics });
      queryClient.invalidateQueries({ queryKey: queryKeys.pipeline });
      queryClient.invalidateQueries({ queryKey: queryKeys.activity });
      queryClient.invalidateQueries({ queryKey: queryKeys.progressionEvents });
      if (result.imported > 0) void recordProgressionEvent("relationships_created", result.imported, { source: "bulk_import" });
    },
  });
}

export function useSaveSettings() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (args: { settings: SettingsMap; fullName?: string }) =>
      updateSettings(args.settings, args.fullName),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.settings });
      queryClient.invalidateQueries({ queryKey: queryKeys.me });
      queryClient.invalidateQueries({ queryKey: queryKeys.account });
    },
  });
}


export function useChangePlan() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (plan: PlanId) => updateSubscription(plan),
    onSuccess: (account) => {
      // Merge onto the existing cached user rather than rebuilding from
      // scratch — `account` doesn't carry every AuthUser field (e.g.
      // onboardingCompleted, emailConfirmed, workspaceStatus), and those
      // should survive a plan change untouched.
      queryClient.setQueryData(queryKeys.me, (prev: { user: AuthUser | null } | undefined) => {
        const prevUser = prev?.user;
        const user: AuthUser = {
          ...(prevUser as AuthUser),
          id: account.user.id,
          fullName: account.user.fullName,
          email: account.user.email,
          plan: account.user.plan,
          subscriptionStatus: account.user.subscriptionStatus,
          creditsLimit: account.credits.limit,
          creditsUsed: account.credits.used,
          creditsRemaining: account.credits.remaining,
          monthlyLeadsUsed: account.monthlyUsage.used,
          dailyLeadsUsed: account.dailyUsage.used,
          nextDailyReset: account.dailyUsage.resetsAt ?? null,
          nextMonthlyReset: account.monthlyUsage.resetsAt ?? null,
          pendingPlanChange: account.subscription.pendingPlanChange ?? null,
        };
        return { user };
      });
      queryClient.setQueryData(queryKeys.account, account);
    },
  });
}

export function useLead(id: number | string | undefined, enabled = true) {
  return useQuery({
    queryKey: queryKeys.lead(id),
    queryFn: () => getLead(id!),
    enabled: enabled && id !== undefined,
  });
}

export function useLeadActivities(lead: Lead | undefined, enabled = true) {
  return useQuery({
    queryKey: queryKeys.leadActivities(lead?.id),
    queryFn: async () => {
      if (!lead) return [];
      try {
        const payload = await getLeadActivities(lead.id);
        return buildActivitiesFromLead(lead, normalizeActivitiesPayload(payload));
      } catch {
        return buildActivitiesFromLead(lead);
      }
    },
    enabled: enabled && lead !== undefined,
  });
}

export function useUpdateLead() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: number; body: UpdateLeadBody }) => updateLead(id, body),
    onSuccess: (updated, variables) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.lead(updated.id) });
      queryClient.invalidateQueries({ queryKey: queryKeys.leadActivities(updated.id) });
      queryClient.invalidateQueries({ queryKey: ["mast", "leads"] });
      queryClient.invalidateQueries({ queryKey: queryKeys.analytics });
      queryClient.invalidateQueries({ queryKey: queryKeys.pipeline });
      queryClient.invalidateQueries({ queryKey: ["mast", "followups"] });
      queryClient.invalidateQueries({ queryKey: queryKeys.progressionEvents });
      recordLeadProgressionEvents(null, variables.body);
    },
  });
}

export function useGenerateOutreachDraft() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ leadId, body }: { leadId: number; body: OutreachDraftRequest }) =>
      generateOutreachDraft(leadId, body),
    onSuccess: (_response, _variables) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.progressionEvents });
      // Not recording ai_actions here: the caller (AIAssistant) always
      // follows a successful generation with a recordActivity({ type:
      // "message_generated" }) call, which is the single source of truth
      // for this metric. Recording it here too double-counted every AI
      // draft. See audit Priority 1.
    },
  });
}

export function useSendLeadEmail() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ leadId, body }: { leadId: number; body: SendEmailRequest }) =>
      sendLeadEmail(leadId, body),
    onSuccess: (response, variables) => {
      if (response.lead) {
        queryClient.setQueryData(queryKeys.lead(response.lead.id), response.lead);
      }
      queryClient.invalidateQueries({ queryKey: queryKeys.lead(variables.leadId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.leadActivities(variables.leadId) });
      queryClient.invalidateQueries({ queryKey: ["mast", "leads"] });
      queryClient.invalidateQueries({ queryKey: queryKeys.analytics });
      queryClient.invalidateQueries({ queryKey: queryKeys.progressionEvents });
      // Not recording businesses_contacted here: EmailForm's handleSend
      // always follows a successful send with a recordActivity({ type:
      // "email_sent" }, { patch: { status: "outreach" } }) call, which is
      // the single source of truth for this metric. Recording it here too
      // meant one "Send Email" click could record businesses_contacted up
      // to three times. See audit Priority 1.
    },
  });
}

export function useRecordLeadActivity() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      lead,
      activity,
      patch = {},
    }: {
      lead: Lead;
      activity: WorkspaceActivityInput;
      patch?: Partial<Lead>;
    }) => {
      const timestamp = activity.timestamp ?? new Date().toISOString();
      const normalizedActivity = { ...activity, timestamp };
      const hasPatch = Object.keys(patch).length > 0;

      try {
        const savedActivity = await createLeadActivity(lead.id, normalizedActivity);
        const updatedLead = hasPatch ? await updateLead(lead.id, patch) : undefined;
        return { activity: savedActivity, lead: updatedLead };
      } catch {
        // Final fallback: embed activity in notes field
        const notesBase = typeof patch.notes === "string" ? patch.notes : lead.notes;
        const updatedLead = await updateLead(lead.id, {
          ...patch,
          notes: appendActivityToNotes(notesBase, normalizedActivity),
        });
        return {
          activity: {
            id: `local-${lead.id}-${timestamp}`,
            leadId: lead.id,
            ...normalizedActivity,
          } satisfies LeadActivity,
          lead: updatedLead,
        };
      }
    },
    onSuccess: (response, variables) => {
      if (response.lead) {
        queryClient.setQueryData(queryKeys.lead(response.lead.id), response.lead);
      }
      queryClient.invalidateQueries({ queryKey: queryKeys.lead(variables.lead.id) });
      queryClient.invalidateQueries({ queryKey: queryKeys.leadActivities(variables.lead.id) });
      queryClient.invalidateQueries({ queryKey: ["mast", "leads"] });
      queryClient.invalidateQueries({ queryKey: queryKeys.analytics });
      queryClient.invalidateQueries({ queryKey: queryKeys.progressionEvents });
      recordLeadProgressionEvents(variables.activity, variables.patch);
    },
  });
}

export function useLeadMessages(id: number | string | undefined, enabled = true) {
  return useQuery({
    queryKey: queryKeys.leadMessages(id),
    queryFn: () => getLeadMessages(id!),
    enabled: enabled && id !== undefined,
  });
}

export function useCreateMessage() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: createMessage,
    onSuccess: (message) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.leadMessages(message.leadId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.lead(message.leadId) });
      queryClient.invalidateQueries({ queryKey: ["mast", "leads"] });
      queryClient.invalidateQueries({ queryKey: queryKeys.analytics });
      queryClient.invalidateQueries({ queryKey: queryKeys.activity });
    },
  });
}

export function useLeadFollowups(id: number | string | undefined, enabled = true) {
  return useQuery({
    queryKey: queryKeys.leadFollowups(id),
    queryFn: () => getLeadFollowups(id!),
    enabled: enabled && id !== undefined,
  });
}

export function useFollowups(params?: Record<string, string | number | undefined>, enabled = true) {
  return useQuery({
    queryKey: queryKeys.followups(params),
    queryFn: () => getFollowups(params),
    enabled,
  });
}

export function useCreateFollowup() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: createFollowup,
    onSuccess: (followup: Followup) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.leadFollowups(followup.leadId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.lead(followup.leadId) });
      queryClient.invalidateQueries({ queryKey: ["mast", "followups"] });
      queryClient.invalidateQueries({ queryKey: ["mast", "leads"] });
      queryClient.invalidateQueries({ queryKey: queryKeys.analytics });
    },
  });
}

export function useUpdateFollowup() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: number | string; body: { status?: string; completedAt?: string; notes?: string; dueAt?: string; sequenceName?: string | null; stepNumber?: number | null; currentStep?: string | null } }) =>
      updateFollowup(id, body),
    onSuccess: (followup, variables) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.leadFollowups(followup.leadId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.lead(followup.leadId) });
      queryClient.invalidateQueries({ queryKey: ["mast", "followups"] });
      queryClient.invalidateQueries({ queryKey: ["mast", "leads"] });
      queryClient.invalidateQueries({ queryKey: queryKeys.analytics });
      queryClient.invalidateQueries({ queryKey: queryKeys.progressionEvents });
      if (variables.body.status === "completed") {
        void recordProgressionEvent("followups_completed", 1, { source: "followup_update", followupId: variables.id });
      }
    },
  });
}

/**
 * Single source of truth for turning a lead activity + a lead patch into
 * progression events. Called from every place that records a lead action
 * (`useRecordLeadActivity`) or applies a direct lead patch (`useUpdateLead`).
 *
 * Both `activity` and `patch` are inspected, but each metric is fired AT
 * MOST ONCE per call via the `metrics` Set below — even if both the
 * activity-type rule and the patch-status rule independently match the same
 * metric for the same call (e.g. sending an email tags the activity as
 * `email_sent` AND patches `status: "outreach"`; without the Set, that one
 * user action would record `businesses_contacted` twice). See audit
 * Priority 1.
 */
function recordLeadProgressionEvents(activity: WorkspaceActivityInput | null, patch: Partial<Lead> | undefined) {
  const metrics = new Set<ProgressionEventType>();

  if (activity) {
    if (activity.type === "message_generated") {
      metrics.add("ai_actions");
    }
    if (activity.type === "note_added") {
      metrics.add("notes_added");
    }
    if (activity.type === "email_sent" || activity.type === "ready_for_outreach") {
      metrics.add("businesses_contacted");
    }
    // "Save to Relationships" tags its status_changed activity with
    // metadata.saved — the one clear, explicit trigger for turning a
    // Discover result into a saved relationship. See audit Priority 3.
    if (activity.type === "status_changed" && activity.metadata?.saved === true) {
      metrics.add("relationships_created");
    }
  }

  if (patch) {
    const status = String(patch.status ?? "");
    if (["email_sent", "instagram_sent", "called", "contacted", "outreach"].includes(status)) {
      metrics.add("businesses_contacted");
    }
    if (["meeting_booked", "meeting"].includes(status)) {
      metrics.add("meetings_booked");
    }
    if (["replied", "interested", "meeting_booked", "meeting", "proposal", "negotiation", "closed", "closed_won"].includes(status)) {
      metrics.add("pipeline_moves");
    }
    if (typeof patch.notes === "string" && patch.notes.trim()) {
      metrics.add("notes_added");
    }
  }

  for (const metric of metrics) {
    void recordProgressionEvent(metric, 1, { source: activity ? "lead_activity" : "lead_patch" });
  }
}

export function usePauseWorkspace() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: pauseWorkspace,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.me });
      queryClient.invalidateQueries({ queryKey: queryKeys.account });
      queryClient.invalidateQueries({ queryKey: queryKeys.settings });
    },
  });
}

export function useEnableWorkspace() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: enableWorkspace,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.me });
      queryClient.invalidateQueries({ queryKey: queryKeys.account });
      queryClient.invalidateQueries({ queryKey: queryKeys.settings });
    },
  });
}

export function useDeleteWorkspace() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: deleteWorkspace,
    onSuccess: () => {
      queryClient.clear();
    },
  });
}

export function useTestSmtpConnection() {
  return useMutation({
    mutationFn: testSmtpConnection,
  });
}

// ─── Opportunity Intelligence (Part 3, Phase 8) ────────────────────────────────
// Reads only — mast-backend owns generation + caching, these hooks just fetch
// and let TanStack Query cache the result client-side on top of that.

/** Deterministic Opportunity Explanation — available on every plan, no gating needed here. */
export function useOpportunityExplanation(leadId: number | string | undefined, enabled = true) {
  return useQuery<OpportunityExplanation>({
    queryKey: queryKeys.opportunityExplanation(leadId),
    queryFn: () => getOpportunityExplanation(leadId!),
    enabled: enabled && leadId !== undefined,
    retry: false,
    staleTime: 60_000,
  });
}

/** AI Opportunity Insight (Premium) — callers should gate visibility with <FeatureGate feature="opportunityInsights">. */
export function useOpportunityInsight(businessId: string | null | undefined, enabled = true) {
  return useQuery<OpportunityInsight>({
    queryKey: queryKeys.opportunityInsight(businessId ?? undefined),
    queryFn: () => getOpportunityInsight(businessId!),
    enabled: enabled && Boolean(businessId),
    retry: false,
    staleTime: 5 * 60_000,
  });
}

/** AI Executive Briefing (Premium) — callers should gate visibility with <FeatureGate feature="executiveBriefings">. */
export function useExecutiveBriefing(enabled = true) {
  return useQuery<ExecutiveBriefing>({
    queryKey: queryKeys.executiveBriefing,
    queryFn: getExecutiveBriefing,
    enabled,
    retry: false,
    staleTime: 5 * 60_000,
  });
}

/** Weekly Intelligence (Premium) — callers should gate visibility with <FeatureGate feature="weeklyIntelligence">. */
export function useWeeklyIntelligence(enabled = true) {
  return useQuery<WeeklyIntelligence>({
    queryKey: queryKeys.weeklyIntelligence,
    queryFn: getWeeklyIntelligence,
    enabled,
    retry: false,
    staleTime: 5 * 60_000,
  });
}

/** AI Pipeline Coaching (Pro+) — callers should gate visibility with <FeatureGate feature="pipelineCoaching">. */
export function usePipelineCoaching(enabled = true) {
  return useQuery<PipelineCoaching>({
    queryKey: queryKeys.pipelineCoaching,
    queryFn: getPipelineCoaching,
    enabled,
    retry: false,
    staleTime: 5 * 60_000,
  });
}
