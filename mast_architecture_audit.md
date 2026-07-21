# MAST OS — Full Architecture Audit
### Prepared for: Production Readiness Review · v1.0 Launch
### Date: June 2026 | Classification: Internal Engineering

---

## Executive Summary

MAST is a B2B SaaS lead-generation and CRM platform built on **React 19 + TanStack Router + Supabase + Tailwind CSS v4**. The codebase is impressively readable and has a clear product vision. However, it is **not production-ready** in its current state. The payment system is entirely a placeholder, plan enforcement is client-side only, lead generation produces mock data, and critical integrations (Stripe/Paddle, Gmail, webhooks) are missing entirely.

**Overall Readiness: 4.1 / 10**

---

## PHASE 1 — File Discovery and Dependency Map

### Files by Category

| Category | Files |
|----------|-------|
| **Auth** | login.tsx, signup.tsx, auth.callback.tsx, forgot-password.tsx, reset-password.tsx |
| **Supabase Client** | src/lib/supabase.ts |
| **API / Business Logic** | src/lib/api.ts (1,206 lines — monolith) |
| **Plans Config** | src/lib/plans.ts |
| **Hooks** | src/hooks/use-mast-api.ts |
| **Lead Workspace Utils** | src/lib/lead-workspace.ts |
| **Dashboard Layout** | src/routes/dashboard.tsx |
| **Dashboard Home** | src/routes/dashboard.index.tsx |
| **Leads / Generation** | src/routes/dashboard.leads.tsx |
| **CRM** | src/routes/dashboard.crm.tsx |
| **Pipeline** | src/routes/dashboard.pipeline.tsx |
| **Follow-ups** | src/routes/dashboard.follow-ups.tsx |
| **Import** | src/routes/dashboard.import.tsx |
| **Analytics** | src/routes/dashboard.analytics.tsx |
| **Subscription** | src/routes/dashboard.subscription.tsx |
| **Billing** | src/routes/dashboard.billing.tsx |
| **Settings** | src/routes/dashboard.settings.tsx |
| **Pricing Page** | src/routes/pricing.tsx |
| **Landing Page** | src/routes/index.tsx |
| **Database Schema** | Inferred from Supabase queries (no schema file present in repo) |
| **Environment Vars** | .env.example |
| **Route Tree** | src/routeTree.gen.ts |

### Inferred Database Tables (from api.ts queries)

| Table | Columns Used |
|-------|-------------|
| `profiles` | id, full_name, email, subscription_plan, pending_plan_change, daily_leads_used, monthly_leads_used, next_daily_reset, next_monthly_reset, settings (JSONB) |
| `leads` | id, user_id, business_name, instagram_handle, email, website, phone, niche, location, status, ig_followers, priority, tags, notes, source, created_at, updated_at, last_contacted_at, follow_up_at |
| `lead_activities` | id, lead_id, user_id, type, timestamp, content, channel, subject, body, metadata |
| `lead_messages` | id, lead_id, user_id, channel, template, content, subject, status, sent_at, created_at |
| `lead_followups` | id, lead_id, user_id, channel, due_at, completed_at, notes, status, sequence_name, step_number |

---

## PHASE 2 — Current Architecture: How It All Works

### Where is the plan stored?
In `profiles.subscription_plan` in Supabase (string: "free", "starter", "pro", "premium"). Read on every getMe() and getAccount() call. **No payment processor is involved.** Plans can be changed directly by writing to the DB, with zero payment verification.

### Where are credits stored?
- Monthly leads used: `profiles.monthly_leads_used` (integer counter)
- Daily leads used: `profiles.daily_leads_used` (integer counter)
- Credits are **not stored as a balance** — they are derived: monthlyRemaining = planConfig.monthlyLeadLimit - monthly_leads_used

### How are credits deducted?
In generateLeads() (api.ts line ~833):
- profiles.daily_leads_used += generatedCount
- profiles.monthly_leads_used += generatedCount

This is a **client-side write** from the browser. No server-side atomic transaction, no idempotency key, no fraud prevention.

### What happens when a user upgrades?
updateSubscription(plan) in api.ts:
- Determines if upgrade (target price > current price)
- **Immediate upgrade**: sets profiles.subscription_plan = newPlan, clears pending_plan_change
- **No payment is collected.** No Stripe checkout. No webhook.

### What happens when a user downgrades?
- Sets profiles.pending_plan_change = newPlan
- Actual downgrade happens on the **next monthly reset** via checkAndResetUsage()
- Lazy client-side reset pattern — not triggered by billing cycles

### What happens when they cancel?
**The cancel button is disabled.** "Cancellation will become available once billing is connected." There is no cancellation flow.

### How is billing currently handled?
**It isn't.** The billing page sets `const billingConnected = false`. All billing data is null or hardcoded. subscriptionStatus is hardcoded as "active" in getAccount().

### What payment integrations exist?
**None.** The billing page lists "Stripe · Paddle · PayPal" but none are installed in package.json.

### What parts are placeholders?

| Feature | Status |
|---------|--------|
| Payment collection | MISSING — Complete placeholder |
| Billing connected flag | MISSING — Hardcoded false |
| Subscription status | MISSING — Hardcoded "active" |
| billingPeriodStartedAt | MISSING — Always null |
| Invoice history | MISSING — Empty static UI |
| Lead generation engine | MISSING — Generates mock/random data |
| AI outreach drafts | MISSING — Throws 501 ENGINE_NOT_CONNECTED |
| Email send | MISSING — Throws 501 ENGINE_NOT_CONNECTED |
| Gmail integration | MISSING — Disabled, "Coming soon" |
| 2FA | MISSING — "Coming soon" badge |
| Webhook handling | MISSING — No webhook endpoint |
| Cancel plan | MISSING — Disabled button |
| Workspace disable/delete | MISSING — Shows toast but does nothing |
| Notification delivery | MISSING — Settings stored, never acted on |

---

## PHASE 3 — Feature Audit

| Feature | Status | Notes |
|---------|--------|-------|
| Authentication (email+password) | COMPLETE | Full signup, login, logout, email verification polling |
| Authentication (Google OAuth) | COMPLETE | Popup + redirect fallback |
| Auth callback / token verification | COMPLETE | Cross-device email confirm handled |
| Password reset | COMPLETE | Forgot password + reset flow |
| User profiles | PARTIAL | Name read from Supabase; profile name NOT written back on save |
| Billing UI | PARTIAL | UI exists but billingConnected = false, all real fields blank |
| Pricing page | PARTIAL | Static marketing page — BUT numbers contradict plans.ts |
| Usage tracking (daily) | COMPLETE | daily_leads_used incremented on generation |
| Usage tracking (monthly) | COMPLETE | monthly_leads_used incremented on generation |
| Daily limits enforcement | PARTIAL | Enforced client-side only — no server protection |
| Monthly limits enforcement | PARTIAL | Enforced client-side only — no server protection |
| Credit deduction | PARTIAL | Works but is client-side only |
| Credit reset (daily) | PARTIAL | Lazy reset on login/getAccount — no scheduled job |
| Credit reset (monthly) | PARTIAL | Same lazy pattern |
| Plan upgrades | PARTIAL | Writes to DB but no payment collected |
| Plan downgrades | PARTIAL | Queued correctly, applied at monthly reset |
| Subscription cancellation | MISSING | Button exists but disabled |
| Payment integration (Stripe) | MISSING | Not installed |
| Webhook handling | MISSING | No server-side webhook endpoints |
| Feature access (instant pool) | COMPLETE | account.limits.allowInstantPool checked |
| Feature access (premium pool) | COMPLETE | account.limits.allowPremiumPool checked |
| Feature access (API access) | PARTIAL | Flag exists in plans.ts, never enforced |
| CRM access gating | MISSING | Free plan should be CSV-only, never gated |
| Analytics gating | MISSING | All plans can access analytics |
| Analytics | COMPLETE | Full analytics page with real Supabase data |
| CRM | COMPLETE | Full CRUD, filtering, bulk ops, pagination |
| Lead generation permissions | COMPLETE | Channel and mode restrictions enforced |
| Admin functionality | MISSING | No admin panel |
| RLS policies | UNKNOWN | Cannot confirm — not present in repo |
| Supabase Edge Functions | MISSING | None in repo |
| Notification delivery | MISSING | Settings stored, never trigger emails |
| Lead generation engine | MISSING | Generates random mock data |
| AI outreach | MISSING | Throws 501 immediately |
| Email sending | MISSING | Throws 501 immediately |

---

## PHASE 4 — Code Quality Audit

### Duplicate Logic

1. **getStatusBadge() defined twice** — identical function in dashboard.billing.tsx and dashboard.subscription.tsx. Should be a shared utility.

2. **normalizeLeads()** — defined in dashboard.index.tsx and similar normalization in dashboard.subscription.tsx. Not unified.

3. **PLAN_BENEFITS object** in dashboard.billing.tsx duplicates plans.ts PLANS config. Two sources of truth for plan feature text.

4. **CRITICAL: Pricing page contradicts plans.ts** — pricing.tsx says 10/50/200/833 leads/day while plans.ts enforces 20/100/400/1000 leads/day. These actively contradict each other.

5. **REGIONS array** defined in both dashboard.leads.tsx and dashboard.settings.tsx. Should be a shared constant.

6. **formatDate() function** defined in both dashboard.billing.tsx and lib/lead-workspace.ts.

7. **Credit fallback chain** appears in at least 3 routes — redundant null-chaining pattern.

### Dead Code / Unused

- isMissingBackendEndpoint() in api.ts — always returns false
- error-capture.ts and error-page.ts in lib/ — potentially unreferenced
- LeadGenerationResponse.cost field computed but never displayed in UI

### Hardcoded Values That Must Change Before Launch

- api.ts: subscriptionStatus hardcoded as "active"
- api.ts: billingPeriodStartedAt always null
- dashboard.settings.tsx:155 — createdDate shows TODAY'S date, not actual account creation date
- dashboard.subscription.tsx — "Visa ending in 4242 / Expires 12/2027" is hardcoded fake card data shown to paid users
- dashboard.index.tsx:368 — Bar chart uses static [42, 65, 38, 80, 95, 60, 110], not real data
- login.tsx — "100 free credits on us" and "Trusted by 4,200+ teams" are hardcoded strings
- dashboard.subscription.tsx comparison table — hardcoded "10/day", "50/day", "200/day", "833/day" values contradicting plans.ts

### Potential Bugs

1. **Race condition on credit deduction** — generateLeads() reads the profile, validates limits, inserts leads, then updates the counter. A second concurrent request passes limit validation with stale data. No atomic transaction.

2. **Lazy reset can be bypassed** — checkAndResetUsage() only runs when the client calls getMe() or getAccount(). No scheduled job exists.

3. **Plan change with no payment verification** — updateSubscription() writes directly to profiles.subscription_plan from the browser. Any authenticated user can upgrade themselves to Premium for free.

4. **Pending plan change orphan** — If user queues a downgrade then immediately upgrades, the downgrade is silently abandoned.

5. **Monthly reset date bug** — nextMonth.setMonth(now.getMonth() + 1) does not handle month-boundary edge cases (Jan 31 rolls to Mar 2-3).

6. **bulkImportLeads() bypasses usage limits** — Users can import thousands of leads without triggering daily/monthly limit checks.

### Security Concerns

1. **All plan enforcement is client-side.** Without strict Supabase RLS policies, any user could UPDATE profiles SET subscription_plan = 'premium' directly.

2. **Credit counter updates are client-side.** Without RLS restricting writes, users could reset their own counters.

3. **No rate limiting** on lead generation.

4. **supabase is exported as nullable global** — multiple files use supabase! non-null assertions rather than proper null guards.

### Technical Debt

- api.ts is 1,206 lines — all business logic in one file
- Zero server-side code — purely client-rendered SPA calling Supabase directly
- No Edge Functions in repo
- wrangler.jsonc suggests Cloudflare Workers was planned but is unused
- No test files anywhere in the codebase
- Mock lead generation produces identical patterns immediately obvious to real users

---

## PHASE 5 — Missing Connections (Systems That Do Not Talk)

| System A | System B | Gap |
|----------|----------|-----|
| Pricing page | Auth / Subscription | CTA goes to /signup without passing selected plan |
| Billing page | Database | billingConnected = false hardcoded; renewal date always null |
| Plan upgrades | Payment processor | Clicking Upgrade changes DB with zero payment |
| Subscription cancellation | Anything | Cancel button is disabled; no flow exists |
| CRM access | Plan gating | Free plan users have full CRM access — should be CSV-only |
| Analytics page | Plan gating | All plans can access analytics |
| Import page | Usage limits | Bulk import does not deduct from daily/monthly limits |
| Settings (notifications) | Email delivery | Preferences saved but never trigger any email |
| Settings (profile name) | Database | Name field editable but save() does NOT write to profiles.full_name |
| Settings (workspace disable/delete) | Database | Danger zone buttons show modals/toasts but never call any API |
| Daily reset | Scheduled jobs | No cron job; reset only fires when client logs in |
| Lead generation | Real engine | Random fake data; Python backend not connected |
| AI outreach | Any AI provider | Throws 501 immediately |
| Email sending | SMTP/SendGrid | Throws 501 immediately |
| Dashboard bar chart | Real analytics data | Hardcoded static values [42,65,38,80,95,60,110] |
| Webhook receiver | Payment events | No /api/webhook route exists |
| Signup flow | Profile creation | No guaranteed trigger to auto-create profiles row |
| lead_activities table | Guaranteed existence | Multiple functions fall back gracefully when table missing — bad practice |

---

## PHASE 6 — Production Readiness Scores

| Subsystem | Score | Rationale |
|-----------|-------|-----------|
| Authentication | 8/10 | Solid — email+password, Google OAuth, cross-device email verify, password reset. Missing 2FA. |
| Supabase | 5/10 | Client configured correctly. RLS unknown. Profile auto-creation not confirmed. |
| CRM | 7/10 | Full CRUD, bulk ops, filtering. Missing plan-based gating. |
| Dashboard | 6/10 | Polished UI. Bar chart is hardcoded static data. Account creation date wrong. |
| Lead Generation | 2/10 | Form works, limits enforced client-side. Actual generation is random mock data. |
| Billing | 1/10 | UI fully built. billingConnected = false. Zero payment infrastructure. |
| Usage | 6/10 | Counters work end-to-end for mock engine. Lazy reset is fragile. Bulk import bypasses limits. Race condition risk. |
| Subscription | 4/10 | Plan UI works. Upgrades are free. No cancel flow. Status hardcoded "active." |
| Analytics | 7/10 | Real Supabase data drives charts. Missing plan gating. |
| Landing / Pricing | 7/10 | Visually strong. CTAs exist. Critical: pricing page numbers contradict plans.ts. |
| Database | 3/10 | Schema is coherent. No migrations. No RLS confirmed. Optional tables with fallbacks. |
| API / Architecture | 3/10 | All logic in one 1,206-line client file. No server-side layer. No rate limiting. |
| **Overall Architecture** | **4.1/10** | Strong UI/UX foundation. Zero production billing or enforcement infrastructure. |

---

## PHASE 7 — Ideal Architecture

### Principle: One Source of Truth

The Supabase profiles table is and should remain the single source of truth for user plan status. However, the plan MUST only be writable by:
1. A Supabase Edge Function (called after payment webhook verification)
2. Direct admin action (service-role key only)
Never from the browser anon key directly.

### Ownership Model

| Layer | Role | Writes To |
|-------|------|-----------|
| lib/plans.ts | Static plan config — READ ONLY | Nothing |
| Edge Function: handle-payment-webhook | Receives Stripe webhook, updates subscription_plan | profiles |
| Edge Function: reset-usage (cron) | Scheduled daily/monthly counter reset | profiles |
| Edge Function: generate-leads | Validates limits server-side, calls Lead Engine, returns leads | profiles + leads |
| lib/api.ts (refactored) | Read-only queries from browser; calls EFs for mutations | Nothing directly |
| hooks/use-mast-api.ts | React Query wrappers — READ ONLY from browser | N/A |
| Route components | Display only | N/A |

### How Usage Should Flow

1. User clicks "Generate Leads"
2. Client calls Edge Function (authenticated JWT)
3. EF validates session, profile exists
4. EF checks daily_remaining >= quantity AND monthly_remaining >= quantity
5. EF calls Python Lead Engine
6. EF atomically INSERTs leads + UPDATEs daily/monthly counters in one transaction
7. EF returns result to client
8. Client invalidates account cache
9. UI re-renders with updated counters

### How Payments Should Flow

1. User clicks "Upgrade to Pro" on subscription page
2. Client calls Edge Function create-checkout-session with target plan
3. EF creates Stripe Checkout session, returns URL
4. Client redirects to Stripe Checkout
5. User completes payment
6. Stripe sends webhook to handle-payment-webhook Edge Function
7. EF verifies webhook signature
8. EF updates profiles.subscription_plan + billing dates
9. EF returns 200 to Stripe
10. Client polling or Supabase Realtime detects profile change — UI updates

### How Credits Should Reset

A Supabase scheduled Edge Function (reset-usage) runs:
- Daily at midnight UTC: daily_leads_used = 0 for all profiles
- Monthly on billing anniversary: monthly_leads_used = 0, apply pending_plan_change

This replaces the current lazy client-side reset entirely.

---

## PHASE 8 — Priority Roadmap

### BLOCKS LAUNCH — Critical Path

| # | Task | Complexity | Est. Time | Risk | Depends On |
|---|------|-----------|-----------|------|------------|
| 1 | RLS policies on all Supabase tables | Medium | 1-2 days | HIGH | Supabase admin access |
| 2 | Server-side profile auto-creation trigger | Low | 2-4 hours | HIGH | Supabase admin |
| 3 | Stripe integration — install stripe, create checkout-session EF, webhook EF | High | 3-5 days | HIGH | Stripe account |
| 4 | Connect plan upgrade/downgrade to Stripe — remove direct DB writes from browser | High | 2-3 days | HIGH | Task 3 |
| 5 | Cancellation flow — Stripe subscription cancel via customer portal | Medium | 1-2 days | HIGH | Task 3 |
| 6 | Fix data contradiction — align pricing.tsx numbers with plans.ts | Low | 1 hour | HIGH | None |
| 7 | Move credit deduction server-side — Edge Function with atomic DB transaction | High | 2-3 days | HIGH | Supabase EF |
| 8 | Bulk import usage check — add limit validation to bulkImportLeads | Low | 2 hours | MEDIUM | None |

### REQUIRED FOR REAL PRODUCT

| # | Task | Complexity | Est. Time | Risk | Depends On |
|---|------|-----------|-----------|------|------------|
| 9 | Scheduled usage reset — Supabase cron EF for daily/monthly resets | Medium | 1 day | MEDIUM | Task 7 |
| 10 | Connect real Lead Engine — replace mock generation | High | 3-5 days | MEDIUM | Python backend |
| 11 | Plan-based CRM gating — free plan shows CSV-only warning | Low | 4 hours | MEDIUM | None |
| 12 | Fix profile name save — must update profiles.full_name | Low | 1 hour | MEDIUM | None |
| 13 | Fix dashboard bar chart — replace hardcoded values with real activity query | Low | 2-4 hours | MEDIUM | None |
| 14 | Fix account creation date — display actual profiles.created_at | Low | 30 min | MEDIUM | None |
| 15 | Remove hardcoded payment card — "Visa ending in 4242 / Expires 12/2027" | Low | 30 min | MEDIUM | Task 3 |
| 16 | Implement workspace disable/delete — hook up danger zone buttons to Supabase | Medium | 1 day | MEDIUM | None |
| 17 | Eliminate PLAN_BENEFITS duplication — single source in plans.ts | Low | 2 hours | LOW | None |
| 18 | Deduplicate getStatusBadge() — move to shared utility | Low | 30 min | LOW | None |

### IMPORTANT QUALITY

| # | Task | Complexity | Est. Time | Risk | Depends On |
|---|------|-----------|-----------|------|------------|
| 19 | Split api.ts into modules (api/auth.ts, api/leads.ts, api/account.ts, api/settings.ts) | Medium | 1 day | LOW | None |
| 20 | Analytics plan gating — limit to Starter+ | Low | 2 hours | LOW | None |
| 21 | Remove isMissingBackendEndpoint() dead code | Low | 10 min | LOW | None |
| 22 | Shared REGIONS constant — remove duplication | Low | 30 min | LOW | None |
| 23 | AI outreach integration — OpenAI/Anthropic via EF | High | 3-5 days | MEDIUM | AI provider account |
| 24 | Email send integration — SendGrid/Postmark via EF | High | 2-3 days | MEDIUM | Email provider |
| 25 | Gmail OAuth integration — connect sender identity | High | 3-5 days | MEDIUM | Google Cloud Console |
| 26 | Webhook infrastructure — Stripe webhooks, signature verification | High | 1-2 days | HIGH | Task 3 |
| 27 | Race condition fix — atomic credit deduction | High | — | HIGH | Task 7 |
| 28 | Test suite — unit tests for plans.ts, api.ts, usage logic | High | 3-5 days | MEDIUM | None |
| 29 | Add environment variables to .env.example | Low | 1 hour | MEDIUM | Task 3 |
| 30 | Notification delivery — wire preferences to actual email delivery | High | 2-3 days | MEDIUM | Task 24 |

### POLISH / POST-LAUNCH

| # | Task | Complexity | Est. Time | Risk | Depends On |
|---|------|-----------|-----------|------|------------|
| 31 | Team/workspace multi-seat support | High | 5-7 days | LOW | DB schema changes |
| 32 | API key system for Pro/Premium | High | 3-5 days | LOW | None |
| 33 | 2FA (TOTP) | Medium | 2-3 days | LOW | Supabase Auth config |
| 34 | Billing portal (Stripe Customer Portal) | Low | 4 hours | LOW | Task 3 |
| 35 | Admin panel | High | 5+ days | LOW | None |
| 36 | Pricing page CTA with plan pre-selection on signup | Low | 2 hours | LOW | None |
| 37 | Monthly reset date edge case fix (setMonth rollover) | Low | 30 min | LOW | Task 9 |

---

## Closing Assessment

This is a complete product shell with a beautiful UI, a coherent data model, and fully implemented CRM and analytics features — built on a foundation that cannot accept real money, cannot produce real leads, and cannot enforce its own subscription rules. The gap between what it looks like and what it does is the entire gap between demo and production.

**Before any real user signs up with payment intent:**
- RLS policies must be applied (security)
- Stripe must be integrated (revenue)
- Lead generation must produce real data (core value prop)
- The pricing page numbers must match the actual plan config (trust)

Everything else is polish on top of a working foundation.
