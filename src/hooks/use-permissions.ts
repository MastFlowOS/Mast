import { useAccount } from "./use-mast-api";
import { buildPermissionsManager, type PermissionsManager } from "@/lib/permissions";
import type { PlanId } from "@/lib/plans";

/**
 * usePermissions
 * 
 * Reactive hook to check user capabilities and retrieve limit/upgrade metadata.
 * Uses TanStack Query cache via useAccount() for performant, synchronized state.
 */
export function usePermissions(): {
  permissions: PermissionsManager;
  isLoading: boolean;
} {
  const { data: account, isLoading } = useAccount();
  const rawPlan = (account?.subscription?.plan || "free") as PlanId;
  const permissions = buildPermissionsManager(rawPlan);

  return {
    permissions,
    isLoading,
  };
}
