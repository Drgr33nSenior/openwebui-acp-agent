import test from "node:test";
import assert from "node:assert/strict";
import {
  prepareCheckpoint,
  recordCheckpoint,
  selectCheckpoint,
  checkpointRestore,
  markCheckpointUndone,
  checkpointSummaries,
  checkpointsSchema,
  CHECKPOINT_LIMIT,
  CheckpointError,
} from "../dist/checkpoints.js";

const prepare = (
  records,
  before = "original",
  after = "changed",
  path = "src/a.ts",
) => prepareCheckpoint(records, path, before, after);

test("checkpoint reservation is immutable and recording requires successful caller edit", () => {
  const original = [];
  const candidate = prepare(original);
  assert.deepEqual(original, []);
  const applied = recordCheckpoint(original, candidate);
  assert.deepEqual(original, []);
  assert.equal(selectCheckpoint(applied).id, candidate.id);
  assert.deepEqual(checkpointRestore(applied, candidate.id, "changed"), {
    checkpoint: candidate,
    before: "changed",
    after: "original",
  });
  assert.throws(
    () => checkpointRestore(applied, candidate.id, "user changed it"),
    /Stale checkpoint/,
  );
  assert.throws(
    () => checkpointRestore(applied, candidate.id, null),
    /Stale checkpoint/,
  );
  const undone = markCheckpointUndone(applied, candidate.id);
  assert.equal(applied[0].status, "applied");
  assert.equal(undone[0].status, "undone");
  assert.throws(() => selectCheckpoint(undone), /No applied checkpoint/);
  assert.deepEqual(
    checkpointsSchema.parse(JSON.parse(JSON.stringify(applied))),
    applied,
  );
});

test("checkpoints undo each file in reverse order without exposing content in listings", () => {
  let records = [];
  const first = prepare(records);
  records = recordCheckpoint(records, first);
  const other = prepare(
    records,
    "other original",
    "other changed",
    "other.txt",
  );
  records = recordCheckpoint(records, other);
  const second = prepare(records, "changed", "newer");
  records = recordCheckpoint(records, second);
  assert.throws(
    () => selectCheckpoint(records, first.id),
    /latest checkpoint for this file/,
  );
  assert.equal(selectCheckpoint(records, other.id).id, other.id);
  records = markCheckpointUndone(records, second.id);
  assert.equal(selectCheckpoint(records, first.id).id, first.id);
  const summaries = checkpointSummaries(records);
  assert(!JSON.stringify(summaries).includes("other original"));
  assert.deepEqual(Object.keys(summaries[0]).sort(), [
    "createdAt",
    "id",
    "operation",
    "path",
    "status",
  ]);
  const create = prepare([], null, "new file", "created.txt");
  assert.equal(checkpointRestore([create], create.id, "new file").after, null);
  assert.equal(checkpointSummaries([create])[0].operation, "create");
});

test("checkpoint schemas refuse invalid paths, duplicate IDs, binary text and credential-bearing snapshots", () => {
  for (const path of [
    "../outside",
    "/absolute",
    "a/../b",
    "a/./b",
    "C:/outside",
    "a\\b",
    "a/",
    ".",
    "a\0b",
  ])
    assert.throws(() => prepare([], "before", "after", path));
  assert.throws(() => prepare([], "same", "same"), /No file change/);
  assert.throws(() => prepare([], "text", "binary\0text"), /Binary/);
  assert.throws(
    () =>
      prepareCheckpoint([], "a.txt", "fixture-secret", "safe", (text) =>
        text.replace("fixture-secret", "[REDACTED]"),
      ),
    /configured credentials/,
  );
  assert.throws(
    () =>
      prepareCheckpoint([], "a.txt", "safe", "fixture-secret", (text) =>
        text.replace("fixture-secret", "[REDACTED]"),
      ),
    /configured credentials/,
  );
  const first = prepare([]);
  assert.throws(() => recordCheckpoint([first], first), /Duplicate checkpoint/);
  assert.throws(
    () => recordCheckpoint([], { ...first, status: "undone" }),
    /Only applied/,
  );
  assert.throws(
    () => selectCheckpoint([{ ...first, unexpected: true }]),
    /Saved checkpoints are invalid/,
  );
});

test("checkpoint failures expose fixed actionable messages without supplied values", () => {
  const secret = "synthetic-checkpoint-sensitive-field";
  const first = prepare([]);
  for (const action of [
    () => selectCheckpoint([{ ...first, [secret]: secret }]),
    () => selectCheckpoint([{ ...first, path: `../${secret}` }]),
    () => prepare([], "before", "after", `../${secret}`),
    () => checkpointRestore([first], first.id, secret),
  ])
    assert.throws(action, (error) => {
      assert(error instanceof CheckpointError);
      assert(!String(error).includes(secret));
      return true;
    });
});

test("checkpoint capacity is checked before edits and UTF-8 storage remains bounded", () => {
  let records = [];
  for (let i = 0; i < CHECKPOINT_LIMIT; i++) {
    const record = prepare(records, String(i), String(i + 1), `file-${i}.txt`);
    records = recordCheckpoint(records, record);
  }
  assert.throws(
    () => prepare(records),
    /Checkpoint limit reached.*checkpoints clear/,
  );
  assert.equal(records.length, CHECKPOINT_LIMIT);
  const unicode = "🌍".repeat(40000);
  const large = prepare([], unicode, unicode + "a");
  assert.throws(
    () => prepare([large], unicode, unicode + "b", "b.txt"),
    /storage budget/,
  );
  assert.equal(large.status, "applied");
});
