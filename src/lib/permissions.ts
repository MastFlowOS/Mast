/**
 * permissions.ts
 *
 * Centralized capability engine for MAST.
 *
 * Plans are translated into capabilities exactly once here.
 * Every page, component, and backend function consumes capabilities —
 * never plan names directly.
 *
 * Architecture:
 *   PlanId → PLAN_FEATURES → PermissionsManager
 *                                ├── can(feature)
 *                                ├── getFeatureMetadata(feature)
 *                                └── limits
 */

import type { PlanId } from "./plans";

// ─── Feature Identifier Registry ─────────────────────────────────────────────
// Strongly typed identifiers prevent magic strings throughout the app.

export type FeatureId =
  // Core workspace features
  | "relationships"
  | "mission"
  | "pipeline"
  | "importExport"
  // Contact channels
  | "emailChannel"
  | "phoneChannel"
  | "instagramChannel"
  | "websiteChannel"
  // Search coverage
  | "localSearch"
  | "regionalSearch"
  | "instantPool"
  | "premiumPool"
  // AI capabilities
  | "assistedDiscovery"
  | "recommendations"
  | "pipelineCoaching"
  | "executiveBriefings"
  | "weeklyIntelligence"
  | "opportunityInsights";

// ─── Feature Metadata ─────────────────────────────────────────────────────────
// User-facing copy is centralized here.
// Components never hardcode upgrade messages.

export interface FeatureMetadata {
  /** Short display name */
  title: string;
  /** Explanation of the capability */
  description: string;
  /** Upgrade CTA text for locked state */
  upgradeCTA?: string;
  /** Lucide icon identifier string */
  icon?: string;
}

export interface CapabilityInfo extends FeatureMetadata {
  id: FeatureId;
  /** Whether the active plan grants this capability */
  enabled: boolean;
  /** The lowest plan that enables this capability */
  requiredPlan: PlanId;
}

// ─── Global Feature Registry ─────────────────────────────────────────────────

export const FEATURE_REGISTRY: Record<FeatureId, FeatureMetadata> = {
  // Core workspace
  relationships: {
    title: "Relationships Workspace",
    description: "Manage contacts and custom communication history.",
    icon: "Network",
  },
  mission: {
    title: "Mission Follow-ups",
    description: "Automate sequence check-ins, reminders, and timeline scheduling.",
    upgradeCTA: "Upgrade to Starter",
    icon: "Bell",
  },
  pipeline: {
    title: "Pipeline Kanban",
    description: "Visualize deals through customizable stages on a premium kanban board.",
    upgradeCTA: "Upgrade to Pro",
    icon: "Kanban",
  },
  importExport: {
    title: "CSV Import / Export",
    description: "Bulk import or export opportunity lists via CSV spreadsheets.",
    icon: "Upload",
  },

  // Contact channels
  emailChannel: {
    title: "Verified Emails",
    description: "Acquire direct, verified professional emails for outreach.",
    icon: "Mail",
  },
  phoneChannel: {
    title: "Phone Numbers",
    description: "Extract direct mobile/phone contacts for rapid conversations.",
    icon: "Phone",
  },
  instagramChannel: {
    title: "Instagram Profiles",
    description: "Scrape Instagram profile handles and bio data for social outreach.",
    upgradeCTA: "Upgrade to Starter",
    icon: "Instagram",
  },
  websiteChannel: {
    title: "Business Websites",
    description: "Capture business websites, contact forms, and DNS records.",
    upgradeCTA: "Upgrade to Pro",
    icon: "Link2",
  },

  // Search coverage
  localSearch: {
    title: "Local Search",
    description: "Scan opportunities within your default local region.",
    icon: "Navigation",
  },
  regionalSearch: {
    title: "Regional Search",
    description: "Target geographic territories globally across all regions.",
    upgradeCTA: "Upgrade to Starter",
    icon: "Globe2",
  },
  instantPool: {
    title: "Instant Pool Access",
    description: "Instantly fetch opportunities from Mast's pre-verified business pool.",
    upgradeCTA: "Upgrade to Pro",
    icon: "Zap",
  },
  premiumPool: {
    title: "Premium Results Pool",
    description: "Access high-priority decision-makers with mobile-verified contacts.",
    upgradeCTA: "Upgrade to Starter",
    icon: "Sparkles",
  },

  // AI capabilities
  assistedDiscovery: {
    title: "AI-Assisted Discovery",
    description: "Use AI matching to surface the most relevant target opportunities.",
    icon: "Search",
  },
  recommendations: {
    title: "AI Recommendations",
    description: "Get personalized AI recommendations tailored to your acquisition profile.",
    upgradeCTA: "Upgrade to Starter",
    icon: "Sparkles",
  },
  pipelineCoaching: {
    title: "AI Pipeline Coaching",
    description: "Receive AI coaching alerts for stalled deals and optimal outreach sequences.",
    upgradeCTA: "Upgrade to Pro",
    icon: "Brain",
  },
  executiveBriefings: {
    title: "AI Executive Briefings",
    description: "Receive high-level AI summaries of pipeline health and daily focus priorities.",
    upgradeCTA: "Upgrade to Premium",
    icon: "FileText",
  },
  weeklyIntelligence: {
    title: "Weekly Intelligence",
    description: "Reflective 7-day performance reviews with forward-looking action goals.",
    upgradeCTA: "Upgrade to Premium",
    icon: "TrendingUp",
  },
  opportunityInsights: {
    title: "AI Opportunity Insights",
    description: "Advanced insight cards surfacing conversion triggers and outreach patterns.",
    upgradeCTA: "Upgrade to Premium",
    icon: "Eye",
  },
};

// ─── Plan Hierarchy ───────────────────────────────────────────────────────────
// Used to resolve "which plan unlocks this feature" automatically.

export const PLAN_HIERARCHY: PlanId[] = ["free", "starter", "pro", "premium"];

// ─── Plan Capability Configuration ───────────────────────────────────────────
// This is the only place where plans are mapped to capabilities.
// To add a new plan or feature: edit this object only.

export const PLAN_CAPABILITIES: Record<PlanId, FeatureId[]> = {
  free: [
    "relationships",
    "importExport",
    "emailChannel",
    "phoneChannel",
    "localSearch",
    "assistedDiscovery",
  ],
  starter: [
    "relationships",
    "importExport",
    "emailChannel",
    "phoneChannel",
    "localSearch",
    "assistedDiscovery",
    // Starter additions
    "mission",
    "instagramChannel",
    "regionalSearch",
    "premiumPool",
    "recommendations",
  ],
  pro: [
    "relationships",
    "importExport",
    "emailChannel",
    "phoneChannel",
    "localSearch",
    "assistedDiscovery",
    "mission",
    "instagramChannel",
    "regionalSearch",
    "premiumPool",
    "recommendations",
    // Pro additions
    "pipeline",
    "websiteChannel",
    "instantPool",
    "pipelineCoaching",
  ],
  premium: [
    "relationships",
    "importExport",
    "emailChannel",
    "phoneChannel",
    "localSearch",
    "assistedDiscovery",
    "mission",
    "instagramChannel",
    "regionalSearch",
    "premiumPool",
    "recommendations",
    "pipeline",
    "websiteChannel",
    "instantPool",
    "pipelineCoaching",
    // Premium additions
    "executiveBriefings",
    "weeklyIntelligence",
    "opportunityInsights",
  ],
};

// ─── Plan Limits Configuration ────────────────────────────────────────────────

export interface PlanLimits {
  dailyOpportunities: number;
  monthlyOpportunities: number;
  teamSeats: number;
  isUnlimitedSeats: boolean;
}

export const PLAN_LIMITS: Record<PlanId, PlanLimits> = {
  free: {
    dailyOpportunities: 20,
    monthlyOpportunities: 300,
    teamSeats: 1,
    isUnlimitedSeats: false,
  },
  starter: {
    dailyOpportunities: 100,
    monthlyOpportunities: 1500,
    teamSeats: 1,
    isUnlimitedSeats: false,
  },
  pro: {
    dailyOpportunities: 400,
    monthlyOpportunities: 6000,
    teamSeats: 3,
    isUnlimitedSeats: false,
  },
  premium: {
    dailyOpportunities: 1000,
    monthlyOpportunities: 25000,
    teamSeats: 999999,
    isUnlimitedSeats: true,
  },
};

// ─── Permissions Manager ──────────────────────────────────────────────────────

export interface PermissionsManager {
  /** The resolved active plan (includes dev override) */
  readonly plan: PlanId;
  /**
   * Check if the active plan grants the given capability.
   * This is the primary API for permission checks.
   */
  can(feature: FeatureId): boolean;
  /**
   * Retrieve full metadata for a capability — title, description,
   * required plan, enabled state, and upgrade copy.
   * Used by <FeatureGate> and <LockedFeatureOverlay> to resolve
   * upgrade messages without hardcoding them at call sites.
   */
  getFeatureMetadata(feature: FeatureId): CapabilityInfo;
  /** Opportunity and team seat limits for the active plan */
  readonly limits: PlanLimits;
}

// ─── Dev Plan Override ────────────────────────────────────────────────────────
// Allows instant plan switching in development via localStorage.
// Always returns null in production.

export function getDevPlanOverride(): PlanId | null {
  if (!import.meta.env.DEV) return null;
  const stored = localStorage.getItem("mast_dev_plan_override");
  const valid: PlanId[] = ["free", "starter", "pro", "premium"];
  return (valid.includes(stored as PlanId) ? stored : null) as PlanId | null;
}

// ─── Factory ──────────────────────────────────────────────────────────────────

/**
 * buildPermissionsManager
 *
 * Creates a permissions manager from a profile plan.
 * The dev override is applied automatically here — callers never
 * need to know about it.
 *
 * @param profilePlan - the plan stored in the user's database profile
 */
export function buildPermissionsManager(profilePlan: PlanId): PermissionsManager {
  const activePlan = getDevPlanOverride() ?? profilePlan;
  const limits = PLAN_LIMITS[activePlan];

  return {
    plan: activePlan,

    can(feature: FeatureId): boolean {
      return PLAN_CAPABILITIES[activePlan]?.includes(feature) ?? false;
    },

    getFeatureMetadata(feature: FeatureId): CapabilityInfo {
      const meta = FEATURE_REGISTRY[feature];
      const enabled = this.can(feature);
      const requiredPlan =
        PLAN_HIERARCHY.find((p) => PLAN_CAPABILITIES[p].includes(feature)) ?? "free";

      return {
        id: feature,
        enabled,
        requiredPlan,
        ...meta,
      };
    },

    limits,
  };
}
