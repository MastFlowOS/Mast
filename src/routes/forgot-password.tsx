import { createFileRoute, Link } from "@tanstack/react-router";
import { Logo } from "@/components/mast/Logo";
import { useState } from "react";
import { ArrowLeft, Mail } from "lucide-react";
import { supabase } from "@/lib/supabase";

export const Route = createFileRoute("/forgot-password")({
  head: () => ({
    meta: [
      { title: "Forgot password — Mast" },
      { name: "description", content: "Reset your Mast account password." },
    ],
  }),
  component: ForgotPasswordPage,
});

function ForgotPasswordPage() {
  const [sent, setSent] = useState(false);
  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  return (
    <div className="min-h-screen flex flex-col px-6 py-10 lg:px-16 bg-background text-foreground">
      <Logo />
      <div className="flex-1 flex items-center">
        <div className="w-full max-w-sm mx-auto">
          <Link
            to="/login"
            className="inline-flex items-center gap-1.5 text-xs font-semibold text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft className="size-4" /> Back to login
          </Link>

          {!sent ? (
            <>
              <h1 className="mt-6 text-3xl font-bold tracking-tight">Reset your password</h1>
              <p className="mt-2 text-sm text-muted-foreground">
                Enter the email on your Mast account. We'll send you a secure link to reset your password.
              </p>

              <form
                className="mt-8 space-y-4"
                onSubmit={async (e) => {
                  e.preventDefault();

                  setLoading(true);
                  setError("");

                  try {
                    if (!supabase) throw new Error("Supabase is not configured.");

                    // ─── Diagnostic logging ──────────────────────────────────
                    console.log("[Mast:forgot-password] resetPasswordForEmail → request started", {
                      email,
                      redirectTo: `${window.location.origin}/reset-password`,
                    });

                    const { error: resetErr } = await supabase.auth.resetPasswordForEmail(email, {
                      redirectTo: `${window.location.origin}/reset-password`,
                    });

                    if (resetErr) {
                      console.error("[Mast:forgot-password] resetPasswordForEmail → error", {
                        message: resetErr.message,
                        status: resetErr.status,
                        code: (resetErr as any).code ?? "n/a",
                      });
                      throw resetErr;
                    }

                    console.log("[Mast:forgot-password] resetPasswordForEmail → success (email dispatched)");
                    // ─────────────────────────────────────────────────────────

                    setSent(true);
                  } catch (err) {
                    setError(
                      err instanceof Error
                        ? err.message
                        : "Failed to send reset email"
                    );
                  } finally {
                    setLoading(false);
                  }
                }}
              >
                <label className="block">
  <span className="block text-xs font-semibold text-muted-foreground mb-1.5">
    Email
  </span>

  <input
    type="email"
    required
    value={email}
    onChange={(e) => setEmail(e.target.value)}
    placeholder="you@agency.com"
    className="w-full bg-card border border-border focus:border-brand focus:ring-2 focus:ring-brand/20 outline-none px-3.5 py-2.5 rounded-lg text-sm"
  />
</label>

{error && (
  <p className="text-sm text-red-500">
    {error}
  </p>
)}

<button
  type="submit"
  disabled={loading}
  className="w-full bg-brand hover:bg-brand-dark text-brand-foreground py-3 rounded-xl font-bold shadow-brand"
>
  {loading ? "Sending..." : "Send reset link"}
</button>
              </form>
            </>
          ) : (
            <div className="mt-8 bg-card border border-border rounded-2xl p-6 text-center">
              <div className="mx-auto size-10 rounded-xl bg-brand/10 border border-brand/20 grid place-items-center">
                <Mail className="size-5 text-brand" />
              </div>
              <h2 className="mt-4 font-bold">Check your inbox</h2>
              <p className="mt-2 text-sm text-muted-foreground">
                If an account exists for that email, you'll get a password reset link within a minute.
              </p>
              <Link
                to="/login"
                className="mt-6 inline-block text-xs font-semibold text-brand hover:text-brand-dark"
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
