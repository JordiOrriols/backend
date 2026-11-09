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

test("Ladders comment visibility is edit-scoped and changes only metadata while preserving employee redaction", async () => {
  const admin = new Client({ connectionString: adminURL }),
    api = new PlatformDatabase(apiURL);
  await admin.connect();
  const owner = randomUUID(),
    workspace = randomUUID(),
    other = randomUUID(),
    team = randomUUID(),
    foreignTeam = randomUUID();
  const member = randomUUID(),
    secondMember = randomUUID(),
    foreignMember = randomUUID();
  const manager = randomUUID(),
    self = randomUUID(),
    selfDraft = randomUUID(),
    peer = randomUUID(),
    peerDraft = randomUUID(),
    foreign = randomUUID();
  const account = await api.account({
    issuer: "https://ladders-visibility.invalid",
    subject: randomUUID(),
    email: "local@example.invalid",
  });
  const visibleRows = async () =>
    (
      await admin.query(
        "SELECT id,comments FROM public.public_view((SELECT view_token FROM public.members WHERE id=$1)) ORDER BY id",
        [member]
      )
    ).rows;
  const snapshot = async () =>
    (
      await admin.query(
        "SELECT jsonb_agg(to_jsonb(e)-'comment_visibility' ORDER BY id) data FROM public.evaluations e WHERE member_id=$1",
        [member]
      )
    ).rows[0].data;
  try {
    await admin.query("BEGIN");
    await admin.query("SELECT set_config('request.jwt.claim.sub',$1,true)", [owner]);
    await admin.query("INSERT INTO auth.users(id) VALUES($1)", [owner]);
    await admin.query(
      "INSERT INTO public.workspaces(id,owner_id,name) VALUES($1,$3,'Visibility integration'),($2,$3,'Other visibility integration')",
      [workspace, other, owner]
    );
    await admin.query(
      "INSERT INTO public.teams(id,owner_id,workspace_id,name) VALUES($1,$3,$4,'Visibility team'),($2,$3,$5,'Foreign visibility team')",
      [team, foreignTeam, owner, workspace, other]
    );
    await admin.query(
      "INSERT INTO public.members(id,team_id,name,view_enabled) VALUES($1,$4,'Visibility member',true),($2,$4,'Second member',false),($3,$5,'Foreign member',false)",
      [member, secondMember, foreignMember, team, foreignTeam]
    );
    await admin.query(
      `INSERT INTO public.evaluations(id,member_id,kind,status,comments) VALUES
      ($1,$6,'manager','published','{"Technology":"Manager note","People":"Manager people"}'),
      ($2,$6,'self','published','{"Technology":"Self note"}'),
      ($3,$6,'self','draft','{"Technology":"Private self"}'),
      ($4,$6,'peer','published','{"Technology":"Peer note","People":"Peer people"}'),
      ($5,$6,'peer','draft','{"Technology":"Draft peer note"}'),
      ($7,$8,'manager','published','{"Technology":"Foreign note"}')`,
      [manager, self, selfDraft, peer, peerDraft, member, foreign, foreignMember]
    );
    await admin.query("COMMIT");
    const before = await snapshot();
    await assert.rejects(
      api.laddersCommentVisibility(account.id, workspace, member, peer, "Technology", true),
      /edit access/
    );
    await admin.query(
      "INSERT INTO platform.grants(user_id,app,workspace_id,role) VALUES($1,'planner',$2,'owner'),($1,'ladders',$2,'viewer')",
      [account.id, workspace]
    );
    await assert.rejects(
      api.laddersCommentVisibility(account.id, workspace, member, peer, "Technology", true),
      /edit access/
    );
    await admin.query(
      "UPDATE platform.grants SET role='editor' WHERE user_id=$1 AND app='ladders'",
      [account.id]
    );
    assert.deepEqual((await visibleRows()).find((row) => row.id === peer)?.comments, {});
    await assert.rejects(
      api.laddersCommentVisibility(account.id, workspace, member, foreign, "Technology", true),
      /Evaluation unavailable/
    );
    await assert.rejects(
      api.laddersCommentVisibility(account.id, workspace, secondMember, peer, "Technology", true),
      /Evaluation unavailable/
    );
    await assert.rejects(
      api.laddersCommentVisibility(account.id, workspace, member, selfDraft, "Technology", true),
      /Evaluation unavailable/
    );
    await assert.rejects(
      api.laddersCommentVisibility(account.id, workspace, member, randomUUID(), "Technology", true),
      /Evaluation unavailable/
    );
    for (const category of ["Unknown", "System"]) {
      await assert.rejects(
        api.laddersCommentVisibility(account.id, workspace, member, peer, category, true),
        /Choose an existing/
      );
    }
    await assert.rejects(
      api.pool.query("SELECT platform.ladders_comment_visibility($1,$2,$3,$4,$5,NULL)", [
        account.id,
        workspace,
        member,
        peer,
        "Technology",
      ]),
      /Choose an existing/
    );
    await api.laddersCommentVisibility(account.id, workspace, member, peer, "Technology", true);
    assert.deepEqual((await visibleRows()).find((row) => row.id === peer)?.comments, {
      Technology: "Peer note",
    });
    await api.laddersCommentVisibility(
      account.id,
      workspace,
      member,
      peerDraft,
      "Technology",
      true
    );
    assert.equal(
      (await visibleRows()).some((row) => row.id === peerDraft),
      false
    );
    await api.laddersCommentVisibility(account.id, workspace, member, manager, "Technology", false);
    assert.deepEqual((await visibleRows()).find((row) => row.id === manager)?.comments, {
      People: "Manager people",
    });
    await api.laddersCommentVisibility(account.id, workspace, member, self, "Technology", false);
    assert.deepEqual((await visibleRows()).find((row) => row.id === self)?.comments, {});
    await api.laddersCommentVisibility(account.id, workspace, member, peer, "Technology", false);
    assert.deepEqual((await visibleRows()).find((row) => row.id === peer)?.comments, {});
    await admin.query(
      "UPDATE platform.grants SET role='owner' WHERE user_id=$1 AND app='ladders'",
      [account.id]
    );
    await api.laddersCommentVisibility(account.id, workspace, member, manager, "Technology", true);
    await api.laddersCommentVisibility(account.id, workspace, member, self, "Technology", true);
    assert.deepEqual((await visibleRows()).find((row) => row.id === self)?.comments, {
      Technology: "Self note",
    });
    const history = await api.laddersEvaluations(account.id, workspace, member);
    assert.ok(Array.isArray(history));
    assert.equal(history.find((row) => row.id === peer)?.comments.Technology, "Peer note");
    await assert.rejects(
      api.pool.query("UPDATE public.evaluations SET comment_visibility='{}' WHERE id=$1", [peer]),
      /permission denied/
    );
    await admin.query("DELETE FROM platform.grants WHERE user_id=$1", [account.id]);
    await assert.rejects(
      api.laddersCommentVisibility(account.id, workspace, member, peer, "Technology", true),
      /edit access/
    );
    assert.deepEqual(await snapshot(), before);
  } finally {
    await admin.query("ROLLBACK");
    await admin.query("DELETE FROM platform.grants WHERE user_id=$1", [account.id]);
    await admin.query("DELETE FROM public.members WHERE id=ANY($1::uuid[])", [
      [member, secondMember, foreignMember],
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
