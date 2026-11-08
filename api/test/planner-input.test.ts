import assert from "node:assert/strict";
import { test } from "node:test";
import {
  priorityInput,
  proposalInput,
  markerInput,
  markerNameInput,
  projectNameInput,
  featureInput,
  inclusionInput,
  dateInput,
  vacationInput,
  calibrationInput,
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
test("vacation input enforces exact booleans and inclusive ranges of at most 366 days", () => {
  const range = { start: "2026-01-01", end: "2027-01-01", working: false };
  assert.deepEqual(vacationInput(range), range);
  assert.deepEqual(vacationInput({ ...range, end: range.start, working: true }), {
    ...range,
    end: range.start,
    working: true,
  });
  for (const invalid of [
    null,
    [],
    {},
    { ...range, working: "false" },
    { ...range, end: "2027-01-02" },
    { ...range, end: "2025-12-31" },
    { ...range, start: "2026-02-30" },
  ])
    assert.throws(() => vacationInput(invalid));
});
test("calibration input validates shape and finite nonnegative points before domain validation", () => {
  const calibration = {
    anchor: "2026-02-02",
    history: [{ start_date: "2026-02-02", story_points: 12.5 }],
  };
  assert.deepEqual(calibrationInput(calibration), calibration);
  for (const invalid of [
    null,
    [],
    {},
    { ...calibration, history: null },
    { ...calibration, anchor: "bad" },
    ...[-1, NaN, Infinity, "1", null].map((story_points) => ({
      ...calibration,
      history: [{ start_date: "2026-02-02", story_points }],
    })),
    { ...calibration, history: [{ start_date: "2026-02-30", story_points: 1 }] },
  ])
    assert.throws(() => calibrationInput(invalid));
});
test("roadmap inclusion accepts only booleans and plan dates must be real calendar days", () => {
  assert.equal(inclusionInput({ included: true }), true);
  assert.equal(inclusionInput({ included: false }), false);
  for (const included of [undefined, null, "true", 0, 1])
    assert.throws(() => inclusionInput({ included }));
  assert.equal(dateInput({ date: "2026-02-02" }), "2026-02-02");
  for (const date of [undefined, null, "", "2026-02-30", "2026-2-2"])
    assert.throws(() => dateInput({ date }));
});

const feature = {
  name: "Feature",
  description: "Private details",
  project_id: input.featureIds[0],
  status: "pending",
  dependency_ids: [],
  backend_devs: 1,
  backend_weeks: 2,
  frontend_devs: 0,
  frontend_weeks: 0,
  design_devs: 0,
  design_weeks: 0,
  qa_devs: 0,
  qa_weeks: 0,
};
test("feature input whitelists editable fields and validates names, status and dependency IDs", () => {
  assert.deepEqual(
    featureInput({ ...feature, name: " Feature ", id: "injected", in_backlog: true, priority: 99 }),
    feature
  );
  assert.equal(featureInput({ ...feature, name: "a".repeat(120) }).name.length, 120);
  for (const invalid of [
    null,
    [],
    {},
    { ...feature, name: "" },
    { ...feature, name: "a".repeat(121) },
    { ...feature, description: null },
    { ...feature, project_id: "bad" },
    { ...feature, status: "unknown" },
    { ...feature, dependency_ids: null },
    { ...feature, dependency_ids: ["bad"] },
    { ...feature, dependency_ids: [input.featureIds[0], input.featureIds[0]] },
  ])
    assert.throws(() => featureInput(invalid));
});
test("feature estimates require bounded whole units and complete role pairs", () => {
  for (const role of ["backend", "frontend", "design", "qa"])
    for (const [devs, weeks] of [
      [-1, 1],
      [101, 1],
      [1, 105],
      [1.5, 1],
      [1, 1.5],
      [NaN, 1],
      [1, Infinity],
      [0, 1],
      [1, 0],
    ])
      assert.throws(() =>
        featureInput({ ...feature, [`${role}_devs`]: devs, [`${role}_weeks`]: weeks })
      );
  assert.equal(
    featureInput({ ...feature, backend_devs: 100, backend_weeks: 104 }).backend_weeks,
    104
  );
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
test("project names reuse the same trimmed 1-80 character validation", () => {
  assert.equal(projectNameInput({ name: " Project " }), "Project");
  assert.equal(projectNameInput({ name: "p".repeat(80) }).length, 80);
  for (const name of ["", " ", "p".repeat(81), null])
    assert.throws(() => projectNameInput({ name }));
});
