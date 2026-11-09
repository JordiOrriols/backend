create table platform.shiplog_checklist_completions (
  item_id uuid primary key references public.shiplog_checklist_items(id) on delete cascade,
  completed boolean not null,
  actor_id uuid not null references platform.users(id),
  completed_at timestamptz,
  check (completed = (completed_at is not null))
);
revoke all on platform.shiplog_checklist_completions from public,anon,authenticated,service_role,platform_api;

create function platform.shiplog_checklist_template(account uuid, workspace uuid, application uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  perform platform.shiplog_require_internal(account,workspace);
  if not exists(select 1 from public.shiplog_applications a where a.id=application and a.workspace_id=workspace) then
    raise exception 'Application unavailable in this workspace' using errcode='P0002';
  end if;
  return coalesce((select jsonb_build_object('revision',t.revision,'items',t.items)
    from public.shiplog_checklist_templates t where t.application_id=application),
    jsonb_build_object('revision',0,'items','[]'::jsonb));
end;
$$;
create function platform.shiplog_save_checklist_template(account uuid, workspace uuid, application uuid, input jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare current_revision integer; item jsonb;
begin
  perform 1 from platform.grants g where g.user_id=account and g.app='shiplog'
    and g.workspace_id=workspace and g.role='owner' for share;
  if not found then raise exception 'Workspace owner access required' using errcode='42501'; end if;
  perform id from public.workspaces where id=workspace for update;
  perform id from public.shiplog_applications a where a.id=application and a.workspace_id=workspace for update;
  if not found then raise exception 'Application unavailable in this workspace' using errcode='P0002'; end if;
  current_revision := coalesce((select t.revision from public.shiplog_checklist_templates t where t.application_id=application),0);
  if (input->>'revision')::integer is distinct from current_revision then
    raise exception 'Checklist template changed. Reload before saving.' using errcode='23514';
  end if;
  if jsonb_typeof(input->'items') is distinct from 'array' then
    raise exception 'Checklist items must be an array' using errcode='22023';
  end if;
  if jsonb_array_length(input->'items')>100 then
    raise exception 'At most 100 checklist items are allowed' using errcode='22023';
  end if;
  for item in select value from jsonb_array_elements(input->'items') loop
    if jsonb_typeof(item->'title') is distinct from 'string' or length(trim(item->>'title')) not between 1 and 160
      or jsonb_typeof(item->'category') is distinct from 'string' or length(trim(item->>'category')) not between 1 and 80
      or jsonb_typeof(item->'description') is distinct from 'string' or length(item->>'description')>4000
      or jsonb_typeof(item->'mandatory') is distinct from 'boolean' then
      raise exception 'Invalid checklist item' using errcode='22023';
    end if;
  end loop;
  insert into public.shiplog_checklist_templates(application_id,revision,items)
    values(application,current_revision+1,input->'items')
    on conflict(application_id) do update set revision=excluded.revision,items=excluded.items;
  insert into platform.shiplog_audit_events(workspace_id,actor_id,event,details)
    values(workspace,account,'checklist.template_updated',jsonb_build_object('application_id',application,
      'revision',current_revision+1,'items',input->'items'));
  return platform.shiplog_checklist_template(account,workspace,application);
end;
$$;

create function platform.shiplog_readiness(account uuid, workspace uuid, release uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  perform platform.shiplog_require_internal(account,workspace);
  if not exists(select 1 from public.shiplog_releases r where r.id=release and r.workspace_id=workspace) then
    raise exception 'Release unavailable in this workspace' using errcode='P0002';
  end if;
  return (select to_jsonb(q) || jsonb_build_object('items',coalesce((
    select jsonb_agg(to_jsonb(i) || jsonb_build_object(
      'completed_by',case when c.item_id is not null then case when c.completed then c.actor_id else null end else i.completed_by end,
      'completed_at',case when c.item_id is not null then c.completed_at else i.completed_at end) order by i.position)
    from public.shiplog_checklist_items i left join platform.shiplog_checklist_completions c on c.item_id=i.id
    where i.release_id=release),'[]'::jsonb)) from public.shiplog_readiness q where q.release_id=release);
end;
$$;
create function platform.shiplog_complete_checklist_item(account uuid, workspace uuid, release uuid, item uuid, completed boolean)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare previous jsonb;
begin
  perform 1 from platform.grants g where g.user_id=account and g.app='shiplog'
    and g.workspace_id=workspace and g.role in ('owner','editor') for share;
  if not found then raise exception 'Shiplog edit access required' using errcode='42501'; end if;
  perform id from public.workspaces where id=workspace for update;
  perform id from public.shiplog_releases r where r.id=release and r.workspace_id=workspace for update;
  if not found then raise exception 'Release unavailable in this workspace' using errcode='P0002'; end if;
  perform id from public.shiplog_checklist_items i where i.id=item and i.release_id=release for update;
  if not found then raise exception 'Checklist item unavailable in this release' using errcode='P0002'; end if;
  if completed is null then raise exception 'Completion state required' using errcode='22023'; end if;
  select value into previous from jsonb_array_elements(platform.shiplog_readiness(account,workspace,release)->'items')
    where value->>'id'=item::text;
  if not completed or previous->>'completed_at' is null
    or exists(select 1 from platform.shiplog_checklist_completions c where c.item_id=item) then
  insert into platform.shiplog_checklist_completions(item_id,completed,actor_id,completed_at)
    values(item,completed,account,case when completed then now() else null end)
    on conflict(item_id) do update set completed=excluded.completed,
      actor_id=case when excluded.completed and shiplog_checklist_completions.completed then shiplog_checklist_completions.actor_id else excluded.actor_id end,
      completed_at=case when excluded.completed and shiplog_checklist_completions.completed then shiplog_checklist_completions.completed_at else excluded.completed_at end;
  end if;
  insert into platform.shiplog_audit_events(workspace_id,actor_id,event,details)
    values(workspace,account,'checklist.item_updated',jsonb_build_object('release_id',release,
      'item_id',item,'completed',completed,'before',previous));
  return platform.shiplog_readiness(account,workspace,release);
end;
$$;
revoke all on function platform.shiplog_checklist_template(uuid,uuid,uuid),
  platform.shiplog_save_checklist_template(uuid,uuid,uuid,jsonb),platform.shiplog_readiness(uuid,uuid,uuid),
  platform.shiplog_complete_checklist_item(uuid,uuid,uuid,uuid,boolean) from public,anon,authenticated,service_role;
grant execute on function platform.shiplog_checklist_template(uuid,uuid,uuid),
  platform.shiplog_save_checklist_template(uuid,uuid,uuid,jsonb),platform.shiplog_readiness(uuid,uuid,uuid),
  platform.shiplog_complete_checklist_item(uuid,uuid,uuid,uuid,boolean) to platform_api;
