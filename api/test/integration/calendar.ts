import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { PlatformDatabase } from "../../src/database.js";
import { validateSprintSettings } from "../../dist/scheduler.mjs";
import { localPermissionConnection } from "../../scripts/local-permissions.js";

const adminURL = localPermissionConnection({
  DATABASE_URL: process.env.DATABASE_URL,
  LOCAL_PERMISSIONS_CONFIRM: "local-only",
});
const apiURL = process.env.API_DATABASE_URL;
if (!apiURL || new URL(apiURL).hostname !== "db")
  throw new Error("Integration tests require isolated Docker database URLs");

test("calendar projections and edits isolate workspace roster, restore working days and preserve proposals", async () => {
  const admin = new pg.Client({ connectionString: adminURL });
  await admin.connect();
  const api = new PlatformDatabase(apiURL);
  const account = await api.account({
    issuer: "https://local.invalid",
    subject: `calendar-${randomUUID()}`,
    email: "calendar@example.invalid",
  });
  const [owner, workspace, other, team, otherTeam, member, stranger] = Array.from(
    { length: 7 },
    () => randomUUID()
  );
  try {
    await admin.query("BEGIN");
    await admin.query("SELECT set_config('request.jwt.claim.sub',$1,true)", [owner]);
    await admin.query("INSERT INTO auth.users(id) VALUES($1)", [owner]);
    await admin.query(
      "INSERT INTO public.workspaces(id,owner_id,name,plan_start_date,sprint_start_date) VALUES($1,$3,'Calendar integration','2026-02-02','2026-02-02'),($2,$3,'Other calendar integration','2026-02-02','2026-02-02')",
      [workspace, other, owner]
    );
    await admin.query(
      "INSERT INTO public.teams(id,owner_id,workspace_id,name) VALUES($1,$3,$4,'Planning roster'),($2,$3,$5,'Other roster')",
      [team, otherTeam, owner, workspace, other]
    );
    await admin.query(
      "INSERT INTO public.members(id,owner_id,team_id,name,planning_role) VALUES($1,$3,$4,'Calendar developer','backend'),($2,$3,$5,'Private other member','design')",
      [member, stranger, owner, team, otherTeam]
    );
    await admin.query("COMMIT");
    await assert.rejects(
      api.plannerCalendar(account.id, workspace),
      /Internal Planner access required/
    );
    await admin.query(
      "INSERT INTO platform.grants(user_id,app,workspace_id,role) VALUES($1,'planner',$2,'external')",
      [account.id, workspace]
    );
    await assert.rejects(
      api.plannerCalendar(account.id, workspace),
      /Internal Planner access required/
    );
    await admin.query("UPDATE platform.grants SET role='viewer' WHERE user_id=$1", [account.id]);
    const read = await api.plannerCalendar(account.id, workspace);
    assert.ok(read && typeof read === "object" && "members" in read && Array.isArray(read.members));
    assert.deepEqual(read.members, [
      { id: member, team_id: team, name: "Calendar developer", role: "backend", can_edit: false },
    ]);
    await assert.rejects(
      api.plannerVacations(account.id, workspace, member, {
        start: "2026-02-02",
        end: "2026-02-03",
        working: false,
      }),
      /edit access required/
    );
    await assert.rejects(
      api.plannerCalibration(account.id, workspace, { anchor: "2026-02-02", history: [] }),
      /edit access required/
    );
    await assert.rejects(
      api.plannerPlanningRole(account.id, workspace, member, "qa"),
      /edit access required/
    );
    await assert.rejects(
      api.plannerCreateTeam(account.id, workspace, "Viewer cannot create"),
      /owner access required/
    );
    await assert.rejects(
      api.plannerCalendar(account.id, other),
      /Internal Planner access required/
    );
    await admin.query("UPDATE platform.grants SET role='editor' WHERE user_id=$1", [account.id]);
    const source = await api.plannerSource(account.id, workspace);
    assert.ok(
      source &&
        typeof source === "object" &&
        "revision" in source &&
        typeof source.revision === "string"
    );
    const snapshot = await api.plannerSaveProposal(account.id, workspace, {
      name: "Untouched capacity comparison",
      featureIds: [],
      expectedRevision: source.revision,
    });
    const saved = await api.plannerSavedProposal(account.id, workspace, snapshot);
    const protectedMember = (
      await admin.query(
        "SELECT id,team_id,role,owner_id,user_id,self_token,peer_token,view_token,vacation_token FROM public.members WHERE id=$1",
        [member]
      )
    ).rows[0];
    await assert.rejects(
      api.plannerCreateTeam(account.id, workspace, "Editor cannot create"),
      /owner access required/
    );
    await assert.rejects(
      api.plannerPlanningRole(account.id, workspace, stranger, "qa"),
      /Member unavailable/
    );
    await api.plannerPlanningRole(account.id, workspace, member, "frontend");
    assert.notDeepEqual(await api.plannerSource(account.id, workspace), source);
    assert.equal(
      (await admin.query("SELECT planning_role FROM public.members WHERE id=$1", [member])).rows[0]
        .planning_role,
      "frontend"
    );
    await api.plannerPlanningRole(account.id, workspace, member, null);
    assert.equal(
      (await admin.query("SELECT planning_role FROM public.members WHERE id=$1", [member])).rows[0]
        .planning_role,
      null
    );
    await api.plannerPlanningRole(account.id, workspace, member, "backend");
    assert.deepEqual(
      (
        await admin.query(
          "SELECT id,team_id,role,owner_id,user_id,self_token,peer_token,view_token,vacation_token FROM public.members WHERE id=$1",
          [member]
        )
      ).rows[0],
      protectedMember
    );
    await assert.rejects(
      api.pool.query("SELECT platform.planner_planning_role($1,$2,$3,$4)", [
        account.id,
        workspace,
        member,
        "invalid",
      ]),
      /Invalid planning role/
    );
    await admin.query("UPDATE platform.grants SET role='owner' WHERE user_id=$1", [account.id]);
    await assert.rejects(api.plannerCreateTeam(account.id, workspace, " "), /Team names/);
    await assert.rejects(
      api.plannerCreateTeam(account.id, workspace, "a".repeat(121)),
      /Team names/
    );
    await api.plannerCreateTeam(account.id, workspace, "  Created planning team  ");
    assert.deepEqual(
      (
        await admin.query(
          "SELECT owner_id,name FROM public.teams WHERE workspace_id=$1 AND name='Created planning team'",
          [workspace]
        )
      ).rows,
      [{ owner_id: owner, name: "Created planning team" }]
    );
    await admin.query("UPDATE platform.grants SET role='editor' WHERE user_id=$1", [account.id]);
    await assert.rejects(
      api.plannerVacations(account.id, workspace, stranger, {
        start: "2026-02-02",
        end: "2026-02-03",
        working: false,
      }),
      /Member unavailable/
    );
    await api.plannerVacations(account.id, workspace, member, {
      start: "2026-02-02",
      end: "2026-02-04",
      working: false,
    });
    assert.equal(
      (
        await admin.query("SELECT count(*)::int n FROM public.vacations WHERE member_id=$1", [
          member,
        ])
      ).rows[0].n,
      3
    );
    const changed = await api.plannerSource(account.id, workspace);
    assert.notDeepEqual(changed, source);
    await api.plannerVacations(account.id, workspace, member, {
      start: "2026-02-03",
      end: "2026-02-03",
      working: true,
    });
    assert.deepEqual(
      (
        await admin.query(
          "SELECT date::text,is_working FROM public.vacations WHERE member_id=$1 ORDER BY date",
          [member]
        )
      ).rows,
      [
        { date: "2026-02-02", is_working: false },
        { date: "2026-02-04", is_working: false },
      ]
    );
    await api.plannerVacations(account.id, workspace, member, {
      start: "2026-02-07",
      end: "2026-02-08",
      working: true,
    });
    assert.equal(
      (
        await admin.query("SELECT count(*)::int n FROM public.vacations WHERE member_id=$1", [
          member,
        ])
      ).rows[0].n,
      2
    );
    const calibration = {
      anchor: "2026-02-02",
      history: [{ start_date: "2026-02-02", story_points: 12.5 }],
    };
    validateSprintSettings(calibration.anchor, calibration.history);
    await api.plannerCalibration(account.id, workspace, calibration);
    assert.deepEqual(
      (
        await admin.query(
          "SELECT sprint_start_date::text,sprint_history FROM public.workspaces WHERE id=$1",
          [workspace]
        )
      ).rows[0],
      { sprint_start_date: calibration.anchor, sprint_history: calibration.history }
    );
    assert.deepEqual(await api.plannerSavedProposal(account.id, workspace, snapshot), saved);
    await admin.query("DELETE FROM platform.grants WHERE user_id=$1", [account.id]);
    await assert.rejects(
      api.plannerPlanningRole(account.id, workspace, member, "qa"),
      /edit access required/
    );
    await assert.rejects(
      api.plannerVacations(account.id, workspace, member, {
        start: "2026-02-02",
        end: "2026-02-04",
        working: true,
      }),
      /edit access required/
    );
    await assert.rejects(
      api.plannerCalendar(account.id, workspace),
      /Internal Planner access required/
    );
  } finally {
    await admin.query("ROLLBACK");
    await admin.query("DELETE FROM platform.planner_priority_proposals WHERE created_by=$1", [
      account.id,
    ]);
    await admin.query("DELETE FROM platform.grants WHERE user_id=$1", [account.id]);
    await admin.query("DELETE FROM platform.identities WHERE user_id=$1", [account.id]);
    await admin.query("DELETE FROM platform.users WHERE id=$1", [account.id]);
    await admin.query("DELETE FROM public.vacations WHERE member_id=ANY($1::uuid[])", [
      [member, stranger],
    ]);
    await admin.query("DELETE FROM public.members WHERE id=ANY($1::uuid[])", [[member, stranger]]);
    await admin.query("DELETE FROM public.teams WHERE workspace_id=ANY($1::uuid[])", [
      [workspace, other],
    ]);
    await admin.query("DELETE FROM public.workspaces WHERE id=ANY($1::uuid[])", [
      [workspace, other],
    ]);
    await admin.query("DELETE FROM auth.users WHERE id=$1", [owner]);
    await api.pool.end();
    await admin.end();
  }
});
