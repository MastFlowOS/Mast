import type { Lead, OutreachTone, OutreachChannel } from "@/lib/api";
import type { Channel } from "@/routes/dashboard.leads.$leadId";

export type AssistantTab = "write" | "improve" | "ideas" | "research";

export interface PersonalizationState {
  businessNameAndNiche: boolean;
  recentInstagramActivity: boolean;
  locationAndLocalMarket: boolean;
  businessReviewsAndReputation: boolean;
  similarBusinessSuccessStories: boolean;
}

export interface GeneratedDraft {
  subject?: string;
  body: string;
}

export type LengthPreference = "short" | "standard" | "detailed";

export type ToneOption = "friendly" | "professional" | "direct" | "persuasive" | "casual" | "urgent";

export interface AIAssistantProps {
  lead: Lead;
  channel: Channel;
  subject: string;
  body: string;
  onInsert: (body: string, subject?: string) => void;
  template: string;
  setTemplate: (t: string) => void;
  tone: string;
  setTone: (t: string) => void;
  onHide?: () => void;
}
