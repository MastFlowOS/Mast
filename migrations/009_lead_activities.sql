-- MAST — Lead activity timeline
--
-- Root cause of the "403 / permission denied for table lead_activities"
-- bug: src/lib/api.ts (getRecentActivity, getLeadActivities,
-- createLeadActivity, deleteWorkspace) and src/scraperBridge/deliverLead.ts
-- have all read/written `lead_activities` since the CRM shipped, but — same
-- class of bug as `progression_events` in migration 008 — no migration ever
-- created the table. Supabase/Postgres returns "permission denied" (not
-- "relation does not exist") for this case, which is what shows up client
-- side as a 403. This migration creates the missing schema so the existing
-- frontend/backend code (already written against this exact shape) starts
-- working — no application code changes needed.
--
-- Architecture note: same as `leads` and `lead_followups`, the frontend
-- reads/writes this table directly via the anon-key Supabase client, scoped
-- by RLS (`auth.uid() = user_id`). The gateway/worker also write to it via
-- deliverLead.ts using the service-role client, which bypasses RLS entirely
-- — the policies below only govern the browser's anon-key access.

create table if not exists lead_activities (
  id uuid primary key default gen_random_uuid(),
  lead_id bigint not null references leads(id) on delete cascade,
  user_id uuid not null references profiles(id) on delete cascade,
  type text not null,
  timestamp timestamptz not null default now(),
  content text not null,
  channel text,
  subject text,
  body text,
  metadata jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_lead_activities_lead_id
  on lead_activities (lead_id);

create index if not exists idx_lead_activities_user_created
  on lead_activities (user_id, timestamp desc);

alter table lead_activities enable row level security;

create policy if not exists lead_activities_owner_select
  on lead_activities for select
  to authenticated
  using (auth.uid() = user_id);

create policy if not exists lead_activities_owner_insert
  on lead_activities for insert
  to authenticated
  with check (auth.uid() = user_id);

create policy if not exists lead_activities_owner_update
  on lead_activities for update
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy if not exists lead_activities_owner_delete
  on lead_activities for delete
  to authenticated
  using (auth.uid() = user_id);
