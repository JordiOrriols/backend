create function platform.ladders_evaluations(account uuid, workspace uuid, member uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  if not exists (select 1 from platform.grants g where g.user_id=account
    and g.app='ladders' and g.workspace_id=workspace and g.role in ('owner','editor','viewer')) then
    raise exception 'Internal Ladders access required' using errcode='42501';
  end if;
  if not exists (select 1 from public.members m join public.teams t on t.id=m.team_id
    where m.id=member and t.workspace_id=workspace) then
    raise exception 'Member unavailable in this workspace' using errcode='P0002';
  end if;
  -- Self drafts stay private to the employee, as in the legacy team projection.
  return coalesce((select jsonb_agg(jsonb_build_object(
    'id',e.id,'member_id',e.member_id,'kind',e.kind,'status',e.status,
    'author_name',e.author_name,'current_levels',e.current_levels,
    'goal_levels',e.goal_levels,'comments',e.comments,
    'comment_visibility',e.comment_visibility,'created_at',e.created_at)
    order by e.created_at desc,e.id desc) from public.evaluations e
    where e.member_id=member and (e.kind <> 'self' or e.status='published')),'[]'::jsonb);
end;
$$;
revoke all on function platform.ladders_evaluations(uuid,uuid,uuid)
  from public,anon,authenticated,service_role;
grant execute on function platform.ladders_evaluations(uuid,uuid,uuid) to platform_api;
