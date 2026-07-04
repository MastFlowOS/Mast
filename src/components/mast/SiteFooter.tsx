import { Link } from "@tanstack/react-router";
import { BrandMark } from "./BrandMark";
import { Mail, Twitter, Github } from "lucide-react";

// ─── Social link constants ────────────────────────────────────────────────────
// Set these to real URLs or leave as empty string ("") to hide the icon.
const SOCIAL_LINKS = {
  twitter: "", // e.g. "https://twitter.com/mastapp"
  github: "",  // e.g. "https://github.com/mastapp"
  email: "",   // e.g. "mailto:hello@mast.so"
} as const;

const socialButtons = [
  { key: "twitter" as const, icon: Twitter, label: "Twitter / X" },
  { key: "github" as const, icon: Github, label: "GitHub" },
  { key: "email" as const, icon: Mail, label: "Email" },
].filter(({ key }) => Boolean(SOCIAL_LINKS[key])); // hide icons with no URL

export function SiteFooter() {
  return (
    <footer className="border-t border-border/50 pt-16 pb-10 px-6 mt-8 relative overflow-hidden">
      {/* Subtle glow */}
      <div
        className="pointer-events-none absolute bottom-0 left-1/2 -translate-x-1/2 size-[400px] opacity-10 rounded-full"
        style={{ background: "radial-gradient(closest-side, var(--brand), transparent)" }}
      />

      <div className="max-w-7xl mx-auto relative">
        <div className="grid md:grid-cols-5 gap-10 mb-14">
          {/* Brand col */}
          <div className="md:col-span-2">
            <div className="flex items-center gap-2.5 mb-4">
              <BrandMark size={28} />
              <span className="font-bold tracking-[0.12em] text-foreground">MAST</span>
            </div>
            <p className="text-sm text-muted-foreground max-w-xs leading-relaxed">
              The premium operating system for client acquisition. Built for modern agencies, freelancers, and growth operators.
            </p>

            {/* Socials — only rendered if URLs are configured */}
            {socialButtons.length > 0 && (
              <div className="flex items-center gap-2 mt-6">
                {socialButtons.map(({ key, icon: Icon, label }) => (
                  <a
                    key={key}
                    href={SOCIAL_LINKS[key]}
                    aria-label={label}
                    target={key === "email" ? undefined : "_blank"}
                    rel={key === "email" ? undefined : "noopener noreferrer"}
                    className="size-8 rounded-lg border border-border/60 grid place-items-center text-muted-foreground hover:text-foreground hover:border-brand/30 hover:bg-brand/5 transition-all"
                  >
                    <Icon className="size-4" />
                  </a>
                ))}
              </div>
            )}
          </div>

          <FooterCol
            title="Product"
            links={[
              ["Features", "/"],
              ["Pricing", "/pricing"],
              ["Discover", "/dashboard/leads"],
              ["Pipeline", "/dashboard/pipeline"],
            ]}
          />
          <FooterCol
            title="Account"
            links={[
              ["Login", "/login"],
              ["Sign up", "/signup"],
              ["Focus", "/dashboard"],
              ["Billing", "/dashboard/billing"],
            ]}
          />
          <FooterCol
            title="Legal"
            links={[
              ["Terms", "/terms"],
              ["Privacy", "/privacy"],
              ["Refund Policy", "/refunds"],
              ["Security", "/security"],
            ]}
          />
        </div>

        {/* Bottom bar */}
        <div className="pt-8 border-t border-border/40 flex flex-col sm:flex-row justify-between items-center gap-4 text-xs text-muted-foreground">
          <span>© 2026 Mast Intelligence Inc.</span>
          <span className="text-muted-foreground/60">Built for operators who hate cold inboxes.</span>
        </div>
      </div>
    </footer>
  );
}

function FooterCol({ title, links }: { title: string; links: [string, string][] }) {
  return (
    <div>
      <h4 className="text-[10px] font-bold uppercase tracking-[0.18em] text-foreground mb-5">{title}</h4>
      <ul className="space-y-3">
        {links.map(([label, href]) => (
          <li key={label}>
            <Link
              to={href as "/"}
              className="text-sm text-muted-foreground hover:text-foreground transition-colors duration-150"
            >
              {label}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
