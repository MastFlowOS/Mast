import type { GenerationMode, PlanId, PlanConfig } from "./plans";
import { getPlan, PLANS } from "./plans";
import { supabase } from "./supabase";
import { addNotification } from "./notifications";
import { buildPermissionsManager, getDevPlanOverride, type FeatureId } from "./permissions";
import { UsageService } from "./usage";
import type { ProgressionEventTotals, ProgressionMetric } from "./progression";


export type { GenerationMode, PlanId } from "./plans";

// ─── Error class (kept for components that import it) ─────────────────────────
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

/** Always returns false — kept for AIAssistant / EmailForm compatibility. */
export function isMissingBackendEndpoint(_error: unknown): boolean {
  return false;
}

// ─── Opportunity Engine backend (Part 3) ───────────────────────────────────────
// Separate service from Supabase — see mast-backend. Only `/v1/discover` is
// called from here today; everything else (leads CRUD, settings, etc.)
// still talks to Supabase directly, unchanged.
const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL as string | undefined)?.replace(/\/$/, "");

async function backendFetch<T>(path: string, options: RequestInit = {}): Promise<T> {
  if (!API_BASE_URL) {
    throw new ApiError(0, "VITE_API_BASE_URL is not configured", {});
  }
  if (!supabase) throw new ApiError(0, "Supabase not configured", {});

  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session) throw new ApiError(401, "Not authenticated", {});

  const res = await fetch(`${API_BASE_URL}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${session.access_token}`,
      ...(options.headers ?? {}),
    },
  });

  const payload = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new ApiError(res.status, (payload as { message?: string }).message ?? res.statusText, payload);
  }
  return payload as T;
}

// ─── Auth types ───────────────────────────────────────────────────────────────
export type AuthUser = {
  id: string;
  fullName: string;
  email: string;
  plan: PlanId;
  subscriptionStatus: string;
  creditsLimit: number;
  creditsUsed: number;
  creditsRemaining: number;
  emailConfirmed?: boolean;
  monthlyLeadsUsed: number;
  dailyLeadsUsed: number;
  nextDailyReset: string | null;
  nextMonthlyReset: string | null;
  pendingPlanChange: PlanId | null;
  workspaceStatus?: string;
  /** True once the user has completed the "Personalize Your Workspace" onboarding flow. */
  onboardingCompleted: boolean;
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
    pendingPlanChange?: PlanId | null;
  };
  credits: {
    limit: number;
    used: number;
    remaining: number;
  };
  dailyUsage: {
    used: number;
    limit: number;
    remaining: number;
    resetsAt?: string | null;
  };
  monthlyUsage: {
    used: number;
    limit: number;
    remaining: number;
    resetsAt?: string | null;
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

// ─── Lead types ───────────────────────────────────────────────────────────────
export type LeadStatus =
  | "new"
  | "email_sent"
  | "called"
  | "instagram_sent"
  | "replied"
  | "meeting_booked"
  | "closed"
  | "dead";

export type OutreachChannel = "email" | "instagram" | "phone" | "contact_form";

export type LeadActivityType =
  | "opportunity_discovered"
  | "company_analyzed"
  | "contact_verified"
  | "workspace_prepared"
  | "ready_for_outreach"
  | "workspace_opened"
  | "email_sent"
  | "reply_received"
  | "meeting_booked"
  | "proposal_sent"
  | "deal_closed"
  | "message_generated"
  | "note_added"
  | "status_changed";

export type ProgressionEventType = ProgressionMetric;

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
  igFollowers?: string | null;
  igBio?: string | null;
  igLastPost?: string | null;
  igPostDescription?: string | null;
  brandingNotes?: string | null;
  websiteNotes?: string | null;
  priority?: string | null;
  tags?: string | null;
  notes?: string | null;
  source?: string | null;
  createdAt: string;
  updatedAt: string;
  lastContactedAt?: string | null;
  followUpAt?: string | null;
  /** Opportunity Engine (Part 3) fields — populated for leads delivered via Discover, null for older/manual leads. */
  businessId?: string | null;
  opportunityScore?: number | null;
  professionSlug?: string | null;
};

export type CreateLeadBody = Partial<
  Pick<
    Lead,
    | "instagramHandle"
    | "email"
    | "website"
    | "phone"
    | "niche"
    | "location"
    | "status"
    | "igFollowers"
    | "igBio"
    | "igLastPost"
    | "igPostDescription"
    | "brandingNotes"
    | "websiteNotes"
    | "notes"
    | "priority"
    | "tags"
    | "source"
  >
> & { businessName: string };

export type UpdateLeadBody = Partial<Omit<Lead, "id" | "userId" | "createdAt" | "updatedAt">>;

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

export type PipelineStat = {
  status: string;
  count: number;
  label?: string;
};

export type ActivityItem = {
  id: number | string;
  type: string;
  description: string;
  leadName?: string | null;
  channel?: string | null;
  createdAt: string;
};

export type Message = {
  id: number | string;
  leadId: number;
  channel: string;
  template: string;
  subject?: string | null;
  content: string;
  status: string;
  sentAt?: string | null;
  createdAt: string;
  updatedAt: string;
};

export type Followup = {
  id: number | string;
  leadId: number;
  channel: string;
  dueAt: string;
  completedAt?: string | null;
  notes?: string | null;
  status: string;
  sequenceName?: string | null;
  stepNumber?: number | null;
  currentStep?: string | null;
  createdAt: string;
  updatedAt: string;
};

export type FollowupWithLead = Followup & {
  lead?: Lead;
};

export type LeadActivity = {
  id: number | string;
  leadId: number;
  type: LeadActivityType;
  timestamp: string;
  content: string;
  channel?: OutreachChannel;
  subject?: string | null;
  body?: string | null;
  metadata?: Record<string, unknown> | null;
};

export type OutreachGenerationAction = "generate" | "rewrite" | "objections";
export type OutreachTone = "friendly" | "professional" | "direct";

export type OutreachDraftRequest = {
  channel: OutreachChannel;
  action?: OutreachGenerationAction;
  tone?: OutreachTone;
  template?: string;
  customInstructions?: string;
  subject?: string;
  body?: string;
  senderName?: string;
  senderEmail?: string;
  signature?: string;
};

export type OutreachDraftResponse = {
  subject?: string | null;
  body?: string | null;
  message?: string | null;
  content?: string | null;
  draft?: {
    subject?: string | null;
    body?: string | null;
    message?: string | null;
  };
};

export type SendEmailRequest = {
  subject: string;
  body: string;
};

export type SendLeadEmailResponse = {
  success: boolean;
  lead?: Lead;
  message?: Message;
};

export type BulkImportResult = {
  imported: number;
  skipped: number;
  failed?: number;
  leads?: Lead[];
  errors?: Array<{ row: number; reason: string }>;
};

export type BulkUpdateResult = {
  updated: number;
};

export type BulkDeleteResult = {
  deleted: number;
};

export type SettingsMap = Record<string, string>;

export type LeadGenerationRequest = {
  quantity: number;
  region: string;
  niche: string;
  mode: GenerationMode;
  channels: string[];
  /** Target currencies, if any — narrows which countries get searched per
   * region to ones where discovered businesses can realistically pay in
   * that currency. */
  currencies?: string[];
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
  /** The scrape_jobs id — pass to subscribeToDiscoverJob() to watch it resolve. */
  jobId: string;
  /** The ACTUAL mode the backend used, derived server-side from the user's real plan — not necessarily what was requested. */
  mode: GenerationMode;
  /**
   * True when more opportunities may still arrive for this job after this
   * call returns: always true for Free's Live Discovery (nothing has
   * landed yet), and true for Starter/Pro/Premium when the pool fell short
   * and a follow-up scrape is running under the same job id.
   */
  pending: boolean;
};

type DiscoverBackendResponse = {
  jobId: string;
  mode: GenerationMode;
  status: "queued" | "streaming" | "completed" | "failed";
  requested: number;
  delivered?: number;
  shortfall?: number;
  backgroundExpansionQueued?: boolean;
  results?: Array<{ businessId: string; opportunityScore: number | null }>;
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

function dbRowToLead(row: Record<string, unknown>): Lead {
  return {
    id: row.id as number,
    userId: (row.user_id as number | null) ?? null,
    businessName: (row.business_name as string) ?? "",
    instagramHandle: (row.instagram_handle as string | null) ?? null,
    email: (row.email as string | null) ?? null,
    website: (row.website as string | null) ?? null,
    phone: (row.phone as string | null) ?? null,
    niche: (row.niche as string | null) ?? null,
    location: (row.location as string | null) ?? null,
    status: (row.status as string) ?? "discovered",
    igFollowers: (row.ig_followers as string | null) ?? null,
    igBio: (row.ig_bio as string | null) ?? null,
    igLastPost: (row.ig_last_post as string | null) ?? null,
    igPostDescription: (row.ig_post_description as string | null) ?? null,
    brandingNotes: (row.branding_notes as string | null) ?? null,
    websiteNotes: (row.website_notes as string | null) ?? null,
    priority: (row.priority as string | null) ?? null,
    tags: (row.tags as string | null) ?? null,
    notes: (row.notes as string | null) ?? null,
    source: (row.source as string | null) ?? null,
    createdAt: (row.created_at as string) ?? new Date().toISOString(),
    updatedAt: (row.updated_at as string) ?? new Date().toISOString(),
    lastContactedAt: (row.last_contacted_at as string | null) ?? null,
    followUpAt: (row.follow_up_at as string | null) ?? null,
    businessId: (row.business_id as string | null) ?? null,
    opportunityScore: (row.opportunity_score as number | null) ?? null,
    professionSlug: (row.profession_slug as string | null) ?? null,
  };
}

function leadToDbRow(body: Partial<Lead & CreateLeadBody>) {
  const row: Record<string, unknown> = {};
  if (body.businessName !== undefined) row.business_name = body.businessName;
  if (body.instagramHandle !== undefined) row.instagram_handle = body.instagramHandle;
  if (body.email !== undefined) row.email = body.email;
  if (body.website !== undefined) row.website = body.website;
  if (body.phone !== undefined) row.phone = body.phone;
  if (body.niche !== undefined) row.niche = body.niche;
  if (body.location !== undefined) row.location = body.location;
  if (body.status !== undefined) row.status = body.status;
  if (body.igFollowers !== undefined) row.ig_followers = body.igFollowers;
  if (body.igBio !== undefined) row.ig_bio = body.igBio;
  if (body.igLastPost !== undefined) row.ig_last_post = body.igLastPost;
  if (body.igPostDescription !== undefined) row.ig_post_description = body.igPostDescription;
  if (body.brandingNotes !== undefined) row.branding_notes = body.brandingNotes;
  if (body.websiteNotes !== undefined) row.website_notes = body.websiteNotes;
  if (body.priority !== undefined) row.priority = body.priority;
  if (body.tags !== undefined) row.tags = body.tags;
  if (body.notes !== undefined) row.notes = body.notes;
  if (body.source !== undefined) row.source = body.source;
  if (body.lastContactedAt !== undefined) row.last_contacted_at = body.lastContactedAt;
  if (body.followUpAt !== undefined) row.follow_up_at = body.followUpAt;
  return row;
}

function backendModeToGenerationMode(mode: string): GenerationMode {
  if (mode === "live") return "scrape";
  if (mode === "instant_pool_ranked") return "premium";
  return "pool"; // instant_pool
}

async function currentCreditsSnapshot(userId: string) {
  const status = await UsageService.getUsageStatus(userId);
  return { limit: status.monthlyLimit, used: status.monthlyUsed, remaining: status.monthlyRemaining };
}

/**
 * Subscribes to a discover job's live results. Calls `onLead` for every new
 * CRM row (`leads`) that lands under this job id, and `onStatusChange`
 * whenever the job's `scrape_jobs` row moves (queued -> streaming ->
 * completed | completed_partial | cancelled | failed). Returns an unsubscribe
 * function.
 *
 * This is what makes both Free's Live Discovery AND a Starter/Pro Instant
 * Discovery shortfall's follow-up feel like one continuous stream — the
 * caller never needs to know which underlying path produced a given lead.
 */
export type DiscoverJobStatus = "queued" | "running" | "streaming" | "completed" | "completed_partial" | "cancelled" | "failed";

export function subscribeToDiscoverJob(
  jobId: string,
  handlers: {
    onLead: (lead: Lead) => void;
    onStatusChange: (status: DiscoverJobStatus, resultsCount: number) => void;
  },
): () => void {
  if (!supabase) return () => {};

  const channel = supabase
    .channel(`discover-job-${jobId}`)
    .on(
      "postgres_changes",
      { event: "INSERT", schema: "public", table: "leads", filter: `scrape_job_id=eq.${jobId}` },
      (payload) => handlers.onLead(dbRowToLead(payload.new as Record<string, unknown>)),
    )
    .on(
      "postgres_changes",
      { event: "UPDATE", schema: "public", table: "scrape_jobs", filter: `id=eq.${jobId}` },
      (payload) => {
        const row = payload.new as { status: string; results_count: number };
        handlers.onStatusChange(row.status as DiscoverJobStatus, row.results_count ?? 0);
      },
    )
    .subscribe();

  return () => {
    supabase?.removeChannel(channel);
  };
}

/**
 * Cancels an in-flight discover job. The worker will detect the status
 * change on its next per-lead loop iteration and stop cleanly.
 * Resolves with { jobId, status: "cancelled" } on success.
 * Throws ApiError if the job is already terminal (409) or not found (404).
 */
export async function cancelDiscoverJob(jobId: string): Promise<{ jobId: string; status: string }> {
  return backendFetch<{ jobId: string; status: string }>(`/v1/discover/${jobId}/cancel`, { method: "POST" });
}



async function requireUserId(): Promise<string> {
  if (!supabase) throw new ApiError(0, "Supabase not configured", {});
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) throw new ApiError(401, "Not authenticated", {});
  return session.user.id;
}

async function enforceCapability(featureId: FeatureId): Promise<void> {
  const userId = await requireUserId();
  const { data: profile } = await supabase!
    .from("profiles")
    .select("subscription_plan")
    .eq("id", userId)
    .single();
  const plan = getDevPlanOverride() || ((profile?.subscription_plan as PlanId) || "free");
  const permissions = buildPermissionsManager(plan);
  if (!permissions.can(featureId)) {
    throw new ApiError(403, `Access denied: feature '${featureId}' is restricted under your plan.`, {});
  }
}

async function enforceTeamSeatLimit(): Promise<void> {
  const userId = await requireUserId();
  const { data: profile } = await supabase!
    .from("profiles")
    .select("subscription_plan")
    .eq("id", userId)
    .single();
  const plan = getDevPlanOverride() || ((profile?.subscription_plan as PlanId) || "free");
  const permissions = buildPermissionsManager(plan);
  
  // Query active team members (simulated as 1 since no multi-tenant workspace UI is present)
  const currentMembersCount = 1;
  if (currentMembersCount > permissions.limits.teamSeats) {
    throw new ApiError(403, `Active team members exceed the limit of ${permissions.limits.teamSeats} seat(s) for your plan.`, {});
  }
}

// ─── Auth ─────────────────────────────────────────────────────────────────────

// ─── Reset & Usage State checks (Lazy reset) ──────────────────────────────────

async function checkAndResetUsage(profile: any): Promise<any> {
  if (!supabase || !profile) return profile;

  const now = new Date();
  let dailyUsed = profile.daily_leads_used ?? 0;
  let monthlyUsed = profile.monthly_leads_used ?? 0;
  let dailyReset = profile.next_daily_reset;
  let monthlyReset = profile.next_monthly_reset;
  let activePlan = profile.subscription_plan || "free";
  let pendingPlan = profile.pending_plan_change || null;
  let needsUpdate = false;
  let monthlyResetTriggered = false;

  // Daily Reset check
  if (!dailyReset || new Date(dailyReset) <= now) {
    const wasInitialized = !!profile.next_daily_reset;
    dailyUsed = 0;
    dailyReset = new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString();
    needsUpdate = true;
    if (wasInitialized) {
      addNotification({
        icon: "CheckCircle2",
        iconColor: "text-emerald-400",
        iconBg: "bg-emerald-400/10 border-emerald-400/20",
        title: "Daily Credits Reset",
        body: "Your daily lead generation limit has been reset. Start acquiring new clients!",
        category: "notifyCreditsReset",
      });
    }
  }

  // Monthly Reset check
  if (!monthlyReset || new Date(monthlyReset) <= now) {
    monthlyUsed = 0;
    monthlyResetTriggered = true;

    // Apply pending downgrade plan on monthly cycle reset
    if (pendingPlan) {
      activePlan = pendingPlan;
      pendingPlan = null;
    }

    const nextMonth = new Date();
    nextMonth.setMonth(now.getMonth() + 1);
    monthlyReset = nextMonth.toISOString();
    needsUpdate = true;
  }

  if (needsUpdate) {
    console.log("[Mast:checkAndResetUsage] Lazy reset triggered for user", profile.id);
    const updateObj: Record<string, unknown> = {
      daily_leads_used: dailyUsed,
      monthly_leads_used: monthlyUsed,
      next_daily_reset: dailyReset,
      next_monthly_reset: monthlyReset,
    };

    // Only touch plan fields when the monthly branch actually recomputed them.
    // A daily-only reset must never re-write subscription_plan / pending_plan_change,
    // since doing so can clobber a plan change that committed concurrently elsewhere.
    if (monthlyResetTriggered) {
      updateObj.subscription_plan = activePlan;
      updateObj.pending_plan_change = pendingPlan;
    }

    const { error } = await supabase
      .from("profiles")
      .update(updateObj)
      .eq("id", profile.id);

    if (error) {
      console.error("[Mast:checkAndResetUsage] Error writing lazy reset to DB:", error.message);
    } else {
      return {
        ...profile,
        ...updateObj,
      };
    }
  }

  return profile;
}

// ─── Auth ─────────────────────────────────────────────────────────────────────

export async function getMe() {
  if (!supabase) return { user: null };
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) return { user: null };

  console.log("[Mast:getMe] profiles query → request started", { userId: session.user.id });
  const { data: profile, error } = await supabase
    .from("profiles")
    .select("*")
    .eq("id", session.user.id)
    .single();

  if (error) {
    if (error.code === "PGRST116") {
      console.warn("[Mast:getMe] profiles query → no row found (PGRST116).", { userId: session.user.id });
    } else {
      console.error("[Mast:getMe] profiles query → error", { message: error.message, code: error.code });
    }
  } else {
    console.log("[Mast:getMe] profiles query → success", { plan: profile?.subscription_plan ?? "none" });
  }

  const emailConfirmed = session.user.email_confirmed_at ? true : false;
  
  // Lazy reset checks
  let activeProfile = profile;
  if (profile) {
    activeProfile = await checkAndResetUsage(profile);
  }

  const resolvedPlan = getDevPlanOverride() || ((activeProfile?.subscription_plan as PlanId) || "free");
  const permissions = buildPermissionsManager(resolvedPlan);
  const monthlyLimit = permissions.limits.monthlyOpportunities;
  const monthlyUsed = activeProfile?.monthly_leads_used ?? 0;
  const monthlyRemaining = Math.max(0, monthlyLimit - monthlyUsed);

  const user: AuthUser = {
    id: session.user.id,
    fullName: activeProfile?.full_name || session.user.user_metadata?.full_name || session.user.user_metadata?.fullName || "",
    email: session.user.email || "",
    plan: resolvedPlan,
    subscriptionStatus: "active",
    creditsLimit: monthlyLimit,
    creditsUsed: monthlyUsed,
    creditsRemaining: monthlyRemaining,
    emailConfirmed,
    monthlyLeadsUsed: monthlyUsed,
    dailyLeadsUsed: activeProfile?.daily_leads_used ?? 0,
    nextDailyReset: activeProfile?.next_daily_reset ?? null,
    nextMonthlyReset: activeProfile?.next_monthly_reset ?? null,
    pendingPlanChange: (activeProfile?.pending_plan_change as PlanId) || null,
    workspaceStatus: (activeProfile?.settings as Record<string, any>)?.workspaceStatus || "active",
    onboardingCompleted: (activeProfile?.settings as Record<string, any>)?.onboardingCompleted === "true",
  };
  return { user };
}

export async function login(body: { email: string; password: string }) {
  if (!supabase) throw new Error("Supabase is not configured.");
  console.log("[Mast:login] signInWithPassword → request started", { email: body.email });
  const { data, error } = await supabase.auth.signInWithPassword({ email: body.email, password: body.password });
  if (error) { console.error("[Mast:login] error", { message: error.message }); throw error; }
  if (!data.user) throw new Error("No user found");
  const me = await getMe();
  if (!me.user) throw new Error("Failed to load user profile");
  return { user: me.user };
}

export async function signup(body: { fullName: string; email: string; password: string; phoneNumber?: string }) {
  if (!supabase) throw new Error("Supabase is not configured.");
  console.log("[Mast:signup] signUp → request started", { email: body.email });
  const { data, error } = await supabase.auth.signUp({
    email: body.email,
    password: body.password,
    options: {
      emailRedirectTo: `${window.location.origin}/auth/callback`,
      data: { full_name: body.fullName, phone_number: body.phoneNumber || "" },
    },
  });
  if (error) { console.error("[Mast:signup] error", { message: error.message }); throw error; }
  if (!data.user) throw new Error("Registration failed");
  if (!data.session) {
    return { user: null, needsEmailVerification: true, pendingUserId: data.user.id };
  }
  const me = await getMe();
  return { user: me.user ?? null, needsEmailVerification: false };
}

export async function logout() {
  if (!supabase) return { success: true };
  const { error } = await supabase.auth.signOut();
  if (error) throw error;
  return { success: true };
}

export async function startGoogleLogin() {
  if (!supabase) throw new Error("Supabase is not configured.");
  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: "google",
    options: {
      skipBrowserRedirect: true,
      redirectTo: `${window.location.origin}/auth/callback`,
      queryParams: {
        prompt: "select_account",
      },
    },
  });
  if (error) throw error;
  return { url: data.url };
}

// ─── Account (Supabase-only) ──────────────────────────────────────────────────

function buildAccountFromProfile(userId: string, activeProfile: any): Account {
  const resolvedPlan = getDevPlanOverride() || ((activeProfile?.subscription_plan as PlanId) || "free");
  const permissions = buildPermissionsManager(resolvedPlan);
  const planConfig = getPlan(permissions.plan);

  const dailyLimit = permissions.limits.dailyOpportunities;
  const monthlyLimit = permissions.limits.monthlyOpportunities;

  const dailyUsed = activeProfile?.daily_leads_used ?? 0;
  const monthlyUsed = activeProfile?.monthly_leads_used ?? 0;

  const dailyRemaining = Math.max(0, dailyLimit - dailyUsed);
  const monthlyRemaining = Math.max(0, monthlyLimit - monthlyUsed);

  // Determine allowed channels from permissions
  const allowedChannels: string[] = ["email", "phone"];
  if (permissions.can("instagramChannel")) allowedChannels.push("instagram");
  if (permissions.can("websiteChannel")) allowedChannels.push("website");

  return {
    user: {
      id: userId,
      fullName: activeProfile?.full_name ?? "",
      email: activeProfile?.email ?? "",
      plan: permissions.plan,
      subscriptionStatus: "active",
    },
    subscription: {
      plan: permissions.plan,
      name: planConfig.name,
      status: "active",
      priceMonthly: planConfig.priceMonthly,
      billingPeriodStartedAt: null,
      billingPeriodEndsAt: activeProfile?.next_monthly_reset || null,
      pendingPlanChange: (activeProfile?.pending_plan_change as PlanId) || null,
    },
    credits: { limit: monthlyLimit, used: monthlyUsed, remaining: monthlyRemaining },
    dailyUsage: {
      used: dailyUsed,
      limit: dailyLimit,
      remaining: dailyRemaining,
      resetsAt: activeProfile?.next_daily_reset || null,
    },
    monthlyUsage: {
      used: monthlyUsed,
      limit: monthlyLimit,
      remaining: monthlyRemaining,
      resetsAt: activeProfile?.next_monthly_reset || null,
    },
    limits: {
      maxLeadRequest: planConfig.maxLeadRequest,
      allowedChannels,
      allowInstantPool: permissions.can("instantPool"),
      allowPremiumPool: permissions.can("premiumPool"),
      allowApiAccess: permissions.plan !== "free" && permissions.plan !== "starter",
    },
    plans: PLANS,
  };
}

  export async function getAccount(): Promise<Account> {
  const userId = await requireUserId();
  const { data: profile, error } = await supabase!.from("profiles").select("*").eq("id", userId).single();
  if (error) throw new ApiError(500, error.message, error);

  const activeProfile = await checkAndResetUsage(profile);
  return buildAccountFromProfile(userId, activeProfile);
}

export async function updateSubscription(plan: PlanId): Promise<Account> {
  const userId = await requireUserId();

  // Single read to decide upgrade vs. downgrade — no second getAccount() call
  // after the write, since that was firing a redundant checkAndResetUsage pass
  // that could race with this very update.
  const currentAccount = await getAccount();
  const currentPlanConfig = getPlan(currentAccount.subscription.plan);
  const targetPlanConfig = getPlan(plan);

  const isDowngrade = targetPlanConfig.priceMonthly < currentPlanConfig.priceMonthly;

  const patch = isDowngrade
    ? { pending_plan_change: plan }
    : { subscription_plan: plan, pending_plan_change: null };

  const { data: updated, error } = await supabase!
    .from("profiles")
    .update(patch)
    .eq("id", userId)
    .select()
    .single();

  if (error) throw new ApiError(500, error.message, error);

  return buildAccountFromProfile(userId, updated);
}

// ─── Leads (Supabase) ─────────────────────────────────────────────────────────

export async function getLeads(params: Record<string, string | number | undefined> = {}): Promise<LeadsResponse> {
  const userId = await requireUserId();
  let query = supabase!.from("leads").select("*", { count: "exact" }).eq("user_id", userId);

  if (params.search) {
    const s = `%${params.search}%`;
    query = query.or(`business_name.ilike.${s},email.ilike.${s},instagram_handle.ilike.${s}`);
  }
  if (params.status) query = query.eq("status", params.status);
  if (params.niche) query = query.eq("niche", params.niche);

  const limit = Number(params.limit ?? 100);
  const page = Number(params.page ?? 1);
  const offset = (page - 1) * limit;

  query = query.order("created_at", { ascending: false }).range(offset, offset + limit - 1);

  const { data, error, count } = await query;
  if (error) throw new ApiError(500, error.message, error);

  const leads = (data ?? []).map(dbRowToLead);
  return {
    leads,
    pagination: { page, limit, total: count ?? leads.length, totalPages: Math.ceil((count ?? leads.length) / limit) },
  };
}

export async function getLead(id: number | string): Promise<Lead> {
  const userId = await requireUserId();
  const { data, error } = await supabase!.from("leads").select("*").eq("id", id).eq("user_id", userId).single();
  if (error) throw new ApiError(404, "Lead not found", error);
  return dbRowToLead(data);
}

export async function createLead(body: CreateLeadBody): Promise<Lead> {
  const userId = await requireUserId();
  
  // Enforce usage limit check and consumption
  await UsageService.consumeAllowance(userId, 1);

  const row = { ...leadToDbRow(body as Partial<Lead>), user_id: userId };
  const { data, error } = await supabase!.from("leads").insert(row).select().single();
  if (error) throw new ApiError(500, error.message, error);
  return dbRowToLead(data);
}

export async function updateLead(id: number, body: UpdateLeadBody): Promise<Lead> {
  const userId = await requireUserId();

  // Enforce restricted pipeline status update
  if (body.status && !["new", "ready"].includes(body.status)) {
    await enforceCapability("pipeline");
  }

  const row = leadToDbRow(body as Partial<Lead>);
  row.updated_at = new Date().toISOString();
  const { data, error } = await supabase!.from("leads").update(row).eq("id", id).eq("user_id", userId).select().single();
  if (error) throw new ApiError(500, error.message, error);
  return dbRowToLead(data);
}

export async function deleteLead(id: number): Promise<void> {
  const userId = await requireUserId();
  const { error } = await supabase!.from("leads").delete().eq("id", id).eq("user_id", userId);
  if (error) throw new ApiError(500, error.message, error);
}

export async function bulkUpdateLeads(body: { ids: number[]; updates: UpdateLeadBody }): Promise<BulkUpdateResult> {
  await Promise.all(body.ids.map((id) => updateLead(id, body.updates)));
  return { updated: body.ids.length };
}

export async function bulkDeleteLeads(body: { ids: number[] }): Promise<BulkDeleteResult> {
  const userId = await requireUserId();
  const { error } = await supabase!.from("leads").delete().in("id", body.ids).eq("user_id", userId);
  if (error) throw new ApiError(500, error.message, error);
  return { deleted: body.ids.length };
}

export async function bulkImportLeads(body: { leads: CreateLeadBody[] }): Promise<BulkImportResult> {
  const userId = await requireUserId();
  
  // Centralized check for the total batch size before importing
  await UsageService.checkAllowance(userId, body.leads.length);

  const leads: Lead[] = [];
  const errors: Array<{ row: number; reason: string }> = [];
  for (const [index, lead] of body.leads.entries()) {
    try {
      leads.push(await createLead(lead));
    } catch (err) {
      errors.push({ row: index + 1, reason: err instanceof Error ? err.message : "Import failed" });
    }
  }
  return { imported: leads.length, skipped: 0, failed: errors.length, leads, errors };
}

// Lead generation is handled by the external Python backend.
// When disconnected or during local operations, we validate limits and return mock leads.
export async function generateLeads(body: LeadGenerationRequest): Promise<LeadGenerationResponse> {
  const userId = await requireUserId();

  // Client-side pre-flight check + lazy daily/monthly reset — reused as-is
  // from the previous mock. This is a fast-fail / UX convenience only; the
  // gateway re-checks the same limits server-side and is the authoritative
  // enforcement (see mast-backend src/routes/discover.ts).
  await UsageService.checkAllowance(userId, body.quantity);
  const { data: profile, error: profileErr } = await supabase!.from("profiles").select("*").eq("id", userId).single();
  if (profileErr) throw new ApiError(500, profileErr.message, profileErr);
  const activeProfile = await checkAndResetUsage(profile);

  // Channel/region restrictions — reused as-is from the mock. NOTE: this is
  // a client-side pre-check only; the gateway (mast-backend) does not yet
  // re-enforce these server-side (it enforces plan/credit/daily/monthly
  // limits, but not per-channel or regional-search gating). Flagged as a
  // gap in Phase 4 deliverables, not fixed here — it's a backend change,
  // out of scope for "Discover integration."
  const resolvedPlan = getDevPlanOverride() || ((activeProfile?.subscription_plan as PlanId) || "free");
  const permissions = buildPermissionsManager(resolvedPlan);

  const requiredChannels: Record<string, FeatureId> = {
    instagram: "instagramChannel",
    website: "websiteChannel",
  };
  for (const ch of body.channels) {
    const feat = requiredChannels[ch];
    if (feat && !permissions.can(feat)) {
      throw new ApiError(403, `Channel ${ch} is restricted under your plan.`, {});
    }
  }
  const requestedRegions = body.region
    .split(",")
    .map((r) => r.trim())
    .filter(Boolean);
  if (requestedRegions.some((r) => r !== "North America") && !permissions.can("regionalSearch")) {
    throw new ApiError(403, "Regional search is restricted under your plan.", {});
  }

  // Note: `body.mode` (the UI's speed selector) is NOT sent — the backend
  // derives the real discovery mode from the user's actual subscription
  // plan, per the product philosophy ("MAST decides, not the user"). See
  // Phase 4 deliverables notes for the resulting UI inconsistency this
  // surfaces in the speed selector, flagged there rather than silently
  // papered over here.
  const backendResponse = await backendFetch<DiscoverBackendResponse>("/v1/discover", {
    method: "POST",
    body: JSON.stringify({
      quantity: body.quantity,
      region: body.region,
      niche: body.niche,
      channels: body.channels,
      currencies: body.currencies ?? [],
    }),
  });

  const credits = await currentCreditsSnapshot(userId);
  const mode = backendModeToGenerationMode(backendResponse.mode);

  if (backendResponse.status === "queued") {
    // Free tier — nothing has been delivered yet. Caller must subscribe via
    // subscribeToDiscoverJob(jobId, ...) to receive leads as they stream in.
    return {
      leads: [],
      requested: backendResponse.requested,
      generated: 0,
      cost: 0,
      source: "live_scrape",
      credits,
      jobId: backendResponse.jobId,
      mode,
      pending: true,
    };
  }

  // Instant Discovery — whatever the pool already had is in `leads` by now;
  // the gateway only returned business ids + scores, so fetch the actual
  // CRM rows the same way the rest of the app reads leads.
  const { data: rows, error: rowsErr } = await supabase!
    .from("leads")
    .select("*")
    .eq("scrape_job_id", backendResponse.jobId)
    .order("created_at", { ascending: true });
  if (rowsErr) throw new ApiError(500, rowsErr.message, rowsErr);

  const leads = (rows ?? []).map(dbRowToLead);

  return {
    leads,
    requested: backendResponse.requested,
    generated: leads.length,
    cost: leads.length,
    source: backendResponse.mode,
    credits,
    jobId: backendResponse.jobId,
    mode,
    // status "streaming" means the pool fell short and a follow-up scrape
    // is running under this same job id — more leads may still arrive.
    pending: backendResponse.status === "streaming",
  };
}

// ─── Opportunity Intelligence (Part 3, Phase 8) ────────────────────────────────
// All calls go through backendFetch — same gateway as /v1/discover — never a
// second AI implementation on the frontend. Every shape here mirrors
// mast-backend src/routes/intelligence.ts's response bodies exactly.

export type OpportunityExplanationReason = {
  component: "website" | "branding" | "social" | "growth" | "newness";
  label: string;
  detail: string;
  weight: number;
  value: number;
};

export type OpportunityExplanation = {
  score: number;
  professionSlug: string;
  professionMatch: "strong" | "moderate" | "weak";
  reasons: OpportunityExplanationReason[];
  summary: string;
};

/** Deterministic — reads the real Opportunity Score breakdown, not AI. Available on every plan. */
export async function getOpportunityExplanation(leadId: number | string): Promise<OpportunityExplanation> {
  return backendFetch<OpportunityExplanation>(`/v1/intelligence/explain/${leadId}`);
}

export type OpportunityInsight = {
  headline: string;
  talking_points: string[];
  opening_line: string;
  score_snapshot: number;
  generated_at: string;
  explanation: OpportunityExplanation;
  cached: boolean;
};

/** AI-generated (Premium) — cached per business+profession on the backend. */
export async function getOpportunityInsight(businessId: string): Promise<OpportunityInsight> {
  return backendFetch<OpportunityInsight>(`/v1/intelligence/opportunities/${businessId}`);
}

export type ExecutiveBriefing = {
  summary: string;
  priorities: string[];
  tone: "brand" | "warning" | "success";
  generatedAt: string;
  cached: boolean;
};

/** AI-generated (Premium) — cached once per user per day. */
export async function getExecutiveBriefing(): Promise<ExecutiveBriefing> {
  return backendFetch<ExecutiveBriefing>("/v1/intelligence/briefing");
}

export type WeeklyIntelligence = {
  reflection: string;
  wins: string[];
  focusForNextWeek: string[];
  generatedAt: string;
  cached: boolean;
};

/** AI-generated (Premium) — cached once per user per ISO week. */
export async function getWeeklyIntelligence(): Promise<WeeklyIntelligence> {
  return backendFetch<WeeklyIntelligence>("/v1/intelligence/weekly");
}

export type PipelineCoachingAlert = { businessName: string; message: string; suggestedAction: string };
export type PipelineCoaching = {
  alerts: PipelineCoachingAlert[];
  allClear: boolean;
  generatedAt: string;
  cached: boolean;
};

/** AI-generated (Pro+) — cached once per user per day. */
export async function getPipelineCoaching(): Promise<PipelineCoaching> {
  return backendFetch<PipelineCoaching>("/v1/intelligence/coaching");
}

// ─── Analytics (computed from Supabase leads) ─────────────────────────────────

export async function getAnalyticsSummary(): Promise<AnalyticsSummary> {
  const userId = await requireUserId();
  const { data, error } = await supabase!.from("leads").select("status, follow_up_at, last_contacted_at, created_at").eq("user_id", userId);
  if (error) throw new ApiError(500, error.message, error);

  const leads = data ?? [];
  const contacted = leads.filter((l) => ["contacted", "instagram_sent", "email_sent", "contact_form_sent", "replied", "interested", "meeting_booked", "closed"].includes(l.status)).length;
  const replied = leads.filter((l) => ["replied", "interested", "meeting_booked", "closed"].includes(l.status)).length;
  const interested = leads.filter((l) => ["interested", "meeting_booked", "closed"].includes(l.status)).length;
  const closed = leads.filter((l) => l.status === "closed").length;
  const dead = leads.filter((l) => l.status === "dead").length;
  const followupsDue = leads.filter((l) => Boolean(l.follow_up_at)).length;
  const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString();
  const messagesThisWeek = leads.filter((l) => l.last_contacted_at && l.last_contacted_at >= weekAgo).length;
  const replyRate = contacted > 0 ? Math.round((replied / contacted) * 100) : 0;

  return { totalLeads: leads.length, contacted, replied, interested, closed, dead, followupsDue, messagesThisWeek, replyRate };
}

export async function getPipelineStats(): Promise<PipelineStat[]> {
  const userId = await requireUserId();
  await enforceCapability("pipeline");
  const { data, error } = await supabase!.from("leads").select("status").eq("user_id", userId);
  if (error) throw new ApiError(500, error.message, error);

  const counts = new Map<string, number>();
  for (const row of data ?? []) {
    counts.set(row.status, (counts.get(row.status) ?? 0) + 1);
  }
  return Array.from(counts.entries()).map(([status, count]) => ({ status, count }));
}

export async function getRecentActivity(): Promise<ActivityItem[]> {
  const userId = await requireUserId();
  const { data, error } = await supabase!
    .from("lead_activities")
    .select("id, type, content, leads(business_name), channel, created_at")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(20);

  if (error) {
    // Table may not exist yet — return empty gracefully
    console.warn("[Mast:getRecentActivity] query failed, returning empty", error.message);
    return [];
  }

  return (data ?? []).map((row: Record<string, unknown>) => ({
    id: row.id as string,
    type: row.type as string,
    description: row.content as string,
    leadName: (row.leads as { business_name?: string } | null)?.business_name ?? null,
    channel: (row.channel as string | null) ?? null,
    createdAt: row.created_at as string,
  }));
}

// ─── Settings (Supabase profiles.settings jsonb column) ──────────────────────

export async function getSettings(): Promise<SettingsMap> {
  const userId = await requireUserId();
  const { data, error } = await supabase!.from("profiles").select("settings").eq("id", userId).single();
  if (error) {
    console.warn("[Mast:getSettings] failed, returning empty settings", error.message);
    return {};
  }
  return (data?.settings as SettingsMap) ?? {};
}

export async function updateSettings(body: SettingsMap, fullName?: string): Promise<SettingsMap> {
  const userId = await requireUserId();
  const { data: existing } = await supabase!.from("profiles").select("settings").eq("id", userId).single();
  const merged = { ...(existing?.settings as SettingsMap ?? {}), ...body };
  
  const updateData: Record<string, any> = { settings: merged };
  if (fullName !== undefined) {
    updateData.full_name = fullName;
  }
  
  const { error } = await supabase!.from("profiles").update(updateData).eq("id", userId);
  if (error) throw new ApiError(500, error.message, error);
  
  if (fullName !== undefined) {
    await supabase!.auth.updateUser({ data: { full_name: fullName } });
  }
  
  return merged;
}

// ─── Progression: XP & Goal Completions (Supabase) ────────────────────────────
//
// XP lives on `profiles.xp` and only ever increases. Daily goals are never
// persisted — they're computed live from leads/followups (see lib/focus.ts).
// Awarding XP for a goal is idempotent per (user, goal, calendar day) via the
// `award_goal_xp` Postgres function and the unique constraint backing it, so
// refreshes, duplicate tabs, and multiple devices can never double-award.

export async function getXp(): Promise<number> {
  const userId = await requireUserId();
  const { data, error } = await supabase!.from("profiles").select("xp").eq("id", userId).single();
  if (error) {
    console.warn("[Mast:getXp] failed, defaulting to 0", error.message);
    return 0;
  }
  return (data?.xp as number | null) ?? 0;
}

/** Goal ids that have already had XP awarded for the given calendar day (YYYY-MM-DD, local time). */
export async function getGoalClaims(date: string): Promise<string[]> {
  const userId = await requireUserId();
  const { data, error } = await supabase!
    .from("goal_completions")
    .select("goal_id")
    .eq("user_id", userId)
    .eq("completed_on", date);

  if (error) {
    console.warn("[Mast:getGoalClaims] failed, returning empty", error.message);
    return [];
  }

  return (data ?? []).map((row: { goal_id: string }) => row.goal_id);
}

/** All completed progression goal ids for the current user. Used by the quest generator. */
export async function getCompletedGoalIds(): Promise<string[]> {
  const userId = await requireUserId();
  const { data, error } = await supabase!
    .from("goal_completions")
    .select("goal_id")
    .eq("user_id", userId);

  if (error) {
    console.warn("[Mast:getCompletedGoalIds] failed, returning empty", error.message);
    return [];
  }

  return Array.from(new Set((data ?? []).map((row: { goal_id: string }) => row.goal_id)));
}

export async function getProgressionEventTotals(): Promise<ProgressionEventTotals> {
  const userId = await requireUserId();
  const { data, error } = await supabase!
    .from("progression_events")
    .select("event_type, quantity")
    .eq("user_id", userId);

  if (error) {
    console.warn("[Mast:getProgressionEventTotals] failed, returning empty", error.message);
    return {};
  }

  return (data ?? []).reduce<ProgressionEventTotals>((totals, row: { event_type: string; quantity: number | null }) => {
    const metric = row.event_type as ProgressionMetric;
    totals[metric] = (totals[metric] ?? 0) + (row.quantity ?? 1);
    return totals;
  }, {});
}

export async function recordProgressionEvent(
  eventType: ProgressionEventType,
  quantity = 1,
  metadata: Record<string, unknown> = {},
): Promise<void> {
  const userId = await requireUserId();
  const { error } = await supabase!.from("progression_events").insert({
    user_id: userId,
    event_type: eventType,
    quantity,
    metadata,
  });

  if (error) {
    console.warn("[Mast:recordProgressionEvent] failed", error.message);
  }
}

/**
 * Award XP for completing `goalId` on `date` (YYYY-MM-DD, local time).
 * Safe to call more than once for the same goal/day: the server only awards
 * XP the first time and reports `awarded: false` on every subsequent call,
 * returning the user's current total either way.
 */
export async function awardGoalXp(
  goalId: string,
  date: string,
  xp: number,
): Promise<{ xp: number; awarded: boolean }> {
  await requireUserId();
  const { data, error } = await supabase!.rpc("award_goal_xp", {
    p_goal_id: goalId,
    p_completed_on: date,
    p_xp: xp,
  });

  if (error) throw new ApiError(500, error.message, error);

  const row = Array.isArray(data) ? data[0] : data;
  return { xp: (row?.xp as number) ?? 0, awarded: !!row?.awarded };
}

// ─── Lead Activities (Supabase) ───────────────────────────────────────────────

export async function getLeadActivities(id: number | string): Promise<LeadActivity[]> {
  const userId = await requireUserId();
  const { data, error } = await supabase!
    .from("lead_activities")
    .select("*")
    .eq("lead_id", id)
    .eq("user_id", userId)
    .order("timestamp", { ascending: false });

  if (error) {
    console.warn("[Mast:getLeadActivities] failed, returning empty", error.message);
    return [];
  }

  return (data ?? []).map((row: Record<string, unknown>) => ({
    id: row.id as string,
    leadId: row.lead_id as number,
    type: row.type as LeadActivityType,
    timestamp: row.timestamp as string,
    content: row.content as string,
    channel: (row.channel as OutreachChannel | undefined) ?? undefined,
    subject: (row.subject as string | null) ?? null,
    body: (row.body as string | null) ?? null,
    metadata: (row.metadata as Record<string, unknown> | null) ?? null,
  }));
}

export async function createLeadActivity(
  id: number | string,
  body: Omit<LeadActivity, "id" | "leadId">,
): Promise<LeadActivity> {
  const userId = await requireUserId();
  const row = {
    lead_id: Number(id),
    user_id: userId,
    type: body.type,
    timestamp: body.timestamp ?? new Date().toISOString(),
    content: body.content,
    channel: body.channel ?? null,
    subject: body.subject ?? null,
    body: body.body ?? null,
    metadata: body.metadata ?? null,
  };

  const { data, error } = await supabase!.from("lead_activities").insert(row).select().single();
  if (error) {
    // Gracefully fall back — table might not exist in all deployments
    console.warn("[Mast:createLeadActivity] insert failed, returning local stub", error.message);
    return { id: `local-${Date.now()}`, leadId: Number(id), ...body };
  }

  return {
    id: (data as Record<string, unknown>).id as string,
    leadId: Number(id),
    ...body,
  };
}

// ─── Messages (Supabase lead_messages table, graceful fallback) ───────────────

export async function getLeadMessages(id: number | string): Promise<Message[]> {
  const userId = await requireUserId();
  const { data, error } = await supabase!
    .from("lead_messages")
    .select("*")
    .eq("lead_id", id)
    .eq("user_id", userId)
    .order("created_at", { ascending: false });

  if (error) { console.warn("[Mast:getLeadMessages] failed", error.message); return []; }

  return (data ?? []).map((row: Record<string, unknown>) => ({
    id: row.id as string,
    leadId: row.lead_id as number,
    channel: row.channel as string,
    template: (row.template as string) ?? "initial",
    subject: (row.subject as string | null) ?? null,
    content: row.content as string,
    status: (row.status as string) ?? "draft",
    sentAt: (row.sent_at as string | null) ?? null,
    createdAt: row.created_at as string,
    updatedAt: (row.updated_at as string) ?? row.created_at as string,
  }));
}

export async function createMessage(body: {
  leadId: number;
  channel: string;
  template: string;
  content: string;
  subject?: string;
  status?: string;
}): Promise<Message> {
  const userId = await requireUserId();
  const row = {
    lead_id: body.leadId,
    user_id: userId,
    channel: body.channel,
    template: body.template,
    content: body.content,
    subject: body.subject ?? null,
    status: body.status ?? "draft",
  };

  const { data, error } = await supabase!.from("lead_messages").insert(row).select().single();
  if (error) {
    console.warn("[Mast:createMessage] insert failed, returning local stub", error.message);
    const now = new Date().toISOString();
    return { id: `local-${Date.now()}`, ...body, template: body.template, status: body.status ?? "draft", sentAt: null, createdAt: now, updatedAt: now };
  }

  const d = data as Record<string, unknown>;
  return {
    id: d.id as string,
    leadId: body.leadId,
    channel: body.channel,
    template: body.template,
    subject: body.subject ?? null,
    content: body.content,
    status: body.status ?? "draft",
    sentAt: null,
    createdAt: d.created_at as string,
    updatedAt: d.updated_at as string,
  };
}

// ─── Follow-ups (Supabase lead_followups table, graceful fallback) ────────────

export async function getLeadFollowups(id: number | string): Promise<Followup[]> {
  const userId = await requireUserId();
  await enforceCapability("mission");
  const { data, error } = await supabase!
    .from("lead_followups")
    .select("*")
    .eq("lead_id", id)
    .eq("user_id", userId)
    .order("due_at", { ascending: true });

  if (error) { console.warn("[Mast:getLeadFollowups] failed", error.message); return []; }

  return (data ?? []).map(dbRowToFollowup);
}

export async function getFollowups(params: Record<string, string | number | undefined> = {}): Promise<FollowupWithLead[]> {
  const userId = await requireUserId();
  await enforceCapability("mission");
  let query = supabase!
    .from("lead_followups")
    .select("*, leads(*)")
    .eq("user_id", userId)
    .order("due_at", { ascending: true });

  if (params.status) query = query.eq("status", params.status);

  const limit = Number(params.limit ?? 1000);
  query = query.limit(limit);

  const { data, error } = await query;
  if (error) {
    console.warn("[Mast:getFollowups] failed, falling back to leads.follow_up_at", error.message);
    // Graceful fallback: derive from leads table
    const { data: leads } = await supabase!.from("leads").select("*").eq("user_id", userId).not("follow_up_at", "is", null);
    return (leads ?? []).map((l) => {
      const lead = dbRowToLead(l);
      return {
        id: lead.id,
        leadId: lead.id,
        channel: "email",
        dueAt: lead.followUpAt!,
        status: "pending",
        notes: null,
        sequenceName: null,
        stepNumber: null,
        currentStep: null,
        createdAt: lead.createdAt,
        updatedAt: lead.updatedAt,
        completedAt: null,
        lead,
      } satisfies FollowupWithLead;
    });
  }

  return (data ?? []).map((row: Record<string, unknown>) => {
    const followup = dbRowToFollowup(row);
    const rawLead = row.leads as Record<string, unknown> | null;
    return { ...followup, lead: rawLead ? dbRowToLead(rawLead) : undefined };
  });
}

export async function createFollowup(body: { leadId: number; channel: string; dueAt: string; notes?: string }): Promise<Followup> {
  const userId = await requireUserId();
  await enforceCapability("mission");
  const row = {
    lead_id: body.leadId,
    user_id: userId,
    channel: body.channel,
    due_at: body.dueAt,
    notes: body.notes ?? null,
    status: "pending",
  };

  const { data, error } = await supabase!.from("lead_followups").insert(row).select().single();
  if (error) {
    console.warn("[Mast:createFollowup] insert failed, falling back to updateLead", error.message);
    const updated = await updateLead(body.leadId, { followUpAt: body.dueAt, status: "follow_up_due" });
    return { id: updated.id, leadId: updated.id, channel: body.channel, dueAt: body.dueAt, notes: body.notes ?? null, status: "pending", sequenceName: null, stepNumber: null, currentStep: null, completedAt: null, createdAt: updated.createdAt, updatedAt: updated.updatedAt };
  }
  return dbRowToFollowup(data as Record<string, unknown>);
}

export async function updateFollowup(id: number | string, body: {
  status?: string;
  completedAt?: string;
  notes?: string;
  dueAt?: string;
  sequenceName?: string | null;
  stepNumber?: number | null;
  currentStep?: string | null;
}): Promise<Followup> {
  const userId = await requireUserId();
  await enforceCapability("mission");
  const row: Record<string, unknown> = {};
  if (body.status !== undefined) row.status = body.status;
  if (body.completedAt !== undefined) row.completed_at = body.completedAt;
  if (body.notes !== undefined) row.notes = body.notes;
  if (body.dueAt !== undefined) row.due_at = body.dueAt;
  if (body.sequenceName !== undefined) row.sequence_name = body.sequenceName;
  if (body.stepNumber !== undefined) row.step_number = body.stepNumber;
  if (body.currentStep !== undefined) row.current_step = body.currentStep;

  const { data, error } = await supabase!.from("lead_followups").update(row).eq("id", id).eq("user_id", userId).select().single();
  if (error) {
    console.warn("[Mast:updateFollowup] update failed, falling back", error.message);
    const leadId = Number(id);
    if (!Number.isFinite(leadId)) throw new ApiError(500, error.message, error);
    const updated = await updateLead(leadId, { followUpAt: body.status === "completed" ? null : body.dueAt, ...(body.status === "completed" ? { status: "contacted" } : {}) });
    return { id: updated.id, leadId: updated.id, channel: "email", dueAt: updated.followUpAt ?? body.dueAt ?? new Date().toISOString(), status: body.status ?? "pending", completedAt: body.completedAt ?? null, notes: body.notes ?? null, sequenceName: body.sequenceName ?? null, stepNumber: body.stepNumber ?? null, currentStep: body.currentStep ?? null, createdAt: updated.createdAt, updatedAt: updated.updatedAt };
  }
  return dbRowToFollowup(data as Record<string, unknown>);
}

// ─── Outreach draft (AI endpoint — stub that returns a local fallback) ─────────
// The AI generation feature requires the Mast Lead Engine.
// The AIAssistant component handles isMissingBackendEndpoint via its own fallback.
export async function generateOutreachDraft(_leadId: number, _body: OutreachDraftRequest): Promise<OutreachDraftResponse> {
  throw new ApiError(501, "AI outreach generation requires the Mast Lead Engine backend.", { code: "ENGINE_NOT_CONNECTED" });
}

export async function sendLeadEmail(leadId: number, body: SendEmailRequest): Promise<SendLeadEmailResponse> {
  const userId = await requireUserId();
  const lead = await getLead(leadId);
  if (!lead.email) {
    throw new Error("Lead does not have an email address.");
  }

  const { data: { session } } = await supabase!.auth.getSession();
  const token = session?.access_token;
  if (!token) throw new ApiError(401, "Not authenticated", {});

  const response = await fetch("/api/send-email", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${token}`
    },
    body: JSON.stringify({ to: lead.email, subject: body.subject, body: body.body })
  });

  const resData = await response.json();
  if (!response.ok || !resData.success) {
    throw new Error(resData.error || "Failed to send email");
  }

  // Update lead status and last contacted
  const updatedLead = await updateLead(leadId, {
    status: "email_sent",
    lastContactedAt: new Date().toISOString(),
  });

  // Record lead activity
  await createLeadActivity(leadId, {
    type: "email_sent",
    timestamp: new Date().toISOString(),
    content: `Sent email: "${body.subject}"`,
    channel: "email",
    subject: body.subject,
    body: body.body
  });

  // Create message record
  const msg = await createMessage({
    leadId,
    channel: "email",
    template: "outreach",
    content: body.body,
    subject: body.subject,
    status: "sent",
  });

  return {
    success: true,
    lead: updatedLead,
    message: msg
  };
}

export async function testSmtpConnection(credentials: {
  host: string;
  port: string;
  user: string;
  pass: string;
  encryption: string;
}): Promise<{ success: boolean; message?: string; error?: string }> {
  const { data: { session } } = await supabase!.auth.getSession();
  const token = session?.access_token;
  if (!token) throw new ApiError(401, "Not authenticated", {});

  const response = await fetch("/api/test-smtp", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${token}`
    },
    body: JSON.stringify(credentials)
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error || "SMTP test failed.");
  }
  return data;
}

export async function pauseWorkspace(): Promise<void> {
  const userId = await requireUserId();
  const { data: existing } = await supabase!.from("profiles").select("settings").eq("id", userId).single();
  const settings = (existing?.settings as Record<string, string>) || {};
  const merged = { ...settings, workspaceStatus: "disabled" };
  
  const { error } = await supabase!.from("profiles").update({ settings: merged }).eq("id", userId);
  if (error) throw new ApiError(500, error.message, error);
}

export async function enableWorkspace(): Promise<void> {
  const userId = await requireUserId();
  const { data: existing } = await supabase!.from("profiles").select("settings").eq("id", userId).single();
  const settings = (existing?.settings as Record<string, string>) || {};
  const merged = { ...settings, workspaceStatus: "active" };
  
  const { error } = await supabase!.from("profiles").update({ settings: merged }).eq("id", userId);
  if (error) throw new ApiError(500, error.message, error);
}

export async function deleteWorkspace(): Promise<void> {
  const userId = await requireUserId();

  // Delete dependencies first:
  // 1. lead_followups
  await supabase!.from("lead_followups").delete().eq("user_id", userId);
  
  // 2. lead_messages
  await supabase!.from("lead_messages").delete().eq("user_id", userId);

  // 3. lead_activities
  await supabase!.from("lead_activities").delete().eq("user_id", userId);

  // 4. goal_completions
  await supabase!.from("goal_completions").delete().eq("user_id", userId);

  // 5. leads
  await supabase!.from("leads").delete().eq("user_id", userId);

  // 6. profiles
  await supabase!.from("profiles").delete().eq("id", userId);

  // 7. Sign out
  await supabase!.auth.signOut();
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function dbRowToFollowup(row: Record<string, unknown>): Followup {
  return {
    id: row.id as string,
    leadId: row.lead_id as number,
    channel: (row.channel as string) ?? "email",
    dueAt: row.due_at as string,
    completedAt: (row.completed_at as string | null) ?? null,
    notes: (row.notes as string | null) ?? null,
    status: (row.status as string) ?? "pending",
    sequenceName: (row.sequence_name as string | null) ?? null,
    stepNumber: (row.step_number as number | null) ?? null,
    currentStep: (row.current_step as string | null) ?? null,
    createdAt: row.created_at as string,
    updatedAt: (row.updated_at as string) ?? row.created_at as string,
  };
}
