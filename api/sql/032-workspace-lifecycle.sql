alter table public.workspaces alter column owner_id drop not null;
alter table public.workspaces add column platform_owner_id uuid references platform.users(id);
alter table public.workspaces add constraint workspace_owner_kind
  check (num_nonnulls(owner_id,platform_owner_id)=1);
alter table public.teams alter column owner_id drop not null;
alter table public.members alter column owner_id drop not null;

create or replace function public.planner_workspace_identity()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.id is distinct from old.id or new.owner_id is distinct from old.owner_id
    or new.platform_owner_id is distinct from old.platform_owner_id
    or new.created_at is distinct from old.created_at then
    raise exception 'Workspace identity is immutable';
  end if;
  return new;
end;
$$;

create or replace function public.teams_workspace()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op='UPDATE' then
    if new.workspace_id is distinct from old.workspace_id then
      raise exception 'Teams cannot move to another workspace' using errcode='42501';
    end if;
    return new;
  end if;
  if new.workspace_id is null then
    insert into public.workspaces(owner_id,name,created_for_team) values(new.owner_id,new.name,true)
      returning id into new.workspace_id;
  elsif not exists (
    select 1 from public.workspaces w where w.id=new.workspace_id and (
      w.owner_id=new.owner_id or
      (session_user='platform_api' and w.platform_owner_id is not null and new.owner_id is null)
    )
  ) then
    raise exception 'Teams can only live in a workspace of their owner' using errcode='42501';
  end if;
  return new;
end;
$$;

create function platform.member_storage_owner()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.owner_id is null and not exists (
    select 1 from public.teams t join public.workspaces w on w.id=t.workspace_id
    where t.id=new.team_id and t.owner_id is null and w.platform_owner_id is not null
      and session_user='platform_api'
  ) then
    raise exception 'Explicit member storage owner required' using errcode='42501';
  end if;
  return new;
end;
$$;
create trigger zz_member_storage_owner before insert or update on public.members
  for each row execute function platform.member_storage_owner();

create table platform.workspace_invitations (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  recipient_id uuid not null references platform.users(id),
  app text not null check (app in ('planner','shiplog','ladders','pulse','agents')),
  role text not null check (role in ('editor','viewer','external')),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now()+interval '30 days',
  unique (workspace_id,recipient_id,app),
  check (role<>'external' or app in ('planner','shiplog'))
);
revoke all on platform.workspace_invitations from public,anon,authenticated,service_role,platform_api;

create function platform.create_workspace(account uuid, workspace_name text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare saved uuid;
begin
  perform id from platform.users where id=account
    and exists(select 1 from platform.identities where user_id=account) for share;
  if not found then raise exception 'Verified account required' using errcode='42501'; end if;
  if workspace_name is null or char_length(trim(workspace_name)) not between 1 and 120 then
    raise exception 'Workspace names need between 1 and 120 characters' using errcode='22023';
  end if;
  insert into public.workspaces(owner_id,platform_owner_id,name,created_for_team)
    values(null,account,trim(workspace_name),false) returning id into saved;
  insert into platform.grants(user_id,app,workspace_id,role)
    select account,app,saved,'owner' from unnest(array['planner','shiplog','ladders','pulse','agents']) app;
  return jsonb_build_object('id',saved,'name',trim(workspace_name));
end;
$$;

create function platform.workspace_access_management(
  account uuid, workspace uuid, app_name text, action text, recipient uuid, access text
)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  perform 1 from platform.grants g where g.user_id=account and g.workspace_id=workspace
    and g.app=app_name and g.role='owner' for share;
  if not found then raise exception 'Workspace app owner access required' using errcode='42501'; end if;
  if action in ('update','remove') then
    begin
      perform 1 from platform.grants g where g.workspace_id=workspace
        and g.app=app_name and g.user_id=recipient and g.role<>'owner' for update nowait;
    exception when lock_not_available then
      raise exception 'Workspace access is busy. Retry after the current operation.' using errcode='23514';
    end;
  end if;
  perform id from public.workspaces where id=workspace for update;
  if action in ('invite','update','remove') then
    if recipient is null or recipient=account or exists (
      select 1 from platform.grants g where g.workspace_id=workspace
        and g.app=app_name and g.user_id=recipient and g.role='owner'
    ) then raise exception 'Owner grants cannot be changed here' using errcode='23514'; end if;
  end if;
  if action in ('invite','update') then
    if access is null or access not in ('editor','viewer','external')
      or (access='external' and app_name not in ('planner','shiplog')) then
      raise exception 'Invalid workspace role' using errcode='22023';
    end if;
    if not exists(select 1 from platform.identities where user_id=recipient) then
      raise exception 'Recipient must first authenticate' using errcode='22023';
    end if;
    if action='invite' then
      if exists(select 1 from platform.grants g where g.workspace_id=workspace
        and g.app=app_name and g.user_id=recipient) then
        raise exception 'Account already has app access; update its role instead' using errcode='23514';
      end if;
      insert into platform.workspace_invitations(workspace_id,recipient_id,app,role)
        values(workspace,recipient,app_name,access)
        on conflict(workspace_id,recipient_id,app) do update set
          id=gen_random_uuid(),role=excluded.role,created_at=now(),expires_at=now()+interval '30 days';
    else
      update platform.grants g set role=access
        where g.workspace_id=workspace and g.app=app_name and g.user_id=recipient;
      if not found then raise exception 'Workspace grant unavailable' using errcode='P0002'; end if;
    end if;
  elsif action='remove' then
    delete from platform.workspace_invitations i where i.workspace_id=workspace
      and i.app=app_name and i.recipient_id=recipient;
    delete from platform.grants g where g.workspace_id=workspace
      and g.app=app_name and g.user_id=recipient and g.role<>'owner';
  elsif action<>'list' or action is null then
    raise exception 'Invalid workspace access action' using errcode='22023';
  end if;
  return jsonb_build_object(
    'grants',coalesce((select jsonb_agg(jsonb_build_object('account_id',g.user_id,'role',g.role)
      order by g.user_id) from platform.grants g where g.workspace_id=workspace and g.app=app_name),'[]'::jsonb),
    'invitations',coalesce((select jsonb_agg(jsonb_build_object(
      'id',i.id,'account_id',i.recipient_id,'role',i.role,'expires_at',i.expires_at
    ) order by i.created_at,i.id) from platform.workspace_invitations i
      where i.workspace_id=workspace and i.app=app_name and i.expires_at>now()),'[]'::jsonb)
  );
end;
$$;

create function platform.my_workspace_invitations(account uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object('id',i.id,'workspace_id',w.id,
    'name',w.name,'app',i.app,'role',i.role,'expires_at',i.expires_at
  ) order by i.created_at,i.id),'[]'::jsonb)
  from platform.workspace_invitations i join public.workspaces w on w.id=i.workspace_id
  where i.recipient_id=account and i.expires_at>now();
$$;

create function platform.answer_workspace_invitation(account uuid, invitation uuid, accept boolean)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare target platform.workspace_invitations;
begin
  select i.* into target from platform.workspace_invitations i where i.id=invitation
    and i.recipient_id=account and i.expires_at>now();
  if not found then raise exception 'Workspace invitation unavailable' using errcode='P0002'; end if;
  perform id from public.workspaces where id=target.workspace_id for update;
  select i.* into target from platform.workspace_invitations i where i.id=invitation
    and i.recipient_id=account and i.expires_at>now() for update;
  if not found then raise exception 'Workspace invitation unavailable' using errcode='P0002'; end if;
  if accept is null then raise exception 'Choose accept or decline' using errcode='22023'; end if;
  if accept then
    if exists(select 1 from platform.grants g where g.user_id=account and g.app=target.app
      and g.workspace_id=target.workspace_id) then
      raise exception 'Account already has app access' using errcode='23514';
    end if;
    insert into platform.grants(user_id,app,workspace_id,role)
      values(account,target.app,target.workspace_id,target.role);
  end if;
  delete from platform.workspace_invitations where id=invitation;
  return jsonb_build_object('workspace_id',target.workspace_id,'app',target.app,'accepted',accept);
end;
$$;

create function platform.delete_workspace(account uuid, workspace uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  begin
    perform 1 from platform.grants g where g.workspace_id=workspace
      order by g.app,g.user_id for update nowait;
  exception when lock_not_available then
    raise exception 'Workspace access is busy. Retry after the current operation.' using errcode='23514';
  end;
  if (select count(*) from platform.grants g where g.user_id=account
    and g.workspace_id=workspace and g.role='owner')<>5 then
    raise exception 'Owner access to all five apps required to delete a workspace' using errcode='42501';
  end if;
  perform id from public.workspaces where id=workspace for update;
  if not found then raise exception 'Workspace unavailable' using errcode='P0002'; end if;
  perform id from public.teams where workspace_id=workspace order by id for update;
  perform id from public.projects where workspace_id=workspace order by id for update;
  if not public.workspace_empty(workspace) or exists (
    select 1 from platform.shiplog_audit_events where workspace_id=workspace
  ) or exists (
    select 1 from platform.planner_priority_proposals where workspace_id=workspace
  ) then
    raise exception 'Workspace is not empty. Remove its content from all apps first.' using errcode='23514';
  end if;
  update public.workspaces set created_for_team=false where id=workspace;
  delete from platform.workspace_invitations where workspace_id=workspace;
  delete from platform.grants where workspace_id=workspace;
  delete from public.teams where workspace_id=workspace;
  delete from public.workspaces where id=workspace;
  return jsonb_build_object('id',workspace);
end;
$$;

revoke all on function platform.member_storage_owner(),platform.create_workspace(uuid,text),
  platform.workspace_access_management(uuid,uuid,text,text,uuid,text),
  platform.my_workspace_invitations(uuid),platform.answer_workspace_invitation(uuid,uuid,boolean),
  platform.delete_workspace(uuid,uuid) from public,anon,authenticated,service_role,platform_api;
grant execute on function platform.create_workspace(uuid,text),
  platform.workspace_access_management(uuid,uuid,text,text,uuid,text),
  platform.my_workspace_invitations(uuid),platform.answer_workspace_invitation(uuid,uuid,boolean),
  platform.delete_workspace(uuid,uuid) to platform_api;
