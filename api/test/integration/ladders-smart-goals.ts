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

test("Ladders SMART goals remain workspace-scoped with owner deletion and append-only comments", async () => {
  const admin = new Client({ connectionString: adminURL });
  const api = new PlatformDatabase(apiURL);
  await admin.connect();
  const owner = randomUUID(),
    workspace = randomUUID(),
    foreignWorkspace = randomUUID(),
    team = randomUUID(),
    foreignTeam = randomUUID(),
    member = randomUUID(),
    foreignMember = randomUUID(),
    goal = randomUUID(),
    foreignGoal = randomUUID(),
    legacyComment = randomUUID();
  const account = await api.account({
    issuer: "https://ladders-goals.invalid",
    subject: randomUUID(),
    email: "local@example.invalid",
  });
  const input = {
    title: "Improve onboarding",
    description: "Document the first-week path",
    due_date: "2026-12-01",
    progress: 25,
  };
  try {
    await admin.query("BEGIN");
    await admin.query("SELECT set_config('request.jwt.claim.sub',$1,true)", [owner]);
    await admin.query("INSERT INTO auth.users(id) VALUES($1)", [owner]);
    await admin.query(
      "INSERT INTO public.workspaces(id,owner_id,name) VALUES($1,$3,'Goals workspace'),($2,$3,'Foreign goals workspace')",
      [workspace, foreignWorkspace, owner]
    );
    await admin.query(
      "INSERT INTO public.teams(id,owner_id,workspace_id,name) VALUES($1,$3,$4,'Goals team'),($2,$3,$5,'Foreign goals team')",
      [team, foreignTeam, owner, workspace, foreignWorkspace]
    );
    await admin.query(
      "INSERT INTO public.members(id,team_id,name) VALUES($1,$3,'Goals member'),($2,$4,'Foreign goals member')",
      [member, foreignMember, team, foreignTeam]
    );
    await admin.query(
      `INSERT INTO public.smart_goals(id,member_id,title,description,due_date,progress,comments,created_at,updated_at) VALUES
      ($1,$3,'Existing goal','Existing description','2026-11-30',10,
        jsonb_build_array(jsonb_build_object('id',$5::uuid,'text','Legacy note','createdAt','2026-10-01T00:00:00Z','authorKind','legacy')),
        '2026-10-01','2026-10-02'),
      ($2,$4,'Foreign goal','',null,0,'[]','2026-10-03','2026-10-04')`,
      [goal, foreignGoal, member, foreignMember, legacyComment]
    );
    await admin.query("COMMIT");

    await assert.rejects(api.laddersGoals(account.id, workspace, member), /access required/);
    await assert.rejects(
      api.laddersSaveGoal(account.id, workspace, member, null, input),
      /edit access/
    );
    await admin.query(
      "INSERT INTO platform.grants(user_id,app,workspace_id,role) VALUES($1,'ladders',$2,'viewer')",
      [account.id, workspace]
    );
    const visible = (await api.laddersGoals(account.id, workspace, member)) as {
      id: string;
      comments: { authorKind: string }[];
    }[];
    assert.deepEqual(
      visible.map((row) => row.id),
      [goal]
    );
    assert.equal(visible[0]?.comments[0]?.authorKind, "legacy");
    await assert.rejects(
      api.laddersSaveGoal(account.id, workspace, member, null, input),
      /edit access/
    );
    await assert.rejects(
      api.laddersAppendGoalComment(account.id, workspace, member, goal, "Viewer comment"),
      /edit access/
    );

    await admin.query(
      "UPDATE platform.grants SET role='editor' WHERE user_id=$1 AND app='ladders'",
      [account.id]
    );
    await assert.rejects(
      api.laddersDeleteGoal(account.id, workspace, member, goal),
      /owner access/
    );
    const created = (await api.laddersSaveGoal(account.id, workspace, member, null, input)) as {
      id: string;
      member_id: string;
      title: string;
      progress: number;
    };
    assert.equal(created.member_id, member);
    assert.equal(created.title, input.title);
    assert.equal(created.progress, 25);
    const updated = (await api.laddersSaveGoal(account.id, workspace, member, goal, {
      ...input,
      title: " Revised goal ",
      progress: 60,
    })) as { id: string; title: string; progress: number; comments: unknown[] };
    assert.equal(updated.id, goal);
    assert.equal(updated.title, "Revised goal");
    assert.equal(updated.progress, 60);
    assert.equal(updated.comments.length, 1);
    await assert.rejects(
      api.laddersSaveGoal(account.id, workspace, foreignMember, goal, input),
      /Member unavailable/
    );
    await assert.rejects(
      api.laddersSaveGoal(account.id, workspace, member, foreignGoal, input),
      /Goal unavailable/
    );
    await assert.rejects(
      api.laddersAppendGoalComment(account.id, workspace, member, foreignGoal, "Foreign"),
      /Goal unavailable/
    );
    const commented = (await api.laddersAppendGoalComment(
      account.id,
      workspace,
      member,
      goal,
      "Manager progress note"
    )) as { comments: { id: string; text: string; authorKind: string }[] };
    assert.equal(commented.comments.length, 2);
    assert.equal(commented.comments[1]?.text, "Manager progress note");
    assert.equal(commented.comments[1]?.authorKind, "manager");
    await assert.rejects(
      api.laddersAppendGoalComment(account.id, workspace, member, goal, "x".repeat(10001)),
      /Comment must contain/
    );
    await assert.rejects(
      api.pool.query("SELECT * FROM public.smart_goals WHERE id=$1", [goal]),
      /permission denied/
    );
    await assert.rejects(
      api.pool.query("INSERT INTO public.smart_goals(member_id,title) VALUES($1,'Direct insert')", [
        member,
      ]),
      /permission denied/
    );
    await assert.rejects(
      api.pool.query("UPDATE public.smart_goals SET progress=99 WHERE id=$1", [goal]),
      /permission denied/
    );
    await assert.rejects(
      api.pool.query("DELETE FROM public.smart_goals WHERE id=$1", [goal]),
      /permission denied/
    );

    await admin.query(
      "UPDATE platform.grants SET role='owner' WHERE user_id=$1 AND app='ladders'",
      [account.id]
    );
    const remaining = (await api.laddersDeleteGoal(account.id, workspace, member, goal)) as {
      id: string;
    }[];
    assert.ok(remaining.every((item) => item.id !== goal));
    await assert.rejects(
      api.laddersDeleteGoal(account.id, workspace, member, foreignGoal),
      /Goal unavailable/
    );
    await admin.query("DELETE FROM platform.grants WHERE user_id=$1", [account.id]);
    await assert.rejects(api.laddersGoals(account.id, workspace, member), /access required/);
  } finally {
    await admin.query("ROLLBACK");
    await admin.query("DELETE FROM platform.grants WHERE user_id=$1", [account.id]);
    await admin.query("DELETE FROM public.members WHERE id=ANY($1::uuid[])", [
      [member, foreignMember],
    ]);
    await admin.query("DELETE FROM public.teams WHERE workspace_id=ANY($1::uuid[])", [
      [workspace, foreignWorkspace],
    ]);
    await admin.query("DELETE FROM public.workspaces WHERE id=ANY($1::uuid[])", [
      [workspace, foreignWorkspace],
    ]);
    await admin.query("DELETE FROM auth.users WHERE id=$1", [owner]);
    await admin.query("DELETE FROM platform.identities WHERE user_id=$1", [account.id]);
    await admin.query("DELETE FROM platform.users WHERE id=$1", [account.id]);
    await admin.end();
    await api.pool.end();
  }
});
