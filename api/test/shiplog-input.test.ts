import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  applicationInput,
  releaseInput,
  checklistInput,
  checklistCompletionInput,
  approvalInput,
  auditCursorInput,
} from "../src/shiplog-input.js";

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

  test("checklist templates validate exact limits and whitelist definitions; completion requires a boolean", () => {
    const item = { category: " QA ", title: " Check ", description: "Details", mandatory: true };
    assert.deepEqual(checklistInput({ revision: 0, items: [{ ...item, id: randomUUID() }] }), {
      revision: 0,
      items: [{ ...item, category: "QA", title: "Check" }],
    });

    test("approval input accepts explicit decisions and ignores caller-supplied identity", () => {
      assert.equal(approvalInput({ approved: true, user_id: randomUUID() }), true);
      assert.equal(approvalInput({ approved: false }), false);
      for (const invalid of [
        null,
        [],
        {},
        { approved: null },
        { approved: "true" },
        { approved: 0 },
      ])
        assert.throws(() => approvalInput(invalid));
    });

    test("audit pagination validates source and exact UUID cursor without accepting arrays or empty values", () => {
      const id = randomUUID();
      assert.equal(auditCursorInput(undefined), null);
      assert.deepEqual(auditCursorInput(`platform:${id}`), { source: "platform", id });
      assert.deepEqual(auditCursorInput(`legacy:${id}`), { source: "legacy", id });
      for (const invalid of [
        null,
        "",
        [],
        ["platform:" + id],
        "other:" + id,
        "platform:bad",
        `platform:${id}:extra`,
      ])
        assert.throws(() => auditCursorInput(invalid));
    });
    const max = {
      category: "c".repeat(80),
      title: "t".repeat(160),
      description: "d".repeat(4000),
      mandatory: false,
    };
    assert.equal(checklistInput({ revision: 10, items: Array(100).fill(max) }).items.length, 100);
    for (const invalid of [
      null,
      [],
      {},
      { revision: -1, items: [] },
      { revision: 0.5, items: [] },
      { revision: 2147483647, items: [] },
      { revision: 0, items: null },
      { revision: 0, items: Array(101).fill(item) },
      ...[
        null,
        [],
        { ...item, title: " " },
        { ...max, title: "t".repeat(161) },
        { ...max, category: "c".repeat(81) },
        { ...max, description: "d".repeat(4001) },
        { ...item, mandatory: "true" },
      ].map((value) => ({ revision: 0, items: [value] })),
    ])
      assert.throws(() => checklistInput(invalid));
    assert.equal(checklistCompletionInput({ completed: true, actor_id: randomUUID() }), true);
    assert.equal(checklistCompletionInput({ completed: false }), false);
    for (const invalid of [
      null,
      [],
      {},
      { completed: null },
      { completed: "false" },
      { completed: 1 },
    ])
      assert.throws(() => checklistCompletionInput(invalid));
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
