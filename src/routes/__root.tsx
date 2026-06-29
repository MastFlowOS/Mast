import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  Outlet,
  Link,
  createRootRouteWithContext,
  useRouter,
  HeadContent,
} from "@tanstack/react-router";
import { Toaster } from "@/components/ui/sonner";
import { useEffect, useState } from "react";
import { supabase, supabaseConfigError } from "@/lib/supabase";
import { BrandMark } from "@/components/mast/BrandMark";

// ─── Config-error screen (inline styles — renders even without Tailwind) ──────
function SupabaseConfigError({ message }: { message: string }) {
  return (
    <div
      style={{
        minHeight: "100vh",
        background: "oklch(0.12 0.02 260)",
        color: "#f8fafc",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontFamily: "system-ui, -apple-system, sans-serif",
        padding: "2rem",
      }}
    >
      <div style={{ maxWidth: 540, textAlign: "center" }}>
        {/* Red warning icon */}
        <div
          style={{
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            width: 64,
            height: 64,
            borderRadius: "50%",
            background: "rgba(239,68,68,0.15)",
            marginBottom: "1.5rem",
          }}
        >
          <svg
            width="32"
            height="32"
            viewBox="0 0 24 24"
            fill="none"
            stroke="#ef4444"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <circle cx="12" cy="12" r="10" />
            <line x1="12" y1="8" x2="12" y2="12" />
            <line x1="12" y1="16" x2="12.01" y2="16" />
          </svg>
        </div>

        <h1
          style={{
            fontSize: "1.4rem",
            fontWeight: 700,
            color: "#f8fafc",
            marginBottom: "0.75rem",
          }}
        >
          Supabase Not Configured
        </h1>

        <p style={{ fontSize: "0.9rem", color: "#94a3b8", lineHeight: 1.7, marginBottom: "1.5rem" }}>
          The application could not connect to Supabase because the required
          environment variables are missing from this build.
        </p>

        {/* Error detail */}
        <div
          style={{
            background: "rgba(239,68,68,0.08)",
            border: "1px solid rgba(239,68,68,0.25)",
            borderRadius: 8,
            padding: "1rem 1.25rem",
            textAlign: "left",
            marginBottom: "1.5rem",
          }}
        >
          <p
            style={{
              fontSize: "0.78rem",
              fontFamily: "ui-monospace, monospace",
              color: "#fca5a5",
              margin: 0,
              lineHeight: 1.7,
              wordBreak: "break-word",
            }}
          >
            {message}
          </p>
        </div>

        {/* Fix instructions */}
        <div
          style={{
            background: "rgba(255,255,255,0.04)",
            border: "1px solid rgba(255,255,255,0.08)",
            borderRadius: 8,
            padding: "1rem 1.25rem",
            textAlign: "left",
          }}
        >
          <p
            style={{
              fontSize: "0.82rem",
              fontWeight: 600,
              color: "#e2e8f0",
              marginBottom: "0.5rem",
            }}
          >
            How to fix:
          </p>
          <ol
            style={{
              fontSize: "0.82rem",
              color: "#94a3b8",
              lineHeight: 2,
              paddingLeft: "1.25rem",
              margin: 0,
            }}
          >
            <li>
              Go to your{" "}
              <strong style={{ color: "#e2e8f0" }}>Netlify dashboard</strong>
            </li>
            <li>
              Open{" "}
              <strong style={{ color: "#e2e8f0" }}>
                Site Settings → Environment Variables
              </strong>
            </li>
            <li>
              Add{" "}
              <code style={{ color: "#7dd3fc", background: "rgba(125,211,252,0.1)", padding: "1px 5px", borderRadius: 3 }}>
                VITE_SUPABASE_URL
              </code>{" "}
              and{" "}
              <code style={{ color: "#7dd3fc", background: "rgba(125,211,252,0.1)", padding: "1px 5px", borderRadius: 3 }}>
                VITE_SUPABASE_ANON_KEY
              </code>
            </li>
            <li>
              Trigger a{" "}
              <strong style={{ color: "#e2e8f0" }}>new deploy</strong> (Deploys
              → Trigger deploy)
            </li>
          </ol>
          <p
            style={{
              fontSize: "0.75rem",
              color: "#64748b",
              marginTop: "0.75rem",
              marginBottom: 0,
            }}
          >
            ⚠️ Do not add these variables to{" "}
            <code style={{ fontSize: "0.75rem" }}>netlify.toml</code> —
            values there override the Netlify dashboard.
          </p>
        </div>
      </div>
    </div>
  );
}

// ─── 404 ──────────────────────────────────────────────────────────────────────
function NotFoundComponent() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="max-w-md text-center">
        <h1 className="text-7xl font-bold text-foreground">404</h1>
        <h2 className="mt-4 text-xl font-semibold text-foreground">
          Page not found
        </h2>
        <p className="mt-2 text-sm text-muted-foreground">
          The page you're looking for doesn't exist or has been moved.
        </p>
        <div className="mt-6">
          <Link
            to="/"
            className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            Go home
          </Link>
        </div>
      </div>
    </div>
  );
}

// ─── Route error boundary ─────────────────────────────────────────────────────
function ErrorComponent({ error, reset }: { error: Error; reset: () => void }) {
  console.error(error);
  const router = useRouter();

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="max-w-md text-center">
        <h1 className="text-xl font-semibold tracking-tight text-foreground">
          This page didn't load
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Something went wrong on our end. You can try refreshing or head back
          home.
        </p>
        <div className="mt-6 flex flex-wrap justify-center gap-2">
          <button
            onClick={() => {
              router.invalidate();
              reset();
            }}
            className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            Try again
          </button>
          <a
            href="/"
            className="inline-flex items-center justify-center rounded-md border border-input bg-background px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-accent"
          >
            Go home
          </a>
        </div>
      </div>
    </div>
  );
}

// ─── Route definition ─────────────────────────────────────────────────────────
export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "Mast — AI Sales Operating System" },
      {
        name: "description",
        content:
          "Mast is a premium AI Sales Operating System for agencies and businesses focused on opportunity discovery, pipeline movement, and client acquisition.",
      },
      { name: "author", content: "Mast" },
      { property: "og:title", content: "Mast — AI Sales Operating System" },
      {
        property: "og:description",
        content:
          "Mast is a premium AI Sales Operating System for agencies and businesses focused on opportunity discovery, pipeline movement, and client acquisition.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
      { name: "twitter:title", content: "Mast — AI Sales Operating System" },
      {
        name: "twitter:description",
        content:
          "Mast is a premium AI Sales Operating System for agencies and businesses focused on opportunity discovery, pipeline movement, and client acquisition.",
      },
      {
        property: "og:image",
        content:
          "https://pub-bb2e103a32db4e198524a2e9ed8f35b4.r2.dev/729aeb81-f0bc-46d5-9d43-7894b201b768/id-preview-8f088e31--807813bd-5dd7-4fdf-94e5-70cfc4cf574b.lovable.app-1778970563271.png",
      },
      {
        name: "twitter:image",
        content:
          "https://pub-bb2e103a32db4e198524a2e9ed8f35b4.r2.dev/729aeb81-f0bc-46d5-9d43-7894b201b768/id-preview-8f088e31--807813bd-5dd7-4fdf-94e5-70cfc4cf574b.lovable.app-1778970563271.png",
      },
    ],
    links: [
      { rel: "icon", type: "image/png", href: "/favicon.png" },
      { rel: "apple-touch-icon", href: "/favicon.png" },
    ],
  }),
  component: RootComponent,
  notFoundComponent: NotFoundComponent,
  errorComponent: ErrorComponent,
});

// ─── Timeout helper ───────────────────────────────────────────────────────────
function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms)),
  ]);
}

// ─── Root component ───────────────────────────────────────────────────────────
function RootComponent() {
  const { queryClient } = Route.useRouteContext();

  // If credentials are missing, show the config error screen immediately.
  // This renders using inline styles so it works even if Tailwind fails.
  if (supabaseConfigError) {
    return <SupabaseConfigError message={supabaseConfigError} />;
  }

  return (
    <QueryClientProvider client={queryClient}>
      <HeadContent />
      <AuthGate queryClient={queryClient} />
    </QueryClientProvider>
  );
}

// ─── Auth gate (only rendered when Supabase is correctly configured) ──────────
function AuthGate({ queryClient }: { queryClient: QueryClient }) {
  const [initializing, setInitializing] = useState(true);

  useEffect(() => {
    // supabase is guaranteed non-null here (supabaseConfigError is null)
    const client = supabase!;
    let cancelled = false;

    // Check initial session with a 5-second safety timeout so we never hang
    withTimeout(
      client.auth.getSession(),
      5000,
      { data: { session: null }, error: null } as Awaited<
        ReturnType<typeof client.auth.getSession>
      >
    )
      .catch(() => ({ data: { session: null }, error: null }))
      .finally(() => {
        if (!cancelled) setInitializing(false);
      });

    // Listen to subsequent auth state changes
    let subscription: { unsubscribe: () => void } | null = null;
    try {
      const { data } = client.auth.onAuthStateChange(() => {
        queryClient.invalidateQueries({ queryKey: ["mast"] });
        if (!cancelled) setInitializing(false);
      });
      subscription = data.subscription;
    } catch (err) {
      console.warn("[Supabase] onAuthStateChange failed:", err);
      if (!cancelled) setInitializing(false);
    }

    return () => {
      cancelled = true;
      subscription?.unsubscribe();
    };
  }, [queryClient]);

  if (initializing) {
    return (
      <div className="min-h-screen bg-[oklch(0.12_0.02_260)] text-foreground grid place-items-center">
        <div className="flex flex-col items-center gap-4">
          <div className="relative size-14 grid place-items-center">
            <div className="absolute inset-0 bg-brand/20 rounded-full blur-xl animate-pulse" />
            <BrandMark size={48} className="relative z-10 animate-pulse text-brand" />
          </div>
          <div className="text-sm font-semibold tracking-wide text-muted-foreground/80 animate-pulse">
            Checking Session...
          </div>
        </div>
      </div>
    );
  }

  return (
    <>
      <Outlet />
      <Toaster richColors position="top-right" />
    </>
  );
}
