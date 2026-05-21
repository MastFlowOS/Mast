import { Link } from "@tanstack/react-router";
import { BrandMark } from "./BrandMark";
import { Mail, Twitter, Github } from "lucide-react";

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
            {/* Socials */}
            <div className="flex items-center gap-2 mt-6">
              {[
                { icon: Twitter, label: "Twitter" },
                { icon: Github, label: "GitHub" },
                { icon: Mail, label: "Email" },
              ].map(({ icon: Icon, label }) => (
                <button
                  key={label}
                  aria-label={label}
                  className="size-8 rounded-lg border border-border/60 grid place-items-center text-muted-foreground hover:text-foreground hover:border-brand/30 hover:bg-brand/5 transition-all"
                >
                  <Icon className="size-3.5" />
                </button>
              ))}
            </div>
          </div>

          <FooterCol
            title="Product"
            links={[["Features", "/"], ["Pricing", "/pricing"], ["Get Leads", "/dashboard/leads"], ["CRM", "/dashboard/crm"]]}
          />
          <FooterCol
            title="Account"
            links={[["Login", "/login"], ["Sign up", "/signup"], ["Dashboard", "/dashboard"], ["Billing", "/dashboard/billing"]]}
          />
          <FooterCol
            title="Legal"
            links={[["Terms", "/"], ["Privacy", "/"], ["Security", "/"], ["Status", "/"]]}
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
