-- Applied to the Supabase project as migration "initial_schema" on 2026-11-13.

create schema if not exists private;

create table public.orgs (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_at timestamptz not null default now()
);

create table public.org_members (
  org_id uuid not null references public.orgs(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null default 'member' check (role in ('admin','approver','member')),
  created_at timestamptz not null default now(),
  primary key (org_id, user_id)
);
create index org_members_user_idx on public.org_members(user_id);

create table public.idea_types (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  name text not null,
  description text not null default '',
  config jsonb not null,
  created_at timestamptz not null default now(),
  unique (org_id, name)
);

create table public.ideas (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  idea_type_id uuid not null references public.idea_types(id),
  title text not null,
  summary text not null default '',
  source_kind text not null default 'text',
  source_text text not null default '',
  stage text not null default 'capture' check (stage in ('capture','scope','evaluate','judge','rank','commit','watch')),
  status text not null default 'active' check (status in ('active','duplicate','awaiting_approval','approved','rejected','returned','done')),
  record jsonb not null default '{}'::jsonb,
  score numeric,
  confidence numeric,
  rank integer,
  escalated boolean not null default false,
  created_by uuid default auth.uid() references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index ideas_org_idx on public.ideas(org_id);
create index ideas_type_idx on public.ideas(idea_type_id);
create index ideas_created_by_idx on public.ideas(created_by);

create table public.stage_runs (
  id uuid primary key default gen_random_uuid(),
  idea_id uuid not null references public.ideas(id) on delete cascade,
  org_id uuid not null references public.orgs(id) on delete cascade,
  stage text not null,
  agent text not null,
  summary text not null default '',
  output jsonb not null default '{}'::jsonb,
  model text,
  created_by uuid default auth.uid() references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);
create index stage_runs_idea_idx on public.stage_runs(idea_id);
create index stage_runs_org_idx on public.stage_runs(org_id);
create index stage_runs_created_by_idx on public.stage_runs(created_by);

create table public.approvals (
  id uuid primary key default gen_random_uuid(),
  idea_id uuid not null references public.ideas(id) on delete cascade,
  org_id uuid not null references public.orgs(id) on delete cascade,
  decision text not null check (decision in ('approved','rejected','returned')),
  comment text not null default '',
  decided_by uuid default auth.uid() references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);
create index approvals_idea_idx on public.approvals(idea_id);
create index approvals_org_idx on public.approvals(org_id);
create index approvals_decided_by_idx on public.approvals(decided_by);

create table public.watch_updates (
  id uuid primary key default gen_random_uuid(),
  idea_id uuid not null references public.ideas(id) on delete cascade,
  org_id uuid not null references public.orgs(id) on delete cascade,
  note text not null,
  percent_complete integer check (percent_complete between 0 and 100),
  rag text check (rag in ('green','amber','red')),
  escalate boolean not null default false,
  assessment jsonb not null default '{}'::jsonb,
  created_by uuid default auth.uid() references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);
create index watch_updates_idea_idx on public.watch_updates(idea_id);
create index watch_updates_org_idx on public.watch_updates(org_id);
create index watch_updates_created_by_idx on public.watch_updates(created_by);

-- membership helpers (security definer, kept out of the exposed API schema)
create function private.is_member(org uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.org_members m where m.org_id = org and m.user_id = (select auth.uid()));
$$;

create function private.has_role(org uuid, roles text[]) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.org_members m where m.org_id = org and m.user_id = (select auth.uid()) and m.role = any(roles));
$$;

revoke all on function private.is_member(uuid) from public;
revoke all on function private.has_role(uuid, text[]) from public;
grant usage on schema private to authenticated;
grant execute on function private.is_member(uuid) to authenticated;
grant execute on function private.has_role(uuid, text[]) to authenticated;

alter table public.orgs enable row level security;
alter table public.org_members enable row level security;
alter table public.idea_types enable row level security;
alter table public.ideas enable row level security;
alter table public.stage_runs enable row level security;
alter table public.approvals enable row level security;
alter table public.watch_updates enable row level security;

create policy orgs_select on public.orgs for select to authenticated using (private.is_member(id));
create policy orgs_update on public.orgs for update to authenticated using (private.has_role(id, array['admin'])) with check (private.has_role(id, array['admin']));

create policy members_select on public.org_members for select to authenticated using (private.is_member(org_id));

create policy types_select on public.idea_types for select to authenticated using (private.is_member(org_id));
create policy types_insert on public.idea_types for insert to authenticated with check (private.has_role(org_id, array['admin']));
create policy types_update on public.idea_types for update to authenticated using (private.has_role(org_id, array['admin'])) with check (private.has_role(org_id, array['admin']));
create policy types_delete on public.idea_types for delete to authenticated using (private.has_role(org_id, array['admin']));

create policy ideas_select on public.ideas for select to authenticated using (private.is_member(org_id));
create policy ideas_insert on public.ideas for insert to authenticated with check (private.is_member(org_id));
create policy ideas_update on public.ideas for update to authenticated using (private.is_member(org_id)) with check (private.is_member(org_id));
create policy ideas_delete on public.ideas for delete to authenticated using (private.has_role(org_id, array['admin']));

-- audit trail: readable and appendable, never editable
create policy runs_select on public.stage_runs for select to authenticated using (private.is_member(org_id));
create policy runs_insert on public.stage_runs for insert to authenticated
  with check (private.is_member(org_id) and exists (select 1 from public.ideas i where i.id = idea_id and i.org_id = stage_runs.org_id));

create policy approvals_select on public.approvals for select to authenticated using (private.is_member(org_id));
create policy approvals_insert on public.approvals for insert to authenticated
  with check (private.has_role(org_id, array['admin','approver']) and exists (select 1 from public.ideas i where i.id = idea_id and i.org_id = approvals.org_id));

create policy watch_select on public.watch_updates for select to authenticated using (private.is_member(org_id));
create policy watch_insert on public.watch_updates for insert to authenticated
  with check (private.is_member(org_id) and exists (select 1 from public.ideas i where i.id = idea_id and i.org_id = watch_updates.org_id));

-- every new user gets a workspace with three starter idea types
create function private.handle_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  new_org uuid;
  all_stages jsonb := '["capture","scope","evaluate","judge","rank","commit","watch"]'::jsonb;
begin
  insert into public.orgs (name) values (coalesce(split_part(new.email, '@', 1), 'My') || ' workspace') returning id into new_org;
  insert into public.org_members (org_id, user_id, role) values (new_org, new.id, 'admin');

  insert into public.idea_types (org_id, name, description, config) values
  (new_org, 'Project request', 'A request for a funded project, reviewed by a governance board.', jsonb_build_object(
    'stages', all_stages,
    'approver', 'Governance board',
    'fields', '[{"key":"problem","label":"Problem or opportunity"},{"key":"proposed_solution","label":"Proposed solution"},{"key":"sponsor","label":"Sponsor"},{"key":"estimated_cost","label":"Estimated cost"},{"key":"expected_benefit","label":"Expected benefit"},{"key":"timeline","label":"Timeline"}]'::jsonb,
    'business_case', 'A full case: costs, quantified benefits, payback period, risks, dependencies and resource needs.',
    'criteria', '[{"key":"strategic_fit","label":"Strategic fit","weight":25},{"key":"financial_return","label":"Financial return","weight":30},{"key":"feasibility","label":"Feasibility","weight":20},{"key":"risk","label":"Risk (5 = low risk)","weight":15},{"key":"urgency","label":"Urgency","weight":10}]'::jsonb,
    'watch_metrics', '["Milestones met on time","Spend against budget","Benefits realized against the business case"]'::jsonb)),
  (new_org, 'Improvement suggestion', 'A small process or cost improvement raised by anyone, approved by a team lead.', jsonb_build_object(
    'stages', '["capture","scope","evaluate","commit","watch"]'::jsonb,
    'approver', 'Team lead',
    'fields', '[{"key":"problem","label":"What is not working"},{"key":"suggestion","label":"Suggested change"},{"key":"area","label":"Team or area affected"},{"key":"expected_saving","label":"Expected saving or gain"}]'::jsonb,
    'business_case', 'One short paragraph with the estimated saving and the effort to implement.',
    'criteria', '[{"key":"impact","label":"Impact","weight":50},{"key":"effort","label":"Ease of implementation (5 = easy)","weight":30},{"key":"risk","label":"Risk (5 = low risk)","weight":20}]'::jsonb,
    'watch_metrics', '["Change implemented","Saving or gain observed"]'::jsonb)),
  (new_org, 'New product concept', 'A new product or service idea, approved by an executive sponsor.', jsonb_build_object(
    'stages', all_stages,
    'approver', 'Executive sponsor',
    'fields', '[{"key":"customer","label":"Target customer"},{"key":"problem","label":"Customer problem"},{"key":"concept","label":"Product concept"},{"key":"differentiation","label":"Differentiation"},{"key":"revenue_model","label":"Revenue model"},{"key":"investment","label":"Investment needed"}]'::jsonb,
    'business_case', 'Market size, revenue projection, investment, competitive position and key assumptions to test.',
    'criteria', '[{"key":"market_attractiveness","label":"Market attractiveness","weight":30},{"key":"differentiation","label":"Differentiation","weight":20},{"key":"financial_return","label":"Financial return","weight":25},{"key":"feasibility","label":"Feasibility","weight":15},{"key":"strategic_fit","label":"Strategic fit","weight":10}]'::jsonb,
    'watch_metrics', '["Assumptions validated","Customer traction","Spend against investment"]'::jsonb));
  return new;
end;
$$;
revoke all on function private.handle_new_user() from public;

create trigger on_auth_user_created after insert on auth.users
  for each row execute function private.handle_new_user();
