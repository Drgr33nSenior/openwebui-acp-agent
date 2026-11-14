import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  realpath,
  access,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClientApp } from "@agentclientprotocol/sdk";

const temp = await mkdtemp(join(tmpdir(), "ow-next-flows-"));
process.env.OPENWEBUI_ACP_HOME = join(temp, "state");
process.env.OPENWEBUI_API_KEY = "synthetic-next-flow-key";
const { createAgent } = await import("../dist/agent.js");
const { writeJson, readJson, configSchema } = await import("../dist/config.js");
let pending = [];
const requests = [];
const server = createServer(async (req, res) => {
  res.setHeader("Content-Type", "application/json");
  if (req.url === "/api/models")
    return res.end(JSON.stringify({ data: [{ id: "fixture" }] }));
  let body = "";
  for await (const chunk of req) body += chunk;
  requests.push(JSON.parse(body));
  const calls = pending.shift();
  res.end(
    JSON.stringify({
      choices: [
        {
          message: calls
            ? { role: "assistant", content: null, tool_calls: calls }
            : { role: "assistant", content: "Fixture complete" },
          finish_reason: calls ? "tool_calls" : "stop",
        },
      ],
    }),
  );
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const url = `http://127.0.0.1:${server.address().port}`;
await writeJson("config.json", configSchema.parse({ url, model: "fixture" }));
test.after(() => new Promise((r) => server.close(r)));
test.beforeEach(() => {
  requests.length = 0;
  pending = [];
});
const call = (name, args, id = name) => ({
  id,
  type: "function",
  function: { name, arguments: JSON.stringify(args) },
});
const events = (c) => c.updates.map((x) => x.update);
const lastText = (c) =>
  events(c)
    .filter((x) => x.sessionUpdate === "agent_message_chunk")
    .at(-1)?.content.text;
const result = (c) => JSON.parse(lastText(c));
async function client({ cwd, load, choose = () => "once", editor } = {}) {
  cwd ??= await realpath(await mkdtemp(join(temp, "project-")));
  if (!load) await writeFile(join(cwd, "a.txt"), "old");
  const updates = [],
    approvals = [],
    executed = [];
  const agent = createAgent({
    sandboxCommand: async (...args) => {
      executed.push(args);
      return JSON.stringify({
        code: 0,
        output: "fixture",
        limitedOrCancelled: false,
      });
    },
  });
  const app = new ClientApp();
  app.onNotification("session/update", ({ params }) => updates.push(params));
  app.onRequest("session/request_permission", async ({ params }) => {
    approvals.push(params);
    return { outcome: { outcome: "selected", optionId: await choose(params) } };
  });
  if (editor) {
    app.onRequest("fs/read_text_file", async ({ params }) => ({
      content: await editor.read(params.path),
    }));
    app.onRequest("fs/write_text_file", ({ params }) => {
      editor.write(params.path, params.content);
      return {};
    });
  }
  const connection = app.connect(agent.app);
  const initialization = await connection.agent.request("initialize", {
    protocolVersion: 1,
    clientCapabilities: editor
      ? { fs: { readTextFile: true, writeTextFile: true } }
      : {},
  });
  const started = await connection.agent.request(
    load ? "session/load" : "session/new",
    { cwd, mcpServers: [], ...(load ? { sessionId: load } : {}) },
  );
  const id = load ?? started.sessionId;
  return {
    id,
    cwd,
    agent,
    updates,
    approvals,
    executed,
    connection,
    initialization,
    state: () => agent.sessions.get(id),
    prompt: (text) =>
      connection.agent.request("session/prompt", {
        sessionId: id,
        prompt: [{ type: "text", text }],
      }),
    select: (configId, value) =>
      connection.agent.request("session/set_config_option", {
        sessionId: id,
        configId,
        value,
      }),
    list: () => connection.agent.request("session/list", { cwd }),
    close: async () => {
      connection.close();
      await agent.close();
    },
  };
}
async function edit(c, after = "new") {
  pending = [[call("write_file", { path: "a.txt", before: "old", after })]];
  await c.prompt("Make the fixture edit");
}
test("session browsing and explicit titles require no inference or workspace activation", async () => {
  const c = await client();
  try {
    assert.deepEqual(
      c.initialization.agentCapabilities.sessionCapabilities.list,
      {},
    );
    await c.prompt("/title Useful fixture session");
    const listing = await c.list();
    assert.equal(listing.sessions.length, 1);
    assert.equal(listing.sessions[0].sessionId, c.id);
    assert.equal(listing.sessions[0].title, "Useful fixture session");
    assert.equal(
      (await readJson(`session-${c.id}.json`)).title,
      "Useful fixture session",
    );
    assert(
      events(c).some(
        (e) =>
          e.sessionUpdate === "session_info_update" &&
          e.title === "Useful fixture session",
      ),
    );
    await c.prompt("/sessions");
    assert.equal(result(c).sessions[0].sessionId, c.id);
    await c.prompt("/title");
    assert.equal(c.state().title, undefined);
    assert(
      events(c).some(
        (e) => e.sessionUpdate === "session_info_update" && e.title === null,
      ),
    );
    assert.equal(c.approvals.length, 0);
    assert.equal(requests.length, 0);
    assert.equal(c.state().active, false);
    await assert.rejects(
      c.connection.agent.request("session/list", {
        cwd: c.cwd,
        cursor: "invalid",
      }),
    );
  } finally {
    await c.close();
  }
});

test("slash-command session pagination preserves its snapshot without duplicate or missing sessions", async () => {
  const c = await client();
  try {
    await c.prompt("/title Browsing fixture");
    const source = await readJson(`session-${c.id}.json`);
    const expected = [c.id];
    for (let i = 0; i < 21; i++) {
      const id = randomUUID();
      expected.push(id);
      await writeJson(`session-${id}.json`, {
        ...source,
        title: `Saved fixture ${i}`,
        updatedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
      });
    }
    await c.prompt("/sessions");
    const first = result(c);
    assert.equal(first.sessions.length, 20);
    assert.equal(typeof first.nextCursor, "string");
    await c.prompt(`/sessions ${first.nextCursor}`);
    const second = result(c);
    assert.equal(second.sessions.length, 2);
    assert.equal(second.nextCursor, undefined);
    const listed = [...first.sessions, ...second.sessions].map(
      (s) => s.sessionId,
    );
    assert.equal(new Set(listed).size, 22);
    assert.deepEqual(listed.sort(), expected.sort());
    assert.equal(requests.length, 0);
    assert.equal(c.approvals.length, 0);
    assert.equal(c.state().active, false);
  } finally {
    await c.close();
  }
});

test("fork retains history with a new identity and load never replays source edits", async () => {
  const c = await client();
  try {
    await c.select("permissions", "development");
    await edit(c);
    await c.select("sandbox", "full_access");
    const history = structuredClone(c.state().messages);
    await c.prompt("/fork Alternative approach");
    const id = /Fork created: ([a-f0-9-]{36})/.exec(lastText(c))?.[1];
    assert(id);
    assert.notEqual(id, c.id);
    const saved = await readJson(`session-${id}.json`);
    assert.deepEqual(saved.messages, history);
    assert.equal(saved.title, "Alternative approach");
    assert.equal(saved.permissionMode, "scoped");
    assert.equal(saved.sandboxMode, "workspace");
    assert.equal(saved.checkpoints, undefined);
    assert.equal(saved.jobs, undefined);
    const loaded = await client({ cwd: c.cwd, load: id });
    try {
      assert.equal(loaded.state().active, false);
      assert.equal(loaded.state().permissions.currentMode, "scoped");
      assert.equal(loaded.state().sandbox, "workspace");
      assert.equal(loaded.executed.length, 0);
      assert.equal(loaded.approvals.length, 0);
      assert.equal(await readFile(join(c.cwd, "a.txt"), "utf8"), "new");
      assert.deepEqual(c.state().messages, history);
    } finally {
      await loaded.close();
    }
  } finally {
    await c.close();
  }
});

test("explicit transcript export shows a diff, respects rejection, and writes only after approval", async () => {
  let allow = false;
  const c = await client({
    choose: (p) =>
      p.toolCall.title.startsWith("Write ")
        ? allow
          ? "once"
          : "deny"
        : "once",
  });
  try {
    await c.prompt("Inspect the task");
    await c.select("permissions", "development");
    const calls = requests.length;
    await c.prompt("/export conversation.json");
    await assert.rejects(access(join(c.cwd, "conversation.json")));
    const declined = c.approvals.find((p) =>
      p.toolCall.title.endsWith("conversation.json"),
    );
    assert(
      declined.toolCall.content.some(
        (p) => p.type === "diff" && p.newText.includes('"messages"'),
      ),
    );
    assert.deepEqual(
      declined.options.map((o) => o.optionId),
      ["once", "deny"],
    );
    allow = true;
    await c.prompt("/export conversation.json");
    const exported = JSON.parse(
      await readFile(join(c.cwd, "conversation.json"), "utf8"),
    );
    assert.equal(exported.sessionId, c.id);
    assert(exported.messages.some((m) => m.content === "Inspect the task"));
    assert.equal(exported.url, undefined);
    assert.equal(exported.permissionMode, undefined);
    assert.equal(requests.length, calls);
  } finally {
    await c.close();
  }
});

test("successful edits create checkpoints; undo and clear preserve unrelated files", async () => {
  const c = await client();
  try {
    await edit(c);
    await c.prompt("/checkpoints");
    const checkpoints = result(c);
    assert.equal(checkpoints.length, 1);
    assert.equal(checkpoints[0].operation, "edit");
    assert.equal(checkpoints[0].before, undefined);
    await c.prompt("/undo");
    assert.equal(await readFile(join(c.cwd, "a.txt"), "utf8"), "old");
    assert.equal(c.state().checkpoints[0].status, "undone");
    const approval = c.approvals.find((p) =>
      p.toolCall.title.startsWith("Undo agent edit"),
    );
    assert.deepEqual(
      approval.options.map((o) => o.optionId),
      ["once", "deny"],
    );
    assert(
      approval.toolCall.content.some(
        (p) => p.type === "diff" && p.oldText === "new" && p.newText === "old",
      ),
    );
    await c.prompt("/checkpoints clear");
    assert.deepEqual(result(c), []);
    assert.equal(await readFile(join(c.cwd, "a.txt"), "utf8"), "old");
  } finally {
    await c.close();
  }
});

test("manual undo and export outcomes reach subsequent inference and restore without replay", async () => {
  const c = await client();
  try {
    await edit(c);
    const codingRequests = requests.length;
    await c.prompt("/undo");
    await c.prompt("/export record.json");
    assert.equal(requests.length, codingRequests);
    assert.equal(await readFile(join(c.cwd, "a.txt"), "utf8"), "old");
    const exported = await readFile(join(c.cwd, "record.json"), "utf8");
    const assertManualHistory = (messages) => {
      const undo = messages.findIndex(
        (m) => m.role === "user" && m.content === "/undo",
      );
      assert(undo >= 0);
      assert.equal(messages[undo + 1].role, "assistant");
      assert.match(messages[undo + 1].content, /Agent edit undone: a\.txt/);
      const exportedAt = messages.findIndex(
        (m) => m.role === "user" && m.content === "/export record.json",
      );
      assert(exportedAt > undo);
      assert.equal(messages[exportedAt + 1].role, "assistant");
      assert.match(
        messages[exportedAt + 1].content,
        /File updated; checkpoint/,
      );
    };
    await c.prompt("Explain the completed undo and export");
    assertManualHistory(requests.at(-1).messages);
    const saved = await readJson(`session-${c.id}.json`);
    assertManualHistory(saved.messages);

    await writeFile(join(c.cwd, "a.txt"), "user edit after undo");
    const loaded = await client({ cwd: c.cwd, load: c.id });
    try {
      assert.equal(loaded.approvals.length, 0);
      assert.equal(loaded.executed.length, 0);
      assertManualHistory(loaded.state().messages);
      assert.equal(
        await readFile(join(c.cwd, "a.txt"), "utf8"),
        "user edit after undo",
      );
      assert.equal(
        await readFile(join(c.cwd, "record.json"), "utf8"),
        exported,
      );
      await loaded.prompt("Continue from the saved manual operations");
      assertManualHistory(requests.at(-1).messages);
      assert.equal(loaded.state().checkpoints[0].status, "undone");
      assert.equal(loaded.state().checkpoints.length, 2);
      assert(
        loaded.approvals.every((p) =>
          p.toolCall.title.startsWith("Activate exact workspace"),
        ),
      );
    } finally {
      await loaded.close();
    }
  } finally {
    await c.close();
  }
});

test("edit storage preflight refuses a checkpoint near the transcript quota before approval or mutation", async () => {
  const c = await client();
  try {
    await c.prompt("Prepare a long-lived coding session");
    const before = "B".repeat(90000),
      after = "A".repeat(90000);
    await writeFile(join(c.cwd, "a.txt"), before);
    c.state().messages.push(
      { role: "assistant", content: "X".repeat(800000) },
      { role: "assistant", content: "Y".repeat(800000) },
    );
    // Keep original history locally while sending only its established summary.
    c.state().compaction = {
      summary:
        "Two large completed fixture results; the next file edit is pending.",
      through: c.state().messages.length,
      count: 1,
      automatic: false,
    };
    const approvals = c.approvals.length;
    pending = [[call("write_file", { path: "a.txt", before, after }, "quota")]];
    await c.prompt("Apply the proposed change only if its checkpoint fits");
    assert.equal(await readFile(join(c.cwd, "a.txt"), "utf8"), before);
    assert.equal(c.approvals.length, approvals);
    assert.equal(c.state().checkpoints.length, 0);
    const failure = events(c)
      .filter((e) => e.toolCallId === "quota")
      .at(-1);
    assert.equal(failure.status, "failed");
    assert.match(
      JSON.stringify(failure.content),
      /Session checkpoint budget exceeded/,
    );
    const saved = await readJson(`session-${c.id}.json`);
    assert.equal(saved.checkpoints.length, 0);
    assert(saved.messages.some((m) => m.content === "X".repeat(800000)));
  } finally {
    await c.close();
  }
});

test("undo rejection, changed content and read-only mode never overwrite user work", async () => {
  let undoChoice = "deny",
    changeWhilePending = false;
  const c = await client({
    choose: async (p) => {
      if (!p.toolCall.title.startsWith("Undo agent edit")) return "once";
      if (changeWhilePending)
        await writeFile(join(c.cwd, "a.txt"), "user edit during approval");
      return undoChoice;
    },
  });
  try {
    await edit(c);
    await c.prompt("/undo");
    assert.equal(await readFile(join(c.cwd, "a.txt"), "utf8"), "new");
    assert.equal(c.state().checkpoints[0].status, "applied");
    await c.select("permissions", "read_only");
    const before = c.approvals.length;
    await c.prompt("/undo");
    assert.equal(c.approvals.length, before);
    assert.match(lastText(c), /read-only/);
    await c.select("permissions", "scoped");
    await writeFile(join(c.cwd, "a.txt"), "user edit before undo");
    await c.prompt("/undo");
    assert.equal(c.approvals.length, before);
    assert.match(lastText(c), /Stale/);
    await writeFile(join(c.cwd, "a.txt"), "new");
    undoChoice = "once";
    changeWhilePending = true;
    await c.prompt("/undo");
    assert.equal(
      await readFile(join(c.cwd, "a.txt"), "utf8"),
      "user edit during approval",
    );
    assert.equal(c.state().checkpoints[0].status, "applied");
  } finally {
    await c.close();
  }
});

test("nested instructions are scoped, refreshed and precede a first proposed edit", async () => {
  const c = await client();
  try {
    await mkdir(join(c.cwd, "src"));
    await mkdir(join(c.cwd, "sibling"));
    await writeFile(join(c.cwd, "AGENTS.md"), "ROOT guidance fixture");
    await writeFile(join(c.cwd, "src/AGENTS.md"), "NESTED guidance fixture");
    await writeFile(
      join(c.cwd, "sibling/AGENTS.md"),
      "SIBLING must stay unread",
    );
    await writeFile(join(c.cwd, "src/code.txt"), "before");
    pending = [
      [
        call(
          "write_file",
          { path: "src/code.txt", before: "before", after: "after" },
          "first-proposal",
        ),
        call(
          "write_file",
          { path: "src/code.txt", before: "before", after: "batch-bypass" },
          "same-batch-proposal",
        ),
      ],
      [
        call(
          "write_file",
          { path: "src/code.txt", before: "before", after: "after" },
          "retry-proposal",
        ),
      ],
    ];
    await c.prompt("Edit the scoped source file");
    assert.equal(await readFile(join(c.cwd, "src/code.txt"), "utf8"), "after");
    for (const id of ["first-proposal", "same-batch-proposal"]) {
      const rejected = events(c)
        .filter((e) => e.toolCallId === id)
        .at(-1);
      assert.equal(rejected.status, "failed");
      assert.match(
        rejected.content.at(-1).content.text,
        /instructions changed or were newly discovered/,
      );
      assert(!c.approvals.some((p) => p.toolCall.toolCallId === id));
    }
    assert.equal(
      requests[1].messages.filter(
        (m) =>
          m.role === "tool" &&
          ["first-proposal", "same-batch-proposal"].includes(m.tool_call_id),
      ).length,
      2,
    );
    assert(JSON.stringify(requests[1]).includes("NESTED guidance fixture"));
    assert.equal(c.state().checkpoints.length, 1);
    const serialized = JSON.stringify(requests);
    assert(serialized.includes("ROOT guidance fixture"));
    assert(serialized.includes("NESTED guidance fixture"));
    assert(!serialized.includes("SIBLING must stay unread"));
    await writeFile(
      join(c.cwd, "src/AGENTS.md"),
      "UPDATED nested guidance fixture",
    );
    pending = [[call("read_file", { path: "src/code.txt" })]];
    await c.prompt("Read the source again");
    assert(
      JSON.stringify(requests.at(-1)).includes(
        "UPDATED nested guidance fixture",
      ),
    );
    assert.equal(
      requests
        .at(-1)
        .messages.find(
          (m) => m.role === "tool" && m.tool_call_id === "read_file",
        ).content,
      "after",
    );
  } finally {
    await c.close();
  }
});

test("checkpoints preserve unsaved editor text and undo rechecks client content after approval", async () => {
  let editorText = "unsaved original",
    writes = 0,
    changeDuringApproval = true;
  const c = await client({
    editor: {
      read: () => editorText,
      write: (_path, text) => {
        writes++;
        editorText = text;
      },
    },
    choose: (p) => {
      if (
        changeDuringApproval &&
        p.toolCall.title.startsWith("Undo agent edit")
      )
        editorText = "user typed while approval was pending";
      return "once";
    },
  });
  try {
    pending = [
      [
        call("write_file", {
          path: "a.txt",
          before: "unsaved original",
          after: "agent replacement",
        }),
      ],
    ];
    await c.prompt("Apply an editor-aware change");
    assert.equal(editorText, "agent replacement");
    assert.equal(writes, 1);
    assert.equal(c.state().checkpoints[0].before, "unsaved original");
    assert.equal(await readFile(join(c.cwd, "a.txt"), "utf8"), "old");
    await c.prompt("/undo");
    assert.match(lastText(c), /Stale undo/);
    assert.equal(editorText, "user typed while approval was pending");
    assert.equal(writes, 1);
    assert.equal(c.state().checkpoints[0].status, "applied");
    changeDuringApproval = false;
    editorText = "agent replacement";
    await c.prompt("/undo");
    assert.equal(editorText, "unsaved original");
    assert.equal(writes, 2);
    assert.equal(c.state().checkpoints[0].status, "undone");
    assert.equal(await readFile(join(c.cwd, "a.txt"), "utf8"), "old");
  } finally {
    await c.close();
  }
});

test("cancelling undo ignores a late approval and keeps the applied checkpoint", async () => {
  let entered, release;
  const ready = new Promise((resolve) => {
    entered = resolve;
  });
  const c = await client({
    choose: (p) => {
      if (!p.toolCall.title.startsWith("Undo agent edit")) return "once";
      entered();
      return new Promise((resolve) => {
        release = resolve;
      });
    },
  });
  try {
    await edit(c);
    const turn = c.prompt("/undo");
    await ready;
    await c.connection.agent.notify("session/cancel", { sessionId: c.id });
    assert.equal((await turn).stopReason, "cancelled");
    release("once");
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(await readFile(join(c.cwd, "a.txt"), "utf8"), "new");
    assert.equal(c.state().checkpoints[0].status, "applied");
    assert.equal(
      (await readJson(`session-${c.id}.json`)).checkpoints[0].status,
      "applied",
    );
  } finally {
    release?.("deny");
    await c.close();
  }
});

test("cancelling an approved undo during editor reread cannot start a late write", async () => {
  let editorText = "old",
    writes = 0,
    pauseRead = false,
    entered,
    release;
  const ready = new Promise((resolve) => {
    entered = resolve;
  });
  const c = await client({
    editor: {
      read: () => {
        if (!pauseRead) return editorText;
        entered();
        return new Promise((resolve) => {
          release = () => resolve(editorText);
        });
      },
      write: (_path, text) => {
        writes++;
        editorText = text;
      },
    },
    choose: (p) => {
      if (p.toolCall.title.startsWith("Undo agent edit")) pauseRead = true;
      return "once";
    },
  });
  try {
    await edit(c);
    const turn = c.prompt("/undo");
    await ready;
    await c.connection.agent.notify("session/cancel", { sessionId: c.id });
    assert.equal((await turn).stopReason, "cancelled");
    release();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(writes, 1);
    assert.equal(editorText, "new");
    assert.equal(c.state().checkpoints[0].status, "applied");
  } finally {
    release?.();
    await c.close();
  }
});

test("root instruction snapshots redact configured credentials before retention and inference", async () => {
  const c = await client();
  try {
    await writeFile(
      join(c.cwd, "AGENTS.md"),
      "Untrusted fixture: synthetic-next-flow-key",
    );
    await c.prompt("Inspect the instructions");
    assert(!JSON.stringify(requests).includes("synthetic-next-flow-key"));
    assert(
      !JSON.stringify(c.state().messages).includes("synthetic-next-flow-key"),
    );
    assert(
      !JSON.stringify(c.state().instructions).includes(
        "synthetic-next-flow-key",
      ),
    );
    pending = [
      [call("write_file", { path: "a.txt", before: "old", after: "new" })],
    ];
    await c.prompt("Apply the requested edit");
    assert.equal(await readFile(join(c.cwd, "a.txt"), "utf8"), "new");
  } finally {
    await c.close();
  }
});
