import crypto from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../../middleware/auth.js";
import { createRateLimiter } from "../../middleware/rateLimit.js";
import { supabaseAdmin } from "../../lib/supabaseAdmin.js";
import { resolveWorkspaceContext } from "../../lib/workspaceContext.js";
import {
  canAcceptSeatInvite,
  computeSeatUsage,
  isValidInviteEmail,
  normalizeInviteEmail,
} from "../../lib/teamSeats.js";

export const teamRouter = Router();

const readLimiter = createRateLimiter({ windowMs: 60_000, max: 120 });
const writeLimiter = createRateLimiter({ windowMs: 60_000, max: 30 });

export const teamDeps = {
  db: supabaseAdmin as any,
  resolveWorkspaceContext,
};

const CreateInviteSchema = z.object({
  email: z.string().trim().min(3).max(320),
  role: z.enum(["admin", "member"]).default("member"),
});

const AcceptInviteSchema = z.object({
  token: z.string().trim().min(10).max(256),
});

const UpdateMemberRoleSchema = z.object({
  role: z.enum(["admin", "member"]),
});

async function resolveAuthEmailsByIds(userIds: string[], db: any): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const adminApi = db?.auth?.admin;
  if (!adminApi || typeof adminApi.getUserById !== "function" || userIds.length === 0) {
    return map;
  }
  const uniqueIds = Array.from(new Set(userIds.filter(Boolean)));
  await Promise.all(
    uniqueIds.map(async (uid) => {
      try {
        const res = await adminApi.getUserById(uid);
        const email = res?.data?.user?.email;
        if (typeof email === "string" && email.trim()) {
          map.set(String(uid), email.trim());
        }
      } catch {
        // Non-fatal: email lookup is best-effort display metadata
      }
    }),
  );
  return map;
}

async function loadWorkspaceSnapshot(ownerId: string, db: any) {
  const [{ data: ownerProfile, error: ownerErr }, { data: memberRows, error: memErr }, { data: inviteRows, error: invErr }] =
    await Promise.all([
      db
        .from("profiles")
        .select("id, full_name, subscription_plan")
        .eq("id", ownerId)
        .single(),
      db
        .from("workspace_members")
        .select("id, owner_id, member_id, role, status, created_at")
        .eq("owner_id", ownerId)
        .eq("status", "active")
        .order("created_at", { ascending: true }),
      db
        .from("workspace_invites")
        .select("id, owner_id, invited_email, role, token, status, expires_at, created_at")
        .eq("owner_id", ownerId)
        .eq("status", "pending")
        .order("created_at", { ascending: false }),
    ]);

  if (ownerErr) throw ownerErr;
  if (memErr) throw memErr;
  if (invErr) throw invErr;

  const nowIso = new Date().toISOString();
  const activeMembers = Array.isArray(memberRows) ? memberRows : [];
  const validPendingInvites = (Array.isArray(inviteRows) ? inviteRows : []).filter(
    (inv: any) => !inv.expires_at || String(inv.expires_at) > nowIso,
  );

  const memberIds = activeMembers.map((m: any) => String(m.member_id));
  const [memberProfilesRes, authEmails] = await Promise.all([
    memberIds.length > 0
      ? db.from("profiles").select("id, full_name").in("id", memberIds)
      : Promise.resolve({ data: [] }),
    resolveAuthEmailsByIds([ownerId, ...memberIds], db),
  ]);

  const memberProfilesById = new Map<string, { full_name?: string | null; email?: string | null }>();
  for (const p of memberProfilesRes?.data ?? []) {
    memberProfilesById.set(String(p.id), p);
  }

  const members = activeMembers.map((m: any) => {
    const uid = String(m.member_id);
    const prof = memberProfilesById.get(uid);
    return {
      id: m.id,
      userId: m.member_id,
      role: m.role,
      fullName: prof?.full_name ?? null,
      email: authEmails.get(uid) ?? prof?.email ?? null,
      joinedAt: m.created_at,
    };
  });

  const pendingInvites = validPendingInvites.map((inv: any) => ({
    id: inv.id,
    email: inv.invited_email,
    role: inv.role,
    token: inv.token,
    expiresAt: inv.expires_at,
    createdAt: inv.created_at,
  }));

  const seatUsage = computeSeatUsage({
    plan: ownerProfile?.subscription_plan ?? "free",
    activeMemberCount: members.length,
    pendingInviteCount: pendingInvites.length,
  });

  return {
    owner: {
      userId: ownerId,
      fullName: ownerProfile?.full_name ?? null,
      email: authEmails.get(String(ownerId)) ?? ownerProfile?.email ?? null,
      plan: seatUsage.plan,
    },
    members,
    pendingInvites,
    seatUsage,
  };
}

/**
 * GET /v1/team
 * Returns the caller's workspace membership, active seats, pending invites, and seat quota.
 */
teamRouter.get("/", requireAuth, readLimiter, async (req, res, next) => {
  try {
    const userId = req.user!.id;
    const db = teamDeps.db;
    const ctx = await teamDeps.resolveWorkspaceContext(userId, db);
    const snapshot = await loadWorkspaceSnapshot(ctx.workspaceOwnerId, db);
    if (!snapshot.owner.email && ctx.workspaceOwnerId === userId && req.user?.email) {
      snapshot.owner.email = req.user.email;
    }

    let incomingInvites: any[] = [];
    if (req.user?.email) {
      const normalizedEmail = normalizeInviteEmail(req.user.email);
      const { data: myInvites } = await db
        .from("workspace_invites")
        .select("id, owner_id, invited_email, role, token, expires_at, created_at")
        .eq("status", "pending")
        .ilike("invited_email", normalizedEmail)
        .gt("expires_at", new Date().toISOString())
        .order("created_at", { ascending: false });

      if (Array.isArray(myInvites) && myInvites.length > 0) {
        const ownerIds = Array.from(new Set(myInvites.map((i: any) => String(i.owner_id))));
        const [{ data: owners }, ownerEmails] = await Promise.all([
          db.from("profiles").select("id, full_name").in("id", ownerIds),
          resolveAuthEmailsByIds(ownerIds, db),
        ]);
        const ownersMap = new Map((owners ?? []).map((o: any) => [String(o.id), o]));
        incomingInvites = myInvites.map((i: any) => {
          const ownerIdKey = String(i.owner_id);
          const owner = ownersMap.get(ownerIdKey) as any;
          return {
            id: i.id,
            token: i.token,
            role: i.role,
            expiresAt: i.expires_at,
            ownerName: owner?.full_name ?? null,
            ownerEmail: ownerEmails.get(ownerIdKey) ?? owner?.email ?? null,
          };
        });
      }
    }

    return res.json({
      myRole: ctx.role,
      isTeamMember: ctx.isTeamMember,
      workspaceOwnerId: ctx.workspaceOwnerId,
      ...snapshot,
      incomingInvites,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /v1/team/invites
 * Invites a teammate by email, enforcing the workspace owner's plan seat limit.
 */
teamRouter.post("/invites", requireAuth, writeLimiter, async (req, res, next) => {
  try {
    const userId = req.user!.id;
    const db = teamDeps.db;
    const ctx = await teamDeps.resolveWorkspaceContext(userId, db);

    if (ctx.role !== "owner" && ctx.role !== "admin") {
      return res.status(403).json({
        code: "forbidden",
        message: "Only workspace owners or admins can invite teammates.",
      });
    }

    const parsed = CreateInviteSchema.safeParse(req.body ?? {});
    if (!parsed.success || !isValidInviteEmail(parsed.data.email)) {
      return res.status(400).json({
        code: "invalid_email",
        message: "Please provide a valid teammate email address.",
      });
    }

    const invitedEmail = normalizeInviteEmail(parsed.data.email);
    const snapshot = await loadWorkspaceSnapshot(ctx.workspaceOwnerId, db);

    if (snapshot.owner.email && normalizeInviteEmail(snapshot.owner.email) === invitedEmail) {
      return res.status(400).json({
        code: "cannot_invite_owner",
        message: "The workspace owner already occupies a seat.",
      });
    }

    if (
      snapshot.members.some(
        (m: any) => m.email && normalizeInviteEmail(m.email) === invitedEmail,
      )
    ) {
      return res.status(409).json({
        code: "already_member",
        message: "This user is already an active member of your workspace.",
      });
    }

    if (
      snapshot.pendingInvites.some(
        (inv: any) => normalizeInviteEmail(inv.email) === invitedEmail,
      )
    ) {
      return res.status(409).json({
        code: "already_invited",
        message: "A pending invite already exists for this email address.",
      });
    }

    if (!snapshot.seatUsage.canInvite) {
      const limitLabel = snapshot.seatUsage.isUnlimitedSeats
        ? "Unlimited"
        : `${snapshot.seatUsage.seatLimit}`;
      return res.status(403).json({
        code: "seat_limit_reached",
        message: `Seat limit reached (${snapshot.seatUsage.seatsReserved}/${limitLabel} seats on ${snapshot.seatUsage.plan.toUpperCase()}). Upgrade your plan or revoke a pending invite.`,
      });
    }

    const token = crypto.randomBytes(24).toString("base64url");
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

    const { data: created, error } = await db
      .from("workspace_invites")
      .insert({
        owner_id: ctx.workspaceOwnerId,
        invited_email: invitedEmail,
        role: parsed.data.role,
        token,
        invited_by: userId,
        status: "pending",
        expires_at: expiresAt,
      })
      .select("id, invited_email, role, token, expires_at, created_at")
      .single();

    if (error) {
      if (error.code === "23505") {
        return res.status(409).json({
          code: "already_invited",
          message: "A pending invite already exists for this email address.",
        });
      }
      throw error;
    }

    const updated = await loadWorkspaceSnapshot(ctx.workspaceOwnerId, db);
    return res.status(201).json({
      invite: {
        id: created.id,
        email: created.invited_email,
        role: created.role,
        token: created.token,
        expiresAt: created.expires_at,
        createdAt: created.created_at,
      },
      seatUsage: updated.seatUsage,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * DELETE /v1/team/invites/:inviteId
 * Revokes a pending invite, immediately freeing the reserved seat.
 */
teamRouter.delete("/invites/:inviteId", requireAuth, writeLimiter, async (req, res, next) => {
  try {
    const userId = req.user!.id;
    const db = teamDeps.db;
    const ctx = await teamDeps.resolveWorkspaceContext(userId, db);

    if (ctx.role !== "owner" && ctx.role !== "admin") {
      return res.status(403).json({
        code: "forbidden",
        message: "Only workspace owners or admins can revoke invites.",
      });
    }

    const { error } = await db
      .from("workspace_invites")
      .update({ status: "revoked" })
      .eq("id", req.params.inviteId)
      .eq("owner_id", ctx.workspaceOwnerId)
      .eq("status", "pending");

    if (error) throw error;
    return res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /v1/team/invites/accept
 * Accepts a workspace invite token for the signed-in user.
 */
teamRouter.post("/invites/accept", requireAuth, writeLimiter, async (req, res, next) => {
  try {
    const userId = req.user!.id;
    const db = teamDeps.db;

    const parsed = AcceptInviteSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ code: "invalid_token", message: "Valid invite token is required." });
    }

    const { data: invite, error: invErr } = await db
      .from("workspace_invites")
      .select("*")
      .eq("token", parsed.data.token)
      .maybeSingle();

    if (invErr) throw invErr;
    if (!invite) {
      return res.status(404).json({ code: "invite_not_found", message: "Invite link not found." });
    }
    if (invite.status !== "pending") {
      return res.status(409).json({
        code: "invite_not_pending",
        message: `This invite has already been ${invite.status}.`,
      });
    }
    if (invite.expires_at && new Date(invite.expires_at).getTime() <= Date.now()) {
      await db.from("workspace_invites").update({ status: "expired" }).eq("id", invite.id);
      return res.status(410).json({ code: "invite_expired", message: "This invite link has expired." });
    }

    if (invite.owner_id === userId) {
      return res.status(400).json({
        code: "cannot_accept_own_invite",
        message: "You are already the owner of this workspace.",
      });
    }

    // Verify signed-in email matches invited email
    let callerEmail = req.user?.email ? normalizeInviteEmail(req.user.email) : "";
    if (!callerEmail) {
      const authLookup = await resolveAuthEmailsByIds([userId], db);
      const foundEmail = authLookup.get(String(userId));
      callerEmail = foundEmail ? normalizeInviteEmail(foundEmail) : "";
    }
    if (!callerEmail || callerEmail !== normalizeInviteEmail(invite.invited_email)) {
      return res.status(403).json({
        code: "email_mismatch",
        message: `Please sign in as ${invite.invited_email} to accept this invite.`,
      });
    }

    // Ensure caller isn't already active in another workspace
    const existingCtx = await teamDeps.resolveWorkspaceContext(userId, db);
    if (existingCtx.isTeamMember && existingCtx.workspaceOwnerId !== invite.owner_id) {
      return res.status(409).json({
        code: "already_in_team",
        message: "You already belong to another team workspace. Leave it in Settings first.",
      });
    }

    // Check owner's active seat count against their plan limit
    const [{ data: ownerProfile }, { data: activeMembers }] = await Promise.all([
      db.from("profiles").select("subscription_plan").eq("id", invite.owner_id).single(),
      db
        .from("workspace_members")
        .select("id")
        .eq("owner_id", invite.owner_id)
        .eq("status", "active"),
    ]);

    const activeCount = Array.isArray(activeMembers) ? activeMembers.length : 0;
    if (
      !canAcceptSeatInvite({
        plan: ownerProfile?.subscription_plan ?? "free",
        activeMemberCount: activeCount,
      })
    ) {
      return res.status(403).json({
        code: "seat_limit_reached",
        message: "This workspace has reached its maximum seat limit. Ask the owner to free a seat or upgrade.",
      });
    }

    const nowIso = new Date().toISOString();
    const { error: upsertErr } = await db.from("workspace_members").upsert(
      {
        owner_id: invite.owner_id,
        member_id: userId,
        role: invite.role === "admin" ? "admin" : "member",
        status: "active",
        updated_at: nowIso,
      },
      { onConflict: "owner_id,member_id" },
    );
    if (upsertErr) throw upsertErr;

    await db
      .from("workspace_invites")
      .update({
        status: "accepted",
        accepted_by: userId,
        accepted_at: nowIso,
      })
      .eq("id", invite.id);

    return res.json({
      success: true,
      workspaceOwnerId: invite.owner_id,
      role: invite.role,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * PATCH /v1/team/members/:memberId
 * Updates a teammate's role (owner only).
 */
teamRouter.patch("/members/:memberId", requireAuth, writeLimiter, async (req, res, next) => {
  try {
    const userId = req.user!.id;
    const db = teamDeps.db;
    const ctx = await teamDeps.resolveWorkspaceContext(userId, db);

    if (ctx.role !== "owner") {
      return res.status(403).json({
        code: "forbidden",
        message: "Only the workspace owner can change teammate roles.",
      });
    }

    const parsed = UpdateMemberRoleSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ code: "invalid_role", message: "Role must be admin or member." });
    }

    const { error } = await db
      .from("workspace_members")
      .update({ role: parsed.data.role, updated_at: new Date().toISOString() })
      .eq("owner_id", ctx.workspaceOwnerId)
      .eq("member_id", req.params.memberId)
      .eq("status", "active");

    if (error) throw error;
    return res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

/**
 * DELETE /v1/team/members/:memberId
 * Removes a teammate (owner/admin) or lets the member leave their workspace.
 */
teamRouter.delete("/members/:memberId", requireAuth, writeLimiter, async (req, res, next) => {
  try {
    const userId = req.user!.id;
    const targetMemberId = req.params.memberId;
    const db = teamDeps.db;
    const ctx = await teamDeps.resolveWorkspaceContext(userId, db);

    const isSelfLeave = targetMemberId === userId && ctx.isTeamMember;
    if (!isSelfLeave && ctx.role !== "owner" && ctx.role !== "admin") {
      return res.status(403).json({
        code: "forbidden",
        message: "Only workspace owners or admins can remove teammates.",
      });
    }

    const { error } = await db
      .from("workspace_members")
      .update({ status: "removed", updated_at: new Date().toISOString() })
      .eq("owner_id", ctx.workspaceOwnerId)
      .eq("member_id", targetMemberId)
      .eq("status", "active");

    if (error) throw error;
    return res.json({ success: true });
  } catch (err) {
    next(err);
  }
});
