grant update (name) on public.roadmap_markers to authenticated;

create policy roadmap_markers_rename on public.roadmap_markers
  for update to authenticated
  using (public.planner_can_edit_workspace(workspace_id))
  with check (public.planner_can_edit_workspace(workspace_id));
