import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { APPLICATIONS, PlatformDatabase } from "../../src/database.js";
import { localPermissionConnection } from "../../scripts/local-permissions.js";

const adminURL = localPermissionConnection({
  DATABASE_URL: process.env.DATABASE_URL,
  LOCAL_PERMISSIONS_CONFIRM: "local-only",
});
const apiURL = process.env.API_DATABASE_URL;
if (!apiURL || new URL(apiURL).hostname !== "db")
  throw new Error("Isolated Docker database required");

test("native workspace lifecycle creates no legacy account and shares exact-recipient app roles with safe empty deletion", async () => {
  const admin = new Client({ connectionString: adminURL });
  const api = new PlatformDatabase(apiURL);
  await admin.connect();
  const identity = {
    issuer: "https://workspace-lifecycle.invalid",
    subject: randomUUID(),
    email: "same@example.invalid",
  };
  const owner = await api.account(identity),
    recipient = await api.account({ ...identity, subject: randomUUID() }),
    sameEmail = await api.account({ ...identity, subject: randomUUID() });
  const ids = [owner.id, recipient.id, sameEmail.id],
    workspaces: string[] = [];
  type Access = {
    grants: { account_id: string; role: string }[];
    invitations: { id: string; account_id: string; role: string }[];
  };
  const create = async () => {
    const saved = (await api.createWorkspace(owner.id, "  Native workspace  ")) as {
      id: string;
      name: string;
    };
    workspaces.push(saved.id);
    return saved;
  };
  try {
    const before = (await admin.query("SELECT count(*)::int AS n FROM auth.users")).rows[0].n;
    await assert.rejects(api.createWorkspace(owner.id, " "), /Workspace names/);
    await assert.rejects(api.createWorkspace(randomUUID(), "No identity"), /Verified account/);
    const saved = await create();
    assert.equal(saved.name, "Native workspace");
    const metadata = (
      await admin.query("SELECT owner_id,platform_owner_id FROM public.workspaces WHERE id=$1", [
        saved.id,
      ])
    ).rows[0];
    assert.equal(metadata.owner_id, null);
    assert.equal(metadata.platform_owner_id, owner.id);
    assert.equal(
      (await admin.query("SELECT count(*)::int AS n FROM auth.users")).rows[0].n,
      before
    );
    for (const app of APPLICATIONS) {
      assert.deepEqual(await api.workspaces(owner.id, app), [
        { id: saved.id, name: saved.name, role: "owner" },
      ]);
      assert.deepEqual(await api.workspaces(recipient.id, app), []);
    }
    const access = (
      action: "list" | "invite" | "update" | "remove",
      target: string | null = recipient.id,
      role: string | null = "viewer"
    ) =>
      api.workspaceAccessManagement(
        owner.id,
        saved.id,
        "planner",
        action,
        target,
        role
      ) as Promise<Access>;
    await assert.rejects(
      api.workspaceAccessManagement(recipient.id, saved.id, "planner", "list"),
      /owner access/
    );
    await assert.rejects(access("invite", owner.id), /Owner grants/);
    await assert.rejects(access("invite", randomUUID()), /first authenticate/);
    await assert.rejects(access("invite", recipient.id, "owner"), /Invalid workspace role/);
    await assert.rejects(
      api.workspaceAccessManagement(
        owner.id,
        saved.id,
        "ladders",
        "invite",
        recipient.id,
        "external"
      ),
      /Invalid workspace role/
    );
    const first = (await access("invite")).invitations[0]!;
    assert.ok(first);
    assert.deepEqual(await api.myWorkspaceInvitations(sameEmail.id), []);
    await assert.rejects(
      api.answerWorkspaceInvitation(sameEmail.id, first.id, true),
      /unavailable/
    );
    const rotated = (await access("invite", recipient.id, "external")).invitations[0]!;
    assert.notEqual(rotated.id, first.id);
    await assert.rejects(
      api.answerWorkspaceInvitation(recipient.id, first.id, true),
      /unavailable/
    );
    await access("remove");
    await assert.rejects(
      api.answerWorkspaceInvitation(recipient.id, rotated.id, true),
      /unavailable/
    );
    const expired = (await access("invite")).invitations[0]!;
    await admin.query(
      "UPDATE platform.workspace_invitations SET expires_at=now()-interval '1 second' WHERE id=$1",
      [expired.id]
    );
    assert.deepEqual(await api.myWorkspaceInvitations(recipient.id), []);
    await assert.rejects(
      api.answerWorkspaceInvitation(recipient.id, expired.id, true),
      /unavailable/
    );
    const declined = (await access("invite")).invitations[0]!;
    await api.answerWorkspaceInvitation(recipient.id, declined.id, false);
    assert.deepEqual(await api.workspaces(recipient.id, "planner"), []);
    const accepted = (await access("invite", recipient.id, "external")).invitations[0]!;
    const raced = await Promise.allSettled([
      api.answerWorkspaceInvitation(recipient.id, accepted.id, true),
      api.answerWorkspaceInvitation(recipient.id, accepted.id, true),
    ]);
    assert.equal(raced.filter((r) => r.status === "fulfilled").length, 1);
    assert.deepEqual(await api.workspaces(recipient.id, "planner"), [
      { id: saved.id, name: saved.name, role: "external" },
    ]);
    for (const app of APPLICATIONS.filter((app) => app !== "planner"))
      assert.deepEqual(await api.workspaces(recipient.id, app), []);
    await assert.rejects(
      api.workspaceAccessManagement(
        recipient.id,
        saved.id,
        "planner",
        "invite",
        sameEmail.id,
        "editor"
      ),
      /owner access/
    );
    await assert.rejects(access("invite"), /already has app access/);
    await access("update", recipient.id, "editor");
    assert.equal((await api.workspaces(recipient.id, "planner"))[0]?.role, "editor");
    await access("remove");
    assert.deepEqual(await api.workspaces(recipient.id, "planner"), []);
    assert.ok(await api.plannerSource(owner.id, saved.id));
    assert.deepEqual(await api.shiplogApplications(owner.id, saved.id), {
      applications: [],
      teams: [],
    });
    await api.laddersSaveTeam(owner.id, saved.id, "Native team", null);
    const roster = (await api.laddersTeams(owner.id, saved.id)) as { teams: { id: string }[] };
    const team = roster.teams[0]!.id;
    const created = (await api.laddersCreateMember(owner.id, saved.id, team, {
      name: "Native member",
      role: "",
      planning_role: null,
      template_id: null,
    })) as { id: string };
    assert.equal(
      (await admin.query("SELECT owner_id FROM public.members WHERE id=$1", [created.id])).rows[0]
        .owner_id,
      null
    );
    await assert.rejects(api.deleteWorkspace(owner.id, saved.id), /not empty/);
    await assert.rejects(api.deleteWorkspace(recipient.id, saved.id), /all five apps/);
    await api.laddersDeleteMember(owner.id, saved.id, created.id);
    const pending = (await access("invite")).invitations[0]!;
    await api.deleteWorkspace(owner.id, saved.id);
    assert.deepEqual(await api.workspaces(owner.id, "ladders"), []);
    assert.deepEqual(await api.myWorkspaceInvitations(recipient.id), []);
    await assert.rejects(
      api.answerWorkspaceInvitation(recipient.id, pending.id, true),
      /unavailable/
    );
    const retained = await create();
    await admin.query(
      "INSERT INTO platform.shiplog_audit_events(workspace_id,actor_id,event,details) VALUES($1,$2,'test','{}')",
      [retained.id, owner.id]
    );
    await assert.rejects(api.deleteWorkspace(owner.id, retained.id), /not empty/);
    await admin.query("DELETE FROM platform.shiplog_audit_events WHERE workspace_id=$1", [
      retained.id,
    ]);
    const busy = new Client({ connectionString: adminURL });
    await busy.connect();
    try {
      await busy.query("BEGIN");
      await busy.query("SELECT 1 FROM platform.grants WHERE workspace_id=$1 FOR SHARE", [
        retained.id,
      ]);
      await assert.rejects(api.deleteWorkspace(owner.id, retained.id), /access is busy/);
    } finally {
      await busy.query("ROLLBACK");
      await busy.end();
    }
    await api.deleteWorkspace(owner.id, retained.id);
    const privileges = await admin.query<{ denied: boolean }>(
      `SELECT NOT has_table_privilege(r, 'platform.workspace_invitations', 'SELECT')
        AND NOT has_function_privilege(r, 'platform.create_workspace(uuid,text)', 'EXECUTE')
        AND NOT has_function_privilege(r, 'platform.delete_workspace(uuid,uuid)', 'EXECUTE') AS denied
       FROM unnest(ARRAY['anon','authenticated','service_role']) r`
    );
    assert.ok(privileges.rows.every((row) => row.denied));
    assert.equal(
      (await admin.query("SELECT count(*)::int AS n FROM auth.users")).rows[0].n,
      before
    );
  } finally {
    await admin.query("ROLLBACK");
    await admin.query(
      "DELETE FROM platform.workspace_invitations WHERE workspace_id=ANY($1::uuid[])",
      [workspaces]
    );
    await admin.query(
      "DELETE FROM platform.shiplog_audit_events WHERE workspace_id=ANY($1::uuid[])",
      [workspaces]
    );
    await admin.query(
      "DELETE FROM public.members WHERE team_id IN (SELECT id FROM public.teams WHERE workspace_id=ANY($1::uuid[]))",
      [workspaces]
    );
    await admin.query(
      "UPDATE public.workspaces SET created_for_team=false WHERE id=ANY($1::uuid[])",
      [workspaces]
    );
    await admin.query("DELETE FROM public.teams WHERE workspace_id=ANY($1::uuid[])", [workspaces]);
    await admin.query("DELETE FROM platform.grants WHERE workspace_id=ANY($1::uuid[])", [
      workspaces,
    ]);
    await admin.query("DELETE FROM public.workspaces WHERE id=ANY($1::uuid[])", [workspaces]);
    await admin.query("DELETE FROM platform.identities WHERE user_id=ANY($1::uuid[])", [ids]);
    await admin.query("DELETE FROM platform.users WHERE id=ANY($1::uuid[])", [ids]);
    await Promise.all([admin.end(), api.pool.end()]);
  }
});
