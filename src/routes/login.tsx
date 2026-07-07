import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Logo } from "@/components/mast/Logo";
import { ApiError } from "@/lib/api";
import { useLogin, useMe, useSignup } from "@/hooks/use-mast-api";
import { Eye, EyeOff } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { useQueryClient } from "@tanstack/react-query";

export const Route = createFileRoute("/login")({
  head: () => ({
    meta: [
      { title: "Login — Mast" },
      { name: "description", content: "Login to your Mast account." },
    ],
  }),
  component: LoginPage,
});

function LoginPage() {
  return <AuthShell mode="login" />;
}

export function AuthShell({ mode }: { mode: "login" | "signup" }) {
  const isSignup = mode === "signup";
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { data: auth, isLoading: authLoading } = useMe();
  const loginMutation = useLogin();
  const signupMutation = useSignup();
  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [phoneNumber, setPhoneNumber] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [isGooglePending, setIsGooglePending] = useState(false);
  const [error, setError] = useState("");
  const [showVerifyEmail, setShowVerifyEmail] = useState(false);
  const isPending = loginMutation.isPending || signupMutation.isPending;

  const [verifiedBanner, setVerifiedBanner] = useState(false);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const authError = params.get("error");
    if (authError) {
      setError(decodeURIComponent(authError));
    }
    if (params.get("verified") === "1") {
      setVerifiedBanner(true);
    }
    if (authError || params.get("verified")) {
      window.history.replaceState({}, "", window.location.pathname);
    }
  }, []);

  useEffect(() => {
    if (authLoading || !auth?.user) return;
    void navigate({ to: "/dashboard", replace: true });
  }, [auth?.user, authLoading, navigate]);

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError("");

    if (!email.trim() || !password) {
      setError("Email and password are required.");
      return;
    }
    if (isSignup && !fullName.trim()) {
      setError("Full name is required.");
      return;
    }

    try {
      if (isSignup) {
        const result = await signupMutation.mutateAsync({ fullName, email, password, phoneNumber });
        if (result.needsEmailVerification) {
          // Expected path when email confirmation is enabled in Supabase.
          // Account was created and verification email was sent — show the
          // verify-email screen, which polls for verification using the
          // same email/password (still held in this component's state).
          setShowVerifyEmail(true);
          return;
        }
        // Email confirmation disabled — session is live, go straight to dashboard.
        toast.success("Account created successfully");
        await navigate({ to: "/dashboard" });
      } else {
        await loginMutation.mutateAsync({ email, password });
        toast.success("Welcome back");
        await navigate({ to: "/dashboard" });
      }
    } catch (err) {
      const message = err instanceof ApiError ? err.message : err instanceof Error ? err.message : "Could not complete authentication.";
      setError(message);
    }
  };

  const startGoogle = async () => {
    setError("");
    if (!supabase) {
      setError("Authentication is not configured. Contact support.");
      return;
    }
    setIsGooglePending(true);
    try {
      // 1. Attempt Popup OAuth
      const { data, error } = await supabase.auth.signInWithOAuth({
        provider: "google",
        options: {
          skipBrowserRedirect: true,
          redirectTo: `${window.location.origin}/auth/callback`,
          queryParams: {
            prompt: "select_account",
          },
        },
      });

      if (error) throw error;
      if (!data?.url) throw new Error("No authorization URL returned");

      // Set up popup features
      const width = 500;
      const height = 600;
      const left = window.screen.width / 2 - width / 2;
      const top = window.screen.height / 2 - height / 2;
      const windowFeatures = `scrollbars=yes,resizable=yes,width=${width},height=${height},top=${top},left=${left}`;

      const popup = window.open(data.url, "GoogleOAuthPopup", windowFeatures);

      // 2. Fallback to redirect if popup is blocked
      if (!popup || popup.closed || typeof popup.closed === "undefined") {
        toast.info("Popup blocked. Redirecting instead...");
        const { error: redirectErr } = await supabase.auth.signInWithOAuth({
          provider: "google",
          options: {
            redirectTo: `${window.location.origin}/dashboard`,
            queryParams: {
              prompt: "select_account",
            },
          },
        });
        if (redirectErr) throw redirectErr;
        return;
      }

      // Listen for the postMessage response from callback window
      const handleMessage = async (event: MessageEvent) => {
        if (event.origin !== window.location.origin) return;
        if (event.data?.type === "AUTH_SUCCESS") {
          window.removeEventListener("message", handleMessage);
          setIsGooglePending(false);
          toast.success("Welcome back");
          await queryClient.invalidateQueries({ queryKey: ["mast"] });
          void navigate({ to: "/dashboard", replace: true });
        }
      };

      window.addEventListener("message", handleMessage);

      // Monitor popup closed state to reset pending spinner
      const timer = setInterval(() => {
        if (popup.closed) {
          clearInterval(timer);
          window.removeEventListener("message", handleMessage);
          setIsGooglePending(false);
        }
      }, 1000);

    } catch (err) {
      console.error("Google OAuth error:", err);
      setError(err instanceof Error ? err.message : "Google login failed.");
      setIsGooglePending(false);
    }
  };


  return (
    <div className="min-h-screen grid lg:grid-cols-2">
      {/* Left: form */}
      <div className="flex flex-col px-6 py-10 lg:px-16">
        <Logo />
        <div className="flex-1 flex items-center">
          <div className="w-full max-w-sm mx-auto">
            {showVerifyEmail ? (
              <VerifyEmailWaiting
                email={email}
                password={password}
                onResend={() => setShowVerifyEmail(false)}
                onVerified={async () => {
                  // The polling sign-in inside VerifyEmailWaiting already
                  // succeeded, so a real Supabase session exists at this
                  // point — just refresh the cached user and head in.
                  await queryClient.invalidateQueries({ queryKey: ["mast"] });
                  void navigate({ to: "/dashboard", replace: true });
                }}
              />
            ) : (
            <>
            <h1 className="text-3xl font-bold tracking-tight">
              {isSignup ? "Create your account" : "Welcome back"}
            </h1>
            <p className="mt-2 text-sm text-muted-foreground">
              {isSignup ? "Start your free trial. 100 free credits on us." : "Login to your Mast dashboard."}
            </p>

            {verifiedBanner && (
              <div className="mt-6 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-400 flex items-center gap-2">
                <svg className="size-4 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
                </svg>
                Email verified! Log in to continue.
              </div>
            )}
            {error && (
              <div className="mt-6 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                {error}
              </div>
            )}

            <button
              type="button"
              onClick={startGoogle}
              disabled={isGooglePending || authLoading}
              className="mt-8 w-full bg-card border border-border hover:border-muted-foreground/40 py-3 rounded-xl font-medium flex items-center justify-center gap-3 transition-colors disabled:opacity-60"
            >
              <GoogleIcon />
              {isGooglePending ? "Connecting..." : "Continue with Google"}
            </button>

            <div className="my-6 flex items-center gap-3">
              <div className="flex-1 h-px bg-border" />
              <span className="text-[11px] uppercase tracking-widest text-muted-foreground">or</span>
              <div className="flex-1 h-px bg-border" />
            </div>

            <form className="space-y-4" onSubmit={submit}>
              {isSignup && (
                <>
                  <Input
                    label="Full name"
                    type="text"
                    placeholder="Jane Doe"
                    value={fullName}
                    onChange={(event) => setFullName(event.target.value)}
                    autoComplete="name"
                  />
                  <Input
                    label="Phone Number (Optional)"
                    type="tel"
                    placeholder="+1 (555) 000-0000"
                    value={phoneNumber}
                    onChange={(event) => setPhoneNumber(event.target.value)}
                    autoComplete="tel"
                  />
                </>
              )}
              <Input
                label="Email"
                type="email"
                placeholder="you@agency.com"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                autoComplete="email"
              />
              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <span className="text-xs font-semibold text-muted-foreground">Password</span>
                  {!isSignup && (
                    <Link
                      to="/forgot-password"
                      className="text-[11px] font-semibold text-brand hover:text-brand-dark"
                    >
                      Forgot password?
                    </Link>
                  )}
                </div>
                <div className="relative">
                  <input
                    type={showPassword ? "text" : "password"}
                    placeholder="••••••••"
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    autoComplete={isSignup ? "new-password" : "current-password"}
                    className="w-full bg-card border border-border focus:border-brand focus:ring-2 focus:ring-brand/20 outline-none pl-3.5 pr-10 py-2.5 rounded-lg text-sm text-foreground placeholder:text-muted-foreground/60 transition-all"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword(!showPassword)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors focus:outline-none"
                    aria-label={showPassword ? "Hide password" : "Show password"}
                  >
                    {showPassword ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                  </button>
                </div>
              </div>
              <button
                type="submit"
                disabled={isPending}
                className="w-full bg-brand hover:bg-brand-dark text-brand-foreground py-3 rounded-xl font-bold transition-colors shadow-brand disabled:opacity-60"
              >
                {isPending ? "Please wait..." : isSignup ? "Create Account" : "Login"}
              </button>
            </form>

            <p className="mt-6 text-sm text-muted-foreground text-center">
              {isSignup ? (
                <>
                  Already have an account?{" "}
                  <Link to="/login" className="text-foreground font-medium hover:text-brand">
                    Login
                  </Link>
                </>
              ) : (
                <>
                  No account?{" "}
                  <Link to="/signup" className="text-foreground font-medium hover:text-brand">
                    Start free
                  </Link>
                </>
              )}
            </p>
            </>
            )}
          </div>
        </div>
        <p className="text-xs text-muted-foreground">
          By continuing, you agree to Mast's Terms and acknowledge our Privacy Policy.
        </p>
      </div>

      {/* Right: brand panel */}
      <div className="hidden lg:flex relative bg-card border-l border-border items-center justify-center p-12 overflow-hidden">
        <div
          className="pointer-events-none absolute inset-0 opacity-60"
          style={{ background: "radial-gradient(ellipse at 30% 20%, color-mix(in oklab, var(--brand) 35%, transparent), transparent 60%)" }}
        />
        <div className="pointer-events-none absolute inset-0 bg-grid opacity-[0.2]" />
        <div className="relative max-w-md">
          <div className="inline-flex px-3 py-1 rounded-full bg-brand/10 border border-brand/25 text-brand text-[11px] font-bold uppercase tracking-wider">
            Trusted by 4,200+ teams
          </div>
          <h2 className="mt-6 text-4xl font-bold tracking-tight leading-tight">
            Sales-ready leads. Every channel. One platform.
          </h2>
          <p className="mt-5 text-muted-foreground leading-relaxed">
            Verified emails, mobile numbers, websites, and Instagram profiles — enriched, scored, and pushed into a pipeline built for outreach.
          </p>
          <div className="mt-10 bg-background border border-border rounded-2xl p-6">
            <p className="text-sm text-foreground leading-relaxed">
              "Mast replaced three tools. Our pipeline doubled in 6 weeks."
            </p>
            <p className="mt-4 text-xs text-muted-foreground">— Maya Chen, Founder · Northwind</p>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Verify-email waiting screen ─────────────────────────────────────────────
// Shown on the laptop/desktop after signup when email confirmation is required.
//
// Why we poll signInWithPassword instead of using Realtime broadcast:
// Supabase's client API has no public "has this email been confirmed yet?"
// check — reading another session's confirmation state isn't something RLS
// allows, and the admin/service-role key that *can* see it must never reach
// the browser. The one thing this screen CAN safely ask Supabase, repeatedly,
// is "let me sign in" — and Supabase Auth already distinguishes the two
// outcomes for an unconfirmed account:
//   • not yet confirmed → signInWithPassword fails with code "email_not_confirmed"
//   • confirmed         → signInWithPassword succeeds and returns a real session
// So we poll signInWithPassword with the same credentials the user just typed
// into the signup form. The call that detects verification IS the sign-in —
// there's no separate channel, no broadcast, nothing for the phone to talk to.
// Supabase Auth itself is the single source of truth, end to end.
function VerifyEmailWaiting({
  email,
  password,
  onResend,
  onVerified,
}: {
  email: string;
  password: string;
  onResend: () => void;
  onVerified: () => void;
}) {
  const [status, setStatus] = useState<"waiting" | "verified" | "timedout">("waiting");

  useEffect(() => {
    if (!supabase || !email || !password) return;

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const POLL_INTERVAL_MS = 4_000;
    const GIVE_UP_AFTER_MS = 15 * 60 * 1000; // 15 minutes
    const startedAt = Date.now();

    const attempt = async () => {
      if (cancelled) return;

      // Skip the network call while the tab is backgrounded. The timer below
      // keeps running regardless, so polling resumes the moment it's visible
      // again — no missed window, no extra requests while the tab is idle.
      if (document.visibilityState === "visible") {
        const { data, error } = await supabase!.auth.signInWithPassword({ email, password });
        if (cancelled) return;

        if (data?.session) {
          // Verified — Supabase just signed this device in for real.
          setStatus("verified");
          setTimeout(() => {
            if (!cancelled) onVerified();
          }, 1200);
          return;
        }

        // "email_not_confirmed" is the expected response until the link is
        // clicked. Anything else (a network blip, etc.) is logged but treated
        // the same way — keep waiting rather than ending the flow on a fluke.
        if (error && error.code !== "email_not_confirmed") {
          console.warn("[Mast:verify-poll] sign-in attempt did not succeed yet:", error.message);
        }
      }

      if (Date.now() - startedAt >= GIVE_UP_AFTER_MS) {
        setStatus("timedout");
        return;
      }

      timer = setTimeout(() => void attempt(), POLL_INTERVAL_MS);
    };

    void attempt();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [email, password, onVerified]);

  if (status === "verified") {
    return (
      <div className="text-center">
        <div className="mx-auto size-12 rounded-2xl bg-emerald-500/10 border border-emerald-500/20 grid place-items-center">
          <svg className="size-6 text-emerald-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
          </svg>
        </div>
        <h1 className="mt-6 text-2xl font-bold tracking-tight">Email verified!</h1>
        <p className="mt-3 text-sm text-muted-foreground">Taking you to your dashboard…</p>
      </div>
    );
  }

  if (status === "timedout") {
    return (
      <div className="text-center">
        <div className="mx-auto size-12 rounded-2xl bg-card border border-border grid place-items-center">
          <svg className="size-6 text-muted-foreground" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6l4 2m6-2a10 10 0 1 1-20 0 10 10 0 0 1 20 0Z" />
          </svg>
        </div>
        <h1 className="mt-6 text-2xl font-bold tracking-tight">Still waiting</h1>
        <p className="mt-3 text-sm text-muted-foreground leading-relaxed">
          We haven't detected verification yet. Once you've clicked the link in your
          email, just log in below.
        </p>
        <Link
          to="/login"
          className="mt-5 inline-block bg-brand hover:bg-brand-dark text-brand-foreground px-5 py-2.5 rounded-xl font-bold text-sm transition-colors"
        >
          Go to login
        </Link>
      </div>
    );
  }

  return (
    <div className="text-center">
      <div className="mx-auto size-12 rounded-2xl bg-brand/10 border border-brand/20 grid place-items-center">
        <svg className="size-6 text-brand" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M21.75 6.75v10.5a2.25 2.25 0 0 1-2.25 2.25h-15a2.25 2.25 0 0 1-2.25-2.25V6.75m19.5 0A2.25 2.25 0 0 0 19.5 4.5h-15a2.25 2.25 0 0 0-2.25 2.25m19.5 0v.243a2.25 2.25 0 0 1-1.07 1.916l-7.5 4.615a2.25 2.25 0 0 1-2.36 0L3.32 8.91a2.25 2.25 0 0 1-1.07-1.916V6.75" />
        </svg>
      </div>
      <h1 className="mt-6 text-2xl font-bold tracking-tight">Check your inbox</h1>
      <p className="mt-3 text-sm text-muted-foreground leading-relaxed">
        We sent a verification link to{" "}
        <span className="font-medium text-foreground">{email}</span>.{" "}
        Open it on any device to activate your account.
      </p>

      {/* Waiting indicator — this device polls in the background until verified */}
      <div className="mt-5 flex items-center justify-center gap-2 text-xs text-muted-foreground">
        <span className="relative flex size-2">
          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-brand opacity-75" />
          <span className="relative inline-flex rounded-full size-2 bg-brand/60" />
        </span>
        Waiting for verification…
      </div>

      <p className="mt-5 text-xs text-muted-foreground">
        Didn't get it? Check your spam folder or{" "}
        <button
          type="button"
          className="text-brand hover:text-brand-dark font-medium underline underline-offset-2"
          onClick={onResend}
        >
          try again
        </button>
        .
      </p>
    </div>
  );
}

function Input({
  label,
  type,
  placeholder,
  value,
  onChange,
  autoComplete,
}: {
  label: string;
  type: string;
  placeholder: string;
  value: string;
  onChange: (event: React.ChangeEvent<HTMLInputElement>) => void;
  autoComplete?: string;
}) {
  return (
    <label className="block">
      <span className="block text-xs font-semibold text-muted-foreground mb-1.5">{label}</span>
      <input
        type={type}
        placeholder={placeholder}
        value={value}
        onChange={onChange}
        autoComplete={autoComplete}
        className="w-full bg-card border border-border focus:border-brand focus:ring-2 focus:ring-brand/20 outline-none px-3.5 py-2.5 rounded-lg text-sm text-foreground placeholder:text-muted-foreground/60 transition-all"
      />
    </label>
  );
}

function GoogleIcon() {
  return (
    <svg className="size-4" viewBox="0 0 48 48">
      <path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3c-1.6 4.7-6.1 8-11.3 8-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.9 1.2 8 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.2-.1-2.3-.4-3.5z" />
      <path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 16.1 19 13 24 13c3.1 0 5.9 1.2 8 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z" />
      <path fill="#4CAF50" d="M24 44c5.2 0 9.8-2 13.3-5.2l-6.2-5.2C29.1 35 26.7 36 24 36c-5.2 0-9.6-3.3-11.2-8l-6.5 5C9.6 39.6 16.2 44 24 44z" />
      <path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.1 4-3.9 5.3l6.2 5.2C41 35 44 30 44 24c0-1.2-.1-2.3-.4-3.5z" />
    </svg>
  );
}
