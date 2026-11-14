-- Applied to the Supabase project as migration "backtest_and_type_approvers" on 2026-11-13.

create table public.backtest_runs (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  batch uuid not null,
  title text not null,
  actual text not null check (actual in ('success','partial','failed')),
  verdict text not null,
  confidence numeric,
  concerns jsonb not null default '[]'::jsonb,
  summary text not null default '',
  model text,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now()
);
create index backtest_runs_org_idx on public.backtest_runs(org_id, created_at desc);
alter table public.backtest_runs enable row level security;
create policy backtest_select on public.backtest_runs for select to authenticated using (private.has_role(org_id, array['admin','approver','member']));
create policy backtest_insert on public.backtest_runs for insert to authenticated with check (private.has_role(org_id, array['admin','member']));
create policy backtest_delete on public.backtest_runs for delete to authenticated using (private.has_role(org_id, array['admin']));

-- An idea type can name its approvers. When it does, only they (or an admin) can record a decision.
alter policy approvals_insert on public.approvals with check (
  private.has_role(org_id, array['admin','approver'])
  and exists (
    select 1 from public.ideas i join public.idea_types t on t.id = i.idea_type_id
    where i.id = idea_id and i.org_id = approvals.org_id
      and (private.has_role(approvals.org_id, array['admin'])
           or coalesce(jsonb_array_length(t.config -> 'approver_ids'), 0) = 0
           or t.config -> 'approver_ids' ? ((select auth.uid())::text))));
