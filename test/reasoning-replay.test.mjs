import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
const temp = await mkdtemp(join(tmpdir(), "acp-reasoning-"));
process.env.OPENWEBUI_ACP_HOME = join(temp, "state");
process.env.OPENWEBUI_API_KEY = "fixture-private-key";
const { Backend, MAX } = await import("../dist/backend.js");
const { configSchema, writeJson } = await import("../dist/config.js");
let reply,
  metadata = [],
  requests = [];
const server = createServer(async (req, res) => {
  if (req.url === "/api/models") {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ data: metadata }));
    return;
  }
  let body = "";
  for await (const chunk of req) body += chunk;
  requests.push(JSON.parse(body));
  await reply(req, res);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const config = configSchema.parse({
  url: `http://127.0.0.1:${server.address().port}`,
  model: "opaque-alias",
});
const backend = () =>
  new Backend(config, "fixture-private-key", async () => ({ rules: {} }));
const json = (message) => (_req, res) => {
  res.setHeader("content-type", "application/json");
  res.end(
    JSON.stringify({
      choices: [
        { message, finish_reason: message.tool_calls ? "tool_calls" : "stop" },
      ],
    }),
  );
};
const sse = (deltas) => (_req, res) => {
  res.setHeader("content-type", "text/event-stream");
  for (const delta of deltas)
    res.write(`data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`);
  res.end(
    'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
  );
};
const call = (id) => ({
  id,
  type: "function",
  function: { name: "list_files", arguments: "{}" },
});
const complete = (
  b,
  messages = [],
  signal = AbortSignal.timeout(5000),
  onText = async () => {},
) => b.complete(messages, [], signal, onText);
test.after(() => server.close());
test("structured reasoning survives completion separately from visible text", async () => {
  reply = json({ content: "visible", reasoning_content: "private" });
  let visible = "";
  const result = await complete(backend(), [], undefined, async (s) => {
    visible += s;
  });
  assert.equal(result.reasoning_content, "private");
  assert.equal(result.content, "visible");
  assert.equal(visible, "visible");
});

for (const streaming of [false, true]) {
  test(`${streaming ? "streamed" : "JSON"} alias reasoning replays through two multiple-call rounds`, async () => {
    requests = [];
    metadata = [
      {
        id: config.model,
        provider_capabilities: { reasoning_replay: "reasoning_content" },
      },
    ];
    const b = backend();
    await b.modelMetadata(AbortSignal.timeout(5000));
    const history = [{ role: "user", content: "task" }];
    for (let round = 0; round < 2; round++) {
      const calls = [call(`${round}-a`), call(`${round}-b`)];
      reply = streaming
        ? sse([
            { reasoning: "private " },
            {
              reasoning: `round ${round}`,
              content: "",
              tool_calls: calls.map((c, index) => ({ ...c, index })),
            },
          ])
        : json({
            content: null,
            reasoning: `private round ${round}`,
            tool_calls: calls,
          });
      const result = await complete(b, history);
      assert.equal(result.reasoning_content, `private round ${round}`);
      assert.deepEqual(result.tool_calls, calls);
      history.push(
        result,
        ...calls.map((c) => ({
          role: "tool",
          tool_call_id: c.id,
          content: "observed",
        })),
      );
    }
    reply = json({ content: "done" });
    await complete(b, history);
    assert.deepEqual(requests[2].messages, history);
    assert.deepEqual(requests[1].messages, history.slice(0, 4));
    assert.equal(requests[2].reasoning_effort, undefined);
    assert.equal(requests[2].temperature, undefined);
  });
}
test("missing, unknown and revoked declarations strip private fields for strict providers", async () => {
  const b = backend();
  for (const declaration of [
    "reasoning_content",
    undefined,
    true,
    "reasoning",
  ]) {
    metadata = [
      {
        id: config.model,
        provider_capabilities: { reasoning_replay: declaration },
      },
    ];
    await b.modelMetadata(AbortSignal.timeout(5000));
    reply = json({ content: "ok" });
    await complete(b, [
      { role: "assistant", content: "visible", reasoning_content: "private" },
    ]);
    assert.deepEqual(requests.at(-1).messages, [
      {
        role: "assistant",
        content: "visible",
        ...(declaration === "reasoning_content"
          ? { reasoning_content: "private" }
          : {}),
      },
    ]);
  }
});
test("reasoning is redacted, independently bounded and counted in outgoing context", async () => {
  const b = backend();
  reply = sse([
    { reasoning_content: "fixture-" },
    { reasoning_content: "private-key hidden" },
  ]);
  assert.equal((await complete(b)).reasoning_content, "[REDACTED] hidden");
  reply = sse([{ reasoning: "x".repeat(MAX) }, { reasoning: "x" }]);
  await assert.rejects(complete(b), /Reasoning retention limit exceeded/);
  metadata = [
    {
      id: config.model,
      provider_capabilities: { reasoning_replay: "reasoning_content" },
    },
  ];
  await b.modelMetadata(AbortSignal.timeout(5000));
  const before = requests.length;
  await assert.rejects(
    complete(b, [
      { role: "assistant", content: "", reasoning_content: "x".repeat(MAX) },
    ]),
    /Context budget exceeded/,
  );
  assert.equal(requests.length, before);
});
test("malformed reasoning, conflicting aliases, duplicate tool IDs and interrupted replies never return executable history", async () => {
  const b = backend();
  for (const message of [
    { content: "", reasoning_content: {}, tool_calls: [call("a")] },
    {
      content: "",
      reasoning_content: "a",
      reasoning: "b",
      tool_calls: [call("a")],
    },
    { content: "", reasoning: "private", tool_calls: [call("a"), call("a")] },
  ]) {
    reply = sse([message]);
    await assert.rejects(complete(b), /Malformed|Conflicting/);
  }
  reply = (_req, res) => {
    res.setHeader("content-type", "text/event-stream");
    res.end(
      'data: {"choices":[{"delta":{"reasoning":"private","tool_calls":[{"index":0,"id":"a","function":{"name":"list_files","arguments":"{}"}}]}}]}\n\n',
    );
  };
  await assert.rejects(complete(b), /Truncated stream/);
  const controller = new AbortController();
  reply = (_req, res) => {
    res.setHeader("content-type", "text/event-stream");
    res.write('data: {"choices":[{"delta":{"reasoning":"private"}}]}\n\n');
    controller.abort();
    res.end();
  };
  await assert.rejects(complete(b, [], controller.signal));
});

test("ACP executes each new tool once and replays private reasoning without rendering it", async () => {
  const { ClientApp } = await import("@agentclientprotocol/sdk");
  const { createAgent } = await import("../dist/agent.js");
  const { changeTrust } = await import("../dist/workspace.js");
  const workspace = join(temp, "project");
  await mkdir(workspace);
  await writeJson("config.json", config);
  await changeTrust(workspace, config.url, true);
  metadata = [
    {
      id: config.model,
      provider_capabilities: { reasoning_replay: "reasoning_content" },
    },
  ];
  requests = [];
  reply = (req, res) => {
    const round = requests.length - 1;
    return json(
      round < 2
        ? {
            content: "",
            reasoning_content: `private-${round}`,
            tool_calls: [call(`${round}-a`), call(`${round}-b`)],
          }
        : { content: "done" },
    )(req, res);
  };
  const agent = createAgent();
  const updates = [];
  let approvals = 0;
  const app = new ClientApp()
    .onRequest("session/request_permission", () => {
      approvals++;
      return { outcome: { outcome: "selected", optionId: "once" } };
    })
    .onNotification("session/update", ({ params }) => updates.push(params));
  const connection = app.connect(agent.app);
  try {
    await connection.agent.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: {},
    });
    const session = await connection.agent.request("session/new", {
      cwd: workspace,
      mcpServers: [],
    });
    const result = await connection.agent.request("session/prompt", {
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: "list" }],
    });
    assert.equal(result.stopReason, "end_turn");
    assert.equal(requests.length, 3);
    const replay = requests[2].messages.filter((m) => m.tool_calls);
    assert.deepEqual(
      replay.map((m) => m.reasoning_content),
      ["private-0", "private-1"],
    );
    assert.deepEqual(
      requests[2].messages
        .filter((m) => m.role === "tool")
        .map((m) => m.tool_call_id),
      ["0-a", "0-b", "1-a", "1-b"],
    );
    const toolStarts = updates.filter(
      (u) =>
        u.update.sessionUpdate === "tool_call" &&
        ["0-a", "0-b", "1-a", "1-b"].includes(u.update.toolCallId),
    );
    assert.equal(toolStarts.length, 4);
    assert.equal(new Set(toolStarts.map((u) => u.update.toolCallId)).size, 4);
    assert.equal(JSON.stringify(updates).includes("private-"), false);
    assert.equal(
      approvals,
      1,
      "workspace activation only; inspection tools need no extra grant",
    );
    // A load displays public history only and never dispatches recorded calls.
    connection.close();
    await agent.close();
    const restored = createAgent();
    const restoredUpdates = [];
    const next = new ClientApp()
      .onRequest("session/request_permission", () => ({
        outcome: { outcome: "selected", optionId: "once" },
      }))
      .onNotification("session/update", ({ params }) =>
        restoredUpdates.push(params),
      )
      .connect(restored.app);
    try {
      await next.agent.request("initialize", { protocolVersion: 1 });
      await next.agent.request("session/load", {
        sessionId: session.sessionId,
        cwd: workspace,
        mcpServers: [],
      });
      assert.equal(requests.length, 3, "load does not call inference or tools");
      assert.equal(JSON.stringify(restoredUpdates).includes("private-"), false);
      // Loading emits historical tool notifications; only subsequent new
      // execution notifications count as dispatches.
      restoredUpdates.length = 0;
      await next.agent.request("session/prompt", {
        sessionId: session.sessionId,
        prompt: [{ type: "text", text: "continue" }],
      });
      assert.equal(requests.length, 4);
      assert.deepEqual(
        requests[3].messages
          .filter((m) => m.tool_calls)
          .map((m) => m.reasoning_content),
        ["private-0", "private-1"],
      );
      assert.equal(
        restoredUpdates.filter(
          (u) =>
            u.update.sessionUpdate === "tool_call" &&
            ["0-a", "0-b", "1-a", "1-b"].includes(u.update.toolCallId),
        ).length,
        0,
      );
    } finally {
      next.close();
      await restored.close();
    }
  } finally {
    connection.close();
    await agent.close();
  }
});
