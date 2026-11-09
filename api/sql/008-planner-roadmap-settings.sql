create function platform.planner_toggle_backlog(account uuid, workspace uuid, feature uuid, included boolean)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare result public.features; next_priority integer;
begin
  perform 1 from platform.grants g where g.user_id=account and g.app='planner'
    and g.workspace_id=workspace and g.role in ('owner','editor') for share;
  if not found then
    raise exception 'Internal Planner edit access required' using errcode='42501';
  end if;
  perform id from public.workspaces where id=workspace for update;
  select coalesce(max(f.priority),0)+1 into next_priority
    from public.features f join public.projects p on p.id=f.project_id
    where p.workspace_id=workspace and f.in_backlog;
  update public.features f set in_backlog=included,
    priority=case when included and not f.in_backlog then next_priority else f.priority end
    from public.projects p where f.id=feature and p.id=f.project_id and p.workspace_id=workspace
    returning f.* into result;
  if result.id is null then
    raise exception 'Feature unavailable in this workspace' using errcode='P0002';
  end if;
  perform public.planner_check_dependencies(workspace);
  return platform.planner_feature_fields(result);
end;
$$;

create function platform.planner_start_date(account uuid, workspace uuid, start_date date)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  perform 1 from platform.grants g where g.user_id=account and g.app='planner'
    and g.workspace_id=workspace and g.role in ('owner','editor') for share;
  if not found then
    raise exception 'Internal Planner edit access required' using errcode='42501';
  end if;
  perform id from public.workspaces where id=workspace for update;
  if start_date is null then
    raise exception 'Plan start date is required' using errcode='22023';
  end if;
  update public.workspaces set plan_start_date=start_date where id=workspace;
  return platform.planner_source(account,workspace);
end;
$$;
revoke all on function platform.planner_toggle_backlog(uuid,uuid,uuid,boolean)
  from public,anon,authenticated,service_role;
revoke all on function platform.planner_start_date(uuid,uuid,date)
  from public,anon,authenticated,service_role;
grant execute on function platform.planner_toggle_backlog(uuid,uuid,uuid,boolean) to platform_api;
grant execute on function platform.planner_start_date(uuid,uuid,date) to platform_api;
