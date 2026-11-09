create function platform.planner_apply_priorities(account uuid, workspace uuid, feature_ids uuid[], expected_revision text)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  -- Hold the grant during the write so a concurrent revocation cannot race it.
  perform 1 from platform.grants g where g.user_id=account and g.app='planner'
    and g.workspace_id=workspace and g.role in ('owner','editor') for share;
  if not found then
    raise exception 'Internal Planner edit access required' using errcode='42501';
  end if;
  perform id from public.workspaces where id=workspace for update;
  perform platform.planner_preview(account,workspace,feature_ids,expected_revision);
  update public.features f set priority=ordered.position
    from unnest(feature_ids) with ordinality ordered(id,position), public.projects p
    where f.id=ordered.id and f.project_id=p.id and p.workspace_id=workspace
      and f.in_backlog and f.priority is distinct from ordered.position;
  perform public.planner_check_dependencies(workspace);
  return platform.planner_source(account,workspace);
end;
$$;
revoke all on function platform.planner_apply_priorities(uuid,uuid,uuid[],text)
  from public,anon,authenticated,service_role;
grant execute on function platform.planner_apply_priorities(uuid,uuid,uuid[],text) to platform_api;
