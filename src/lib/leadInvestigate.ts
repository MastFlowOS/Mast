import { URL } from "node:url";
import { validateImapHost } from "./inboxHostValidator.js";

export interface WebsiteSnapshot {
  checked: boolean;
  url: string | null;
  finalUrl: string | null;
  statusCode: number | null;
  https: boolean;
  title: string | null;
  metaDescription: string | null;
  cmsOrTech: string[];
  bookingTools: string[];
  analyticsTools: string[];
  emailsFound: string[];
  socialLinks: string[];
  ownerHints: string[];
  hasContactForm: boolean;
  hasMobileViewport: boolean;
  heroHeadline?: string | null;
  subHeadlines?: string[];
  ctaLabels?: string[];
  brokenLinks?: string[];
  hasVideoOrMedia?: boolean;
  imageCount?: number;
  copyrightYear?: number | null;
  error: string | null;
}

export interface LeadInvestigationContext {
  lead: {
    id: number;
    businessName: string;
    niche: string | null;
    location: string | null;
    website: string | null;
    email: string | null;
    phone: string | null;
    instagramHandle: string | null;
    linkedinHandle: string | null;
    opportunityScore: number | null;
    status: string;
    igFollowers: string | null;
    igBio: string | null;
    igLastPost: string | null;
  };
  business: {
    id: string;
    category: string | null;
    address: string | null;
    website: string | null;
    email: string | null;
    phone: string | null;
    instagram: string | null;
    facebook: string | null;
    linkedin: string | null;
    reviewsCount: number | null;
    reviewsRating: number | null;
    hasPhotos: boolean | null;
    websiteIsWeak: boolean | null;
    sslValid: boolean | null;
    loadTimeMs: number | null;
    seo: unknown;
    blog: unknown;
    confidence: number | null;
    lastVerifiedAt: string | null;
    isDisqualified: boolean;
    disqualifyReason: string | null;
    signals: Record<string, unknown>;
  } | null;
  healthScore: {
    score: number;
    breakdown: Record<string, unknown> | null;
  } | null;
  explanation: {
    score: number;
    summary: string;
    reasons: Array<{ reason?: string; label?: string; detail?: string; component?: string; weight?: number }>;
  } | null;
  recentActivitySummary: string[];
  websiteSnapshot: WebsiteSnapshot;
}

export interface InvestigateLeadResult {
  question: string;
  answer: string;
  mode: "ai" | "verified_data";
  confidence: "high" | "medium" | "low";
  evidence: string[];
  gaps: string[];
  websiteSnapshot: WebsiteSnapshot;
  checkedAt: string;
}

const MAX_HTML_BYTES = 200_000;
const FETCH_TIMEOUT_MS = 4_500;
const MAX_REDIRECTS = 2;

function emptySnapshot(url: string | null, error: string | null = null): WebsiteSnapshot {
  return {
    checked: false,
    url,
    finalUrl: null,
    statusCode: null,
    https: Boolean(url && url.startsWith("https://")),
    title: null,
    metaDescription: null,
    cmsOrTech: [],
    bookingTools: [],
    analyticsTools: [],
    emailsFound: [],
    socialLinks: [],
    ownerHints: [],
    hasContactForm: false,
    hasMobileViewport: false,
    heroHeadline: null,
    subHeadlines: [],
    ctaLabels: [],
    brokenLinks: [],
    hasVideoOrMedia: false,
    imageCount: 0,
    copyrightYear: null,
    error,
  };
}

export function normalizeWebsiteUrl(raw: string | null | undefined): string | null {
  if (!raw || typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const parsed = new URL(withScheme);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    if (!parsed.hostname) return null;
    return parsed.href;
  } catch {
    return null;
  }
}

function decodeHtmlEntities(str: string): string {
  return str
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
}

export function extractWebsiteSignalsFromHtml(html: string, finalUrl: string, statusCode: number): WebsiteSnapshot {
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? decodeHtmlEntities(titleMatch[1]).slice(0, 160) : null;

  const metaDescMatch =
    html.match(/<meta\b[^>]*name=["']description["'][^>]*content=["']([\s\S]*?)["'][^>]*>/i) ||
    html.match(/<meta\b[^>]*content=["']([\s\S]*?)["'][^>]*name=["']description["'][^>]*>/i);
  const metaDescription = metaDescMatch ? decodeHtmlEntities(metaDescMatch[1]).slice(0, 260) : null;

  const cmsOrTech: string[] = [];
  const addTech = (label: string, test: boolean) => {
    if (test && !cmsOrTech.includes(label)) cmsOrTech.push(label);
  };
  addTech("WordPress", /wp-content\/|wp-includes\/|<meta[^>]+generator[^>]+WordPress/i.test(html));
  addTech("Shopify", /cdn\.shopify\.com|Shopify\.theme/i.test(html));
  addTech("Wix", /wixstatic\.com|wix\.com\/|X-Wix-/i.test(html));
  addTech("Squarespace", /static1\.squarespace\.com|squarespace-cdn\.com/i.test(html));
  addTech("Webflow", /website-files\.com|data-wf-site|webflow\.com/i.test(html));
  addTech("Framer", /framerusercontent\.com|framer\.com/i.test(html));
  addTech("Next.js", /__NEXT_DATA__|\/_next\/static\//i.test(html));
  addTech("Elementor", /elementor/i.test(html));

  const bookingTools: string[] = [];
  const addBooking = (label: string, test: boolean) => {
    if (test && !bookingTools.includes(label)) bookingTools.push(label);
  };
  addBooking("Calendly", /calendly\.com/i.test(html));
  addBooking("Acuity Scheduling", /acuityscheduling\.com/i.test(html));
  addBooking("Booksy", /booksy\.com/i.test(html));
  addBooking("Mindbody", /mindbodyonline\.com/i.test(html));
  addBooking("Square Appointments", /squareup\.com\/appointments|square\.site/i.test(html));
  addBooking("Fresha", /fresha\.com/i.test(html));
  addBooking("Vagaro", /vagaro\.com/i.test(html));
  addBooking("JaneApp", /janeapp\.com/i.test(html));

  const analyticsTools: string[] = [];
  if (/googletagmanager\.com|gtag\(/i.test(html)) analyticsTools.push("Google Tag / Analytics");
  if (/connect\.facebook\.net\/.*fbevents\.js|fbq\(/i.test(html)) analyticsTools.push("Meta Pixel");
  if (/hotjar\.com/i.test(html)) analyticsTools.push("Hotjar");

  const emailMatches = Array.from(
    html.matchAll(/mailto:([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/gi),
  ).map((m) => m[1].toLowerCase());
  const emailsFound = Array.from(
    new Set(emailMatches.filter((e) => !/example\.com|sentry\.io|wixpress\.com/i.test(e))),
  ).slice(0, 3);

  const socialLinks: string[] = [];
  const socialPatterns = [
    /https?:\/\/(?:www\.)?instagram\.com\/[a-zA-Z0-9._-]+/gi,
    /https?:\/\/(?:www\.)?facebook\.com\/[a-zA-Z0-9._-]+/gi,
    /https?:\/\/(?:www\.)?linkedin\.com\/(?:company|in)\/[a-zA-Z0-9._-]+/gi,
  ];
  for (const pat of socialPatterns) {
    const match = html.match(pat);
    if (match && match[0] && !socialLinks.includes(match[0])) {
      socialLinks.push(match[0]);
    }
  }

  const ownerHints: string[] = [];
  const jsonLdBlocks = Array.from(
    html.matchAll(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi),
  );
  for (const block of jsonLdBlocks) {
    try {
      const parsed = JSON.parse(block[1]);
      const items = Array.isArray(parsed) ? parsed : [parsed];
      for (const item of items) {
        if (!item || typeof item !== "object") continue;
        const founder = (item as any).founder ?? (item as any).author;
        const founderName =
          typeof founder === "string"
            ? founder
            : founder && typeof founder === "object" && typeof founder.name === "string"
              ? founder.name
              : null;
        if (founderName && founderName.trim().length >= 2 && founderName.trim().length <= 60) {
          ownerHints.push(`Schema founder/author: ${founderName.trim()}`);
        }
      }
    } catch {
      // Ignore malformed JSON-LD blocks
    }
  }

  const hasContactForm = /<form\b[\s\S]*?(?:email|message|contact|inquiry|submit)[\s\S]*?<\/form>/i.test(html);
  const hasMobileViewport = /<meta\b[^>]*name=["']viewport["']/i.test(html);

  const h1Match = html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i);
  const rawH1 = h1Match ? decodeHtmlEntities(h1Match[1].replace(/<[^>]+>/g, " ")) : "";
  const heroHeadline = rawH1 && rawH1.length >= 3 && rawH1.length <= 140 ? rawH1 : null;

  const subHeadlines: string[] = [];
  const h2Matches = html.matchAll(/<h[23]\b[^>]*>([\s\S]*?)<\/h[23]>/gi);
  for (const m of h2Matches) {
    const text = decodeHtmlEntities(m[1].replace(/<[^>]+>/g, " "));
    if (text.length >= 4 && text.length <= 90 && text !== heroHeadline && !subHeadlines.includes(text)) {
      subHeadlines.push(text);
      if (subHeadlines.length >= 4) break;
    }
  }

  const ctaLabels: string[] = [];
  const ctaMatches = html.matchAll(/<(?:button|a)\b[^>]*>([\s\S]*?)<\/(?:button|a)>/gi);
  for (const m of ctaMatches) {
    const label = decodeHtmlEntities(m[1].replace(/<[^>]+>/g, " "));
    if (
      label.length >= 3 &&
      label.length <= 32 &&
      /\b(book|order|schedule|shop|get|request|quote|menu|contact|call|buy|start|join|reserve|appointment|view|explore)\b/i.test(label) &&
      !ctaLabels.includes(label)
    ) {
      ctaLabels.push(label);
      if (ctaLabels.length >= 5) break;
    }
  }

  const hasVideoOrMedia =
    /<video\b|youtube\.com\/embed|player\.vimeo\.com|tiktok\.com\/embed|instagram\.com\/reel|wistia\.com|loom\.com/i.test(
      html,
    );
  const imageCount = Array.from(html.matchAll(/<img\b/gi)).length;

  const brokenLinks: string[] = [];
  const anchorMatches = html.matchAll(/<a\b[^>]*href=["']\s*(#|#!|javascript:void\(0\)|)\s*["'][^>]*>([\s\S]*?)<\/a>/gi);
  for (const m of anchorMatches) {
    const label = decodeHtmlEntities(m[2].replace(/<[^>]+>/g, " "));
    if (
      label.length >= 2 &&
      label.length <= 40 &&
      !/^(skip to|close|menu|toggle|back to top)$/i.test(label)
    ) {
      const desc = `"${label}" button/link points to "${m[1] || "empty"}"`;
      if (!brokenLinks.includes(desc)) brokenLinks.push(desc);
      if (brokenLinks.length >= 4) break;
    }
  }

  let copyrightYear: number | null = null;
  const currentYear = new Date().getFullYear();
  const copyMatches = Array.from(html.matchAll(/(?:©|&copy;|copyright)\s*(20\d{2})/gi));
  if (copyMatches.length > 0) {
    const years = copyMatches.map((m) => Number(m[1])).filter((y) => y >= 2010 && y <= currentYear);
    if (years.length > 0) {
      const newest = Math.max(...years);
      if (newest <= currentYear - 2) {
        copyrightYear = newest;
      }
    }
  }

  return {
    checked: true,
    url: finalUrl,
    finalUrl,
    statusCode,
    https: finalUrl.startsWith("https://"),
    title: title || null,
    metaDescription: metaDescription || null,
    cmsOrTech,
    bookingTools,
    analyticsTools,
    emailsFound,
    socialLinks,
    ownerHints: Array.from(new Set(ownerHints)).slice(0, 3),
    hasContactForm,
    hasMobileViewport,
    heroHeadline,
    subHeadlines,
    ctaLabels,
    brokenLinks,
    hasVideoOrMedia,
    imageCount,
    copyrightYear,
    error: null,
  };
}

export interface InspectWebsiteDeps {
  validateHost?: typeof validateImapHost;
  fetchImpl?: typeof fetch;
}

export async function inspectWebsiteSnapshot(
  rawUrl: string | null | undefined,
  deps: InspectWebsiteDeps = {},
): Promise<WebsiteSnapshot> {
  const normalized = normalizeWebsiteUrl(rawUrl);
  if (!normalized) return emptySnapshot(null, null);

  const validateHost = deps.validateHost ?? validateImapHost;
  const fetchImpl = deps.fetchImpl ?? fetch;

  let currentUrl = normalized;
  try {
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const parsed = new URL(currentUrl);
      await validateHost(parsed.hostname);

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
      let res: Response;
      try {
        res = await fetchImpl(currentUrl, {
          method: "GET",
          redirect: "manual",
          signal: controller.signal,
          headers: {
            "User-Agent": "Mozilla/5.0 (compatible; MastResearchBot/1.0)",
            Accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
          },
        });
      } finally {
        clearTimeout(timer);
      }

      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get("location");
        if (!location || hop === MAX_REDIRECTS) {
          return emptySnapshot(normalized, `Website redirected (${res.status}) without a followable destination.`);
        }
        currentUrl = new URL(location, currentUrl).href;
        continue;
      }

      if (!res.ok) {
        return {
          ...emptySnapshot(normalized, `Website responded with HTTP ${res.status}.`),
          checked: true,
          finalUrl: currentUrl,
          statusCode: res.status,
          https: currentUrl.startsWith("https://"),
        };
      }

      const contentType = res.headers.get("content-type") || "";
      if (contentType && !/text\/html|application\/xhtml/i.test(contentType)) {
        return {
          ...emptySnapshot(normalized, `Non-HTML content type (${contentType.split(";")[0]}).`),
          checked: true,
          finalUrl: currentUrl,
          statusCode: res.status,
          https: currentUrl.startsWith("https://"),
        };
      }

      const text = (await res.text()).slice(0, MAX_HTML_BYTES);
      const snapshot = extractWebsiteSignalsFromHtml(text, currentUrl, res.status);
      snapshot.url = normalized;
      return snapshot;
    }
    return emptySnapshot(normalized, "Too many redirects.");
  } catch (err: any) {
    const message = err?.name === "AbortError" ? "Website request timed out." : err?.message || "Could not reach website.";
    return emptySnapshot(normalized, message);
  }
}

export function buildDeterministicInvestigation(
  question: string,
  ctx: LeadInvestigationContext,
): InvestigateLeadResult {
  const q = question.toLowerCase();
  const biz = ctx.business;
  const snap = ctx.websiteSnapshot;
  const evidence: string[] = [];
  const gaps: string[] = [];
  const answers: string[] = [];

  const websiteUrl = ctx.lead.website || biz?.website || null;
  const email = ctx.lead.email || biz?.email || null;
  const phone = ctx.lead.phone || biz?.phone || null;
  const ig = ctx.lead.instagramHandle || biz?.instagram || null;
  const linkedin = ctx.lead.linkedinHandle || biz?.linkedin || null;
  const signals = (biz?.signals ?? {}) as Record<string, unknown>;
  const techStack = (signals.tech_stack ?? {}) as Record<string, unknown>;

  if (websiteUrl) evidence.push(`Website on record: ${websiteUrl}`);
  else gaps.push("No official website is on record for this business.");

  if (email) evidence.push(`Verified email: ${email}`);
  if (phone) evidence.push(`Phone: ${phone}`);
  if (ig) evidence.push(`Instagram: @${ig.replace(/^@/, "")}${ctx.lead.igFollowers ? ` (${ctx.lead.igFollowers} followers)` : ""}`);
  if (linkedin) evidence.push(`LinkedIn: ${linkedin}`);

  if (biz?.reviewsCount != null || biz?.reviewsRating != null) {
    evidence.push(
      `Google reputation: ${biz.reviewsRating ?? "?"}★ across ${biz.reviewsCount ?? 0} reviews`,
    );
  }
  if (biz?.sslValid !== null && biz?.sslValid !== undefined) {
    evidence.push(`SSL valid: ${biz.sslValid ? "Yes" : "No"}`);
  }
  if (biz?.loadTimeMs != null) {
    evidence.push(`Stored page load time: ${biz.loadTimeMs}ms`);
  }
  if (snap.checked) {
    evidence.push(`Live homepage checked (HTTP ${snap.statusCode ?? "?"}${snap.title ? ` · "${snap.title}"` : ""})`);
    if (snap.cmsOrTech.length > 0) evidence.push(`Detected web tech: ${snap.cmsOrTech.join(", ")}`);
    if (snap.bookingTools.length > 0) evidence.push(`Detected booking tools: ${snap.bookingTools.join(", ")}`);
    if (snap.analyticsTools.length > 0) evidence.push(`Detected tracking: ${snap.analyticsTools.join(", ")}`);
    if (snap.ownerHints.length > 0) evidence.push(...snap.ownerHints);
    if (snap.emailsFound.length > 0) evidence.push(`Homepage mailto email(s): ${snap.emailsFound.join(", ")}`);
  } else if (websiteUrl && snap.error) {
    gaps.push(`Live website check did not complete: ${snap.error}`);
  }

  // Question-specific direct answering
  if (/wordpress|wix|shopify|squarespace|webflow|cms|platform|tech|stack|built with/i.test(q)) {
    const dbTech = Array.isArray(techStack.cms) ? techStack.cms : typeof techStack.cms === "string" ? [techStack.cms] : [];
    const combinedTech = Array.from(new Set([...snap.cmsOrTech, ...dbTech.map(String)]));
    if (!websiteUrl) {
      answers.push(`${ctx.lead.businessName} has no website on record, so no CMS or website stack is in use.`);
    } else if (combinedTech.length > 0) {
      answers.push(`Detected website technology: ${combinedTech.join(", ")}.`);
    } else if (snap.checked) {
      answers.push(
        `Checked ${snap.finalUrl ?? websiteUrl} (HTTP ${snap.statusCode}) and did not see WordPress, Shopify, Wix, Squarespace, or Webflow signatures in the homepage HTML (it may be custom-built or rendered client-side).`,
      );
    } else {
      answers.push(`Could not inspect ${websiteUrl} right now (${snap.error || "unreachable"}), and no CMS is stored in the database.`);
    }
  }

  if (/owner|founder|ceo|decision|who|manager|person|name/i.test(q)) {
    if (snap.ownerHints.length > 0) {
      answers.push(`Found potential leadership clues on the homepage: ${snap.ownerHints.join("; ")}.`);
    } else {
      const contactHint = linkedin
        ? `LinkedIn is listed (${linkedin}), which is the best place to identify the owner or decision-maker.`
        : email
          ? `No owner name is stored in MAST's database or homepage metadata. Direct contact on record is ${email}.`
          : `No owner or decision-maker name is stored in MAST's database or homepage metadata.`;
      answers.push(contactHint);
      gaps.push("Owner/decision-maker name is not verified in stored data.");
    }
  }

  if (/book|schedul|appoint|calendly|online/i.test(q)) {
    const storedBooking = Array.isArray(techStack.booking) ? techStack.booking.map(String) : [];
    const allBooking = Array.from(new Set([...snap.bookingTools, ...storedBooking]));
    if (allBooking.length > 0) {
      answers.push(`Online booking tool detected: ${allBooking.join(", ")}.`);
    } else if (snap.checked) {
      answers.push(
        `No known online booking widget (Calendly, Acuity, Booksy, Square, Fresha, Vagaro, Mindbody) was detected on their homepage${snap.hasContactForm ? ", though a contact form is present" : ""}.`,
      );
    } else {
      answers.push("No online booking tool is recorded in MAST's stored signals for this lead.");
    }
  }

  if (/ssl|https|mobile|speed|slow|seo|blog|website|weak/i.test(q)) {
    const webFacts: string[] = [];
    if (biz?.websiteIsWeak != null) webFacts.push(`website_is_weak=${biz.websiteIsWeak ? "yes" : "no"}`);
    if (biz?.sslValid != null) webFacts.push(`SSL=${biz.sslValid ? "valid" : "invalid/missing"}`);
    if (biz?.loadTimeMs != null) webFacts.push(`load time=${biz.loadTimeMs}ms`);
    if (snap.checked) webFacts.push(`mobile viewport=${snap.hasMobileViewport ? "present" : "missing"}`);
    if (webFacts.length > 0) {
      answers.push(`Website health telemetry: ${webFacts.join(", ")}.`);
    } else if (!websiteUrl) {
      answers.push(`${ctx.lead.businessName} has no website listed on record.`);
    }
  }

  if (/instagram|social|ig|follower|post|bio/i.test(q)) {
    if (ig) {
      answers.push(
        `Instagram @${ig.replace(/^@/, "")} is on record${ctx.lead.igFollowers ? ` with ${ctx.lead.igFollowers} followers` : ""}${ctx.lead.igLastPost ? ` (last post: ${ctx.lead.igLastPost})` : ""}.${ctx.lead.igBio ? ` Bio: "${ctx.lead.igBio}"` : ""}`,
      );
    } else {
      answers.push("No Instagram handle is recorded for this lead.");
    }
  }

  if (/review|rating|reputation|google/i.test(q)) {
    if (biz?.reviewsRating != null || biz?.reviewsCount != null) {
      answers.push(
        `${ctx.lead.businessName} has a ${biz?.reviewsRating ?? "?"}★ rating across ${biz?.reviewsCount ?? 0} reviews.`,
      );
    } else {
      answers.push("No Google review count or rating is stored for this lead.");
    }
  }

  if (answers.length === 0) {
    const scorePart =
      ctx.explanation?.score != null
        ? `Opportunity Score is ${ctx.explanation.score}/100${ctx.explanation.summary ? ` (${ctx.explanation.summary})` : ""}.`
        : ctx.lead.opportunityScore != null
          ? `Opportunity Score is ${ctx.lead.opportunityScore}/100.`
          : "";
    const techPart =
      snap.cmsOrTech.length > 0
        ? ` Live homepage check detected: ${snap.cmsOrTech.join(", ")}.`
        : snap.checked
          ? ` Live homepage responded HTTP ${snap.statusCode} (${snap.title || "no title"}).`
          : "";
    answers.push(
      `${scorePart || `Verified record for ${ctx.lead.businessName}.`}${techPart} See the verified evidence bullets below for everything confirmed on record.`.trim(),
    );
  }

  if (ctx.recentActivitySummary.length > 0) {
    evidence.push(`Recent outreach activity: ${ctx.recentActivitySummary[0]}`);
  }

  const confidence: "high" | "medium" | "low" =
    evidence.length >= 4 ? "high" : evidence.length >= 2 ? "medium" : "low";

  return {
    question,
    answer: answers.join(" "),
    mode: "verified_data",
    confidence,
    evidence: evidence.slice(0, 8),
    gaps: gaps.slice(0, 4),
    websiteSnapshot: snap,
    checkedAt: new Date().toISOString(),
  };
}
