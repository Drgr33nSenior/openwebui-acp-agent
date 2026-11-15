import { randomUUID } from "node:crypto";
import { isAbsolute, posix } from "node:path";
import { z } from "zod";

// Undo history is bounded: recording a checkpoint evicts the oldest ones until
// the new one fits, so checkpoint storage never blocks an edit.
export const CHECKPOINT_LIMIT = 20;
// Two text fields of CHECKPOINT_TEXT_CHARS each serialize to at most 1.2 MB of
// JSON (six bytes per escaped control character), so every checkpoint fits.
// The 8 MB session record keeps at least 5.8 MB for the transcript.
export const CHECKPOINT_BYTES = 2_000_000;
// Reads and edits already cap file text at this size; prepareCheckpoint returns
// no checkpoint for larger text rather than refusing the edit.
export const CHECKPOINT_TEXT_CHARS = 100_000;
export class CheckpointError extends Error {}
const checkpointPath = z
  .string()
  .min(1)
  .max(4096)
  .refine(
    (path) =>
      !isAbsolute(path) &&
      !/^[A-Za-z]:/.test(path) &&
      !path.includes("\\") &&
      !path.includes("\0") &&
      !path.endsWith("/") &&
      !path.split("/").includes("..") &&
      path !== "." &&
      posix.normalize(path) === path,
    "Checkpoint path must be a normalized workspace-relative file path",
  );
const textContent = z
  .string()
  .max(CHECKPOINT_TEXT_CHARS)
  .refine(
    (value) => !value.includes("\0"),
    "Binary checkpoint content refused",
  );
export const checkpointSchema = z
  .object({
    id: z.string().uuid(),
    path: checkpointPath,
    before: textContent.nullable(),
    after: textContent,
    createdAt: z.string().datetime(),
    status: z.enum(["applied", "undone"]),
  })
  .strict();
export type Checkpoint = z.infer<typeof checkpointSchema>;
export const checkpointsSchema = z
  .array(checkpointSchema)
  .max(CHECKPOINT_LIMIT)
  .refine(
    (records) =>
      new Set(records.map((record) => record.id)).size === records.length,
    "Duplicate checkpoint IDs",
  )
  .refine(
    (records) =>
      Buffer.byteLength(JSON.stringify(records), "utf8") <= CHECKPOINT_BYTES,
    "Checkpoint storage budget exceeded",
  );

function validatedRecords(records: Checkpoint[]): Checkpoint[] {
  const result = checkpointsSchema.safeParse(records);
  if (result.success) return result.data;
  // Do not expose Zod errors: unknown field names and supplied values may be
  // sensitive. Only our fixed, actionable messages may leave this module.
  if (
    result.error.issues.some(
      (issue) => issue.message === "Duplicate checkpoint IDs",
    )
  )
    throw new CheckpointError(
      "Duplicate checkpoint IDs; saved checkpoints are invalid",
    );
  throw new CheckpointError("Saved checkpoints are invalid; nothing changed");
}

// Reversible snapshots must remain exact. Never redact bytes and then use those
// altered bytes to restore a file. Callers keep snapshots in private state only,
// exclude sensitive paths, and supply their configured-secret redactor here.
// Returns null when the text is too large to keep: the caller may still make
// the edit, but nothing can undo or rewind it.
export function prepareCheckpoint(
  records: Checkpoint[],
  path: string,
  before: string | null,
  after: string,
  redact: (text: string) => string = (text) => text,
): Checkpoint | null {
  validatedRecords(records);
  if (before === after)
    throw new CheckpointError("No file change to checkpoint");
  if ((before !== null && redact(before) !== before) || redact(after) !== after)
    throw new CheckpointError(
      "Cannot checkpoint text containing configured credentials",
    );
  if (!checkpointPath.safeParse(path).success)
    throw new CheckpointError("Invalid checkpoint path; nothing changed");
  if (before?.includes("\0") || after.includes("\0"))
    throw new CheckpointError("Binary checkpoint content refused");
  if (
    (before?.length ?? 0) > CHECKPOINT_TEXT_CHARS ||
    after.length > CHECKPOINT_TEXT_CHARS
  )
    return null;
  const candidate = checkpointSchema.safeParse({
    id: randomUUID(),
    path,
    before,
    after,
    createdAt: new Date().toISOString(),
    status: "applied",
  });
  if (!candidate.success)
    throw new CheckpointError("Invalid checkpoint; nothing changed");
  return byteSize(candidate.data) + 2 > CHECKPOINT_BYTES
    ? null
    : candidate.data;
}

const byteSize = (value: unknown) =>
  Buffer.byteLength(JSON.stringify(value), "utf8");

// Adds an applied checkpoint, evicting the oldest records (first in, first
// out) until the list fits CHECKPOINT_LIMIT and CHECKPOINT_BYTES. Callers find
// evicted records by ID. Never refuses for capacity: prepareCheckpoint returns
// null for a checkpoint that cannot fit on its own.
export function recordCheckpoint(
  records: Checkpoint[],
  checkpoint: Checkpoint,
): Checkpoint[] {
  if (checkpoint.status !== "applied")
    throw new CheckpointError("Only applied edits can be recorded");
  if (records.some((record) => record.id === checkpoint.id))
    throw new CheckpointError(
      "Duplicate checkpoint IDs; saved checkpoints are invalid",
    );
  const next = [...validatedRecords(records), checkpoint];
  // JSON array size: brackets, records and the commas between them.
  const sizes = next.map(byteSize);
  let bytes = 1 + sizes.reduce((sum, size) => sum + size + 1, 0);
  let first = 0;
  while (
    first < next.length - 1 &&
    (next.length - first > CHECKPOINT_LIMIT || bytes > CHECKPOINT_BYTES)
  )
    bytes -= sizes[first++]! + 1;
  return validatedRecords(next.slice(first));
}

export function selectCheckpoint(
  records: Checkpoint[],
  id = "latest",
): Checkpoint {
  const validated = validatedRecords(records);
  const record =
    id === "latest"
      ? validated.findLast((item) => item.status === "applied")
      : validated.find((item) => item.id === id && item.status === "applied");
  if (!record) throw new CheckpointError("No applied checkpoint found");
  const latest = validated.findLast(
    (item) => item.path === record.path && item.status === "applied",
  );
  if (latest?.id !== record.id)
    throw new CheckpointError("Undo the latest checkpoint for this file first");
  return record;
}

export function checkpointRestore(
  records: Checkpoint[],
  id: string,
  current: string | null,
) {
  const checkpoint = selectCheckpoint(records, id);
  if (current !== checkpoint.after)
    throw new CheckpointError(
      "Stale checkpoint: file changed since the agent edit; nothing restored",
    );
  return { checkpoint, before: checkpoint.after, after: checkpoint.before };
}

// Call only after the approved restore/delete succeeded. Never replay on load.
export function markCheckpointUndone(
  records: Checkpoint[],
  id: string,
): Checkpoint[] {
  selectCheckpoint(records, id);
  return validatedRecords(
    records.map((record) =>
      record.id === id ? { ...record, status: "undone" } : record,
    ),
  );
}

export function checkpointSummaries(records: Checkpoint[]) {
  return validatedRecords(records).map(
    ({ id, path, createdAt, status, before }) => ({
      id,
      path,
      createdAt,
      status,
      operation: before === null ? "create" : "edit",
    }),
  );
}
