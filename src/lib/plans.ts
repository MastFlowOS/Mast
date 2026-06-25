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
      "20 leads / day (300 / mo)",
      "CSV Export",
      "Basic CRM",
      "Limited AI Personalization",
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
      "100 leads / day (1,500 / mo)",
      "Built-in CRM",
      "Better AI Personalization",
      "Premium Lead Pools",
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
      "400 leads / day (6,000 / mo)",
      "Full Pipeline CRM",
      "Premium Lead Pools",
      "AI Personalization",
      "Automations",
      "Sequences",
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
      "1000 leads / day (25,000 / mo)",
      "Everything Included",
      "Full Automations",
      "Unlimited Team Seats",
      "Highest AI Personalization",
      "Premium Lead Pools",
    ],
  },
];

export function getPlan(plan?: string | null) {
  return PLANS.find((item) => item.id === plan) ?? PLANS[0];
}
