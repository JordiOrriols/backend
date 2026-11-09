import test from "node:test";
import assert from "node:assert/strict";
import {
  memberProfileInput,
  commentVisibilityInput,
  evaluationContentInput,
  evaluationStatusInput,
} from "../src/ladders-input.js";

test("evaluation content validates legacy half-step and comment limits without accepting identity or visibility fields", () => {
  const input = {
    current_levels: { Technology: 5.5 },
    goal_levels: {},
    comments: { Technology: "😀".repeat(2000) },
  };
  assert.deepEqual(
    evaluationContentInput({
      ...input,
      kind: "self",
      status: "published",
      member_id: "spoof",
      comment_visibility: { Technology: true },
    }),
    input
  );
  for (const patch of [
    { current_levels: { Technology: 6 } },
    { current_levels: { Technology: 0.25 } },
    { current_levels: { Technology: NaN } },
    { current_levels: { Unknown: 1 } },
    { goal_levels: [] },
    { comments: { Technology: "x".repeat(2001) } },
    { comments: { Technology: 1 } },
    { comments: null },
  ])
    assert.throws(() => evaluationContentInput({ ...input, ...patch }));
  assert.throws(() => evaluationContentInput({}));
  assert.equal(evaluationStatusInput({ status: "draft", kind: "self" }), "draft");
  assert.equal(evaluationStatusInput({ status: "published" }), "published");
  for (const body of [null, {}, { status: "other" }])
    assert.throws(() => evaluationStatusInput(body));
});

test("comment visibility requires an explicit boolean and ignores injected fields", () => {
  assert.equal(commentVisibilityInput({ visible: true, user_id: "spoof" }), true);
  assert.equal(commentVisibilityInput({ visible: false }), false);
  for (const body of [null, [], {}, { visible: "true" }, { visible: 1 }, { visible: null }])
    assert.throws(() => commentVisibilityInput(body));
});

test("member profiles validate complete fields and Unicode limits while ignoring identities and tokens", () => {
  const input = {
    name: " Local ",
    role: " Developer ",
    planning_role: "backend",
    template_id: "D3",
  };
  assert.deepEqual(
    memberProfileInput({
      ...input,
      owner_id: "spoof",
      user_id: "spoof",
      team_id: "spoof",
      self_token: "spoof",
    }),
    {
      name: "Local",
      role: "Developer",
      planning_role: "backend",
      template_id: "D3",
    }
  );
  assert.equal(
    memberProfileInput({
      ...input,
      name: "😀".repeat(120),
      role: "",
      planning_role: null,
      template_id: null,
    }).name.length,
    240
  );
  for (const body of [
    null,
    [],
    {},
    { ...input, name: " " },
    { ...input, name: "x".repeat(121) },
    { ...input, role: "x".repeat(121) },
    { ...input, planning_role: "other" },
    { ...input, template_id: "x".repeat(11) },
    { ...input, template_id: 1 },
  ]) {
    assert.throws(() => memberProfileInput(body));
  }
  assert.equal(
    memberProfileInput({ ...input, template_id: "x".repeat(10) }).template_id?.length,
    10
  );
});
