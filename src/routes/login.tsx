import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Logo } from "@/components/mast/Logo";
import { ApiError } from "@/lib/api";
import { useGoogleLogin, useLogin, useMe, useSignup } from "@/hooks/use-mast-api";

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
  const { data: auth, isLoading: authLoading } = useMe();
  const loginMutation = useLogin();
  const signupMutation = useSignup();
  const googleLogin = useGoogleLogin();
  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const isPending = loginMutation.isPending || signupMutation.isPending;

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const authError = params.get("error");
    if (!authError) return;
    setError(decodeURIComponent(authError));
    window.history.replaceState({}, "", window.location.pathname);
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
        await signupMutation.mutateAsync({ fullName, email, password });
        toast.success("Account created");
      } else {
        await loginMutation.mutateAsync({ email, password });
        toast.success("Welcome back");
      }
      await navigate({ to: "/dashboard" });
    } catch (err) {
      const message = err instanceof ApiError ? err.message : "Could not complete authentication.";
      setError(message);
    }
  };

  const startGoogle = async () => {
    setError("");
    try {
      await googleLogin.mutateAsync();
    } catch (err) {
      const message = err instanceof ApiError ? err.message : "Google login is not configured yet.";
      setError(message);
    }
  };

  return (
    <div className="min-h-screen grid lg:grid-cols-2">
      {/* Left: form */}
      <div className="flex flex-col px-6 py-10 lg:px-16">
        <Logo />
        <div className="flex-1 flex items-center">
          <div className="w-full max-w-sm mx-auto">
            <h1 className="text-3xl font-bold tracking-tight">
              {isSignup ? "Create your account" : "Welcome back"}
            </h1>
            <p className="mt-2 text-sm text-muted-foreground">
              {isSignup ? "Start your free trial. 100 free credits on us." : "Login to your Mast dashboard."}
            </p>

            {error && (
              <div className="mt-6 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                {error}
              </div>
            )}

            <button
              type="button"
              onClick={startGoogle}
              disabled={googleLogin.isPending || authLoading}
              className="mt-8 w-full bg-card border border-border hover:border-muted-foreground/40 py-3 rounded-xl font-medium flex items-center justify-center gap-3 transition-colors disabled:opacity-60"
            >
              <GoogleIcon />
              {googleLogin.isPending ? "Connecting..." : "Continue with Google"}
            </button>

            <div className="my-6 flex items-center gap-3">
              <div className="flex-1 h-px bg-border" />
              <span className="text-[11px] uppercase tracking-widest text-muted-foreground">or</span>
              <div className="flex-1 h-px bg-border" />
            </div>

            <form className="space-y-4" onSubmit={submit}>
              {isSignup && (
                <Input
                  label="Full name"
                  type="text"
                  placeholder="Jane Doe"
                  value={fullName}
                  onChange={(event) => setFullName(event.target.value)}
                  autoComplete="name"
                />
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
                <input
                  type="password"
                  placeholder="••••••••"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  autoComplete={isSignup ? "new-password" : "current-password"}
                  className="w-full bg-card border border-border focus:border-brand focus:ring-2 focus:ring-brand/20 outline-none px-3.5 py-2.5 rounded-lg text-sm text-foreground placeholder:text-muted-foreground/60 transition-all"
                />
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
            Verified emails, mobile numbers, websites, and Instagram profiles — enriched, scored, and pushed into a CRM built for outreach.
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
