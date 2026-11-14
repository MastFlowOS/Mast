Mast: an intelligent client acquisition engine and CRM workspace for freelancers that identifies thriving local businesses with critical digital gaps and converts them through research-backed outreach.

## Current Stage & Goal of This Pitch
- **Status**: Pre-launch / NOT published yet. No live public users, revenue, or published deal-conversion baseline yet.
- **Internal Validation**: Completed 100s of internal discovery runs with a healthy engine and no scraper issues/blocks so far.
- **IMPORTANT INSTRUCTION FOR THE PANEL**: Do NOT focus on "you have 0 paying users / 0 revenue / no conversion proof" — the product is not published yet. Assume pre-launch status is a given. The founder specifically wants your honest critique of **the actual core idea of Mast**: the problem, the product mechanics, the architecture, and any non-monetary flaws or blind spots.

## Data Source Architecture & Scraper Resilience (Already Built)
- **Own Street Layer (OSM + DB Cache)**: Mast uses OpenStreetMap (Overpass) to build and cache boundary-verified street inventories in its own database, so it does not rely on Google Maps for geography.
- **8-Provider Engine**: The Python discovery engine includes `google_maps` and `overpass` (credential-free) alongside 6 official API-key providers (`yelp`, `apple_maps`, `foursquare`, `azure_maps`, `crunchbase`, `apollo`) as multi-source backups/complements.
- **Distributed Desktop Execution + Global Pool Caching**: Discovery runs from each user's desktop rather than a single central scraping IP, and discovered/enriched businesses are cached in Mast's Global Lead Pool so repeat queries don't re-hit external sources.

## Founder Clarifications on Product Mechanics & Retention
- **Niche-Matched Lead Delivery**: Mast only delivers a business to a freelancer when the business actually exhibits a gap matching that freelancer's service (e.g., an outdated logo is delivered to a graphic designer; a bad website is delivered to a web/tech freelancer).
- **Higher Relevance & Retention**: Instead of cold-outreaching 100 random businesses where most already have a provider or don't need the service (~5 replies, 1 deal), Mast targets ~90% relevance—delivering businesses that actually need the service, increasing deal close rates. When a freelancer sees Mast actively generating profit for them, they keep using it rather than churning after a few deals.
- **Why Paid Tiers Upgrade Beyond Volume**: 20 leads/day on Free is insufficient for cold outreach conversion and basically nothing for agencies. Paid tiers don't just add lead credits—they unlock higher lead quality, Opportunity Score ranking, AI Workspace, and outreach/CTA message generation, directly increasing close rates.

## 1. Problem & Origin
Built by a remote freelancer with 2 years of remote freelancing experience after hitting the limits of existing platforms:
- Freelance marketplaces (Fiverr/Upwork) impose brutal price wars, race-to-the-bottom bidding, and heavy take rates.
- Standard cold outreach yields ~2.5% response rates (5 replies per 200 messages, mostly automated or negative) because freelancers blindly pitch mature, corporate companies with existing in-house teams.
- Freelancers lack a structured sales process, leading to severe feast-or-famine income cycles.

## 2. Product Architecture & Technology
Mast operates as a cross-platform desktop application (Tauri + Rust frontend with a packaged local Python desktop worker) backed by a cloud coordination gateway:
- **Lead Discovery Engine**: Multi-source geographic and street-level discovery combining OpenStreetMap Overpass street geometry, Apple Maps, Azure Maps, Google Maps, Yelp, and Foursquare.
- **Dual Decoupled Scoring Model**:
  - **Business Health Score (0-100)**: Evaluates review count, rating volume, local foot traffic, verification confidence, and operating vitality. This ensures freelancers NEVER pitch broke or dying ghost businesses, but rather financially healthy, thriving local businesses with real customer revenue and budget.
  - **Opportunity Score (0-100)**: Scored across 12 canonical professions (Graphic Design, Web Design, Programming/Tech, Social Media, Copywriting, Local SEO, etc.) across 6 components: Website hygiene (load speed, SSL validity, linktree/weak builder placeholders), Branding (photo presence, visual assets), Social (dormant/abandoned accounts, post frequency), Growth (hiring, new locations), Newness, and Tech stack gaps.
- **No Meta TOS Violations / Ban Protection**:
  - Mast does NOT use unauthorized private Instagram scraping bots, headless bot logins, or automated spam DM blast scripts that risk Meta account termination.
  - Social handles are verified via public web crawl, schema.org markup, and Google Business profiles.
  - Freelancers reach out via human-in-the-loop execution across 4 compliant channels: Cold Email, Instagram DMs, Phone Scripts, and Website Contact Forms.
- **Empirical AI Outreach Engine**:
  - Synthesizes findings from Gong (85M sales emails dataset), Lavender (231k emails), and FTC CAN-SPAM regulations.
  - Strictly bans spam marketing jargon ("elevate your brand", "supercharge"), LLM em dashes, and premature calendar/meeting demands.
  - Uses interest-based, low-friction conversational hooks (30-70 words for Instagram DMs, 50-125 words for email) grounded strictly in verified lead facts with zero hallucinated audits.

## 3. Business Model, Pricing & Unit Economics
SaaS subscription model with 4 distinct tiers:
- **Free Tier ($0/mo)**: 20 leads/day (300/mo), local search, deterministic outreach templates, email & phone channels. Acts as a high-conversion freemium acquisition hook.
- **Starter Tier ($29/mo)**: 100 leads/day (1,500/mo), Instagram profile unlock, regional search, mission follow-ups.
- **Pro Tier ($79/mo)**: 400 leads/day (6,000/mo), Instant Pool ranked by Opportunity Score, business website discovery, standard AI personalization, 3 team seats.
- **Premium Tier ($199/mo)**: 1,000 leads/day (25,000/mo), Full AI opportunity intelligence & executive briefings, API access, unlimited team seats.

**Unit Economics & Margins**:
- **Gross Margins > 85%**: By using a local desktop worker model (Tauri + PyInstaller worker), intensive browser scraping and parsing are executed distributed at the client edge, minimizing central server infrastructure.
- **Global Lead Pool Efficiency**: Once a business is discovered, it is enriched and indexed in the Global Lead Pool. Paid users accessing the instant pool incur near-zero marginal scraping cost.
- **AI Inference Efficiency**: Free/Starter tiers use deterministic, zero-token template engines; Pro/Premium tiers leverage cost-efficient structured providers (DeepSeek / OpenRouter) with token costs under $0.005 per generated draft.

## 4. Churn Prevention & Retention Engine
Mast is not a one-and-done scraper; it is the freelancer's daily operating system:
- **Full Client Relationship Pipeline**: Lead status tracking from Discovery -> Contacted -> Replied -> Interested -> Meeting Booked -> Closed.
- **Focus Mode**: Daily task priority view telling the freelancer exactly which follow-ups, outreach messages, and actions to execute today.
- **Gamification & Daily Quests**: Milestone-based journey, daily goals, and quest rewards that incentivize daily active usage and build operational habits.
- **High ROI for Freelancer**: Closing just one client gig ($500 - $3,000) covers an entire year of Mast Pro ($79/mo), delivering massive customer lifetime value and sticky retention.
