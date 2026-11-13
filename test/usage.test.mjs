import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClientApp } from "@agentclientprotocol/sdk";

const temporary = await mkdtemp(join(tmpdir(), "ow-usage-"));
process.env.OPENWEBUI_ACP_HOME = join(temporary, "state");
process.env.OPENWEBUI_API_KEY = "synthetic-usage-key";
const { Backend } = await import("../dist/backend.js");
const { configSchema, writeJson } = await import("../dist/config.js");
const { contextSize, completionContextTokens } =
  await import("../dist/usage.js");
const { createAgent } = await import("../dist/agent.js");
const { root, changeTrust } = await import("../dist/workspace.js");
const workspace = join(temporary, "project");
await mkdir(workspace);
let models = [
  { id: "a", context_window: 1000, max_input_tokens: 700 },
  { id: "b", max_input_tokens: 2000 },
  { id: "unknown" },
];
let response;
const requests = [];
const http = createServer(async (req, res) => {
  if (req.url === "/api/models") {
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ data: models }));
    return;
  }
  let raw = "";
  for await (const chunk of req) raw += chunk;
  requests.push(JSON.parse(raw));
  await response(req, res);
});
await new Promise((resolve) => http.listen(0, "127.0.0.1", resolve));
const conf = configSchema.parse({
  url: `http://127.0.0.1:${http.address().port}`,
  model: "a",
});
await writeJson("config.json", conf);
await changeTrust(await root(workspace), conf.url, true);
test.after(() => new Promise((resolve) => http.close(resolve)));
const completed = (usage, extra = {}) => ({
  choices: [
    { message: { role: "assistant", content: "ok" }, finish_reason: "stop" },
  ],
  usage,
  ...extra,
});
function json(res, body) {
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}
async function client() {
  const agent = createAgent(),
    updates = [];
  const app = new ClientApp()
    .onRequest("session/request_permission", () => ({
      outcome: { outcome: "selected", optionId: "once" },
    }))
    .onNotification("session/update", ({ params }) => updates.push(params));
  const connection = app.connect(agent.app);
  await connection.agent.request("initialize", { protocolVersion: 1 });
  return {
    agent,
    updates,
    request: (method, params) => connection.agent.request(method, params),
    close: async () => {
      connection.close();
      await agent.close();
    },
  };
}
const newSession = (c) =>
  c.request("session/new", { cwd: workspace, mcpServers: [] });
const prompt = (c, id) =>
  c.request("session/prompt", {
    sessionId: id,
    prompt: [{ type: "text", text: "inspect files" }],
  });
const usageUpdates = (c) =>
  c.updates.filter((u) => u.update.sessionUpdate === "usage_update");

test("context counts use validated per-call usage, never billing totals or guessed capacity", () => {
  assert.equal(
    contextSize({
      context_window: 2048,
      max_input_tokens: 1200,
      max_output_tokens: 512,
    }),
    2048,
  );
  assert.equal(
    contextSize({ max_input_tokens: 1200, openai: { context_window: 2048 } }),
    2048,
  );
  assert.equal(
    contextSize({ context_window: -1, max_input_tokens: 1200 }),
    undefined,
  );
  assert.equal(
    contextSize({ max_input_tokens: 100, max_output_tokens: 50 }),
    100,
  );
  assert.equal(contextSize({ openai: { max_input_tokens: 200 } }), 200);
  for (const n of [0, -1, 1.5, "200", Infinity, Number.MAX_SAFE_INTEGER + 1])
    assert.equal(contextSize({ max_input_tokens: n }), undefined);
  assert.equal(contextSize({ max_output_tokens: 200 }), undefined);
  assert.equal(
    completionContextTokens({
      prompt_tokens: 100,
      completion_tokens: 25,
      total_tokens: 9000,
      input_tokens: 8000,
      cost: 20,
    }),
    125,
  );
  assert.equal(
    completionContextTokens({ prompt_eval_count: 20, eval_count: 3 }),
    23,
  );
  assert.equal(completionContextTokens({ prompt_tokens: 0 }), 0);
  for (const u of [
    null,
    {},
    { total_tokens: 42 },
    { input_tokens: 200, output_tokens: 50 },
    { prompt_tokens: -1 },
    { prompt_tokens: "200" },
    { prompt_tokens: 2, completion_tokens: -1 },
    { prompt_tokens: Number.MAX_SAFE_INTEGER, completion_tokens: 1 },
  ])
    assert.equal(completionContextTokens(u), undefined);
});

test("fragmented SSE collects final usage-only events without double counting", async () => {
  response = async (_, res) => {
    res.setHeader("Content-Type", "text/event-stream");
    const events = [
      {
        choices: [{ delta: { content: "hé🙂" }, finish_reason: null }],
        usage: { prompt_tokens: 10 },
      },
      { choices: [{ delta: {}, finish_reason: "stop" }] },
      { choices: [], usage: { prompt_tokens: 100, completion_tokens: 7 } },
      { choices: [], usage: { prompt_tokens: 100, completion_tokens: 7 } },
    ];
    const bytes = Buffer.from(
      events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("") +
        "data: [DONE]\n\n",
    );
    for (const byte of bytes) res.write(Buffer.from([byte]));
    res.end();
  };
  const usage = [];
  const result = await new Backend(conf, "synthetic").complete(
    [],
    [],
    AbortSignal.timeout(5000),
    async () => {},
    {},
    undefined,
    async (u) => {
      usage.push(u);
    },
  );
  assert.equal(result.content, "hé🙂");
  assert.deepEqual(usage, [107]);
  assert.deepEqual(requests.at(-1).stream_options, { include_usage: true });
  assert.equal(
    result.usage,
    undefined,
    "usage must not become inference history",
  );
});

test("non-streaming usage is optional; malformed counts do not break replies; length errors still report measured usage", async () => {
  for (const [u, expected] of [
    [{ prompt_tokens: 12, completion_tokens: 4 }, [16]],
    [undefined, []],
    [{ prompt_tokens: "bad" }, []],
  ]) {
    response = async (_, res) => json(res, completed(u));
    const actual = [];
    await new Backend(conf, "synthetic").complete(
      [],
      [],
      AbortSignal.timeout(5000),
      async () => {},
      {},
      undefined,
      async (v) => {
        actual.push(v);
      },
    );
    assert.deepEqual(actual, expected);
  }
  response = async (_, res) =>
    json(
      res,
      completed(
        { prompt_tokens: 900, completion_tokens: 100 },
        {
          choices: [
            {
              message: { role: "assistant", content: "partial" },
              finish_reason: "length",
            },
          ],
        },
      ),
    );
  const actual = [];
  await assert.rejects(
    new Backend(conf, "synthetic").complete(
      [],
      [],
      AbortSignal.timeout(5000),
      async () => {},
      {},
      undefined,
      async (v) => {
        actual.push(v);
      },
    ),
    /limit reached/,
  );
  assert.deepEqual(actual, [1000]);
});

test("cancelled streams do not publish late usage", async () => {
  const controller = new AbortController();
  response = async (_, res) => {
    res.setHeader("Content-Type", "text/event-stream");
    res.write(
      `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 100 } })}\n\n`,
    );
    controller.abort();
    res.end();
  };
  const usage = [];
  await assert.rejects(
    new Backend(conf, "synthetic").complete(
      [],
      [],
      controller.signal,
      async () => {},
      {},
      undefined,
      async (u) => {
        usage.push(u);
      },
    ),
  );
  assert.deepEqual(usage, []);
});

test("ACP emits each round's usage, isolates sessions, restores snapshots and clears them on model changes", async () => {
  const c = await client();
  let id;
  try {
    id = (await newSession(c)).sessionId;
    const other = (await newSession(c)).sessionId;
    assert.deepEqual(usageUpdates(c), [], "no invented zero before inference");
    let round = 0;
    response = async (_, res) => {
      round++;
      json(
        res,
        round === 1
          ? {
              choices: [
                {
                  message: {
                    role: "assistant",
                    content: null,
                    tool_calls: [
                      {
                        id: "read-1",
                        type: "function",
                        function: { name: "list_files", arguments: "{}" },
                      },
                    ],
                  },
                  finish_reason: "tool_calls",
                },
              ],
              usage: {
                prompt_tokens: 100,
                completion_tokens: 20,
                total_tokens: 9000,
              },
            }
          : completed({
              prompt_tokens: 180,
              completion_tokens: 5,
              total_tokens: 18000,
            }),
      );
    };
    await prompt(c, id);
    assert.deepEqual(
      usageUpdates(c).map((u) => [u.sessionId, u.update.used, u.update.size]),
      [
        [id, 120, 1000],
        [id, 185, 1000],
      ],
    );
    assert.equal(c.agent.sessions.get(other).contextUsage, undefined);
    const saved = JSON.parse(
      await readFile(join(temporary, "state", `session-${id}.json`), "utf8"),
    );
    assert.deepEqual(saved.contextUsage, { used: 185, size: 1000 });
    assert(saved.messages.every((m) => !("usage" in m)));
  } finally {
    await c.close();
  }
  const restored = await client();
  try {
    const before = requests.length;
    await restored.request("session/load", {
      sessionId: id,
      cwd: workspace,
      mcpServers: [],
    });
    assert.equal(
      requests.length,
      before,
      "restoring usage does not replay inference or tools",
    );
    assert.deepEqual(
      usageUpdates(restored).map((u) => u.update),
      [{ sessionUpdate: "usage_update", used: 185, size: 1000 }],
    );
    await restored.request("session/set_config_option", {
      sessionId: id,
      configId: "model",
      value: "b",
    });
    assert.equal(restored.agent.sessions.get(id).contextUsage, undefined);
    response = async (_, res) =>
      json(res, completed({ prompt_tokens: 75, completion_tokens: 5 }));
    await prompt(restored, id);
    assert.deepEqual(usageUpdates(restored).at(-1).update, {
      sessionUpdate: "usage_update",
      used: 80,
      size: 2000,
    });
    await restored.request("session/set_config_option", {
      sessionId: id,
      configId: "model",
      value: "unknown",
    });
    const n = usageUpdates(restored).length;
    await prompt(restored, id);
    assert.equal(
      usageUpdates(restored).length,
      n,
      "unknown capacity must not invent a wheel",
    );
  } finally {
    await restored.close();
  }
});

test("restoration rejects a stale capacity and accepts old transcripts without usage", async () => {
  const c = await client();
  let id;
  try {
    id = (await newSession(c)).sessionId;
    response = async (_, res) => json(res, completed({ prompt_tokens: 50 }));
    await prompt(c, id);
  } finally {
    await c.close();
  }
  const oldModels = models;
  models = [{ id: "a", max_input_tokens: 4000 }];
  const restored = await client();
  try {
    await restored.request("session/load", {
      sessionId: id,
      cwd: workspace,
      mcpServers: [],
    });
    assert.deepEqual(usageUpdates(restored), []);
    const legacy = (await newSession(restored)).sessionId;
    const value = JSON.parse(
      await readFile(
        join(temporary, "state", `session-${legacy}.json`),
        "utf8",
      ),
    );
    assert.equal(value.contextUsage, undefined);
    const second = await client();
    try {
      await second.request("session/load", {
        sessionId: legacy,
        cwd: workspace,
        mcpServers: [],
      });
      assert.deepEqual(usageUpdates(second), []);
    } finally {
      await second.close();
    }
  } finally {
    models = oldModels;
    await restored.close();
  }
});
