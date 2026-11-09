create table platform.planner_priority_proposals (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id),
  name text not null check (length(btrim(name)) between 1 and 120),
  created_by uuid not null references platform.users(id),
  created_at timestamptz not null default now(),
  source jsonb not null
);
create index on platform.planner_priority_proposals(workspace_id,created_at desc,id);
revoke all on platform.planner_priority_proposals from public,platform_api;

create function platform.planner_preview(account uuid, workspace uuid, feature_ids uuid[], expected_revision text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  if expected_revision is null then
    raise exception 'Reload the roadmap before proposing priorities' using errcode='23514';
  end if;
  return public.planner_proposal_source(
    platform.planner_source(account,workspace),feature_ids,expected_revision);
end;
$$;

create function platform.planner_save_proposal(account uuid, workspace uuid, proposal_name text, feature_ids uuid[], expected_revision text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare source jsonb; result uuid;
begin
  -- Check the workspace grant before validating names or accessing snapshots.
  perform platform.planner_source(account,workspace);
  if proposal_name is null or length(btrim(proposal_name)) not between 1 and 120 then
    raise exception 'Proposal names need between 1 and 120 characters' using errcode='22023';
  end if;
  perform id from public.workspaces where id=workspace for update;
  source := platform.planner_preview(account,workspace,feature_ids,expected_revision);
  insert into platform.planner_priority_proposals(workspace_id,name,created_by,source)
    values(workspace,btrim(proposal_name),account,source) returning id into result;
  return result;
end;
$$;

create function platform.planner_proposals(account uuid, workspace uuid)
returns table(id uuid,name text,created_at timestamptz)
language plpgsql stable security definer set search_path = '' as $$
begin
  perform platform.planner_source(account,workspace);
  return query select p.id,p.name,p.created_at
    from platform.planner_priority_proposals p
    where p.workspace_id=workspace order by p.created_at desc,p.id;
end;
$$;

create function platform.planner_saved_proposal(account uuid, workspace uuid, proposal uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare source jsonb;
begin
  perform platform.planner_source(account,workspace);
  select p.source into source from platform.planner_priority_proposals p
    where p.workspace_id=workspace and p.id=proposal;
  if source is null then
    raise exception 'Priority proposal unavailable' using errcode='P0002';
  end if;
  return source;
end;
$$;

revoke all on function platform.planner_preview(uuid,uuid,uuid[],text) from public,anon,authenticated,service_role;
revoke all on function platform.planner_save_proposal(uuid,uuid,text,uuid[],text) from public,anon,authenticated,service_role;
revoke all on function platform.planner_proposals(uuid,uuid) from public,anon,authenticated,service_role;
revoke all on function platform.planner_saved_proposal(uuid,uuid,uuid) from public,anon,authenticated,service_role;
grant execute on function platform.planner_preview(uuid,uuid,uuid[],text) to platform_api;
grant execute on function platform.planner_save_proposal(uuid,uuid,text,uuid[],text) to platform_api;
grant execute on function platform.planner_proposals(uuid,uuid) to platform_api;
grant execute on function platform.planner_saved_proposal(uuid,uuid,uuid) to platform_api;
