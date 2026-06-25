import { createFileRoute } from "@tanstack/react-router";
import { SiteNav } from "@/components/mast/SiteNav";
import { SiteFooter } from "@/components/mast/SiteFooter";
import { LegalPage } from "./terms";

export const Route = createFileRoute("/privacy")({
  head: () => ({
    meta: [
      { title: "Privacy Policy — Mast" },
      { name: "description", content: "Mast Privacy Policy" },
    ],
  }),
  component: PrivacyPage,
});

function PrivacyPage() {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <SiteNav />
      <LegalPage
        title="Privacy Policy"
        lastUpdated="January 1, 2026"
        sections={[
          {
            heading: "Information We Collect",
            body: "We collect information you provide when creating an account (name, email, payment details) and usage data generated when you interact with Mast (lead searches, CRM actions, session data).",
          },
          {
            heading: "How We Use Your Information",
            body: "We use collected data to provide and improve Mast, process payments, send account notifications, and analyze platform usage. We do not sell your personal information to third parties.",
          },
          {
            heading: "Lead Data",
            body: "Business contact information generated through Mast is sourced from publicly available sources. You are responsible for ensuring your outreach activities comply with applicable laws (CAN-SPAM, GDPR, CCPA).",
          },
          {
            heading: "Data Storage & Security",
            body: "Your data is stored on secure servers. We use encryption in transit (TLS) and at rest. Access is restricted to authorized personnel on a need-to-know basis.",
          },
          {
            heading: "Cookies",
            body: "Mast uses session cookies for authentication and analytics cookies to understand usage patterns. You can disable non-essential cookies in your browser settings.",
          },
          {
            heading: "Third-Party Services",
            body: "We use third-party services for payment processing (Stripe), email delivery, and analytics. These services have their own privacy policies and we encourage you to review them.",
          },
          {
            heading: "Your Rights",
            body: "Depending on your location, you may have rights to access, correct, or delete your personal data. Contact us at privacy@mast.so to exercise these rights.",
          },
          {
            heading: "Contact",
            body: "Questions about this policy? Reach out at privacy@mast.so.",
          },
        ]}
      />
      <SiteFooter />
    </div>
  );
}
