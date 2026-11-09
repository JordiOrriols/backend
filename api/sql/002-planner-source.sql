create or replace function platform.planner_source(account uuid, workspace uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare source jsonb;
begin
  if not exists(select 1 from platform.grants g
    where g.user_id=account and g.workspace_id=workspace and g.app='planner')
  then raise exception 'Workspace access required' using errcode='42501'; end if;
  select jsonb_build_object(
    'name',w.name,'startDate',w.plan_start_date,
    'markers',coalesce((select jsonb_agg(jsonb_build_object('name',m.name,'date',m.date) order by m.date,m.name,m.id)
      from public.roadmap_markers m where m.workspace_id=workspace),'[]'::jsonb),
    'projects',coalesce((select jsonb_agg(jsonb_build_object('id',p.id,'name',p.name) order by p.id)
      from public.projects p where p.workspace_id=workspace),'[]'::jsonb),
    'features',coalesce((select jsonb_agg(jsonb_build_object(
      'id',f.id,'project_id',f.project_id,'name',f.name,'description','',
      'in_backlog',f.in_backlog,'status',f.status,'priority',f.priority,
      'dependency_ids',f.dependency_ids,
      'backend_devs',f.backend_devs,'backend_weeks',f.backend_weeks,
      'frontend_devs',f.frontend_devs,'frontend_weeks',f.frontend_weeks,
      'design_devs',f.design_devs,'design_weeks',f.design_weeks,
      'qa_devs',f.qa_devs,'qa_weeks',f.qa_weeks) order by f.priority,f.id)
      from public.features f join public.projects p on p.id=f.project_id
      where p.workspace_id=workspace and f.in_backlog),'[]'::jsonb),
    'members',coalesce((select jsonb_agg(jsonb_build_object('id',m.id,'role',m.planning_role) order by m.id)
      from public.members m join public.teams t on t.id=m.team_id
      where t.workspace_id=workspace),'[]'::jsonb),
    'vacations',coalesce((select jsonb_agg(jsonb_build_object(
      'member_id',v.member_id,'date',v.date,'is_working',v.is_working) order by v.member_id,v.date)
      from public.vacations v join public.members m on m.id=v.member_id
      join public.teams t on t.id=m.team_id where t.workspace_id=workspace),'[]'::jsonb)
  ) into source from public.workspaces w where w.id=workspace;
  return source || jsonb_build_object('revision',md5(source::text));
end;
$$;
revoke all on function platform.planner_source(uuid,uuid) from public,anon,authenticated,service_role;
grant execute on function platform.planner_source(uuid,uuid) to platform_api;
