import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { ClientApp } from "@agentclientprotocol/sdk";
const temporary = await mkdtemp(join(tmpdir(), "ow-server-task-"));
process.env.OPENWEBUI_ACP_HOME = join(temporary, "state");
process.env.OPENWEBUI_API_KEY = "synthetic-api-only";
const { Backend } = await import("../dist/backend.js");
const { configSchema, writeJson } = await import("../dist/config.js");
const { createAgent } = await import("../dist/agent.js");
const { snapshotPolicy } = await import("../dist/policy.js");
const { serverCatalog, validateServerTask, runServerTask, serverTaskGrant } =
  await import("../dist/server-tools.js");
const model = {
  id: "fixture",
  info: {
    meta: {
      capabilities: { web_search: true, image_generation: true, memory: true },
    },
  },
};
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j1ioAAAAASUVORK5CYII=",
  "base64",
);

async function fixture(settings = {}) {
  let chatId = randomUUID();
  const imageId = randomUUID();
  let saved,
    rounds = 0,
    polls = 0;
  const requests = [];
  const http = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : undefined;
    requests.push({
      method: req.method,
      path: req.url,
      body,
      headers: req.headers,
    });
    res.setHeader("Content-Type", "application/json");
    const send = (data) => res.end(JSON.stringify(data));
    const route = req.url.replace(/^\/prefix\//, "");
    if (settings.deny === route) {
      res.writeHead(403);
      return send({ detail: "synthetic-api-only" });
    }
    if (route === "api/version")
      return send({ version: settings.version ?? "0.13.3" });
    if (route === "api/config")
      return send({
        features: settings.publicConfig
          ? {}
          : {
              enable_web_search: true,
              enable_image_generation: true,
              enable_memories: true,
            },
      });
    if (route === "api/models") return send({ data: [model, { id: "other" }] });
    if (route === "api/v1/tools/")
      return send([
        {
          id: "server:mcp:fixture",
          name: "Research and memory",
          meta: { description: "untrusted description" },
        },
        { id: "locked", name: "Needs server login", authenticated: false },
      ]);
    if (route === "api/v1/chats/new") {
      chatId = randomUUID();
      polls = 0;
      saved = body.chat;
      return send({ id: chatId });
    }
    if (route === "api/chat/completions") {
      if (body.chat_id) {
        if (settings.malformedAck) return send({ choices: [] });
        if (settings.startFailure) {
          res.writeHead(502);
          return send({ error: "private body" });
        }
        return send({
          status: true,
          chat_id: chatId,
          task_ids: ["task-fixture"],
        });
      }
      const message =
        (settings.repeatTasks
          ? body.messages.at(-1)?.role === "user"
          : rounds++ === 0) &&
        body.tools.some((t) => t.function.name === "openwebui_task")
          ? {
              role: "assistant",
              tool_calls: [
                {
                  id: "local-call",
                  type: "function",
                  function: {
                    name: "openwebui_task",
                    arguments: JSON.stringify(
                      settings.task ?? {
                        prompt:
                          "Search a public reference and draw a small icon",
                        features: ["web_search", "image_generation"],
                        toolIds: ["server:mcp:fixture"],
                      },
                    ),
                  },
                },
              ],
            }
          : { role: "assistant", content: "Finished" };
      return send({
        choices: [
          {
            message,
            finish_reason: message.tool_calls ? "tool_calls" : "stop",
          },
        ],
      });
    }
    if (route === `api/tasks/chat/${chatId}`) {
      polls++;
      if (settings.onPoll) settings.onPoll();
      return send(
        settings.malformedPoll
          ? {}
          : {
              task_ids: settings.running || polls === 1 ? ["task-fixture"] : [],
            },
      );
    }
    if (route === `api/tasks/chat/${chatId}/stop`)
      return send({ status: true });
    if (route === `api/v1/chats/${chatId}`) {
      const id = saved.history.currentId;
      return send({
        chat: {
          history: {
            messages: {
              [id]: {
                role: "assistant",
                done: !settings.pending,
                output: [
                  {
                    type: "message",
                    content: [{ type: "output_text", text: "Research answer" }],
                  },
                  ...(!settings.noEvidence
                    ? [
                        {
                          type: "function_call",
                          name: "search_web",
                          status: settings.pending ? "pending" : "completed",
                        },
                      ]
                    : []),
                ],
                sources: [
                  {
                    source: { name: "Reference" },
                    metadata: [
                      { source: "https://example.org/reference" },
                      { source: "file:///not-a-citation" },
                    ],
                  },
                ],
                files: settings.noImages
                  ? []
                  : [
                      {
                        type: "image",
                        id: imageId,
                        url: "https://untrusted.invalid/never-fetch",
                      },
                    ],
              },
            },
          },
        },
      });
    }
    if (route === `api/v1/files/${imageId}/content`) {
      if (settings.redirectImage) {
        res.writeHead(302, {
          Location: "https://untrusted.invalid/never-fetch",
        });
        return res.end();
      }
      res.setHeader("Content-Type", "image/png");
      return res.end(
        settings.badImage
          ? Buffer.from("not an image")
          : settings.hugeImage
            ? Buffer.alloc(2_000_001)
            : png,
      );
    }
    res.writeHead(404);
    send({ detail: "Unknown fixture endpoint" });
  });
  await new Promise((r) => http.listen(0, "127.0.0.1", r));
  const config = configSchema.parse({
    url: `http://127.0.0.1:${http.address().port}/prefix`,
    model: "fixture",
    timeoutMs: 5000,
  });
  return {
    config,
    get chatId() {
      return chatId;
    },
    requests,
    backend: new Backend(config, "synthetic-api-only"),
    async close() {
      http.closeAllConnections();
      await new Promise((r) => http.close(r));
    },
  };
}
const task = {
  prompt: "Search and draw",
  features: ["web_search", "image_generation"],
  toolIds: ["server:mcp:fixture"],
};

test("server discovery is version-gated, uses published capabilities and validates tool IDs", async () => {
  const f = await fixture();
  try {
    const catalog = await serverCatalog(
      f.backend,
      model,
      AbortSignal.timeout(3000),
    );
    assert.deepEqual(catalog.features, [
      "web_search",
      "image_generation",
      "memory",
    ]);
    assert.deepEqual(validateServerTask(task, catalog), task);
    for (const value of [
      { ...task, toolIds: ["invented"] },
      { ...task, toolIds: ["locked"] },
      { ...task, features: ["code_interpreter"] },
      { ...task, terminal_id: "anything" },
    ])
      assert.throws(() => validateServerTask(value, catalog));
    const disabled = await serverCatalog(
      f.backend,
      { info: { meta: { capabilities: { builtin_tools: false } } } },
      AbortSignal.timeout(3000),
    );
    assert.deepEqual(disabled.features, []);
    assert(f.requests.every((r) => r.method === "GET"));
  } finally {
    await f.close();
  }
  const other = await fixture({ version: "0.99.0" });
  try {
    await assert.rejects(
      serverCatalog(other.backend, model, AbortSignal.timeout(3000)),
      /not verified/,
    );
    assert.equal(other.requests.length, 1);
  } finally {
    await other.close();
  }
  const denied = await fixture({ deny: "api/v1/tools/" });
  try {
    await assert.rejects(
      serverCatalog(denied.backend, model, AbortSignal.timeout(3000)),
      (error) => {
        assert.match(error.message, /GET \/api\/v1\/tools\/ returned HTTP 403/);
        assert(!error.message.includes("synthetic-api-only"));
        return true;
      },
    );
  } finally {
    await denied.close();
  }
  const publicConfig = await fixture({ publicConfig: true });
  try {
    const advertised = await serverCatalog(
      publicConfig.backend,
      model,
      AbortSignal.timeout(3000),
    );
    assert.deepEqual(advertised.features, [
      "web_search",
      "image_generation",
      "memory",
    ]);
    assert.deepEqual(advertised.unverifiedFeatures, advertised.features);
    const unknown = await serverCatalog(
      publicConfig.backend,
      { id: "no-metadata" },
      AbortSignal.timeout(3000),
    );
    assert.deepEqual(unknown.features, []);
  } finally {
    await publicConfig.close();
  }
});

test("native server task contract keeps caller tools separate and returns citations plus bounded authenticated images", async () => {
  const f = await fixture();
  const records = [],
    progress = [];
  try {
    const result = await runServerTask(
      f.backend,
      task,
      AbortSignal.timeout(3000),
      async (r) => records.push({ ...r }),
      async (s) => progress.push(s),
      {
        reasoning_effort: "low",
        params: { model_controls: { fixture: { thinking: "deep" } } },
      },
      1,
    );
    assert.equal(result.failed, false);
    const value = JSON.parse(result.text);
    assert.equal(value.content, "Research answer");
    assert.deepEqual(value.sources, ["https://example.org/reference"]);
    assert(value.images[0].startsWith(f.config.url + "/api/v1/files/"));
    assert.equal(
      result.content.find((c) => c.content.type === "image").content.data,
      png.toString("base64"),
    );
    assert.deepEqual(
      records.map((r) => r.state),
      ["created", "running", "completed"],
    );
    assert.match(progress[0], /retained Open WebUI chat/);
    const completion = f.requests.find((r) => r.body?.chat_id).body;
    assert.equal(completion.reasoning_effort, "low");
    assert.equal(completion.tools, undefined);
    assert.equal(completion.terminal_id, undefined);
    assert.equal(completion.params.function_calling, "native");
    assert.deepEqual(completion.params.model_controls, {
      fixture: { thinking: "deep" },
    });
    assert.equal(completion.features.code_interpreter, false);
    assert.equal(completion.features.memory, false);
    assert.deepEqual(completion.tool_ids, task.toolIds);
    assert.equal(completion.chat_id, f.chatId);
    assert(f.requests.every((r) => r.method !== "DELETE"));
    assert(
      f.requests.every(
        (r) => r.headers.authorization === "Bearer synthetic-api-only",
      ),
    );
    assert(!result.text.includes("synthetic-api-only"));
  } finally {
    await f.close();
  }
});

test("cancellation and malformed acknowledgements stop only the created chat, without retries or admin task APIs", async () => {
  for (const mode of [
    "cancel",
    "malformedAck",
    "malformedPoll",
    "startFailure",
  ]) {
    const controller = new AbortController();
    const f = await fixture({
      [mode]: true,
      running: mode === "cancel",
      onPoll: mode === "cancel" ? () => controller.abort() : undefined,
    });
    const records = [];
    try {
      const result = await runServerTask(
        f.backend,
        task,
        controller.signal,
        async (r) => records.push({ ...r }),
        async () => {},
        {},
        1,
      );
      assert.equal(result.failed, true);
      assert.match(result.text, /No automatic retry/);
      assert.equal(records.at(-1).state, "unknown");
      assert.equal(
        f.requests.filter((r) => r.path.endsWith("/api/chat/completions"))
          .length,
        1,
      );
      assert.equal(
        f.requests.filter((r) =>
          r.path.endsWith(`/api/tasks/chat/${f.chatId}/stop`),
        ).length,
        1,
      );
      assert(!f.requests.some((r) => r.path.includes("/api/tasks/stop/")));
    } finally {
      await f.close();
    }
  }
});

test("server-side interaction pauses and missing tool evidence are reported, not treated as proved success", async () => {
  for (const mode of ["pending", "noEvidence"]) {
    const f = await fixture({ [mode]: true, noImages: true });
    try {
      const result = await runServerTask(
        f.backend,
        task,
        AbortSignal.timeout(3000),
        async () => {},
        async () => {},
        {},
        1,
      );
      const value = JSON.parse(result.text);
      assert(value.warnings.some((s) => s.includes("no generated image")));
      if (mode === "pending") {
        assert.equal(result.failed, true);
        assert.equal(value.state, "attention");
      } else assert(value.warnings.some((s) => s.includes("does not prove")));
    } finally {
      await f.close();
    }
  }
});

test("invalid, oversized and redirected image previews retain safe file links without fetching arbitrary URLs", async () => {
  for (const mode of ["badImage", "hugeImage", "redirectImage"]) {
    const f = await fixture({ [mode]: true });
    try {
      const result = await runServerTask(
        f.backend,
        task,
        AbortSignal.timeout(3000),
        async () => {},
        async () => {},
        {},
        1,
      );
      assert(!result.content.some((c) => c.content.type === "image"));
      assert(result.content.some((c) => c.content.type === "resource_link"));
      assert(
        JSON.parse(result.text).warnings.some((s) =>
          s.includes("preview unavailable"),
        ),
      );
    } finally {
      await f.close();
    }
  }
});

test("ACP remote tasks require explicit enablement and scoped approval; restore never replays and model changes disable", async () => {
  for (const allowed of [true, false, "cancel", "read_only"]) {
    const f = await fixture();
    await writeJson("config.json", f.config);
    const workspace = join(temporary, randomUUID());
    await mkdir(workspace);
    const agent = createAgent(),
      app = new ClientApp(),
      updates = [];
    app.onNotification("session/update", ({ params }) => updates.push(params));
    app.onRequest("session/request_permission", async ({ params }) => {
      const remote = params.toolCall.title.startsWith("Delegate to Open WebUI");
      if (remote) {
        assert.match(params.toolCall.title, /Create and retain/);
        assert.match(
          params.toolCall.title,
          /Individual remote calls do not receive ACP approval/,
        );
        assert.deepEqual(
          params.options.map((o) => o.optionId),
          ["once", "session", "remember", "deny"],
        );
        assert(
          !f.requests.some(
            (r) => r.method === "POST" && r.path.endsWith("/chats/new"),
          ),
        );
        if (allowed === "cancel")
          await c.agent.notify("session/cancel", {
            sessionId: params.sessionId,
          });
      }
      return {
        outcome: {
          outcome: "selected",
          optionId: remote && allowed === false ? "deny" : "once",
        },
      };
    });
    const c = app.connect(agent.app);
    try {
      await c.agent.request("initialize", {
        protocolVersion: 1,
        clientCapabilities: {},
      });
      const s = await c.agent.request("session/new", {
        cwd: workspace,
        mcpServers: [],
      });
      assert.equal(
        s.configOptions.find((o) => o.id === "server_tools").currentValue,
        "off",
      );
      assert(!f.requests.some((r) => r.path.endsWith("/tools/")));
      await c.agent.request("session/set_config_option", {
        sessionId: s.sessionId,
        configId: "server_tools",
        value: "on",
      });
      assert(!f.requests.some((r) => r.method === "POST"));
      await c.agent.request("session/prompt", {
        sessionId: s.sessionId,
        prompt: [{ type: "text", text: "/status" }],
      });
      const status = updates
        .filter((u) => u.update.sessionUpdate === "agent_message_chunk")
        .at(-1);
      assert(
        JSON.parse(status.update.content.text).tools.includes("openwebui_task"),
      );
      assert(!f.requests.some((r) => r.method === "POST"));
      if (allowed === "read_only")
        await c.agent.request("session/set_config_option", {
          sessionId: s.sessionId,
          configId: "permissions",
          value: "read_only",
        });
      await c.agent.request("session/prompt", {
        sessionId: s.sessionId,
        prompt: [{ type: "text", text: "Use the delegated task" }],
      });
      const created = f.requests.filter((r) => r.path.endsWith("/chats/new"));
      assert.equal(created.length, allowed === true ? 1 : 0);
      for (const r of f.requests.filter(
        (r) => r.path.endsWith("/api/chat/completions") && !r.body.chat_id,
      )) {
        assert.equal(r.body.features, undefined);
        assert.equal(r.body.tool_ids, undefined);
        assert(Array.isArray(r.body.tools));
      }
      if (allowed === true)
        assert(
          updates.some((u) =>
            u.update.content?.some?.((x) => x.content?.type === "image"),
          ),
        );
      const saved = JSON.parse(
        await readFile(
          join(temporary, "state", `session-${s.sessionId}.json`),
          "utf8",
        ),
      );
      assert.equal(saved.serverRuns.length, allowed === true ? 1 : 0);
      assert(!JSON.stringify(saved).includes(png.toString("base64")));
      const switched = await c.agent.request("session/set_config_option", {
        sessionId: s.sessionId,
        configId: "model",
        value: "other",
      });
      assert.equal(
        switched.configOptions.find((o) => o.id === "server_tools")
          .currentValue,
        "off",
      );
      if (allowed === true) {
        const interrupted = JSON.parse(
          await readFile(
            join(temporary, "state", `session-${s.sessionId}.json`),
            "utf8",
          ),
        );
        interrupted.serverRuns[0].state = "running";
        await writeJson(`session-${s.sessionId}.json`, interrupted);
      }
      const restored = createAgent(),
        restoreClient = new ClientApp();
      restoreClient.onNotification("session/update", () => {});
      const rc = restoreClient.connect(restored.app);
      try {
        await rc.agent.request("initialize", {
          protocolVersion: 1,
          clientCapabilities: {},
        });
        const count = f.requests.filter((r) => r.method === "POST").length;
        const loaded = await rc.agent.request("session/load", {
          sessionId: s.sessionId,
          cwd: workspace,
          mcpServers: [],
        });
        assert.equal(
          loaded.configOptions.find((o) => o.id === "server_tools")
            .currentValue,
          "off",
        );
        assert.equal(
          f.requests.filter((r) => r.method === "POST").length,
          count,
        );
        if (allowed === true)
          assert.equal(
            restored.sessions.get(s.sessionId).serverRuns[0].state,
            "unknown",
          );
      } finally {
        rc.close();
        await restored.close();
      }
    } finally {
      c.close();
      await agent.close();
      await f.close();
    }
  }
});

test("administrator restrictions block remote task enablement before discovery", async () => {
  const f = await fixture();
  await writeJson("config.json", f.config);
  const workspace = join(temporary, randomUUID());
  await mkdir(workspace);
  for (const rules of [{ allowServerTools: false }, { mcpHttpUrls: [] }]) {
    const agent = createAgent({
      loadPolicy: async () => snapshotPolicy({ version: 1, ...rules }),
    });
    const app = new ClientApp();
    app.onNotification("session/update", () => {});
    const c = app.connect(agent.app);
    try {
      await c.agent.request("initialize", {
        protocolVersion: 1,
        clientCapabilities: {},
      });
      const s = await c.agent.request("session/new", {
        cwd: workspace,
        mcpServers: [],
      });
      await assert.rejects(
        c.agent.request("session/set_config_option", {
          sessionId: s.sessionId,
          configId: "server_tools",
          value: "on",
        }),
        /Administrator policy denies/,
      );
      assert(!f.requests.some((r) => r.path.endsWith("/tools/")));
    } finally {
      c.close();
      await agent.close();
    }
  }
  await f.close();
});

test("server task grant covers prompts but binds exact selected model, features, tools and visible policy metadata", async () => {
  const f = await fixture();
  try {
    const catalog = await serverCatalog(
      f.backend,
      model,
      AbortSignal.timeout(3000),
    );
    const first = serverTaskGrant(task, catalog, model);
    assert.equal(
      serverTaskGrant(
        {
          ...task,
          prompt: "A different task",
          features: [...task.features].reverse(),
        },
        catalog,
        model,
      ).id,
      first.id,
    );
    for (const [t, c, m] of [
      [{ ...task, features: ["memory"] }, catalog, model],
      [{ ...task, toolIds: [] }, catalog, model],
      [task, catalog, { ...model, id: "other" }],
      [task, { ...catalog, version: "different" }, model],
      [task, { ...catalog, unverifiedFeatures: ["web_search"] }, model],
      [
        task,
        {
          ...catalog,
          tools: catalog.tools.map((t) => ({ ...t, name: "Changed server" })),
        },
        model,
      ],
      [
        task,
        catalog,
        { ...model, info: { meta: { builtinTools: { notes: false } } } },
      ],
    ])
      assert.notEqual(serverTaskGrant(t, c, m).id, first.id);
    assert(!JSON.stringify(first).includes(task.prompt));
  } finally {
    await f.close();
  }
});

test("remote task session/remembered grants reuse only their scope and support revocation; ask policies stay once-only", async () => {
  for (const choice of [
    "once",
    "session",
    "remember",
    "ask",
    "managed",
    "yolo",
    "yolo-managed",
  ]) {
    const managed = choice === "managed" || choice === "yolo-managed";
    const alwaysAsk = choice === "ask" || managed;
    const yolo = choice.startsWith("yolo");
    const settings = {
      repeatTasks: true,
      noImages: true,
      task: { ...task, prompt: "first task" },
    };
    const f = await fixture(settings);
    await writeJson("config.json", f.config);
    const workspace = join(temporary, randomUUID());
    await mkdir(workspace);
    let remoteApprovals = 0;
    const connected = [];
    async function connect() {
      const agent = createAgent(
        managed
          ? {
              loadPolicy: async () =>
                snapshotPolicy({ version: 1, alwaysAsk: ["mcp-tool"] }),
            }
          : {},
      );
      const app = new ClientApp();
      app.onNotification("session/update", () => {});
      app.onRequest("session/request_permission", ({ params }) => {
        if (params.toolCall.title.startsWith("Enable YOLO"))
          return { outcome: { outcome: "selected", optionId: "enable-yolo" } };
        if (!params.toolCall.title.startsWith("Delegate to Open WebUI"))
          return { outcome: { outcome: "selected", optionId: "once" } };
        remoteApprovals++;
        assert.match(params.toolCall.title, /authorize ANY prompt/);
        assert.deepEqual(
          params.options.map((o) => o.optionId),
          alwaysAsk
            ? ["once", "deny"]
            : ["once", "session", "remember", "deny"],
        );
        return {
          outcome: {
            outcome: "selected",
            optionId: alwaysAsk || yolo ? "once" : choice,
          },
        };
      });
      const c = app.connect(agent.app);
      const item = { c, agent };
      connected.push(item);
      await c.agent.request("initialize", {
        protocolVersion: 1,
        clientCapabilities: {},
      });
      const s = await c.agent.request("session/new", {
        cwd: workspace,
        mcpServers: [],
      });
      await c.agent.request("session/set_config_option", {
        sessionId: s.sessionId,
        configId: "server_tools",
        value: "on",
      });
      if (choice === "ask" || yolo)
        await c.agent.request("session/set_config_option", {
          sessionId: s.sessionId,
          configId: "permissions",
          value: yolo ? "yolo" : "ask",
        });
      return {
        ...item,
        id: s.sessionId,
        prompt: (text) =>
          c.agent.request("session/prompt", {
            sessionId: s.sessionId,
            prompt: [{ type: "text", text }],
          }),
      };
    }
    try {
      const first = await connect();
      await first.prompt("first");
      settings.task.prompt = "second task";
      await first.prompt("second");
      assert.equal(
        remoteApprovals,
        choice === "yolo"
          ? 0
          : ["session", "remember"].includes(choice)
            ? 1
            : 2,
      );
      const before = remoteApprovals;
      const second = await connect();
      await second.prompt("third");
      assert.equal(
        remoteApprovals,
        before + (["remember", "yolo"].includes(choice) ? 0 : 1),
      );
      settings.task.features = ["memory"];
      const changed = remoteApprovals;
      await second.prompt("different feature scope");
      assert.equal(remoteApprovals, changed + (choice === "yolo" ? 0 : 1));
      await second.prompt("/permissions revoke-tools");
      const revoked = remoteApprovals;
      await second.prompt("after revocation");
      assert.equal(remoteApprovals, revoked + 1);
      assert.equal(
        f.requests.filter((r) => r.path.endsWith("/chats/new")).length,
        5,
      );
      const stored = await readFile(
        join(temporary, "state", "permissions.json"),
        "utf8",
      );
      assert(!stored.includes("second task"));
      assert(!stored.includes("synthetic-api-only"));
    } finally {
      for (const { c, agent } of connected) {
        c.close();
        await agent.close();
      }
      await f.close();
    }
  }
});
