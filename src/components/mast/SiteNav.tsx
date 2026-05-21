import { Link, useRouterState } from "@tanstack/react-router";
import { Logo } from "./Logo";
import { useState, useEffect } from "react";
import { Menu, X } from "lucide-react";

const links = [
  { label: "Features", to: "/" },
  { label: "Pricing", to: "/pricing" },
  { label: "Solutions", href: "#solutions" },
  { label: "Customers", href: "#testimonials" },
];

export function SiteNav() {
  const [scrolled, setScrolled] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const pathname = useRouterState({ select: (s) => s.location.pathname });

  useEffect(() => {
    const handler = () => setScrolled(window.scrollY > 12);
    window.addEventListener("scroll", handler, { passive: true });
    return () => window.removeEventListener("scroll", handler);
  }, []);

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
              l.href ? (
                <a
                  key={l.label}
                  href={l.href}
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
              )
            )}
          </div>
        </div>

        {/* Right: auth */}
        <div className="flex items-center gap-2">
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
            l.href ? (
              <a
                key={l.label}
                href={l.href}
                className="block px-3 py-2.5 text-sm font-medium text-muted-foreground hover:text-foreground rounded-lg hover:bg-white/[0.05] transition-colors"
                onClick={() => setMobileOpen(false)}
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
            )
          )}
          <div className="pt-2 border-t border-border/50">
            <Link to="/login" className="block px-3 py-2.5 text-sm font-medium text-muted-foreground">Login</Link>
          </div>
        </div>
      )}
    </nav>
  );
}
