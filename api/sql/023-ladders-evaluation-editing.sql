create function platform.ladders_save_evaluation(
  account uuid, workspace uuid, member uuid, evaluation uuid, content jsonb
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare saved uuid; visibility jsonb;
begin
  perform 1 from platform.grants g where g.user_id=account and g.app='ladders'
    and g.workspace_id=workspace and g.role in ('owner','editor') for share;
  if not found then
    raise exception 'Internal Ladders edit access required' using errcode='42501';
  end if;
  perform id from public.workspaces where id=workspace for update;
  perform m.id from public.members m join public.teams t on t.id=m.team_id
    where m.id=member and t.workspace_id=workspace for update of m;
  if not found then
    raise exception 'Member unavailable in this workspace' using errcode='P0002';
  end if;
  if content is null or jsonb_typeof(content)<>'object'
    or not (content ?& array['current_levels','goal_levels','comments'])
    or public.valid_levels(content->'current_levels') is not true
    or public.valid_levels(content->'goal_levels') is not true
    or public.valid_comments(content->'comments') is not true then
    raise exception 'Invalid evaluation content' using errcode='22023';
  end if;
  if evaluation is null then
    if exists (select 1 from public.evaluations e where e.member_id=member
      and e.kind='manager' and e.status='draft') then
      raise exception 'A manager draft already exists; reload before editing' using errcode='23514';
    end if;
    -- Visibility is copied server-side, never supplied by the draft-content caller.
    select e.comment_visibility into visibility from public.evaluations e
      where e.member_id=member and e.kind='manager'
      order by e.created_at desc,e.id desc limit 1;
    insert into public.evaluations(member_id,kind,status,current_levels,goal_levels,comments,comment_visibility)
      values(member,'manager','draft',content->'current_levels',content->'goal_levels',
        content->'comments',coalesce(visibility,'{}'::jsonb)) returning id into saved;
  else
    perform e.id from public.evaluations e where e.id=evaluation and e.member_id=member
      and e.kind='manager' for update;
    if not found then
      raise exception 'Evaluation unavailable in this workspace' using errcode='P0002';
    end if;
    if not exists (select 1 from public.evaluations e where e.id=evaluation and e.status='draft') then
      raise exception 'Published evaluation content is immutable' using errcode='23514';
    end if;
    update public.evaluations set current_levels=content->'current_levels',
      goal_levels=content->'goal_levels',comments=content->'comments'
      where id=evaluation returning id into saved;
  end if;
  return (select value from jsonb_array_elements(platform.ladders_evaluations(account,workspace,member))
    where value->>'id'=saved::text);
end;
$$;

create function platform.ladders_evaluation_status(
  account uuid, workspace uuid, member uuid, evaluation uuid, status text
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
  select e.* into target from public.evaluations e join public.members m on m.id=e.member_id
    join public.teams t on t.id=m.team_id
    where e.id=evaluation and m.id=member and t.workspace_id=workspace
      and e.kind in ('manager','peer') for update of e;
  if not found then
    raise exception 'Evaluation unavailable in this workspace' using errcode='P0002';
  end if;
  if status is null or status not in ('draft','published') then
    raise exception 'Invalid evaluation status' using errcode='22023';
  end if;
  if target.kind='manager' and status='draft' and exists (
    select 1 from public.evaluations e where e.member_id=member and e.kind='manager'
      and e.status='draft' and e.id<>evaluation
  ) then
    raise exception 'A manager draft already exists; reload before editing' using errcode='23514';
  end if;
  update public.evaluations e set status=ladders_evaluation_status.status where e.id=evaluation;
  return (select value from jsonb_array_elements(platform.ladders_evaluations(account,workspace,member))
    where value->>'id'=evaluation::text);
end;
$$;
revoke all on function platform.ladders_save_evaluation(uuid,uuid,uuid,uuid,jsonb)
  from public,anon,authenticated,service_role;
revoke all on function platform.ladders_evaluation_status(uuid,uuid,uuid,uuid,text)
  from public,anon,authenticated,service_role;
grant execute on function platform.ladders_save_evaluation(uuid,uuid,uuid,uuid,jsonb) to platform_api;
grant execute on function platform.ladders_evaluation_status(uuid,uuid,uuid,uuid,text) to platform_api;
