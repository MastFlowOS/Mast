import { Link, useRouterState, useNavigate } from "@tanstack/react-router";
import { Logo } from "./Logo";
import { useState, useEffect, useCallback } from "react";
import { Crosshair, Menu, X } from "lucide-react";
import { useMe, useLogout } from "@/hooks/use-mast-api";

// Configurable anchor targets — always resolve to the home page sections
const ANCHOR_LINKS: Record<string, string> = {
  Solutions: "/#solutions",
  Customers: "/#testimonials",
};

const links = [
  { label: "Features", to: "/" },
  { label: "Pricing", to: "/pricing" },
  { label: "Solutions", anchor: "#solutions" },
  { label: "Customers", anchor: "#testimonials" },
];

type SiteNavProps = {
  /**
   * Experimental flag — when true, replaces `backdrop-blur-*` with a
   * near-opaque solid background instead. Used only by the landing page
   * ("/") to test whether `backdrop-filter` is the cause of icons
   * intermittently failing to paint at non-100% browser zoom.
   * Defaults to false everywhere else (pricing, terms, privacy, refunds,
   * security, status) so their rendering is completely unchanged.
   */
  disableBackdropBlur?: boolean;
};

export function SiteNav({ disableBackdropBlur = false }: SiteNavProps = {}) {
  const [scrolled, setScrolled] = useState(false);
  const [sheenOffset, setSheenOffset] = useState(0);
  const [mobileOpen, setMobileOpen] = useState(false);
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const navigate = useNavigate();

  // Auth state — read from React Query cache (populated by /api/me on app init)
  const { data: auth, isLoading: authLoading } = useMe();
  const user = auth?.user ?? null;
  const logout = useLogout();

  useEffect(() => {
    let ticking = false;
    const handler = () => {
      setScrolled(window.scrollY > 12);
      if (!ticking) {
        ticking = true;
        requestAnimationFrame(() => {
          // Slow, subtle gold sheen that drifts across the header as you
          // scroll — gives the bar a sense of moving with the page instead
          // of sitting as a static, flat-colored strip.
          setSheenOffset(window.scrollY * 0.25);
          ticking = false;
        });
      }
    };
    window.addEventListener("scroll", handler, { passive: true });
    return () => window.removeEventListener("scroll", handler);
  }, []);

  /**
   * Navigate to /#hash always — never /pricing#solutions etc.
   * If already on "/", just scroll. If on another page, navigate first.
   */
  const handleAnchorClick = useCallback(
    (e: React.MouseEvent<HTMLAnchorElement>, hash: string) => {
      e.preventDefault();
      setMobileOpen(false);

      const scrollToHash = () => {
        const id = hash.replace("#", "");
        const el = document.getElementById(id);
        if (el) {
          el.scrollIntoView({ behavior: "smooth", block: "start" });
        } else {
          // Fallback: set location hash
          window.location.hash = hash;
        }
      };

      if (pathname === "/") {
        scrollToHash();
      } else {
        // Navigate to home, then scroll after paint
        navigate({ to: "/" }).then(() => {
          // Give React time to render the landing sections
          requestAnimationFrame(() => {
            setTimeout(scrollToHash, 100);
          });
        });
      }
    },
    [pathname, navigate],
  );

  const handleLogout = async () => {
    await logout.mutateAsync();
    await navigate({ to: "/login" });
  };

  return (
    <nav
      className={`sticky top-0 z-50 transition-all duration-300 overflow-hidden ${
        disableBackdropBlur
          ? scrolled
            ? "border-b border-brand/20 shadow-[0_4px_30px_rgba(201,166,107,0.05)] bg-[#02040c]/85"
            : "border-b border-transparent bg-transparent"
          : scrolled
            ? "border-b border-brand/20 bg-background/80 backdrop-blur-md shadow-[0_4px_30px_rgba(201,166,107,0.05)]"
            : "border-b border-transparent bg-transparent backdrop-blur-none"
      }`}
    >
      {disableBackdropBlur && scrolled && (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 opacity-90"
          style={{
            backgroundImage:
              "linear-gradient(115deg, transparent 15%, color-mix(in oklab, var(--brand, #c9a66b) 16%, transparent) 48%, transparent 82%)",
            backgroundSize: "220% 100%",
            backgroundPositionX: `${-sheenOffset}px`,
          }}
        />
      )}
      <div className="relative max-w-7xl mx-auto px-6 h-16 flex items-center justify-between">
        {/* Left: logo + links */}
        <div className="flex items-center gap-10">
          <Logo />
          <div className="hidden md:flex items-center gap-1">
            {links.map((l) =>
              l.anchor ? (
                // Anchor link — always navigates to /#hash
                <a
                  key={l.label}
                  href={`/${l.anchor}`}
                  onClick={(e) => handleAnchorClick(e, l.anchor!)}
                  className="relative px-3 py-2 text-sm font-medium text-muted-foreground hover:text-brand transition-colors duration-150 rounded-lg hover:bg-brand/5 group"
                >
                  {l.label}
                </a>
              ) : (
                <Link
                  key={l.label}
                  to={l.to as "/"}
                  className={`relative px-3 py-2 text-sm font-medium transition-colors duration-150 rounded-lg hover:bg-brand/5 group ${
                    pathname === l.to
                      ? "text-brand"
                      : "text-muted-foreground hover:text-brand"
                  }`}
                >
                  {l.label}
                  {pathname === l.to && (
                    <span className="absolute inset-x-3 -bottom-px h-0.5 bg-brand" />
                  )}
                </Link>
              ),
            )}
          </div>
        </div>

        {/* Right: auth-aware actions */}
        <div className="flex items-center gap-2">
          {authLoading ? (
            // Skeleton while resolving session — prevents flicker
            <div className="hidden sm:block h-8 w-20 rounded-full bg-card/60 animate-pulse" />
          ) : user ? (
            // Authenticated state
            <>
              <Link
                to="/dashboard"
                className="hidden sm:inline-flex items-center gap-1.5 text-sm font-medium text-muted-foreground hover:text-foreground transition-colors px-3 py-2 rounded-lg hover:bg-white/[0.04]"
              >
                <Crosshair className="size-4" />
                Focus
              </Link>
              <button
                onClick={handleLogout}
                className="hidden sm:block text-sm font-medium text-muted-foreground hover:text-foreground transition-colors px-3 py-2 rounded-lg hover:bg-white/[0.04]"
              >
                Log out
              </button>
            </>
          ) : (
            // Unauthenticated state
            <>
              <Link
                to="/login"
                className="hidden sm:block text-sm font-medium text-muted-foreground hover:text-foreground transition-colors px-3 py-2 rounded-lg hover:bg-white/[0.04]"
              >
                Login
              </Link>
              <Link
                to="/signup"
                className="relative group bg-brand hover:bg-brand-dark text-brand-foreground px-5 py-2 rounded-full text-sm font-semibold transition-all duration-200 shadow-brand btn-press overflow-hidden"
              >
                <span className="relative z-10">Start Free</span>
                <span className="absolute inset-0 bg-white/10 opacity-0 group-hover:opacity-100 transition-opacity duration-200 rounded-full" />
              </Link>
            </>
          )}

          {/* Mobile hamburger */}
          <button
            className="md:hidden ml-1 size-9 grid place-items-center rounded-lg border border-border hover:bg-card transition-colors"
            onClick={() => setMobileOpen((o) => !o)}
          >
            {mobileOpen ? <X className="size-4" /> : <Menu className="size-4" />}
          </button>
        </div>
      </div>

      {/* Mobile menu */}
      {mobileOpen && (
        <div
          className={`md:hidden border-t border-brand/20 bg-[#02040c]/95 px-6 py-4 space-y-1 animate-fade-up ${
            disableBackdropBlur ? "" : "backdrop-blur-xl"
          }`}
        >
          {links.map((l) =>
            l.anchor ? (
              <a
                key={l.label}
                href={`/${l.anchor}`}
                onClick={(e) => handleAnchorClick(e, l.anchor!)}
                className="block px-3 py-2.5 text-sm font-medium text-muted-foreground hover:text-brand rounded-lg hover:bg-brand/5 transition-colors"
              >
                {l.label}
              </a>
            ) : (
              <Link
                key={l.label}
                to={l.to as "/"}
                className="block px-3 py-2.5 text-sm font-medium text-muted-foreground hover:text-brand rounded-lg hover:bg-brand/5 transition-colors"
                onClick={() => setMobileOpen(false)}
              >
                {l.label}
              </Link>
            ),
          )}
          <div className="pt-2 border-t border-brand/10 space-y-1">
            {user ? (
              <>
                <Link
                  to="/dashboard"
                  className="block px-3 py-2.5 text-sm font-medium text-muted-foreground hover:text-brand rounded-lg hover:bg-brand/5 transition-colors"
                  onClick={() => setMobileOpen(false)}
                >
                  Focus
                </Link>
                <button
                  className="block w-full text-left px-3 py-2.5 text-sm font-medium text-muted-foreground hover:text-brand rounded-lg hover:bg-brand/5 transition-colors"
                  onClick={() => {
                    setMobileOpen(false);
                    handleLogout();
                  }}
                >
                  Log out
                </button>
              </>
            ) : (
              <Link
                to="/login"
                className="block px-3 py-2.5 text-sm font-medium text-muted-foreground hover:text-brand rounded-lg hover:bg-brand/5 transition-colors"
                onClick={() => setMobileOpen(false)}
              >
                Login
              </Link>
            )}
          </div>
        </div>
      )}
    </nav>
  );
}
