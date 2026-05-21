import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  createLead,
  generateLeads,
  getAccount,
  getAnalyticsSummary,
  getLeads,
  getMe,
  getSettings,
  login,
  logout,
  signup,
  startGoogleLogin,
  updateSettings,
  updateSubscription,
  type AuthUser,
  type LeadGenerationRequest,
  type PlanId,
  type SettingsMap,
} from "@/lib/api";

export const queryKeys = {
  me: ["mast", "me"] as const,
  account: ["mast", "account"] as const,
  leads: (params?: Record<string, string | number | undefined>) => ["mast", "leads", params ?? {}] as const,
  analytics: ["mast", "analytics"] as const,
  settings: ["mast", "settings"] as const,
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
    onSuccess: ({ user }) => {
      queryClient.setQueryData(queryKeys.me, { user });
      queryClient.invalidateQueries({ queryKey: queryKeys.account });
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
    mutationFn: createLead,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["mast", "leads"] });
      queryClient.invalidateQueries({ queryKey: queryKeys.analytics });
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
      };
      queryClient.setQueryData(queryKeys.me, { user });
      queryClient.setQueryData(queryKeys.account, account);
    },
  });
}
