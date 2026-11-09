create or replace function platform.ladders_goals(account uuid, workspace uuid, member uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare result jsonb;
begin
  perform 1 from platform.grants g where g.user_id=account and g.app='ladders'
    and g.workspace_id=workspace and g.role in ('owner','editor','viewer') for share;
  if not found then
    raise exception 'Ladders workspace access required' using errcode='42501';
  end if;
  perform m.id from public.members m join public.teams t on t.id=m.team_id
    where m.id=member and t.workspace_id=workspace;
  if not found then
    raise exception 'Member unavailable in this workspace' using errcode='P0002';
  end if;
  select coalesce(jsonb_agg(jsonb_build_object(
    'id',g.id,'member_id',g.member_id,'title',g.title,'description',g.description,
    'due_date',g.due_date,'progress',g.progress,'comments',coalesce(g.comments,'[]'::jsonb),
    'created_at',g.created_at,'updated_at',g.updated_at
  ) order by g.created_at,g.id),'[]'::jsonb) into result
  from public.smart_goals g where g.member_id=member;
  return result;
end;
$$;

create or replace function platform.ladders_save_goal(
  account uuid, workspace uuid, member uuid, goal uuid,
  title text, description text, due_date date, progress smallint
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare saved uuid;
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
  if goal is null then
    insert into public.smart_goals(member_id,title,description,due_date,progress)
      values(member,title,description,due_date,progress) returning id into saved;
  else
    perform g.id from public.smart_goals g where g.id=goal and g.member_id=member for update;
    if not found then
      raise exception 'Goal unavailable in this workspace' using errcode='P0002';
    end if;
    update public.smart_goals g set title=ladders_save_goal.title,
      description=ladders_save_goal.description,due_date=ladders_save_goal.due_date,
      progress=ladders_save_goal.progress where g.id=goal returning g.id into saved;
  end if;
  return (select value from jsonb_array_elements(platform.ladders_goals(account,workspace,member))
    where value->>'id'=saved::text);
end;
$$;

create or replace function platform.ladders_append_goal_comment(
  account uuid, workspace uuid, member uuid, goal uuid, comment text
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare saved uuid;
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
  if comment is null or char_length(trim(comment)) not between 1 and 10000 then
    raise exception 'Comment must contain 1 to 10000 characters' using errcode='22023';
  end if;
  perform g.id from public.smart_goals g where g.id=goal and g.member_id=member for update;
  if not found then
    raise exception 'Goal unavailable in this workspace' using errcode='P0002';
  end if;
  update public.smart_goals g set comments=coalesce(g.comments,'[]'::jsonb) || jsonb_build_array(
    jsonb_build_object('id',gen_random_uuid(),'text',trim(comment),'createdAt',now(),'authorKind','manager')
  ) where g.id=goal returning g.id into saved;
  return (select value from jsonb_array_elements(platform.ladders_goals(account,workspace,member))
    where value->>'id'=saved::text);
end;
$$;

create or replace function platform.ladders_delete_goal(account uuid, workspace uuid, member uuid, goal uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  perform 1 from platform.grants g where g.user_id=account and g.app='ladders'
    and g.workspace_id=workspace and g.role='owner' for share;
  if not found then
    raise exception 'Ladders workspace owner access required' using errcode='42501';
  end if;
  perform id from public.workspaces where id=workspace for update;
  perform m.id from public.members m join public.teams t on t.id=m.team_id
    where m.id=member and t.workspace_id=workspace for update of m;
  if not found then
    raise exception 'Member unavailable in this workspace' using errcode='P0002';
  end if;
  perform g.id from public.smart_goals g where g.id=goal and g.member_id=member for update;
  if not found then
    raise exception 'Goal unavailable in this workspace' using errcode='P0002';
  end if;
  delete from public.smart_goals g where g.id=goal;
  return platform.ladders_goals(account,workspace,member);
end;
$$;

revoke all on function platform.ladders_goals(uuid,uuid,uuid),
  platform.ladders_save_goal(uuid,uuid,uuid,uuid,text,text,date,smallint),
  platform.ladders_append_goal_comment(uuid,uuid,uuid,uuid,text),
  platform.ladders_delete_goal(uuid,uuid,uuid,uuid)
  from public,anon,authenticated,service_role;
grant execute on function platform.ladders_goals(uuid,uuid,uuid),
  platform.ladders_save_goal(uuid,uuid,uuid,uuid,text,text,date,smallint),
  platform.ladders_append_goal_comment(uuid,uuid,uuid,uuid,text),
  platform.ladders_delete_goal(uuid,uuid,uuid,uuid)
  to platform_api;
