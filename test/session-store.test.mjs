import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  chmod,
  symlink,
  unlink,
  stat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const temporary = await mkdtemp(join(tmpdir(), "ow-session-store-"));
process.env.OPENWEBUI_ACP_HOME = join(temporary, "state");
const { directory, writeJson } = await import("../dist/config.js");
const {
  listStoredSessions,
  readStoredSession,
  forkStoredSession,
  exportStoredSession,
  normalizeSessionTitle,
} = await import("../dist/session-store.js");
const scope = { url: "https://example.invalid/ui", header: "Authorization" };
const cwd = join(temporary, "workspace");
await mkdir(cwd);
let ids = [];
const record = (overrides = {}) => ({
  root: cwd,
  url: scope.url,
  model: "fixture",
  reasoning: "default",
  messages: [
    { role: "system", content: "Agent instructions" },
    { role: "user", content: "Implement this exact task; synthetic-secret" },
    {
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: "one",
          type: "function",
          function: { name: "read_file", arguments: '{"path":"a.txt"}' },
        },
      ],
    },
    { role: "tool", tool_call_id: "one", content: "observed file" },
    { role: "assistant", content: "Finished" },
  ],
  ...overrides,
});
const write = async (value) => {
  const id = randomUUID();
  ids.push(id);
  await writeJson(`session-${id}.json`, value);
  return id;
};
const redact = (value) => value.replaceAll("synthetic-secret", "[REDACTED]");
test.afterEach(async () => {
  for (const id of ids)
    await unlink(join(directory, `session-${id}.json`)).catch(() => {});
  ids = [];
});

test("listing filters backend/header and exact workspace with bounded stable pagination", async () => {
  const first = await write(
    record({ title: "First", updatedAt: "2026-01-03T00:00:00Z" }),
  );
  const second = await write(
    record({ title: "Second", updatedAt: "2026-01-02T00:00:00Z" }),
  );
  await write(
    record({ url: "https://other.invalid", title: "Hidden backend" }),
  );
  await write(record({ header: "X-Api-Key", title: "Hidden header" }));
  await write(record({ root: cwd + "-sibling", title: "Other workspace" }));
  const page = await listStoredSessions({ ...scope, cwd, limit: 1 });
  assert.deepEqual(
    page.sessions.map((s) => s.sessionId),
    [first],
  );
  assert.equal(page.sessions[0].cwd, cwd);
  assert(!JSON.stringify(page).includes("synthetic-secret"));
  const next = await listStoredSessions({
    ...scope,
    cwd,
    limit: 1,
    cursor: page.nextCursor,
  });
  assert.deepEqual(
    next.sessions.map((s) => s.sessionId),
    [second],
  );
  assert.equal(next.nextCursor, undefined);
  await assert.rejects(
    listStoredSessions({
      ...scope,
      cwd: cwd + "-sibling",
      cursor: page.nextCursor,
    }),
    /cursor/,
  );
  await assert.rejects(
    listStoredSessions({ ...scope, cursor: "not-json" }),
    /cursor/,
  );
  await assert.rejects(
    listStoredSessions({ ...scope, cwd: "relative" }),
    /absolute/,
  );
  await assert.rejects(listStoredSessions({ ...scope, limit: 51 }));
  await writeJson(
    `session-${second}.json`,
    record({ title: "Changed", updatedAt: "2026-01-04T00:00:00Z" }),
  );
  await assert.rejects(
    listStoredSessions({ ...scope, cwd, cursor: page.nextCursor }),
    /stale/,
  );
});

test("listing handles legacy metadata without deriving titles from prompts", async () => {
  const id = await write(record());
  await write(record({ root: "[REDACTED]" }));
  const result = await listStoredSessions({ ...scope, cwd });
  assert.equal(result.sessions.length, 1);
  assert.equal(result.sessions[0].sessionId, id);
  assert.equal(result.sessions[0].title, undefined);
  assert(Number.isFinite(Date.parse(result.sessions[0].updatedAt)));
  await assert.rejects(
    readStoredSession(id, { ...scope, cwd: cwd + "-sibling" }),
    /match/,
  );
  await assert.rejects(
    readStoredSession(id, { ...scope, url: "https://other.invalid" }),
    /match/,
  );
  await assert.rejects(readStoredSession("../config", scope));
});

test("unsafe, symlinked, corrupt and structurally invalid sessions are refused without copying them", async () => {
  const id = await write(record());
  const file = join(directory, `session-${id}.json`);
  await chmod(file, 0o644);
  await assert.rejects(listStoredSessions(scope), /Unsafe/);
  await chmod(file, 0o600);
  await writeFile(file, '{"root":');
  await assert.rejects(readStoredSession(id, scope), /malformed/);
  await writeFile(
    file,
    JSON.stringify(
      record({ messages: [{ role: "invented", content: "bad" }] }),
    ),
  );
  await assert.rejects(forkStoredSession(id, scope, { redact }), /malformed/);
  await writeFile(
    file,
    JSON.stringify(
      record({
        compaction: {
          summary: "bad checkpoint",
          through: 999,
          count: 1,
          automatic: true,
        },
      }),
    ),
  );
  await assert.rejects(readStoredSession(id, scope), /malformed/);
  await writeFile(file, "x".repeat(4_000_001));
  await assert.rejects(readStoredSession(id, scope), /Unsafe/);
  await unlink(file);
  const target = join(temporary, "symlink-target.json");
  await writeFile(target, JSON.stringify(record()), { mode: 0o600 });
  await symlink(target, file);
  await assert.rejects(listStoredSessions(scope));
  await assert.rejects(readStoredSession(id, scope));
  assert.equal(JSON.parse(await readFile(target, "utf8")).model, "fixture");
});

test("fork copies conversation only and resets executable state without mutating source", async () => {
  const id = await write(
    record({
      title: "Source",
      permissionMode: "development",
      sandboxMode: "full_access",
      workflow: "plan",
      promptMode: "queue",
      plan: [
        {
          content: "Pending synthetic-secret",
          priority: "high",
          status: "pending",
        },
      ],
      serverRuns: [
        { chatId: randomUUID(), messageId: randomUUID(), state: "running" },
      ],
      jobs: [{ pid: 123 }],
      toolGrants: ["never-copy"],
      apiKey: "never-copy",
    }),
  );
  const original = await readFile(
    join(directory, `session-${id}.json`),
    "utf8",
  );
  const fork = await forkStoredSession(
    id,
    { ...scope, cwd },
    { title: "Alternative", redact },
  );
  ids.push(fork.sessionId);
  assert.notEqual(fork.sessionId, id);
  assert.equal(fork.record.root, cwd);
  assert.equal(fork.record.title, "Alternative");
  assert.equal(fork.record.permissionMode, "scoped");
  assert.equal(fork.record.sandboxMode, "workspace");
  assert.equal(fork.record.promptMode, "queue");
  assert.equal(fork.record.workflow, "plan");
  assert.deepEqual(fork.record.serverRuns, []);
  for (const key of ["jobs", "toolGrants", "apiKey"])
    assert.equal(fork.record[key], undefined);
  assert(!JSON.stringify(fork.record).includes("synthetic-secret"));
  assert.equal(fork.record.messages[2].tool_calls[0].id, "one");
  assert.equal(fork.record.messages[3].tool_call_id, "one");
  assert.equal(
    await readFile(join(directory, `session-${id}.json`), "utf8"),
    original,
  );
  assert.equal(
    (await stat(join(directory, `session-${fork.sessionId}.json`))).mode &
      0o777,
    0o600,
  );
  for (const permissionMode of ["ask", "read_only"]) {
    await writeJson(
      `session-${id}.json`,
      record({ permissionMode, sandboxMode: "read_only" }),
    );
    const copy = await forkStoredSession(id, scope, { redact });
    ids.push(copy.sessionId);
    assert.equal(copy.record.permissionMode, permissionMode);
    assert.equal(copy.record.sandboxMode, "read_only");
  }
});

test("export returns explicit redacted transcript formats without credentials or operational state", async () => {
  const remoteId = randomUUID();
  const id = await write(
    record({
      title: "Export",
      serverRuns: [
        { chatId: remoteId, messageId: randomUUID(), state: "completed" },
      ],
      jobs: [{ pid: 123 }],
      apiKey: "never-copy",
    }),
  );
  const json = await exportStoredSession(id, scope, { format: "json", redact });
  const value = JSON.parse(json);
  assert.equal(value.title, "Export");
  assert.equal(value.messages.length, 5);
  assert.equal(
    value.messages[1].content,
    "Implement this exact task; [REDACTED]",
  );
  for (const absent of [
    "synthetic-secret",
    "never-copy",
    remoteId,
    scope.url,
    cwd,
  ])
    assert(!json.includes(absent));
  assert.deepEqual(Object.keys(value).sort(), [
    "messages",
    "model",
    "plan",
    "sessionId",
    "title",
    "version",
  ]);
  const markdown = await exportStoredSession(id, scope, {
    format: "markdown",
    redact,
  });
  assert.match(markdown, /^# Export/);
  assert.match(markdown, /## tool/);
  assert.match(markdown, /Tool result for: one/);
  await assert.rejects(
    exportStoredSession(id, scope, { format: "xml", redact }),
  );
  await assert.rejects(listStoredSessions({ ...scope, cursor: "" }), /cursor/);
});

test("titles are explicit, bounded and do not accept terminal controls", () => {
  assert.equal(normalizeSessionTitle("  Useful title  "), "Useful title");
  assert.equal(normalizeSessionTitle(null), undefined);
  for (const title of [
    "",
    " ",
    "a".repeat(121),
    "bad\x1b[31mtitle",
    "two\nlines",
  ])
    assert.throws(() => normalizeSessionTitle(title));
});

test("listing refuses an oversized catalog before opening session payloads", async () => {
  await listStoredSessions(scope);
  for (let index = 0; index < 1001; index++) {
    const id = randomUUID();
    ids.push(id);
    await writeFile(join(directory, `session-${id}.json`), "not parsed", {
      mode: 0o600,
    });
  }
  await assert.rejects(listStoredSessions(scope), /count limit/);
});

test("fork storage limit counts UTF-8 bytes before creating a new record", async () => {
  const id = await write(
    record({ messages: [{ role: "user", content: "界".repeat(700000) }] }),
  );
  await assert.rejects(
    forkStoredSession(id, scope, { redact }),
    /storage limit/,
  );
  assert.equal((await listStoredSessions(scope)).sessions.length, 1);
});
