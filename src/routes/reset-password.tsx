import { createFileRoute, Link } from "@tanstack/react-router";
import { Logo } from "@/components/mast/Logo";
import { useState, useEffect } from "react";
import { ArrowLeft, CheckCircle2, Lock, Eye, EyeOff } from "lucide-react";
import { supabase } from "@/lib/supabase";

type ResetPasswordSearch = {
  token?: string;
};

export const Route = createFileRoute("/reset-password")({
  validateSearch: (search: Record<string, unknown>): ResetPasswordSearch => {
    return {
      token: (search.token as string) || "",
    };
  },
  head: () => ({
    meta: [
      { title: "Reset Password — Mast" },
      { name: "description", content: "Choose a new password for your Mast account." },
    ],
  }),
  component: ResetPasswordPage,
});

function ResetPasswordPage() {
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState(false);
  
  const [checking, setChecking] = useState(true);
  const [hasSession, setHasSession] = useState(false);

  useEffect(() => {
    if (!supabase) {
      setChecking(false);
      return;
    }
    // Check if we already have a session (established by recovery link)
    const checkSession = async () => {
      const { data: { session } } = await supabase!.auth.getSession();
      setHasSession(!!session);
      setChecking(false);
    };
    void checkSession();

    // Listen for auth state changes
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
      if (session) {
        setHasSession(true);
      }
      setChecking(false);
    });

    return () => subscription.unsubscribe();
  }, []);

  const token = hasSession ? "active" : "";

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();

    if (!hasSession) {
      setError("No active password recovery session. Please request a new link.");
      return;
    }

    if (password.length < 8) {
      setError("Password must be at least 8 characters long.");
      return;
    }

    if (password !== confirmPassword) {
      setError("Passwords do not match.");
      return;
    }

    setLoading(true);
    setError("");

    try {
      if (!supabase) throw new Error("Supabase is not configured.");
      const { error: updateErr } = await supabase.auth.updateUser({
        password: password,
      });

      if (updateErr) {
        throw updateErr;
      }

      setSuccess(true);
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Failed to reset password. Please try again."
      );
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex flex-col px-6 py-10 lg:px-16 bg-background text-foreground">
      <Logo />
      <div className="flex-1 flex items-center">
        <div className="w-full max-w-sm mx-auto">
          {!success && (
            <Link
              to="/login"
              className="inline-flex items-center gap-1.5 text-xs font-semibold text-muted-foreground hover:text-foreground"
            >
              <ArrowLeft className="size-3.5" /> Back to login
            </Link>
          )}

          {!token ? (
            <div className="mt-8 bg-card border border-border rounded-2xl p-6 text-center">
              <div className="mx-auto size-10 rounded-xl bg-destructive/10 border border-destructive/20 grid place-items-center">
                <Lock className="size-5 text-destructive" />
              </div>
              <h2 className="mt-4 font-bold text-foreground">Missing or Invalid Token</h2>
              <p className="mt-2 text-sm text-muted-foreground">
                The password reset token is missing or has expired. Please request a new password reset link.
              </p>
              <Link
                to="/forgot-password"
                className="mt-6 inline-block text-xs font-semibold text-brand hover:text-brand-dark"
              >
                Request a new link →
              </Link>
            </div>
          ) : !success ? (
            <>
              <h1 className="mt-6 text-3xl font-bold tracking-tight">Create new password</h1>
              <p className="mt-2 text-sm text-muted-foreground">
                Please enter a secure new password for your account.
              </p>

              <form className="mt-8 space-y-4" onSubmit={handleSubmit}>
                <label className="block">
                  <span className="block text-xs font-semibold text-muted-foreground mb-1.5">
                    New password
                  </span>
                  <div className="relative">
                    <input
                      type={showPassword ? "text" : "password"}
                      required
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      placeholder="••••••••"
                      className="w-full bg-card border border-border focus:border-brand focus:ring-2 focus:ring-brand/20 outline-none pl-3.5 pr-10 py-2.5 rounded-lg text-sm text-foreground placeholder:text-muted-foreground/60 transition-all"
                    />
                    <button
                      type="button"
                      onClick={() => setShowPassword(!showPassword)}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors focus:outline-none"
                    >
                      {showPassword ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                    </button>
                  </div>
                </label>

                <label className="block">
                  <span className="block text-xs font-semibold text-muted-foreground mb-1.5">
                    Confirm new password
                  </span>
                  <div className="relative">
                    <input
                      type={showConfirmPassword ? "text" : "password"}
                      required
                      value={confirmPassword}
                      onChange={(e) => setConfirmPassword(e.target.value)}
                      placeholder="••••••••"
                      className="w-full bg-card border border-border focus:border-brand focus:ring-2 focus:ring-brand/20 outline-none pl-3.5 pr-10 py-2.5 rounded-lg text-sm text-foreground placeholder:text-muted-foreground/60 transition-all"
                    />
                    <button
                      type="button"
                      onClick={() => setShowConfirmPassword(!showConfirmPassword)}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors focus:outline-none"
                    >
                      {showConfirmPassword ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                    </button>
                  </div>
                </label>

                {error && (
                  <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive animate-in fade-in slide-in-from-top-1 duration-200">
                    {error}
                  </div>
                )}

                <button
                  type="submit"
                  disabled={loading}
                  className="w-full bg-brand hover:bg-brand-dark text-brand-foreground py-3 rounded-xl font-bold transition-all shadow-brand disabled:opacity-60"
                >
                  {loading ? "Resetting password..." : "Reset password"}
                </button>
              </form>
            </>
          ) : (
            <div className="mt-8 bg-card border border-border rounded-2xl p-6 text-center animate-in fade-in zoom-in-95 duration-300">
              <div className="mx-auto size-10 rounded-xl bg-brand/10 border border-brand/20 grid place-items-center">
                <CheckCircle2 className="size-5 text-brand" />
              </div>
              <h2 className="mt-4 font-bold text-foreground">Password reset successful</h2>
              <p className="mt-2 text-sm text-muted-foreground">
                Your password has been successfully updated. You can now login with your new password.
              </p>
              <Link
                to="/login"
                className="mt-6 inline-block text-xs font-semibold text-brand hover:text-brand-dark transition-colors"
              >
                Return to login →
              </Link>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
