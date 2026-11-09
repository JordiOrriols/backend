create or replace function platform.workspace_directory(account uuid, app_name text)
returns table(id uuid, name text, role text)
language sql stable security definer set search_path = '' as $$
  select w.id,w.name,g.role from platform.grants g
  join public.workspaces w on w.id=g.workspace_id
  where g.user_id=account and g.app=app_name order by w.name,w.id;
$$;

create or replace function platform.shiplog_catalog(account uuid, workspace uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare result jsonb;
begin
  if not exists (select 1 from platform.grants g
    where g.user_id=account and g.app='shiplog' and g.workspace_id=workspace)
  then raise exception 'Workspace access required' using errcode='42501'; end if;
  select jsonb_build_object(
    'name',w.name,
    'applications',coalesce((select jsonb_agg(jsonb_build_object('id',a.id,'name',a.name) order by a.name,a.id)
      from public.shiplog_applications a where a.workspace_id=workspace),'[]'::jsonb),
    'releases',coalesce((select jsonb_agg(public.shiplog_public_release_content(r.id) order by r.created_at desc,r.id)
      from public.shiplog_releases r where r.workspace_id=workspace),'[]'::jsonb)
  ) into result from public.workspaces w where w.id=workspace;
  return result;
end;
$$;

revoke all on function platform.workspace_directory(uuid,text), platform.shiplog_catalog(uuid,uuid)
  from public,anon,authenticated,service_role;
grant execute on function platform.workspace_directory(uuid,text), platform.shiplog_catalog(uuid,uuid)
  to platform_api;
