create function platform.planner_projects(account uuid, workspace uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  perform platform.planner_require_internal(account,workspace);
  return coalesce((select jsonb_agg(jsonb_build_object(
    'id',p.id,'workspace_id',p.workspace_id,'name',p.name,
    'in_use',exists(select 1 from public.features f where f.project_id=p.id)
  ) order by p.name,p.id) from public.projects p where p.workspace_id=workspace),'[]'::jsonb);
end;
$$;

create function platform.planner_project(account uuid, workspace uuid, action text, project uuid, project_name text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare result public.projects;
begin
  perform platform.planner_require_internal(account,workspace,true);
  perform id from public.workspaces where id=workspace for update;
  if action='create' then
    insert into public.projects(workspace_id,name) values(workspace,btrim(project_name)) returning * into result;
  else
    select p.* into result from public.projects p where p.id=project and p.workspace_id=workspace for update;
    if result.id is null then
      raise exception 'Project unavailable in this workspace' using errcode='P0002';
    end if;
    if action='rename' then
      update public.projects set name=btrim(project_name)
        where id=project and workspace_id=workspace returning * into result;
    elsif action='delete' then
      if exists(select 1 from public.features f where f.project_id=project) then
        raise exception 'Move or delete the features of this project first' using errcode='23514';
      end if;
      delete from public.projects where id=project and workspace_id=workspace returning * into result;
    else
      raise exception 'Unknown project operation' using errcode='22023';
    end if;
  end if;
  return jsonb_build_object('id',result.id,'workspace_id',result.workspace_id,'name',result.name,
    'in_use',exists(select 1 from public.features f where f.project_id=result.id));
end;
$$;
revoke all on function platform.planner_projects(uuid,uuid) from public,anon,authenticated,service_role;
revoke all on function platform.planner_project(uuid,uuid,text,uuid,text) from public,anon,authenticated,service_role;
grant execute on function platform.planner_projects(uuid,uuid) to platform_api;
grant execute on function platform.planner_project(uuid,uuid,text,uuid,text) to platform_api;
