create function platform.planner_create_team(account uuid, workspace uuid, team_name text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare storage_owner uuid;
begin
  perform 1 from platform.grants g where g.user_id=account and g.app='planner'
    and g.workspace_id=workspace and g.role='owner' for share;
  if not found then
    raise exception 'Planner workspace owner access required' using errcode='42501';
  end if;
  select w.owner_id into storage_owner from public.workspaces w where w.id=workspace for update;
  if team_name is null or char_length(trim(team_name)) not between 1 and 120 then
    raise exception 'Team names need between 1 and 120 characters' using errcode='22023';
  end if;
  -- Legacy storage requires the workspace owner FK; this does not link the caller's identity.
  insert into public.teams(owner_id,workspace_id,name) values(storage_owner,workspace,trim(team_name));
  return platform.planner_calendar(account,workspace);
end;
$$;

create function platform.planner_planning_role(account uuid, workspace uuid, member uuid, planning_role text)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  perform 1 from platform.grants g where g.user_id=account and g.app='planner'
    and g.workspace_id=workspace and g.role in ('owner','editor') for share;
  if not found then
    raise exception 'Internal Planner edit access required' using errcode='42501';
  end if;
  perform id from public.workspaces where id=workspace for update;
  if planning_role is not null and planning_role not in ('backend','frontend','design','qa') then
    raise exception 'Invalid planning role' using errcode='22023';
  end if;
  update public.members m set planning_role=planner_planning_role.planning_role
    from public.teams t where m.id=member and m.team_id=t.id and t.workspace_id=workspace;
  if not found then
    raise exception 'Member unavailable in this workspace' using errcode='P0002';
  end if;
  return platform.planner_calendar(account,workspace);
end;
$$;
revoke all on function platform.planner_create_team(uuid,uuid,text) from public,anon,authenticated,service_role;
revoke all on function platform.planner_planning_role(uuid,uuid,uuid,text) from public,anon,authenticated,service_role;
grant execute on function platform.planner_create_team(uuid,uuid,text) to platform_api;
grant execute on function platform.planner_planning_role(uuid,uuid,uuid,text) to platform_api;
