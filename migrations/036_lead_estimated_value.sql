-- MAST — Optional, user-entered monetary value per opportunity.
--
-- Powers the real "Opportunity" total in the Pipeline stage panel. The column is
-- nullable with NO default and NO backfill: every existing opportunity stays NULL
-- ("value unavailable") until a person records a real figure. Nothing is estimated
-- or derived from stage.
--
-- RLS: leads already has per-user policies at the row level; they cover new columns.
-- Safe to re-run.

alter table leads
  add column if not exists estimated_value numeric(14, 2);

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'leads_estimated_value_nonnegative'
  ) then
    alter table leads
      add constraint leads_estimated_value_nonnegative
      check (estimated_value is null or estimated_value >= 0);
  end if;
end $$;

comment on column leads.estimated_value is
  'Optional user-entered deal value. NULL = not provided. Never auto-filled.';
