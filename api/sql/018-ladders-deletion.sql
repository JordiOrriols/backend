create function platform.ladders_delete_member(account uuid, workspace uuid, member uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  perform 1 from platform.grants g where g.user_id=account and g.app='ladders'
    and g.workspace_id=workspace and g.role='owner' for share;
  if not found then
    raise exception 'Ladders workspace owner access required' using errcode='42501';
  end if;
  perform id from public.workspaces where id=workspace for update;
  delete from public.members m using public.teams t
    where m.id=member and m.team_id=t.id and t.workspace_id=workspace;
  if not found then
    raise exception 'Member unavailable in this workspace' using errcode='P0002';
  end if;
  return platform.ladders_teams(account,workspace);
end;
$$;

create function platform.ladders_delete_team(account uuid, workspace uuid, team uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare target public.teams;
begin
  perform 1 from platform.grants g where g.user_id=account and g.app='ladders'
    and g.workspace_id=workspace and g.role='owner' for share;
  if not found then
    raise exception 'Ladders workspace owner access required' using errcode='42501';
  end if;
  perform id from public.workspaces where id=workspace for update;
  select * into target from public.teams t where t.id=team and t.workspace_id=workspace for update;
  if not found then
    raise exception 'Team unavailable in this workspace' using errcode='P0002';
  end if;
  if target.is_default then
    raise exception 'default team cannot be deleted' using errcode='23514';
  end if;
  if exists(select 1 from public.members m where m.team_id=team) then
    raise exception 'team is not empty' using errcode='23514';
  end if;
  -- Container deletion must not implicitly delete a platform-granted workspace.
  update public.workspaces set created_for_team=false where id=workspace;
  delete from public.teams t where t.id=team and t.workspace_id=workspace;
  return platform.ladders_teams(account,workspace);
end;
$$;
revoke all on function platform.ladders_delete_member(uuid,uuid,uuid),platform.ladders_delete_team(uuid,uuid,uuid)
  from public,anon,authenticated,service_role;
grant execute on function platform.ladders_delete_member(uuid,uuid,uuid),platform.ladders_delete_team(uuid,uuid,uuid)
  to platform_api;
