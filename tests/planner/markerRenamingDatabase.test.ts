// @vitest-environment node
import { expect, it } from "vitest";
import { createMigratedDatabase } from "../../testing/migratedDatabase.js";

it("allows owners and editors to rename, but not viewers or anonymous users, preserving marker identity/date", async () => {
  const owner = "11111111-1111-4111-8111-111111111111";
  const editor = "22222222-2222-4222-8222-222222222222";
  const viewer = "33333333-3333-4333-8333-333333333333";
  const stranger = "44444444-4444-4444-8444-444444444444";
  const db = await createMigratedDatabase(
    [owner, editor, viewer, stranger].map((id, i) => ({
      id,
      email: `marker${i}@example.com`,
    }))
  );
  async function login(id: string, role = "authenticated") {
    await db.exec("reset role");
    await db.query("select set_config('request.jwt.claim.sub',$1,false)", [id]);
    await db.exec(`set role ${role}`);
  }
  try {
    await login(owner);
    const workspace = (
      await db.query<{ id: string }>("select id from public.create_workspace('Rename')")
    ).rows[0]!.id;
    await db.query("select public.share_workspace($1,'marker1@example.com','planner','editor')", [
      workspace,
    ]);
    await db.query("select public.share_workspace($1,'marker2@example.com','planner','viewer')", [
      workspace,
    ]);
    const marker = (
      await db.query<{ id: string }>(
        "insert into public.roadmap_markers(workspace_id,name,date) values($1,'Launch','2026-02-04') returning id",
        [workspace]
      )
    ).rows[0]!.id;
    for (const account of [owner, editor]) {
      await login(account);
      expect(
        (
          await db.query(
            "update public.roadmap_markers set name='Renamed' where id=$1 returning id,name,date::text,workspace_id",
            [marker]
          )
        ).rows
      ).toEqual([{ id: marker, name: "Renamed", date: "2026-02-04", workspace_id: workspace }]);
      for (const name of ["", " ", "x".repeat(81)])
        await expect(
          db.query("update public.roadmap_markers set name=$2 where id=$1", [marker, name])
        ).rejects.toThrow();
      for (const assignment of [
        "date='2026-03-01'",
        "workspace_id=gen_random_uuid()",
        "id=gen_random_uuid()",
      ])
        await expect(
          db.query(`update public.roadmap_markers set ${assignment} where id=$1`, [marker])
        ).rejects.toThrow(/permission denied/);
    }
    for (const account of [viewer, stranger]) {
      await login(account);
      expect(
        (
          await db.query(
            "update public.roadmap_markers set name='Blocked' where id=$1 returning id",
            [marker]
          )
        ).rows
      ).toEqual([]);
    }
    await login("", "anon");
    await expect(
      db.query("update public.roadmap_markers set name='Blocked' where id=$1", [marker])
    ).rejects.toThrow(/permission denied/);
  } finally {
    await db.close();
  }
});
