import { constants } from "node:fs";
import { lstat, open, opendir } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { isAbsolute, join } from "node:path";
import { z } from "zod";
import {
  directory,
  endpoint,
  privateDir,
  SESSION_RECORD_BYTES,
  SESSION_STORAGE_BYTES,
  writeJson,
} from "./config.js";
import type { Message } from "./backend.js";
import {
  compactionStateSchema,
  contextMessages,
  pinnedRequest,
  PROJECT_GUIDANCE_PREFIX,
  type CompactionState,
} from "./compaction.js";
import { planSchema } from "./planning.js";
import { contextUsageSchema } from "./usage.js";
import {
  contextMaskSchema,
  NO_MASK,
  type ContextMask,
} from "./context-mask.js";
import { serverRunSchema } from "./server-tools.js";
import { promptModes } from "./turns.js";
import { UNTRACKED_TURN, userTurns } from "./rewind.js";

// Messages in one saved session. Bounded separately from its byte size.
export const SESSION_MESSAGE_LIMIT = 10_000;

export const sessionIdSchema = z.string().uuid();
export const sessionTitleSchema = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .refine(
    (value) => [...value].every((c) => c.charCodeAt(0) >= 32 && c !== "\x7f"),
    "Session title must not contain control characters",
  );
const timestamp = z.string().datetime({ offset: true });
const messageSchema = z
  .object({
    role: z.enum(["system", "user", "assistant", "tool"]),
    content: z.string().max(1_000_000).nullable(),
    tool_call_id: z.string().max(1000).optional(),
    tool_calls: z
      .array(
        z
          .object({
            id: z.string().max(1000),
            type: z.literal("function"),
            function: z
              .object({
                name: z.string().max(1000),
                arguments: z.string().max(1_000_000),
              })
              .strict(),
          })
          .strict(),
      )
      .max(64)
      .optional(),
  })
  .strict();

// Known conversation fields only. Additional per-session runtime state is never
// copied by fork/export. The agent remains responsible for activation and load.
export const storedSessionSchema = z.object({
  root: z.string().min(1).max(4096),
  url: z.string().url(),
  header: z
    .string()
    .regex(/^[A-Za-z0-9-]+$/)
    .default("Authorization"),
  model: z.string().min(1).max(1000),
  reasoning: z.string().max(1000),
  title: sessionTitleSchema.optional(),
  createdAt: timestamp.optional(),
  updatedAt: timestamp.optional(),
  messages: z.array(messageSchema).max(SESSION_MESSAGE_LIMIT),
  compaction: compactionStateSchema.default(() =>
    compactionStateSchema.parse({}),
  ),
  contextUsage: contextUsageSchema.optional(),
  contextMask: contextMaskSchema.catch(NO_MASK).default(NO_MASK),
  promptMode: z.enum(promptModes).default("interrupt"),
  workflow: z.enum(["code", "plan"]).default("code"),
  plan: planSchema.default([]),
  permissionMode: z
    .enum(["read_only", "ask", "scoped", "edits", "development", "yolo"])
    .default("scoped"),
  sandboxMode: z
    .enum(["workspace", "read_only", "full_access"])
    .default("workspace"),
  serverRuns: z.array(serverRunSchema).max(64).default([]),
});
export type StoredSession = z.infer<typeof storedSessionSchema>;
export type SessionScope = { url: string; header?: string; cwd?: string };
export type StoredSessionInfo = {
  sessionId: string;
  cwd: string;
  title?: string;
  updatedAt: string;
};

export function normalizeSessionTitle(
  value: string | null,
): string | undefined {
  return value === null ? undefined : sessionTitleSchema.parse(value);
}

function scopeValues(scope: SessionScope) {
  endpoint(scope.url, "api/models");
  const header = z
    .string()
    .regex(/^[A-Za-z0-9-]+$/)
    .parse(scope.header ?? "Authorization");
  if (scope.cwd !== undefined && !isAbsolute(scope.cwd))
    throw new Error("Session directory filter must be absolute");
  return { url: scope.url, header, ...(scope.cwd ? { cwd: scope.cwd } : {}) };
}

async function ownedDirectory() {
  await privateDir();
  const stat = await lstat(directory);
  if (stat.uid !== process.getuid?.())
    throw new Error(
      "Application state directory must belong to the current user",
    );
}

async function readRecord(id: string) {
  sessionIdSchema.parse(id);
  await ownedDirectory();
  const handle = await open(
    join(directory, `session-${id}.json`),
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    const before = await handle.stat();
    if (
      !before.isFile() ||
      before.uid !== process.getuid?.() ||
      before.mode & 0o077 ||
      before.nlink !== 1 ||
      before.size > SESSION_RECORD_BYTES
    )
      throw new Error("Unsafe saved session file");
    const buffer = Buffer.alloc(before.size + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(
        buffer,
        length,
        buffer.length - length,
        length,
      );
      if (!bytesRead) break;
      length += bytesRead;
    }
    const after = await handle.stat();
    if (
      length !== before.size ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs
    )
      throw new Error("Saved session changed while reading; retry");
    let record: StoredSession;
    try {
      const encoded = buffer.subarray(0, length).toString("utf8");
      record = storedSessionSchema.parse(JSON.parse(encoded));
      endpoint(record.url, "api/models");
      contextMessages(record.messages, record.compaction);
    } catch {
      throw new Error("Saved session is malformed or exceeds its limits");
    }
    return {
      record,
      size: before.size,
      updatedAt: record.updatedAt ?? before.mtime.toISOString(),
    };
  } finally {
    await handle.close();
  }
}

function matches(record: StoredSession, scope: ReturnType<typeof scopeValues>) {
  return (
    record.url === scope.url &&
    record.header.toLowerCase() === scope.header.toLowerCase() &&
    (scope.cwd === undefined || record.root === scope.cwd)
  );
}

export async function readStoredSession(
  id: string,
  scope: SessionScope,
): Promise<StoredSession> {
  const values = scopeValues(scope);
  const { record } = await readRecord(id);
  if (!matches(record, values) || !isAbsolute(record.root))
    throw new Error("Saved session does not match this backend or workspace");
  return record;
}

const digest = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const cursorSchema = z
  .object({
    version: z.literal(1),
    scope: z.string().regex(/^[a-f0-9]{64}$/),
    snapshot: z.string().regex(/^[a-f0-9]{64}$/),
    offset: z.number().int().min(0).max(1000),
  })
  .strict();

export async function listStoredSessions(
  options: SessionScope & { cursor?: string | null; limit?: number },
): Promise<{ sessions: StoredSessionInfo[]; nextCursor?: string }> {
  const values = scopeValues(options);
  const limit = z
    .number()
    .int()
    .min(1)
    .max(50)
    .parse(options.limit ?? 20);
  await ownedDirectory();
  const names: string[] = [];
  let scanned = 0;
  for await (const entry of await opendir(directory)) {
    if (++scanned > 5000)
      throw new Error("Application state directory scan limit exceeded");
    const match = /^session-([a-f0-9-]{36})\.json$/.exec(entry.name);
    if (!match) continue;
    names.push(match[1]);
    if (names.length > 1000)
      throw new Error("Saved session count limit exceeded");
  }
  const sessions: StoredSessionInfo[] = [];
  let total = 0;
  for (const id of names) {
    const { record, size, updatedAt } = await readRecord(id);
    if ((total += size) > SESSION_STORAGE_BYTES)
      throw new Error("Saved session scan budget exceeded");
    // A legacy redacted root has no safe ACP cwd. It can still be recovered by
    // the existing explicit session/load flow, but must not become a fake root.
    if (!matches(record, values) || !isAbsolute(record.root)) continue;
    sessions.push({
      sessionId: id,
      cwd: record.root,
      ...(record.title ? { title: record.title } : {}),
      updatedAt,
    });
  }
  sessions.sort(
    (a, b) =>
      b.updatedAt.localeCompare(a.updatedAt) ||
      a.sessionId.localeCompare(b.sessionId),
  );
  const scope = digest(values),
    snapshot = digest(sessions);
  let offset = 0;
  if (options.cursor !== undefined && options.cursor !== null) {
    try {
      if (
        options.cursor.length > 1024 ||
        !/^[A-Za-z0-9_-]+$/.test(options.cursor)
      )
        throw new Error();
      const cursor = cursorSchema.parse(
        JSON.parse(Buffer.from(options.cursor, "base64url").toString("utf8")),
      );
      if (
        cursor.scope !== scope ||
        cursor.snapshot !== snapshot ||
        cursor.offset >= sessions.length
      )
        throw new Error();
      offset = cursor.offset;
    } catch {
      throw new Error(
        "Invalid or stale session cursor; refresh the session list",
      );
    }
  }
  const nextOffset = offset + limit;
  return {
    sessions: sessions.slice(offset, nextOffset),
    ...(nextOffset < sessions.length
      ? {
          nextCursor: Buffer.from(
            JSON.stringify({ version: 1, scope, snapshot, offset: nextOffset }),
          ).toString("base64url"),
        }
      : {}),
  };
}

function redactedConversation(
  record: StoredSession,
  redact: (text: string) => string,
) {
  return {
    messages: record.messages.map((message) => ({
      ...message,
      content: message.content === null ? null : redact(message.content),
      ...(message.tool_calls
        ? {
            tool_calls: message.tool_calls.map((call) => ({
              ...call,
              function: {
                ...call.function,
                arguments: redact(call.function.arguments),
              },
            })),
          }
        : {}),
    })),
    plan: record.plan.map((entry) => ({
      ...entry,
      content: redact(entry.content),
    })),
    compaction: {
      ...record.compaction,
      summary: redact(record.compaction.summary),
    },
  };
}

export async function forkStoredSession(
  id: string,
  scope: SessionScope,
  options: { title?: string | null; redact: (text: string) => string },
): Promise<{ sessionId: string; record: StoredSession }> {
  const source = await readStoredSession(id, scope);
  const now = new Date().toISOString();
  const title =
    options.title === undefined
      ? source.title
      : normalizeSessionTitle(options.title);
  const conversation = redactedConversation(source, options.redact);
  // Redaction can lengthen text; the fork is fitted like any other save.
  const fitted = fitSessionRecord(
    {
      messages: conversation.messages,
      compaction: conversation.compaction,
      contextMask: source.contextMask,
    },
    SESSION_RECORD_BYTES - 100_000,
  ).record;
  const record = storedSessionSchema.parse({
    ...source,
    ...conversation,
    ...fitted,
    ...(title
      ? { title: normalizeSessionTitle(options.redact(title)) }
      : { title: undefined }),
    createdAt: now,
    updatedAt: now,
    permissionMode: ["ask", "read_only"].includes(source.permissionMode)
      ? source.permissionMode
      : "scoped",
    sandboxMode: source.sandboxMode === "read_only" ? "read_only" : "workspace",
    serverRuns: [],
  });
  if (Buffer.byteLength(JSON.stringify(record)) > SESSION_RECORD_BYTES)
    throw new Error("Forked session exceeds storage limit");
  const sessionId = randomUUID();
  await writeJson(`session-${sessionId}.json`, record);
  return { sessionId, record };
}

export async function exportStoredSession(
  id: string,
  scope: SessionScope,
  options: { format: "json" | "markdown"; redact: (text: string) => string },
): Promise<string> {
  const format = z.enum(["json", "markdown"]).parse(options.format);
  const source = await readStoredSession(id, scope);
  const { messages, plan } = redactedConversation(source, options.redact);
  const title = source.title
    ? options.redact(source.title)
    : "Untitled session";
  const value = {
    version: 1,
    sessionId: id,
    title,
    model: source.model,
    messages,
    plan,
  };
  const text =
    format === "json"
      ? JSON.stringify(value, null, 2)
      : [
          `# ${title.replaceAll("\n", " ")}`,
          `Session: ${id}`,
          `Model: ${source.model}`,
          ...messages.map(
            (m) =>
              `## ${m.role}\n\n${m.content ?? ""}${m.tool_calls ? `\n\nTool calls:\n\n${JSON.stringify(m.tool_calls, null, 2)}` : ""}${m.tool_call_id ? `\n\nTool result for: ${m.tool_call_id}` : ""}`,
          ),
          ...(plan.length
            ? [
                `## Task plan\n\n${plan.map((p) => `- [${p.status === "completed" ? "x" : " "}] ${p.content}`).join("\n")}`,
              ]
            : []),
        ].join("\n\n");
  if (text.length > 4_000_000)
    throw new Error("Session export exceeds output limit");
  return text + "\n";
}

// Saving never fails because the transcript grew. When a record would exceed
// its byte limit, the STORED copy is trimmed deterministically, oldest first;
// the live session keeps its full transcript. Checkpoints are never trimmed:
// they must stay exact and have their own 2 MB budget.
//
// Never touched: system messages, the AGENTS.md guidance message, the compaction
// summary, the request and steering messages compaction pins, and (until every
// older message is gone) the latest KEPT_TURNS user turns. Three turns keep the
// current request with its tool results plus the two before it, which is what
// a reopened session continues from and what /rewind most often targets.
// Trimming stays within one message's text, so tool calls, ids, names and
// result pairing are unchanged; dropping removes whole tool groups.
export const KEPT_TURNS = 3;
const EXCERPT_FROM = 4_000; // bytes; smaller results stay complete
const EXCERPT_HEAD = 1_200; // characters kept from the start
const EXCERPT_TAIL = 600; // and the end
const STUB_FROM = 200; // fallback: anything larger keeps only a short head
const STUB_HEAD = 160;
const MARKER = /\[trimmed from the saved session: (\d+) bytes\]/g;
export const trimMarker = (bytes: number) =>
  `[trimmed from the saved session: ${bytes} bytes]`;

const byteSize = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
// Avoid splitting a surrogate pair at either cut.
const cutStart = (text: string, n: number) =>
  text.slice(0, /[\uD800-\uDBFF]/.test(text[n - 1] ?? "") ? n - 1 : n);
const cutEnd = (text: string, n: number) => {
  if (!n) return "";
  const start = text.length - n;
  return text.slice(
    /[\uDC00-\uDFFF]/.test(text[start] ?? "") ? start + 1 : start,
  );
};

function trimText(text: string, head: number, tail: number) {
  // A field trimmed by an earlier save reports its original size again.
  let bytes = Buffer.byteLength(text);
  for (const match of text.matchAll(MARKER))
    bytes = Math.max(bytes, Number(match[1]));
  const excerpt = [cutStart(text, head), trimMarker(bytes), cutEnd(text, tail)]
    .filter(Boolean)
    .join("\n");
  return excerpt.length < text.length ? excerpt : text;
}

// Arguments stay a JSON object with the same keys, so a provider that parses
// historical tool calls still can; only large values become excerpts.
function trimArguments(args: string, from: number, head: number, tail: number) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(args);
  } catch {
    return trimText(args, head, tail);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    return trimText(args, head, tail);
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(parsed)) {
    const text = typeof value === "string" ? value : JSON.stringify(value);
    out[key] =
      text !== undefined && Buffer.byteLength(text) > from
        ? trimText(text, head, tail)
        : value;
  }
  return JSON.stringify(out);
}

type Fittable = {
  messages: Message[];
  compaction: CompactionState;
  contextMask?: ContextMask;
  checkpointTurns?: Record<string, number>;
  unrestorableTurn?: number;
  failedToolCalls?: string[];
};

export function fitSessionRecord<T extends Fittable>(
  input: T,
  limit = SESSION_RECORD_BYTES,
): { record: T; trimmed: number } {
  let size = byteSize(input);
  if (size <= limit && input.messages.length <= SESSION_MESSAGE_LIMIT)
    return { record: input, trimmed: 0 };
  // Copy only what may change; the caller's transcript stays untouched.
  let messages: Message[] = input.messages.map((m) => ({
    ...m,
    ...(m.tool_calls
      ? {
          tool_calls: m.tool_calls.map((c) => ({
            ...c,
            function: { ...c.function },
          })),
        }
      : {}),
  }));
  let compaction = input.compaction;
  let contextMask = input.contextMask;
  let checkpointTurns = input.checkpointTurns;
  let unrestorableTurn = input.unrestorableTurn;
  let trimmed = 0;

  const kept = () => {
    const keep = new Set<number>();
    messages.forEach((m, i) => {
      if (m.role === "system") keep.add(i);
    });
    const first = messages.findIndex((m) => m.role !== "system");
    if (
      first >= 0 &&
      messages[first]!.content?.startsWith(PROJECT_GUIDANCE_PREFIX)
    )
      keep.add(first);
    if (compaction.through > 0) {
      const pinned = pinnedRequest(messages, compaction.through);
      if (pinned.request >= 0) keep.add(pinned.request);
      for (const i of pinned.steering) keep.add(i);
    }
    return keep;
  };
  const recentStart = (turnsKept: number) => {
    const turns = userTurns(messages);
    return turns.length > turnsKept ? turns[turns.length - turnsKept]! : 0;
  };

  // Shortens text fields of messages in [from, to), oldest first, until the
  // record fits. `everything` also covers user/assistant text (fallback).
  const shorten = (
    from: number,
    to: number,
    everything: boolean,
    skip: Set<number>,
  ) => {
    const [min, head, tail] = everything
      ? [STUB_FROM, STUB_HEAD, 0]
      : [EXCERPT_FROM, EXCERPT_HEAD, EXCERPT_TAIL];
    for (let i = from; i < to && size > limit; i++) {
      if (skip.has(i)) continue;
      const m = messages[i]!;
      if (
        typeof m.content === "string" &&
        (everything || m.role === "tool") &&
        Buffer.byteLength(m.content) > min
      ) {
        const next = trimText(m.content, head, tail);
        if (next !== m.content) {
          size += byteSize(next) - byteSize(m.content);
          m.content = next;
          trimmed++;
        }
      }
      for (const call of m.tool_calls ?? []) {
        if (size <= limit) break;
        const args = call.function.arguments;
        if (Buffer.byteLength(args) <= min) continue;
        const next = trimArguments(args, min, head, tail);
        if (byteSize(next) < byteSize(args)) {
          size += byteSize(next) - byteSize(args);
          call.function.arguments = next;
          trimmed++;
        }
      }
    }
  };

  // Removes unprotected messages before `cut`: whole tool groups, plain user
  // and assistant messages. Turn tags and the compaction index are remapped;
  // checkpoints from removed turns become untracked, so /rewind leaves them to
  // /undo instead of restoring through a turn that no longer exists.
  const drop = (cut: number) => {
    const keep = kept();
    const map = new Map<number, number>();
    const next: Message[] = [];
    messages.forEach((m, i) => {
      if (i >= cut || keep.has(i)) {
        map.set(i, next.length);
        next.push(m);
      }
    });
    if (next.length === messages.length) return false;
    let through = 0;
    if (compaction.through > 0) {
      through = [...map.keys()].filter((i) => i < compaction.through).length;
      try {
        contextMessages(next, { ...compaction, through });
      } catch {
        return false; // Never store a summary index that does not fit.
      }
    }
    const newTurns = new Map(userTurns(next).map((index, i) => [index, i + 1]));
    const turnMap = new Map<number, number>();
    userTurns(messages).forEach((index, i) => {
      const moved = map.get(index);
      turnMap.set(
        i + 1,
        moved === undefined ? UNTRACKED_TURN : newTurns.get(moved)!,
      );
    });
    if (checkpointTurns)
      checkpointTurns = Object.fromEntries(
        Object.entries(checkpointTurns).map(([id, turn]) => [
          id,
          turnMap.get(turn) ?? UNTRACKED_TURN,
        ]),
      );
    // A kept turn at or before the old limit (such as a pinned request) is
    // still unrestorable under its new number.
    if (unrestorableTurn)
      unrestorableTurn = Math.max(
        UNTRACKED_TURN,
        ...[...turnMap]
          .filter(([turn]) => turn <= unrestorableTurn!)
          .map(([, moved]) => moved),
      );
    trimmed += messages.length - next.length;
    messages = next;
    if (compaction.through > 0) compaction = { ...compaction, through };
    // The mask indexes follow the messages they stood before.
    if (contextMask) {
      const moved = (index: number) =>
        [...map.keys()].filter((i) => i < index).length;
      contextMask = {
        masked: moved(contextMask.masked),
        elided: moved(contextMask.elided),
        seen: moved(contextMask.seen),
      };
    }
    size = byteSize({
      ...input,
      messages,
      compaction,
      checkpointTurns,
      ...(unrestorableTurn !== undefined ? { unrestorableTurn } : {}),
      ...(contextMask ? { contextMask } : {}),
    });
    return true;
  };

  const protectedNow = kept();
  const recent = recentStart(KEPT_TURNS);
  // 1. Excerpts of large older tool results and arguments.
  shorten(0, recent, false, protectedNow);
  // 2. Older messages reduced to short heads.
  shorten(0, recent, true, protectedNow);
  // 3. Keep only the summary, pinned messages and the latest turns.
  if (size > limit || messages.length > SESSION_MESSAGE_LIMIT) drop(recent);
  // 4./5. The latest turns alone are too large: excerpts, then short heads,
  // still keeping the current request itself.
  const recentSkip = new Set([
    ...kept(),
    messages.findLastIndex((m) => m.role === "user"),
  ]);
  const start = recentStart(KEPT_TURNS);
  shorten(start, messages.length, false, recentSkip);
  shorten(start, messages.length, true, recentSkip);
  // 6. Fewer turns, down to the current one.
  for (
    let turns = KEPT_TURNS - 1;
    turns >= 1 && (size > limit || messages.length > SESSION_MESSAGE_LIMIT);
    turns--
  )
    drop(recentStart(turns));
  // 7. Last resort: short heads for pinned and current requests too.
  const first = messages.findIndex((m) => m.role !== "system");
  shorten(
    0,
    messages.length,
    true,
    new Set(
      messages.flatMap((m, i) =>
        m.role === "system" ||
        (i === first && m.content?.startsWith(PROJECT_GUIDANCE_PREFIX))
          ? [i]
          : [],
      ),
    ),
  );
  const ids = new Set(
    messages.flatMap((m) => m.tool_calls?.map((c) => c.id) ?? []),
  );
  const record = {
    ...input,
    messages,
    compaction,
    ...(contextMask ? { contextMask } : {}),
    ...(checkpointTurns ? { checkpointTurns } : {}),
    ...(unrestorableTurn !== undefined ? { unrestorableTurn } : {}),
    ...(input.failedToolCalls
      ? { failedToolCalls: input.failedToolCalls.filter((id) => ids.has(id)) }
      : {}),
  };
  // Every remaining field has its own small bound (checkpoints 2 MB, summary
  // 16000 characters, guidance 64 KB), so this cannot be reached in practice.
  if (byteSize(record) > limit || messages.length > SESSION_MESSAGE_LIMIT)
    throw new Error("Session record cannot be reduced to its storage limit");
  return { record, trimmed };
}
