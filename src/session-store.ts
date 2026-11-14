import { constants } from "node:fs";
import { lstat, open, opendir } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { isAbsolute, join } from "node:path";
import { z } from "zod";
import { directory, endpoint, privateDir, writeJson } from "./config.js";
import { compactionStateSchema, contextMessages } from "./compaction.js";
import { planSchema } from "./planning.js";
import { contextUsageSchema } from "./usage.js";
import { serverRunSchema } from "./server-tools.js";

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
  messages: z.array(messageSchema).max(2000),
  compaction: compactionStateSchema.default(() =>
    compactionStateSchema.parse({}),
  ),
  contextUsage: contextUsageSchema.optional(),
  promptMode: z.enum(["interrupt", "queue"]).default("interrupt"),
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
      before.size > 4_000_000
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
      if (encoded.length > 2_000_000) throw new Error();
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
    if ((total += size) > 64_000_000)
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
  const record = storedSessionSchema.parse({
    ...source,
    ...redactedConversation(source, options.redact),
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
  if (Buffer.byteLength(JSON.stringify(record)) > 2_000_000)
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
