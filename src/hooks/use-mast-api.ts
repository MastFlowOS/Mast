import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
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
  getLead,
  getLeadActivities,
  getLeadFollowups,
  getLeadMessages,
  getLeads,
  getMe,
  getPipelineStats,
  getRecentActivity,
  getSettings,
  login,
  logout,
  sendLeadEmail,
  signup,
  startGoogleLogin,
  updateLead,
  updateFollowup,
  updateSettings,
  updateSubscription,
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
} from "@/lib/api";
import { appendActivityToNotes, buildActivitiesFromLead, normalizeActivitiesPayload, type WorkspaceActivityInput } from "@/lib/lead-workspace";

export const queryKeys = {
  me: ["mast", "me"] as const,
  account: ["mast", "account"] as const,
  leads: (params?: Record<string, string | number | undefined>) => ["mast", "leads", params ?? {}] as const,
  analytics: ["mast", "analytics"] as const,
  settings: ["mast", "settings"] as const,
  lead: (id: number | string | undefined) => ["mast", "lead", String(id)] as const,
  leadActivities: (id: number | string | undefined) => ["mast", "lead", String(id), "activities"] as const,
  leadMessages: (id: number | string | undefined) => ["mast", "lead", String(id), "messages"] as const,
  leadFollowups: (id: number | string | undefined) => ["mast", "lead", String(id), "followups"] as const,
  followups: (params?: Record<string, string | number | undefined>) => ["mast", "followups", params ?? {}] as const,
  pipeline: ["mast", "analytics", "pipeline"] as const,
  activity: ["mast", "analytics", "activity"] as const,
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
    mutationFn: (body: SettingsMap) => updateSettings(body),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.settings });
    },
  });
}

export function useChangePlan() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (plan: PlanId) => updateSubscription(plan),
    onSuccess: (account) => {
      const user: AuthUser = {
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
      queryClient.setQueryData(queryKeys.me, { user });
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
    onSuccess: (followup) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.leadFollowups(followup.leadId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.lead(followup.leadId) });
      queryClient.invalidateQueries({ queryKey: ["mast", "followups"] });
      queryClient.invalidateQueries({ queryKey: ["mast", "leads"] });
      queryClient.invalidateQueries({ queryKey: queryKeys.analytics });
    },
  });
}
