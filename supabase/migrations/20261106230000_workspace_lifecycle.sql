-- Accounts choose whether to create a workspace or wait for an invitation.
drop trigger if exists create_default_team_after_signup on auth.users;

create function public.workspace_empty(workspace uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select not (
    exists (select 1 from public.members m join public.teams t on t.id = m.team_id where t.workspace_id = workspace)
    or exists (select 1 from public.features f join public.projects p on p.id = f.project_id where p.workspace_id = workspace)
    or exists (select 1 from public.pulse_surveys where workspace_id = workspace)
    or exists (select 1 from public.pulse_retros where workspace_id = workspace)
    or exists (select 1 from public.pulse_actions where workspace_id = workspace)
    or exists (select 1 from public.roadmap_markers where workspace_id = workspace)
    or exists (select 1 from public.agent_tasks where workspace_id = workspace)
    or exists (select 1 from public.shiplog_applications where workspace_id = workspace)
    or exists (select 1 from public.shiplog_audit_events where workspace_id = workspace)
  );
$$;
revoke all on function public.workspace_empty(uuid) from public, anon, authenticated;

create or replace function public.teams_before_delete()
returns trigger language plpgsql set search_path = '' as $$
begin
  if old.is_default then
    if not has_function_privilege(current_user, 'public.workspace_empty(uuid)', 'EXECUTE') then
      raise exception 'default team cannot be deleted' using errcode = '23503';
    end if;
    if not public.workspace_empty(old.workspace_id) then
      raise exception 'Workspace is not empty' using errcode = '23503';
    end if;
  end if;
  if exists (select 1 from public.members m where m.team_id = old.id) then
    raise exception 'team is not empty' using errcode = '23503';
  end if;
  return old;
end;
$$;

create or replace function public.teams_release_workspace()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  -- Explicit workspace deletion locks and removes its containers itself.
  if pg_trigger_depth() > 1 then return null; end if;
  perform id from public.workspaces where id = old.workspace_id for update;
  delete from public.workspaces w
    where w.id = old.workspace_id and w.created_for_team
      and not exists (select 1 from public.teams t where t.workspace_id = w.id)
      and not exists (select 1 from public.projects p where p.workspace_id = w.id)
      and public.workspace_empty(w.id);
  return null;
end;
$$;

create function public.delete_workspace(workspace uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare owned public.workspaces;
begin
  select * into owned from public.workspaces where id = workspace for update;
  if owned.id is null then
    raise exception 'Workspace not found' using errcode = '22023';
  end if;
  if auth.uid() is null or owned.owner_id <> auth.uid() then
    raise exception 'Only the workspace owner can delete it' using errcode = '42501';
  end if;
  -- FK row locks prevent new content being inserted while emptiness is checked.
  perform id from public.teams where workspace_id = workspace order by id for update;
  perform id from public.projects where workspace_id = workspace order by id for update;
  if not public.workspace_empty(workspace) then
    raise exception 'Workspace is not empty. Remove its content from all apps first.' using errcode = '23503';
  end if;
  update public.workspaces set created_for_team = false where id = workspace;
  delete from public.teams where workspace_id = workspace;
  delete from public.workspaces where id = workspace;
end;
$$;
revoke all on function public.delete_workspace(uuid) from public, anon;
grant execute on function public.delete_workspace(uuid) to authenticated;

-- Older clients and direct REST deletes must enforce the same content protection.
create function public.workspaces_keep_content()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if pg_trigger_depth() = 1 and not public.workspace_empty(old.id) then
    raise exception 'Workspace is not empty. Remove its content from all apps first.' using errcode = '23503';
  end if;
  return old;
end;
$$;
create trigger workspaces_keep_content before delete on public.workspaces
  for each row execute function public.workspaces_keep_content();
