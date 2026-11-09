create or replace function public.members_before_insert()
returns trigger language plpgsql security definer set search_path to 'public' as $$
declare v_owner_id uuid;
begin
  if session_user = 'platform_api' then
    -- This login has no member INSERT privilege; only scoped definer functions write.
    if new.team_id is null then
      raise exception 'Explicit team required' using errcode='22023';
    end if;
  else
    if new.team_id is null then
      select t.id into new.team_id from teams t
        where t.owner_id=auth.uid() and t.is_default limit 1;
    end if;
    if new.team_id is null or not public.can_edit_team(new.team_id) then
      raise exception 'team edit access required' using errcode='42501';
    end if;
  end if;
  select t.owner_id into v_owner_id from teams t where t.id=new.team_id;
  new.owner_id := v_owner_id;
  new.self_token := gen_random_uuid();
  new.peer_token := gen_random_uuid();
  new.view_token := gen_random_uuid();
  new.view_enabled := coalesce(new.view_enabled,false);
  new.user_id := null;
  return new;
end;
$$;

create function platform.ladders_create_member(account uuid, workspace uuid, team uuid, profile jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare created uuid;
begin
  perform 1 from platform.grants g where g.user_id=account and g.app='ladders'
    and g.workspace_id=workspace and g.role in ('owner','editor') for share;
  if not found then
    raise exception 'Internal Ladders edit access required' using errcode='42501';
  end if;
  perform id from public.workspaces where id=workspace for update;
  perform id from public.teams t where t.id=team and t.workspace_id=workspace for share;
  if not found then
    raise exception 'Team unavailable in this workspace' using errcode='P0002';
  end if;
  insert into public.members(team_id,name) values(team,'New member') returning id into created;
  -- Reuse the complete profile validator; any failure rolls back the insertion too.
  perform platform.ladders_save_profile(account,workspace,created,profile);
  return jsonb_build_object('id',created);
end;
$$;
revoke all on function platform.ladders_create_member(uuid,uuid,uuid,jsonb)
  from public,anon,authenticated,service_role;
grant execute on function platform.ladders_create_member(uuid,uuid,uuid,jsonb) to platform_api;
