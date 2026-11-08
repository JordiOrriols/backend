import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { applicationInput, releaseInput } from "../src/shiplog-input.js";

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

test("release configuration validates semantic versions, explicit links and editable fields", () => {
  const input = {
    application_id: randomUUID(),
    version: "1.2.3-rc.1+build.42",
    title: "  Release  ",
    public_notes: "Notes",
    status: "qa",
    feature_ids: [randomUUID()],
  };
  assert.deepEqual(releaseInput({ ...input, created_by: randomUUID() }), {
    ...input,
    title: "Release",
  });
  assert.equal(
    releaseInput({ ...input, version: "1.0.0+" + "a".repeat(94), feature_ids: null }).version
      .length,
    100
  );
  for (const invalid of [
    null,
    [],
    {},
    { ...input, version: "01.0.0" },
    { ...input, version: "1.0.0-01" },
    { ...input, version: "1.0.0+" + "a".repeat(95) },
    { ...input, title: " " },
    { ...input, title: "a".repeat(161) },
    { ...input, public_notes: "a".repeat(20001) },
    { ...input, status: "published" },
    { ...input, feature_ids: undefined },
    { ...input, feature_ids: ["bad"] },
    { ...input, feature_ids: [null] },
    { ...input, application_id: "bad" },
  ])
    assert.throws(() => releaseInput(invalid));
});
