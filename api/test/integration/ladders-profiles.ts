import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { PlatformDatabase } from "../../src/database.js";
import { localPermissionConnection } from "../../scripts/local-permissions.js";

const adminURL = localPermissionConnection({
  DATABASE_URL: process.env.DATABASE_URL,
  LOCAL_PERMISSIONS_CONFIRM: "local-only",
});
const apiURL = process.env.API_DATABASE_URL;
if (!apiURL || new URL(apiURL).hostname !== "db")
  throw new Error("Isolated Docker database required");
test("Ladders profile edits preserve imported identity, tokens, history and member scope", async () => {
  const admin = new Client({ connectionString: adminURL }),
    api = new PlatformDatabase(apiURL);
  await admin.connect();
  const owner = randomUUID(),
    workspace = randomUUID(),
    other = randomUUID(),
    team = randomUUID(),
    member = randomUUID();
  const account = await api.account({
    issuer: "https://ladders-profiles.invalid",
    subject: randomUUID(),
    email: "local@example.invalid",
  });
  const input = {
    name: " Updated ",
    role: " Engineer ",
    planning_role: "backend" as const,
    template_id: "D3",
  };
  try {
    await admin.query("BEGIN");
    await admin.query("SELECT set_config('request.jwt.claim.sub',$1,true)", [owner]);
    await admin.query("INSERT INTO auth.users(id) VALUES($1)", [owner]);
    await admin.query(
      "INSERT INTO public.workspaces(id,owner_id,name) VALUES($1,$3,'Profiles integration'),($2,$3,'Other profiles integration')",
      [workspace, other, owner]
    );
    await admin.query(
      "INSERT INTO public.teams(id,owner_id,workspace_id,name) VALUES($1,$2,$3,'Profiles team')",
      [team, owner, workspace]
    );
    await admin.query(
      "INSERT INTO public.members(id,owner_id,team_id,name,role) VALUES($1,$2,$3,'Original','Developer')",
      [member, owner, team]
    );
    await admin.query("SELECT set_config('members.claiming',$1,true)", [member]);
    await admin.query("UPDATE public.members SET user_id=$2 WHERE id=$1", [member, owner]);
    await admin.query(
      "INSERT INTO public.evaluations(member_id,kind,status,comments) VALUES($1,'manager','published','{\"Technology\":\"Keep history\"}')",
      [member]
    );
    await admin.query("COMMIT");
    const protectedFields =
      "id,owner_id,team_id,user_id,self_token,peer_token,view_token,vacation_token,view_enabled,created_at";
    const before = (
      await admin.query(`SELECT ${protectedFields} FROM public.members WHERE id=$1`, [member])
    ).rows[0];
    const history = (
      await admin.query("SELECT * FROM public.evaluations WHERE member_id=$1", [member])
    ).rows;
    await assert.rejects(
      api.laddersSaveProfile(account.id, workspace, member, input),
      /edit access/
    );
    await admin.query(
      "INSERT INTO platform.grants(user_id,app,workspace_id,role) VALUES($1,'planner',$2,'owner')",
      [account.id, workspace]
    );
    await assert.rejects(
      api.laddersSaveProfile(account.id, workspace, member, input),
      /edit access/
    );
    await admin.query(
      "INSERT INTO platform.grants(user_id,app,workspace_id,role) VALUES($1,'ladders',$2,'viewer')",
      [account.id, workspace]
    );
    await assert.rejects(
      api.laddersSaveProfile(account.id, workspace, member, input),
      /edit access/
    );
    await admin.query(
      "UPDATE platform.grants SET role='editor' WHERE user_id=$1 AND app='ladders'",
      [account.id]
    );
    await api.laddersSaveProfile(account.id, workspace, member, input);
    assert.deepEqual(
      (
        await admin.query(
          "SELECT name,role,planning_role,template_id FROM public.members WHERE id=$1",
          [member]
        )
      ).rows[0],
      {
        name: "Updated",
        role: "Engineer",
        planning_role: "backend",
        template_id: "D3",
      }
    );
    assert.deepEqual(
      (await admin.query(`SELECT ${protectedFields} FROM public.members WHERE id=$1`, [member]))
        .rows[0],
      before
    );
    assert.deepEqual(
      (await admin.query("SELECT * FROM public.evaluations WHERE member_id=$1", [member])).rows,
      history
    );
    await assert.rejects(
      api.laddersSaveProfile(account.id, workspace, randomUUID(), input),
      /Member unavailable/
    );
    await admin.query(
      "INSERT INTO platform.grants(user_id,app,workspace_id,role) VALUES($1,'ladders',$2,'owner')",
      [account.id, other]
    );
    await assert.rejects(
      api.laddersSaveProfile(account.id, other, member, input),
      /Member unavailable/
    );
    for (const profile of [
      { ...input, name: "" },
      { ...input, name: "x".repeat(121) },
      { ...input, role: "x".repeat(121) },
      { ...input, planning_role: "invalid" },
      { ...input, template_id: "x".repeat(11) },
    ]) {
      await assert.rejects(
        api.pool.query("SELECT platform.ladders_save_profile($1,$2,$3,$4)", [
          account.id,
          workspace,
          member,
          profile,
        ]),
        /Invalid member profile/
      );
    }
    await api.laddersSaveProfile(account.id, workspace, member, {
      name: "😀".repeat(120),
      role: "x".repeat(120),
      planning_role: null,
      template_id: "x".repeat(10),
    });
    await api.laddersSaveProfile(account.id, workspace, member, {
      ...input,
      planning_role: null,
      template_id: null,
    });
    assert.deepEqual(
      (
        await admin.query("SELECT planning_role,template_id FROM public.members WHERE id=$1", [
          member,
        ])
      ).rows[0],
      { planning_role: null, template_id: null }
    );
    await assert.rejects(
      api.pool.query("UPDATE public.members SET name='Direct' WHERE id=$1", [member]),
      /permission denied/
    );
    await admin.query("DELETE FROM platform.grants WHERE user_id=$1", [account.id]);
    await assert.rejects(
      api.laddersSaveProfile(account.id, workspace, member, input),
      /edit access/
    );
  } finally {
    await admin.query("ROLLBACK");
    await admin.query("DELETE FROM platform.grants WHERE user_id=$1", [account.id]);
    await admin.query("DELETE FROM public.members WHERE id=$1", [member]);
    await admin.query("DELETE FROM public.teams WHERE workspace_id=ANY($1::uuid[])", [
      [workspace, other],
    ]);
    await admin.query("DELETE FROM public.workspaces WHERE id=ANY($1::uuid[])", [
      [workspace, other],
    ]);
    await admin.query("DELETE FROM auth.users WHERE id=$1", [owner]);
    await admin.query("DELETE FROM platform.identities WHERE user_id=$1", [account.id]);
    await admin.query("DELETE FROM platform.users WHERE id=$1", [account.id]);
    await admin.end();
    await api.pool.end();
  }
});
