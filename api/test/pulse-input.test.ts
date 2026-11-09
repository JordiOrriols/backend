import test from "node:test";
import assert from "node:assert/strict";
import { surveyInput, surveyResponseInput, surveyStatusInput } from "../src/pulse-input.js";

test("survey validation preserves bounded Unicode text and exact question variants", () => {
  const valid = {
    title: " Team health ",
    asks_comment: true,
    min_responses: 3,
    questions: [{ key: "health" }, { prompt: " Clarity? ", low_label: " Low ", high_label: null }],
  };
  assert.deepEqual(surveyInput(valid), {
    ...valid,
    title: "Team health",
    questions: [
      { key: "health", prompt: null, low_label: null, high_label: null },
      { key: null, prompt: "Clarity?", low_label: "Low", high_label: null },
    ],
  });
  for (const change of [
    { title: " " },
    { title: "😀".repeat(121) },
    { asks_comment: 1 },
    { min_responses: 0 },
    { min_responses: 51 },
    { min_responses: 1.5 },
    { questions: [] },
    { questions: Array.from({ length: 13 }, () => ({ key: "health" })) },
    { questions: [{ key: "unknown" }] },
    { questions: [{ key: "health", prompt: "Both" }] },
    { questions: [{ prompt: "x".repeat(201) }] },
    { questions: [{ prompt: 123 }] },
    { questions: [{ prompt: "Scale", low_label: "" }] },
  ]) {
    assert.throws(() => surveyInput({ ...valid, ...change }));
  }
  for (const value of [null, [], "survey"]) assert.throws(() => surveyInput(value));
  assert.equal(surveyInput({ ...valid, title: "😀".repeat(120) }).title, "😀".repeat(120));
});
test("survey responses and status accept only bounded exact ratings", () => {
  const id = "10000000-0000-0000-0000-000000000001";
  assert.deepEqual(surveyResponseInput({ ratings: { [id]: 5 }, comment: " Notes " }), {
    ratings: { [id]: 5 },
    comment: "Notes",
  });
  for (const value of [
    null,
    [],
    { ratings: {}, comment: "" },
    { ratings: { [id]: 0 }, comment: "" },
    { ratings: { [id]: 6 }, comment: "" },
    { ratings: { [id]: 1.5 }, comment: "" },
    { ratings: { [id]: "5" }, comment: "" },
    { ratings: { unknown: 5 }, comment: "" },
    { ratings: { [id]: 5 }, comment: null },
    { ratings: { [id]: 5 }, comment: "a".repeat(2001) },
  ]) {
    assert.throws(() => surveyResponseInput(value));
  }
  assert.equal(surveyStatusInput({ status: "open" }), "open");
  assert.equal(surveyStatusInput({ status: "closed" }), "closed");
  for (const value of [null, [], { status: "deleted" }])
    assert.throws(() => surveyStatusInput(value));
});
