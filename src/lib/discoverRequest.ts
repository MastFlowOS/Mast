/**
 * Single source of truth for the Discover request. The submit handler, the
 * "current setup" summary shown in the AI Overview, and the tests all read the
 * request from here, so what the page displays can never drift from what is
 * actually sent.
 */
import type { DiscoveryMode } from "../config/plans.js";
import { generationModeFor } from "./discoveryMethod.js";
import { channelsForRequest } from "./channelSelection.js";

export type DiscoverFormState = {
  quantity: number;
  regions: readonly string[];
  niches: readonly string[];
  channels: readonly string[];
  method: DiscoveryMode;
  /** set only by the explicit "Find remaining with Live Discovery" action */
  followsJobId?: string;
};

export type DiscoverRequestPayload = {
  quantity: number;
  region: string;
  niche: string;
  channels: string[];
  method: DiscoveryMode;
  mode: ReturnType<typeof generationModeFor>;
  followsJobId?: string;
};

export function buildDiscoverRequest(form: DiscoverFormState): DiscoverRequestPayload {
  const payload: DiscoverRequestPayload = {
    quantity: form.quantity,
    region: form.regions.join(", "),
    niche: form.niches.join(", "),
    channels: channelsForRequest([...form.channels]),
    method: form.method,
    mode: generationModeFor(form.method),
  };
  if (form.followsJobId) payload.followsJobId = form.followsJobId;
  return payload;
}

export function summarizeDiscoverRequest(req: DiscoverRequestPayload): {
  niche: string;
  region: string;
  amount: string;
  channels: string;
  method: DiscoveryMode;
} {
  return {
    niche: req.niche || "—",
    region: req.region || "—",
    amount: String(req.quantity),
    channels: req.channels.length > 0 ? req.channels.join(" + ") : "Any",
    method: req.method,
  };
}
