create or replace function platform.ladders_teams(account uuid, workspace uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  if not exists (select 1 from platform.grants g where g.user_id=account
    and g.app='ladders' and g.workspace_id=workspace and g.role in ('owner','editor','viewer')) then
    raise exception 'Internal Ladders access required' using errcode='42501';
  end if;
  return jsonb_build_object(
    'teams',coalesce((select jsonb_agg(jsonb_build_object('id',t.id,'name',t.name)
      order by t.is_default desc,lower(t.name),t.id) from public.teams t
      where t.workspace_id=workspace),'[]'::jsonb),
    'members',coalesce((select jsonb_agg(jsonb_build_object('id',m.id,'team_id',m.team_id,
      'name',m.name,'role',m.role,'planning_role',m.planning_role,'template_id',m.template_id)
      order by lower(m.name),m.id)
      from public.members m join public.teams t on t.id=m.team_id
      where t.workspace_id=workspace),'[]'::jsonb));
end;
$$;

create function platform.ladders_save_profile(account uuid, workspace uuid, member uuid, profile jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  perform 1 from platform.grants g where g.user_id=account and g.app='ladders'
    and g.workspace_id=workspace and g.role in ('owner','editor') for share;
  if not found then
    raise exception 'Internal Ladders edit access required' using errcode='42501';
  end if;
  perform id from public.workspaces where id=workspace for update;
  if profile is null or jsonb_typeof(profile) <> 'object' or
    not (profile ?& array['name','role','planning_role','template_id']) or
    jsonb_typeof(profile->'name') <> 'string' or
    char_length(trim(profile->>'name')) not between 1 and 120 or
    jsonb_typeof(profile->'role') <> 'string' or char_length(trim(profile->>'role')) > 120 or
    (profile->'planning_role' <> 'null'::jsonb and
      (jsonb_typeof(profile->'planning_role') <> 'string' or
       profile->>'planning_role' not in ('backend','frontend','design','qa'))) or
    (profile->'template_id' <> 'null'::jsonb and
      (jsonb_typeof(profile->'template_id') <> 'string' or char_length(profile->>'template_id') > 10)) then
    raise exception 'Invalid member profile' using errcode='22023';
  end if;
  update public.members m set name=trim(profile->>'name'),role=trim(profile->>'role'),
    planning_role=profile->>'planning_role',template_id=profile->>'template_id'
    from public.teams t where m.id=member and m.team_id=t.id and t.workspace_id=workspace;
  if not found then
    raise exception 'Member unavailable in this workspace' using errcode='P0002';
  end if;
  return platform.ladders_teams(account,workspace);
end;
$$;
revoke all on function platform.ladders_save_profile(uuid,uuid,uuid,jsonb)
  from public,anon,authenticated,service_role;
grant execute on function platform.ladders_save_profile(uuid,uuid,uuid,jsonb) to platform_api;
