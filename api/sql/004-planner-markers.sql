create function platform.planner_require_internal(account uuid, workspace uuid, editing boolean default false)
returns void language plpgsql stable security definer set search_path = '' as $$
begin
  if not exists(select 1 from platform.grants g where g.user_id=account
    and g.workspace_id=workspace and g.app='planner'
    and (g.role in ('owner','editor') or (not editing and g.role='viewer')))
  then raise exception 'Internal Planner access required' using errcode='42501'; end if;
end;
$$;
revoke all on function platform.planner_require_internal(uuid,uuid,boolean) from public,anon,authenticated,service_role,platform_api;

create function platform.planner_markers(account uuid, workspace uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  perform platform.planner_require_internal(account,workspace);
  return coalesce((select jsonb_agg(to_jsonb(m) order by m.date,m.name,m.id)
    from public.roadmap_markers m where m.workspace_id=workspace),'[]'::jsonb);
end;
$$;

create function platform.planner_marker(account uuid, workspace uuid, action text, marker uuid, marker_name text, marker_date date)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare result public.roadmap_markers;
begin
  perform platform.planner_require_internal(account,workspace,true);
  perform id from public.workspaces where id=workspace for update;
  if action='create' then
    insert into public.roadmap_markers(workspace_id,name,date)
      values(workspace,btrim(marker_name),marker_date) returning * into result;
  elsif action='rename' then
    update public.roadmap_markers set name=btrim(marker_name)
      where id=marker and workspace_id=workspace returning * into result;
  elsif action='delete' then
    delete from public.roadmap_markers where id=marker and workspace_id=workspace returning * into result;
  else
    raise exception 'Unknown marker operation' using errcode='22023';
  end if;
  if result.id is null then
    raise exception 'Marker unavailable in this workspace' using errcode='P0002';
  end if;
  return to_jsonb(result);
end;
$$;
revoke all on function platform.planner_markers(uuid,uuid) from public,anon,authenticated,service_role;
revoke all on function platform.planner_marker(uuid,uuid,text,uuid,text,date) from public,anon,authenticated,service_role;
grant execute on function platform.planner_markers(uuid,uuid) to platform_api;
grant execute on function platform.planner_marker(uuid,uuid,text,uuid,text,date) to platform_api;
