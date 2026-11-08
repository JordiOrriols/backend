import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { applicationInput } from "../src/shiplog-input.js";

test("application inputs validate limits, require explicit team and whitelist editable fields", () => {
  const input = { name: "  Core  ", description: "Details", team_id: randomUUID() };
  assert.deepEqual(applicationInput({ ...input, id: randomUUID(), workspace_id: randomUUID() }), {
    ...input,
    name: "Core",
  });
  assert.deepEqual(
    applicationInput({ name: "a".repeat(120), description: "d".repeat(4000), team_id: null }),
    { name: "a".repeat(120), description: "d".repeat(4000), team_id: null }
  );
  for (const invalid of [
    null,
    [],
    {},
    { ...input, name: " " },
    { ...input, name: "a".repeat(121) },
    { ...input, description: null },
    { ...input, description: "d".repeat(4001) },
    { ...input, team_id: undefined },
    { ...input, team_id: "bad" },
  ])
    assert.throws(() => applicationInput(invalid));
});
