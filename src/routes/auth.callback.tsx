import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";

export const Route = createFileRoute("/auth/callback")({
  head: () => ({
    meta: [{ title: "Completing Sign In... — Mast" }],
  }),
  component: AuthCallbackPage,
});

// ─── What this page handles ───────────────────────────────────────────────────
//
// This route is the single landing point for all Supabase auth redirects:
//
//  1. Google OAuth (popup)    — window.opener present → postMessage → close popup
//  2. Google OAuth (redirect) — no opener → navigate to /dashboard
//  3. Password reset          — event === PASSWORD_RECOVERY → /reset-password
//  4. Email confirmation      — token_hash + type=signup in URL (cross-device flow)
//                               → manually verify OTP → sign out → show success page
//
// ── Why we must call verifyOtp() manually for email confirmation ──────────────
//
// Supabase JS auto-detects two callback URL types:
//   PKCE:     ?code=XXX  AND  localStorage has a code-verifier
//   Implicit: #access_token=XXX
//
// Email confirmation links from Supabase use a third format:
//   ?token_hash=XXX&type=signup
//
// When the user opens the link on a DIFFERENT device (phone), localStorage has
// no code-verifier. Supabase JS sees neither a PKCE nor an implicit callback and
// does nothing — getSession() returns null, onAuthStateChange never fires.
//
// The fix: detect token_hash in the URL and call verifyOtp() explicitly.
// This exchanges the hash for a session, then onAuthStateChange fires SIGNED_IN.
//
// ── What happens after verification ────────────────────────────────────────────
//
// This device (the phone) is signed out immediately and shown a static
// "you're verified" page — nothing more. It has no idea whether another
// device is waiting, and it doesn't need to: the laptop's /login waiting
// screen independently polls Supabase Auth (signInWithPassword) and detects
// the now-confirmed account on its own. No channel, no broadcast, no
// coordination between devices is required.

type CallbackView = "processing" | "email-verified" | "error";

function AuthCallbackPage() {
  const navigate = useNavigate();
  const [view, setView] = useState<CallbackView>("processing");

  useEffect(() => {
    if (!supabase) {
      void navigate({ to: "/login", replace: true });
      return;
    }

    // Read URL parameters from both query string and hash.
    // Supabase sends confirmation URLs as:
    //   ?token_hash=XXX&type=signup         (cross-device email confirmation)
    //   ?code=XXX                           (PKCE OAuth / same-device flow)
    //   #access_token=XXX&type=signup       (legacy implicit flow)
    const searchParams = new URLSearchParams(window.location.search);
    const hashParams = new URLSearchParams(window.location.hash.slice(1));

    const tokenHash = searchParams.get("token_hash") ?? hashParams.get("token_hash") ?? "";
    const linkType = searchParams.get("type") ?? hashParams.get("type") ?? "";
    const isEmailConfirmation = linkType === "signup";

    // ── Bug-fix 3 guard: once handleSession decides this is an email confirmation,
    // we must NOT let the SIGNED_OUT event (fired after we call signOut on the phone)
    // navigate away from the verified page.
    let intentionalSignOut = false;

    let subscription: { unsubscribe: () => void } | null = null;

    const { data } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === "PASSWORD_RECOVERY") {
        void navigate({ to: "/reset-password", replace: true });
        return;
      }

      if (session) {
        void handleSession(session.user.id, isEmailConfirmation);
        return;
      }

      if (event === "SIGNED_OUT" && !intentionalSignOut) {
        // Only navigate to login for genuine sign-outs, not our own signOut() call.
        void navigate({ to: "/login", replace: true });
      }
    });
    subscription = data.subscription;

    // ── Bug-fix 1 & 2: If there is a token_hash in the URL, Supabase JS will NOT
    // auto-exchange it on a device without a code-verifier. Call verifyOtp() ourselves.
    // This fires onAuthStateChange(SIGNED_IN) which then calls handleSession().
    if (tokenHash && isEmailConfirmation) {
      supabase.auth
        .verifyOtp({ token_hash: tokenHash, type: "email" })
        .then(({ error }) => {
          if (error) {
            // Token expired, already used, or invalid.
            console.error("[Mast:callback] verifyOtp error:", error.message);
            setView("error");
          }
          // On success: onAuthStateChange fires SIGNED_IN → handleSession() runs.
          // Clear the safety timeout so a slow verifyOtp can't race against it.
          clearTimeout(timeout);
        })
        .catch(() => setView("error"));
    } else {
      // Non-token_hash flow (OAuth PKCE or implicit): Supabase JS handles it
      // automatically via getSession() in initialization. Check eagerly too.
      supabase.auth.getSession().then(({ data: { session } }) => {
        if (session) void handleSession(session.user.id, isEmailConfirmation);
      });
    }

    // Safety timeout — if nothing resolves in 10s show an error.
    const timeout = setTimeout(() => setView("error"), 10_000);

    return () => {
      subscription?.unsubscribe();
      clearTimeout(timeout);
    };

    // ── Inner helper ──────────────────────────────────────────────────────────
    async function handleSession(userId: string, emailConfirmation: boolean) {
      if (emailConfirmation) {
        // This device (the phone) has nothing further to do. Sign it out —
        // set the flag BEFORE calling signOut so the SIGNED_OUT listener
        // above does not navigate this tab to /login — then show the static
        // success page. The laptop detects verification on its own by
        // polling Supabase Auth directly; see the comment block above.
        intentionalSignOut = true;
        await supabase!.auth.signOut({ scope: "local" });

        setView("email-verified");
        return;
      }

      // OAuth and other redirect flows.
      if (window.opener) {
        window.opener.postMessage({ type: "AUTH_SUCCESS" }, window.location.origin);
        window.close();
      } else {
        void navigate({ to: "/dashboard", replace: true });
      }
    }
  }, [navigate]);

  // ── Render ──────────────────────────────────────────────────────────────────

  if (view === "email-verified") {
    return <EmailVerifiedPage />;
  }

  if (view === "error") {
    return (
      <div className="min-h-screen bg-[oklch(0.12_0.02_260)] text-foreground grid place-items-center px-4">
        <div className="flex flex-col items-center gap-4 text-center max-w-sm">
          <div className="size-12 rounded-2xl bg-destructive/10 border border-destructive/20 grid place-items-center">
            <svg className="size-6 text-destructive" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126ZM12 15.75h.007v.008H12v-.008Z" />
            </svg>
          </div>
          <h1 className="text-xl font-bold">Link expired</h1>
          <p className="text-sm text-muted-foreground">
            This link has expired or has already been used. Please request a new one.
          </p>
          <a href="/login" className="mt-2 text-sm font-semibold text-brand hover:text-brand-dark">
            Back to login →
          </a>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[oklch(0.12_0.02_260)] text-foreground grid place-items-center">
      <div className="flex flex-col items-center gap-4">
        <div className="size-8 rounded-full border-2 border-white/15 border-t-white/70 animate-spin" />
        <div className="text-sm font-semibold tracking-wide text-muted-foreground/80">
          Verifying…
        </div>
      </div>
    </div>
  );
}

// ─── Email verified success page ──────────────────────────────────────────────
// Shown on the device that clicked the confirmation link (phone). Deliberately
// bare: no logo, no header/nav, no other links — this is a dead-end status
// message, not a page into the rest of the site. The user is signed out on
// this device; they continue on their laptop, which detected verification on
// its own (see the comment block at the top of this file).
function EmailVerifiedPage() {
  return (
    <div className="min-h-screen bg-[oklch(0.12_0.02_260)] text-foreground grid place-items-center px-4">
      <div className="flex flex-col items-center text-center max-w-sm gap-0">
        <div className="relative">
          <div className="absolute inset-0 bg-emerald-500/20 rounded-full blur-2xl scale-150" />
          <div className="relative size-16 rounded-full bg-emerald-500/10 border border-emerald-500/20 grid place-items-center">
            <svg
              className="size-8 text-emerald-400"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
            </svg>
          </div>
        </div>

        <h1 className="mt-6 text-xl font-bold tracking-tight">Verification Completed</h1>

        <p className="mt-2 text-sm text-muted-foreground leading-relaxed">
          You may now go back to your computer.
        </p>
      </div>
    </div>
  );
}
