import { randomUUID } from "node:crypto";
import { isAbsolute, posix } from "node:path";
import { z } from "zod";

export const CHECKPOINT_LIMIT = 20;
export const CHECKPOINT_BYTES = 500_000;
export class CheckpointError extends Error {}

const storageError =
  "Checkpoint storage budget exceeded; use /checkpoints clear before editing";
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
  .max(100_000)
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
    storageError,
  );

function validatedRecords(records: Checkpoint[]): Checkpoint[] {
  const result = checkpointsSchema.safeParse(records);
  if (result.success) return result.data;
  // Do not expose Zod errors: unknown field names and supplied values may be
  // sensitive. Only our fixed, actionable messages may leave this module.
  if (
    result.error.issues.some(
      (issue) => issue.code === "too_big" && issue.path.length === 0,
    )
  )
    throw new CheckpointError(
      `Checkpoint limit reached (${CHECKPOINT_LIMIT}); use /checkpoints clear before editing`,
    );
  if (result.error.issues.some((issue) => issue.message === storageError))
    throw new CheckpointError(storageError);
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
export function prepareCheckpoint(
  records: Checkpoint[],
  path: string,
  before: string | null,
  after: string,
  redact: (text: string) => string = (text) => text,
): Checkpoint {
  validatedRecords(records);
  if (before === after)
    throw new CheckpointError("No file change to checkpoint");
  if ((before !== null && redact(before) !== before) || redact(after) !== after)
    throw new CheckpointError(
      "Cannot checkpoint text containing configured credentials",
    );
  const candidate = checkpointSchema.safeParse({
    id: randomUUID(),
    path,
    before,
    after,
    createdAt: new Date().toISOString(),
    status: "applied",
  });
  if (!candidate.success) {
    if (
      candidate.error.issues.some(
        (issue) => issue.message === "Binary checkpoint content refused",
      )
    )
      throw new CheckpointError("Binary checkpoint content refused");
    throw new CheckpointError(
      "Invalid checkpoint path or text size; nothing changed",
    );
  }
  const checkpoint = candidate.data;
  // Reserve capacity before asking for approval or mutating a workspace file.
  validatedRecords([...records, checkpoint]);
  return checkpoint;
}

export function recordCheckpoint(
  records: Checkpoint[],
  checkpoint: Checkpoint,
): Checkpoint[] {
  if (checkpoint.status !== "applied")
    throw new CheckpointError("Only applied edits can be recorded");
  return validatedRecords([...records, checkpoint]);
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
