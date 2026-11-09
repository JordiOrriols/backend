create table platform.ladders_member_links (
  member_id uuid primary key references public.members(id) on delete cascade,
  user_id uuid not null references platform.users(id),
  created_at timestamptz not null default now()
);
create table platform.ladders_member_invitations (
  id uuid primary key default gen_random_uuid(),
  member_id uuid not null unique references public.members(id) on delete cascade,
  recipient_id uuid not null references platform.users(id),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '30 days'
);
revoke all on platform.ladders_member_links,platform.ladders_member_invitations
  from public,anon,authenticated,service_role,platform_api;

create function platform.ladders_member_account(member uuid)
returns uuid language sql stable security definer set search_path = '' as $$
  select case when m.user_id is not null then
    (select l.user_id from platform.legacy_account_mappings l where l.legacy_user_id=m.user_id)
    else (select l.user_id from platform.ladders_member_links l where l.member_id=m.id) end
  from public.members m where m.id=member;
$$;

create or replace function platform.ladders_my_members(account uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id',m.id,'name',m.name,'role',m.role,'planning_role',m.planning_role,
    'template_id',m.template_id,'workspace_id',w.id,'workspace_name',w.name
  ) order by w.name,m.name,m.id),'[]'::jsonb)
  from public.members m join public.teams t on t.id=m.team_id
    join public.workspaces w on w.id=t.workspace_id
  where platform.ladders_member_account(m.id)=account;
$$;

create or replace function platform.ladders_lock_my_member(account uuid, member uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform 1 from platform.legacy_account_mappings l where l.user_id=account for share;
  perform m.id from public.members m where m.id=member for update;
  if not found or platform.ladders_member_account(member) is distinct from account then
    raise exception 'Member unavailable for this account' using errcode='P0002';
  end if;
end;
$$;

create function platform.ladders_member_invitation_management(
  account uuid, workspace uuid, member uuid, action text, recipient uuid
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare target public.members;
begin
  perform 1 from platform.grants g where g.user_id=account and g.app='ladders'
    and g.workspace_id=workspace and g.role in ('owner','editor') for share;
  if not found then
    raise exception 'Internal Ladders edit access required' using errcode='42501';
  end if;
  perform id from public.workspaces where id=workspace for update;
  select m.* into target from public.members m join public.teams t on t.id=m.team_id
    where m.id=member and t.workspace_id=workspace for update of m;
  if not found then
    raise exception 'Member unavailable in this workspace' using errcode='P0002';
  end if;
  if action='invite' then
    if target.user_id is not null or exists (
      select 1 from platform.ladders_member_links l where l.member_id=member
    ) then
      raise exception 'This member is already linked to an account' using errcode='23514';
    end if;
    if recipient is null or not exists (select 1 from platform.identities i where i.user_id=recipient) then
      raise exception 'Recipient must first authenticate' using errcode='22023';
    end if;
    insert into platform.ladders_member_invitations(member_id,recipient_id) values(member,recipient)
      on conflict (member_id) do update set id=gen_random_uuid(),recipient_id=excluded.recipient_id,
        created_at=now(),expires_at=now()+interval '30 days';
    delete from public.member_invites where member_id=member;
  elsif action='revoke' then
    delete from platform.ladders_member_invitations i where i.member_id=member;
  elsif action='unlink' then
    delete from platform.ladders_member_links l where l.member_id=member;
    update public.members set user_id=null where id=member;
    delete from platform.ladders_member_invitations i where i.member_id=member;
    update platform.ladders_peer_assignments set revoked_at=coalesce(revoked_at,now())
      where reviewer_member_id=member;
    delete from public.member_invites where member_id=member;
  elsif action<>'get' or action is null then
    raise exception 'Invalid member invitation action' using errcode='22023';
  end if;
  return jsonb_build_object(
    'linked',target.user_id is not null and action<>'unlink' or exists (
      select 1 from platform.ladders_member_links l where l.member_id=member
    ),
    'invited',exists (select 1 from platform.ladders_member_invitations i
      where i.member_id=member and i.expires_at>now())
  );
end;
$$;

create function platform.ladders_my_member_invitations(account uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id',i.id,'member_id',m.id,'name',m.name,'workspace_name',w.name,'expires_at',i.expires_at
  ) order by i.created_at,i.id),'[]'::jsonb)
  from platform.ladders_member_invitations i join public.members m on m.id=i.member_id
    join public.teams t on t.id=m.team_id join public.workspaces w on w.id=t.workspace_id
  where i.recipient_id=account and i.expires_at>now() and m.user_id is null
    and not exists (select 1 from platform.ladders_member_links l where l.member_id=m.id);
$$;

create function platform.ladders_answer_member_invitation(account uuid, invitation uuid, accept boolean)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare target platform.ladders_member_invitations; team uuid;
begin
  perform id from platform.users where id=account for update;
  select i.* into target from platform.ladders_member_invitations i
    where i.id=invitation and i.recipient_id=account and i.expires_at>now();
  if not found then
    raise exception 'Member invitation unavailable' using errcode='P0002';
  end if;
  perform w.id from public.workspaces w join public.teams t on t.workspace_id=w.id
    join public.members m on m.team_id=t.id where m.id=target.member_id for update of w;
  select m.team_id into team from public.members m where m.id=target.member_id for update;
  perform 1 from platform.ladders_member_invitations i
    where i.id=invitation and i.recipient_id=account and i.expires_at>now() for update;
  if not found then
    raise exception 'Member invitation unavailable' using errcode='P0002';
  end if;
  if accept is null then
    raise exception 'Choose accept or decline' using errcode='22023';
  end if;
  if accept then
    if exists (select 1 from public.members m where m.id=target.member_id and m.user_id is not null)
      or exists (select 1 from platform.ladders_member_links l where l.member_id=target.member_id) then
      raise exception 'This member is already linked to an account' using errcode='23514';
    end if;
    if exists (select 1 from public.members m where m.team_id=team
      and platform.ladders_member_account(m.id)=account) then
      raise exception 'Your account is already linked to a member of this team' using errcode='23514';
    end if;
    insert into platform.ladders_member_links(member_id,user_id) values(target.member_id,account);
  end if;
  delete from platform.ladders_member_invitations where id=invitation;
  return jsonb_build_object('member_id',target.member_id,'accepted',accept);
end;
$$;

create function platform.ladders_direct_link_before_member_update()
returns trigger language plpgsql security definer set search_path = '' as $$
declare account uuid; direct_account uuid;
begin
  select l.user_id into direct_account from platform.ladders_member_links l where l.member_id=old.id;
  if direct_account is not null and new.user_id is not null then
      raise exception 'Unlink the platform member before legacy linking' using errcode='23514';
  end if;
  account:=coalesce(direct_account,
    (select l.user_id from platform.legacy_account_mappings l where l.legacy_user_id=new.user_id));
  if account is not null and (new.team_id is distinct from old.team_id or new.user_id is distinct from old.user_id) then
    if exists (
      select 1 from public.members m where m.team_id=new.team_id and m.id<>old.id
        and platform.ladders_member_account(m.id)=account
    ) then
      raise exception 'Account already linked in the destination team' using errcode='23514';
    end if;
  end if;
  return new;
end;
$$;
create trigger ladders_direct_link_before_member_update before update on public.members
  for each row execute function platform.ladders_direct_link_before_member_update();

create function platform.ladders_mapping_before_link()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  perform id from platform.users where id=new.user_id for update;
  perform w.id from public.workspaces w where exists (
    select 1 from public.teams t join public.members m on m.team_id=t.id
      where t.workspace_id=w.id and m.user_id=new.legacy_user_id
  ) order by w.id for update;
  if exists (
    select 1 from public.members m join public.members other on other.team_id=m.team_id and other.id<>m.id
    join platform.ladders_member_links l on l.member_id=other.id and l.user_id=new.user_id
    where m.user_id=new.legacy_user_id
  ) then
    raise exception 'Account already linked in a legacy member team' using errcode='23514';
  end if;
  return new;
end;
$$;
create trigger ladders_mapping_before_link before insert or update on platform.legacy_account_mappings
  for each row execute function platform.ladders_mapping_before_link();

create or replace function platform.ladders_my_peer_assignments(account uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id',a.id,'member_id',m.id,'name',m.name,'role',m.role,
    'template_id',m.template_id,'submitted',a.submitted_at is not null
  ) order by a.created_at,a.id),'[]'::jsonb)
  from platform.ladders_peer_assignments a
    join public.members m on m.id=a.member_id join public.teams t on t.id=m.team_id
    join public.members r on r.id=a.reviewer_member_id
    join public.teams rt on rt.id=r.team_id and rt.workspace_id=t.workspace_id
  where a.reviewer_id=account and a.revoked_at is null
    and platform.ladders_member_account(r.id)=account
    and platform.ladders_member_account(m.id) is distinct from account;
$$;

create or replace function platform.ladders_peer_management(
  account uuid, workspace uuid, member uuid, action text, target uuid
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare reviewer uuid; subject uuid;
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
  subject:=platform.ladders_member_account(member);
  if action='candidates' then
    return (select coalesce(jsonb_agg(jsonb_build_object('id',m.id,'name',m.name)
      order by m.name,m.id),'[]'::jsonb)
      from public.members m join public.teams t on t.id=m.team_id
      where t.workspace_id=workspace and m.id<>member
        and platform.ladders_member_account(m.id) is not null
        and platform.ladders_member_account(m.id) is distinct from subject);
  elsif action='assign' then
    perform m.id from public.members m join public.teams t on t.id=m.team_id
      where m.id=target and t.workspace_id=workspace and m.id<>member for share of m;
    reviewer:=platform.ladders_member_account(target);
    if not found or reviewer is null or reviewer is not distinct from subject then
      raise exception 'Reviewer unavailable in this workspace' using errcode='P0002';
    end if;
    if exists (select 1 from platform.ladders_peer_assignments a where a.member_id=member
      and a.reviewer_id=reviewer and a.submitted_at is null and a.revoked_at is null) then
      raise exception 'A peer assignment is already pending' using errcode='23514';
    end if;
    insert into platform.ladders_peer_assignments(member_id,reviewer_member_id,reviewer_id)
      values(member,target,reviewer);
  elsif action='revoke' then
    update platform.ladders_peer_assignments a set revoked_at=coalesce(a.revoked_at,now())
      where a.id=target and a.member_id=member;
    if not found then raise exception 'Peer assignment unavailable' using errcode='P0002'; end if;
  elsif action<>'list' or action is null then
    raise exception 'Invalid peer assignment action' using errcode='22023';
  end if;
  return (select coalesce(jsonb_agg(jsonb_build_object(
    'id',a.id,'name',m.name,'submitted',a.submitted_at is not null,'revoked',a.revoked_at is not null
  ) order by a.created_at,a.id),'[]'::jsonb)
  from platform.ladders_peer_assignments a join public.members m on m.id=a.reviewer_member_id
  where a.member_id=member);
end;
$$;

create or replace function platform.ladders_submit_peer(account uuid, assignment uuid, content jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare target platform.ladders_peer_assignments; author text; saved uuid;
begin
  perform 1 from platform.legacy_account_mappings l where l.user_id=account for share;
  select a.* into target from platform.ladders_peer_assignments a
    where a.id=assignment and a.reviewer_id=account and a.revoked_at is null;
  if not found then raise exception 'Peer assignment unavailable' using errcode='P0002'; end if;
  perform id from public.members where id in (target.member_id,target.reviewer_member_id)
    order by id for share;
  select a.* into target from platform.ladders_peer_assignments a
    where a.id=assignment and a.reviewer_id=account and a.revoked_at is null for update;
  if not found or not exists (
    select 1 from jsonb_array_elements(platform.ladders_my_peer_assignments(account))
    where value->>'id'=assignment::text
  ) then raise exception 'Peer assignment unavailable' using errcode='P0002'; end if;
  if target.submitted_at is not null then
    raise exception 'Peer assignment already submitted' using errcode='23514';
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

revoke all on function platform.ladders_member_account(uuid),
  platform.ladders_direct_link_before_member_update(),
  platform.ladders_mapping_before_link(),
  platform.ladders_member_invitation_management(uuid,uuid,uuid,text,uuid),
  platform.ladders_my_member_invitations(uuid),
  platform.ladders_answer_member_invitation(uuid,uuid,boolean)
  from public,anon,authenticated,service_role,platform_api;
grant execute on function platform.ladders_member_invitation_management(uuid,uuid,uuid,text,uuid),
  platform.ladders_my_member_invitations(uuid),
  platform.ladders_answer_member_invitation(uuid,uuid,boolean) to platform_api;
