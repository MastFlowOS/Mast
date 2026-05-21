import type { GenerationMode, PlanId, PlanConfig } from "./plans";

export type { GenerationMode, PlanId } from "./plans";

const rawApiUrl = import.meta.env.VITE_API_URL?.trim() ?? "";
const apiOrigin = rawApiUrl.replace(/\/$/, "");
const API_BASE = apiOrigin
  ? apiOrigin.endsWith("/api")
    ? apiOrigin
    : `${apiOrigin}/api`
  : "/api";

/** Backend origin without the `/api` suffix (e.g. Replit app URL). */
export function getApiOrigin() {
  return apiOrigin;
}

export function requireApiOrigin() {
  if (!apiOrigin) {
    throw new ApiError(
      0,
      "VITE_API_URL is not configured. Set it to your Replit backend URL before building the frontend.",
      { code: "MISSING_API_URL" },
    );
  }
  return apiOrigin;
}

export class ApiError extends Error {
  status: number;
  code?: string;
  payload: unknown;

  constructor(status: number, message: string, payload: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.payload = payload;
    if (payload && typeof payload === "object" && "code" in payload) {
      this.code = String((payload as { code?: unknown }).code);
    }
  }
}

type ApiRequestOptions = Omit<RequestInit, "body"> & {
  body?: unknown;
};

async function readPayload(response: Response) {
  const contentType = response.headers.get("content-type") ?? "";
  if (response.status === 204) return undefined;
  if (contentType.includes("application/json")) return response.json();
  return response.text();
}

export async function apiRequest<T>(path: string, options: ApiRequestOptions = {}): Promise<T> {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  const headers = new Headers(options.headers);
  let body: BodyInit | undefined;

  if (options.body instanceof FormData) {
    body = options.body;
  } else if (options.body !== undefined) {
    headers.set("Content-Type", "application/json");
    body = JSON.stringify(options.body);
  }

  const response = await fetch(`${API_BASE}${normalizedPath}`, {
    ...options,
    headers,
    body,
    credentials: "include",
  });
  const payload = await readPayload(response);

  if (!response.ok) {
    const message =
      payload && typeof payload === "object" && "error" in payload
        ? String((payload as { error?: unknown }).error)
        : response.statusText || "Request failed";
    throw new ApiError(response.status, message, payload);
  }

  return payload as T;
}

export type AuthUser = {
  id: number;
  fullName: string;
  email: string;
  plan: PlanId;
  subscriptionStatus: string;
  creditsLimit: number;
  creditsUsed: number;
  creditsRemaining: number;
};

export type Account = {
  user: Pick<AuthUser, "id" | "fullName" | "email" | "plan" | "subscriptionStatus">;
  subscription: {
    plan: PlanId;
    name: string;
    status: string;
    priceMonthly: number;
    billingPeriodStartedAt?: string | null;
    billingPeriodEndsAt?: string | null;
  };
  credits: {
    limit: number;
    used: number;
    remaining: number;
  };
  limits: {
    maxLeadRequest: number;
    allowedChannels: string[];
    allowInstantPool: boolean;
    allowPremiumPool: boolean;
    allowApiAccess: boolean;
  };
  plans: PlanConfig[];
};

export type Lead = {
  id: number;
  userId?: number | null;
  businessName: string;
  instagramHandle?: string | null;
  email?: string | null;
  website?: string | null;
  phone?: string | null;
  niche?: string | null;
  location?: string | null;
  status: string;
  priority?: string | null;
  notes?: string | null;
  source?: string | null;
  createdAt: string;
  updatedAt: string;
  lastContactedAt?: string | null;
  followUpAt?: string | null;
};

export type LeadsResponse = {
  leads: Lead[];
  pagination?: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
};

export type AnalyticsSummary = {
  totalLeads: number;
  contacted: number;
  replied: number;
  interested: number;
  closed: number;
  dead: number;
  followupsDue: number;
  messagesThisWeek: number;
  replyRate: number;
};

export type SettingsMap = Record<string, string>;

export type LeadGenerationRequest = {
  quantity: number;
  region: string;
  niche: string;
  mode: GenerationMode;
  channels: string[];
};

export type LeadGenerationResponse = {
  leads: Lead[];
  requested: number;
  generated: number;
  cost: number;
  source: string;
  credits: {
    limit: number;
    used: number;
    remaining: number;
  };
};

export function getMe() {
  return apiRequest<{ user: AuthUser | null }>("/auth/me");
}

export function login(body: { email: string; password: string }) {
  return apiRequest<{ user: AuthUser }>("/auth/login", { method: "POST", body });
}

export function signup(body: { fullName: string; email: string; password: string }) {
  return apiRequest<{ user: AuthUser }>("/auth/signup", { method: "POST", body });
}

export function logout() {
  return apiRequest<{ success: boolean }>("/auth/logout", { method: "POST" });
}

export function startGoogleLogin() {
  requireApiOrigin();
  return apiRequest<{ url: string }>("/auth/google/start");
}

export function getAccount() {
  return apiRequest<Account>("/account");
}

export function updateSubscription(plan: PlanId) {
  return apiRequest<Account>("/account/subscription", { method: "PATCH", body: { plan } });
}

export function getLeads(params: Record<string, string | number | undefined> = {}) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== "") search.set(key, String(value));
  }
  const suffix = search.toString() ? `?${search.toString()}` : "";
  return apiRequest<LeadsResponse | Lead[]>(`/leads${suffix}`);
}

export function createLead(body: Partial<Lead> & { businessName: string }) {
  return apiRequest<Lead>("/leads", { method: "POST", body });
}

export function updateLead(id: number, body: Partial<Lead>) {
  return apiRequest<Lead>(`/leads/${id}`, { method: "PATCH", body });
}

export function generateLeads(body: LeadGenerationRequest) {
  return apiRequest<LeadGenerationResponse>("/leads/generate", { method: "POST", body });
}

export function getAnalyticsSummary() {
  return apiRequest<AnalyticsSummary>("/analytics/summary");
}

export function getSettings() {
  return apiRequest<SettingsMap>("/settings");
}

export function updateSettings(body: SettingsMap) {
  return apiRequest<SettingsMap>("/settings", { method: "PATCH", body });
}
