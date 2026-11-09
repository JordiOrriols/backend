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

test("Ladders internal evaluation history is member/workspace scoped and never exposes private self drafts", async () => {
  const admin = new Client({ connectionString: adminURL }),
    api = new PlatformDatabase(apiURL);
  await admin.connect();
  const owner = randomUUID(),
    workspace = randomUUID(),
    other = randomUUID();
  const team = randomUUID(),
    foreignTeam = randomUUID(),
    member = randomUUID(),
    foreignMember = randomUUID();
  const selfDraft = randomUUID(),
    selfPublished = randomUUID(),
    manager = randomUUID(),
    managerDraft = randomUUID(),
    peer = randomUUID();
  const account = await api.account({
    issuer: "https://ladders-history.invalid",
    subject: randomUUID(),
    email: "same@example.invalid",
  });
  const unrelated = await api.account({
    issuer: "https://ladders-history.invalid",
    subject: randomUUID(),
    email: "same@example.invalid",
  });
  try {
    await admin.query("BEGIN");
    await admin.query("SELECT set_config('request.jwt.claim.sub',$1,true)", [owner]);
    await admin.query("INSERT INTO auth.users(id) VALUES($1)", [owner]);
    await admin.query(
      "INSERT INTO public.workspaces(id,owner_id,name) VALUES($1,$3,'History integration'),($2,$3,'Other history integration')",
      [workspace, other, owner]
    );
    await admin.query(
      "INSERT INTO public.teams(id,owner_id,workspace_id,name) VALUES($1,$3,$4,'History team'),($2,$3,$5,'Foreign history team')",
      [team, foreignTeam, owner, workspace, other]
    );
    await admin.query(
      "INSERT INTO public.members(id,team_id,name) VALUES($1,$3,'History member'),($2,$4,'Foreign history member')",
      [member, foreignMember, team, foreignTeam]
    );
    await admin.query(
      `INSERT INTO public.evaluations(id,member_id,kind,status,author_name,current_levels,goal_levels,comments,comment_visibility,created_at) VALUES
      ($1,$6,'self','draft',null,'{}','{}','{"Technology":"Private self draft"}','{}','2026-11-05'),
      ($2,$6,'self','published',null,'{"Technology":2}','{}','{"Technology":"Published self"}','{}','2026-11-01'),
      ($3,$6,'manager','published',null,'{"Technology":5.5}','{"Technology":5.5}','{"Technology":"Hidden manager note"}','{"Technology":false}','2026-11-02'),
      ($4,$6,'manager','draft',null,'{}','{}','{"Technology":"Manager draft"}','{}','2026-11-03'),
      ($5,$6,'peer','draft','Peer reviewer','{"Technology":3}','{}','{"Technology":"Unapproved peer note"}','{}','2026-11-04')`,
      [selfDraft, selfPublished, manager, managerDraft, peer, member]
    );
    await admin.query(
      "INSERT INTO public.evaluations(member_id,kind,status,comments) VALUES($1,'manager','published','{\"Technology\":\"Foreign note\"}')",
      [foreignMember]
    );
    await admin.query("COMMIT");
    const snapshot = (
      await admin.query(
        "SELECT jsonb_agg(to_jsonb(e) ORDER BY id) data FROM public.evaluations e WHERE member_id=$1",
        [member]
      )
    ).rows[0].data;
    await assert.rejects(api.laddersEvaluations(account.id, workspace, member), /access/);
    await admin.query(
      "INSERT INTO platform.grants(user_id,app,workspace_id,role) VALUES($1,'planner',$2,'owner')",
      [account.id, workspace]
    );
    await assert.rejects(api.laddersEvaluations(account.id, workspace, member), /access/);
    for (const role of ["viewer", "editor", "owner"]) {
      await admin.query(
        "INSERT INTO platform.grants(user_id,app,workspace_id,role) VALUES($1,'ladders',$2,$3) ON CONFLICT(user_id,app,workspace_id) DO UPDATE SET role=excluded.role",
        [account.id, workspace, role]
      );
      const result = await api.laddersEvaluations(account.id, workspace, member);
      assert.ok(Array.isArray(result));
      assert.deepEqual(
        result.map((row) => row.id),
        [peer, managerDraft, manager, selfPublished]
      );
      assert.ok(!JSON.stringify(result).includes("Private self draft"));
      assert.ok(!JSON.stringify(result).includes("Foreign note"));
      assert.deepEqual(
        Object.keys(result[0]).sort(),
        [
          "id",
          "member_id",
          "kind",
          "status",
          "author_name",
          "current_levels",
          "goal_levels",
          "comments",
          "comment_visibility",
          "created_at",
        ].sort()
      );
      assert.deepEqual(result[2].comment_visibility, { Technology: false });
      // Internal reviewers retain hidden notes; employee redaction belongs to a separate projection.
      assert.equal(result[2].comments.Technology, "Hidden manager note");
      assert.equal(result[0].comments.Technology, "Unapproved peer note");
    }
    await assert.rejects(api.laddersEvaluations(unrelated.id, workspace, member), /access/);
    await assert.rejects(
      api.laddersEvaluations(account.id, workspace, foreignMember),
      /Member unavailable/
    );
    await assert.rejects(
      api.laddersEvaluations(account.id, workspace, randomUUID()),
      /Member unavailable/
    );
    await admin.query(
      "INSERT INTO platform.grants(user_id,app,workspace_id,role) VALUES($1,'ladders',$2,'viewer')",
      [account.id, other]
    );
    await assert.rejects(api.laddersEvaluations(account.id, other, member), /Member unavailable/);
    const foreignHistory = await api.laddersEvaluations(account.id, other, foreignMember);
    assert.ok(Array.isArray(foreignHistory));
    assert.deepEqual(foreignHistory[0]?.comments, { Technology: "Foreign note" });
    await assert.rejects(api.pool.query("SELECT * FROM public.evaluations"), /permission denied/);
    assert.deepEqual(
      (
        await admin.query(
          "SELECT jsonb_agg(to_jsonb(e) ORDER BY id) data FROM public.evaluations e WHERE member_id=$1",
          [member]
        )
      ).rows[0].data,
      snapshot
    );
    await admin.query("DELETE FROM platform.grants WHERE user_id=$1", [account.id]);
    await assert.rejects(api.laddersEvaluations(account.id, workspace, member), /access/);
  } finally {
    await admin.query("ROLLBACK");
    await admin.query("DELETE FROM platform.grants WHERE user_id=ANY($1::uuid[])", [
      [account.id, unrelated.id],
    ]);
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
    await admin.query("DELETE FROM platform.identities WHERE user_id=ANY($1::uuid[])", [
      [account.id, unrelated.id],
    ]);
    await admin.query("DELETE FROM platform.users WHERE id=ANY($1::uuid[])", [
      [account.id, unrelated.id],
    ]);
    await admin.end();
    await api.pool.end();
  }
});
