import type { GenerationMode, PlanId, PlanConfig } from "./plans";
import { getPlan, PLANS } from "./plans";
import { supabase } from "./supabase";
import { addNotification } from "./notifications";

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

async function requireUserId(): Promise<string> {
  if (!supabase) throw new ApiError(0, "Supabase not configured", {});
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) throw new ApiError(401, "Not authenticated", {});
  return session.user.id;
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
    const updateObj = {
      daily_leads_used: dailyUsed,
      monthly_leads_used: monthlyUsed,
      next_daily_reset: dailyReset,
      next_monthly_reset: monthlyReset,
      subscription_plan: activePlan,
      pending_plan_change: pendingPlan,
    };
    
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

  const resolvedPlan = ((activeProfile?.subscription_plan as PlanId) || "free");
  const planConfig = getPlan(resolvedPlan);
  const monthlyLimit = planConfig.monthlyLeadLimit;
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
    options: { skipBrowserRedirect: true, redirectTo: `${window.location.origin}/auth/callback` },
  });
  if (error) throw error;
  return { url: data.url };
}

// ─── Account (Supabase-only) ──────────────────────────────────────────────────

export async function getAccount(): Promise<Account> {
  const userId = await requireUserId();
  const { data: profile, error } = await supabase!.from("profiles").select("*").eq("id", userId).single();
  if (error) throw new ApiError(500, error.message, error);

  // Lazy reset checks
  const activeProfile = await checkAndResetUsage(profile);

  const resolvedPlan = ((activeProfile?.subscription_plan as PlanId) || "free");
  const planConfig = getPlan(resolvedPlan);

  const dailyLimit = planConfig.dailyLeadLimit;
  const monthlyLimit = planConfig.monthlyLeadLimit;

  const dailyUsed = activeProfile?.daily_leads_used ?? 0;
  const monthlyUsed = activeProfile?.monthly_leads_used ?? 0;

  const dailyRemaining = Math.max(0, dailyLimit - dailyUsed);
  const monthlyRemaining = Math.max(0, monthlyLimit - monthlyUsed);

  return {
    user: {
      id: userId,
      fullName: activeProfile?.full_name ?? "",
      email: activeProfile?.email ?? "",
      plan: resolvedPlan,
      subscriptionStatus: "active",
    },
    subscription: {
      plan: resolvedPlan,
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
      allowedChannels: ["email", "phone", "instagram", "website"],
      allowInstantPool: planConfig.allowInstantPool,
      allowPremiumPool: planConfig.allowPremiumPool,
      allowApiAccess: planConfig.allowApiAccess,
    },
    plans: PLANS,
  };
}

export async function updateSubscription(plan: PlanId): Promise<Account> {
  const userId = await requireUserId();
  
  const currentAccount = await getAccount();
  const currentPlanConfig = getPlan(currentAccount.subscription.plan);
  const targetPlanConfig = getPlan(plan);

  const isDowngrade = targetPlanConfig.priceMonthly < currentPlanConfig.priceMonthly;

  if (isDowngrade) {
    // Downgrade: set pending_plan_change
    const { error } = await supabase!
      .from("profiles")
      .update({ pending_plan_change: plan })
      .eq("id", userId);
    if (error) throw new ApiError(500, error.message, error);
  } else {
    // Upgrade: immediate and clear any pending downgrade
    const { error } = await supabase!
      .from("profiles")
      .update({ subscription_plan: plan, pending_plan_change: null })
      .eq("id", userId);
    if (error) throw new ApiError(500, error.message, error);
  }

  return getAccount();
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
  const row = { ...leadToDbRow(body as Partial<Lead>), user_id: userId };
  const { data, error } = await supabase!.from("leads").insert(row).select().single();
  if (error) throw new ApiError(500, error.message, error);
  return dbRowToLead(data);
}

export async function updateLead(id: number, body: UpdateLeadBody): Promise<Lead> {
  const userId = await requireUserId();
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

  const { data: profile, error: profileErr } = await supabase!
    .from("profiles")
    .select("*")
    .eq("id", userId)
    .single();

  if (profileErr) throw new ApiError(500, profileErr.message, profileErr);

  // Perform lazy resets to ensure correct active limits
  const activeProfile = await checkAndResetUsage(profile);

  const resolvedPlan = ((activeProfile?.subscription_plan as PlanId) || "free");
  const planConfig = getPlan(resolvedPlan);
  const dailyLimit = planConfig.dailyLeadLimit;
  const monthlyLimit = planConfig.monthlyLeadLimit;

  const dailyUsed = activeProfile?.daily_leads_used ?? 0;
  const monthlyUsed = activeProfile?.monthly_leads_used ?? 0;

  const dailyRemaining = Math.max(0, dailyLimit - dailyUsed);
  const monthlyRemaining = Math.max(0, monthlyLimit - monthlyUsed);

  // Validation: Proceed only if BOTH limits allow the requested quantity
  if (body.quantity > dailyRemaining && body.quantity > monthlyRemaining) {
    throw new ApiError(400, "LIMIT_EXCEEDED_BOTH", {
      reason: "both",
      dailyLimit,
      dailyRemaining,
      monthlyLimit,
      monthlyRemaining,
    });
  }
  if (body.quantity > dailyRemaining) {
    throw new ApiError(400, "LIMIT_EXCEEDED_DAILY", {
      reason: "daily",
      dailyLimit,
      dailyRemaining,
    });
  }
  if (body.quantity > monthlyRemaining) {
    throw new ApiError(400, "LIMIT_EXCEEDED_MONTHLY", {
      reason: "monthly",
      monthlyLimit,
      monthlyRemaining,
    });
  }

  // Simulate external Lead Engine: might return slightly fewer than requested
  // but never more, and never charge for what was not generated.
  const successRate = 0.9 + Math.random() * 0.1; // 90% to 100% success rate
  const actualCount = Math.max(1, Math.min(body.quantity, Math.round(body.quantity * successRate)));

  const generatedLeads: Lead[] = [];
  const nichesList = body.niche && body.niche !== "General" ? body.niche.split(", ") : ["Software Agency", "Local Bakery", "Consulting Firm", "Dental Clinic"];
  const regionsList = body.region && body.region !== "Global" ? body.region.split(", ") : ["New York, US", "London, UK", "Toronto, CA", "Sydney, AU"];

  for (let i = 0; i < actualCount; i++) {
    const niche = nichesList[i % nichesList.length];
    const location = regionsList[i % regionsList.length];
    const businessName = `${niche} Co. ${Math.floor(Math.random() * 900 + 100)}`;
    
    // Customize research notes based on vertical/niche
    let brandingDesc = "Visual presence is established but lacks coordination across active channels. Color usage could be more cohesive.";
    let websiteDesc = "Web layout is responsive but lacks clean conversion pathways above the fold. Loading speed has optimization potential.";
    let actionRecommendation = "Send personalized outreach introducing a high-impact design enhancement for their website.";
    
    if (niche.toLowerCase().includes("restaurant") || niche.toLowerCase().includes("bakery") || niche.toLowerCase().includes("coffee") || niche.toLowerCase().includes("cafe")) {
      brandingDesc = "Instagram aesthetic is strong, but menu branding and photography are inconsistent. Recommended: Standardize grid layout and highlight signature items.";
      websiteDesc = "Online ordering system is functional but requires 4 clicks to access. Lacks clear menu CTAs on mobile home page. Mobile speed is 3.4s.";
      actionRecommendation = "Initiate contact via Instagram DM or Email with a mobile wireframe mockup showing a 1-click ordering pathway.";
    } else if (niche.toLowerCase().includes("agency") || niche.toLowerCase().includes("consulting") || niche.toLowerCase().includes("firm") || niche.toLowerCase().includes("services") || niche.toLowerCase().includes("law") || niche.toLowerCase().includes("accounting")) {
      brandingDesc = "Brand positioning is formal but feels generic. Lacks video case studies or partner headshots. Recommended: Highlight testimonials and modern typography.";
      websiteDesc = "Case studies are buried in the navigation. Form fields are too long (8 inputs), causing lead drop-off. Mobile speed is 2.9s.";
      actionRecommendation = "Send email highlighting a simplified 3-field contact form case study, showing how it increases conversions by 50%.";
    } else if (niche.toLowerCase().includes("clinic") || niche.toLowerCase().includes("dental") || niche.toLowerCase().includes("health") || niche.toLowerCase().includes("medical") || niche.toLowerCase().includes("veterinary")) {
      brandingDesc = "Patient trust signals (reviews, safety badges) are not featured prominently. Color scheme is clean but feels cold.";
      websiteDesc = "Appointment booking is redirected to an external portal that is not mobile-optimized. Load time is 3.1s on mobile.";
      actionRecommendation = "Initiate outreach with an email offering a patient booking flow audit, focusing on booking page bounce rates.";
    }

    const brandingNotes = `${brandingDesc} Recommendation: Sync visual style and modern fonts across all platforms to build stronger trust.`;
    const websiteNotes = `${websiteDesc} Recommendation: Add a primary sticky 'Schedule Appointment' button in the header.`;
    const notes = `AI Overview: ${businessName} is a growing ${niche} business in ${location}. Their local customer satisfaction is high, but their digital footprint leaks conversions due to friction in booking/ordering and inconsistent cross-channel branding.\n\nSuggested First Action: ${actionRecommendation}`;

    const leadRow: CreateLeadBody = {
      businessName,
      niche,
      location,
      status: "ready", // Active in momentum pipeline
      email: body.channels.includes("email") ? `contact@${businessName.toLowerCase().replace(/[^a-z0-9]/g, "")}.com` : null,
      phone: body.channels.includes("phone") ? `+1 (555) ${Math.floor(Math.random() * 900 + 100)}-${Math.floor(Math.random() * 9000 + 1000)}` : null,
      instagramHandle: body.channels.includes("instagram") ? `${businessName.toLowerCase().replace(/[^a-z0-9]/g, "")}_ig` : null,
      website: body.channels.includes("website") ? `https://www.${businessName.toLowerCase().replace(/[^a-z0-9]/g, "")}.com` : null,
      source: `Engine (${body.mode === "premium" ? "premium" : body.mode === "pool" ? "pool" : "scrape"})`,
      brandingNotes,
      websiteNotes,
      notes,
      igFollowers: body.channels.includes("instagram") ? `${Math.floor(Math.random() * 8000 + 1200)}` : null,
      igBio: body.channels.includes("instagram") ? `Premium ${niche} services. Contact us today!` : null,
    };

    // Insert lead into Supabase workspace
    const row = { ...leadToDbRow(leadRow), user_id: userId };
    const { data: dbLead, error: insertErr } = await supabase!.from("leads").insert(row).select().single();
    if (insertErr) {
      console.error("[Mast:generateLeads] Mock lead insert failed:", insertErr.message);
    } else if (dbLead) {
      const opportunity = dbRowToLead(dbLead);
      generatedLeads.push(opportunity);

      // Seed 5 spaced timeline events
      const nowMs = Date.now();
      const activities = [
        {
          lead_id: dbLead.id,
          user_id: userId,
          type: "opportunity_discovered",
          timestamp: new Date(nowMs - 5 * 60 * 1000).toISOString(),
          content: "Opportunity discovered via target segment search",
        },
        {
          lead_id: dbLead.id,
          user_id: userId,
          type: "company_analyzed",
          timestamp: new Date(nowMs - 4 * 60 * 1000).toISOString(),
          content: `Analyzed company structure and digital footprint for ${dbLead.business_name}`,
        },
        {
          lead_id: dbLead.id,
          user_id: userId,
          type: "contact_verified",
          timestamp: new Date(nowMs - 3 * 60 * 1000).toISOString(),
          content: "Verified contact details and verified active outreach channels",
        },
        {
          lead_id: dbLead.id,
          user_id: userId,
          type: "workspace_prepared",
          timestamp: new Date(nowMs - 2 * 60 * 1000).toISOString(),
          content: "Outreach workspace initialized with research highlights",
        },
        {
          lead_id: dbLead.id,
          user_id: userId,
          type: "ready_for_outreach",
          timestamp: new Date(nowMs - 1 * 60 * 1000).toISOString(),
          content: "Opportunity marked ready for outreach campaigns",
        },
      ];

      const { error: actErr } = await supabase!.from("lead_activities").insert(activities);
      if (actErr) {
        console.error("[Mast:generateLeads] Failed to seed activities:", actErr.message);
      }
    }
  }

  const generatedCount = generatedLeads.length;

  // Charge only for the actual generated leads
  const newDailyUsed = dailyUsed + generatedCount;
  const newMonthlyUsed = monthlyUsed + generatedCount;

  const { error: updateErr } = await supabase!
    .from("profiles")
    .update({
      daily_leads_used: newDailyUsed,
      monthly_leads_used: newMonthlyUsed,
    })
    .eq("id", userId);

  if (updateErr) {
    console.error("[Mast:generateLeads] Error updating user profile usage:", updateErr.message);
  }

  return {
    leads: generatedLeads,
    requested: body.quantity,
    generated: generatedCount,
    cost: generatedCount, // 1 lead = 1 usage count
    source: body.mode === "premium" ? "premium_pool" : body.mode === "pool" ? "instant_pool" : "live_scrape",
    credits: {
      limit: monthlyLimit,
      used: newMonthlyUsed,
      remaining: Math.max(0, monthlyLimit - newMonthlyUsed),
    },
  };
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

export async function sendLeadEmail(_leadId: number, _body: SendEmailRequest): Promise<SendLeadEmailResponse> {
  throw new ApiError(501, "Connected email send requires the Mast Lead Engine backend.", { code: "ENGINE_NOT_CONNECTED" });
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
