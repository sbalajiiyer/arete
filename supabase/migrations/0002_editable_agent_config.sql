-- Applied to the Supabase project as migration "editable_agent_config" on 2026-11-13.

create table public.agent_configs (
  org_id uuid not null references public.orgs(id) on delete cascade,
  stage text not null check (stage in ('capture','scope','evaluate','judge','rank','commit','watch')),
  instructions text,
  rules text[] not null default '{}',
  updated_by uuid default auth.uid(),
  updated_at timestamptz not null default now(),
  primary key (org_id, stage)
);

create table public.org_settings (
  org_id uuid primary key references public.orgs(id) on delete cascade,
  settings jsonb not null default '{}'::jsonb,
  updated_by uuid default auth.uid(),
  updated_at timestamptz not null default now()
);

create table public.org_memory (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  note text not null check (char_length(note) between 3 and 1000),
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now()
);
create index org_memory_org_idx on public.org_memory(org_id);

-- append-only record of every configuration change
create table public.config_changes (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  area text not null,
  before jsonb,
  after jsonb,
  changed_by uuid default auth.uid(),
  changed_by_email text default (auth.jwt() ->> 'email'),
  created_at timestamptz not null default now()
);
create index config_changes_org_idx on public.config_changes(org_id, created_at desc);

create table public.eval_runs (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  stage text not null,
  passed integer not null,
  total integer not null,
  details jsonb not null default '[]'::jsonb,
  model text,
  customized boolean not null default false,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now()
);
create index eval_runs_org_idx on public.eval_runs(org_id, created_at desc);

alter table public.agent_configs enable row level security;
alter table public.org_settings enable row level security;
alter table public.org_memory enable row level security;
alter table public.config_changes enable row level security;
alter table public.eval_runs enable row level security;

create policy agent_configs_select on public.agent_configs for select to authenticated using (private.is_member(org_id));
create policy agent_configs_insert on public.agent_configs for insert to authenticated with check (private.has_role(org_id, array['admin']));
create policy agent_configs_update on public.agent_configs for update to authenticated using (private.has_role(org_id, array['admin'])) with check (private.has_role(org_id, array['admin']));
create policy agent_configs_delete on public.agent_configs for delete to authenticated using (private.has_role(org_id, array['admin']));

create policy org_settings_select on public.org_settings for select to authenticated using (private.is_member(org_id));
create policy org_settings_insert on public.org_settings for insert to authenticated with check (private.has_role(org_id, array['admin']));
create policy org_settings_update on public.org_settings for update to authenticated using (private.has_role(org_id, array['admin'])) with check (private.has_role(org_id, array['admin']));

create policy org_memory_select on public.org_memory for select to authenticated using (private.is_member(org_id));
create policy org_memory_insert on public.org_memory for insert to authenticated with check (private.has_role(org_id, array['admin']));
create policy org_memory_delete on public.org_memory for delete to authenticated using (private.has_role(org_id, array['admin']));

create policy config_changes_select on public.config_changes for select to authenticated using (private.is_member(org_id));
create policy config_changes_insert on public.config_changes for insert to authenticated with check (private.has_role(org_id, array['admin']));

create policy eval_runs_select on public.eval_runs for select to authenticated using (private.is_member(org_id));
create policy eval_runs_insert on public.eval_runs for insert to authenticated with check (private.is_member(org_id));
