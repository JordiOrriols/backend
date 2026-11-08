create or replace function public.members_before_update()
returns trigger language plpgsql security definer set search_path to 'public' as $$
declare v_new_owner_id uuid;
begin
  if new.owner_id is distinct from old.owner_id
    or new.self_token is distinct from old.self_token
    or new.peer_token is distinct from old.peer_token
    or new.view_token is distinct from old.view_token
    or new.id is distinct from old.id then
    raise exception 'owner, id and share tokens are immutable';
  end if;
  if new.user_id is distinct from old.user_id and new.user_id is not null
    and current_setting('members.claiming',true) is distinct from new.id::text then
    raise exception 'Members are linked to an account only through an invite' using errcode='42501';
  end if;
  if new.team_id is distinct from old.team_id then
    -- The API login cannot UPDATE members directly; its scoped definer authorizes moves.
    if session_user <> 'platform_api' and
      (not public.can_edit_team(old.team_id) or not public.can_edit_team(new.team_id)) then
      raise exception 'both teams require edit access' using errcode='42501';
    end if;
    select t.owner_id into v_new_owner_id from teams t where t.id=new.team_id;
    if v_new_owner_id is distinct from old.owner_id then
      raise exception 'members cannot move across team owners' using errcode='42501';
    end if;
  end if;
  new.updated_at := now();
  return new;
end;
$$;

create function platform.ladders_move_member(account uuid, workspace uuid, member uuid, team uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare target public.members; destination_owner uuid;
begin
  perform 1 from platform.grants g where g.user_id=account and g.app='ladders'
    and g.workspace_id=workspace and g.role in ('owner','editor') for share;
  if not found then
    raise exception 'Internal Ladders edit access required' using errcode='42501';
  end if;
  perform id from public.workspaces where id=workspace for update;
  select m.* into target from public.members m join public.teams t on t.id=m.team_id
    where m.id=member and t.workspace_id=workspace for update of m;
  if not found then
    raise exception 'Member unavailable in this workspace' using errcode='P0002';
  end if;
  select t.owner_id into destination_owner from public.teams t
    where t.id=team and t.workspace_id=workspace for share;
  if not found then
    raise exception 'Team unavailable in this workspace' using errcode='P0002';
  end if;
  if destination_owner is distinct from target.owner_id then
    raise exception 'members cannot move across team owners' using errcode='42501';
  end if;
  if target.team_id is distinct from team then
    begin
      update public.members set team_id=team where id=member;
    exception when unique_violation then
      raise exception 'This account already has a member in the destination team' using errcode='23514';
    end;
  end if;
  return platform.ladders_teams(account,workspace);
end;
$$;
revoke all on function platform.ladders_move_member(uuid,uuid,uuid,uuid)
  from public,anon,authenticated,service_role;
grant execute on function platform.ladders_move_member(uuid,uuid,uuid,uuid) to platform_api;
