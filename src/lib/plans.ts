export type PlanId = "free" | "starter" | "pro" | "premium";
export type GenerationMode = "scrape" | "pool" | "premium";

export type PlanConfig = {
  id: PlanId;
  name: string;
  price: string;
  priceMonthly: number;
  creditsLimit: number;
  maxLeadRequest: number;
  /** Daily lead cap */
  dailyLeadLimit: number;
  /** Monthly lead cap */
  monthlyLeadLimit: number;
  allowInstantPool: boolean;
  allowPremiumPool: boolean;
  allowApiAccess: boolean;
  /** AI personalisation tier */
  aiAccess: "none" | "limited" | "standard" | "full";
  features: string[];
};

export const PLANS: PlanConfig[] = [
  {
    id: "free",
    name: "Free",
    price: "$0",
    priceMonthly: 0,
    creditsLimit: 300,
    maxLeadRequest: 20,
    dailyLeadLimit: 20,
    monthlyLeadLimit: 300,
    allowInstantPool: false,
    allowPremiumPool: false,
    allowApiAccess: false,
    aiAccess: "limited",
    features: [
      "20 opportunities / day (300 / mo)",
      "AI Opportunity Discovery",
      "Business emails & websites",
      "CSV Import / Export",
      "1 Seat",
    ],
  },
  {
    id: "starter",
    name: "Starter",
    price: "$29",
    priceMonthly: 29,
    creditsLimit: 1500,
    maxLeadRequest: 100,
    dailyLeadLimit: 100,
    monthlyLeadLimit: 1500,
    allowInstantPool: false,
    allowPremiumPool: true,
    allowApiAccess: false,
    aiAccess: "limited",
    features: [
      "100 opportunities / day (1,500 / mo)",
      "Relationships Workspace",
      "AI discovery recommendations",
      "Business emails, phones & Instagram",
      "1 Seat",
    ],
  },
  {
    id: "pro",
    name: "Pro",
    price: "$79",
    priceMonthly: 79,
    creditsLimit: 6000,
    maxLeadRequest: 400,
    dailyLeadLimit: 400,
    monthlyLeadLimit: 6000,
    allowInstantPool: true,
    allowPremiumPool: true,
    allowApiAccess: true,
    aiAccess: "standard",
    features: [
      "400 opportunities / day (6,000 / mo)",
      "Pipeline & Relationships Workspace",
      "Mission Follow-ups",
      "AI pipeline coaching & recommendations",
      "Regional & national search",
      "3 Seats",
    ],
  },
  {
    id: "premium",
    name: "Premium",
    price: "$199",
    priceMonthly: 199,
    creditsLimit: 25000,
    maxLeadRequest: 1000,
    dailyLeadLimit: 1000,
    monthlyLeadLimit: 25000,
    allowInstantPool: true,
    allowPremiumPool: true,
    allowApiAccess: true,
    aiAccess: "full",
    features: [
      "1,000 opportunities / day (25,000 / mo)",
      "Pipeline, Relationships & Follow-ups",
      "AI Executive Briefings & Weekly Intelligence",
      "AI coaching & opportunity insights",
      "Unlimited Team Seats",
      "Global search",
    ],
  },
];

export function getPlan(plan?: string | null) {
  return PLANS.find((item) => item.id === plan) ?? PLANS[0];
}
