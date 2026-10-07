import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ApiError,
  isFutureIatApiError,
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
  getFollowups,
  getMissionWeekStats,
  getLead,
  getLeadActivities,
  getLeadFollowups,
  getLeadMessages,
  getLeads,
  getMe,
  getPipelineStats,
  getRecentActivity,
  getSettings,
  getXp,
  getOpportunityExplanation,
  getLeadTrust,
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
  enableWorkspace,
  deleteWorkspace,
  testSmtpConnection,
  getOpsStats,
  getOpsHistory,
  type AuthUser,
  type CreateLeadBody,
  type Followup,
  type Lead,
  type LeadActivity,
  type LeadGenerationRequest,
  type OutreachDraftRequest,
  type PlanId,
  type SendEmailRequest,
  type SettingsMap,
  type UpdateLeadBody,
  type OpportunityExplanation,
  type LeadTrust,
  type OpportunityInsight,
  type ExecutiveBriefing,
  type WeeklyIntelligence,
  type PipelineCoaching,
  type OpsStats,
  type OpsHistoryEntry,
} from "@/lib/api";
import { appendActivityToNotes, buildActivitiesFromLead, normalizeActivitiesPayload, type WorkspaceActivityInput } from "@/lib/lead-workspace";

export const queryKeys = {
  me: ["mast", "me"] as const,
  account: ["mast", "account"] as const,
  leads: (params?: Record<string, string | number | undefined>) => ["mast", "leads", params ?? {}] as const,
  analytics: ["mast", "analytics"] as const,
  settings: ["mast", "settings"] as const,
  xp: ["mast", "xp"] as const,
  lead: (id: number | string | undefined) => ["mast", "lead", String(id)] as const,
  leadActivities: (id: number | string | undefined) => ["mast", "lead", String(id), "activities"] as const,
  leadMessages: (id: number | string | undefined) => ["mast", "lead", String(id), "messages"] as const,
  leadFollowups: (id: number | string | undefined) => ["mast", "lead", String(id), "followups"] as const,
  followups: (params?: Record<string, string | number | undefined>) => ["mast", "followups", params ?? {}] as const,
  missionWeek: ["mast", "mission-week"] as const,
  pipeline: ["mast", "analytics", "pipeline"] as const,
  activity: ["mast", "analytics", "activity"] as const,
  opportunityExplanation: (leadId: number | string | undefined) => ["mast", "intelligence", "explain", String(leadId)] as const,
  leadTrust: (leadId: number | string | undefined) => ["mast", "intelligence", "trust", String(leadId)] as const,
  opportunityInsight: (businessId: string | undefined) => ["mast", "intelligence", "opportunity", businessId ?? ""] as const,
  executiveBriefing: ["mast", "intelligence", "briefing"] as const,
  weeklyIntelligence: ["mast", "intelligence", "weekly"] as const,
  pipelineCoaching: ["mast", "intelligence", "coaching"] as const,
  // Phase 7 — Observability
  opsStats: (rangeHours: number) => ["mast", "ops", "stats", rangeHours] as const,
  opsHistory: (rangeHours: number) => ["mast", "ops", "history", rangeHours] as const,
};

const DEV_MOCK_USER: AuthUser = {
  id: 'dev-user-id',
  fullName: 'MAST Workspace',
  email: 'dev@mast.internal',
  plan: 'pro',
  subscriptionStatus: 'active',
  creditsLimit: 1000,
  creditsUsed: 120,
  creditsRemaining: 880,
  monthlyLeadsUsed: 48,
  dailyLeadsUsed: 12,
  nextDailyReset: null,
  nextMonthlyReset: null,
  pendingPlanChange: null,
  onboardingCompleted: true,
};

export function useMe(enabled = true) {
  return useQuery({
    queryKey: queryKeys.me,
    queryFn: async () => {
      const res = await getMe();
      if (!res.user && import.meta.env.DEV) return { user: DEV_MOCK_USER };
      return res;
    },
    retry: false,
    staleTime: 60_000,
    enabled,
  });
}

export function useAccount(enabled = true) {
  return useQuery({
    queryKey: queryKeys.account,
    queryFn: async () => {
      try {
        return await getAccount();
      } catch (err) {
        if (import.meta.env.DEV) {
          return {
            user: DEV_MOCK_USER,
            subscription: { plan: 'pro' as const, name: 'PRO', status: 'active', priceMonthly: 79 },
            credits: { limit: 1000, used: 120, remaining: 880 },
            dailyUsage: { used: 12, limit: 400, remaining: 388, resetsAt: null },
            monthlyUsage: { used: 48, limit: 6000, remaining: 5952, resetsAt: null },
            limits: { maxLeadRequest: 100, allowedChannels: ['email', 'phone', 'instagram', 'website'], allowInstantPool: true, allowPremiumPool: true, allowApiAccess: true },
            plans: [],
          };
        }
        throw err;
      }
    },
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

/** Persistent, server-side XP total. Never resets — only ever increases via `useClaimDailyGoal`. */
export function useXp(enabled = true) {
  return useQuery({
    queryKey: queryKeys.xp,
    queryFn: getXp,
    enabled,
    staleTime: 15_000,
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
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["mast", "leads"] });
      queryClient.invalidateQueries({ queryKey: queryKeys.account });
      queryClient.invalidateQueries({ queryKey: queryKeys.analytics });
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
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["mast", "leads"] });
      queryClient.invalidateQueries({ queryKey: queryKeys.analytics });
      queryClient.invalidateQueries({ queryKey: queryKeys.pipeline });
      queryClient.invalidateQueries({ queryKey: queryKeys.activity });
    },
  });
}

export function useSaveSettings() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (args: { settings: SettingsMap; fullName?: string }) =>
      updateSettings(args.settings, args.fullName),
    onSuccess: (_data, variables) => {
      queryClient.setQueryData(queryKeys.me, (old: any) => {
        if (!old?.user) return old;
        return {
          ...old,
          user: {
            ...old.user,
            ...(variables.fullName !== undefined ? { fullName: variables.fullName } : {}),
            ...(variables.settings?.avatarUrl !== undefined ? { avatarUrl: variables.settings.avatarUrl } : {}),
          },
        };
      });
      queryClient.invalidateQueries({ queryKey: queryKeys.settings });
      queryClient.invalidateQueries({ queryKey: queryKeys.me });
      queryClient.invalidateQueries({ queryKey: queryKeys.account });
    },
    onError: (err) => {
      // A rejected/expired session (see isAuthRejection in lib/api.ts) has
      // already been cleared locally at this point. Re-fetching `me` picks
      // up the now-null session so the page's existing
      // `if (!user) navigate("/login")` guard fires — instead of leaving
      // the user stuck on a page that will only ever fail the same way.
      //
      // Exception: the confirmed-persistent PGRST303 condition (Supabase's
      // Auth-issuer/PostgREST-validator clock disagreement) is explicitly
      // NOT cleared locally — the session is intentionally left intact —
      // so re-fetching `me` here would just re-trigger the same rejection
      // for no benefit. Skip the invalidation for that one case only.
      if (err instanceof ApiError && err.status === 401 && !isFutureIatApiError(err)) {
        queryClient.invalidateQueries({ queryKey: queryKeys.me });
      }
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
    onSuccess: (updated) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.lead(updated.id) });
      queryClient.invalidateQueries({ queryKey: queryKeys.leadActivities(updated.id) });
      queryClient.invalidateQueries({ queryKey: ["mast", "leads"] });
      queryClient.invalidateQueries({ queryKey: queryKeys.analytics });
      queryClient.invalidateQueries({ queryKey: queryKeys.pipeline });
      queryClient.invalidateQueries({ queryKey: ["mast", "followups"] });
    },
  });
}

export function useGenerateOutreachDraft() {
  return useMutation({
    mutationFn: ({ leadId, body }: { leadId: number; body: OutreachDraftRequest }) =>
      generateOutreachDraft(leadId, body),
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
    queryFn: async () => {
      try {
        return await getFollowups(params);
      } catch (err) {
        if (import.meta.env.DEV) return [];
        throw err;
      }
    },
    retry: false,
    enabled,
  });
}

export function useMissionWeekStats(enabled = true) {
  return useQuery({
    queryKey: queryKeys.missionWeek,
    queryFn: getMissionWeekStats,
    retry: false,
    staleTime: 60_000,
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
    onSuccess: (followup) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.leadFollowups(followup.leadId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.lead(followup.leadId) });
      queryClient.invalidateQueries({ queryKey: ["mast", "followups"] });
      queryClient.invalidateQueries({ queryKey: ["mast", "leads"] });
      queryClient.invalidateQueries({ queryKey: queryKeys.analytics });
      queryClient.invalidateQueries({ queryKey: queryKeys.missionWeek });
    },
  });
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

/** Deterministic Trust/Business Health readout (Priority 2/3/7) — field provenance/confidence + health score, no gating needed here. */
export function useLeadTrust(leadId: number | string | undefined, enabled = true) {
  return useQuery<LeadTrust>({
    queryKey: queryKeys.leadTrust(leadId),
    queryFn: () => getLeadTrust(leadId!),
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

// ─── Phase 7 — Observability / Ops Dashboard ────────────────────────────────

/**
 * Live ops stats with auto-refresh every 15 seconds.
 * Only succeeds if the authenticated user has internal_role = 'engineer' or 'admin'.
 */
export function useOpsStats(rangeHours = 24, enabled = true) {
  return useQuery<OpsStats>({
    queryKey: queryKeys.opsStats(rangeHours),
    queryFn: () => getOpsStats(rangeHours),
    enabled,
    retry: false,
    refetchInterval: 15_000,
    staleTime: 10_000,
  });
}

/**
 * Historical job metrics for graphing.
 * Only succeeds if the authenticated user has internal_role = 'engineer' or 'admin'.
 */
export function useOpsHistory(rangeHours = 24, enabled = true) {
  return useQuery<OpsHistoryEntry[]>({
    queryKey: queryKeys.opsHistory(rangeHours),
    queryFn: () => getOpsHistory(rangeHours, 200),
    enabled,
    retry: false,
    staleTime: 30_000,
  });
}
