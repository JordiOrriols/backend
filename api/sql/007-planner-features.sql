create function platform.planner_feature_fields(feature public.features)
returns jsonb language sql immutable set search_path = '' as $$
  select jsonb_build_object(
    'id',feature.id,'project_id',feature.project_id,'name',feature.name,
    'description',feature.description,'status',feature.status,
    'in_backlog',feature.in_backlog,'priority',feature.priority,'dependency_ids',feature.dependency_ids,
    'backend_devs',feature.backend_devs,'backend_weeks',feature.backend_weeks,
    'frontend_devs',feature.frontend_devs,'frontend_weeks',feature.frontend_weeks,
    'design_devs',feature.design_devs,'design_weeks',feature.design_weeks,
    'qa_devs',feature.qa_devs,'qa_weeks',feature.qa_weeks);
$$;
revoke all on function platform.planner_feature_fields(public.features)
  from public,anon,authenticated,service_role,platform_api;

create function platform.planner_features(account uuid, workspace uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  perform platform.planner_require_internal(account,workspace);
  return coalesce((select jsonb_agg(platform.planner_feature_fields(f) order by f.priority,f.id)
    from public.features f join public.projects p on p.id=f.project_id
    where p.workspace_id=workspace),'[]'::jsonb);
end;
$$;

create function platform.planner_feature(account uuid, workspace uuid, action text, feature uuid, payload jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare result public.features; input public.features;
begin
  perform 1 from platform.grants g where g.user_id=account and g.app='planner'
    and g.workspace_id=workspace and g.role in ('owner','editor') for share;
  if not found then
    raise exception 'Internal Planner edit access required' using errcode='42501';
  end if;
  perform id from public.workspaces where id=workspace for update;
  if action not in ('create','save','delete') or action is null then
    raise exception 'Unknown feature operation' using errcode='22023';
  end if;
  if action <> 'create' then
    select f.* into result from public.features f join public.projects p on p.id=f.project_id
      where f.id=feature and p.workspace_id=workspace for update of f;
    if result.id is null then
      raise exception 'Feature unavailable in this workspace' using errcode='P0002';
    end if;
  end if;
  if action='delete' then
    delete from public.features where id=result.id returning * into result;
  else
    input := jsonb_populate_record(null::public.features,payload);
    if not exists(select 1 from public.projects p where p.id=input.project_id and p.workspace_id=workspace) then
      raise exception 'Project unavailable in this workspace' using errcode='P0002';
    end if;
    if action='create' then
      insert into public.features(project_id,name,description,status,dependency_ids,
        backend_devs,backend_weeks,frontend_devs,frontend_weeks,design_devs,design_weeks,qa_devs,qa_weeks)
      values(input.project_id,btrim(input.name),input.description,input.status,input.dependency_ids,
        input.backend_devs,input.backend_weeks,input.frontend_devs,input.frontend_weeks,
        input.design_devs,input.design_weeks,input.qa_devs,input.qa_weeks)
      returning * into result;
    else
      update public.features set project_id=input.project_id,name=btrim(input.name),
        description=input.description,status=input.status,dependency_ids=input.dependency_ids,
        backend_devs=input.backend_devs,backend_weeks=input.backend_weeks,
        frontend_devs=input.frontend_devs,frontend_weeks=input.frontend_weeks,
        design_devs=input.design_devs,design_weeks=input.design_weeks,
        qa_devs=input.qa_devs,qa_weeks=input.qa_weeks
        where id=result.id returning * into result;
    end if;
  end if;
  perform public.planner_check_dependencies(workspace);
  return platform.planner_feature_fields(result);
end;
$$;
revoke all on function platform.planner_features(uuid,uuid) from public,anon,authenticated,service_role;
revoke all on function platform.planner_feature(uuid,uuid,text,uuid,jsonb) from public,anon,authenticated,service_role;
grant execute on function platform.planner_features(uuid,uuid) to platform_api;
grant execute on function platform.planner_feature(uuid,uuid,text,uuid,jsonb) to platform_api;
