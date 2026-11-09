create function platform.ladders_my_members(account uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id',m.id,'name',m.name,'role',m.role,'planning_role',m.planning_role,
    'template_id',m.template_id,'workspace_id',w.id,'workspace_name',w.name
  ) order by w.name,m.name,m.id),'[]'::jsonb)
  from platform.legacy_account_mappings l
    join public.members m on m.user_id=l.legacy_user_id
    join public.teams t on t.id=m.team_id
    join public.workspaces w on w.id=t.workspace_id
  where l.user_id=account;
$$;

create function platform.ladders_my_evaluations(account uuid, member uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare profile jsonb;
begin
  select value into profile
    from jsonb_array_elements(platform.ladders_my_members(account))
    where value->>'id'=member::text;
  if profile is null then
    raise exception 'Member unavailable for this account' using errcode='P0002';
  end if;
  return jsonb_build_object('member',profile,'evaluations',coalesce((
    select jsonb_agg(jsonb_build_object(
      'id',e.id,'member_id',e.member_id,'kind',e.kind,'status',e.status,
      'author_name',e.author_name,'current_levels',e.current_levels,
      'goal_levels',e.goal_levels,'comments',coalesce((
        select jsonb_object_agg(c.key,c.value) from jsonb_each(e.comments) c
        where coalesce((e.comment_visibility->>c.key)::boolean,e.kind <> 'peer')
      ),'{}'::jsonb),'comment_visibility','{}'::jsonb,'created_at',e.created_at
    ) order by e.created_at desc,e.id desc)
    from public.evaluations e
    where e.member_id=member and (e.kind='self' or e.status='published')
  ),'[]'::jsonb));
end;
$$;

revoke all on function platform.ladders_my_members(uuid),
  platform.ladders_my_evaluations(uuid,uuid)
  from public, anon, authenticated, service_role;
grant execute on function platform.ladders_my_members(uuid),
  platform.ladders_my_evaluations(uuid,uuid) to platform_api;
