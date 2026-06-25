import { createFileRoute } from "@tanstack/react-router";
import { SiteNav } from "@/components/mast/SiteNav";
import { SiteFooter } from "@/components/mast/SiteFooter";
import { LegalPage } from "./terms";

export const Route = createFileRoute("/security")({
  head: () => ({
    meta: [
      { title: "Security — Mast" },
      { name: "description", content: "Mast security practices and vulnerability disclosure" },
    ],
  }),
  component: SecurityPage,
});

function SecurityPage() {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <SiteNav />
      <LegalPage
        title="Security"
        lastUpdated="January 1, 2026"
        sections={[
          {
            heading: "Our Commitment",
            body: "Security is a core principle at Mast. We invest continuously in protecting your data and maintaining platform integrity.",
          },
          {
            heading: "Data Encryption",
            body: "All data transmitted between your browser and Mast servers is encrypted using TLS 1.2+. Data at rest is encrypted using AES-256.",
          },
          {
            heading: "Authentication",
            body: "Mast supports secure session authentication with httpOnly cookies. We support Google OAuth for social login. Passwords are hashed using bcrypt with appropriate cost factors.",
          },
          {
            heading: "Infrastructure",
            body: "Our infrastructure runs on Replit with automated backups, rate limiting, and DDoS mitigation. Access to production systems is restricted and audited.",
          },
          {
            heading: "Vulnerability Disclosure",
            body: "If you discover a security vulnerability, please report it responsibly to security@mast.so. We aim to acknowledge reports within 48 hours and resolve critical issues within 7 days.",
          },
          {
            heading: "Compliance",
            body: "Mast is designed with GDPR and CCPA considerations in mind. We provide data export and deletion tools on request.",
          },
          {
            heading: "Contact",
            body: "Security concerns? Contact security@mast.so. For non-urgent inquiries, reach out via our support channels.",
          },
        ]}
      />
      <SiteFooter />
    </div>
  );
}
