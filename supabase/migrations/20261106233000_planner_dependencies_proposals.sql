alter table public.features add column dependency_ids uuid[] not null default '{}';

create function public.planner_check_dependencies(workspace uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare invalid_name text; prerequisite text;
begin
  select f.name into invalid_name from public.features f
    join public.projects p on p.id = f.project_id
    where p.workspace_id = workspace and (
      cardinality(f.dependency_ids) <> (select count(distinct id) from unnest(f.dependency_ids) d(id))
      or exists (select 1 from unnest(f.dependency_ids) d(id)
        left join public.features parent on parent.id = d.id
        left join public.projects pp on pp.id = parent.project_id
        where d.id is null or d.id = f.id or parent.id is null or pp.workspace_id <> workspace)
    ) limit 1;
  if found then raise exception 'Invalid dependencies for "%": choose other features in this workspace', invalid_name using errcode = '23514'; end if;
  if exists (
    with recursive paths(origin, node) as (
      select f.id, d.id
      from public.features f join public.projects p on p.id = f.project_id
      cross join lateral unnest(f.dependency_ids) d(id) where p.workspace_id = workspace
      union
      select paths.origin, d.id
      from paths join public.features f on f.id = paths.node
      cross join lateral unnest(f.dependency_ids) d(id)
    ) select 1 from paths where origin = node
  ) then raise exception 'Feature dependencies cannot contain a cycle' using errcode = '23514'; end if;
  select f.name, parent.name into invalid_name, prerequisite
    from public.features f join public.projects p on p.id = f.project_id
    cross join lateral unnest(f.dependency_ids) d(id)
    join public.features parent on parent.id = d.id
    where p.workspace_id = workspace and f.in_backlog and (
      not parent.in_backlog or (parent.priority, parent.id) >= (f.priority, f.id)
    ) limit 1;
  if found then raise exception '"%" must come after its dependency "%" on the roadmap', invalid_name, prerequisite using errcode = '23514'; end if;
end;
$$;
revoke all on function public.planner_check_dependencies(uuid) from public, anon, authenticated;

create function public.planner_lock_dependencies()
returns trigger language plpgsql security definer set search_path = '' as $$
declare workspace uuid;
begin
  for workspace in select distinct p.workspace_id from public.projects p
    where p.id in (case when tg_op <> 'INSERT' then old.project_id end,
                   case when tg_op <> 'DELETE' then new.project_id end) order by p.workspace_id
  loop
    perform id from public.workspaces where id = workspace for update;
  end loop;
  if tg_op = 'DELETE' then return old; else return new; end if;
end;
$$;
create trigger planner_lock_dependencies before insert or update or delete on public.features
  for each row execute function public.planner_lock_dependencies();

create function public.planner_dependencies_constraint()
returns trigger language plpgsql security definer set search_path = '' as $$
declare workspace uuid;
begin
  for workspace in select distinct p.workspace_id from public.projects p
    where p.id in (case when tg_op <> 'INSERT' then old.project_id end,
                   case when tg_op <> 'DELETE' then new.project_id end)
      or p.id in (select f.project_id from public.features f
        where tg_op <> 'INSERT' and f.dependency_ids @> array[old.id])
  loop
    perform public.planner_check_dependencies(workspace);
  end loop;
  return null;
end;
$$;
create constraint trigger planner_dependencies_constraint after insert or update or delete
  on public.features deferrable initially deferred
  for each row execute function public.planner_dependencies_constraint();

-- Projects cannot move their features/dependencies into another workspace via REST.
create function public.planner_project_identity()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.workspace_id is distinct from old.workspace_id then
    raise exception 'Projects cannot move to another workspace' using errcode = '23514';
  end if;
  return new;
end;
$$;
create trigger planner_project_identity before update on public.projects
  for each row execute function public.planner_project_identity();

alter function public.planner_roadmap_source(uuid) rename to planner_roadmap_source_without_dependencies;
revoke all on function public.planner_roadmap_source_without_dependencies(uuid) from public, anon, authenticated, service_role;
create function public.planner_roadmap_source(token uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare source jsonb;
begin
  source := public.planner_roadmap_source_without_dependencies(token);
  source := jsonb_set(source, '{features}', coalesce((
    select jsonb_agg(item || jsonb_build_object('dependency_ids', f.dependency_ids)
      order by f.priority, f.id)
    from jsonb_array_elements(source->'features') item
    join public.features f on f.id = (item->>'id')::uuid
  ), '[]'::jsonb));
  return source || jsonb_build_object('revision', md5(source::text));
end;
$$;
revoke all on function public.planner_roadmap_source(uuid) from public, anon, authenticated;
grant execute on function public.planner_roadmap_source(uuid) to service_role;

create function public.planner_proposal_source(source jsonb, feature_ids uuid[], expected_revision text default null)
returns jsonb language plpgsql immutable set search_path = '' as $$
declare current_ids uuid[]; locked_until integer; item record; dependency uuid;
begin
  if expected_revision is not null and expected_revision is distinct from source->>'revision'
    then raise exception 'Roadmap changed. Refresh before proposing priorities.' using errcode = '23514'; end if;
  select array_agg((f->>'id')::uuid order by (f->>'priority')::integer, (f->>'id')::uuid)
    into current_ids from jsonb_array_elements(source->'features') f;
  current_ids := coalesce(current_ids, '{}');
  if feature_ids is null or cardinality(feature_ids) <> cardinality(current_ids)
    or cardinality(feature_ids) <> (select count(distinct id) from unnest(feature_ids) d(id))
    or not feature_ids @> current_ids
  then raise exception 'Roadmap changed. Refresh before proposing priorities.' using errcode = '23514'; end if;
  select coalesce(max(array_position(current_ids, (f->>'id')::uuid)), 0) into locked_until
    from jsonb_array_elements(source->'features') f where f->>'status' in ('done', 'in_progress');
  if feature_ids[1:locked_until] is distinct from current_ids[1:locked_until] then
    raise exception 'Only pending or paused features after completed/in-progress work can move' using errcode = '23514';
  end if;
  for item in select f from jsonb_array_elements(source->'features') f loop
    for dependency in select value::uuid from jsonb_array_elements_text(item.f->'dependency_ids') loop
      if array_position(feature_ids, dependency) is null or
        array_position(feature_ids, dependency) >= array_position(feature_ids, (item.f->>'id')::uuid)
      then raise exception '"%" must come after its dependency', item.f->>'name' using errcode = '23514'; end if;
    end loop;
  end loop;
  return jsonb_set(source, '{features}', coalesce((
    select jsonb_agg(f || jsonb_build_object('priority', ordered.position) order by ordered.position)
    from unnest(feature_ids) with ordinality ordered(id, position)
    join jsonb_array_elements(source->'features') f on (f->>'id')::uuid = ordered.id
  ), '[]'::jsonb));
end;
$$;
revoke all on function public.planner_proposal_source(jsonb, uuid[], text) from public, anon, authenticated;
grant execute on function public.planner_proposal_source(jsonb, uuid[], text) to service_role;

create table public.planner_priority_proposals (
  id uuid primary key default gen_random_uuid(),
  share_token uuid not null references public.roadmap_shares(token) on delete cascade,
  name text not null check (length(btrim(name)) between 1 and 120),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  source jsonb not null
);
create index on public.planner_priority_proposals(share_token, created_at desc, id);
alter table public.planner_priority_proposals enable row level security;
revoke all on public.planner_priority_proposals from anon, authenticated;

create function public.planner_save_priority_proposal(token uuid, proposal_name text, feature_ids uuid[], expected_revision text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare workspace uuid; source jsonb; result uuid;
begin
  if not exists(select 1 from auth.users where id = auth.uid() and email_confirmed_at is not null)
    then raise exception 'Sign in with a verified email to save a proposal' using errcode = '42501'; end if;
  if proposal_name is null or length(btrim(proposal_name)) not between 1 and 120
    then raise exception 'Proposal names need between 1 and 120 characters' using errcode = '22023'; end if;
  select workspace_id into workspace from public.roadmap_shares where roadmap_shares.token = $1 for update;
  if workspace is null then raise exception 'Roadmap link unavailable' using errcode = 'P0002'; end if;
  perform id from public.workspaces where id = workspace for update;
  if expected_revision is null then raise exception 'Reload the roadmap before saving a proposal' using errcode = '23514'; end if;
  source := public.planner_proposal_source(public.planner_roadmap_source(token), feature_ids, expected_revision);
  insert into public.planner_priority_proposals(share_token, name, created_by, source)
    values(token, btrim(proposal_name), auth.uid(), source) returning id into result;
  return result;
end;
$$;
revoke all on function public.planner_save_priority_proposal(uuid, text, uuid[], text) from public, anon;
grant execute on function public.planner_save_priority_proposal(uuid, text, uuid[], text) to authenticated;

create function public.planner_list_priority_proposals(token uuid)
returns table(id uuid, name text, created_at timestamptz)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not exists(select 1 from public.roadmap_shares s where s.token = $1)
    then raise exception 'Roadmap link unavailable' using errcode = 'P0002'; end if;
  return query select p.id, p.name, p.created_at from public.planner_priority_proposals p
    where p.share_token = token order by p.created_at desc, p.id;
end;
$$;
revoke all on function public.planner_list_priority_proposals(uuid) from public;
grant execute on function public.planner_list_priority_proposals(uuid) to anon, authenticated;

create function public.planner_saved_proposal_source(token uuid, proposal uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare source jsonb;
begin
  select p.source into source from public.planner_priority_proposals p
    join public.roadmap_shares s on s.token = p.share_token
    where p.share_token = $1 and p.id = $2;
  if source is null then raise exception 'Priority proposal unavailable' using errcode = 'P0002'; end if;
  return source;
end;
$$;
revoke all on function public.planner_saved_proposal_source(uuid, uuid) from public, anon, authenticated;
grant execute on function public.planner_saved_proposal_source(uuid, uuid) to service_role;

-- A saved proposal is Planner content, not a disposable workspace setting.
alter function public.workspace_empty(uuid) rename to workspace_empty_without_proposals;
revoke all on function public.workspace_empty_without_proposals(uuid) from public, anon, authenticated;
create function public.workspace_empty(workspace uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select public.workspace_empty_without_proposals(workspace) and not exists (
    select 1 from public.planner_priority_proposals p join public.roadmap_shares s on s.token = p.share_token
    where s.workspace_id = workspace
  );
$$;
revoke all on function public.workspace_empty(uuid) from public, anon, authenticated;
