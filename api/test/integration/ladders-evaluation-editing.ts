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
test("Ladders manager drafts and peer publication preserve version identity, visibility and employee-owned self status", async () => {
  const admin = new Client({ connectionString: adminURL }),
    api = new PlatformDatabase(apiURL);
  await admin.connect();
  const owner = randomUUID(),
    workspace = randomUUID(),
    other = randomUUID(),
    team = randomUUID(),
    foreignTeam = randomUUID();
  const member = randomUUID(),
    foreignMember = randomUUID(),
    published = randomUUID(),
    self = randomUUID(),
    peer = randomUUID();
  const account = await api.account({
    issuer: "https://ladders-editing.invalid",
    subject: randomUUID(),
    email: "local@example.invalid",
  });
  const input = {
    current_levels: { Technology: 3.5 },
    goal_levels: { Technology: 5.5 },
    comments: { Technology: "New draft note" },
  };
  try {
    await admin.query("BEGIN");
    await admin.query("SELECT set_config('request.jwt.claim.sub',$1,true)", [owner]);
    await admin.query("INSERT INTO auth.users(id) VALUES($1)", [owner]);
    await admin.query(
      "INSERT INTO public.workspaces(id,owner_id,name) VALUES($1,$3,'Editing integration'),($2,$3,'Foreign editing integration')",
      [workspace, other, owner]
    );
    await admin.query(
      "INSERT INTO public.teams(id,owner_id,workspace_id,name) VALUES($1,$3,$4,'Editing team'),($2,$3,$5,'Foreign editing team')",
      [team, foreignTeam, owner, workspace, other]
    );
    await admin.query(
      "INSERT INTO public.members(id,team_id,name) VALUES($1,$3,'Editing member'),($2,$4,'Foreign editing member')",
      [member, foreignMember, team, foreignTeam]
    );
    await admin.query(
      `INSERT INTO public.evaluations(id,member_id,kind,status,comments,comment_visibility,created_at) VALUES
      ($1,$4,'manager','published','{"Technology":"Immutable published note"}','{"Technology":false}','2026-11-01'),
      ($2,$4,'self','published','{"Technology":"Self note"}','{}','2026-11-02'),
      ($3,$4,'peer','draft','{"Technology":"Peer note"}','{}','2026-11-03')`,
      [published, self, peer, member]
    );
    await admin.query("COMMIT");
    const immutable = (
      await admin.query("SELECT to_jsonb(e) data FROM public.evaluations e WHERE id=$1", [
        published,
      ])
    ).rows[0].data;
    await assert.rejects(
      api.laddersSaveEvaluation(account.id, workspace, member, null, input),
      /edit access/
    );
    await admin.query(
      "INSERT INTO platform.grants(user_id,app,workspace_id,role) VALUES($1,'ladders',$2,'viewer'),($1,'planner',$2,'owner')",
      [account.id, workspace]
    );
    await assert.rejects(
      api.laddersSaveEvaluation(account.id, workspace, member, null, input),
      /edit access/
    );
    await assert.rejects(
      api.laddersEvaluationStatus(account.id, workspace, member, peer, "published"),
      /edit access/
    );
    await admin.query(
      "UPDATE platform.grants SET role='editor' WHERE user_id=$1 AND app='ladders'",
      [account.id]
    );
    await assert.rejects(
      api.laddersSaveEvaluation(account.id, workspace, foreignMember, null, input),
      /Member unavailable/
    );
    await assert.rejects(
      api.laddersSaveEvaluation(account.id, workspace, member, published, input),
      /immutable/
    );
    await assert.rejects(
      api.laddersSaveEvaluation(account.id, workspace, member, self, input),
      /Evaluation unavailable/
    );
    await assert.rejects(
      api.laddersSaveEvaluation(account.id, workspace, member, peer, input),
      /Evaluation unavailable/
    );
    await assert.rejects(
      api.laddersEvaluationStatus(account.id, workspace, member, self, "draft"),
      /Evaluation unavailable/
    );
    await assert.rejects(
      api.pool.query("SELECT platform.ladders_save_evaluation($1,$2,$3,NULL,$4)", [
        account.id,
        workspace,
        member,
        { ...input, comments: { Technology: "x".repeat(2001) } },
      ]),
      /Invalid evaluation content/
    );
    const created = await api.laddersSaveEvaluation(account.id, workspace, member, null, input);
    assert.ok(
      created && typeof created === "object" && "id" in created && typeof created.id === "string"
    );
    const draft = created.id;
    const row = (await admin.query("SELECT * FROM public.evaluations WHERE id=$1", [draft]))
      .rows[0];
    assert.equal(row.kind, "manager");
    assert.equal(row.status, "draft");
    assert.equal(row.author_name, null);
    assert.deepEqual(row.comment_visibility, { Technology: false });
    await assert.rejects(
      api.laddersSaveEvaluation(account.id, workspace, member, null, input),
      /draft already exists/
    );
    const updated = await api.laddersSaveEvaluation(account.id, workspace, member, draft, {
      ...input,
      comments: { Technology: "Updated draft" },
    });
    assert.ok(updated && typeof updated === "object" && "id" in updated);
    assert.equal(updated.id, draft);
    const after = (await admin.query("SELECT * FROM public.evaluations WHERE id=$1", [draft]))
      .rows[0];
    assert.deepEqual(after.created_at, row.created_at);
    assert.deepEqual(after.comment_visibility, row.comment_visibility);
    assert.deepEqual(
      (
        await admin.query("SELECT to_jsonb(e) data FROM public.evaluations e WHERE id=$1", [
          published,
        ])
      ).rows[0].data,
      immutable
    );
    await api.laddersEvaluationStatus(account.id, workspace, member, draft, "published");
    await assert.rejects(
      api.laddersSaveEvaluation(account.id, workspace, member, draft, input),
      /immutable/
    );
    await api.laddersEvaluationStatus(account.id, workspace, member, peer, "published");
    assert.deepEqual(
      (
        await admin.query(
          "SELECT status,comments,comment_visibility FROM public.evaluations WHERE id=$1",
          [peer]
        )
      ).rows[0],
      { status: "published", comments: { Technology: "Peer note" }, comment_visibility: {} }
    );
    await api.laddersEvaluationStatus(account.id, workspace, member, peer, "draft");
    await admin.query(
      "UPDATE platform.grants SET role='owner' WHERE user_id=$1 AND app='ladders'",
      [account.id]
    );
    await api.laddersEvaluationStatus(account.id, workspace, member, draft, "draft");
    await assert.rejects(
      api.laddersEvaluationStatus(account.id, workspace, member, published, "draft"),
      /draft already exists/
    );
    await assert.rejects(
      api.laddersEvaluationStatus(account.id, workspace, foreignMember, draft, "published"),
      /Evaluation unavailable/
    );
    await assert.rejects(
      api.pool.query("INSERT INTO public.evaluations(member_id,kind) VALUES($1,'manager')", [
        member,
      ]),
      /permission denied/
    );
    await assert.rejects(
      api.pool.query("UPDATE public.evaluations SET status='published' WHERE id=$1", [draft]),
      /permission denied/
    );
    await admin.query("DELETE FROM platform.grants WHERE user_id=$1", [account.id]);
    await assert.rejects(
      api.laddersSaveEvaluation(account.id, workspace, member, draft, input),
      /edit access/
    );
    await assert.rejects(
      api.laddersEvaluationStatus(account.id, workspace, member, peer, "published"),
      /edit access/
    );
  } finally {
    await admin.query("ROLLBACK");
    await admin.query("DELETE FROM platform.grants WHERE user_id=$1", [account.id]);
    await admin.query("DELETE FROM public.members WHERE id=ANY($1::uuid[])", [
      [member, foreignMember],
    ]);
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
