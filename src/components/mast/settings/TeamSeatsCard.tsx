import { useState } from "react";
import { toast } from "sonner";
import {
  Check,
  Copy,
  Crown,
  Loader2,
  LogOut,
  Mail,
  Shield,
  Trash2,
  UserPlus,
  Users,
  X,
} from "lucide-react";
import {
  useAcceptTeamInvite,
  useInviteTeamMember,
  useMe,
  useRemoveTeamMember,
  useRevokeTeamInvite,
  useTeamWorkspace,
  useUpdateTeamMemberRole,
} from "@/hooks/use-mast-api";
import { ApiError, getPublicWebOrigin } from "@/lib/api";
import { MastConfirm } from "@/components/mast/ui/MastConfirm";

export function TeamSeatsCard() {
  const { data: auth } = useMe();
  const teamQuery = useTeamWorkspace(!!auth?.user);
  const inviteMember = useInviteTeamMember();
  const revokeInvite = useRevokeTeamInvite();
  const acceptInvite = useAcceptTeamInvite();
  const updateRole = useUpdateTeamMemberRole();
  const removeMember = useRemoveTeamMember();

  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<"member" | "admin">("member");
  const [copiedToken, setCopiedToken] = useState<string | null>(null);

  const team = teamQuery.data;
  const seatUsage = team?.seatUsage;
  const canManageTeam = team?.myRole === "owner" || team?.myRole === "admin";
  const isOwner = team?.myRole === "owner";

  const buildInviteUrl = (token: string) =>
    `${getPublicWebOrigin()}/invite?token=${encodeURIComponent(token)}`;

  const handleInvite = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = inviteEmail.trim();
    if (!trimmed) return;
    try {
      const res = await inviteMember.mutateAsync({ email: trimmed, role: inviteRole });
      setInviteEmail("");
      const inviteUrl = buildInviteUrl(res.invite.token);
      try {
        await navigator.clipboard.writeText(inviteUrl);
        setCopiedToken(res.invite.token);
        setTimeout(() => setCopiedToken(null), 2500);
        toast.success("Invite created and link copied to clipboard");
      } catch {
        toast.success("Invite created — copy the invite link below to share");
      }
    } catch (err) {
      toast.error(err instanceof ApiError || err instanceof Error ? err.message : "Could not send invite");
    }
  };

  const handleCopyLink = async (token: string) => {
    const inviteUrl = buildInviteUrl(token);
    try {
      await navigator.clipboard.writeText(inviteUrl);
      setCopiedToken(token);
      setTimeout(() => setCopiedToken(null), 2000);
      toast.success("Invite link copied");
    } catch {
      toast.error("Could not copy invite link");
    }
  };

  const handleRevoke = async (inviteId: string) => {
    try {
      await revokeInvite.mutateAsync(inviteId);
      toast.success("Invite revoked and seat freed");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not revoke invite");
    }
  };

  const handleAcceptIncoming = async (token: string) => {
    try {
      await acceptInvite.mutateAsync(token);
      toast.success("Joined team workspace");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not accept invite");
    }
  };

  const handleRoleChange = async (memberId: string, role: "admin" | "member") => {
    try {
      await updateRole.mutateAsync({ memberId, role });
      toast.success(`Role updated to ${role}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not update role");
    }
  };

  const handleRemoveOrLeave = async (memberId: string, isSelf: boolean) => {
    try {
      await removeMember.mutateAsync(memberId);
      toast.success(isSelf ? "You left the team workspace" : "Teammate removed");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not update membership");
    }
  };

  const seatBadgeText = seatUsage
    ? seatUsage.isUnlimitedSeats
      ? `${seatUsage.seatsReserved} seat${seatUsage.seatsReserved === 1 ? "" : "s"} · Unlimited`
      : `${seatUsage.seatsReserved} / ${seatUsage.seatLimit} seat${seatUsage.seatLimit === 1 ? "" : "s"} used`
    : teamQuery.isError
      ? "Unavailable"
      : "Loading seats...";

  return (
    <div className="bg-card border border-border/60 rounded-2xl p-6 shadow-sm space-y-5">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="flex items-start gap-3">
          <div className="size-10 rounded-xl bg-blue-500/10 border border-blue-500/20 text-blue-400 grid place-items-center shrink-0">
            <Users className="size-5" />
          </div>
          <div>
            <h2 className="text-base font-bold text-foreground">Team &amp; Seats</h2>
            <p className="text-xs text-muted-foreground mt-0.5">
              Share your agency leads, pipeline, follow-ups, and plan credits across your team.
            </p>
          </div>
        </div>

        <div
          className={`inline-flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-semibold border self-start sm:self-auto ${
            teamQuery.isError
              ? "bg-destructive/10 text-destructive border-destructive/25"
              : "bg-blue-500/10 text-blue-300 border-blue-500/25"
          }`}
        >
          <span>{seatBadgeText}</span>
        </div>
      </div>

      {teamQuery.isError && !team && (
        <p className="text-xs text-destructive">
          {(teamQuery.error as Error | null)?.message || "Could not load team seats."}{" "}
          <button
            type="button"
            className="underline cursor-pointer"
            onClick={() => teamQuery.refetch()}
          >
            Retry
          </button>
        </p>
      )}

      {/* Incoming invites addressed to the signed-in user */}
      {team && team.incomingInvites.length > 0 && (
        <div className="space-y-2">
          {team.incomingInvites.map((inv) => (
            <div
              key={inv.id}
              className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 p-3.5 rounded-xl border border-emerald-500/30 bg-emerald-500/5"
            >
              <div className="text-xs space-y-0.5">
                <p className="font-semibold text-foreground">
                  Team invite from {inv.ownerName || inv.ownerEmail || "Workspace Owner"}
                </p>
                <p className="text-muted-foreground">
                  Role: <span className="capitalize font-medium text-foreground">{inv.role}</span> · Joining shares their CRM workspace and plan limits.
                </p>
              </div>
              <button
                type="button"
                onClick={() => handleAcceptIncoming(inv.token)}
                disabled={acceptInvite.isPending}
                className="px-3.5 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold transition-colors inline-flex items-center gap-1.5 shrink-0"
              >
                {acceptInvite.isPending ? <Loader2 className="size-3.5 animate-spin" /> : <Check className="size-3.5" />}
                Join Workspace
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Member banner when currently inside another owner's agency workspace */}
      {team?.isTeamMember && auth?.user?.id && (
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 p-3.5 rounded-xl border border-blue-500/25 bg-blue-500/5">
          <div className="text-xs space-y-0.5">
            <p className="font-semibold text-foreground">
              Active member of {team.owner.fullName || team.owner.email || "Agency"}&apos;s workspace
            </p>
            <p className="text-muted-foreground">
              Your role is <span className="capitalize font-medium text-foreground">{team.myRole}</span> · Plan:{" "}
              <span className="uppercase font-medium text-foreground">{team.owner.plan}</span>
            </p>
          </div>
          <MastConfirm
            trigger={
              <button
                type="button"
                disabled={removeMember.isPending}
                className="px-3 py-1.5 rounded-xl border border-destructive/30 text-destructive hover:bg-destructive/10 text-xs font-semibold transition-colors inline-flex items-center gap-1.5 self-start sm:self-auto cursor-pointer"
              >
                <LogOut className="size-3.5" />
                Leave Workspace
              </button>
            }
            title="Leave this workspace?"
            description="You will lose access to shared agency leads, pipeline stages, follow-ups, and team credits until re-invited."
            confirmLabel="Leave workspace"
            destructive
            disabled={removeMember.isPending}
            onConfirm={() => handleRemoveOrLeave(auth.user!.id, true)}
          />
        </div>
      )}

      {/* Invite form */}
      {canManageTeam && (
        <form onSubmit={handleInvite} className="space-y-2.5">
          <div className="flex flex-col sm:flex-row gap-2">
            <div className="relative flex-1">
              <Mail className="size-4 text-muted-foreground absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
              <input
                type="email"
                value={inviteEmail}
                onChange={(e) => setInviteEmail(e.target.value)}
                placeholder="teammate@agency.com"
                disabled={!seatUsage?.canInvite || inviteMember.isPending}
                className="w-full bg-background border border-border/80 focus:border-blue-500 focus:ring-1 focus:ring-blue-500 outline-none pl-9 pr-3.5 py-2 rounded-xl text-sm disabled:opacity-50"
              />
            </div>

            <select
              value={inviteRole}
              onChange={(e) => setInviteRole(e.target.value === "admin" ? "admin" : "member")}
              disabled={!seatUsage?.canInvite || inviteMember.isPending}
              className="bg-background border border-border/80 focus:border-blue-500 outline-none px-3 py-2 rounded-xl text-sm disabled:opacity-50"
            >
              <option value="member">Member</option>
              <option value="admin">Admin</option>
            </select>

            <button
              type="submit"
              disabled={!inviteEmail.trim() || !seatUsage?.canInvite || inviteMember.isPending}
              className="px-4 py-2 rounded-xl bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-xs font-semibold transition-colors inline-flex items-center justify-center gap-1.5 shrink-0"
            >
              {inviteMember.isPending ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <UserPlus className="size-3.5" />
              )}
              Invite Teammate
            </button>
          </div>

          {seatUsage && !seatUsage.canInvite && (
            <p className="text-xs text-amber-400">
              {seatUsage.seatLimit <= 1
                ? "Your current plan includes 1 seat (you). Pro includes 3 seats and Premium includes 7 seats."
                : `All ${seatUsage.seatLimit} seats on ${seatUsage.plan.toUpperCase()} are in use or reserved by pending invites.`}
            </p>
          )}
        </form>
      )}

      {/* Pending Invites */}
      {team && team.pendingInvites.length > 0 && (
        <div className="space-y-2">
          <h3 className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground">
            Pending Invites ({team.pendingInvites.length})
          </h3>
          <div className="divide-y divide-border/40 rounded-xl border border-border/50 bg-background/40">
            {team.pendingInvites.map((inv) => (
              <div key={inv.id} className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 px-3.5 py-2.5">
                <div className="min-w-0">
                  <p className="text-xs font-semibold text-foreground truncate">{inv.email}</p>
                  <p className="text-[11px] text-muted-foreground capitalize">
                    {inv.role} · Pending acceptance
                  </p>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <button
                    type="button"
                    onClick={() => handleCopyLink(inv.token)}
                    className="px-2.5 py-1 rounded-lg border border-border/70 bg-card hover:bg-muted text-[11px] font-medium text-foreground inline-flex items-center gap-1"
                  >
                    {copiedToken === inv.token ? <Check className="size-3 text-emerald-400" /> : <Copy className="size-3" />}
                    {copiedToken === inv.token ? "Copied" : "Copy Link"}
                  </button>
                  {canManageTeam && (
                    <button
                      type="button"
                      onClick={() => handleRevoke(inv.id)}
                      disabled={revokeInvite.isPending}
                      title="Revoke invite"
                      className="p-1.5 rounded-lg text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors"
                    >
                      <X className="size-3.5" />
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Active Roster */}
      {team && (
        <div className="space-y-2">
          <h3 className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground">
            Active Seats ({1 + team.members.length})
          </h3>
          <div className="divide-y divide-border/40 rounded-xl border border-border/50 bg-background/40">
            {/* Workspace Owner */}
            <div className="flex items-center justify-between gap-3 px-3.5 py-2.5">
              <div className="flex items-center gap-2.5 min-w-0">
                <div className="size-7 rounded-lg bg-amber-500/15 border border-amber-500/25 text-amber-400 grid place-items-center shrink-0">
                  <Crown className="size-3.5" />
                </div>
                <div className="min-w-0">
                  <p className="text-xs font-semibold text-foreground truncate">
                    {team.owner.fullName || team.owner.email || "Workspace Owner"}
                  </p>
                  {team.owner.email && (
                    <p className="text-[11px] text-muted-foreground truncate">{team.owner.email}</p>
                  )}
                </div>
              </div>
              <span className="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full bg-amber-500/10 text-amber-400 border border-amber-500/25 shrink-0">
                Owner
              </span>
            </div>

            {/* Active Teammates */}
            {team.members.map((m) => (
              <div key={m.id} className="flex items-center justify-between gap-3 px-3.5 py-2.5">
                <div className="flex items-center gap-2.5 min-w-0">
                  <div className="size-7 rounded-lg bg-blue-500/15 border border-blue-500/25 text-blue-400 grid place-items-center shrink-0">
                    <Shield className="size-3.5" />
                  </div>
                  <div className="min-w-0">
                    <p className="text-xs font-semibold text-foreground truncate">
                      {m.fullName || m.email || m.userId}
                    </p>
                    {m.email && <p className="text-[11px] text-muted-foreground truncate">{m.email}</p>}
                  </div>
                </div>

                <div className="flex items-center gap-2 shrink-0">
                  {isOwner ? (
                    <select
                      value={m.role}
                      onChange={(e) =>
                        handleRoleChange(m.userId, e.target.value === "admin" ? "admin" : "member")
                      }
                      disabled={updateRole.isPending}
                      className="bg-card border border-border/70 rounded-lg px-2 py-1 text-[11px] font-medium text-foreground outline-none"
                    >
                      <option value="member">Member</option>
                      <option value="admin">Admin</option>
                    </select>
                  ) : (
                    <span className="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full bg-blue-500/10 text-blue-300 border border-blue-500/20">
                      {m.role}
                    </span>
                  )}

                  {(isOwner || (canManageTeam && m.role === "member")) && m.userId !== auth?.user?.id && (
                    <MastConfirm
                      trigger={
                        <button
                          type="button"
                          disabled={removeMember.isPending}
                          title="Remove teammate"
                          aria-label={`Remove ${m.fullName || m.email || "teammate"}`}
                          className="p-1.5 rounded-lg text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors cursor-pointer"
                        >
                          <Trash2 className="size-3.5" />
                        </button>
                      }
                      title={`Remove ${m.fullName || m.email || "teammate"}?`}
                      description="They will immediately lose access to your shared agency leads, pipeline, follow-ups, and plan credits."
                      confirmLabel="Remove teammate"
                      destructive
                      disabled={removeMember.isPending}
                      onConfirm={() => handleRemoveOrLeave(m.userId, false)}
                    />
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
