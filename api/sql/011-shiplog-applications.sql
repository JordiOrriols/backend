create table platform.shiplog_audit_events (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  actor_id uuid not null references platform.users(id),
  event text not null,
  details jsonb not null,
  created_at timestamptz not null default now()
);
revoke all on platform.shiplog_audit_events from public,anon,authenticated,service_role,platform_api;

create function platform.shiplog_require_internal(account uuid, workspace uuid)
returns void language plpgsql stable security definer set search_path = '' as $$
begin
  if not exists(select 1 from platform.grants g where g.user_id=account and g.app='shiplog'
    and g.workspace_id=workspace and g.role in ('owner','editor','viewer')) then
    raise exception 'Internal Shiplog access required' using errcode='42501';
  end if;
end;
$$;
create function platform.shiplog_applications(account uuid, workspace uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  perform platform.shiplog_require_internal(account,workspace);
  return jsonb_build_object(
    'applications',coalesce((select jsonb_agg(jsonb_build_object(
      'id',a.id,'workspace_id',a.workspace_id,'name',a.name,'description',a.description,
      'team_id',a.team_id,'created_at',a.created_at,
      'in_use',exists(select 1 from public.shiplog_releases r where r.application_id=a.id)
    ) order by a.name,a.id) from public.shiplog_applications a where a.workspace_id=workspace),'[]'::jsonb),
    'teams',coalesce((select jsonb_agg(jsonb_build_object('id',t.id,'name',t.name) order by t.name,t.id)
      from public.teams t where t.workspace_id=workspace),'[]'::jsonb));
end;
$$;
create function platform.shiplog_save_application(account uuid, workspace uuid, application uuid, application_name text, description text, team uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare previous public.shiplog_applications; saved public.shiplog_applications;
begin
  perform 1 from platform.grants g where g.user_id=account and g.app='shiplog'
    and g.workspace_id=workspace and g.role in ('owner','editor') for share;
  if not found then raise exception 'Shiplog edit access required' using errcode='42501'; end if;
  perform id from public.workspaces where id=workspace for update;
  if application_name is null or char_length(trim(application_name)) not between 1 and 120
    or description is null or char_length(description)>4000 then
    raise exception 'Invalid application name or description' using errcode='22023';
  end if;
  if team is not null and not exists(select 1 from public.teams t where t.id=team and t.workspace_id=workspace) then
    raise exception 'Team unavailable in this workspace' using errcode='P0002';
  end if;
  if application is null then
    insert into public.shiplog_applications(workspace_id,name,description,team_id)
      values(workspace,trim(application_name),description,team) returning * into saved;
  else
    select * into previous from public.shiplog_applications a where a.id=application and a.workspace_id=workspace for update;
    if not found then raise exception 'Application unavailable in this workspace' using errcode='P0002'; end if;
    update public.shiplog_applications a set name=trim(application_name),
      description=shiplog_save_application.description,team_id=team where a.id=application returning * into saved;
  end if;
  insert into platform.shiplog_audit_events(workspace_id,actor_id,event,details)
    values(workspace,account,case when application is null then 'application.created' else 'application.updated' end,
      jsonb_build_object('before',to_jsonb(previous),'after',to_jsonb(saved)));
  return platform.shiplog_applications(account,workspace);
end;
$$;
create function platform.shiplog_delete_application(account uuid, workspace uuid, application uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare previous public.shiplog_applications;
begin
  perform 1 from platform.grants g where g.user_id=account and g.app='shiplog'
    and g.workspace_id=workspace and g.role in ('owner','editor') for share;
  if not found then raise exception 'Shiplog edit access required' using errcode='42501'; end if;
  perform id from public.workspaces where id=workspace for update;
  select * into previous from public.shiplog_applications a where a.id=application and a.workspace_id=workspace for update;
  if not found then raise exception 'Application unavailable in this workspace' using errcode='P0002'; end if;
  if exists(select 1 from public.shiplog_releases r where r.application_id=application) then
    raise exception 'Applications with releases cannot be deleted' using errcode='23514';
  end if;
  delete from public.shiplog_applications a where a.id=application;
  insert into platform.shiplog_audit_events(workspace_id,actor_id,event,details)
    values(workspace,account,'application.deleted',jsonb_build_object('before',to_jsonb(previous)));
  return platform.shiplog_applications(account,workspace);
end;
$$;
revoke all on function platform.shiplog_require_internal(uuid,uuid),
  platform.shiplog_applications(uuid,uuid),platform.shiplog_save_application(uuid,uuid,uuid,text,text,uuid),
  platform.shiplog_delete_application(uuid,uuid,uuid) from public,anon,authenticated,service_role;
grant execute on function platform.shiplog_applications(uuid,uuid),
  platform.shiplog_save_application(uuid,uuid,uuid,text,text,uuid),
  platform.shiplog_delete_application(uuid,uuid,uuid) to platform_api;
