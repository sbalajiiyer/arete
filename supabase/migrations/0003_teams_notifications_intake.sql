-- Applied to the Supabase project as migration "teams_notifications_intake" on 2026-11-13.

-- Roles: admin, approver, member (shown as Analyst), submitter
alter table public.org_members drop constraint org_members_role_check;
alter table public.org_members add constraint org_members_role_check check (role in ('admin','approver','member','submitter'));
alter table public.org_members add column email text;
update public.org_members m set email = u.email from auth.users u where u.id = m.user_id;

create table public.user_prefs (
  user_id uuid primary key references auth.users(id) on delete cascade,
  active_org uuid references public.orgs(id) on delete set null
);
create index user_prefs_active_org_idx on public.user_prefs(active_org);
alter table public.user_prefs enable row level security;
create policy user_prefs_select on public.user_prefs for select to authenticated using (user_id = (select auth.uid()));

create table public.invitations (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  email text not null,
  role text not null default 'submitter' check (role in ('admin','approver','member','submitter')),
  token uuid not null default gen_random_uuid() unique,
  invited_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '7 days',
  accepted_at timestamptz
);
create index invitations_org_idx on public.invitations(org_id);
create index invitations_email_idx on public.invitations(lower(email));
alter table public.invitations enable row level security;

create table public.notifications (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  idea_id uuid references public.ideas(id) on delete cascade,
  kind text not null,
  title text not null,
  body text not null default '',
  read_at timestamptz,
  created_at timestamptz not null default now()
);
create index notifications_user_idx on public.notifications(user_id, created_at desc);
create index notifications_org_idx on public.notifications(org_id);
create index notifications_idea_idx on public.notifications(idea_id);
alter table public.notifications enable row level security;

create table public.intake_keys (
  org_id uuid primary key references public.orgs(id) on delete cascade,
  key_hash text not null unique,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now()
);
alter table public.intake_keys enable row level security;

-- A person can belong to several workspaces; exactly one is active at a time and all access rules follow it.
create function private.active_org() returns uuid
language sql stable security definer set search_path = '' as $$
  select coalesce(
    (select p.active_org from public.user_prefs p
      where p.user_id = (select auth.uid())
        and exists (select 1 from public.org_members m where m.org_id = p.active_org and m.user_id = p.user_id)),
    (select m.org_id from public.org_members m where m.user_id = (select auth.uid()) order by m.created_at, m.org_id limit 1));
$$;
revoke all on function private.active_org() from public;
grant execute on function private.active_org() to authenticated;

create or replace function private.is_member(org uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select org is not null and org = private.active_org();
$$;

create or replace function private.has_role(org uuid, roles text[]) returns boolean
language sql stable security definer set search_path = '' as $$
  select org = private.active_org()
    and exists (select 1 from public.org_members m where m.org_id = org and m.user_id = (select auth.uid()) and m.role = any(roles));
$$;

-- Submitters see only their own ideas; only analysts, approvers and admins can change an idea.
drop policy ideas_select on public.ideas;
create policy ideas_select on public.ideas for select to authenticated
  using (private.is_member(org_id) and (created_by = (select auth.uid()) or private.has_role(org_id, array['admin','approver','member'])));
drop policy ideas_update on public.ideas;
create policy ideas_update on public.ideas for update to authenticated
  using (private.has_role(org_id, array['admin','approver','member'])) with check (private.has_role(org_id, array['admin','approver','member']));

drop policy runs_select on public.stage_runs;
create policy runs_select on public.stage_runs for select to authenticated
  using (private.is_member(org_id) and exists (select 1 from public.ideas i where i.id = idea_id));
drop policy approvals_select on public.approvals;
create policy approvals_select on public.approvals for select to authenticated
  using (private.is_member(org_id) and exists (select 1 from public.ideas i where i.id = idea_id));
drop policy watch_select on public.watch_updates;
create policy watch_select on public.watch_updates for select to authenticated
  using (private.is_member(org_id) and exists (select 1 from public.ideas i where i.id = idea_id));

create policy members_update on public.org_members for update to authenticated
  using (private.has_role(org_id, array['admin'])) with check (private.has_role(org_id, array['admin']));
create policy members_delete on public.org_members for delete to authenticated
  using (private.has_role(org_id, array['admin']));

create policy invitations_select on public.invitations for select to authenticated using (private.has_role(org_id, array['admin']));
create policy invitations_insert on public.invitations for insert to authenticated with check (private.has_role(org_id, array['admin']));
create policy invitations_delete on public.invitations for delete to authenticated using (private.has_role(org_id, array['admin']));

create policy notifications_select on public.notifications for select to authenticated
  using (user_id = (select auth.uid()) and private.is_member(org_id));
create policy notifications_update on public.notifications for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy notifications_insert on public.notifications for insert to authenticated
  with check (private.is_member(org_id) and exists (select 1 from public.org_members m where m.org_id = notifications.org_id and m.user_id = notifications.user_id));

create policy intake_keys_select on public.intake_keys for select to authenticated using (private.has_role(org_id, array['admin']));

-- A workspace must keep at least one admin (direct changes only; cascades from deleting a workspace are allowed).
create function private.keep_one_admin() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if pg_trigger_depth() = 1 and old.role = 'admin' and (tg_op = 'DELETE' or new.role <> 'admin')
     and not exists (select 1 from public.org_members m where m.org_id = old.org_id and m.role = 'admin' and m.user_id <> old.user_id) then
    raise exception 'A workspace must keep at least one admin.';
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;
revoke all on function private.keep_one_admin() from public;
create trigger org_members_keep_admin before update or delete on public.org_members
  for each row execute function private.keep_one_admin();

-- New account with a pending invitation: join that workspace instead of keeping the personal one just created.
create function private.handle_invited_user() returns trigger
language plpgsql security definer set search_path = '' as $$
declare inv record;
begin
  update public.org_members set email = new.email where user_id = new.id and email is null;
  select * into inv from public.invitations i
    where lower(i.email) = lower(new.email) and i.accepted_at is null and i.expires_at > now()
    order by i.created_at desc limit 1;
  if found then
    delete from public.orgs o where o.id in (select m.org_id from public.org_members m where m.user_id = new.id);
    insert into public.org_members (org_id, user_id, role, email) values (inv.org_id, new.id, inv.role, new.email);
    update public.invitations set accepted_at = now() where id = inv.id;
  end if;
  return new;
end;
$$;
revoke all on function private.handle_invited_user() from public;
create trigger on_auth_user_created_invite after insert on auth.users
  for each row execute function private.handle_invited_user();

create function public.my_workspaces() returns table (org_id uuid, name text, role text, active boolean)
language sql stable security definer set search_path = '' as $$
  select m.org_id, o.name, m.role, m.org_id = private.active_org()
  from public.org_members m join public.orgs o on o.id = m.org_id
  where m.user_id = (select auth.uid()) order by o.name;
$$;

create function public.set_active_workspace(org uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not exists (select 1 from public.org_members m where m.org_id = org and m.user_id = auth.uid()) then
    raise exception 'You are not a member of that workspace.';
  end if;
  insert into public.user_prefs (user_id, active_org) values (auth.uid(), org)
    on conflict (user_id) do update set active_org = excluded.active_org;
end;
$$;

create function public.accept_invitation(tok uuid) returns text
language plpgsql security definer set search_path = '' as $$
declare inv record; nm text;
begin
  select * into inv from public.invitations i where i.token = tok and i.accepted_at is null and i.expires_at > now();
  if not found then raise exception 'This invitation is no longer valid.'; end if;
  if lower(inv.email) <> lower(coalesce(auth.jwt() ->> 'email', '')) then
    raise exception 'This invitation was sent to a different email address.';
  end if;
  insert into public.org_members (org_id, user_id, role, email) values (inv.org_id, auth.uid(), inv.role, inv.email)
    on conflict (org_id, user_id) do nothing;
  update public.invitations set accepted_at = now() where id = inv.id;
  insert into public.user_prefs (user_id, active_org) values (auth.uid(), inv.org_id)
    on conflict (user_id) do update set active_org = excluded.active_org;
  select o.name into nm from public.orgs o where o.id = inv.org_id;
  return nm;
end;
$$;

-- Intake keys let outside tools submit ideas without a signed-in user. Only the hash is stored.
create function public.rotate_intake_key() returns text
language plpgsql security definer set search_path = '' as $$
declare org uuid := private.active_org(); k text;
begin
  if not private.has_role(org, array['admin']) then raise exception 'Only an admin can create an intake key.'; end if;
  k := 'ak_' || encode(extensions.gen_random_bytes(24), 'hex');
  insert into public.intake_keys (org_id, key_hash, created_by) values (org, encode(extensions.digest(k, 'sha256'), 'hex'), auth.uid())
    on conflict (org_id) do update set key_hash = excluded.key_hash, created_by = excluded.created_by, created_at = now();
  return k;
end;
$$;

create function public.intake_context(k text) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'org_id', ik.org_id,
    'types', (select coalesce(jsonb_agg(jsonb_build_object('id', t.id, 'name', t.name, 'description', t.description, 'config', t.config) order by t.created_at), '[]'::jsonb) from public.idea_types t where t.org_id = ik.org_id),
    'capture', (select jsonb_build_object('instructions', a.instructions, 'rules', a.rules) from public.agent_configs a where a.org_id = ik.org_id and a.stage = 'capture'),
    'settings', (select s.settings from public.org_settings s where s.org_id = ik.org_id),
    'runs_today', (select count(*) from public.stage_runs r where r.org_id = ik.org_id and r.created_at >= date_trunc('day', now())))
  from public.intake_keys ik where ik.key_hash = encode(extensions.digest(k, 'sha256'), 'hex');
$$;

create function public.intake_create(k text, items jsonb, source_label text, source_text text, model text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare org uuid; it jsonb; new_id uuid; made jsonb := '[]'::jsonb;
begin
  select ik.org_id into org from public.intake_keys ik where ik.key_hash = encode(extensions.digest(k, 'sha256'), 'hex');
  if org is null then raise exception 'Unknown intake key.'; end if;
  for it in select * from jsonb_array_elements(items) limit 8 loop
    if not exists (select 1 from public.idea_types t where t.id = (it ->> 'idea_type_id')::uuid and t.org_id = org) then continue; end if;
    insert into public.ideas (org_id, idea_type_id, title, summary, source_kind, source_text, record, created_by)
      values (org, (it ->> 'idea_type_id')::uuid, left(it ->> 'title', 200), coalesce(it ->> 'summary', ''), 'intake', left(source_text, 40000),
              jsonb_build_object('fields', coalesce(it -> 'fields', '{}'::jsonb), 'missing_info', coalesce(it -> 'missing_info', '[]'::jsonb), 'source', source_label), null)
      returning id into new_id;
    insert into public.stage_runs (idea_id, org_id, stage, agent, summary, output, model, created_by)
      values (new_id, org, 'capture', 'Capture agent', 'Captured from ' || source_label || '.', it, model, null);
    insert into public.notifications (org_id, user_id, idea_id, kind, title, body)
      select org, m.user_id, new_id, 'intake', 'New idea from ' || source_label, left(it ->> 'title', 200)
      from public.org_members m where m.org_id = org and m.role in ('admin', 'member');
    made := made || jsonb_build_object('id', new_id, 'title', it ->> 'title');
  end loop;
  return made;
end;
$$;

revoke all on function public.my_workspaces() from public, anon;
revoke all on function public.set_active_workspace(uuid) from public, anon;
revoke all on function public.accept_invitation(uuid) from public, anon;
revoke all on function public.rotate_intake_key() from public, anon;
revoke all on function public.intake_context(text) from public;
revoke all on function public.intake_create(text, jsonb, text, text, text) from public;
grant execute on function public.my_workspaces() to authenticated;
grant execute on function public.set_active_workspace(uuid) to authenticated;
grant execute on function public.accept_invitation(uuid) to authenticated;
grant execute on function public.rotate_intake_key() to authenticated;
grant execute on function public.intake_context(text) to anon, authenticated;
grant execute on function public.intake_create(text, jsonb, text, text, text) to anon, authenticated;
