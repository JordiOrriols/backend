create function platform.ladders_teams(account uuid, workspace uuid)
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
      'name',m.name,'role',m.role,'planning_role',m.planning_role) order by lower(m.name),m.id)
      from public.members m join public.teams t on t.id=m.team_id
      where t.workspace_id=workspace),'[]'::jsonb));
end;
$$;

create function platform.ladders_save_team(account uuid, workspace uuid, team_name text, team uuid default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare storage_owner uuid;
begin
  perform 1 from platform.grants g where g.user_id=account and g.app='ladders'
    and g.workspace_id=workspace and (g.role='owner' or (team is not null and g.role='editor')) for share;
  if not found then
    raise exception 'Ladders team management access required' using errcode='42501';
  end if;
  select w.owner_id into storage_owner from public.workspaces w where w.id=workspace for update;
  if team_name is null or char_length(trim(team_name)) not between 1 and 120 then
    raise exception 'Team names need between 1 and 120 characters' using errcode='22023';
  end if;
  if team is null then
    -- The legacy owner FK is storage metadata, not a mapping of the verified caller.
    insert into public.teams(owner_id,workspace_id,name) values(storage_owner,workspace,trim(team_name));
  else
    update public.teams t set name=trim(team_name) where t.id=team and t.workspace_id=workspace;
    if not found then
      raise exception 'Team unavailable in this workspace' using errcode='P0002';
    end if;
  end if;
  return platform.ladders_teams(account,workspace);
end;
$$;
revoke all on function platform.ladders_teams(uuid,uuid),platform.ladders_save_team(uuid,uuid,text,uuid)
  from public,anon,authenticated,service_role;
grant execute on function platform.ladders_teams(uuid,uuid),platform.ladders_save_team(uuid,uuid,text,uuid)
  to platform_api;
