import { createFileRoute } from "@tanstack/react-router";
import { SiteNav } from "@/components/mast/SiteNav";
import { SiteFooter } from "@/components/mast/SiteFooter";

export const Route = createFileRoute("/terms")({
  head: () => ({
    meta: [
      { title: "Terms of Service — Mast" },
      { name: "description", content: "Mast Terms of Service" },
    ],
  }),
  component: TermsPage,
});

function TermsPage() {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <SiteNav />
      <LegalPage
        title="Terms of Service"
        lastUpdated="January 1, 2026"
        sections={[
          {
            heading: "Acceptance of Terms",
            body: "By accessing or using Mast, you agree to be bound by these Terms of Service. If you do not agree to these terms, please do not use our services.",
          },
          {
            heading: "Use of Service",
            body: "Mast provides opportunity discovery and relationship data tools for professional business use. You agree to use the platform only for lawful purposes and in compliance with all applicable regulations, including those governing outreach communications (CAN-SPAM, GDPR, etc.).",
          },
          {
            heading: "Account Responsibility",
            body: "You are responsible for maintaining the confidentiality of your account credentials and for all activity that occurs under your account. Notify us immediately of any unauthorized use.",
          },
          {
            heading: "Credits & Billing",
            body: "Credits are consumed upon opportunity discovery and do not roll over between billing cycles. All charges are final unless otherwise stated in our refund policy. You may upgrade or cancel your plan at any time.",
          },
          {
            heading: "Intellectual Property",
            body: "All content, trademarks, and software associated with Mast are the property of Mast Intelligence Inc. or its licensors. You may not reproduce, distribute, or create derivative works without express written permission.",
          },
          {
            heading: "Limitation of Liability",
            body: "Mast is provided 'as is' without warranties of any kind. We shall not be liable for indirect, incidental, or consequential damages arising from your use of the platform.",
          },
          {
            heading: "Changes to Terms",
            body: "We may update these Terms of Service at any time. Continued use of Mast after changes constitutes acceptance of the updated terms. We will notify users of material changes via email.",
          },
          {
            heading: "Contact",
            body: "Questions about these terms? Reach out to us at legal@mast.so.",
          },
        ]}
      />
      <SiteFooter />
    </div>
  );
}

// ─── Shared layout for legal pages ───────────────────────────────────────────

export function LegalPage({
  title,
  lastUpdated,
  sections,
}: {
  title: string;
  lastUpdated: string;
  sections: { heading: string; body: string }[];
}) {
  return (
    <>
      {/* Hero */}
      <section className="relative pt-24 pb-14 px-6 overflow-hidden">
        <div className="pointer-events-none absolute inset-0 bg-grid opacity-[0.12] [mask-image:radial-gradient(ellipse_at_top,black_20%,transparent_65%)]" />
        <div className="relative max-w-3xl mx-auto">
          <h1 className="text-[clamp(2rem,5vw,3rem)] font-bold tracking-tight text-foreground">
            {title}
          </h1>
          <p className="mt-3 text-sm text-muted-foreground">Last updated: {lastUpdated}</p>
        </div>
      </section>

      {/* Content */}
      <section className="px-6 pb-24">
        <div className="max-w-3xl mx-auto space-y-10">
          {sections.map(({ heading, body }) => (
            <div key={heading}>
              <h2 className="text-base font-bold text-foreground mb-3">{heading}</h2>
              <p className="text-sm text-muted-foreground leading-relaxed">{body}</p>
            </div>
          ))}
          <div className="pt-4 border-t border-border/40 text-xs text-muted-foreground/60">
            This is a placeholder document. Full legal terms will be published prior to general availability.
          </div>
        </div>
      </section>
    </>
  );
}
