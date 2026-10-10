/**
 * What the contact icons on a Discover result card mean.
 *
 * An icon is "present" when the saved lead actually has a non-empty value for
 * that channel — it is NOT a statement about which channels were requested.
 * The channel contract is AND (see channelFilter.ts): every requested channel
 * must be present on a delivered lead. `missingRequested` therefore surfaces
 * any lead that violates that contract instead of quietly showing fewer icons.
 */
export type LeadChannelId = "email" | "phone" | "instagram" | "website";

export const LEAD_CHANNEL_ORDER: readonly LeadChannelId[] = ["email", "phone", "instagram", "website"];

export const LEAD_CHANNEL_LABEL: Record<LeadChannelId, string> = {
  email: "Email",
  phone: "Phone",
  instagram: "Instagram",
  website: "Website",
};

export type LeadChannelSource = {
  email?: string | null;
  phone?: string | null;
  instagramHandle?: string | null;
  instagram?: string | null;
  website?: string | null;
};

export type ChannelPresence = {
  id: LeadChannelId;
  label: string;
  present: boolean;
  requested: boolean;
};

const filled = (v: unknown): boolean => typeof v === "string" && v.trim().length > 0;

export function channelPresence(lead: LeadChannelSource, requested: readonly string[]): ChannelPresence[] {
  const has: Record<LeadChannelId, boolean> = {
    email: filled(lead.email),
    phone: filled(lead.phone),
    instagram: filled(lead.instagramHandle ?? lead.instagram),
    website: filled(lead.website),
  };
  return LEAD_CHANNEL_ORDER.map((id) => ({
    id,
    label: LEAD_CHANNEL_LABEL[id],
    present: has[id],
    requested: requested.includes(id),
  }));
}

/** Requested channels this lead does NOT have (AND-contract violations). */
export function missingRequestedChannels(lead: LeadChannelSource, requested: readonly string[]): LeadChannelId[] {
  return channelPresence(lead, requested)
    .filter((c) => c.requested && !c.present)
    .map((c) => c.id);
}
