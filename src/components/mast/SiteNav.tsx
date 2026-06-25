import { Link, useRouterState, useNavigate } from "@tanstack/react-router";
import { Logo } from "./Logo";
import { useState, useEffect, useCallback } from "react";
import { Menu, X, LayoutDashboard } from "lucide-react";
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

export function SiteNav() {
  const [scrolled, setScrolled] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const navigate = useNavigate();

  // Auth state — read from React Query cache (populated by /api/me on app init)
  const { data: auth, isLoading: authLoading } = useMe();
  const user = auth?.user ?? null;
  const logout = useLogout();

  useEffect(() => {
    const handler = () => setScrolled(window.scrollY > 12);
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
      className={`sticky top-0 z-50 transition-all duration-300 ${
        scrolled
          ? "border-b border-border/60 bg-background/85 backdrop-blur-2xl shadow-[0_1px_0_0_rgba(255,255,255,0.04)]"
          : "border-b border-transparent bg-background/40 backdrop-blur-xl"
      }`}
    >
      <div className="max-w-7xl mx-auto px-6 h-16 flex items-center justify-between">
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
                  className="relative px-3 py-2 text-sm font-medium text-muted-foreground hover:text-foreground transition-colors duration-150 rounded-lg hover:bg-white/[0.04] group"
                >
                  {l.label}
                </a>
              ) : (
                <Link
                  key={l.label}
                  to={l.to as "/"}
                  className={`relative px-3 py-2 text-sm font-medium transition-colors duration-150 rounded-lg hover:bg-white/[0.04] group ${
                    pathname === l.to
                      ? "text-foreground"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {l.label}
                  {pathname === l.to && (
                    <span className="absolute inset-x-3 -bottom-px h-px bg-brand/60" />
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
                <LayoutDashboard className="size-3.5" />
                Dashboard
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
        <div className="md:hidden border-t border-border/60 bg-background/95 backdrop-blur-xl px-6 py-4 space-y-1 animate-fade-up">
          {links.map((l) =>
            l.anchor ? (
              <a
                key={l.label}
                href={`/${l.anchor}`}
                onClick={(e) => handleAnchorClick(e, l.anchor!)}
                className="block px-3 py-2.5 text-sm font-medium text-muted-foreground hover:text-foreground rounded-lg hover:bg-white/[0.05] transition-colors"
              >
                {l.label}
              </a>
            ) : (
              <Link
                key={l.label}
                to={l.to as "/"}
                className="block px-3 py-2.5 text-sm font-medium text-muted-foreground hover:text-foreground rounded-lg hover:bg-white/[0.05] transition-colors"
                onClick={() => setMobileOpen(false)}
              >
                {l.label}
              </Link>
            ),
          )}
          <div className="pt-2 border-t border-border/50 space-y-1">
            {user ? (
              <>
                <Link
                  to="/dashboard"
                  className="block px-3 py-2.5 text-sm font-medium text-muted-foreground"
                  onClick={() => setMobileOpen(false)}
                >
                  Dashboard
                </Link>
                <button
                  className="block w-full text-left px-3 py-2.5 text-sm font-medium text-muted-foreground"
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
                className="block px-3 py-2.5 text-sm font-medium text-muted-foreground"
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
