export type PlanId = "free" | "starter" | "pro" | "premium";
export type GenerationMode = "scrape" | "pool" | "premium";

export type PlanConfig = {
  id: PlanId;
  name: string;
  price: string;
  priceMonthly: number;
  creditsLimit: number;
  maxLeadRequest: number;
  allowInstantPool: boolean;
  allowPremiumPool: boolean;
  allowApiAccess: boolean;
  features: string[];
};

export const PLANS: PlanConfig[] = [
  {
    id: "free",
    name: "Free",
    price: "$0",
    priceMonthly: 0,
    creditsLimit: 100,
    maxLeadRequest: 100,
    allowInstantPool: false,
    allowPremiumPool: false,
    allowApiAccess: false,
    features: ["100 credits / mo", "Live scraping", "Email + website data", "CSV export"],
  },
  {
    id: "starter",
    name: "Starter",
    price: "$49",
    priceMonthly: 49,
    creditsLimit: 500,
    maxLeadRequest: 500,
    allowInstantPool: false,
    allowPremiumPool: false,
    allowApiAccess: false,
    features: ["500 credits / mo", "Email + phone + website", "Instagram discovery", "Built-in CRM"],
  },
  {
    id: "pro",
    name: "Pro",
    price: "$99",
    priceMonthly: 99,
    creditsLimit: 2500,
    maxLeadRequest: 2500,
    allowInstantPool: true,
    allowPremiumPool: false,
    allowApiAccess: true,
    features: ["2,500 credits / mo", "Premium contact data", "Instant pool access", "API access"],
  },
  {
    id: "premium",
    name: "Premium",
    price: "$249",
    priceMonthly: 249,
    creditsLimit: 25000,
    maxLeadRequest: 10000,
    allowInstantPool: true,
    allowPremiumPool: true,
    allowApiAccess: true,
    features: ["25,000 credits / mo", "Premium instant pool", "White-labeled CRM", "Dedicated AM"],
  },
];

export function getPlan(plan?: string | null) {
  return PLANS.find((item) => item.id === plan) ?? PLANS[0];
}
