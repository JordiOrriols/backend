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

test("Ladders evaluation deletion is owner-only and never exposes private self drafts", async () => {
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
    foreignEvaluation = randomUUID(),
    managerDraft = randomUUID(),
    managerPublished = randomUUID(),
    peer = randomUUID(),
    selfPublished = randomUUID(),
    privateSelfDraft = randomUUID();
  const account = await api.account({
    issuer: "https://ladders-deletion.invalid",
    subject: randomUUID(),
    email: "local@example.invalid",
  });
  try {
    await admin.query("BEGIN");
    await admin.query("SELECT set_config('request.jwt.claim.sub',$1,true)", [owner]);
    await admin.query("INSERT INTO auth.users(id) VALUES($1)", [owner]);
    await admin.query(
      "INSERT INTO public.workspaces(id,owner_id,name) VALUES($1,$3,'Deletion workspace'),($2,$3,'Foreign deletion workspace')",
      [workspace, foreignWorkspace, owner]
    );
    await admin.query(
      "INSERT INTO public.teams(id,owner_id,workspace_id,name) VALUES($1,$3,$4,'Deletion team'),($2,$3,$5,'Foreign deletion team')",
      [team, foreignTeam, owner, workspace, foreignWorkspace]
    );
    await admin.query(
      "INSERT INTO public.members(id,team_id,name) VALUES($1,$3,'Deletion member'),($2,$4,'Foreign deletion member')",
      [member, foreignMember, team, foreignTeam]
    );
    await admin.query(
      `INSERT INTO public.evaluations(id,member_id,kind,status,comments,created_at) VALUES
      ($1,$6,'manager','draft','{}','2026-11-01'),
      ($2,$6,'manager','published','{}','2026-11-02'),
      ($3,$6,'peer','published','{}','2026-11-03'),
      ($4,$6,'self','published','{}','2026-11-04'),
      ($5,$6,'self','draft','{}','2026-11-05'),
      ($7,$8,'manager','published','{}','2026-11-06')`,
      [
        managerDraft,
        managerPublished,
        peer,
        selfPublished,
        privateSelfDraft,
        member,
        foreignEvaluation,
        foreignMember,
      ]
    );
    await admin.query("COMMIT");

    await assert.rejects(
      api.laddersDeleteEvaluation(account.id, workspace, member, managerDraft),
      /owner access/
    );
    await admin.query(
      "INSERT INTO platform.grants(user_id,app,workspace_id,role) VALUES($1,'ladders',$2,'viewer')",
      [account.id, workspace]
    );
    await assert.rejects(
      api.laddersDeleteEvaluation(account.id, workspace, member, managerDraft),
      /owner access/
    );
    await admin.query(
      "UPDATE platform.grants SET role='editor' WHERE user_id=$1 AND app='ladders'",
      [account.id]
    );
    await assert.rejects(
      api.laddersDeleteEvaluation(account.id, workspace, member, managerDraft),
      /owner access/
    );
    await admin.query(
      "UPDATE platform.grants SET role='owner' WHERE user_id=$1 AND app='ladders'",
      [account.id]
    );
    await assert.rejects(
      api.laddersDeleteEvaluation(account.id, workspace, foreignMember, managerPublished),
      /Evaluation unavailable/
    );
    await assert.rejects(
      api.laddersDeleteEvaluation(account.id, workspace, member, randomUUID()),
      /Evaluation unavailable/
    );
    await assert.rejects(
      api.laddersDeleteEvaluation(account.id, workspace, member, privateSelfDraft),
      /Evaluation unavailable/
    );

    const remaining = (await api.laddersDeleteEvaluation(
      account.id,
      workspace,
      member,
      managerDraft
    )) as { id: string }[];
    assert.ok(remaining.every((evaluation) => evaluation.id !== managerDraft));
    assert.ok(remaining.some((evaluation) => evaluation.id === selfPublished));
    assert.ok(remaining.every((evaluation) => evaluation.id !== privateSelfDraft));
    await assert.rejects(
      api.pool.query("DELETE FROM public.evaluations WHERE id=$1", [managerPublished]),
      /permission denied/
    );
    await api.laddersDeleteEvaluation(account.id, workspace, member, managerPublished);
    await api.laddersDeleteEvaluation(account.id, workspace, member, peer);
    await api.laddersDeleteEvaluation(account.id, workspace, member, selfPublished);
    assert.deepEqual(
      (
        await admin.query("SELECT id FROM public.evaluations WHERE member_id=$1 ORDER BY id", [
          member,
        ])
      ).rows.map((row: { id: string }) => row.id),
      [privateSelfDraft].sort()
    );
    await admin.query("DELETE FROM platform.grants WHERE user_id=$1", [account.id]);
    await assert.rejects(
      api.laddersDeleteEvaluation(account.id, workspace, member, privateSelfDraft),
      /owner access/
    );
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
