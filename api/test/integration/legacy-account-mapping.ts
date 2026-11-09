import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { PlatformDatabase } from "../../src/database.js";
import {
  localPermissionConnection,
  runPermissionCommand,
} from "../../scripts/local-permissions.js";

const adminURL = localPermissionConnection({
  DATABASE_URL: process.env.DATABASE_URL,
  LOCAL_PERMISSIONS_CONFIRM: "local-only",
});
const apiURL = process.env.API_DATABASE_URL;
if (!apiURL || new URL(apiURL).hostname !== "db")
  throw new Error("Isolated Docker database required");

test("legacy mappings require explicit verified IDs, are one-to-one and never infer grants or mutate legacy records", async () => {
  const admin = new Client({ connectionString: adminURL });
  const secondAdmin = new Client({ connectionString: adminURL });
  const restricted = new Client({ connectionString: apiURL });
  const api = new PlatformDatabase(apiURL);
  await Promise.all([admin.connect(), secondAdmin.connect(), restricted.connect()]);
  const legacy = randomUUID(),
    otherLegacy = randomUUID(),
    workspace = randomUUID(),
    team = randomUUID(),
    member = randomUUID();
  const identity = {
    issuer: "https://legacy-mapping.invalid",
    subject: randomUUID(),
    email: "legacy-mapping@example.invalid",
  };
  const first = await api.account(identity);
  const secondIdentity = { ...identity, subject: randomUUID() };
  const second = await api.account(secondIdentity);
  const third = await api.account({ ...identity, subject: randomUUID() });
  let unverified: string | undefined;
  const readMappings = async () =>
    (
      await admin.query<{ user_id: string; legacy_user_id: string; created_at: Date }>(
        `SELECT user_id,legacy_user_id,created_at FROM platform.legacy_account_mappings
         WHERE user_id=ANY($1::uuid[]) ORDER BY user_id`,
        [[first.id, second.id, third.id]]
      )
    ).rows;
  const snapshot = async () =>
    (
      await admin.query(
        `SELECT jsonb_build_object(
          'workspace',(SELECT to_jsonb(w) FROM public.workspaces w WHERE id=$1),
          'team',(SELECT to_jsonb(t) FROM public.teams t WHERE id=$2),
          'member',(SELECT to_jsonb(m) FROM public.members m WHERE id=$3)
        ) AS data`,
        [workspace, team, member]
      )
    ).rows[0].data;
  try {
    await admin.query("BEGIN");
    await admin.query("SELECT set_config('request.jwt.claim.sub',$1,true)", [legacy]);
    await admin.query("INSERT INTO auth.users(id,email) VALUES($1,$3),($2,$3)", [
      legacy,
      otherLegacy,
      identity.email,
    ]);
    await admin.query(
      "INSERT INTO public.workspaces(id,owner_id,name) VALUES($1,$2,'Mapping fixture')",
      [workspace, legacy]
    );
    await admin.query(
      "INSERT INTO public.teams(id,owner_id,workspace_id,name) VALUES($1,$2,$3,'Mapping team')",
      [team, legacy, workspace]
    );
    await admin.query(
      "INSERT INTO public.members(id,team_id,name) VALUES($1,$2,'Mapping member')",
      [member, team]
    );
    await admin.query("SELECT set_config('members.claiming',$1,true)", [member]);
    await admin.query("UPDATE public.members SET user_id=$2 WHERE id=$1", [member, legacy]);
    const result = await admin.query<{ id: string }>(
      "INSERT INTO platform.users(email) VALUES($1) RETURNING id",
      [identity.email]
    );
    unverified = result.rows[0]!.id;
    await admin.query("COMMIT");
    const before = await snapshot();
    assert.deepEqual(await readMappings(), []);
    assert.deepEqual((await api.account(identity)).grants, []);
    await assert.rejects(
      runPermissionCommand(admin, ["map-legacy", unverified, legacy]),
      /must first authenticate/
    );
    await assert.rejects(
      runPermissionCommand(admin, ["map-legacy", randomUUID(), legacy]),
      /Unknown platform user/
    );
    await assert.rejects(
      runPermissionCommand(admin, ["map-legacy", first.id, randomUUID()]),
      /Unknown legacy user/
    );
    await runPermissionCommand(admin, ["map-legacy", first.id, legacy]);
    const initial = await readMappings();
    assert.equal(initial.length, 1);
    assert.equal(initial[0]?.legacy_user_id, legacy);
    await runPermissionCommand(admin, ["map-legacy", first.id, legacy]);
    assert.deepEqual(await readMappings(), initial);
    await assert.rejects(
      runPermissionCommand(admin, ["map-legacy", second.id, legacy]),
      /already mapped/
    );
    await assert.rejects(
      runPermissionCommand(admin, ["map-legacy", first.id, otherLegacy]),
      /already mapped/
    );
    await assert.rejects(
      runPermissionCommand(admin, ["unmap-legacy", first.id, otherLegacy]),
      /No matching legacy mapping/
    );
    assert.deepEqual(await readMappings(), initial);
    assert.deepEqual((await api.account(identity)).grants, []);
    assert.deepEqual((await api.account(secondIdentity)).grants, []);
    await assert.rejects(api.laddersTeams(first.id, workspace), /access required/i);

    await assert.rejects(
      restricted.query("SELECT * FROM platform.legacy_account_mappings"),
      /permission denied/
    );
    await assert.rejects(
      restricted.query(
        "INSERT INTO platform.legacy_account_mappings(user_id,legacy_user_id) VALUES($1,$2)",
        [second.id, otherLegacy]
      ),
      /permission denied/
    );
    await assert.rejects(
      restricted.query(
        "UPDATE platform.legacy_account_mappings SET legacy_user_id=$2 WHERE user_id=$1",
        [first.id, otherLegacy]
      ),
      /permission denied/
    );
    await assert.rejects(
      restricted.query("DELETE FROM platform.legacy_account_mappings WHERE user_id=$1", [first.id]),
      /permission denied/
    );
    await assert.rejects(
      runPermissionCommand(restricted, ["map-legacy", second.id, otherLegacy]),
      /permission denied/
    );
    await assert.rejects(
      runPermissionCommand(restricted, ["unmap-legacy", first.id, legacy]),
      /permission denied/
    );
    const roles = await admin.query<{ denied: boolean }>(
      `SELECT NOT has_table_privilege(r, 'platform.legacy_account_mappings', 'SELECT')
        AND NOT has_table_privilege(r, 'platform.legacy_account_mappings', 'INSERT')
        AND NOT has_table_privilege(r, 'platform.legacy_account_mappings', 'UPDATE')
        AND NOT has_table_privilege(r, 'platform.legacy_account_mappings', 'DELETE') AS denied
       FROM unnest(ARRAY['anon','authenticated','service_role','platform_api']) r`
    );
    assert.ok(roles.rows.every((row) => row.denied));
    const commands = await runPermissionCommand(admin, ["mappings"]);
    assert.ok(Array.isArray(commands));
    assert.ok(commands.some((row) => row.user_id === first.id && row.legacy_user_id === legacy));
    const legacyUsers = await runPermissionCommand(admin, ["legacy-users"]);
    assert.ok(Array.isArray(legacyUsers));
    assert.ok(legacyUsers.some((row) => row.id === legacy));

    await runPermissionCommand(admin, ["grant", first.id, "planner", workspace, "viewer"]);
    await runPermissionCommand(admin, ["unmap-legacy", first.id, legacy]);
    assert.deepEqual(await readMappings(), []);
    assert.deepEqual((await api.account(identity)).grants, [
      { app: "planner", workspaceId: workspace, role: "viewer" },
    ]);
    await assert.rejects(
      runPermissionCommand(admin, ["unmap-legacy", first.id, legacy]),
      /No matching legacy mapping/
    );
    const attempts = await Promise.allSettled([
      runPermissionCommand(admin, ["map-legacy", second.id, legacy]),
      runPermissionCommand(secondAdmin, ["map-legacy", third.id, legacy]),
    ]);
    assert.equal(attempts.filter((attempt) => attempt.status === "fulfilled").length, 1);
    assert.equal(attempts.filter((attempt) => attempt.status === "rejected").length, 1);
    assert.equal((await readMappings()).length, 1);
    assert.deepEqual(await snapshot(), before);
  } finally {
    await admin.query("ROLLBACK");
    await admin.query(
      "DELETE FROM platform.legacy_account_mappings WHERE legacy_user_id=ANY($1::uuid[])",
      [[legacy, otherLegacy]]
    );
    await admin.query("DELETE FROM platform.grants WHERE workspace_id=$1", [workspace]);
    await admin.query("DELETE FROM public.members WHERE id=$1", [member]);
    await admin.query("DELETE FROM public.teams WHERE workspace_id=$1", [workspace]);
    await admin.query("DELETE FROM public.workspaces WHERE id=$1", [workspace]);
    await admin.query("DELETE FROM auth.users WHERE id=ANY($1::uuid[])", [[legacy, otherLegacy]]);
    const accounts = [first.id, second.id, third.id, ...(unverified ? [unverified] : [])];
    await admin.query("DELETE FROM platform.identities WHERE user_id=ANY($1::uuid[])", [accounts]);
    await admin.query("DELETE FROM platform.users WHERE id=ANY($1::uuid[])", [accounts]);
    await Promise.all([admin.end(), secondAdmin.end(), restricted.end(), api.pool.end()]);
  }
});
