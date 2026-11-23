import { normalizeInstagram } from "./instagram.js";

export type OutreachChannelKey = "instagram" | "email" | "phone" | "contact_form";

export type InstagramActivityLevel =
  | "very_active"
  | "active"
  | "slow"
  | "inactive"
  | "private"
  | "unknown"
  | "none";

export interface InstagramActivitySnapshot {
  handle: string | null;
  profileUrl: string | null;
  status: InstagramActivityLevel;
  statusLabel: string;
  worthDming: boolean | null;
  lastPostDaysAgo: number | null;
  lastPostLabel: string | null;
  lastPostAt: string | null;
  lastPostCaption: string | null;
  hasActiveStory: boolean | null;
  storyLabel: string;
  followersCount: number | null;
  postsCount: number | null;
  isPrivate: boolean | null;
  source: "live" | "stored" | "none";
  checkedAt: string | null;
  liveCheckNote: string | null;
}

export interface ChannelActivitySummary {
  channel: OutreachChannelKey;
  label: string;
  available: boolean;
  score: number;
  status: "best" | "active" | "available" | "weak" | "unavailable";
  summary: string;
}

export interface BusinessActivityReport {
  mostActiveOn: OutreachChannelKey | null;
  mostActiveLabel: string;
  recommendationReason: string;
  confidence: "high" | "medium" | "low";
  instagram: InstagramActivitySnapshot;
  channels: ChannelActivitySummary[];
  extraSignals: {
    hasWebsite: boolean;
    websiteIsWeak: boolean | null;
    reviewsCount: number | null;
    reviewsRating: number | null;
    hasFacebook: boolean;
    hasLinkedin: boolean;
    hasBlog: boolean;
  };
}

export interface LiveInstagramCheckResult {
  ok: boolean;
  handle: string;
  lastPostDaysAgo: number | null;
  lastPostAt: string | null;
  lastPostCaption: string | null;
  hasActiveStory: boolean | null;
  followersCount: number | null;
  postsCount: number | null;
  isPrivate: boolean | null;
  bio: string | null;
  note: string | null;
  checkedAt: string;
}

const FREE_EMAIL_DOMAINS = new Set([
  "gmail.com",
  "yahoo.com",
  "hotmail.com",
  "outlook.com",
  "icloud.com",
  "aol.com",
  "live.com",
  "me.com",
  "proton.me",
  "protonmail.com",
]);

export function formatDaysAgoLabel(days: number | null | undefined): string | null {
  if (typeof days !== "number" || !Number.isFinite(days) || days < 0) return null;
  const rounded = Math.floor(days);
  if (rounded === 0) return "Today";
  if (rounded === 1) return "Yesterday";
  if (rounded < 7) return `${rounded} days ago`;
  if (rounded < 30) {
    const weeks = Math.floor(rounded / 7);
    return weeks === 1 ? "1 week ago" : `${weeks} weeks ago`;
  }
  if (rounded < 365) {
    const months = Math.floor(rounded / 30);
    return months === 1 ? "1 month ago" : `${months} months ago`;
  }
  const years = Math.floor(rounded / 365);
  return years === 1 ? "Over a year ago" : `${years}+ years ago`;
}

export function parseDaysAgoFromText(raw: string | null | undefined, nowMs = Date.now()): number | null {
  if (!raw || typeof raw !== "string") return null;
  const text = raw.trim().toLowerCase();
  if (!text) return null;

  if (text === "today" || text === "just now" || /^\d+\s*(m|min|mins|minute|minutes|h|hr|hrs|hour|hours)\s*ago$/.test(text)) {
    return 0;
  }
  if (text === "yesterday") return 1;

  const dayMatch = text.match(/\b(\d+)\s*(?:d|day|days)\s*ago\b/);
  if (dayMatch) return Number(dayMatch[1]);

  const weekMatch = text.match(/\b(\d+)\s*(?:w|wk|wks|week|weeks)\s*ago\b/);
  if (weekMatch) return Number(weekMatch[1]) * 7;

  const monthMatch = text.match(/\b(\d+)\s*(?:mo|mos|month|months)\s*ago\b/);
  if (monthMatch) return Number(monthMatch[1]) * 30;

  const yearMatch = text.match(/\b(\d+)\s*(?:y|yr|yrs|year|years)\s*ago\b/);
  if (yearMatch) return Number(yearMatch[1]) * 365;

  // ISO date string check
  if (/^\d{4}-\d{2}-\d{2}/.test(text)) {
    const ts = Date.parse(text);
    if (!Number.isNaN(ts)) {
      return Math.max(0, Math.floor((nowMs - ts) / 86_400_000));
    }
  }

  return null;
}

export function parseFollowersNumber(raw: string | number | null | undefined): number | null {
  if (typeof raw === "number" && Number.isFinite(raw) && raw >= 0) return Math.round(raw);
  if (typeof raw !== "string") return null;
  const cleaned = raw.trim().toLowerCase().replace(/,/g, "");
  if (!cleaned) return null;
  const match = cleaned.match(/^(\d+(?:\.\d+)?)\s*([km])?$/);
  if (!match) return null;
  const base = Number(match[1]);
  if (!Number.isFinite(base)) return null;
  if (match[2] === "k") return Math.round(base * 1_000);
  if (match[2] === "m") return Math.round(base * 1_000_000);
  return Math.round(base);
}

/**
 * Checks a public Instagram profile for last post date, follower/post counts,
 * privacy status, and active story metadata (when exposed by Instagram).
 * Never fabricates data: if Instagram blocks unauthenticated requests or hides
 * story rings behind login, it reports that honestly.
 */
export async function fetchLiveInstagramActivity(
  rawHandle: string,
  fetchImpl: typeof fetch = fetch,
): Promise<LiveInstagramCheckResult> {
  const normalized = normalizeInstagram(rawHandle);
  const handle = normalized?.handle || rawHandle.replace(/^@+/, "").trim();
  const checkedAt = new Date().toISOString();

  if (!handle) {
    return {
      ok: false,
      handle: "",
      lastPostDaysAgo: null,
      lastPostAt: null,
      lastPostCaption: null,
      hasActiveStory: null,
      followersCount: null,
      postsCount: null,
      isPrivate: null,
      bio: null,
      note: "No valid Instagram handle.",
      checkedAt,
    };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 7_000);

  try {
    const apiUrl = `https://i.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(handle)}`;
    const response = await fetchImpl(apiUrl, {
      method: "GET",
      signal: controller.signal,
      headers: {
        "x-ig-app-id": "936619743392459",
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        Accept: "application/json, text/plain, */*",
        "Accept-Language": "en-US,en;q=0.9",
        Referer: `https://www.instagram.com/${encodeURIComponent(handle)}/`,
      },
    });

    if (response.ok) {
      const json = (await response.json()) as Record<string, any>;
      const user = json?.data?.user;
      if (user && typeof user === "object") {
        const isPrivate = typeof user.is_private === "boolean" ? user.is_private : null;
        const followersCount =
          typeof user?.edge_followed_by?.count === "number"
            ? user.edge_followed_by.count
            : null;
        const timeline = user?.edge_owner_to_timeline_media;
        const postsCount =
          typeof timeline?.count === "number" ? timeline.count : null;
        const edges: Array<{ node?: Record<string, any> }> = Array.isArray(timeline?.edges)
          ? timeline.edges
          : [];

        // Pinned posts appear first in `edges` — pick the newest timestamp across the top 6 posts
        let newestTsSec: number | null = null;
        let newestCaption: string | null = null;
        for (const edge of edges.slice(0, 6)) {
          const ts = edge?.node?.taken_at_timestamp;
          if (typeof ts === "number" && Number.isFinite(ts) && (newestTsSec === null || ts > newestTsSec)) {
            newestTsSec = ts;
            const capText = edge?.node?.edge_media_to_caption?.edges?.[0]?.node?.text;
            newestCaption = typeof capText === "string" && capText.trim()
              ? capText.trim().replace(/\s+/g, " ").slice(0, 140)
              : null;
          }
        }

        const nowMs = Date.now();
        const lastPostAt = newestTsSec ? new Date(newestTsSec * 1000).toISOString() : null;
        const lastPostDaysAgo = newestTsSec
          ? Math.max(0, Math.floor((nowMs - newestTsSec * 1000) / 86_400_000))
          : null;

        // Instagram only exposes latest_reel_media on some public responses; if absent, keep null (honest)
        let hasActiveStory: boolean | null = null;
        if (typeof user.latest_reel_media === "number") {
          const storyAgeSec = Math.floor(nowMs / 1000) - user.latest_reel_media;
          hasActiveStory = user.latest_reel_media > 0 && storyAgeSec >= 0 && storyAgeSec <= 86_400;
        }

        const bio =
          typeof user.biography === "string" && user.biography.trim()
            ? user.biography.trim().slice(0, 220)
            : null;

        return {
          ok: true,
          handle,
          lastPostDaysAgo,
          lastPostAt,
          lastPostCaption: newestCaption,
          hasActiveStory,
          followersCount,
          postsCount,
          isPrivate,
          bio,
          note:
            hasActiveStory === null
              ? "Stories require an Instagram login to verify — click Open Profile to check live story ring."
              : null,
          checkedAt,
        };
      }
    }

    // Fallback: fetch public profile HTML meta tags for follower/post counts
    const htmlRes = await fetchImpl(`https://www.instagram.com/${encodeURIComponent(handle)}/`, {
      method: "GET",
      signal: controller.signal,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml",
      },
    });

    if (htmlRes.ok) {
      const html = await htmlRes.text();
      const descMatch = html.match(/<meta\s+(?:property|name)=["'](?:og:description|description)["']\s+content=["']([^"']+)["']/i);
      const desc = descMatch?.[1] ?? "";
      const followersMatch = desc.match(/([\d.,]+[kKmM]?)\s+Followers/i);
      const postsMatch = desc.match(/([\d.,]+[kKmM]?)\s+Posts/i);
      const followersCount = followersMatch ? parseFollowersNumber(followersMatch[1]) : null;
      const postsCount = postsMatch ? parseFollowersNumber(postsMatch[1]) : null;

      if (followersCount !== null || postsCount !== null) {
        return {
          ok: true,
          handle,
          lastPostDaysAgo: null,
          lastPostAt: null,
          lastPostCaption: null,
          hasActiveStory: null,
          followersCount,
          postsCount,
          isPrivate: null,
          bio: null,
          note: "Instagram restricted post dates without login — open profile to see exact last post & story.",
          checkedAt,
        };
      }
    }

    return {
      ok: false,
      handle,
      lastPostDaysAgo: null,
      lastPostAt: null,
      lastPostCaption: null,
      hasActiveStory: null,
      followersCount: null,
      postsCount: null,
      isPrivate: null,
      bio: null,
      note: "Instagram blocked automated check right now — click Open Profile to verify directly.",
      checkedAt,
    };
  } catch {
    return {
      ok: false,
      handle,
      lastPostDaysAgo: null,
      lastPostAt: null,
      lastPostCaption: null,
      hasActiveStory: null,
      followersCount: null,
      postsCount: null,
      isPrivate: null,
      bio: null,
      note: "Instagram check timed out — click Open Profile to verify directly.",
      checkedAt,
    };
  } finally {
    clearTimeout(timeout);
  }
}

export interface ComputeBusinessActivityInput {
  email?: string | null;
  phone?: string | null;
  website?: string | null;
  instagramHandle?: string | null;
  igFollowers?: string | number | null;
  igLastPost?: string | null;
  igLastPostDays?: number | null;
  liveIg?: LiveInstagramCheckResult | null;
  facebook?: string | null;
  linkedin?: string | null;
  reviewsCount?: number | null;
  reviewsRating?: number | null;
  websiteIsWeak?: boolean | null;
  hasBlog?: boolean | null;
}

export function computeBusinessActivity(input: ComputeBusinessActivityInput): BusinessActivityReport {
  const normalizedIg = normalizeInstagram(input.instagramHandle ?? null);
  const igHandle = normalizedIg?.handle ?? null;
  const igUrl = normalizedIg?.profileUrl ?? (igHandle ? `https://www.instagram.com/${igHandle}/` : null);

  // Resolve Instagram signals (live check overrides stored values when available)
  const live = input.liveIg ?? null;
  const parsedStoredDays =
    typeof input.igLastPostDays === "number" && Number.isFinite(input.igLastPostDays)
      ? input.igLastPostDays
      : parseDaysAgoFromText(input.igLastPost);

  const lastPostDaysAgo = live?.lastPostDaysAgo ?? parsedStoredDays ?? null;
  const lastPostLabel =
    formatDaysAgoLabel(lastPostDaysAgo) ??
    (input.igLastPost && !parseDaysAgoFromText(input.igLastPost) ? input.igLastPost.slice(0, 60) : null);

  const followersCount =
    live?.followersCount ?? parseFollowersNumber(input.igFollowers) ?? null;
  const postsCount = live?.postsCount ?? null;
  const isPrivate = live?.isPrivate ?? null;
  const hasActiveStory = live?.hasActiveStory ?? null;

  let igStatus: InstagramActivityLevel = "none";
  let igStatusLabel = "No Instagram";
  let worthDming: boolean | null = false;

  if (igHandle) {
    if (isPrivate === true) {
      igStatus = "private";
      igStatusLabel = "Private Account";
      worthDming = false;
    } else if (hasActiveStory === true || (lastPostDaysAgo !== null && lastPostDaysAgo <= 7)) {
      igStatus = "very_active";
      igStatusLabel = "Very Active on IG";
      worthDming = true;
    } else if (lastPostDaysAgo !== null && lastPostDaysAgo <= 30) {
      igStatus = "active";
      igStatusLabel = "Active on IG";
      worthDming = true;
    } else if (lastPostDaysAgo !== null && lastPostDaysAgo <= 90) {
      igStatus = "slow";
      igStatusLabel = "Slow on IG";
      worthDming = false;
    } else if ((lastPostDaysAgo !== null && lastPostDaysAgo > 90) || postsCount === 0) {
      igStatus = "inactive";
      igStatusLabel = postsCount === 0 ? "Empty IG (0 posts)" : "Inactive on IG";
      worthDming = false;
    } else {
      igStatus = "unknown";
      igStatusLabel = "IG Not Verified Yet";
      worthDming = null;
    }
  }

  const storyLabel = !igHandle
    ? "No IG"
    : hasActiveStory === true
      ? "Active story right now"
      : hasActiveStory === false
        ? "No active story"
        : "Check on IG (login required)";

  const instagram: InstagramActivitySnapshot = {
    handle: igHandle,
    profileUrl: igUrl,
    status: igStatus,
    statusLabel: igStatusLabel,
    worthDming,
    lastPostDaysAgo,
    lastPostLabel,
    lastPostAt: live?.lastPostAt ?? null,
    lastPostCaption: live?.lastPostCaption ?? null,
    hasActiveStory,
    storyLabel,
    followersCount,
    postsCount,
    isPrivate,
    source: live?.ok ? "live" : igHandle && (lastPostDaysAgo !== null || followersCount !== null) ? "stored" : "none",
    checkedAt: live?.checkedAt ?? null,
    liveCheckNote: live?.note ?? null,
  };

  // Score each channel to determine "Most Active On"
  const email = input.email?.trim() || null;
  const emailDomain = email && email.includes("@") ? email.split("@")[1]?.toLowerCase() : null;
  const isBusinessDomainEmail = Boolean(emailDomain && !FREE_EMAIL_DOMAINS.has(emailDomain));

  let igScore = 0;
  let igSummary = "No Instagram profile found.";
  if (igHandle) {
    if (igStatus === "very_active") {
      igScore = 95;
      igSummary = hasActiveStory
        ? `Active story live & posted ${lastPostLabel ?? "recently"} — fast DM replies likely.`
        : `Posted ${lastPostLabel} — very active on Instagram.`;
    } else if (igStatus === "active") {
      igScore = 82;
      igSummary = `Posted ${lastPostLabel} — active account, good for DM.`;
    } else if (igStatus === "slow") {
      igScore = 44;
      igSummary = `Last post was ${lastPostLabel} — slow on IG, Email or Phone is safer.`;
    } else if (igStatus === "inactive") {
      igScore = 15;
      igSummary =
        postsCount === 0
          ? "0 posts on Instagram — don't waste time DMing here."
          : `Last post was ${lastPostLabel} — looks inactive, skip IG DM.`;
    } else if (igStatus === "private") {
      igScore = 20;
      igSummary = "Private Instagram — DMs usually get hidden in requests.";
    } else {
      igScore = 58;
      igSummary = "Instagram handle listed — click Check IG to verify last post.";
    }
  }

  let emailScore = 0;
  let emailSummary = "No email address on file.";
  if (email) {
    if (isBusinessDomainEmail) {
      emailScore = 86;
      emailSummary = `Direct business email (${emailDomain}) — reliable channel.`;
    } else {
      emailScore = 74;
      emailSummary = "Direct owner email on file.";
    }
  }

  const phone = input.phone?.trim() || null;
  let phoneScore = 0;
  let phoneSummary = "No phone number on file.";
  if (phone) {
    const highReviewActivity = typeof input.reviewsCount === "number" && input.reviewsCount >= 20;
    phoneScore = highReviewActivity ? 78 : 66;
    phoneSummary = highReviewActivity
      ? `Active local business (${input.reviewsCount} Google reviews) — phone line active.`
      : "Direct phone number listed.";
  }

  const website = input.website?.trim() || null;
  let formScore = 0;
  let formSummary = "No website on file.";
  if (website) {
    formScore = input.websiteIsWeak ? 40 : 52;
    formSummary = input.websiteIsWeak
      ? "Website exists (outdated/weak) — contact form backup."
      : "Active website available as fallback.";
  }

  const rawChannels: ChannelActivitySummary[] = [
    {
      channel: "instagram",
      label: "Instagram DM",
      available: Boolean(igHandle),
      score: igScore,
      status:
        !igHandle
          ? "unavailable"
          : igScore >= 80
            ? "active"
            : igScore >= 50
              ? "available"
              : "weak",
      summary: igSummary,
    },
    {
      channel: "email",
      label: "Direct Email",
      available: Boolean(email),
      score: emailScore,
      status: !email ? "unavailable" : emailScore >= 80 ? "active" : "available",
      summary: emailSummary,
    },
    {
      channel: "phone",
      label: "Phone Call",
      available: Boolean(phone),
      score: phoneScore,
      status: !phone ? "unavailable" : phoneScore >= 75 ? "active" : "available",
      summary: phoneSummary,
    },
    {
      channel: "contact_form",
      label: "Website Form",
      available: Boolean(website),
      score: formScore,
      status: !website ? "unavailable" : "available",
      summary: formSummary,
    },
  ];

  const sortedAvailable = [...rawChannels]
    .filter((c) => c.available)
    .sort((a, b) => b.score - a.score);

  const best = sortedAvailable[0] ?? null;

  const channels: ChannelActivitySummary[] = rawChannels.map((c) =>
    best && c.channel === best.channel ? { ...c, status: "best" } : c,
  );

  let recommendationReason = "No verified contact channels found for this business yet.";
  let confidence: "high" | "medium" | "low" = "low";

  if (best) {
    recommendationReason = best.summary;
    if (best.channel === "instagram" && (igStatus === "very_active" || igStatus === "active")) {
      confidence = "high";
    } else if (best.channel === "email" && isBusinessDomainEmail) {
      confidence = "high";
    } else if (best.score >= 65) {
      confidence = "medium";
    }
  }

  return {
    mostActiveOn: best?.channel ?? null,
    mostActiveLabel: best?.label ?? "No Channel Found",
    recommendationReason,
    confidence,
    instagram,
    channels,
    extraSignals: {
      hasWebsite: Boolean(website),
      websiteIsWeak: input.websiteIsWeak ?? null,
      reviewsCount: typeof input.reviewsCount === "number" ? input.reviewsCount : null,
      reviewsRating: typeof input.reviewsRating === "number" ? input.reviewsRating : null,
      hasFacebook: Boolean(input.facebook),
      hasLinkedin: Boolean(input.linkedin),
      hasBlog: Boolean(input.hasBlog),
    },
  };
}
