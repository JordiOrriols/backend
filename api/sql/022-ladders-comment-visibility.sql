create function platform.ladders_comment_visibility(
  account uuid, workspace uuid, member uuid, evaluation uuid, category text, visible boolean
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare target public.evaluations;
begin
  perform 1 from platform.grants g where g.user_id=account and g.app='ladders'
    and g.workspace_id=workspace and g.role in ('owner','editor') for share;
  if not found then
    raise exception 'Internal Ladders edit access required' using errcode='42501';
  end if;
  perform id from public.workspaces where id=workspace for update;
  select e.* into target from public.evaluations e
    join public.members m on m.id=e.member_id join public.teams t on t.id=m.team_id
    where e.id=evaluation and m.id=member and t.workspace_id=workspace
      and (e.kind <> 'self' or e.status='published') for update of e;
  if not found then
    raise exception 'Evaluation unavailable in this workspace' using errcode='P0002';
  end if;
  if category is null or category not in ('Technology','System','People','Process','Influence')
    or visible is null or coalesce(trim(target.comments->>category),'')='' then
    raise exception 'Choose an existing competency comment' using errcode='22023';
  end if;
  update public.evaluations set comment_visibility=
    jsonb_set(comment_visibility,array[category],to_jsonb(visible)) where id=evaluation;
  return platform.ladders_evaluations(account,workspace,member);
end;
$$;
revoke all on function platform.ladders_comment_visibility(uuid,uuid,uuid,uuid,text,boolean)
  from public,anon,authenticated,service_role;
grant execute on function platform.ladders_comment_visibility(uuid,uuid,uuid,uuid,text,boolean) to platform_api;
