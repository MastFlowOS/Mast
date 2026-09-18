/**
 * Adapter over the existing deterministic Opportunity Explanation read.
 *
 * Reuses `getOpportunityExplanation()` (src/lib/api.ts →
 * `GET /v1/intelligence/explain/:leadId`). No new endpoint, no change to
 * intelligence.ts, no AI Opportunity Insights call, no scoring change.
 *
 * KNOWN CONTRACT GAP (documented, not "fixed" here): the scoring engine
 * computes a 6th `tech` component, but
 * `OpportunityExplanationReason.component` in src/lib/api.ts declares only
 * five values. This adapter therefore reads the runtime value defensively
 * and accepts `tech` if the endpoint ever surfaces it, without widening
 * the api.ts type (which mirrors the backend response body) and without
 * touching the scoring engine to make the types agree.
 */

import type { OpportunityExplanation } from "@/lib/api";
import type { NormalizedOpportunitySignal, OpportunityComponent } from "@/lib/outreach/types";

const VALID_COMPONENTS: readonly OpportunityComponent[] = [
  "website",
  "branding",
  "social",
  "growth",
  "newness",
  "tech",
];

export const UNAVAILABLE_SIGNAL: NormalizedOpportunitySignal = {
  available: false,
  rankedComponents: [],
  topComponent: null,
  score: null,
};

function isOpportunityComponent(value: unknown): value is OpportunityComponent {
  return typeof value === "string" && (VALID_COMPONENTS as readonly string[]).includes(value);
}

/**
 * Pure normalization of an already-fetched explanation. Kept separate from
 * the fetch so it can be tested without a network stub.
 */
export function normalizeExplanation(
  explanation: OpportunityExplanation | null | undefined,
  suppressedComponents: readonly OpportunityComponent[] = [],
): NormalizedOpportunitySignal {
  if (!explanation || !Array.isArray(explanation.reasons)) return UNAVAILABLE_SIGNAL;

  const suppressed = new Set<OpportunityComponent>(suppressedComponents);
  const seen = new Set<OpportunityComponent>();
  const ranked: OpportunityComponent[] = [];

  // The endpoint returns reasons strongest-first; sort defensively by
  // weight × value so a differently-ordered payload still ranks correctly.
  const reasons = [...explanation.reasons].sort((a, b) => {
    const aStrength = (Number(a?.weight) || 0) * (Number(a?.value) || 0);
    const bStrength = (Number(b?.weight) || 0) * (Number(b?.value) || 0);
    return bStrength - aStrength;
  });

  for (const reason of reasons) {
    const component: unknown = reason?.component;
    if (!isOpportunityComponent(component)) continue;
    if (seen.has(component)) continue;
    seen.add(component);
    if (suppressed.has(component)) continue;
    ranked.push(component);
  }

  const score = typeof explanation.score === "number" && Number.isFinite(explanation.score) ? explanation.score : null;

  if (ranked.length === 0) {
    // Either there were no usable reasons, or every one was suppressed.
    // Both are the same thing to the pipeline: no usable signal.
    return { available: false, rankedComponents: [], topComponent: null, score };
  }

  return { available: true, rankedComponents: ranked, topComponent: ranked[0], score };
}

/**
 * Best-effort read. NEVER throws and never blocks generation — a 404, a
 * 400, a network failure, or a missing profession on the backend all
 * resolve to the unavailable signal.
 */
export async function readOpportunitySignal(
  leadId: number | string,
  suppressedComponents: readonly OpportunityComponent[] = [],
): Promise<NormalizedOpportunitySignal> {
  try {
    // Loaded lazily so the deterministic core has no module-scope
    // dependency on the browser API client. Nothing about the read
    // changes: it is still `getOpportunityExplanation()` hitting the
    // existing deterministic explain endpoint.
    const { getOpportunityExplanation } = await import("@/lib/api");
    const explanation = await getOpportunityExplanation(leadId);
    return normalizeExplanation(explanation, suppressedComponents);
  } catch {
    return UNAVAILABLE_SIGNAL;
  }
}
