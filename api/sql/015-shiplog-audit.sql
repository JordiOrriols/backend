create index on platform.shiplog_audit_events(workspace_id,created_at desc,id desc);
create index on public.shiplog_audit_events(workspace_id,created_at desc,id desc);

create function platform.shiplog_audit(account uuid, workspace uuid, cursor_source text, cursor_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare boundary_time timestamptz; entries jsonb; next_cursor text;
begin
  perform platform.shiplog_require_internal(account,workspace);
  if (cursor_source is null) <> (cursor_id is null)
    or (cursor_source is not null and cursor_source not in ('platform','legacy')) then
    raise exception 'Invalid audit cursor' using errcode='22023';
  end if;
  if cursor_id is not null then
    if cursor_source='platform' then
      select e.created_at into boundary_time from platform.shiplog_audit_events e where e.id=cursor_id and e.workspace_id=workspace;
    else
      select e.created_at into boundary_time from public.shiplog_audit_events e where e.id=cursor_id and e.workspace_id=workspace;
    end if;
    if not found then raise exception 'Audit cursor unavailable in this workspace' using errcode='P0002'; end if;
  end if;
  with history as (
    select e.id,'platform'::text as source,e.created_at,e.event,e.actor_id,
      split_part(u.email,'@',1) as actor_name,e.details
    from platform.shiplog_audit_events e join platform.users u on u.id=e.actor_id where e.workspace_id=workspace
    union all
    select e.id,'legacy'::text,e.created_at,e.event,e.actor_id,null::text,e.details
    from public.shiplog_audit_events e where e.workspace_id=workspace
  ), page as (
    select * from history h where cursor_id is null
      or (h.created_at,h.source collate "C",h.id)<(boundary_time,cursor_source collate "C",cursor_id)
    order by h.created_at desc,h.source collate "C" desc,h.id desc limit 51
  )
  select coalesce(jsonb_agg(to_jsonb(p) order by p.created_at desc,p.source collate "C" desc,p.id desc),'[]'::jsonb)
    into entries from page p;
  if jsonb_array_length(entries)>50 then
    next_cursor := (entries->49->>'source') || ':' || (entries->49->>'id');
    entries := entries - 50;
  end if;
  return jsonb_build_object('events',entries,'next_cursor',next_cursor);
end;
$$;
revoke all on function platform.shiplog_audit(uuid,uuid,text,uuid) from public,anon,authenticated,service_role;
grant execute on function platform.shiplog_audit(uuid,uuid,text,uuid) to platform_api;
