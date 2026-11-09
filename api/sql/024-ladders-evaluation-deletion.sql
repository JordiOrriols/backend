create function platform.ladders_delete_evaluation(
  account uuid, workspace uuid, member uuid, evaluation uuid
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare target public.evaluations;
begin
  perform 1 from platform.grants g where g.user_id=account and g.app='ladders'
    and g.workspace_id=workspace and g.role='owner' for share;
  if not found then
    raise exception 'Ladders workspace owner access required' using errcode='42501';
  end if;
  perform id from public.workspaces where id=workspace for update;
  select e.* into target from public.evaluations e
    join public.members m on m.id=e.member_id
    join public.teams t on t.id=m.team_id
    where e.id=evaluation and m.id=member and t.workspace_id=workspace
    for update of e;
  if not found then
    raise exception 'Evaluation unavailable in this workspace' using errcode='P0002';
  end if;
  if target.kind='self' and target.status='draft' then
    raise exception 'Evaluation unavailable in this workspace' using errcode='P0002';
  end if;
  delete from public.evaluations e where e.id=evaluation;
  return platform.ladders_evaluations(account,workspace,member);
end;
$$;
revoke all on function platform.ladders_delete_evaluation(uuid,uuid,uuid,uuid)
  from public,anon,authenticated,service_role;
grant execute on function platform.ladders_delete_evaluation(uuid,uuid,uuid,uuid) to platform_api;
