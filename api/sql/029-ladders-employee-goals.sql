create function platform.ladders_my_goals(account uuid, member uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  perform 1 from jsonb_array_elements(platform.ladders_my_members(account))
    where value->>'id'=member::text;
  if not found then
    raise exception 'Member unavailable for this account' using errcode='P0002';
  end if;
  return (select coalesce(jsonb_agg(jsonb_build_object(
    'id',g.id,'member_id',g.member_id,'title',g.title,'description',g.description,
    'due_date',g.due_date,'progress',g.progress,'comments',coalesce(g.comments,'[]'::jsonb),
    'created_at',g.created_at,'updated_at',g.updated_at
  ) order by g.created_at,g.id),'[]'::jsonb)
  from public.smart_goals g where g.member_id=member);
end;
$$;

create function platform.ladders_update_my_goal(
  account uuid, member uuid, goal uuid, progress smallint, comment text
)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  perform platform.ladders_lock_my_member(account,member);
  if (progress is null) = (comment is null)
    or (progress is not null and progress not between 0 and 100)
    or (comment is not null and char_length(trim(comment)) not between 1 and 10000) then
    raise exception 'Invalid goal progress or comment' using errcode='22023';
  end if;
  perform g.id from public.smart_goals g where g.id=goal and g.member_id=member for update;
  if not found then
    raise exception 'Goal unavailable for this account' using errcode='P0002';
  end if;
  if progress is not null then
    update public.smart_goals g set progress=ladders_update_my_goal.progress where g.id=goal;
  else
    update public.smart_goals g set comments=coalesce(g.comments,'[]'::jsonb) || jsonb_build_array(
      jsonb_build_object('id',gen_random_uuid(),'text',trim(comment),'createdAt',now(),'authorKind','member')
    ) where g.id=goal;
  end if;
  return (select value from jsonb_array_elements(platform.ladders_my_goals(account,member))
    where value->>'id'=goal::text);
end;
$$;

revoke all on function platform.ladders_my_goals(uuid,uuid),
  platform.ladders_update_my_goal(uuid,uuid,uuid,smallint,text)
  from public,anon,authenticated,service_role;
grant execute on function platform.ladders_my_goals(uuid,uuid),
  platform.ladders_update_my_goal(uuid,uuid,uuid,smallint,text) to platform_api;
