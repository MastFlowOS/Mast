import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { CheckCircle2, Loader2, Users } from "lucide-react";
import { toast } from "sonner";
import { useAcceptTeamInvite, useMe } from "@/hooks/use-mast-api";
import { MastWordmark } from "@/components/mast/MastWordmark";

export const Route = createFileRoute("/invite")({
  head: () => ({ meta: [{ title: "Team Invite — Mast" }] }),
  component: AcceptInvitePage,
});

const PENDING_INVITE_KEY = "mast_pending_invite_token";

function AcceptInvitePage() {
  const navigate = useNavigate();
  const { data: auth, isLoading: authLoading } = useMe();
  const acceptInvite = useAcceptTeamInvite();

  const [token, setToken] = useState<string>(() => {
    if (typeof window === "undefined") return "";
    const urlToken = new URLSearchParams(window.location.search).get("token") || "";
    if (urlToken) {
      try {
        localStorage.setItem(PENDING_INVITE_KEY, urlToken);
      } catch {
        // ignore storage errors
      }
      return urlToken;
    }
    try {
      return localStorage.getItem(PENDING_INVITE_KEY) || "";
    } catch {
      return "";
    }
  });

  const [errorMsg, setErrorMsg] = useState("");
  const [joined, setJoined] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const urlToken = new URLSearchParams(window.location.search).get("token");
    if (urlToken && urlToken !== token) {
      setToken(urlToken);
      try {
        localStorage.setItem(PENDING_INVITE_KEY, urlToken);
      } catch {
        // ignore
      }
    }
  }, [token]);

  const handleAccept = async () => {
    if (!token) {
      setErrorMsg("Missing invite token.");
      return;
    }
    setErrorMsg("");
    try {
      await acceptInvite.mutateAsync(token);
      try {
        localStorage.removeItem(PENDING_INVITE_KEY);
      } catch {
        // ignore
      }
      setJoined(true);
      toast.success("Joined team workspace");
      setTimeout(() => {
        void navigate({ to: "/dashboard" });
      }, 900);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : "Could not accept invite.");
    }
  };

  return (
    <div className="min-h-screen bg-background text-foreground flex flex-col items-center justify-center p-6">
      <div className="w-full max-w-md bg-card border border-border/60 rounded-2xl p-7 shadow-lg space-y-5 text-center">
        <div className="flex justify-center">
          <MastWordmark />
        </div>

        <div className="size-12 rounded-2xl bg-blue-500/15 border border-blue-500/25 text-blue-400 grid place-items-center mx-auto">
          {joined ? <CheckCircle2 className="size-6 text-emerald-400" /> : <Users className="size-6" />}
        </div>

        <div className="space-y-1.5">
          <h1 className="text-xl font-bold tracking-tight">
            {joined ? "Welcome to the Team" : "Team Workspace Invite"}
          </h1>
          <p className="text-xs text-muted-foreground leading-relaxed">
            {joined
              ? "Redirecting you to your shared MAST workspace..."
              : "Accept this invite to collaborate on shared leads, pipeline stages, and follow-ups."}
          </p>
        </div>

        {!token ? (
          <div className="space-y-3">
            <p className="text-xs text-destructive">No invite token was found in this URL.</p>
            <Link
              to="/dashboard"
              className="inline-flex items-center justify-center px-4 py-2 rounded-xl bg-blue-600 text-white text-xs font-semibold hover:bg-blue-500"
            >
              Go to Dashboard
            </Link>
          </div>
        ) : authLoading ? (
          <div className="py-4 flex justify-center">
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          </div>
        ) : !auth?.user ? (
          <div className="space-y-3 pt-1">
            <p className="text-xs text-muted-foreground">
              Sign in with the email address that was invited, then return here to join.
            </p>
            <div className="flex items-center justify-center gap-2.5">
              <Link
                to="/login"
                className="px-4 py-2 rounded-xl bg-blue-600 hover:bg-blue-500 text-white text-xs font-semibold transition-colors"
              >
                Sign In
              </Link>
              <Link
                to="/signup"
                className="px-4 py-2 rounded-xl border border-border/80 bg-background hover:bg-muted text-xs font-semibold transition-colors"
              >
                Create Account
              </Link>
            </div>
          </div>
        ) : joined ? null : (
          <div className="space-y-3 pt-1">
            <p className="text-xs text-muted-foreground">
              Signed in as <span className="font-semibold text-foreground">{auth.user.email}</span>
            </p>
            {errorMsg && <p className="text-xs text-destructive">{errorMsg}</p>}
            <button
              type="button"
              onClick={handleAccept}
              disabled={acceptInvite.isPending}
              className="w-full px-4 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-xs font-semibold transition-colors inline-flex items-center justify-center gap-2"
            >
              {acceptInvite.isPending && <Loader2 className="size-4 animate-spin" />}
              Accept &amp; Join Workspace
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
