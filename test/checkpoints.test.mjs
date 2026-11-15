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
  CHECKPOINT_BYTES,
  CHECKPOINT_TEXT_CHARS,
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

test("recording evicts the oldest checkpoints by count instead of refusing an edit", () => {
  let records = [];
  for (let i = 0; i < CHECKPOINT_LIMIT; i++) {
    const record = prepare(records, String(i), String(i + 1), `file-${i}.txt`);
    records = recordCheckpoint(records, record);
  }
  const full = records;
  const next = prepare(records);
  assert.equal(next.status, "applied");
  records = recordCheckpoint(records, next);
  assert.equal(full.length, CHECKPOINT_LIMIT, "input is not modified");
  assert.equal(records.length, CHECKPOINT_LIMIT);
  assert.deepEqual(
    records.map((r) => r.id),
    [...full.slice(1).map((r) => r.id), next.id],
  );
  // Undo after eviction reaches only what remains.
  let remaining = records;
  for (let i = 0; i < CHECKPOINT_LIMIT; i++)
    remaining = markCheckpointUndone(remaining, selectCheckpoint(remaining).id);
  assert.throws(() => selectCheckpoint(remaining), /No applied checkpoint/);
  assert(!remaining.some((r) => r.path === "file-0.txt"));
  assert.throws(
    () => recordCheckpoint(records, records[0]),
    /Duplicate checkpoint/,
  );
});

test("recording evicts the oldest checkpoints by bytes and keeps UTF-8 storage bounded", () => {
  const size = (records) => Buffer.byteLength(JSON.stringify(records));
  // About 384 KB each: 96,000 UTF-16 units, 192 KB of UTF-8, per side.
  const unicode = "🌍".repeat(48000);
  let records = [];
  const ids = [];
  for (let i = 0; i < 6; i++) {
    const record = prepare(records, unicode + i, unicode + "x" + i, `f${i}`);
    records = recordCheckpoint(records, record);
    ids.push(record.id);
    assert(size(records) <= CHECKPOINT_BYTES);
  }
  assert(size([records[0]]) > 380_000);
  // Five fit in 2 MB; the sixth evicted the first.
  assert.deepEqual(
    records.map((r) => r.id),
    ids.slice(1),
  );
  // A small edit evicts only as much as it needs.
  const small = prepare(records, "a", "b", "small.txt");
  const after = recordCheckpoint(records, small);
  assert.deepEqual(
    after.map((r) => r.id),
    [...ids.slice(1), small.id],
  );
  assert(CHECKPOINT_BYTES >= 2_000_000);
});

test("text too large to checkpoint returns no checkpoint instead of refusing", () => {
  const large = "x".repeat(CHECKPOINT_TEXT_CHARS + 1);
  assert.equal(prepare([], large, large + "y"), null);
  assert.equal(prepare([], "small", large), null);
  assert.equal(prepare([], null, large, "new.txt"), null);
  // The largest text that is kept still fits the byte budget on its own,
  // even when every character needs a six-byte JSON escape.
  const escaped = "\u0001".repeat(CHECKPOINT_TEXT_CHARS);
  const kept = prepare([], escaped, escaped.slice(1));
  assert.equal(kept.status, "applied");
  assert(Buffer.byteLength(JSON.stringify([kept])) <= CHECKPOINT_BYTES);
  // Path, binary and credential checks still refuse.
  assert.throws(() => prepare([], large, large + "y", "../x"), /Invalid/);
  assert.throws(() => prepare([], large, large + "\0"), /Binary/);
});
