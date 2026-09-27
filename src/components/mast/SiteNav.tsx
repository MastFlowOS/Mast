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
  { key: "features", label: "Features", to: "/" },
  { key: "pricing", label: "Pricing", to: "/pricing" },
  { key: "solutions", label: "Solutions", anchor: "#solutions" },
  { key: "customers", label: "Customers", anchor: "#testimonials" },
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

  // Active and hover tracking for the floating pill
  const [activeKey, setActiveKey] = useState<string | null>(() => {
    if (pathname === "/pricing") return "pricing";
    if (typeof window !== "undefined") {
      if (window.location.hash === "#solutions") return "solutions";
      if (window.location.hash === "#testimonials") return "customers";
    }
    return pathname === "/" ? "features" : null;
  });

  const [hoveredKey, setHoveredKey] = useState<string | null>(null);
  const targetKey = hoveredKey ?? activeKey;

  const navLinksRef = useRef<HTMLDivElement>(null);
  const [pillStyle, setPillStyle] = useState({ x: 0, y: 0, width: 0, height: 0, opacity: 0 });
  const pillMounted = useRef(false);
  const [pillAnimReady, setPillAnimReady] = useState(false);

  // Sync activeKey when route changes
  useEffect(() => {
    if (pathname === "/pricing") {
      setActiveKey("pricing");
    } else if (pathname === "/") {
      if (window.location.hash === "#solutions") {
        setActiveKey("solutions");
      } else if (window.location.hash === "#testimonials") {
        setActiveKey("customers");
      } else if (window.scrollY < 300) {
        setActiveKey("features");
      }
    } else {
      setActiveKey(null);
    }
  }, [pathname]);

  // Scroll spy on home page: update activeKey as sections scroll into view
  useEffect(() => {
    if (pathname !== "/") return;

    let ticking = false;
    const handleScrollSpy = () => {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(() => {
        ticking = false;
        const scrollY = window.scrollY;
        if (scrollY < 300) {
          setActiveKey("features");
          return;
        }

        const navOffset = 180;
        const testimonialsEl = document.getElementById("testimonials");
        if (testimonialsEl) {
          const rect = testimonialsEl.getBoundingClientRect();
          if (rect.top <= navOffset) {
            setActiveKey("customers");
            return;
          }
        }

        const solutionsEl = document.getElementById("solutions");
        if (solutionsEl) {
          const rect = solutionsEl.getBoundingClientRect();
          if (rect.top <= navOffset) {
            setActiveKey("solutions");
            return;
          }
        }

        setActiveKey("features");
      });
    };

    window.addEventListener("scroll", handleScrollSpy, { passive: true });
    return () => window.removeEventListener("scroll", handleScrollSpy);
  }, [pathname]);

  // Measure and position the pill behind targetKey (hovered or active)
  const measurePill = useCallback(() => {
    const container = navLinksRef.current;
    if (!container || !targetKey) {
      setPillStyle((prev) => ({ ...prev, opacity: 0 }));
      return;
    }

    const targetEl = container.querySelector<HTMLElement>(
      `[data-nav-key="${targetKey}"]`,
    );
    if (!targetEl) return;

    const cr = container.getBoundingClientRect();
    const er = targetEl.getBoundingClientRect();

    if (er.width > 0 && er.height > 0) {
      setPillStyle({
        x: er.left - cr.left,
        y: er.top - cr.top,
        width: er.width,
        height: er.height,
        opacity: 1,
      });

      if (!pillMounted.current) {
        pillMounted.current = true;
        requestAnimationFrame(() => {
          setPillAnimReady(true);
        });
      }
    }
  }, [targetKey]);

  useEffect(() => {
    measurePill();
  }, [measurePill, scrolled]);

  useEffect(() => {
    const container = navLinksRef.current;
    if (!container) return;

    const ro = new ResizeObserver(() => {
      measurePill();
    });
    ro.observe(container);

    window.addEventListener("resize", measurePill);
    const onVisible = () => {
      if (!document.hidden) measurePill();
    };
    document.addEventListener("visibilitychange", onVisible);

    document.fonts?.ready?.then?.(() => {
      measurePill();
    });

    return () => {
      ro.disconnect();
      window.removeEventListener("resize", measurePill);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [measurePill]);

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
    (e: React.MouseEvent<HTMLAnchorElement>, hash: string, key: string) => {
      e.preventDefault();
      setMobileOpen(false);
      setActiveKey(key);

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
            <div
              ref={navLinksRef}
              onMouseLeave={() => setHoveredKey(null)}
              className="hidden md:flex items-center gap-1 relative"
            >
              {/* Shared sliding pill indicator */}
              <div
                aria-hidden="true"
                className="absolute rounded-full bg-white/[0.08] shadow-[inset_0_1px_0_rgba(255,255,255,0.06)] pointer-events-none"
                style={{
                  top: 0,
                  left: 0,
                  transform: `translate3d(${pillStyle.x}px, ${pillStyle.y}px, 0)`,
                  width: `${pillStyle.width}px`,
                  height: `${pillStyle.height}px`,
                  opacity: pillStyle.opacity,
                  transition: pillAnimReady
                    ? "transform 350ms cubic-bezier(0.16, 1, 0.3, 1), width 350ms cubic-bezier(0.16, 1, 0.3, 1), height 350ms cubic-bezier(0.16, 1, 0.3, 1), opacity 150ms ease"
                    : "none",
                  willChange: "transform, width, height",
                }}
              />
              {links.map((l) => {
                const isSelected = targetKey === l.key;
                return l.anchor ? (
                  // Anchor link — always navigates to /#hash
                  <a
                    key={l.label}
                    data-nav-key={l.key}
                    href={`/${l.anchor}`}
                    onMouseEnter={() => setHoveredKey(l.key)}
                    onClick={(e) => handleAnchorClick(e, l.anchor!, l.key)}
                    className={`relative z-[1] px-3.5 py-1.5 text-sm font-medium rounded-full transition-colors duration-200 ${
                      isSelected
                        ? "text-foreground"
                        : "text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    {l.label}
                  </a>
                ) : (
                  <Link
                    key={l.label}
                    data-nav-key={l.key}
                    to={l.to as "/"}
                    onMouseEnter={() => setHoveredKey(l.key)}
                    onClick={(e) => {
                      setActiveKey(l.key);
                      if (l.key === "features" && pathname === "/") {
                        e.preventDefault();
                        window.scrollTo({ top: 0, behavior: "smooth" });
                      }
                    }}
                    className={`relative z-[1] px-3.5 py-1.5 text-sm font-medium rounded-full transition-colors duration-200 ${
                      isSelected
                        ? "text-foreground"
                        : "text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    {l.label}
                  </Link>
                );
              })}
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
            {links.map((l) => {
              const isSelected = activeKey === l.key;
              return l.anchor ? (
                <a
                  key={l.label}
                  href={`/${l.anchor}`}
                  onClick={(e) => handleAnchorClick(e, l.anchor!, l.key)}
                  className={`block px-3.5 py-2 text-sm font-medium rounded-xl transition-colors ${
                    isSelected
                      ? "text-foreground bg-white/[0.08]"
                      : "text-muted-foreground hover:text-foreground hover:bg-white/[0.04]"
                  }`}
                >
                  {l.label}
                </a>
              ) : (
                <Link
                  key={l.label}
                  to={l.to as "/"}
                  className={`block px-3.5 py-2 text-sm font-medium rounded-xl transition-colors ${
                    isSelected
                      ? "text-foreground bg-white/[0.08]"
                      : "text-muted-foreground hover:text-foreground hover:bg-white/[0.04]"
                  }`}
                  onClick={(e) => {
                    setActiveKey(l.key);
                    setMobileOpen(false);
                    if (l.key === "features" && pathname === "/") {
                      e.preventDefault();
                      window.scrollTo({ top: 0, behavior: "smooth" });
                    }
                  }}
                >
                  {l.label}
                </Link>
              );
            })}
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
