import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { Client } from "pg";
import { from as copyFrom } from "pg-copy-streams";

const connection = process.env.DATABASE_URL;
if (
  process.env.LOCAL_IMPORT_CONFIRM !== "local-only" ||
  !connection ||
  new URL(connection).hostname !== "db" ||
  new URL(connection).pathname !== "/platform"
)
  throw new Error("Import is restricted to the isolated Docker db/platform database");

const directory = "/backup";
const checksums = await readFile(`${directory}/SHA256SUMS`, "utf8");
for (const line of checksums.trim().split("\n")) {
  const match = /^([a-f0-9]{64})\s+([\w.-]+)$/.exec(line);
  if (!match) throw new Error("Invalid backup checksum file");
  const bytes = await readFile(`${directory}/${match[2]}`);
  if (createHash("sha256").update(bytes).digest("hex") !== match[1])
    throw new Error(`Backup checksum mismatch: ${match[2]}`);
}
const client = new Client({ connectionString: connection });
await client.connect();
try {
  const existing = await client.query("SELECT to_regclass('public.workspaces') AS existing");
  if (existing.rows[0]?.existing) throw new Error("Refusing to import over an existing database");
  await client.query("BEGIN");
  await client.query(`
    create role anon; create role authenticated; create role service_role;
    create schema auth;
    create table auth.users (
      id uuid primary key, email varchar(255), email_confirmed_at timestamptz,
      raw_user_meta_data jsonb not null default '{}'::jsonb
    );
    create function auth.uid() returns uuid language sql stable as $$
      select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid;
    $$;
    grant usage on schema auth,public to authenticated,anon;
    grant execute on function auth.uid() to authenticated,anon;
  `);
  const migrations = "/migrations";
  for (const file of (await readdir(migrations)).filter((name) => name.endsWith(".sql")).sort())
    await client.query(await readFile(`${migrations}/${file}`, "utf8"));

  await client.query("SET LOCAL session_replication_role=replica");
  const dump = await readFile(`${directory}/data.sql`, "utf8");
  const blocks = [
    ...dump.matchAll(/^COPY "(\w+)"\."(\w+)" \(([^;\n]+)\) FROM stdin;\n([\s\S]*?)^\\\.\r?$/gm),
  ];
  let imported = 0;
  for (const block of blocks) {
    const [, schema, table, columns, data] = block;
    if (schema === "auth" && table === "users") {
      const names = columns!.split(",").map((name) => name.trim().replaceAll('"', ""));
      if (!names.every((name) => /^\w+$/.test(name)))
        throw new Error("Unexpected auth dump columns");
      await client.query(
        `CREATE TEMP TABLE import_accounts (${names.map((name) => `"${name}" text`).join(",")})`
      );
      await pipeline(
        Readable.from([data!]),
        client.query(copyFrom(`COPY import_accounts (${columns}) FROM STDIN`))
      );
      await client.query(`
        INSERT INTO auth.users(id,email,email_confirmed_at,raw_user_meta_data)
        SELECT id::uuid,email,email_confirmed_at::timestamptz,
          coalesce(raw_user_meta_data::jsonb,'{}'::jsonb) FROM import_accounts;
        DROP TABLE import_accounts;
      `);
    } else if (schema === "public") {
      await pipeline(
        Readable.from([data!]),
        client.query(copyFrom(`COPY "${schema}"."${table}" (${columns}) FROM STDIN`))
      );
      imported++;
    }
  }
  if (!imported) throw new Error("Backup has no application tables");
  await client.query("SET LOCAL session_replication_role=origin");
  const foreignKeys = await client.query<{ query: string }>(`
    select format('SELECT count(*) AS invalid FROM %s child WHERE %s AND NOT EXISTS (SELECT 1 FROM %s parent WHERE %s)',
      c.conrelid::regclass,
      string_agg(format('child.%I IS NOT NULL',child.attname),' AND ' order by k.ordinality),
      c.confrelid::regclass,
      string_agg(format('child.%I=parent.%I',child.attname,parent.attname),' AND ' order by k.ordinality)) as query
    from pg_constraint c
    cross join lateral unnest(c.conkey,c.confkey) with ordinality k(child_key,parent_key,ordinality)
    join pg_attribute child on child.attrelid=c.conrelid and child.attnum=k.child_key
    join pg_attribute parent on parent.attrelid=c.confrelid and parent.attnum=k.parent_key
    where c.contype='f' and c.connamespace='public'::regnamespace
    group by c.oid,c.conrelid,c.confrelid
  `);
  for (const check of foreignKeys.rows) {
    const result = await client.query<{ invalid: string }>(check.query);
    if (result.rows[0]?.invalid !== "0")
      throw new Error("Imported database contains an invalid foreign key");
  }
  await client.query(await readFile("/platform-schema/platform.sql", "utf8"));
  for (const file of (await readdir("/platform-schema"))
    .filter((name) => /^\d.*\.sql$/.test(name))
    .sort())
    await client.query(await readFile(`/platform-schema/${file}`, "utf8"));
  const password = process.env.API_DATABASE_PASSWORD;
  if (!password || !/^[a-zA-Z0-9_-]{24,}$/.test(password))
    throw new Error("A strong local API database password is required");
  await client.query(`ALTER ROLE platform_api PASSWORD '${password}'`);
  await client.query("COMMIT");
  console.log(
    `Local import complete: ${imported} application tables, foreign keys verified. No passwords or sessions imported.`
  );
} catch (error) {
  await client.query("ROLLBACK");
  throw error;
} finally {
  await client.end();
}
