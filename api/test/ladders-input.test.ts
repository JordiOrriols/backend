import test from "node:test";
import assert from "node:assert/strict";
import { memberProfileInput } from "../src/ladders-input.js";

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
