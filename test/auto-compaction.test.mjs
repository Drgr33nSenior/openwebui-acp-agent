import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, writeFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClientApp } from "@agentclientprotocol/sdk";

const temporary = await realpath(await mkdtemp(join(tmpdir(), "ow-auto-")));
process.env.OPENWEBUI_ACP_HOME = join(temporary, "state");
process.env.OPENWEBUI_API_KEY = "synthetic-compaction-key";
const { createAgent } = await import("../dist/agent.js");
const { directory, writeJson, configSchema } =
  await import("../dist/config.js");
assert.equal(
  directory,
  process.env.OPENWEBUI_ACP_HOME,
  "Application state must use the test's private directory before any writes",
);
const {
  compactionStateSchema,
  compactHistory,
  canCompact,
  contextMessages,
  contextPressure,
  MAX_TURN_COMPACTIONS,
} = await import("../dist/compaction.js");
const { contextLimits, charsPerToken, promptContextTokens } =
  await import("../dist/usage.js");
const { firstChangedLine } = await import("../dist/edits.js");

// The fixture counts four serialized characters per prompt token, so the
// agent's measured ratio is exact and thresholds can be placed precisely.
const requestChars = (r) =>
  JSON.stringify(r.messages).length + JSON.stringify(r.tools).length;
let model = { id: "fixture", context_window: 1_000_000 };
let pending = [];
let summary;
const requests = [];
const server = createServer(async (req, res) => {
  res.setHeader("Content-Type", "application/json");
  if (req.url === "/api/models")
    return res.end(JSON.stringify({ data: [model] }));
  let raw = "";
  for await (const part of req) raw += part;
  const request = JSON.parse(raw);
  requests.push(request);
  const message =
    request.tools.length === 0
      ? { role: "assistant", content: summary(request) }
      : (pending.shift() ?? { role: "assistant", content: "Done" });
  res.end(
    JSON.stringify({
      choices: [
        { message, finish_reason: message.tool_calls ? "tool_calls" : "stop" },
      ],
      usage: {
        prompt_tokens: Math.ceil(requestChars(request) / 4),
        completion_tokens: 10,
      },
    }),
  );
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const url = `http://127.0.0.1:${server.address().port}`;
await writeJson("config.json", configSchema.parse({ url, model: "fixture" }));
test.after(() => new Promise((r) => server.close(r)));
test.beforeEach(() => {
  pending = [];
  requests.length = 0;
  summary = () =>
    "Task: inspect the fixture files. first.txt was read; nothing was changed. No checks have run.";
});

const FILE = 60000;
const read = (path, id) => ({
  role: "assistant",
  content: null,
  tool_calls: [
    {
      id,
      type: "function",
      function: { name: "read_file", arguments: JSON.stringify({ path }) },
    },
  ],
});
async function client() {
  const cwd = await realpath(await mkdtemp(join(temporary, "project-")));
  await writeFile(join(cwd, "first.txt"), "first ".repeat(FILE / 6));
  await writeFile(join(cwd, "second.txt"), "second ".repeat(FILE / 7));
  const app = new ClientApp(),
    agent = createAgent(),
    updates = [];
  app.onNotification("session/update", ({ params }) =>
    updates.push(params.update),
  );
  app.onRequest("session/request_permission", () => ({
    outcome: { outcome: "selected", optionId: "once" },
  }));
  const connection = app.connect(agent.app);
  await connection.agent.request("initialize", {
    protocolVersion: 1,
    clientCapabilities: {},
  });
  const { sessionId } = await connection.agent.request("session/new", {
    cwd,
    mcpServers: [],
  });
  return {
    updates,
    state: () => agent.sessions.get(sessionId),
    text: () =>
      updates
        .filter((u) => u.sessionUpdate === "agent_message_chunk")
        .map((u) => u.content.text)
        .join(""),
    prompt: (text = "Inspect the fixture files") =>
      connection.agent.request("session/prompt", {
        sessionId,
        prompt: [{ type: "text", text }],
      }),
    close: async () => {
      connection.close();
      await agent.close();
    },
  };
}
// Size of a request that carries no tool results yet.
async function baseline() {
  model = { id: "fixture", context_window: 1_000_000 };
  const c = await client();
  try {
    await c.prompt();
    return requestChars(requests[0]);
  } finally {
    await c.close();
    requests.length = 0;
  }
}
// Two file reads fit one at a time but not together: the third request of the
// turn exceeds the usable input while reported usage stays under the 80% rule.
async function tightModel() {
  const usable = Math.ceil(((await baseline()) + 1.5 * FILE) / 4);
  model = {
    id: "fixture",
    context_window: usable + 8000,
    max_output_tokens: 8000,
  };
  return usable;
}
const paired = (messages) =>
  messages
    .filter((m) => m.role === "tool")
    .every((m) =>
      messages.some((a) => a.tool_calls?.some((t) => t.id === m.tool_call_id)),
    );

test("usable input reserves the output allowance and prefers an explicit input limit", () => {
  assert.deepEqual(
    contextLimits({ context_window: 100768, max_output_tokens: 12288 }, 4096),
    { size: 100768, usable: 88480 },
  );
  assert.deepEqual(contextLimits({ context_window: 262112 }, 12288), {
    size: 262112,
    usable: 249824,
  });
  assert.deepEqual(
    contextLimits(
      { openai: { context_window: 1000, max_input_tokens: 700 } },
      1,
    ),
    { size: 1000, usable: 700 },
  );
  assert.deepEqual(contextLimits({ max_input_tokens: 2000 }, 12288), {
    size: 2000,
    usable: 2000,
  });
  // An allowance that leaves no input is not treated as a usable split.
  assert.deepEqual(contextLimits({ context_window: 8000 }, 12288), {
    size: 8000,
    usable: 4000,
  });
  assert.equal(contextLimits({ id: "unknown" }, 12288), undefined);
});

test("request estimates need a measured ratio and a known limit", () => {
  assert.equal(charsPerToken(4000, 1000), 4);
  assert.equal(charsPerToken(1000, 100000), 1.5);
  assert.equal(charsPerToken(4000, 0), undefined);
  assert.equal(promptContextTokens({ prompt_tokens: 12 }), 12);
  assert.equal(promptContextTokens({ prompt_eval_count: 7 }), 7);
  assert.equal(promptContextTokens({ total_tokens: 9 }), undefined);
  const limits = { size: 1000, usable: 800 };
  assert.deepEqual(contextPressure(3200, 4, limits), {
    estimate: 800,
    over: false,
  });
  assert.deepEqual(contextPressure(3204, 4, limits), {
    estimate: 801,
    over: true,
  });
  assert.deepEqual(contextPressure(1e9, undefined, limits), { over: false });
  assert.deepEqual(contextPressure(1e9, 4, undefined), { over: false });
});

test("a bounded summary request takes a smaller prefix and never splits a tool group", async () => {
  const group = (id) => [
    {
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id,
          type: "function",
          function: { name: "read_file", arguments: "{}" },
        },
      ],
    },
    { role: "tool", tool_call_id: id, content: "x".repeat(5000) },
  ];
  const messages = [
    { role: "system", content: "Authoritative instruction" },
    { role: "user", content: "Do the task" },
    ...group("a"),
    ...group("b"),
    ...group("c"),
    ...group("d"),
  ];
  const state = compactionStateSchema.parse({});
  const signal = AbortSignal.timeout(10000);
  let input;
  const summarize = async (value) => {
    input = value;
    return { role: "assistant", content: "Task and progress." };
  };
  const wide = await compactHistory(messages, state, summarize, signal);
  assert.equal(wide.through, 6);
  const narrow = await compactHistory(messages, state, summarize, signal, {
    maxInputChars: 8000,
  });
  assert.equal(narrow.through, 4);
  assert(JSON.stringify(input).length <= 8000);
  assert(paired(contextMessages(messages, narrow)));
  // Nothing fits: no request is made and nothing is dropped.
  assert.equal(canCompact(messages, state, { maxInputChars: 3000 }), false);
  await assert.rejects(
    compactHistory(messages, state, summarize, signal, { maxInputChars: 3000 }),
    /history retained/,
  );
  // Without the recent-message preference the latest group still survives.
  const last = await compactHistory(messages, state, summarize, signal, {
    keepRecent: false,
  });
  assert.equal(last.through, 8);
  const context = contextMessages(messages, last);
  assert.deepEqual(context[0], messages[0]);
  assert(paired(context));
  assert(context.some((m) => m.tool_call_id === "d"));
  // An unanswered call is pending: the cut stops before it.
  const unfinished = [...messages, group("e")[0]];
  const kept = await compactHistory(unfinished, state, summarize, signal, {
    keepRecent: false,
  });
  assert.equal(kept.through, 10);
  assert(contextMessages(unfinished, kept).some((m) => m.tool_calls));
});

test("first changed line locates an edit for the client", () => {
  assert.equal(firstChangedLine(null, "new\nfile\n"), 1);
  assert.equal(firstChangedLine("a\nb\nc\n", "a\nB\nc\n"), 2);
  assert.equal(firstChangedLine("a\r\nb\r\n", "a\r\nb\r\nc\r\n"), 3);
  assert.equal(firstChangedLine("same", "same"), 1);
});

test("a request that would exceed the usable input is compacted first, with a notice, and the turn continues", async () => {
  const usable = await tightModel();
  const c = await client();
  try {
    pending = [read("first.txt", "one"), read("second.txt", "two")];
    const result = await c.prompt();
    assert.equal(result.stopReason, "end_turn");
    assert.deepEqual(
      requests.map((r) => r.tools.length > 0),
      [true, true, false, true],
    );
    // The reported-usage rule alone would not have fired.
    const reported = c.updates.filter(
      (u) => u.sessionUpdate === "usage_update",
    );
    assert(reported.length >= 2);
    assert(reported.slice(0, 2).every((u) => u.used < u.size * 0.8));
    assert(reported.every((u) => u.size === usable + 8000));
    const [, , summaryRequest, continued] = requests;
    assert.match(summaryRequest.messages[0].content, /untrusted data/);
    assert.match(summaryRequest.messages[0].content, /verification status/);
    assert(requestChars(summaryRequest) / 4 <= usable);
    assert(Math.ceil(requestChars(continued) / 4) <= usable);
    assert.deepEqual(continued.messages[0], requests[0].messages[0]);
    assert(paired(continued.messages));
    assert(continued.messages.some((m) => m.tool_call_id === "two"));
    assert(!continued.messages.some((m) => m.tool_call_id === "one"));
    assert(
      continued.messages.some(
        (m) => m.role === "user" && /Untrusted summary/.test(m.content),
      ),
    );
    assert(
      continued.messages.some(
        (m) =>
          m.role === "user" &&
          m.content.includes(JSON.stringify("Inspect the fixture files")),
      ),
    );
    assert.match(c.text(), /needs about \d+ input tokens; the model accepts/);
    assert.match(c.text(), /Context compacted/);
    assert.equal(c.state().compaction.count, 1);
    // The local transcript keeps both results.
    for (const id of ["one", "two"])
      assert(c.state().messages.some((m) => m.tool_call_id === id));
  } finally {
    await c.close();
  }
});

test("a failed compaction stops the turn before an oversized request, keeping history", async () => {
  await tightModel();
  const c = await client();
  try {
    pending = [read("first.txt", "one"), read("second.txt", "two")];
    summary = () => "";
    const result = await c.prompt();
    assert.equal(result.stopReason, "end_turn");
    assert.deepEqual(
      requests.map((r) => r.tools.length > 0),
      [true, true, false],
    );
    assert.match(
      c.text(),
      /Context is full: the next request needs about \d+ input tokens.*automatic compaction failed\. Nothing was sent/,
    );
    assert.doesNotMatch(c.text(), /Continuing within existing context limits/);
    assert.equal(c.state().compaction.count, 0);
    assert(paired(c.state().messages));
    assert(c.state().messages.some((m) => m.tool_call_id === "two"));
    // Disabled compaction is respected: the next turn stops without a summary.
    await c.prompt("/autocompact off");
    requests.length = 0;
    await c.prompt("Continue");
    assert.equal(requests.length, 0);
    assert.match(c.text(), /automatic compaction is off/);
  } finally {
    await c.close();
  }
});

test("automatic compaction is bounded per turn", async () => {
  const usable = await tightModel();
  const c = await client();
  try {
    await c.prompt("Measure");
    const chunk = Math.floor(usable * 4 * 0.4);
    const s = c.state();
    for (let i = 0; i < 12; i++)
      s.messages.push(read("first.txt", `seed-${i}`), {
        role: "tool",
        tool_call_id: `seed-${i}`,
        content: "y".repeat(chunk),
      });
    requests.length = 0;
    const result = await c.prompt("Continue");
    assert.equal(result.stopReason, "end_turn");
    assert.equal(requests.length, MAX_TURN_COMPACTIONS);
    assert(requests.every((r) => r.tools.length === 0));
    assert(requests.every((r) => requestChars(r) / 4 <= usable));
    assert.equal(s.compaction.count, MAX_TURN_COMPACTIONS);
    assert.match(
      c.text(),
      new RegExp(
        `Context is full.*already compacted its context ${MAX_TURN_COMPACTIONS} times`,
      ),
    );
    assert(paired(contextMessages(s.messages, s.compaction)));
  } finally {
    await c.close();
  }
});
