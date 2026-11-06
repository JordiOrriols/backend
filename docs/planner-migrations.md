# Planner migration history

What each Planner migration changed, kept from the Planner README when the
schema moved here. Every one of them is already applied to the hosted project.

1. `20261003140000_planner_workspaces.sql`: workspace, member, project and daily
   availability tables, RLS, verified-email invitations and transactional actions.
2. `20261003150000_planner_team_and_priority.sql`: owner-controlled role editing
   and deterministic, serialized backlog insertion.
3. `20261003170000_planner_whole_estimates.sql`: reject fractional people/weeks
   on new inserts/updates, without modifying any pre-existing estimates.
4. `20261003183000_planner_ladders_teams.sql`: workspace-to-Ladders-team links,
   global member availability and anonymous, member-scoped vacation RPCs.
   Adds nullable `members.planning_role` and immutable `members.vacation_token`.
5. `20261014223000_planner_vacation_team_calendar.sql`: read-only, token-scoped
   current-team names and vacations. Save/reset capabilities remain member-only.
6. `20261014224000_planner_project_delivery.sql`: persistent project delivery
   status, protected by the existing owner-only project write policy.
7. `20261014225000_planner_workspace_plan_start.sql`: saved workspace plan start
   date, protected by existing owner-only workspace update permissions.
8. `20261014230000_planner_workspace_sharing.sql`: owner-managed registered-account
   View/Edit shares, editor project/start-date permissions and immutable workspace
   identity. Supersedes owner-only project/start-date writes without changing
   linked-team editing permissions.
9. `20261016092000_planner_restore_working_calendar.sql`: changes Working Day
   saves to remove vacations while preserving the default calendar. Applied with approval.
10. `20261016110000_planner_sprint_calibration.sql`: sprint start and delivered
    story points per sprint for the squad velocity forecast.
11. `20261016130000_planner_main_projects.sql`: main projects that group features.
12. `20261016170000_planner_drop_legacy_members.sql`: drops the unused
    `planner_members` and `planner_availability` tables.
13. `20261016180000_shared_workspaces.sql`: shared `workspaces` table; every team
    lives in exactly one workspace (`teams.workspace_id`).
14. `20261016190000_planner_rename_features_projects_vacations.sql`: renames
    `planner_projects` → `features`, `planner_main_projects` → `projects` and
    `planner_team_availability` → `vacations`.
15. `20261016200000_planner_teams_live_in_workspaces.sql`: choosing a team moves it
    into the workspace; drops `planner_workspace_teams`.
16. `20261016210000_planner_settings_live_on_workspaces.sql`: plan and sprint
    settings move onto `workspaces` and `planner_workspaces` is dropped. Deleting a
    workspace moves its teams into workspaces of their own.
17. `20261016220000_workspace_collaborators.sql`: one `workspace_collaborators`
    table shares a workspace per app (Ladders, Planner, Pulse) as viewer or editor,
    through `share_workspace`, `update_workspace_share`, `remove_workspace_share`
    and `list_workspace_shares`. Planner shares move there and
    `planner_workspace_collaborators` is dropped.
18. `20261016230000_ladders_shares_live_on_workspaces.sql`: Ladders team shares
    move onto `workspace_collaborators` (app `ladders`), so sharing a team shares
    every team in its workspace. The team share RPCs keep their signatures and
    `team_collaborators` is dropped.
19. `20261017000000_list_and_create_workspaces.sql`: `list_workspaces(app_name)`
    and `create_workspace(workspace_name)` let every app list and create
    workspaces the same way. Planner also lists, read-only, the workspaces of the
    Ladders teams the account can view.
20. `20261017010000_teams_stay_in_their_workspace.sql`: teams cannot move to
    another workspace, a workspace that still holds teams cannot be deleted,
    `planner_set_workspace_teams` is dropped and `create_team(p_name, p_workspace)`
    adds a team to a workspace of its owner.
21. `20261017020000_features_belong_to_a_project.sql`: every feature belongs to
    a project. Project-less features move into a **General** project of their
    workspace, `features.workspace_id` is dropped, feature access and the roadmap
    RPCs go through the project, and a project with features cannot be deleted
    (deleting the workspace still removes everything).
22. `20261019190000_public_roadmap.sql`: token-gated public roadmap links.
23. `20261020090000_feature_status.sql`: `features.status` (pending, in_progress,
    done, paused), backfilled from `delivered`. A trigger keeps the legacy
    `delivered` flag equal to `status = 'done'` so already deployed clients keep
    working; drop `delivered` once every client reads `status`.

The fourth migration deliberately extends Ladders members; it does not alter
job titles, existing evaluation tokens or evaluations. Both apps must use this
same database schema before deploying the updated Ladders repository selectors.
The earlier numbered migrations are the shared project's copied Ladders migration
history, **not a separate Planner schema**.
