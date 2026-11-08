create function platform.shiplog_release_features(account uuid, workspace uuid, release uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  perform platform.shiplog_require_internal(account,workspace);
  if not exists(select 1 from public.shiplog_releases r where r.id=release and r.workspace_id=workspace) then
    raise exception 'Release unavailable in this workspace' using errcode='P0002';
  end if;
  return coalesce((select jsonb_agg(jsonb_build_object('id',l.feature_id,'name',l.name,'linked',true)
    order by lower(l.name),l.feature_id) from public.shiplog_release_features l where l.release_id=release),'[]'::jsonb);
end;
$$;

create function platform.shiplog_workspace_features(account uuid, workspace uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  perform platform.shiplog_require_internal(account,workspace);
  if not exists(select 1 from platform.grants g where g.user_id=account and g.app='planner'
    and g.workspace_id=workspace and g.role in ('owner','editor','viewer')) then
    raise exception 'Planner access required' using errcode='42501';
  end if;
  return coalesce((select jsonb_agg(jsonb_build_object('id',f.id,'name',f.name,'linked',false)
    order by lower(f.name),f.id) from public.features f join public.projects p on p.id=f.project_id
    where p.workspace_id=workspace),'[]'::jsonb);
end;
$$;

create function platform.shiplog_save_release(account uuid, workspace uuid, release uuid, input jsonb, feature_ids uuid[])
returns jsonb language plpgsql security definer set search_path = '' as $$
declare previous public.shiplog_releases; saved public.shiplog_releases;
  app uuid := (input->>'application_id')::uuid; feature uuid; feature_name text;
  previous_links jsonb;
begin
  perform 1 from platform.grants g where g.user_id=account and g.app='shiplog'
    and g.workspace_id=workspace and g.role in ('owner','editor') for share;
  if not found then raise exception 'Shiplog edit access required' using errcode='42501'; end if;
  perform id from public.workspaces where id=workspace for update;
  perform id from public.shiplog_applications a where a.id=app and a.workspace_id=workspace for update;
  if not found then raise exception 'Application unavailable in this workspace' using errcode='P0002'; end if;
  if input->>'status' is null or input->>'status' not in ('draft','qa','released')
    or input->>'version' is null or input->>'title' is null or input->>'public_notes' is null then
    raise exception 'Invalid release fields' using errcode='22023';
  end if;
  if release is not null then
    select * into previous from public.shiplog_releases r where r.id=release and r.workspace_id=workspace for update;
    if not found then raise exception 'Release unavailable in this workspace' using errcode='P0002'; end if;
    if previous.application_id<>app then
      raise exception 'The release application cannot be changed' using errcode='23514';
    end if;
    if previous.status<>'draft' and (previous.version is distinct from input->>'version'
      or previous.title is distinct from trim(input->>'title') or feature_ids is not null) then
      raise exception 'Only drafts can be edited' using errcode='23514';
    end if;
    previous_links := platform.shiplog_release_features(account,workspace,release);
  end if;
  if feature_ids is not null then
    perform 1 from platform.grants g where g.user_id=account and g.app='planner'
      and g.workspace_id=workspace and g.role in ('owner','editor','viewer') for share;
    if not found then raise exception 'Planner access required' using errcode='42501'; end if;
    if array_position(feature_ids,null) is not null then
      raise exception 'Planner feature unavailable' using errcode='22023';
    end if;
    for feature in select distinct unnest(feature_ids) loop
      perform f.id from public.features f join public.projects p on p.id=f.project_id
        where f.id=feature and p.workspace_id=workspace for share of f,p;
      if not found then raise exception 'Planner feature unavailable' using errcode='P0002'; end if;
    end loop;
  end if;
  if exists(select 1 from public.shiplog_releases r where r.application_id=app
    and r.version=input->>'version' and (release is null or r.id<>release)) then
    raise exception 'Release version already exists for this application' using errcode='23514';
  end if;
  if release is null then
    insert into public.shiplog_releases(workspace_id,application_id,version,release_type,title,public_notes,status)
      values(workspace,app,input->>'version',public.shiplog_detect_release_type(app,input->>'version'),
        trim(input->>'title'),input->>'public_notes',input->>'status') returning * into saved;
  else
    update public.shiplog_releases r set version=input->>'version',
      release_type=case when previous.status='draft' then public.shiplog_detect_release_type(app,input->>'version',release)
        else previous.release_type end,
      title=trim(input->>'title'),public_notes=input->>'public_notes',status=input->>'status'
      where r.id=release returning * into saved;
  end if;
  if feature_ids is not null then
    delete from public.shiplog_release_features l where l.release_id=saved.id and not (l.feature_id=any(feature_ids));
    for feature in select distinct unnest(feature_ids) loop
      select f.name into feature_name from public.features f where f.id=feature;
      insert into public.shiplog_release_features(release_id,feature_id,name) values(saved.id,feature,feature_name)
        on conflict(release_id,feature_id) do nothing;
    end loop;
  end if;
  insert into platform.shiplog_audit_events(workspace_id,actor_id,event,details)
    values(workspace,account,case when release is null then 'release.created' else 'release.updated' end,
      jsonb_build_object('release_id',saved.id,'before',to_jsonb(previous),'after',to_jsonb(saved),
        'features_before',previous_links,'features_after',platform.shiplog_release_features(account,workspace,saved.id)));
  return public.shiplog_public_release_content(saved.id);
end;
$$;
revoke all on function platform.shiplog_release_features(uuid,uuid,uuid),
  platform.shiplog_workspace_features(uuid,uuid),platform.shiplog_save_release(uuid,uuid,uuid,jsonb,uuid[])
  from public,anon,authenticated,service_role;
grant execute on function platform.shiplog_release_features(uuid,uuid,uuid),
  platform.shiplog_workspace_features(uuid,uuid),platform.shiplog_save_release(uuid,uuid,uuid,jsonb,uuid[])
  to platform_api;
