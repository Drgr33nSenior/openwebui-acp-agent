import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { mkdtemp, realpath } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ClientApp } from "@agentclientprotocol/sdk";

const temporary = await realpath(
  await mkdtemp(join(tmpdir(), "ow-browser-mcp-")),
);
process.env.OPENWEBUI_ACP_HOME = join(temporary, "state");
process.env.OPENWEBUI_API_KEY = "synthetic-browser-inference";
// App modules capture the state directory at import time. Establish and check
// isolation before loading any module that can access configuration or stores.
const { writeJson, configSchema, directory } =
  await import("../dist/config.js");
assert.equal(directory, join(temporary, "state"));
const { Mcp, boundedMcpResponse, mcpOutput } = await import("../dist/mcp.js");
const { parseUserMcp, mcpOptions, mcpOptionsSchema } =
  await import("../dist/user-mcp.js");
const { SandboxMcpTransport } = await import("../dist/sandbox-mcp.js");
const { createAgent } = await import("../dist/agent.js");
const { grant } = await import("../dist/permissions.js");

const included = ["browser_snapshot", "browser_find", "browser_navigate"];
const excluded = [
  "browser_run_code_unsafe",
  "browser_evaluate",
  "browser_file_upload",
  "browser_install",
  "browser_take_screenshot",
  "browser_pdf_save",
  "browser_future_unsafe",
];
const tools = [...included, ...excluded].map((name) => ({
  name,
  description: `Fixture ${name}`,
  inputSchema: {
    type: "object",
    properties: {
      url: { type: "string" },
      mode: { type: "string" },
      filename: { type: "string" },
    },
    additionalProperties: false,
  },
}));

async function fixture(catalog = tools) {
  const requests = [];
  const sessions = new Set();
  let serial = 0;
  let responsive = true;
  const server = createServer(async (req, res) => {
    if (req.method === "DELETE") {
      requests.push({
        method: "DELETE",
        session: req.headers["mcp-session-id"],
      });
      sessions.delete(req.headers["mcp-session-id"]);
      res.writeHead(204).end();
      return;
    }
    if (req.method === "GET") {
      requests.push({ method: "GET" });
      res.writeHead(405).end();
      return;
    }
    let body = "";
    for await (const chunk of req) body += chunk;
    const rpc = JSON.parse(body);
    requests.push(rpc);
    const send = (result, headers = {}) =>
      res
        .writeHead(200, {
          "Content-Type": "application/json",
          ...headers,
        })
        .end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result }));
    if (!Object.hasOwn(rpc, "id")) {
      res.writeHead(202).end();
      return;
    }
    if (rpc.method === "initialize") {
      if (sessions.size >= 4) {
        res.writeHead(503).end();
        return;
      }
      const session = `fixture-owned-session-${++serial}`;
      sessions.add(session);
      send(
        {
          protocolVersion: rpc.params.protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: "browser-fixture", version: "1" },
        },
        { "mcp-session-id": session },
      );
      return;
    }
    if (rpc.method === "tools/list") {
      send({ tools: catalog });
      return;
    }
    if (rpc.method === "ping") {
      if (responsive) send({});
      return;
    }
    if (rpc.method === "tools/call") {
      const mode = rpc.params.arguments.mode;
      if (mode === "slow") return;
      if (mode === "overflow") {
        send({ content: [{ type: "text", text: "x".repeat(1100000) }] });
        return;
      }
      if (mode === "sse-overflow") {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.write("id: oversized\ndata: " + "x".repeat(1100000));
        res.end();
        return;
      }
      send({
        isError: mode === "error",
        content: [
          {
            type: "text",
            text:
              mode === "large" || mode === "error"
                ? "x".repeat(50000)
                : "fixture result",
          },
          {
            type: "image",
            mimeType: "image/png",
            data: Buffer.from("fixture image bytes").toString("base64"),
          },
        ],
      });
      return;
    }
    res.writeHead(400).end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}/mcp`;
  return {
    url,
    requests,
    sessions,
    responsive(value) {
      responsive = value;
    },
    definitions(options = {}) {
      return parseUserMcp([
        {
          type: "http",
          name: "browser",
          url,
          options: { includeTools: included, ...options },
        },
      ]);
    },
    async close() {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
const find = (m, name) =>
  [...m.tools.values()].find((tool) => tool.label.endsWith("/" + name));
async function connect(f, options) {
  const m = new Mcp();
  await m.connect(
    f.definitions(options),
    temporary,
    async () => {},
    AbortSignal.timeout(20000),
  );
  return m;
}

test("explicit allowlist excludes dangerous and future tools, prevents filename writes, and enters grant identity", async () => {
  const f = await fixture();
  const m = await connect(f);
  try {
    assert.deepEqual(
      [...m.tools.values()].map((tool) => tool.label),
      included.map((name) => "browser/" + name),
    );
    for (const name of excluded) assert.equal(find(m, name), undefined);
    const snapshot = find(m, "browser_snapshot");
    assert.equal(
      snapshot.definition.function.parameters.properties.filename,
      undefined,
    );
    assert.equal(snapshot.validate({ filename: "unwanted.txt" }), false);
    const before = f.requests.length;
    await assert.rejects(
      snapshot.call({ filename: "unwanted.txt" }, AbortSignal.timeout(1000)),
      /schema/,
    );
    assert.equal(f.requests.length, before);
    assert.deepEqual(snapshot.identity.options.includeTools, included);
    assert.equal(find(m, "browser_navigate").forceOnce, true);
    assert.equal(snapshot.forceOnce, false);
    assert.equal(snapshot.unsandboxed, true);
  } finally {
    await m.close();
    await f.close();
  }
});

test("MCP draft 2020-12 validates its own keywords without weakening file-output checks", async () => {
  for (const dialect of [
    "https://json-schema.org/draft/2020-12/schema",
    "https://json-schema.org/draft/2020-12/schema#",
  ]) {
    const catalog = [
      {
        name: "browser_snapshot",
        inputSchema: {
          $schema: dialect,
          type: "object",
          properties: {
            selection: {
              type: "array",
              prefixItems: [{ type: "integer" }],
              items: false,
            },
            filename: { type: "string" },
          },
          required: ["selection"],
          unevaluatedProperties: false,
        },
      },
    ];
    const f = await fixture(catalog);
    const m = await connect(f);
    try {
      const snapshot = find(m, "browser_snapshot");
      assert.equal(snapshot.validate({ selection: [1] }), true);
      for (const args of [
        { selection: ["1"] },
        { selection: [1, 2] },
        { selection: [1], extra: true },
        { selection: [1], filename: "unwanted.txt" },
      ]) {
        assert.equal(snapshot.validate(args), false);
        const before = f.requests.length;
        await assert.rejects(
          snapshot.call(args, AbortSignal.timeout(1000)),
          /schema/,
        );
        assert.equal(f.requests.length, before);
      }
      assert.equal(snapshot.definition.function.parameters.$schema, dialect);
    } finally {
      await m.close();
      await f.close();
    }
  }
});

test("unknown MCP schema dialect fails closed", async () => {
  const f = await fixture([
    {
      name: "browser_snapshot",
      inputSchema: {
        $schema: "https://example.org/unknown-schema",
        type: "object",
      },
    },
  ]);
  try {
    await assert.rejects(connect(f), /tool catalog or schema validation/);
    assert.equal(
      f.requests.some((r) => r.method === "tools/call"),
      false,
    );
  } finally {
    await f.close();
  }
});

test("app options cannot be smuggled through an ACP-supplied server with the same name", async () => {
  const f = await fixture();
  const m = new Mcp();
  try {
    const source = f.definitions()[0];
    const clone = { ...source, options: { includeTools: [] } };
    assert.equal(mcpOptions(clone), undefined);
    await m.connect(
      [clone],
      temporary,
      async () => {},
      AbortSignal.timeout(10000),
    );
    assert.equal(m.tools.size, tools.length);
    assert.equal(find(m, "browser_navigate").forceOnce, false);
    assert.equal(find(m, "browser_navigate").unsandboxed, true);
  } finally {
    await m.close();
    await f.close();
  }
});

test("configured output strips image parts and truncates with a bounded marker while retaining error status", async () => {
  const f = await fixture();
  const m = await connect(f, { maxOutputChars: 1000 });
  try {
    const snapshot = find(m, "browser_snapshot");
    const short = await snapshot.call({}, AbortSignal.timeout(3000));
    assert.doesNotMatch(short, /Zml4dHVyZSBpbWFnZSBieXRlcw==|image\/png/);
    assert.equal(JSON.parse(short).content.length, 1);
    const large = await snapshot.call(
      { mode: "large" },
      AbortSignal.timeout(3000),
    );
    assert.equal(large.length, 1000);
    assert.match(large, /…truncated; use browser_find to locate elements$/);
    const error = await snapshot.call(
      { mode: "error" },
      AbortSignal.timeout(3000),
    );
    assert.equal(error.length, 1000);
    assert.match(error, /^MCP tool returned an error/);
    const nested = mcpOutput(
      {
        content: [
          {
            type: "resource",
            resource: { mimeType: "image/png", blob: "nested-image" },
          },
        ],
        structuredContent: { nested: [{ type: "image", data: "nested-data" }] },
      },
      mcpOptions(f.definitions()[0]),
    );
    assert.doesNotMatch(nested, /nested-image|nested-data/);
  } finally {
    await m.close();
    await f.close();
  }
});

test("configured HTTP timeout preserves responsive connection and never repeats the action", async () => {
  const f = await fixture();
  const m = await connect(f, { callTimeoutMs: 100 });
  try {
    const snapshot = find(m, "browser_snapshot");
    await assert.rejects(
      snapshot.call({ mode: "slow" }, AbortSignal.timeout(5000)),
      /connection retained.*No automatic retry/,
    );
    assert.equal(
      f.requests.filter((request) => request.method === "tools/call").length,
      1,
    );
    assert.equal(
      f.requests.filter((request) => request.method === "ping").length,
      1,
    );
    assert.ok(
      f.requests.some(
        (request) => request.method === "notifications/cancelled",
      ),
    );
    assert.match(
      await snapshot.call({}, AbortSignal.timeout(3000)),
      /fixture result/,
    );
    assert.equal(
      f.requests.filter((request) => request.method === "initialize").length,
      1,
    );
    assert.equal(
      f.requests.filter((request) => request.method === "DELETE").length,
      0,
    );
    await m.close();
    assert.deepEqual(
      f.requests.filter((request) => request.method === "DELETE"),
      [{ method: "DELETE", session: "fixture-owned-session-1" }],
    );
  } finally {
    await m.close();
    await f.close();
  }
});

test("an unresponsive timeout closes the connection and cancellation cannot retain it", async () => {
  for (const cancel of [false, true]) {
    const f = await fixture();
    const m = await connect(f, { callTimeoutMs: 100 });
    f.responsive(false);
    try {
      const snapshot = find(m, "browser_snapshot");
      const controller = new AbortController();
      const call = snapshot.call({ mode: "slow" }, controller.signal);
      if (cancel) setTimeout(() => controller.abort(), 20);
      await assert.rejects(call, /connection closed/);
      const before = f.requests.length;
      await assert.rejects(
        snapshot.call({}, AbortSignal.timeout(1000)),
        /connection closed/,
      );
      assert.equal(f.requests.length, before);
    } finally {
      await m.close();
      await f.close();
    }
  }
});

test("owned HTTP sessions are released across six turns, including cancelled turns", async () => {
  const f = await fixture();
  try {
    for (let turn = 0; turn < 6; turn++) {
      const m = new Mcp();
      const controller = new AbortController();
      try {
        await m.connect(
          f.definitions(),
          temporary,
          async () => {},
          controller.signal,
        );
        assert.equal(f.sessions.size, 1);
        if (turn % 2) controller.abort();
      } finally {
        await m.close();
      }
      assert.equal(f.sessions.size, 0);
    }
    assert.equal(
      f.requests.filter((request) => request.method === "DELETE").length,
      6,
    );
  } finally {
    await f.close();
  }
});

test("JSON and SSE overflow fail terminally before parsing and never reconnect", async () => {
  for (const mode of ["overflow", "sse-overflow"]) {
    const f = await fixture();
    const m = await connect(f);
    try {
      const before = f.requests.filter(
        (request) => request.method === "GET",
      ).length;
      await assert.rejects(
        find(m, "browser_snapshot").call({ mode }, AbortSignal.timeout(5000)),
        /connection closed/,
      );
      await delay(30);
      assert.equal(
        f.requests.filter((request) => request.method === "GET").length,
        before,
      );
      assert.equal(
        f.requests.filter((request) => request.method === "tools/call").length,
        1,
      );
    } finally {
      await m.close();
      await f.close();
    }
  }
});

test("raw HTTP bounds apply per SSE event and bound JSON before SDK parsing", async () => {
  let failures = 0;
  const fail = () => failures++;
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(
        new TextEncoder().encode("data: 123456\n\n".repeat(100)),
      );
      controller.close();
    },
  });
  assert.equal(
    (
      await boundedMcpResponse(
        new Response(stream, {
          headers: { "content-type": "text/event-stream" },
        }),
        20,
        fail,
      ).text()
    ).length,
    1400,
  );
  assert.equal(failures, 0);
  await assert.rejects(
    boundedMcpResponse(
      new Response("x".repeat(21), {
        headers: { "content-type": "application/json" },
      }),
      20,
      fail,
    ).json(),
    /frame/,
  );
  assert.equal(failures, 1);
});

test("strict option bounds fail closed and existing definitions keep their shape", () => {
  const base = {
    type: "http",
    name: "browser",
    url: "http://127.0.0.1:1234/mcp",
  };
  for (const options of [
    {},
    { includeTools: included, surprise: true },
    { includeTools: ["*"] },
    { includeTools: ["browser_find", "browser_find"] },
    { includeTools: included, callTimeoutMs: 99 },
    { includeTools: included, callTimeoutMs: 600001 },
    { includeTools: included, maxFrameBytes: 8000001 },
    { includeTools: included, maxOutputChars: 255 },
    { includeTools: included, stripImages: "true" },
  ])
    assert.throws(() => parseUserMcp([{ ...base, options }]));
  assert.throws(() => parseUserMcp([{ ...base, unknown: true }]));
  const old = parseUserMcp([base])[0];
  assert.deepEqual(old, {
    type: "http",
    name: "browser",
    url: base.url,
    headers: [],
  });
  assert.equal(mcpOptions(old), undefined);
  assert.equal(
    mcpOptionsSchema.parse({ includeTools: included }).callTimeoutMs,
    60000,
  );
});

test("configured stdio frames remain bounded and a failed stream cannot resume", async () => {
  const transport = new SandboxMcpTransport(
    "unused",
    [],
    { root: temporary, mode: "workspace", network: async () => false },
    new AbortController().signal,
    1000000,
  );
  let stopped = 0;
  transport.process = {
    stop() {
      stopped++;
    },
    child: {
      stdin: {
        write(_line, done) {
          done();
        },
      },
    },
  };
  const messages = [],
    errors = [];
  transport.onmessage = (message) => messages.push(message);
  transport.onerror = (error) => errors.push(error.message);
  const message = {
    jsonrpc: "2.0",
    id: 1,
    result: { text: "x".repeat(300000) },
  };
  transport.receive(Buffer.from(JSON.stringify(message) + "\n"));
  assert.equal(messages.length, 1);
  transport.receive(Buffer.alloc(1000001, "x"));
  transport.receive(Buffer.from('{"jsonrpc":"2.0","id":2,"result":{}}\n'));
  assert.equal(messages.length, 1);
  assert.equal(stopped, 1);
  assert.deepEqual(errors, ["MCP frame invalid or oversized"]);
  await assert.rejects(
    transport.send({ jsonrpc: "2.0", id: 2, method: "ping" }),
    /failed/,
  );
  assert.throws(
    () =>
      new SandboxMcpTransport(
        "unused",
        [],
        {},
        new AbortController().signal,
        8000001,
      ),
    /frame limit/,
  );
});

test("loopback container calls require approval every time even with no always-approve names or saved scopes", async () => {
  const f = await fixture();
  const workspace = await realpath(
    await mkdtemp(join(temporary, "workspace-")),
  );
  let round = 0;
  const backend = createServer(async (req, res) => {
    if (req.url === "/api/models") {
      res.end(JSON.stringify({ data: [{ id: "fixture" }] }));
      return;
    }
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    if (round === 0) {
      const state = [...agent.sessions.values()][0];
      const remote = find(state.mcp, "browser_navigate");
      const permission = grant(
        "mcp-tool",
        remote.identity,
        "synthetic remembered browser grant",
      );
      const scope = await state.permissions.prepare();
      await state.permissions.remember(
        permission,
        "remember",
        scope.epoch,
        new AbortController().signal,
      );
      await state.permissions.remember(
        permission,
        "session",
        scope.epoch,
        new AbortController().signal,
      );
    }
    const name = body.tools.find((tool) =>
      tool.function.description.includes("browser/browser_navigate"),
    ).function.name;
    const message =
      round++ < 2
        ? {
            role: "assistant",
            tool_calls: [
              {
                id: `navigate-${round}`,
                type: "function",
                function: {
                  name,
                  arguments: '{"url":"https://example.test/path?q=fixture"}',
                },
              },
            ],
          }
        : { role: "assistant", content: "Done" };
    res.end(
      JSON.stringify({
        choices: [
          {
            message,
            finish_reason: message.tool_calls ? "tool_calls" : "stop",
          },
        ],
      }),
    );
  });
  await new Promise((resolve) => backend.listen(0, "127.0.0.1", resolve));
  await writeJson(
    "config.json",
    configSchema.parse({
      url: `http://127.0.0.1:${backend.address().port}`,
      model: "fixture",
    }),
  );
  await writeJson("mcp.json", [
    {
      type: "http",
      name: "browser",
      url: f.url,
      options: { includeTools: included, alwaysApproveTools: [] },
    },
  ]);
  const agent = createAgent();
  const app = new ClientApp();
  const calls = [];
  app.onNotification("session/update", () => {});
  app.onRequest("session/request_permission", ({ params }) => {
    if (params.toolCall.title.startsWith("Call browser/")) {
      calls.push(params);
      assert.equal(
        f.requests.filter((request) => request.method === "tools/call").length,
        calls.length - 1,
      );
      assert.deepEqual(
        params.options
          .filter((option) => option.optionId !== "deny")
          .map((option) => option.optionId),
        ["once"],
      );
      assert.match(
        params.toolCall.title,
        /https:\/\/example\.test\/path\?q=fixture/,
      );
    }
    return { outcome: { outcome: "selected", optionId: "once" } };
  });
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
    assert.equal(
      (
        await connection.agent.request("session/prompt", {
          sessionId: session.sessionId,
          prompt: [{ type: "text", text: "Inspect the fixture" }],
        })
      ).stopReason,
      "end_turn",
    );
    assert.equal(calls.length, 2);
    assert.equal(
      f.requests.filter((request) => request.method === "tools/call").length,
      2,
    );
  } finally {
    connection.close();
    await agent.close();
    await f.close();
    backend.closeAllConnections();
    await new Promise((resolve) => backend.close(resolve));
    await writeJson("mcp.json", []);
  }
});
