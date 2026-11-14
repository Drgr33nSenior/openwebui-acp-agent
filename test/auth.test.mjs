import test from "node:test";
import assert from "node:assert/strict";
import "./fixtures/keyring.mjs";
import { mkdtemp, mkdir, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { ClientApp } from "@agentclientprotocol/sdk";

const base = await mkdtemp(join(tmpdir(), "ow-auth-test-"));
process.env.OPENWEBUI_ACP_HOME = join(base, "state");
delete process.env.OPENWEBUI_API_KEY;
const { runSetup } = await import("../dist/setup.js");
const { authMethods } = await import("../dist/auth.js");
const { createAgent } = await import("../dist/agent.js");
const { config, key, logout, readJson } = await import("../dist/config.js");
const workspace = join(base, "workspace");
await mkdir(workspace);
let modelStatus = 200,
  completionStatus = 200,
  modelRequests = 0,
  completionRequests = 0,
  modelHandler,
  completionHandler;
const server = createServer(async (req, res) => {
  req.resume();
  if (req.url === "/prefix/api/models") {
    modelRequests++;
    if (modelStatus !== 200) {
      res.writeHead(modelStatus).end("untrusted error body");
      return;
    }
    if (req.headers.authorization !== "Bearer fixture-key") {
      res.writeHead(401).end();
      return;
    }
    if (modelHandler) return modelHandler(req, res);
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({
        data: [{ id: "fixture-model" }, { id: "second-model" }],
      }),
    );
  } else {
    completionRequests++;
    if (completionHandler) return completionHandler(req, res);
    res.writeHead(completionStatus, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        choices: [
          {
            message: { role: "assistant", content: "connected" },
            finish_reason: "stop",
          },
        ],
      }),
    );
  }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const url = `http://127.0.0.1:${server.address().port}/prefix`;
function ui(answers) {
  const prompts = [],
    messages = [];
  return {
    prompts,
    messages,
    ask: async (label, secret, signal) => {
      signal.throwIfAborted();
      prompts.push({ label, secret });
      const answer = answers.shift();
      if (answer instanceof Error) throw answer;
      return answer;
    },
    write: (m) => messages.push(m),
  };
}
async function connect(capabilities, permission, dependencies) {
  const agent = createAgent(dependencies);
  const updates = [];
  const client = new ClientApp()
    .onNotification("session/update", (notification) =>
      updates.push(notification.params.update),
    )
    .onRequest(
      "session/request_permission",
      permission ??
        (() => ({
          outcome: { outcome: "selected", optionId: "once" },
        })),
    );
  const connection = client.connect(agent.app);
  const init = await connection.agent.request("initialize", {
    protocolVersion: 1,
    clientCapabilities: capabilities,
  });
  return {
    agent,
    connection,
    init,
    updates,
    close: async () => {
      connection.close();
      await agent.close();
    },
  };
}
const modern = { auth: { terminal: true } },
  legacy = { _meta: { "terminal-auth": true } };
async function cliLogout(state) {
  const child = spawn(
    process.execPath,
    [
      "--import",
      resolve("test/fixtures/keyring.mjs"),
      resolve("dist/cli.js"),
      "logout",
    ],
    {
      env: { PATH: process.env.PATH, OPENWEBUI_ACP_HOME: state },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stdout = "",
    stderr = "";
  child.stdout.on("data", (b) => (stdout += b));
  child.stderr.on("data", (b) => (stderr += b));
  assert.equal(await new Promise((r) => child.on("close", r)), 0);
  assert.equal(stdout, "");
  assert.match(stderr, /Signed out/);
}
test("logout before setup is idempotent and requires no backend or keyring entry", async () => {
  const state = join(base, "empty-logout");
  for (let i = 0; i < 2; i++) {
    await cliLogout(state);
    assert.equal(
      JSON.parse(await readFile(join(state, "auth-state.json"), "utf8"))
        .loggedOut,
      true,
    );
  }
});

test("capability negotiation: modern, JetBrains legacy, both and unsupported", () => {
  const typed = authMethods(modern)[0];
  assert.equal(typed.type, "terminal");
  assert.deepEqual(typed.args, ["--setup"]);
  assert(!("command" in typed));
  const old = authMethods(legacy)[0];
  assert.equal(old.type, undefined);
  assert.deepEqual(old._meta["terminal-auth"], {
    args: [resolve("dist/cli.js"), "--setup"],
    env: {},
    label: "Set up Open WebUI",
  });
  assert.equal(authMethods({ ...modern, ...legacy })[0].type, "terminal");
  for (const caps of [
    {},
    { terminal: true },
    { _meta: { "terminal-auth": "true" } },
    { auth: { terminal: false } },
  ])
    assert.deepEqual(authMethods(caps), []);
});
test("first-use IDE setup, secret storage, reconnect and model selector", async () => {
  for (const caps of [modern, legacy]) {
    const c = await connect(caps);
    try {
      await assert.rejects(
        c.connection.agent.request("session/new", {
          cwd: workspace,
          mcpServers: [],
        }),
        (e) =>
          e.code === -32000 &&
          e.message.includes("Set up Open WebUI") &&
          !e.message.includes("run "),
      );
    } finally {
      await c.close();
    }
  }
  const terminal = ui([url, "fixture-key"]);
  await runSetup(terminal, AbortSignal.timeout(5000));
  assert.deepEqual(
    terminal.prompts.map((p) => p.secret),
    [false, true],
  );
  assert(!terminal.messages.join("").includes("fixture-key"));
  for (const name of await readdir(join(base, "state")))
    assert(
      !(await readFile(join(base, "state", name), "utf8")).includes(
        "fixture-key",
      ),
    );
  const c = await connect(modern);
  try {
    const s = await c.connection.agent.request("session/new", {
      cwd: workspace,
      mcpServers: [],
    });
    assert.equal(s.configOptions[0].currentValue, "fixture-model");
    assert.equal(s.configOptions[0].options.length, 2);
    await assert.rejects(
      c.connection.agent.request("authenticate", { methodId: "login" }),
      (e) => e.code === -32602,
    );
  } finally {
    await c.close();
  }
  const old = await connect(legacy);
  try {
    assert.deepEqual(
      await old.connection.agent.request("authenticate", { methodId: "login" }),
      {},
    );
    await assert.rejects(
      old.connection.agent.request("authenticate", { methodId: "unknown" }),
      (e) => e.code === -32602,
    );
  } finally {
    await old.close();
  }
});
test("cancelled setup and invalid or forbidden key do not replace configuration", async () => {
  const before = await readJson("config.json"),
    epoch = await readJson("auth-state.json");
  for (const answers of [
    [new Error("Setup cancelled")],
    [url, new Error("Setup cancelled")],
  ])
    await assert.rejects(
      runSetup(ui(answers), AbortSignal.timeout(5000)),
      /cancelled/,
    );
  await assert.rejects(
    runSetup(ui([url, "wrong-fixture-key"]), AbortSignal.timeout(5000)),
    /Authentication/,
  );
  modelStatus = 403;
  await assert.rejects(
    runSetup(ui([url, "fixture-key"]), AbortSignal.timeout(5000)),
    /Access denied/,
  );
  modelStatus = 200;
  assert.deepEqual(await readJson("config.json"), before);
  assert.deepEqual(await readJson("auth-state.json"), epoch);
  const c = await connect(modern);
  try {
    await c.connection.agent.request("session/new", {
      cwd: workspace,
      mcpServers: [],
    });
  } finally {
    await c.close();
  }
});
test("cancellation during validation prevents storing credentials", async () => {
  const controller = new AbortController();
  let saved = false;
  const services = {
    previous: async () => undefined,
    models: async () => {
      controller.abort();
      return ["model"];
    },
    save: async () => {
      saved = true;
    },
  };
  await assert.rejects(
    runSetup(ui([url, "fixture-key"]), controller.signal, services),
  );
  assert.equal(saved, false);
});
test("credential-store failure is not silently replaced with plaintext storage", async () => {
  let saved = false;
  const services = {
    previous: async () => undefined,
    models: async () => ["model"],
    save: async () => {
      saved = true;
      throw new Error("Credential store unavailable");
    },
  };
  const terminal = ui([url, "fixture-key"]);
  await assert.rejects(
    runSetup(terminal, AbortSignal.timeout(5000), services),
    /store unavailable/,
  );
  assert(saved);
  assert(!terminal.messages.join("").includes("Connected to"));
});
test("expired credentials produce actionable ACP errors in new, load and prompt", async () => {
  const c = await connect(modern);
  let id;
  try {
    id = (
      await c.connection.agent.request("session/new", {
        cwd: workspace,
        mcpServers: [],
      })
    ).sessionId;
    modelStatus = 401;
    await assert.rejects(
      c.connection.agent.request("session/new", {
        cwd: workspace,
        mcpServers: [],
      }),
      (e) => e.code === -32000 && e.message.includes("Set up Open WebUI"),
    );
    modelStatus = 200;
    completionStatus = 401;
    await assert.rejects(
      c.connection.agent.request("session/prompt", {
        sessionId: id,
        prompt: [{ type: "text", text: "hello" }],
      }),
      (e) => e.code === -32000,
    );
    completionStatus = 200;
  } finally {
    await c.close();
    modelStatus = 200;
    completionStatus = 200;
  }
  const load = await connect(modern);
  try {
    modelStatus = 401;
    await assert.rejects(
      load.connection.agent.request("session/load", {
        sessionId: id,
        cwd: workspace,
        mcpServers: [],
      }),
      (e) => e.code === -32000,
    );
  } finally {
    modelStatus = 200;
    await load.close();
  }
  await runSetup(ui(["", "fixture-key"]), AbortSignal.timeout(5000));
  const recovered = await connect(modern);
  try {
    await recovered.connection.agent.request("session/load", {
      sessionId: id,
      cwd: workspace,
      mcpServers: [],
    });
  } finally {
    await recovered.close();
  }
});
test("logout requires IDE setup again and invalidates prior sessions", async () => {
  const c = await connect(modern);
  try {
    const s = await c.connection.agent.request("session/new", {
      cwd: workspace,
      mcpServers: [],
    });
    await logout(await config());
    await assert.rejects(
      c.connection.agent.request("session/new", {
        cwd: workspace,
        mcpServers: [],
      }),
      (e) => e.code === -32000,
    );
    await assert.rejects(
      c.connection.agent.request("session/prompt", {
        sessionId: s.sessionId,
        prompt: [{ type: "text", text: "hello" }],
      }),
      (e) => e.code === -32000,
    );
  } finally {
    await c.close();
  }
});
test("chat login advertises IDE setup without deleting credentials or sending inference", async () => {
  await runSetup(ui([url, "fixture-key"]), AbortSignal.timeout(5000));
  for (const caps of [modern, legacy, {}]) {
    const c = await connect(caps);
    try {
      const { sessionId } = await c.connection.agent.request("session/new", {
        cwd: workspace,
        mcpServers: [],
      });
      assert.deepEqual(c.init.agentCapabilities.auth.logout, {});
      const commands = c.updates.find(
        (u) => u.sessionUpdate === "available_commands_update",
      ).availableCommands;
      assert(commands.some((v) => v.name === "login"));
      assert(commands.some((v) => v.name === "logout"));
      const epoch = await readJson("auth-state.json"),
        before = completionRequests;
      await assert.rejects(
        c.connection.agent.request("session/prompt", {
          sessionId,
          prompt: [
            { type: "text", text: "/login" },
            {
              type: "resource_link",
              uri: "file:///unapproved/project.txt",
              name: "editor context",
            },
          ],
        }),
        (e) =>
          e.code === -32000 &&
          e.message.includes(
            caps === modern || caps === legacy
              ? "Set up Open WebUI"
              : "manual-login",
          ),
      );
      for (const command of [
        "/login fixture-do-not-log",
        "/logout fixture-do-not-log",
      ])
        await assert.rejects(
          c.connection.agent.request("session/prompt", {
            sessionId,
            prompt: [{ type: "text", text: command }],
          }),
          (e) => e.code === -32602 && !e.message.includes("fixture-do-not-log"),
        );
      assert.equal(await key(await config()), "fixture-key");
      assert.deepEqual(await readJson("auth-state.json"), epoch);
      assert.equal(completionRequests, before);
      assert.equal(c.agent.sessions.get(sessionId).messages.length, 0);
    } finally {
      await c.close();
    }
  }
});
test("chat and ACP logout remove the key, invalidate all sessions and require setup then reconnect", async () => {
  for (const method of ["chat", "rpc"]) {
    await runSetup(ui([url, "fixture-key"]), AbortSignal.timeout(5000));
    const c = await connect(modern);
    try {
      const ids = [];
      for (let i = 0; i < 2; i++)
        ids.push(
          (
            await c.connection.agent.request("session/new", {
              cwd: workspace,
              mcpServers: [],
            })
          ).sessionId,
        );
      const before = completionRequests;
      process.env.OPENWEBUI_API_KEY = "fixture-key";
      if (method === "chat")
        assert.equal(
          (
            await c.connection.agent.request("session/prompt", {
              sessionId: ids[0],
              prompt: [{ type: "text", text: "/logout" }],
            })
          ).stopReason,
          "end_turn",
        );
      else assert.deepEqual(await c.connection.agent.request("logout", {}), {});
      assert.equal(process.env.OPENWEBUI_API_KEY, undefined);
      const { Entry } = await import("@napi-rs/keyring");
      assert.equal(new Entry("openwebui-acp-agent", url).getPassword(), null);
      await assert.rejects(key(await config()), /Authentication required/);
      for (const sessionId of ids) {
        for (const message of ["hello", "/doctor", "/model second-model"])
          await assert.rejects(
            c.connection.agent.request("session/prompt", {
              sessionId,
              prompt: [{ type: "text", text: message }],
            }),
            (e) => e.code === -32000,
          );
        await assert.rejects(
          c.connection.agent.request("session/set_config_option", {
            sessionId,
            configId: "model",
            value: "second-model",
          }),
          (e) => e.code === -32000,
        );
      }
      await assert.rejects(
        c.connection.agent.request("session/new", {
          cwd: workspace,
          mcpServers: [],
        }),
        (e) => e.code === -32000,
      );
      assert.equal(completionRequests, before);
      assert.deepEqual(await c.connection.agent.request("logout", {}), {});
      // Reconnect alone cannot bypass logout, even with an environment credential.
      process.env.OPENWEBUI_API_KEY = "fixture-key";
      const loggedOut = await connect(modern);
      try {
        await assert.rejects(
          loggedOut.connection.agent.request("session/new", {
            cwd: workspace,
            mcpServers: [],
          }),
          (e) => e.code === -32000,
        );
      } finally {
        await loggedOut.close();
        delete process.env.OPENWEBUI_API_KEY;
      }
      await runSetup(ui([url, "fixture-key"]), AbortSignal.timeout(5000));
      await assert.rejects(
        c.connection.agent.request("session/new", {
          cwd: workspace,
          mcpServers: [],
        }),
        (e) => e.code === -32000,
      );
      const recovered = await connect(modern);
      try {
        await recovered.connection.agent.request("session/load", {
          sessionId: ids[0],
          cwd: workspace,
          mcpServers: [],
        });
        assert(
          recovered.updates.some(
            (u) =>
              u.sessionUpdate === "available_commands_update" &&
              u.availableCommands.some((x) => x.name === "login"),
          ),
        );
        assert.equal(completionRequests, before);
        const result = await recovered.connection.agent.request(
          "session/prompt",
          { sessionId: ids[0], prompt: [{ type: "text", text: "hello" }] },
        );
        assert.equal(result.stopReason, "end_turn");
      } finally {
        await recovered.close();
      }
    } finally {
      await c.close();
    }
  }
});
test(
  "logout cancels pending approval; a late allow cannot activate the workspace",
  { timeout: 10000 },
  async () => {
    await runSetup(ui([url, "fixture-key"]), AbortSignal.timeout(5000));
    const arrived = Promise.withResolvers(),
      reply = Promise.withResolvers();
    const c = await connect(modern, () => {
      arrived.resolve();
      return reply.promise;
    });
    try {
      const { sessionId } = await c.connection.agent.request("session/new", {
        cwd: workspace,
        mcpServers: [],
      });
      const before = completionRequests;
      const pending = c.connection.agent.request("session/prompt", {
        sessionId,
        prompt: [{ type: "text", text: "hello" }],
      });
      await arrived.promise;
      await c.connection.agent.request("session/prompt", {
        sessionId,
        prompt: [{ type: "text", text: "/logout" }],
      });
      reply.resolve({ outcome: { outcome: "selected", optionId: "remember" } });
      assert.equal((await pending).stopReason, "cancelled");
      assert.equal(c.agent.sessions.get(sessionId).active, false);
      assert.equal(completionRequests, before);
      assert.equal((await readJson("trust.json"))?.[workspace], undefined);
    } finally {
      reply.resolve({ outcome: { outcome: "cancelled" } });
      await c.close();
    }
  },
);
test(
  "protocol logout and logout from a separate CLI process abort active inference",
  { timeout: 10000 },
  async () => {
    for (const external of [false, true]) {
      await runSetup(ui([url, "fixture-key"]), AbortSignal.timeout(5000));
      const arrived = Promise.withResolvers(),
        closed = Promise.withResolvers();
      completionHandler = (_req, res) => {
        res.on("close", () => closed.resolve());
        arrived.resolve();
      };
      const c = await connect(modern);
      try {
        const { sessionId } = await c.connection.agent.request("session/new", {
          cwd: workspace,
          mcpServers: [],
        });
        const pending = c.connection.agent.request("session/prompt", {
          sessionId,
          prompt: [{ type: "text", text: "hello" }],
        });
        await arrived.promise;
        if (external) await cliLogout(join(base, "state"));
        else await c.connection.agent.request("logout", {});
        assert.equal((await pending).stopReason, "cancelled");
        await closed.promise;
      } finally {
        completionHandler = undefined;
        await c.close();
      }
    }
  },
);
test(
  "IDE logout cancels queued prompts without entering another inference",
  { timeout: 10000 },
  async () => {
    await runSetup(ui([url, "fixture-key"]), AbortSignal.timeout(5000));
    const arrived = Promise.withResolvers();
    completionHandler = () => arrived.resolve();
    const c = await connect(modern);
    try {
      const { sessionId } = await c.connection.agent.request("session/new", {
        cwd: workspace,
        mcpServers: [],
      });
      await c.connection.agent.request("session/set_config_option", {
        sessionId,
        configId: "prompt_mode",
        value: "queue",
      });
      const prompt = (text) =>
        c.connection.agent.request("session/prompt", {
          sessionId,
          prompt: [{ type: "text", text }],
        });
      const first = prompt("active");
      await arrived.promise;
      const before = completionRequests;
      const second = prompt("queued before logout");
      const deadline = Date.now() + 5000;
      while (!c.agent.sessions.get(sessionId).turns.queued) {
        assert(Date.now() < deadline, "queue did not receive the prompt");
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      await prompt("/logout");
      assert.equal((await first).stopReason, "cancelled");
      assert.equal((await second).stopReason, "cancelled");
      assert.equal(completionRequests, before);
      assert.equal(c.agent.sessions.get(sessionId).turns.queued, 0);
    } finally {
      completionHandler = undefined;
      await c.close();
    }
  },
);
test(
  "logout cancels an executing command and closes connected MCP clients",
  { timeout: 10000 },
  async () => {
    await runSetup(ui([url, "fixture-key"]), AbortSignal.timeout(5000));
    const started = Promise.withResolvers();
    let cancelled = false,
      closed = false;
    completionHandler = (_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          choices: [
            {
              message: {
                role: "assistant",
                content: null,
                tool_calls: [
                  {
                    id: "command",
                    type: "function",
                    function: {
                      name: "run_command",
                      arguments: JSON.stringify({
                        executable: "git",
                        args: ["status"],
                      }),
                    },
                  },
                ],
              },
              finish_reason: "tool_calls",
            },
          ],
        }),
      );
    };
    const c = await connect(modern, undefined, {
      sandboxCommand: async (_exe, _args, _options, signal) => {
        started.resolve();
        await new Promise((resolve) =>
          signal.addEventListener("abort", resolve, { once: true }),
        );
        cancelled = true;
        signal.throwIfAborted();
      },
    });
    try {
      const { sessionId } = await c.connection.agent.request("session/new", {
        cwd: workspace,
        mcpServers: [],
      });
      const pending = c.connection.agent.request("session/prompt", {
        sessionId,
        prompt: [{ type: "text", text: "check status" }],
      });
      await started.promise;
      c.agent.sessions.get(sessionId).mcp.clients.push({
        close: async () => {
          closed = true;
        },
      });
      await c.connection.agent.request("logout", {});
      assert.equal((await pending).stopReason, "cancelled");
      assert(cancelled);
      assert(closed);
      assert.equal(c.agent.sessions.get(sessionId).mcp.clients.length, 0);
    } finally {
      completionHandler = undefined;
      await c.close();
    }
  },
);
test(
  "logout during model discovery cannot create or restore a session with an old key",
  { timeout: 10000 },
  async () => {
    await runSetup(ui([url, "fixture-key"]), AbortSignal.timeout(5000));
    const original = await connect(modern);
    const { sessionId } = await original.connection.agent.request(
      "session/new",
      { cwd: workspace, mcpServers: [] },
    );
    await original.close();
    for (const method of ["session/new", "session/load"]) {
      await runSetup(ui([url, "fixture-key"]), AbortSignal.timeout(5000));
      const arrived = Promise.withResolvers();
      let response;
      modelHandler = (_req, res) => {
        response = res;
        arrived.resolve();
      };
      const c = await connect(modern);
      try {
        const pending = c.connection.agent.request(method, {
          ...(method === "session/load" ? { sessionId } : {}),
          cwd: workspace,
          mcpServers: [],
        });
        const rejected = assert.rejects(pending, (e) => e.code === -32000);
        await arrived.promise;
        await cliLogout(join(base, "state"));
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ data: [{ id: "fixture-model" }] }));
        await rejected;
        assert.equal(c.agent.sessions.size, 0);
      } finally {
        response?.end();
        modelHandler = undefined;
        await c.close();
      }
    }
  },
);
test("credential-store deletion failure is actionable, redacted and still fails closed", async () => {
  await runSetup(ui([url, "fixture-key"]), AbortSignal.timeout(5000));
  const c = await connect(modern);
  const { Entry } = await import("@napi-rs/keyring");
  const entry = new Entry("openwebui-acp-agent", url);
  try {
    const { sessionId } = await c.connection.agent.request("session/new", {
      cwd: workspace,
      mcpServers: [],
    });
    entry.setPassword("fixture-delete-denied");
    await assert.rejects(
      c.connection.agent.request("logout", {}),
      (e) =>
        e.message.includes("Logout could not fully remove credentials") &&
        !e.message.includes("fixture-delete-denied"),
    );
    await assert.rejects(key(await config()), /Authentication required/);
    await assert.rejects(
      c.connection.agent.request("session/prompt", {
        sessionId,
        prompt: [{ type: "text", text: "hello" }],
      }),
      (e) => e.code === -32000,
    );
  } finally {
    entry.setPassword("fixture-key");
    await logout();
    await c.close();
  }
});
test(
  "403 session creation and restoration preserve login/logout access without enabling coding",
  { timeout: 15000 },
  async () => {
    for (const caps of [modern, legacy, {}]) {
      for (const method of ["session/new", "session/load"]) {
        modelStatus = 200;
        await runSetup(ui([url, "fixture-key"]), AbortSignal.timeout(5000));
        const previous = await connect(caps);
        const saved = await previous.connection.agent.request("session/new", {
          cwd: workspace,
          mcpServers: [],
        });
        await previous.close();
        modelStatus = 403;
        let approvals = 0,
          executions = 0;
        const c = await connect(
          caps,
          () => {
            approvals++;
            throw new Error("Unexpected permission request");
          },
          {
            sandboxCommand: async () => {
              executions++;
              throw new Error("Unexpected command");
            },
          },
        );
        const before = completionRequests;
        try {
          const response = await c.connection.agent.request(method, {
            ...(method === "session/load"
              ? { sessionId: saved.sessionId }
              : {}),
            cwd: workspace,
            mcpServers: [
              {
                name: "must-not-start",
                command: process.execPath,
                args: ["-e", "process.exit(99)"],
                env: [],
              },
            ],
          });
          const sessionId = response.sessionId ?? saved.sessionId;
          assert.deepEqual(response.configOptions, []);
          const commands = c.updates
            .find((u) => u.sessionUpdate === "available_commands_update")
            .availableCommands.map((v) => v.name);
          assert.deepEqual(commands, ["login", "logout", "status", "doctor"]);
          const prompt = (text) =>
            c.connection.agent.request("session/prompt", {
              sessionId,
              prompt: [
                { type: "text", text },
                {
                  type: "resource_link",
                  name: "context",
                  uri: "file:///unapproved/project.txt",
                },
              ],
            });
          for (const message of [
            "edit the project",
            "/permissions mode development",
            "/model second-model",
            "/status",
            "/doctor",
          ])
            assert.equal((await prompt(message)).stopReason, "end_turn");
          await assert.rejects(
            c.connection.agent.request("session/set_config_option", {
              sessionId,
              configId: "permissions",
              value: "development",
            }),
            (e) => e.code === -32602 && e.message.includes("403"),
          );
          await assert.rejects(
            prompt("/login"),
            (e) =>
              e.code === -32000 &&
              e.message.includes("HTTP 403") &&
              e.message.includes(
                caps === modern || caps === legacy
                  ? "Set up Open WebUI"
                  : "manual-login",
              ),
          );
          assert.equal(completionRequests, before);
          assert.equal(approvals, 0);
          assert.equal(executions, 0);
          const state = c.agent.sessions.get(sessionId);
          assert.equal(state.active, false);
          assert.deepEqual(state.servers, []);
          assert.deepEqual(state.messages, []);
          assert(!JSON.stringify(c.updates).includes("untrusted error body"));
          const status = c.updates
            .filter((u) => u.sessionUpdate === "agent_message_chunk")
            .map((u) => u.content.text)
            .find((v) => v.startsWith("{"));
          assert.deepEqual(JSON.parse(status).tools, []);
          assert.equal(JSON.parse(status).modelVerified, false);
          modelStatus = 200;
          await prompt("/doctor");
          assert(
            c.updates.some((u) =>
              u.content?.text?.includes("Model access is restored"),
            ),
          );
          await prompt("edit the project");
          assert.equal(completionRequests, before);
          assert.equal(approvals, 0);
          modelStatus = 403;
          const modelBeforeLogout = modelRequests;
          assert.equal((await prompt("/logout")).stopReason, "end_turn");
          assert.equal(modelRequests, modelBeforeLogout);
          await assert.rejects(key(await config()), /Authentication required/);
          modelStatus = 200;
          await runSetup(ui([url, "fixture-key"]), AbortSignal.timeout(5000));
          const recovered = await connect(caps);
          try {
            const restored = await recovered.connection.agent.request(
              "session/load",
              { sessionId, cwd: workspace, mcpServers: [] },
            );
            assert(restored.configOptions.some((o) => o.id === "model"));
            assert.equal(completionRequests, before);
          } finally {
            await recovered.close();
          }
        } finally {
          modelStatus = 200;
          await c.close();
        }
      }
    }
  },
);
test("non-interactive setup variants fail without contaminating ACP stdout", async () => {
  for (const args of [
    ["--setup"],
    ["acp", "--setup"],
    ["--setup", "acp"],
    ["login"],
    ["acp", "login"],
  ]) {
    const child = spawn(process.execPath, [resolve("dist/cli.js"), ...args], {
      env: {
        PATH: process.env.PATH,
        OPENWEBUI_ACP_HOME: join(base, "noninteractive"),
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "",
      stderr = "";
    child.stdout.on("data", (b) => (stdout += b));
    child.stderr.on("data", (b) => (stderr += b));
    child.stdin.end();
    const code = await new Promise((r) => child.on("close", r));
    assert.notEqual(code, 0);
    assert.equal(stdout, "");
    assert.match(stderr, /IDE/);
  }
});
test(
  "real PTY masks the key and cancellation exits login-only mode",
  { skip: process.platform !== "darwin", timeout: 10000 },
  async () => {
    const child = spawn(
      "/bin/sh",
      [
        "-c",
        'cat | /usr/bin/script -q /dev/null "$@"',
        "auth-pty-test",
        process.execPath,
        resolve("dist/cli.js"),
        "acp",
        "--setup",
      ],
      {
        env: { PATH: process.env.PATH, OPENWEBUI_ACP_HOME: join(base, "pty") },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    const watchdog = setTimeout(() => {
      child.stdin.end();
      child.kill();
    }, 8000);
    let output = "",
      stage = 0;
    child.stderr.on("data", (b) => (output += b));
    child.stdout.on("data", (b) => {
      output += b;
      if (stage === 0 && output.includes("Installation URL:")) {
        stage = 1;
        child.stdin.write(url + "\r");
      } else if (stage === 1 && output.includes("API key:")) {
        stage = 2;
        child.stdin.write("fixture-masked-key");
      } else if (stage === 2 && output.includes("*")) {
        stage = 3;
        child.stdin.end("\u0003");
      }
    });
    const before = modelRequests;
    const code = await new Promise((r) => child.on("close", r));
    clearTimeout(watchdog);
    assert.equal(
      stage,
      3,
      output.replaceAll("fixture-masked-key", "[REDACTED]"),
    );
    assert.notEqual(code, 0);
    assert(!output.includes("fixture-masked-key"));
    assert(!output.includes("Connected to Open WebUI"));
    assert.equal(modelRequests, before);
  },
);
test.after(() => server.close());

test(
  "real PTY completes advertised setup with a minimal PATH for replacement and appended launch arguments",
  { skip: process.platform !== "darwin", timeout: 15000 },
  async () => {
    const entrypoint = resolve("dist/cli.js");
    const legacyArgs = authMethods(legacy)[0]._meta["terminal-auth"].args;
    for (const args of [
      legacyArgs,
      [entrypoint, "acp", ...legacyArgs],
      [entrypoint, "acp", ...authMethods(modern)[0].args],
    ]) {
      const state = await mkdtemp(join(base, "pty-success-"));
      const child = spawn(
        "/bin/sh",
        [
          "-c",
          'cat | /usr/bin/script -q /dev/null "$@"',
          "auth-pty-test",
          process.execPath,
          "--import",
          resolve("test/fixtures/keyring.mjs"),
          ...args,
        ],
        {
          env: { PATH: "/usr/bin:/bin", OPENWEBUI_ACP_HOME: state },
          stdio: ["pipe", "pipe", "pipe"],
        },
      );
      const watchdog = setTimeout(() => {
        child.stdin.end();
        child.kill();
      }, 8000);
      let output = "",
        stage = 0;
      child.stderr.on("data", (b) => (output += b));
      child.stdout.on("data", (b) => {
        output += b;
        if (stage === 0 && output.includes("Installation URL:")) {
          stage = 1;
          child.stdin.write(url + "\r");
        } else if (stage === 1 && output.includes("API key:")) {
          stage = 2;
          child.stdin.write("fixture-key\r");
        } else if (stage === 2 && output.includes("Connected to Open WebUI")) {
          stage = 3;
          child.stdin.end();
        }
      });
      const code = await new Promise((r) => child.on("close", r));
      clearTimeout(watchdog);
      assert.equal(stage, 3, output.replaceAll("fixture-key", "[REDACTED]"));
      assert.equal(code, 0);
      assert(!output.includes("fixture-key"));
      assert(!output.includes('"jsonrpc"'));
      const saved = JSON.parse(
        await readFile(join(state, "config.json"), "utf8"),
      );
      assert.equal(saved.url, url);
      assert.equal(saved.model, "fixture-model");
      for (const name of await readdir(state))
        assert(
          !(await readFile(join(state, name), "utf8")).includes("fixture-key"),
        );
    }
  },
);
