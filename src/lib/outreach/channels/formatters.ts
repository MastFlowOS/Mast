/**
 * Channel formatting. ONE template output (`SlotContent`) in, one
 * channel-shaped message out — never a template × channel copy of the
 * copy itself.
 *
 * Templates produce no line breaks and no subject lines; every newline,
 * paragraph break, subject, and signoff in a finished message originates
 * here.
 */

import type { OutreachChannel, SlotContent } from "@/lib/outreach/types";

export type FormattedMessage = {
  readonly subject: string | null;
  readonly body: string;
};

/** Instagram DMs are read in a narrow column — keep them short. */
export const INSTAGRAM_TARGET_MAX_CHARS = 500;

function sentences(content: SlotContent, keys: readonly (keyof SlotContent)[]): string[] {
  const out: string[] = [];
  for (const key of keys) {
    const value = content[key];
    if (typeof value === "string" && value.trim()) out.push(value.trim());
  }
  return out;
}

function formatEmail(content: SlotContent, businessName: string): FormattedMessage {
  const paragraphs: string[] = [];

  const intro = sentences(content, ["opening", "continuity"]).join(" ");
  if (intro) paragraphs.push(intro);

  const middle = sentences(content, ["observation", "angle", "value"]).join(" ");
  if (middle) paragraphs.push(middle);

  if (content.cta?.trim()) paragraphs.push(content.cta.trim());

  const body = paragraphs.join("\n\n");
  const signoff = content.signoff?.trim();

  return {
    subject: `A quick note for ${businessName}`,
    body: signoff ? `${body}\n\nBest,\n${signoff}` : body,
  };
}

function formatInstagram(content: SlotContent): FormattedMessage {
  // No subject, no location wording, concise, and the signoff is dropped —
  // a DM already carries the sender's identity.
  const parts = sentences(content, ["opening", "continuity", "angle", "cta"]);
  let body = parts.join(" ");
  if (body.length > INSTAGRAM_TARGET_MAX_CHARS) {
    const trimmed = sentences(content, ["opening", "continuity", "cta"]).join(" ");
    body = trimmed.length <= INSTAGRAM_TARGET_MAX_CHARS ? trimmed : trimmed.slice(0, INSTAGRAM_TARGET_MAX_CHARS).trim();
  }
  return { subject: null, body };
}

function formatPhone(content: SlotContent): FormattedMessage {
  // A spoken script: opener, condensed observation/angle, spoken CTA, and
  // a graceful exit so the caller is never left improvising one.
  const lines: string[] = [];
  const opener = sentences(content, ["opening", "continuity"]).join(" ");
  if (opener) lines.push(`Opener: ${opener}`);

  const middle = sentences(content, ["observation", "angle"]).join(" ");
  if (middle) lines.push(`Reason for calling: ${middle}`);

  if (content.cta?.trim()) lines.push(`Ask: ${content.cta.trim()}`);

  lines.push("If it's not a good time: No problem at all — I'll leave you to it. Thanks for your time.");

  return { subject: null, body: lines.join("\n\n") };
}

function formatContactForm(content: SlotContent, businessName: string): FormattedMessage {
  // Plain text, concise, no signoff. The existing ContactForm UI has no
  // subject field, so no subject is produced for it.
  const paragraphs: string[] = [];
  const intro = sentences(content, ["opening", "continuity"]).join(" ");
  if (intro) paragraphs.push(intro);

  const middle = sentences(content, ["angle", "value"]).join(" ");
  if (middle) paragraphs.push(middle);

  if (content.cta?.trim()) paragraphs.push(content.cta.trim());

  void businessName;
  return { subject: null, body: paragraphs.join("\n\n") };
}

export function formatForChannel(
  channel: OutreachChannel,
  content: SlotContent,
  businessName: string,
): FormattedMessage {
  switch (channel) {
    case "email":
      return formatEmail(content, businessName);
    case "instagram":
      return formatInstagram(content);
    case "phone":
      return formatPhone(content);
    case "contact_form":
      return formatContactForm(content, businessName);
  }
}
