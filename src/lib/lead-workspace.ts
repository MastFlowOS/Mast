import type {
  Lead,
  LeadActivity,
  LeadActivityType,
  LeadStatus,
  OutreachChannel,
  OutreachDraftResponse,
} from "./api";

export const LEAD_STATUSES: { value: LeadStatus; label: string }[] = [
  { value: "new", label: "New" },
  { value: "email_sent", label: "Email Sent" },
  { value: "called", label: "Called" },
  { value: "instagram_sent", label: "Instagram Sent" },
  { value: "replied", label: "Replied" },
  { value: "meeting_booked", label: "Meeting Booked" },
  { value: "closed", label: "Closed" },
  { value: "dead", label: "Dead" },
];

export const STATUS_COLORS: Record<LeadStatus, string> = {
  new: "bg-blue-500/10 text-blue-400 border-blue-500/20",
  email_sent: "bg-indigo-500/10 text-indigo-400 border-indigo-500/20",
  called: "bg-cyan-500/10 text-cyan-400 border-cyan-500/20",
  instagram_sent: "bg-purple-500/10 text-purple-400 border-purple-500/20",
  replied: "bg-brand/10 text-brand border-brand/20",
  meeting_booked: "bg-amber-500/10 text-amber-400 border-amber-500/20",
  closed: "bg-success/10 text-success border-success/20",
  dead: "bg-destructive/10 text-destructive border-destructive/20",
};

// Maps old pipeline-style statuses and any legacy values to the new communication statuses
const LEGACY_STATUS_MAP: Record<string, LeadStatus> = {
  // Old pipeline statuses
  discovered: "new",
  ready: "new",
  outreach: "email_sent",
  conversation: "replied",
  meeting: "meeting_booked",
  proposal: "replied",
  negotiation: "replied",
  closed_won: "closed",
  closed_lost: "dead",
  // Old legacy values
  won: "closed",
  lost: "dead",
  crm: "new",
  priority: "new",
  warm: "new",
  contacted: "email_sent",
  contact_form_sent: "email_sent",
  interested: "replied",
  follow_up_due: "replied",
};

export const PIPELINE_COLUMNS: LeadStatus[] = [
  "new",
  "email_sent",
  "replied",
  "meeting_booked",
  "closed",
];

export type FlowStage = "new" | "contacted" | "replied" | "meeting" | "won";

export const FLOW_STAGES: { value: FlowStage; label: string; color: string; valueMultiplier: number }[] = [
  { value: "new", label: "New", color: "from-blue-500/25 to-blue-500/5 text-blue-400 border-blue-500/20", valueMultiplier: 50 },
  { value: "contacted", label: "Contacted", color: "from-indigo-500/25 to-indigo-500/5 text-indigo-400 border-indigo-500/20", valueMultiplier: 150 },
  { value: "replied", label: "Replied", color: "from-brand/25 to-brand/5 text-brand border-brand/20", valueMultiplier: 500 },
  { value: "meeting", label: "Meeting Booked", color: "from-amber-500/25 to-amber-500/5 text-amber-400 border-amber-500/20", valueMultiplier: 1200 },
  { value: "won", label: "Closed", color: "from-success/25 to-success/5 text-success border-success/20", valueMultiplier: 8000 },
];

export const STATUS_TO_STAGE: Record<LeadStatus, FlowStage> = {
  new: "new",
  email_sent: "contacted",
  called: "contacted",
  instagram_sent: "contacted",
  replied: "replied",
  meeting_booked: "meeting",
  closed: "won",
  dead: "new",
};

export function getStageForStatus(status?: string | null): FlowStage {
  const norm = normalizeLeadStatus(status);
  return STATUS_TO_STAGE[norm] ?? "new";
}

export const NICHES = [
  { value: "cafe", label: "Café" },
  { value: "coffee_shop", label: "Coffee Shop" },
  { value: "bakery", label: "Bakery" },
  { value: "restaurant", label: "Restaurant" },
  { value: "bar_lounge", label: "Bar & Lounge" },
  { value: "food_truck", label: "Food Truck" },
  { value: "catering", label: "Catering" },
  { value: "hair_salon", label: "Hair Salon" },
  { value: "barbershop", label: "Barbershop" },
  { value: "nail_salon", label: "Nail Salon" },
  { value: "spa_wellness", label: "Spa & Wellness" },
  { value: "tattoo_studio", label: "Tattoo Studio" },
  { value: "yoga_studio", label: "Yoga Studio" },
  { value: "pilates_studio", label: "Pilates Studio" },
  { value: "fitness", label: "Fitness Studio / Gym" },
  { value: "crossfit", label: "CrossFit Box" },
  { value: "martial_arts", label: "Martial Arts" },
  { value: "dance_studio", label: "Dance Studio" },
  { value: "personal_trainer", label: "Personal Trainer" },
  { value: "boutique_retail", label: "Boutique Retail" },
  { value: "clothing_brand", label: "Clothing Brand" },
  { value: "jewelry", label: "Jewelry" },
  { value: "home_decor", label: "Home Décor" },
  { value: "florist", label: "Florist" },
  { value: "gift_shop", label: "Gift Shop" },
  { value: "bookshop", label: "Bookshop" },
  { value: "vintage_shop", label: "Vintage / Thrift" },
  { value: "photography", label: "Photography" },
  { value: "videography", label: "Videography" },
  { value: "architecture", label: "Architecture" },
  { value: "interior_design", label: "Interior Design" },
  { value: "graphic_design", label: "Graphic Design" },
  { value: "branding_studio", label: "Branding Studio" },
  { value: "art_gallery", label: "Art Gallery" },
  { value: "music_studio", label: "Music Studio" },
  { value: "real_estate", label: "Real Estate" },
  { value: "property_management", label: "Property Management" },
  { value: "mortgage_broker", label: "Mortgage Broker" },
  { value: "law_firm", label: "Law Firm" },
  { value: "accounting", label: "Accounting / CPA" },
  { value: "financial_advisor", label: "Financial Advisor" },
  { value: "insurance", label: "Insurance" },
  { value: "medical_clinic", label: "Medical Clinic" },
  { value: "dental", label: "Dental" },
  { value: "chiropractic", label: "Chiropractic" },
  { value: "mental_health", label: "Mental Health / Therapy" },
  { value: "optometry", label: "Optometry" },
  { value: "veterinary", label: "Veterinary" },
  { value: "childcare", label: "Childcare / Daycare" },
  { value: "tutoring", label: "Tutoring / Education" },
  { value: "coaching", label: "Life / Business Coaching" },
  { value: "event_planning", label: "Event Planning" },
  { value: "wedding_planner", label: "Wedding Planner" },
  { value: "cleaning_service", label: "Cleaning Service" },
  { value: "landscaping", label: "Landscaping" },
  { value: "construction", label: "Construction / Contracting" },
  { value: "plumbing", label: "Plumbing" },
  { value: "electrician", label: "Electrician" },
  { value: "hvac", label: "HVAC" },
  { value: "auto_repair", label: "Auto Repair" },
  { value: "car_detailing", label: "Car Detailing" },
  { value: "moving_service", label: "Moving Service" },
  { value: "marketing_agency", label: "Marketing Agency" },
  { value: "pr_agency", label: "PR Agency" },
  { value: "digital_agency", label: "Digital Agency" },
  { value: "saas", label: "SaaS / Tech" },
  { value: "ecommerce", label: "E-commerce" },
  { value: "local_services", label: "Local Services" },
  { value: "nonprofit", label: "Nonprofit / Charity" },
  { value: "religious_org", label: "Religious Organization" },
  { value: "other", label: "Other" },
];

export const CHANNELS: { value: OutreachChannel; label: string }[] = [
  { value: "email", label: "Email" },
  { value: "instagram", label: "Instagram DM" },
  { value: "phone", label: "Phone" },
  { value: "contact_form", label: "Contact Form" },
];

export const TEMPLATES = [
  { value: "initial", label: "Initial Outreach" },
  { value: "follow_up_2day", label: "Follow-up (2 days)" },
  { value: "follow_up_5day", label: "Follow-up (5 days)" },
  { value: "buried_bump", label: "Buried Bump" },
  { value: "objection_handling", label: "Objection Handling" },
  { value: "reengagement", label: "Re-engagement" },
  { value: "pricing_transition", label: "Pricing Transition" },
];

export type WorkspaceActivityInput = {
  type: LeadActivityType;
  content: string;
  channel?: OutreachChannel;
  subject?: string | null;
  body?: string | null;
  timestamp?: string;
  metadata?: Record<string, unknown> | null;
};

export type DraftContent = {
  subject?: string;
  body: string;
};

const ACTIVITY_MARKER = "[[mast:activity]]";

export function normalizeLeadStatus(status?: string | null): LeadStatus {
  const normalized = (status ?? "new").toLowerCase().trim().replace(/\s+/g, "_");
  if (LEAD_STATUSES.some((item) => item.value === normalized)) return normalized as LeadStatus;
  if (normalized in LEGACY_STATUS_MAP) return LEGACY_STATUS_MAP[normalized];
  return "new";
}

export function leadStatusLabel(status?: string | null) {
  const normalized = normalizeLeadStatus(status);
  return LEAD_STATUSES.find((item) => item.value === normalized)?.label ?? "New";
}

export function leadStatusColor(status?: string | null) {
  return STATUS_COLORS[normalizeLeadStatus(status)];
}

export function appendActivityToNotes(notes: string | null | undefined, activity: WorkspaceActivityInput) {
  const timestamp = activity.timestamp ?? new Date().toISOString();
  const marker = `${ACTIVITY_MARKER}${JSON.stringify({ ...activity, timestamp })}`;
  return [notes?.trim(), marker].filter(Boolean).join("\n\n");
}

export function appendVisibleNote(notes: string | null | undefined, content: string, timestamp = new Date()) {
  const trimmed = content.trim();
  if (!trimmed) return notes ?? "";
  const note = `[${timestamp.toLocaleString()}]\n${trimmed}`;
  return [notes?.trim(), note].filter(Boolean).join("\n\n");
}

export function stripActivityMarkers(notes: string | null | undefined) {
  if (!notes) return "";
  return notes
    .split(/\n{2,}/)
    .filter((block) => !block.trim().startsWith(ACTIVITY_MARKER))
    .join("\n\n")
    .trim();
}

export function normalizeDraftResponse(response: OutreachDraftResponse): DraftContent {
  const subject = response.subject ?? response.draft?.subject ?? undefined;
  const body = response.body ?? response.message ?? response.content ?? response.draft?.body ?? response.draft?.message ?? "";
  return {
    subject: subject ?? undefined,
    body: body.trim(),
  };
}

export function formatDate(date: string | Date | null | undefined) {
  if (!date) return "-";
  const value = typeof date === "string" ? new Date(date) : date;
  if (Number.isNaN(value.getTime())) return "-";
  return value.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

export function formatRelative(date: string | Date | null | undefined) {
  if (!date) return "-";
  const value = typeof date === "string" ? new Date(date) : date;
  if (Number.isNaN(value.getTime())) return "-";
  const diff = Date.now() - value.getTime();
  const days = Math.floor(diff / 86_400_000);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return `${days}d ago`;
  if (days < 30) return `${Math.floor(days / 7)}w ago`;
  return formatDate(value);
}

export function normalizeActivitiesPayload(payload: LeadActivity[] | { activities?: LeadActivity[] } | undefined) {
  return Array.isArray(payload) ? payload : payload?.activities ?? [];
}

export function buildActivitiesFromLead(lead: Lead, apiActivities: LeadActivity[] = []) {
  const activities = [...apiActivities];
  const seen = new Set(activities.map(activityKey));

  const add = (activity: LeadActivity) => {
    const key = activityKey(activity);
    if (!seen.has(key)) {
      seen.add(key);
      activities.push(activity);
    }
  };

  if (lead.createdAt) {
    add({
      id: `opportunity-discovered-${lead.id}`,
      leadId: lead.id,
      type: "opportunity_discovered",
      timestamp: lead.createdAt,
      content: "Opportunity discovered",
    });
  }

  if (lead.lastContactedAt) {
    add({
      id: `last-contacted-${lead.id}`,
      leadId: lead.id,
      type: "email_sent",
      timestamp: lead.lastContactedAt,
      content: "Outreach started",
    });
  }

  if (lead.followUpAt) {
    add({
      id: `follow-up-${lead.id}`,
      leadId: lead.id,
      type: "status_changed",
      timestamp: lead.followUpAt,
      content: "Follow-up due",
    });
  }

  for (const activity of parseActivitiesFromNotes(lead)) {
    add(activity);
  }

  for (const activity of parseVisibleNotes(lead)) {
    add(activity);
  }

  return activities.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
}

function parseActivitiesFromNotes(lead: Lead): LeadActivity[] {
  if (!lead.notes) return [];
  const results: LeadActivity[] = [];
  lead.notes.split(/\n{2,}/).forEach((block, index) => {
    const trimmed = block.trim();
    if (!trimmed.startsWith(ACTIVITY_MARKER)) return;
    try {
      const payload = JSON.parse(trimmed.slice(ACTIVITY_MARKER.length)) as WorkspaceActivityInput;
      results.push({
        id: `note-activity-${lead.id}-${index}-${payload.timestamp ?? ""}`,
        leadId: lead.id,
        type: payload.type,
        timestamp: payload.timestamp ?? lead.updatedAt,
        content: payload.content,
        channel: payload.channel,
        subject: payload.subject,
        body: payload.body,
        metadata: payload.metadata,
      });
    } catch {
      // skip malformed
    }
  });
  return results;
}

function parseVisibleNotes(lead: Lead): LeadActivity[] {
  const visibleNotes = stripActivityMarkers(lead.notes);
  if (!visibleNotes) return [];

  const results: LeadActivity[] = [];
  visibleNotes.split(/\n{2,}/).forEach((block, index) => {
    const match = block.match(/^\[(.+?)\]\n([\s\S]+)/);
    const timestamp = match ? Date.parse(match[1]) : Number.NaN;
    const content = match?.[2]?.trim() ?? block.trim();
    if (!content) return;
    results.push({
      id: `visible-note-${lead.id}-${index}`,
      leadId: lead.id,
      type: "note_added",
      timestamp: Number.isNaN(timestamp) ? lead.updatedAt : new Date(timestamp).toISOString(),
      content: `Note added: ${content.slice(0, 120)}${content.length > 120 ? "..." : ""}`,
    });
  });
  return results;
}

function activityKey(activity: LeadActivity) {
  return `${activity.type}:${activity.timestamp}:${activity.content}`;
}
