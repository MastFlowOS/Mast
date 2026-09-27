import { Link, useRouterState, useNavigate } from "@tanstack/react-router";
import { Logo } from "./Logo";
import { useState, useEffect, useCallback, useRef } from "react";
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
  const [mobileOpen, setMobileOpen] = useState(false);
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const navigate = useNavigate();

  // Auth state — read from React Query cache (populated by /api/me on app init)
  const { data: auth, isLoading: authLoading } = useMe();
  const user = auth?.user ?? null;
  const logout = useLogout();

  const scrolledRef = useRef(false);

  // The sheen's scroll offset is applied straight to the DOM instead of going
  // through React state. As state it re-rendered the whole nav (and forced an
  // extra style recalc + repaint) on every scroll frame; the value is purely
  // visual, so React never needs to know about it. The callback ref also seeds
  // the position the moment the sheen mounts (it only exists while `scrolled`).
  const sheenElRef = useRef<HTMLDivElement | null>(null);
  const sheenOffsetRef = useRef(0);
  const setSheenEl = useCallback((el: HTMLDivElement | null) => {
    sheenElRef.current = el;
    if (el) el.style.backgroundPositionX = `${-sheenOffsetRef.current}px`;
  }, []);

  useEffect(() => {
    let rafId = 0;
    const handler = () => {
      if (rafId) return;
      rafId = requestAnimationFrame(() => {
        rafId = 0;
        const scrollY = window.scrollY;

        // Hysteresis threshold: trigger compact state when scrollY > 20px,
        // expand back to wide transparent top state when scrollY <= 8px.
        const current = scrolledRef.current;
        const nextScrolled = current ? scrollY > 8 : scrollY > 20;

        if (nextScrolled !== current) {
          scrolledRef.current = nextScrolled;
          setScrolled(nextScrolled);
        }

        // Slow, subtle celestial sheen that drifts across the header as you
        // scroll — gives the bar a sense of moving with the page
        if (nextScrolled) {
          const offset = scrollY * 0.25;
          sheenOffsetRef.current = offset;
          const sheenEl = sheenElRef.current;
          if (sheenEl) sheenEl.style.backgroundPositionX = `${-offset}px`;
        }
      });
    };
    window.addEventListener("scroll", handler, { passive: true });
    return () => {
      window.removeEventListener("scroll", handler);
      if (rafId) cancelAnimationFrame(rafId);
    };
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
      aria-label="Main navigation"
      className={`sticky top-0 z-50 w-full px-4 sm:px-6 lg:px-8 pointer-events-none transition-[padding] duration-500 ease-[cubic-bezier(0.16,1,0.3,1)] ${
        scrolled ? "pt-3 sm:pt-3.5 pb-2" : "pt-2 sm:pt-3 pb-1"
      }`}
    >
      <div className="relative mx-auto">
        {/* Dynamic expanding / collapsing nav container */}
        <div
          className={`pointer-events-auto relative mx-auto flex items-center justify-between transition-[max-width,height,padding,background-color,border-color,box-shadow,backdrop-filter] duration-500 ease-[cubic-bezier(0.16,1,0.3,1)] overflow-hidden rounded-full ${
            scrolled
              ? "max-w-5xl h-14 px-5 sm:px-7 " +
                (disableBackdropBlur
                  ? "bg-[#050814] border border-white/[0.12] shadow-[0_12px_36px_rgba(0,0,0,0.55),0_1px_0_rgba(255,255,255,0.06)_inset]"
                  : "bg-[#020511]/85 backdrop-blur-xl border border-white/[0.12] shadow-[0_12px_36px_rgba(0,0,0,0.55),0_1px_0_rgba(255,255,255,0.06)_inset]")
              : "max-w-7xl h-16 px-6 sm:px-8 lg:px-10 bg-transparent border border-transparent shadow-none backdrop-blur-none"
          }`}
        >
          {scrolled && (
            <div
              ref={setSheenEl}
              aria-hidden="true"
              className="pointer-events-none absolute inset-0 opacity-40 rounded-full animate-fade-in"
              style={{
                backgroundImage:
                  "linear-gradient(115deg, transparent 20%, color-mix(in oklab, var(--brand, #c9a66b) 12%, transparent) 50%, transparent 80%)",
                backgroundSize: "220% 100%",
              }}
            />
          )}

          {/* Left group: Logo + Nav links */}
          <div
            className={`relative z-10 flex items-center transition-[gap] duration-500 ease-[cubic-bezier(0.16,1,0.3,1)] ${
              scrolled ? "gap-7 lg:gap-9" : "gap-8 lg:gap-12"
            }`}
          >
            <Logo height={22} />
            <div className="hidden md:flex items-center gap-1">
              {links.map((l) =>
                l.anchor ? (
                  // Anchor link — always navigates to /#hash
                  <a
                    key={l.label}
                    href={`/${l.anchor}`}
                    onClick={(e) => handleAnchorClick(e, l.anchor!)}
                    className="px-3.5 py-1.5 text-sm font-medium text-muted-foreground hover:text-foreground hover:bg-white/[0.04] rounded-full transition-colors duration-150"
                  >
                    {l.label}
                  </a>
                ) : (
                  <Link
                    key={l.label}
                    to={l.to as "/"}
                    className={`px-3.5 py-1.5 text-sm font-medium rounded-full transition-all duration-150 ${
                      pathname === l.to
                        ? "text-foreground bg-white/[0.08] shadow-[inset_0_1px_0_rgba(255,255,255,0.06)]"
                        : "text-muted-foreground hover:text-foreground hover:bg-white/[0.04]"
                    }`}
                  >
                    {l.label}
                  </Link>
                ),
              )}
            </div>
          </div>

          {/* Right group: Auth-aware actions */}
          <div className="relative z-10 flex items-center gap-2 sm:gap-3">
            {authLoading ? (
              // Skeleton while resolving session — prevents flicker
              <div className="hidden sm:block h-7 w-20 rounded-full bg-white/[0.06] animate-pulse" />
            ) : user ? (
              // Authenticated state
              <>
                <Link
                  to="/dashboard"
                  className="hidden sm:inline-flex items-center gap-1.5 text-sm font-medium text-foreground bg-white/[0.08] hover:bg-white/[0.12] border border-white/[0.08] px-3.5 py-1.5 rounded-full transition-colors duration-150"
                >
                  <Crosshair className="size-3.5 text-brand" />
                  Focus
                </Link>
                <button
                  onClick={handleLogout}
                  className="hidden sm:block text-sm font-medium text-muted-foreground hover:text-foreground transition-colors duration-150 px-3.5 py-1.5 rounded-full hover:bg-white/[0.04]"
                >
                  Log out
                </button>
              </>
            ) : (
              // Unauthenticated state
              <>
                <Link
                  to="/login"
                  className="hidden sm:block text-sm font-medium text-muted-foreground hover:text-foreground transition-colors duration-150 px-3.5 py-1.5 rounded-full hover:bg-white/[0.04]"
                >
                  Login
                </Link>
                <Link
                  to="/signup"
                  className="relative group bg-brand hover:bg-brand-dark text-brand-foreground px-4 sm:px-5 py-1.5 rounded-full text-sm font-semibold transition-all duration-200 shadow-brand btn-press overflow-hidden"
                >
                  <span className="relative z-10">Start Free</span>
                  <span className="absolute inset-0 bg-white/10 opacity-0 group-hover:opacity-100 transition-opacity duration-200 rounded-full" />
                </Link>
              </>
            )}

            {/* Mobile hamburger */}
            <button
              className="md:hidden size-9 grid place-items-center rounded-full border border-white/[0.08] bg-white/[0.03] hover:bg-white/[0.08] text-muted-foreground hover:text-foreground transition-colors"
              onClick={() => setMobileOpen((o) => !o)}
              aria-label={mobileOpen ? "Close menu" : "Open menu"}
            >
              {mobileOpen ? <X className="size-4" /> : <Menu className="size-4" />}
            </button>
          </div>
        </div>

        {/* Floating Mobile dropdown panel */}
        {mobileOpen && (
          <div
            className={`pointer-events-auto md:hidden mt-2 p-3 rounded-2xl border border-white/[0.1] bg-[#020511]/95 shadow-[0_16px_40px_rgba(0,0,0,0.65)] space-y-1 animate-fade-up ${
              disableBackdropBlur ? "" : "backdrop-blur-2xl"
            }`}
          >
            {links.map((l) =>
              l.anchor ? (
                <a
                  key={l.label}
                  href={`/${l.anchor}`}
                  onClick={(e) => handleAnchorClick(e, l.anchor!)}
                  className="block px-3.5 py-2 text-sm font-medium text-muted-foreground hover:text-foreground rounded-xl hover:bg-white/[0.04] transition-colors"
                >
                  {l.label}
                </a>
              ) : (
                <Link
                  key={l.label}
                  to={l.to as "/"}
                  className={`block px-3.5 py-2 text-sm font-medium rounded-xl transition-colors ${
                    pathname === l.to
                      ? "text-foreground bg-white/[0.08]"
                      : "text-muted-foreground hover:text-foreground hover:bg-white/[0.04]"
                  }`}
                  onClick={() => setMobileOpen(false)}
                >
                  {l.label}
                </Link>
              ),
            )}
            <div className="pt-2 mt-1 border-t border-white/[0.08] space-y-1">
              {user ? (
                <>
                  <Link
                    to="/dashboard"
                    className="flex items-center gap-2 px-3.5 py-2 text-sm font-medium text-foreground bg-white/[0.06] rounded-xl hover:bg-white/[0.1] transition-colors"
                    onClick={() => setMobileOpen(false)}
                  >
                    <Crosshair className="size-3.5 text-brand" />
                    Focus
                  </Link>
                  <button
                    className="block w-full text-left px-3.5 py-2 text-sm font-medium text-muted-foreground hover:text-foreground rounded-xl hover:bg-white/[0.04] transition-colors"
                    onClick={() => {
                      setMobileOpen(false);
                      handleLogout();
                    }}
                  >
                    Log out
                  </button>
                </>
              ) : (
                <>
                  <Link
                    to="/login"
                    className="block px-3.5 py-2 text-sm font-medium text-muted-foreground hover:text-foreground rounded-xl hover:bg-white/[0.04] transition-colors"
                    onClick={() => setMobileOpen(false)}
                  >
                    Login
                  </Link>
                  <Link
                    to="/signup"
                    className="block px-3.5 py-2 text-sm font-semibold text-brand-foreground bg-brand hover:bg-brand-dark rounded-xl text-center transition-colors shadow-brand"
                    onClick={() => setMobileOpen(false)}
                  >
                    Start Free
                  </Link>
                </>
              )}
            </div>
          </div>
        )}
      </div>
    </nav>
  );
}
