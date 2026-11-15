import { z } from "zod";
import type { Message } from "./backend.js";
import { CheckpointError, type Checkpoint } from "./checkpoints.js";
import { isImageMessage } from "./images.js";
import {
  compactionStateSchema,
  PROJECT_GUIDANCE_PREFIX,
  STEERING_PREFIX,
  type CompactionState,
} from "./compaction.js";

// Checkpoints recorded before turn tracking, or kept after a conversation-only
// rewind, belong to no rewindable turn. Rewind never reverts them.
export const UNTRACKED_TURN = 0;

// Checkpoint ID -> 1-based user turn that created it. Bounded by the checkpoint
// limit; stored beside checkpoints so their strict schema stays unchanged.
export const checkpointTurnsSchema = z
  .record(z.string().uuid(), z.number().int().min(0).max(100_000))
  .refine((value) => Object.keys(value).length <= 64, "Too many turn tags");
export type CheckpointTurns = z.infer<typeof checkpointTurnsSchema>;

// Indices of user messages that start a rewindable point, in order. Legacy
// project guidance stored as a user message is not a turn, and neither is a
// view_image attachment (tool output in a user-role message).
export function userTurns(messages: Message[]): number[] {
  const result: number[] = [];
  messages.forEach((m, index) => {
    if (
      m.role === "user" &&
      !m.content?.startsWith(PROJECT_GUIDANCE_PREFIX) &&
      !isImageMessage(m)
    )
      result.push(index);
  });
  return result;
}

// Tag new checkpoints with the current turn and drop tags for removed ones.
export function tagCheckpoints(
  tags: CheckpointTurns,
  checkpoints: Checkpoint[],
  turn: number,
): CheckpointTurns {
  const result: CheckpointTurns = {};
  for (const checkpoint of checkpoints)
    result[checkpoint.id] = tags[checkpoint.id] ?? turn;
  return result;
}

export type TurnSummary = {
  turn: number;
  preview: string;
  agentEdits: number;
};

export function turnSummaries(
  messages: Message[],
  checkpoints: Checkpoint[],
  tags: CheckpointTurns,
): TurnSummary[] {
  return userTurns(messages).map((index, i) => {
    const content = messages[index]!.content ?? "";
    const text = (
      content.startsWith(STEERING_PREFIX)
        ? "(steering) " + content.slice(STEERING_PREFIX.length)
        : content
    )
      .replace(/\s+/g, " ")
      .trim();
    return {
      turn: i + 1,
      preview:
        [...text].length > 80 ? [...text].slice(0, 79).join("") + "…" : text,
      agentEdits: checkpoints.filter(
        (c) => c.status === "applied" && tags[c.id] === i + 1,
      ).length,
    };
  });
}

export type RewindFile = {
  path: string;
  // Content the agent's latest checkpoint left; anything else is a later change.
  expected: string;
  // Content before the earliest rewound agent edit; null removes a created file.
  restored: string | null;
};

export type RewindPlan = {
  turn: number;
  cut: number;
  files: RewindFile[];
  // Checkpoints created in the rewound turns, applied or already undone.
  rewound: string[];
  untracked: number;
};

// `unrestorable` is the latest turn with an agent edit that has no checkpoint
// (evicted, or too large to keep). Restoring files from that turn or earlier
// would be partial, so only a conversation rewind (`keepFiles`) is allowed.
export function rewindPlan(
  messages: Message[],
  checkpoints: Checkpoint[],
  tags: CheckpointTurns,
  turn: number,
  { keepFiles = false, unrestorable = UNTRACKED_TURN } = {},
): RewindPlan {
  const turns = userTurns(messages);
  if (!Number.isSafeInteger(turn) || turn < 1 || turn > turns.length)
    throw new CheckpointError(
      `Choose a turn from 1 to ${turns.length}; /rewind lists them`,
    );
  if (!keepFiles && turn <= unrestorable)
    throw new CheckpointError(
      `Cannot restore files to before turn ${turn}: undo checkpoints for agent edits in turn ${unrestorable} or earlier were dropped or never kept, so the restore would be partial. Nothing was restored. ${unrestorable < turns.length ? `Rewind to turn ${unrestorable + 1} or later, or use` : "Use"} /rewind ${turn} --keep-files to rewind only the conversation.`,
    );
  const rewound = checkpoints.filter(
    (c) => (tags[c.id] ?? UNTRACKED_TURN) >= turn,
  );
  const byPath = new Map<string, Checkpoint[]>();
  for (const checkpoint of rewound)
    if (checkpoint.status === "applied")
      byPath.set(checkpoint.path, [
        ...(byPath.get(checkpoint.path) ?? []),
        checkpoint,
      ]);
  const files: RewindFile[] = [];
  for (const [path, chain] of keepFiles ? [] : byPath) {
    // A gap means something else changed the file between two agent edits.
    for (let i = 1; i < chain.length; i++)
      if (chain[i]!.before !== chain[i - 1]!.after)
        throw new CheckpointError(
          `Cannot rewind ${path}: it changed between agent edits, so restoring it would discard those changes. Nothing was restored. Use /rewind ${turn} --keep-files to rewind only the conversation.`,
        );
    files.push({
      path,
      expected: chain.at(-1)!.after,
      restored: chain[0]!.before,
    });
  }
  return {
    turn,
    cut: turns[turn - 1]!,
    files,
    rewound: rewound.map((c) => c.id),
    untracked: checkpoints.filter(
      (c) =>
        c.status === "applied" &&
        (tags[c.id] ?? UNTRACKED_TURN) === UNTRACKED_TURN,
    ).length,
  };
}

// The compaction summary covers messages before `through`; it cannot describe a
// transcript cut earlier than that, so it is discarded rather than reused.
export function truncatedCompaction(
  state: CompactionState,
  cut: number,
): CompactionState {
  return state.through > cut
    ? compactionStateSchema.parse({
        automatic: state.automatic,
        count: state.count,
      })
    : state;
}
