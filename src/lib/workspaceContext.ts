import { supabaseAdmin } from "./supabaseAdmin.js";
import type { WorkspaceRole } from "./teamSeats.js";

export interface WorkspaceContext {
  actorUserId: string;
  workspaceOwnerId: string;
  role: WorkspaceRole;
  isTeamMember: boolean;
}

/**
 * Resolves the effective workspace owner for an authenticated user.
 * If the user is an active member of a team workspace, `workspaceOwnerId`
 * points to that workspace's owner so CRM leads, discovery credits, and plan
 * capabilities are shared cleanly across the team.
 *
 * Gracefully falls back to solo-owner mode if migration 055 has not been
 * applied yet in a given environment.
 */
export async function resolveWorkspaceContext(
  userId: string,
  db: any = supabaseAdmin,
): Promise<WorkspaceContext> {
  try {
    const { data, error } = await db
      .from("workspace_members")
      .select("owner_id, role")
      .eq("member_id", userId)
      .eq("status", "active")
      .maybeSingle();

    if (!error && data?.owner_id && data.owner_id !== userId) {
      const role: WorkspaceRole = data.role === "admin" ? "admin" : "member";
      return {
        actorUserId: userId,
        workspaceOwnerId: String(data.owner_id),
        role,
        isTeamMember: true,
      };
    }
  } catch {
    // Table may not exist in minimal unit-test mocks; fail safe to solo owner.
  }

  return {
    actorUserId: userId,
    workspaceOwnerId: userId,
    role: "owner",
    isTeamMember: false,
  };
}
