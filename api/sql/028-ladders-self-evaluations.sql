create function platform.ladders_my_self_evaluations(account uuid, member uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare profile jsonb;
begin
  select value into profile from jsonb_array_elements(platform.ladders_my_members(account))
    where value->>'id'=member::text;
  if profile is null then
    raise exception 'Member unavailable for this account' using errcode='P0002';
  end if;
  return jsonb_build_object('member',profile,'evaluations',coalesce((
    select jsonb_agg(jsonb_build_object(
      'id',e.id,'member_id',e.member_id,'kind',e.kind,'status',e.status,
      'author_name',e.author_name,'current_levels',e.current_levels,
      'goal_levels',e.goal_levels,'comments',e.comments,
      'comment_visibility','{}'::jsonb,'created_at',e.created_at
    ) order by e.created_at desc,e.id desc)
    from public.evaluations e where e.member_id=member and e.kind='self'
  ),'[]'::jsonb));
end;
$$;

create function platform.ladders_lock_my_member(account uuid, member uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare legacy uuid;
begin
  select l.legacy_user_id into legacy from platform.legacy_account_mappings l
    where l.user_id=account for share;
  if not found then
    raise exception 'Member unavailable for this account' using errcode='P0002';
  end if;
  perform m.id from public.members m where m.id=member and m.user_id=legacy for update;
  if not found then
    raise exception 'Member unavailable for this account' using errcode='P0002';
  end if;
end;
$$;

create function platform.ladders_save_my_evaluation(
  account uuid, member uuid, evaluation uuid, content jsonb
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare saved uuid; author text;
begin
  perform platform.ladders_lock_my_member(account,member);
  if content is null or jsonb_typeof(content)<>'object'
    or not (content ?& array['current_levels','goal_levels','comments'])
    or public.valid_levels(content->'current_levels') is not true
    or public.valid_levels(content->'goal_levels') is not true
    or public.valid_comments(content->'comments') is not true then
    raise exception 'Invalid evaluation content' using errcode='22023';
  end if;
  if evaluation is null then
    if exists (select 1 from public.evaluations e where e.member_id=member
      and e.kind='self' and e.status='draft') then
      raise exception 'A self draft already exists; reload before editing' using errcode='23514';
    end if;
    select m.name into author from public.members m where m.id=member;
    insert into public.evaluations(member_id,kind,status,author_name,current_levels,goal_levels,comments)
      values(member,'self','draft',author,content->'current_levels',content->'goal_levels',
        content->'comments') returning id into saved;
  else
    perform e.id from public.evaluations e where e.id=evaluation and e.member_id=member
      and e.kind='self' for update;
    if not found then
      raise exception 'Self evaluation unavailable for this account' using errcode='P0002';
    end if;
    if not exists (select 1 from public.evaluations e where e.id=evaluation and e.status='draft') then
      raise exception 'Published evaluation content is immutable' using errcode='23514';
    end if;
    update public.evaluations set current_levels=content->'current_levels',
      goal_levels=content->'goal_levels',comments=content->'comments'
      where id=evaluation returning id into saved;
  end if;
  return (select value from jsonb_array_elements(
    platform.ladders_my_self_evaluations(account,member)->'evaluations'
  ) where value->>'id'=saved::text);
end;
$$;

create function platform.ladders_publish_my_evaluation(account uuid, member uuid, evaluation uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  perform platform.ladders_lock_my_member(account,member);
  perform e.id from public.evaluations e where e.id=evaluation and e.member_id=member
    and e.kind='self' for update;
  if not found then
    raise exception 'Self evaluation unavailable for this account' using errcode='P0002';
  end if;
  update public.evaluations set status='published' where id=evaluation;
  return (select value from jsonb_array_elements(
    platform.ladders_my_self_evaluations(account,member)->'evaluations'
  ) where value->>'id'=evaluation::text);
end;
$$;

revoke all on function platform.ladders_my_self_evaluations(uuid,uuid),
  platform.ladders_lock_my_member(uuid,uuid),
  platform.ladders_save_my_evaluation(uuid,uuid,uuid,jsonb),
  platform.ladders_publish_my_evaluation(uuid,uuid,uuid)
  from public,anon,authenticated,service_role,platform_api;
grant execute on function platform.ladders_my_self_evaluations(uuid,uuid),
  platform.ladders_save_my_evaluation(uuid,uuid,uuid,jsonb),
  platform.ladders_publish_my_evaluation(uuid,uuid,uuid) to platform_api;
