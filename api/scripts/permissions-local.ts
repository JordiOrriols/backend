import { Client } from "pg";
import { localPermissionConnection, runPermissionCommand } from "./local-permissions.js";

async function main() {
  const client = new Client({ connectionString: localPermissionConnection(process.env) });
  await client.connect();
  try {
    console.log(JSON.stringify(await runPermissionCommand(client, process.argv.slice(2)), null, 2));
  } finally {
    await client.end();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Permission administration failed");
  process.exitCode = 1;
});
