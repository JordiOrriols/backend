create table platform.shiplog_release_decisions (
  release_id uuid not null references public.shiplog_releases(id) on delete cascade,
  user_id uuid not null references platform.users(id),
  approved boolean not null,
  decided_at timestamptz not null default now(),
  primary key(release_id,user_id)
);
revoke all on platform.shiplog_release_decisions from public,anon,authenticated,service_role,platform_api;

create function platform.shiplog_decisions(account uuid, workspace uuid, release uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  perform platform.shiplog_require_internal(account,workspace);
  if not exists(select 1 from public.shiplog_releases r where r.id=release and r.workspace_id=workspace) then
    raise exception 'Release unavailable in this workspace' using errcode='P0002';
  end if;
  return jsonb_build_object('account_id',account,'decisions',coalesce((
    select jsonb_agg(jsonb_build_object('user_id',u.id,
      'name',split_part(u.email,'@',1),'approved',d.approved,'decided_at',d.decided_at)
      order by lower(split_part(u.email,'@',1)),u.id)
    from platform.grants g join platform.users u on u.id=g.user_id
    left join platform.shiplog_release_decisions d on d.user_id=u.id and d.release_id=release
    where g.app='shiplog' and g.workspace_id=workspace and g.role in ('owner','editor','viewer')
  ),'[]'::jsonb));
end;
$$;
create function platform.shiplog_decide_release(account uuid, workspace uuid, release uuid, approved boolean)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare previous platform.shiplog_release_decisions;
begin
  perform 1 from platform.grants g where g.user_id=account and g.app='shiplog'
    and g.workspace_id=workspace and g.role in ('owner','editor','viewer') for share;
  if not found then raise exception 'Internal Shiplog access required' using errcode='42501'; end if;
  perform id from public.workspaces where id=workspace for update;
  perform id from public.shiplog_releases r where r.id=release and r.workspace_id=workspace for update;
  if not found then raise exception 'Release unavailable in this workspace' using errcode='P0002'; end if;
  if approved is null then raise exception 'Approval decision required' using errcode='22023'; end if;
  select * into previous from platform.shiplog_release_decisions d where d.release_id=release and d.user_id=account;
  insert into platform.shiplog_release_decisions(release_id,user_id,approved)
    values(release,account,approved) on conflict(release_id,user_id)
    do update set approved=excluded.approved,decided_at=now();
  insert into platform.shiplog_audit_events(workspace_id,actor_id,event,details)
    values(workspace,account,'release.decision',jsonb_build_object('release_id',release,
      'approved',approved,'before',to_jsonb(previous)));
  return platform.shiplog_decisions(account,workspace,release);
end;
$$;
revoke all on function platform.shiplog_decisions(uuid,uuid,uuid),
  platform.shiplog_decide_release(uuid,uuid,uuid,boolean) from public,anon,authenticated,service_role;
grant execute on function platform.shiplog_decisions(uuid,uuid,uuid),
  platform.shiplog_decide_release(uuid,uuid,uuid,boolean) to platform_api;
