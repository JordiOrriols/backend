create or replace function platform.planner_calendar(account uuid, workspace uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare editing boolean;
begin
  perform platform.planner_require_internal(account,workspace);
  select g.role in ('owner','editor') into editing from platform.grants g
    where g.user_id=account and g.app='planner' and g.workspace_id=workspace;
  return (select jsonb_build_object(
    'sprint_start_date',w.sprint_start_date,'sprint_history',w.sprint_history,
    'members',coalesce((select jsonb_agg(jsonb_build_object(
      'id',m.id,'team_id',m.team_id,'name',m.name,'role',m.planning_role,'can_edit',editing
    ) order by m.name,m.id) from public.members m join public.teams t on t.id=m.team_id
      where t.workspace_id=workspace),'[]'::jsonb),
    'teams',coalesce((select jsonb_agg(jsonb_build_object('id',t.id,'name',t.name) order by t.name,t.id)
      from public.teams t where t.workspace_id=workspace),'[]'::jsonb),
    'vacations',coalesce((select jsonb_agg(jsonb_build_object(
      'member_id',v.member_id,'date',v.date,'is_working',v.is_working) order by v.member_id,v.date
    ) from public.vacations v join public.members m on m.id=v.member_id
      join public.teams t on t.id=m.team_id where t.workspace_id=workspace),'[]'::jsonb)
  ) from public.workspaces w where w.id=workspace);
end;
$$;

create or replace function platform.planner_vacations(account uuid, workspace uuid, member uuid, start_date date, end_date date, working boolean)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  perform 1 from platform.grants g where g.user_id=account and g.app='planner'
    and g.workspace_id=workspace and g.role in ('owner','editor') for share;
  if not found then
    raise exception 'Internal Planner edit access required' using errcode='42501';
  end if;
  perform id from public.workspaces where id=workspace for update;
  if not exists(select 1 from public.members m join public.teams t on t.id=m.team_id
    where m.id=member and t.workspace_id=workspace) then
    raise exception 'Member unavailable in this workspace' using errcode='P0002';
  end if;
  if start_date is null or end_date is null or end_date<start_date or end_date-start_date>365
    or start_date<date '2026-01-01' or end_date>date '2027-12-31'
    or working is null then
    raise exception 'Choose a date range of at most 366 days' using errcode='22023';
  end if;
  -- Working restores the underlying calendar; it does not invent working weekends.
  if working then
    delete from public.vacations v where v.member_id=member
      and v.date between start_date and end_date and not v.is_working;
  else
    insert into public.vacations(member_id,date,is_working)
      select member,day::date,false from pg_catalog.generate_series(
        start_date::timestamp,end_date::timestamp,interval '1 day') day
      on conflict(member_id,date) do update set is_working=false;
  end if;
  return platform.planner_calendar(account,workspace);
end;
$$;

create or replace function platform.planner_calibration(account uuid, workspace uuid, anchor date, history jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  perform 1 from platform.grants g where g.user_id=account and g.app='planner'
    and g.workspace_id=workspace and g.role in ('owner','editor') for share;
  if not found then
    raise exception 'Internal Planner edit access required' using errcode='42501';
  end if;
  perform id from public.workspaces where id=workspace for update;
  if anchor is null or history is null or jsonb_typeof(history)<>'array' then
    raise exception 'Calibration anchor and history are required' using errcode='22023';
  end if;
  update public.workspaces set sprint_start_date=anchor,sprint_history=history where id=workspace;
  return platform.planner_calendar(account,workspace);
end;
$$;
revoke all on function platform.planner_calendar(uuid,uuid) from public,anon,authenticated,service_role;
revoke all on function platform.planner_vacations(uuid,uuid,uuid,date,date,boolean) from public,anon,authenticated,service_role;
revoke all on function platform.planner_calibration(uuid,uuid,date,jsonb) from public,anon,authenticated,service_role;
grant execute on function platform.planner_calendar(uuid,uuid) to platform_api;
grant execute on function platform.planner_vacations(uuid,uuid,uuid,date,date,boolean) to platform_api;
grant execute on function platform.planner_calibration(uuid,uuid,date,jsonb) to platform_api;
