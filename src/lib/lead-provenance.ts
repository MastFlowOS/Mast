import type { Lead } from "./api";
import { normalizeLeadStatus } from "./lead-workspace.js";

/**
 * Lead provenance, based on the source values the application actually writes:
 *
 *  - Backend delivery (`scraperBridge/deliverLead.ts`) writes
 *    `discover_${discoveryMode}`, i.e. `discover_live`,
 *    `discover_instant_pool` or `discover_instant_pool_ranked`, and also sets
 *    `business_id` (the Global Lead Pool link).
 *  - The frontend writes `manual` (Add Lead form) and `csv_import`
 *    (Import page). Those rows never carry a `business_id`.
 *
 * The legacy `engine (` prefix is still accepted for old rows, but nothing
 * writes it any more.
 */
export function isDiscoveredLead(lead: Pick<Lead, "source" | "businessId">): boolean {
  const source = lead.source?.trim().toLowerCase() ?? "";
  if (source === "manual" || source === "csv_import") return false;
  if (source.startsWith("discover_") || source.startsWith("engine (")) return true;
  // Unknown or missing source: fall back to the pool link, which only
  // Discover deliveries set.
  return Boolean(lead.businessId);
}

/**
 * A discovered lead the user has not acted on: never contacted and still on
 * the default `new` status. Manual and CSV leads are never "discovered
 * opportunities", so they are excluded even when untouched.
 */
export function isUntouchedDiscoveredLead(
  lead: Pick<Lead, "source" | "businessId" | "status" | "lastContactedAt">,
): boolean {
  return (
    isDiscoveredLead(lead) && !lead.lastContactedAt && normalizeLeadStatus(lead.status) === "new"
  );
}

/**
 * Goal-side "relationship" rule, matching the intent documented on
 * `isRelationshipLead`: manual and imported leads count immediately, while a
 * Discover result only counts once the user has engaged with it. This keeps
 * "Save N relationships" from counting the same rows as "Discover N
 * opportunities".
 */
export function isEngagedRelationship(
  lead: Pick<Lead, "source" | "businessId" | "status" | "lastContactedAt">,
): boolean {
  return !isUntouchedDiscoveredLead(lead);
}
