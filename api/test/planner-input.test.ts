import assert from "node:assert/strict";
import { test } from "node:test";
import {
  priorityInput,
  proposalInput,
  markerInput,
  markerNameInput,
} from "../src/planner-input.js";

const input = {
  featureIds: ["11111111-1111-4111-8111-111111111111"],
  expectedRevision: "a".repeat(32),
};
test("priority requests require a canonical revision and a unique UUID order", () => {
  assert.deepEqual(priorityInput(input), input);
  assert.deepEqual(priorityInput({ ...input, featureIds: [] }), { ...input, featureIds: [] });
  for (const invalid of [
    undefined,
    null,
    [],
    "text",
    {},
    { ...input, featureIds: "bad" },
    { ...input, featureIds: ["bad"] },
    { ...input, featureIds: [null] },
    { ...input, featureIds: [...input.featureIds, ...input.featureIds] },
    { ...input, expectedRevision: null },
    { ...input, expectedRevision: "stale" },
  ])
    assert.throws(() => priorityInput(invalid));
});
test("proposal names must be nonempty, trimmed and at most 120 characters", () => {
  assert.deepEqual(proposalInput({ ...input, name: "  Alternative  " }), {
    ...input,
    name: "Alternative",
  });
  assert.equal(proposalInput({ ...input, name: "é".repeat(120) }).name.length, 120);
  for (const name of [undefined, null, 1, "", "   ", "é".repeat(121)])
    assert.throws(() => proposalInput({ ...input, name }));
});
test("markers validate names and real calendar dates without accepting normalized invalid days", () => {
  assert.equal(markerNameInput({ name: " Launch " }), "Launch");
  for (const name of ["", "  ", "x".repeat(81), null])
    assert.throws(() => markerNameInput({ name }));
  for (const date of ["2026-02-02", "2024-02-29", "0001-01-01", "9999-12-31"])
    assert.deepEqual(markerInput({ name: "Launch", date }), { name: "Launch", date });
  for (const date of [null, "", "2026-02-30", "2026-02-29", "0000-01-01", "2026-13-01", "2026-2-2"])
    assert.throws(() => markerInput({ name: "Launch", date }));
});
