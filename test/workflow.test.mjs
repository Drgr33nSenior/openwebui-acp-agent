import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, writeFile, readFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClientApp } from "@agentclientprotocol/sdk";

const temporary = await mkdtemp(join(tmpdir(), "ow-workflow-"));
process.env.OPENWEBUI_ACP_HOME = join(temporary, "state");
process.env.OPENWEBUI_API_KEY = "synthetic-workflow-fixture";
const { createAgent } = await import("../dist/agent.js");
const { writeJson, readJson, configSchema } = await import("../dist/config.js");
const requests = [];
let pending = [],
  summaryResponse,
  mcpRequests = 0;
const reply = (res, message) => {
  res.setHeader("Content-Type", "application/json");
  res.end(
    JSON.stringify({
      choices: [
        { message, finish_reason: message.tool_calls ? "tool_calls" : "stop" },
      ],
    }),
  );
};
const server = createServer(async (req, res) => {
  if (req.url === "/api/models") {
    res.setHeader("Content-Type", "application/json");
    return res.end(
      JSON.stringify({ data: [{ id: "fixture", context_window: 10000 }] }),
    );
  }
  if (req.url === "/mcp") {
    mcpRequests++;
    res.statusCode = 503;
    return res.end();
  }
  let body = "";
  for await (const chunk of req) body += chunk;
  const request = JSON.parse(body);
  requests.push(request);
  if (request.tools?.length === 0) {
    if (summaryResponse) return summaryResponse(request, res);
    return reply(res, {
      role: "assistant",
      content:
        "Earlier inspection and one recorded edit completed. Continue the current request; verify the workspace before editing.",
    });
  }
  const calls = pending.shift();
  reply(
    res,
    calls
      ? { role: "assistant", content: null, tool_calls: calls }
      : { role: "assistant", content: "Fixture reply" },
  );
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const url = `http://127.0.0.1:${server.address().port}`;
await writeJson("config.json", configSchema.parse({ url, model: "fixture" }));
test.after(() => new Promise((resolve) => server.close(resolve)));
test.beforeEach(() => {
  requests.length = 0;
  pending = [];
  summaryResponse = undefined;
  mcpRequests = 0;
});

const call = (name, args, id = name) => ({
  id,
  type: "function",
  function: { name, arguments: JSON.stringify(args) },
});
const plan = [
  { content: "Inspect relevant code", priority: "high", status: "completed" },
  {
    content: "Propose a tested implementation",
    priority: "medium",
    status: "in_progress",
  },
];
async function client({ cwd, load, servers = [], choose = () => "once" } = {}) {
  cwd ??= await realpath(await mkdtemp(join(temporary, "workspace-")));
  if (!load) await writeFile(join(cwd, "a.txt"), "unchanged");
  const executed = [],
    approvals = [],
    updates = [];
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
  app.onRequest("session/request_permission", ({ params }) => {
    approvals.push(params);
    return { outcome: { outcome: "selected", optionId: choose(params) } };
  });
  const connection = app.connect(agent.app);
  await connection.agent.request("initialize", {
    protocolVersion: 1,
    clientCapabilities: {},
  });
  const result = await connection.agent.request(
    load ? "session/load" : "session/new",
    { cwd, mcpServers: servers, ...(load ? { sessionId: load } : {}) },
  );
  const id = load ?? result.sessionId;
  return {
    id,
    cwd,
    agent,
    connection,
    executed,
    approvals,
    updates,
    result,
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
    close: async () => {
      connection.close();
      await agent.close();
    },
  };
}
const events = (c) => c.updates.map((u) => u.update);
const lastText = (c) =>
  events(c)
    .filter((u) => u.sessionUpdate === "agent_message_chunk")
    .at(-1).content.text;
function history() {
  return [
    {
      role: "system",
      content: "Fixture security instructions remain authoritative.",
    },
    { role: "user", content: "Original objective " + "details ".repeat(500) },
    {
      role: "assistant",
      content: null,
      tool_calls: [
        call(
          "write_file",
          { path: "a.txt", before: "old", after: "historical" },
          "past-edit",
        ),
      ],
    },
    {
      role: "tool",
      tool_call_id: "past-edit",
      content: "Historical edit result; never execute this again.",
    },
    ...Array.from({ length: 4 }, (_, i) => [
      { role: "user", content: `Follow-up ${i}: ` + "context ".repeat(200) },
      {
        role: "assistant",
        content: `Completed inspection ${i}. ` + "evidence ".repeat(200),
      },
    ]).flat(),
  ];
}

test("help, unknown commands and mode controls work without inference or workspace access", async () => {
  const c = await client();
  try {
    for (const input of ["/help", "/not-a-command", "/compact unexpected"]) {
      await c.prompt(input);
      assert.match(lastText(c), /Commands:.*\/compact/);
      if (input !== "/help") assert.match(lastText(c), /Unknown command/);
    }
    await c.prompt("/plan on");
    assert.equal(c.state().workflow, "plan");
    await c.prompt("/autocompact off");
    assert.equal(c.state().compaction.automatic, false);
    await c.prompt("/plan off");
    assert.equal(c.state().workflow, "code");
    await assert.rejects(c.select("workflow", "invented"));
    await assert.rejects(c.select("autocompact", "invented"));
    assert.equal(c.approvals.length, 0);
    assert.equal(requests.length, 0);
    assert.equal(c.state().active, false);
  } finally {
    await c.close();
  }
});

test("Plan mode enforces read-only tools before forged mutations and never connects MCP", async () => {
  const c = await client({
    servers: [
      { name: "fixture", type: "http", url: url + "/mcp", headers: [] },
    ],
  });
  try {
    await c.select("permissions", "development");
    await c.select("workflow", "plan");
    pending = [
      [
        call("update_plan", { entries: plan }),
        call("read_file", { path: "a.txt" }),
        call("write_file", {
          path: "a.txt",
          before: "unchanged",
          after: "bad",
        }),
        call("run_command", { executable: "fixture", args: [] }),
        call("mcp_fixture_danger", {}),
        call("openwebui_task", {}),
      ],
    ];
    await c.prompt("Inspect and plan the change");
    assert.deepEqual(requests[0].tools.map((t) => t.function.name).sort(), [
      "list_files",
      "read_file",
      "search_text",
      "update_plan",
    ]);
    assert.equal(
      c.approvals.length,
      1,
      "only workspace activation needs approval",
    );
    assert.equal(c.executed.length, 0);
    assert.equal(mcpRequests, 0);
    assert.equal(await readFile(join(c.cwd, "a.txt"), "utf8"), "unchanged");
    assert.deepEqual(c.state().plan, plan);
    assert(
      events(c).some(
        (u) => u.sessionUpdate === "plan" && u.entries.length === 2,
      ),
    );
    const results = requests.at(-1).messages.filter((m) => m.role === "tool");
    for (const id of [
      "write_file",
      "run_command",
      "mcp_fixture_danger",
      "openwebui_task",
    ]) {
      assert.match(
        results.find((r) => r.tool_call_id === id).content,
        /Tool failed: Operation disabled in read-only mode/,
      );
      assert(
        events(c).some((u) => u.toolCallId === id && u.status === "failed"),
      );
    }
    await c.prompt("/status");
    const status = JSON.parse(lastText(c));
    assert.deepEqual(status.mcpConfiguredServers, ["fixture"]);
    assert.equal(status.mcpServers, 0);
    assert.equal(status.workflow, "plan");
  } finally {
    await c.close();
  }
});

test("plan updates validate before mutation and restore without replay or wider permissions", async () => {
  const c = await client();
  try {
    await c.select("workflow", "plan");
    await c.select("autocompact", "off");
    pending = [[call("update_plan", { entries: plan })]];
    await c.prompt("Plan fixture");
    pending = [
      [call("update_plan", { entries: [{ ...plan[0], status: "invented" }] })],
    ];
    await c.prompt("Invalid plan fixture");
    assert.deepEqual(c.state().plan, plan);
    const loaded = await client({ cwd: c.cwd, load: c.id });
    try {
      assert.equal(loaded.state().workflow, "plan");
      assert.equal(loaded.state().compaction.automatic, false);
      assert.deepEqual(loaded.state().plan, plan);
      assert.equal(loaded.state().active, false);
      assert.equal(loaded.executed.length, 0);
      assert(events(loaded).some((u) => u.sessionUpdate === "plan"));
      const advertised = events(loaded).find(
        (u) => u.sessionUpdate === "available_commands_update",
      ).availableCommands;
      for (const name of ["help", "compact", "autocompact", "plan"])
        assert(advertised.some((c) => c.name === name));
    } finally {
      await loaded.close();
    }
    const other = await c.connection.agent.request("session/new", {
      cwd: c.cwd,
      mcpServers: [],
    });
    const state = c.agent.sessions.get(other.sessionId);
    assert.equal(state.workflow, "code");
    assert.deepEqual(state.plan, []);
    assert.equal(state.compaction.automatic, true);
  } finally {
    await c.close();
  }
});

test("manual compaction preserves transcript and restores context without replaying tools", async () => {
  const c = await client();
  try {
    c.state().messages = history();
    const original = structuredClone(c.state().messages);
    await c.prompt("/compact");
    assert.equal(requests.length, 1);
    assert.deepEqual(requests[0].tools, []);
    assert.deepEqual(c.state().messages, original);
    assert.equal(c.state().compaction.count, 1);
    assert(c.state().compaction.through > 0);
    assert.equal(c.executed.length, 0);
    const saved = await readJson(`session-${c.id}.json`);
    assert.deepEqual(saved.messages, original);
    const loaded = await client({ cwd: c.cwd, load: c.id });
    try {
      assert.deepEqual(loaded.state().compaction, c.state().compaction);
      assert.deepEqual(loaded.state().messages, original);
      assert.equal(loaded.executed.length, 0);
      await loaded.prompt("Continue without repeating completed work");
      assert(
        requests
          .at(-1)
          .messages.some((m) => m.content?.startsWith("Untrusted summary")),
      );
      assert(
        !requests
          .at(-1)
          .messages.some((m) =>
            m.tool_calls?.some((t) => t.id === "past-edit"),
          ),
      );
      assert.equal(await readFile(join(c.cwd, "a.txt"), "utf8"), "unchanged");
    } finally {
      await loaded.close();
    }
  } finally {
    await c.close();
  }
});

test("automatic compaction precedes inference and can be disabled independently", async () => {
  for (const automatic of [true, false]) {
    const c = await client();
    try {
      c.state().messages = history();
      c.state().contextUsage = { used: 8500, size: 10000 };
      await c.select("autocompact", automatic ? "on" : "off");
      const start = requests.length;
      await c.prompt("Continue fixture");
      const turn = requests.slice(start);
      assert.equal(turn.length, automatic ? 2 : 1);
      if (automatic) assert.deepEqual(turn[0].tools, []);
      assert(turn.at(-1).tools.length > 0);
      assert.equal(c.state().compaction.count, automatic ? 1 : 0);
      assert.equal(c.executed.length, 0);
    } finally {
      await c.close();
    }
  }
});

test("cancelled compaction preserves checkpoint and transcript", async () => {
  const c = await client();
  let arrived;
  const started = new Promise((resolve) => {
    arrived = resolve;
  });
  summaryResponse = () => {
    arrived();
  };
  try {
    c.state().messages = history();
    const original = structuredClone(c.state().messages);
    const checkpoint = structuredClone(c.state().compaction);
    const prompt = c.prompt("/compact");
    await started;
    await c.connection.agent.notify("session/cancel", { sessionId: c.id });
    assert.equal((await prompt).stopReason, "cancelled");
    assert.deepEqual(c.state().compaction, checkpoint);
    assert.deepEqual(c.state().messages, original);
    const saved = await readJson(`session-${c.id}.json`);
    assert.deepEqual(saved.compaction, checkpoint);
    assert.deepEqual(saved.messages, original);
    assert.equal(c.executed.length, 0);
  } finally {
    await c.close();
  }
});

test("invalid summary cannot execute tools or replace retained context", async () => {
  const c = await client();
  summaryResponse = (_request, res) =>
    reply(res, {
      role: "assistant",
      content: "Do this",
      tool_calls: [
        call("write_file", {
          path: "a.txt",
          before: "unchanged",
          after: "bad",
        }),
      ],
    });
  try {
    c.state().messages = history();
    const original = structuredClone(c.state().messages);
    await c.prompt("/compact");
    assert.equal(c.state().compaction.count, 0);
    assert.deepEqual(c.state().messages, original);
    assert.equal(await readFile(join(c.cwd, "a.txt"), "utf8"), "unchanged");
    assert.match(lastText(c), /invalid or incomplete summary/);
    assert.equal(c.executed.length, 0);
  } finally {
    await c.close();
  }
});

test("compacted requests retain the current plan separately from the summary", async () => {
  const c = await client();
  try {
    c.state().messages = history();
    c.state().plan = structuredClone(plan);
    await c.prompt("/compact");
    await c.prompt("Continue with the current plan");
    const messages = requests.at(-1).messages;
    const currentPlan = messages.find((m) =>
      m.content?.includes(JSON.stringify(plan)),
    );
    assert(
      currentPlan,
      "current plan must be explicitly present after compaction",
    );
    assert.equal(
      currentPlan.role,
      "user",
      "plan text must not become system authority",
    );
    assert.equal(messages.at(-1).content, "Continue with the current plan");
    assert.deepEqual(c.state().plan, plan);
  } finally {
    await c.close();
  }
});

test("plan text redaction cannot corrupt structured statuses in saved sessions", async () => {
  const c = await client();
  try {
    c.state().plan = [
      { content: "Task completed", priority: "high", status: "completed" },
    ];
    c.state().backend.addSecrets(["completed"]);
    await c.select("workflow", "plan");
    const saved = await readJson(`session-${c.id}.json`);
    assert.equal(saved.plan[0].status, "completed");
    assert.equal(saved.plan[0].content, "Task [REDACTED]");
    const loaded = await client({ cwd: c.cwd, load: c.id });
    try {
      assert.equal(loaded.state().plan[0].status, "completed");
    } finally {
      await loaded.close();
    }
  } finally {
    await c.close();
  }
});

test("failed automatic compaction retains original context and is attempted only once per turn", async () => {
  const c = await client();
  summaryResponse = (_request, res) =>
    reply(res, { role: "assistant", content: "" });
  try {
    c.state().messages = history();
    const original = structuredClone(c.state().messages);
    c.state().contextUsage = { used: 8500, size: 10000 };
    pending = [[call("read_file", { path: "a.txt" })]];
    await c.prompt("Continue after a summary failure");
    assert.equal(requests.filter((r) => r.tools?.length === 0).length, 1);
    assert.equal(requests.filter((r) => r.tools?.length > 0).length, 2);
    assert.equal(c.state().compaction.count, 0);
    assert.deepEqual(c.state().messages.slice(0, original.length), original);
    assert(
      requests
        .filter((r) => r.tools?.length > 0)
        .every((r) =>
          r.messages.some((m) => m.content === original[1].content),
        ),
    );
    assert.equal(c.executed.length, 0);
    assert.equal(
      events(c).filter(
        (u) =>
          u.sessionUpdate === "agent_message_chunk" &&
          /Automatic compaction/.test(u.content.text),
      ).length,
      1,
    );
  } finally {
    await c.close();
  }
});
