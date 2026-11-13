import test from "node:test";
import assert from "node:assert/strict";
import {
  planSchema,
  planArgumentsSchema,
  planToolDefinition,
  planningInstruction,
} from "../dist/planning.js";

const entry = {
  content: "Inspect affected code",
  priority: "high",
  status: "pending",
};

test("plans validate ACP values, bounded entries and one active step", () => {
  assert.deepEqual(planSchema.parse([]), []);
  const valid = [
    { ...entry, status: "completed" },
    { ...entry, priority: "medium", status: "in_progress" },
    { ...entry, priority: "low" },
  ];
  assert.deepEqual(planArgumentsSchema.parse({ entries: valid }), {
    entries: valid,
  });
  assert.equal(
    planSchema.parse(Array.from({ length: 32 }, () => entry)).length,
    32,
  );
  assert.throws(() =>
    planSchema.parse(Array.from({ length: 33 }, () => entry)),
  );
  assert.throws(() =>
    planSchema.parse([
      { ...entry, status: "in_progress" },
      { ...entry, status: "in_progress" },
    ]),
  );
  for (const invalid of [
    { ...entry, content: "" },
    { ...entry, content: " \n " },
    { ...entry, content: "x".repeat(1001) },
    { ...entry, priority: "critical" },
    { ...entry, status: "blocked" },
    { ...entry, command: "unexpected executable configuration" },
  ])
    assert.throws(() => planSchema.parse([invalid]));
  assert.throws(() =>
    planArgumentsSchema.parse({ entries: [], approved: true }),
  );
});

test("plan definition describes full replacement, honest progress and no authority", () => {
  assert.equal(planToolDefinition.function.name, "update_plan");
  assert.equal(
    planToolDefinition.function.parameters.additionalProperties,
    false,
  );
  assert.equal(
    planToolDefinition.function.parameters.properties.entries.maxItems,
    32,
  );
  assert.match(
    planToolDefinition.function.description,
    /complete current plan/,
  );
  assert.match(
    planToolDefinition.function.description,
    /does not execute actions or grant permission/,
  );
  for (const mode of ["code", "plan"]) {
    assert.match(planningInstruction(mode), /multi-step tasks/);
    assert.match(
      planningInstruction(mode),
      /never claim success for blocked, untested or merely proposed work/,
    );
  }
  assert.match(
    planningInstruction("plan"),
    /Only list_files, read_file, search_text and update_plan/,
  );
  assert.match(
    planningInstruction("plan"),
    /do not apply edits, run commands or call MCP\/server tools/,
  );
  assert.match(planningInstruction("code"), /approval and sandbox policy/);
});
