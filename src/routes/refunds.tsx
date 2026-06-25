import { createFileRoute } from "@tanstack/react-router";
import { SiteNav } from "@/components/mast/SiteNav";
import { SiteFooter } from "@/components/mast/SiteFooter";
import { LegalPage } from "./terms";

export const Route = createFileRoute("/refunds")({
  head: () => ({
    meta: [
      { title: "Refund Policy — Mast" },
      { name: "description", content: "Mast Refund Policy" },
    ],
  }),
  component: RefundsPage,
});

function RefundsPage() {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <SiteNav />
      <LegalPage
        title="Refund Policy"
        lastUpdated="January 1, 2026"
        sections={[
          {
            heading: "Subscription Services",
            body: "Mast is a subscription-based SaaS platform. By subscribing, you gain access to our lead generation tools, CRM features, and credit allocations according to your selected plan. Subscriptions are billed on a recurring basis — monthly or annually — depending on the plan you choose at signup.",
          },
          {
            heading: "Refund Eligibility",
            body: "We review refund requests on a case-by-case basis. You may be eligible for a refund if you were charged in error, made a duplicate purchase, experienced a significant technical issue that prevented normal use of the platform and was not resolved within a reasonable timeframe, or if you accidentally purchased a plan you did not intend to activate. Refund requests must be submitted within 14 days of the charge in question. We are not able to issue refunds for usage already consumed during a billing period.",
          },
          {
            heading: "Billing Errors",
            body: "If you believe you were charged incorrectly — including duplicate charges, incorrect plan amounts, or charges after a confirmed cancellation — please contact us as soon as possible. We will investigate and, where an error is confirmed, issue a correction or refund promptly.",
          },
          {
            heading: "Subscription Cancellation",
            body: "You may cancel your Mast subscription at any time from your account settings. Cancellation takes effect at the end of your current billing period, after which your account will not be renewed or charged. Cancellation does not automatically entitle you to a refund for the remaining days in your current billing cycle. If you cancel shortly after renewal and have not meaningfully used the platform during that period, you are welcome to contact us and we will consider your request.",
          },
          {
            heading: "Contact Information",
            body: "To submit a refund request or report a billing issue, please reach out to us at billing@mast.so. Include your account email, the date of the charge, and a brief description of the issue. We aim to respond to all billing inquiries within 2 business days.",
          },
          {
            heading: "Policy Updates",
            body: "We may update this Refund Policy from time to time as our platform and practices evolve. When we make material changes, we will notify you via email or a notice within the platform. Continued use of Mast after such changes constitutes your acceptance of the updated policy.",
          },
        ]}
      />
      <SiteFooter />
    </div>
  );
}
