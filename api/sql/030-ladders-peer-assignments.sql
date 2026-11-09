create table platform.ladders_peer_assignments (
  id uuid primary key default gen_random_uuid(),
  member_id uuid not null references public.members(id) on delete cascade,
  reviewer_member_id uuid not null references public.members(id) on delete cascade,
  reviewer_id uuid not null references platform.users(id),
  created_at timestamptz not null default now(),
  submitted_at timestamptz,
  revoked_at timestamptz,
  evaluation_id uuid references public.evaluations(id) on delete set null
);
create unique index ladders_pending_peer_assignment
  on platform.ladders_peer_assignments(member_id,reviewer_id)
  where submitted_at is null and revoked_at is null;
revoke all on platform.ladders_peer_assignments from public,anon,authenticated,service_role,platform_api;

create function platform.ladders_peer_management(
  account uuid, workspace uuid, member uuid, action text, target uuid
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare legacy uuid; reviewer uuid;
begin
  perform 1 from platform.grants g where g.user_id=account and g.app='ladders'
    and g.workspace_id=workspace and g.role in ('owner','editor') for share;
  if not found then
    raise exception 'Internal Ladders edit access required' using errcode='42501';
  end if;
  perform id from public.workspaces where id=workspace for update;
  select m.user_id into legacy from public.members m join public.teams t on t.id=m.team_id
    where m.id=member and t.workspace_id=workspace for update of m;
  if not found then
    raise exception 'Member unavailable in this workspace' using errcode='P0002';
  end if;
  if action='candidates' then
    return (select coalesce(jsonb_agg(jsonb_build_object('id',m.id,'name',m.name)
      order by m.name,m.id),'[]'::jsonb)
      from public.members m join public.teams t on t.id=m.team_id
      join platform.legacy_account_mappings l on l.legacy_user_id=m.user_id
      where t.workspace_id=workspace and m.id<>member
        and m.user_id is distinct from legacy);
  elsif action='assign' then
    select l.user_id into reviewer from public.members m
      join public.teams t on t.id=m.team_id
      join platform.legacy_account_mappings l on l.legacy_user_id=m.user_id
      where m.id=target and t.workspace_id=workspace and m.id<>member
        and m.user_id is distinct from legacy for share of m,l;
    if not found then
      raise exception 'Reviewer unavailable in this workspace' using errcode='P0002';
    end if;
    if exists (select 1 from platform.ladders_peer_assignments a
      where a.member_id=member and a.reviewer_id=reviewer
        and a.submitted_at is null and a.revoked_at is null) then
      raise exception 'A peer assignment is already pending' using errcode='23514';
    end if;
    insert into platform.ladders_peer_assignments(member_id,reviewer_member_id,reviewer_id)
      values(member,target,reviewer);
  elsif action='revoke' then
    update platform.ladders_peer_assignments a set revoked_at=coalesce(a.revoked_at,now())
      where a.id=target and a.member_id=member;
    if not found then
      raise exception 'Peer assignment unavailable' using errcode='P0002';
    end if;
  elsif action<>'list' or action is null then
    raise exception 'Invalid peer assignment action' using errcode='22023';
  end if;
  return (select coalesce(jsonb_agg(jsonb_build_object(
    'id',a.id,'name',m.name,'submitted',a.submitted_at is not null,
    'revoked',a.revoked_at is not null
  ) order by a.created_at,a.id),'[]'::jsonb)
  from platform.ladders_peer_assignments a join public.members m on m.id=a.reviewer_member_id
  where a.member_id=member);
end;
$$;

create function platform.ladders_my_peer_assignments(account uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id',a.id,'member_id',m.id,'name',m.name,'role',m.role,
    'template_id',m.template_id,'submitted',a.submitted_at is not null
  ) order by a.created_at,a.id),'[]'::jsonb)
  from platform.ladders_peer_assignments a
    join public.members m on m.id=a.member_id
    join public.teams t on t.id=m.team_id
    join public.members r on r.id=a.reviewer_member_id
    join public.teams rt on rt.id=r.team_id and rt.workspace_id=t.workspace_id
    join platform.legacy_account_mappings l on l.user_id=a.reviewer_id and l.legacy_user_id=r.user_id
  where a.reviewer_id=account and a.revoked_at is null
    and r.user_id is distinct from m.user_id;
$$;

create function platform.ladders_submit_peer(account uuid, assignment uuid, content jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare target platform.ladders_peer_assignments; author text; saved uuid;
begin
  perform 1 from platform.legacy_account_mappings l where l.user_id=account for share;
  if not found then
    raise exception 'Peer assignment unavailable' using errcode='P0002';
  end if;
  select a.* into target from platform.ladders_peer_assignments a
    where a.id=assignment and a.reviewer_id=account and a.revoked_at is null;
  if not found or not exists (
    select 1 from jsonb_array_elements(platform.ladders_my_peer_assignments(account))
    where value->>'id'=assignment::text
  ) then
    raise exception 'Peer assignment unavailable' using errcode='P0002';
  end if;
  perform id from public.members where id in (target.member_id,target.reviewer_member_id)
    order by id for share;
  select a.* into target from platform.ladders_peer_assignments a
    where a.id=assignment and a.reviewer_id=account and a.revoked_at is null for update;
  if not found then
    raise exception 'Peer assignment unavailable' using errcode='P0002';
  end if;
  if target.submitted_at is not null then
    raise exception 'Peer assignment already submitted' using errcode='23514';
  end if;
  if not exists (
    select 1 from jsonb_array_elements(platform.ladders_my_peer_assignments(account))
    where value->>'id'=assignment::text
  ) then
    raise exception 'Peer assignment unavailable' using errcode='P0002';
  end if;
  if content is null or jsonb_typeof(content)<>'object'
    or public.valid_levels(content->'current_levels') is not true
    or public.valid_comments(content->'comments') is not true then
    raise exception 'Invalid evaluation content' using errcode='22023';
  end if;
  select name into author from public.members where id=target.reviewer_member_id;
  insert into public.evaluations(member_id,kind,status,author_name,current_levels,goal_levels,comments)
    values(target.member_id,'peer','draft',author,content->'current_levels','{}',content->'comments')
    returning id into saved;
  update platform.ladders_peer_assignments set submitted_at=now(),evaluation_id=saved where id=assignment;
  return jsonb_build_object('id',saved,'member_id',target.member_id,'kind','peer','status','draft',
    'author_name',author,'current_levels',content->'current_levels','goal_levels','{}'::jsonb,
    'comments',content->'comments','comment_visibility','{}'::jsonb,
    'created_at',(select created_at from public.evaluations where id=saved));
end;
$$;
revoke all on function platform.ladders_peer_management(uuid,uuid,uuid,text,uuid),
  platform.ladders_my_peer_assignments(uuid),platform.ladders_submit_peer(uuid,uuid,jsonb)
  from public,anon,authenticated,service_role;
grant execute on function platform.ladders_peer_management(uuid,uuid,uuid,text,uuid),
  platform.ladders_my_peer_assignments(uuid),platform.ladders_submit_peer(uuid,uuid,jsonb) to platform_api;
