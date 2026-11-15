import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, realpath, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { ClientApp } from "@agentclientprotocol/sdk";
const temp = await mkdtemp(join(tmpdir(), "ow-modes-"));
process.env.OPENWEBUI_ACP_HOME = join(temp, "state");
process.env.OPENWEBUI_API_KEY = "modes-fixture-not-real";
const { directory, writeJson, configSchema } =
  await import("../dist/config.js");
assert.equal(
  directory,
  process.env.OPENWEBUI_ACP_HOME,
  "Application state must use the test's private directory before any writes",
);
const { createAgent } = await import("../dist/agent.js");
const { snapshotPolicy } = await import("../dist/policy.js");
const { reasoningChoices, reasoningPayload, defaultReasoning } =
  await import("../dist/reasoning.js");
const {
  availableSessionModes,
  codePermissionMode,
  currentSessionMode,
  parseSessionMode,
} = await import("../dist/modes.js");

// Shaped like a provider-declared control passed through Open WebUI: the
// server, not the agent, chooses the values, their order and the default.
const declaredEffort = {
  label: "Reasoning effort",
  default: "medium",
  display: "slider",
  options: {
    none: { label: "Off" },
    low: { label: "low" },
    medium: { label: "medium" },
    xhigh: { label: "Max" },
  },
};
let pending = [],
  requests = [];
const server = createServer(async (req, res) => {
  res.setHeader("Content-Type", "application/json");
  if (req.url === "/api/models")
    return res.end(
      JSON.stringify({
        data: [
          {
            id: "fixture",
            name: "Fixture Model",
            provider_model_controls: { reasoning_effort: declaredEffort },
          },
          { id: "plain" },
        ],
      }),
    );
  let body = "";
  for await (const c of req) body += c;
  requests.push(JSON.parse(body));
  const calls = pending.shift();
  res.end(
    JSON.stringify({
      choices: [
        {
          message: calls
            ? { role: "assistant", content: null, tool_calls: calls }
            : { role: "assistant", content: "done" },
        },
      ],
    }),
  );
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const url = `http://127.0.0.1:${server.address().port}`;
await writeJson("config.json", configSchema.parse({ url, model: "fixture" }));
after(() => new Promise((r) => server.close(r)));

const call = (name, args) => ({
  id: "call-" + Math.random(),
  type: "function",
  function: { name, arguments: JSON.stringify(args) },
});
async function workspace() {
  const p = await mkdtemp(join(temp, "project-"));
  await writeFile(join(p, "a.txt"), "old");
  return realpath(p);
}
async function client(
  cwd,
  {
    load,
    policy,
    initialize = { protocolVersion: 1, clientCapabilities: {} },
  } = {},
) {
  const executed = [],
    clientMethods = [],
    approvals = [],
    updates = [];
  const agent = createAgent({
    ...(policy ? { loadPolicy: async () => policy } : {}),
    sandboxCommand: async (executable, args) => {
      executed.push({ executable, args });
      return JSON.stringify({
        code: 0,
        output: "ok",
        limitedOrCancelled: false,
      });
    },
  });
  const app = new ClientApp();
  app.onNotification("session/update", ({ params }) =>
    updates.push(params.update),
  );
  app.onRequest("session/request_permission", ({ params }) => {
    approvals.push(params);
    return { outcome: { outcome: "selected", optionId: "once" } };
  });
  for (const method of ["fs/read_text_file", "fs/write_text_file"])
    app.onRequest(method, () => {
      clientMethods.push(method);
      throw new Error("client filesystem was not offered");
    });
  app.onRequest("terminal/create", () => {
    clientMethods.push("terminal/create");
    return { terminalId: "never" };
  });
  const c = app.connect(agent.app);
  const init = await c.agent.request("initialize", initialize);
  const s = await c.agent.request(load ? "session/load" : "session/new", {
    cwd,
    mcpServers: [],
    ...(load ? { sessionId: load } : {}),
  });
  const id = load ?? s.sessionId;
  return {
    id,
    c,
    init,
    s,
    approvals,
    updates,
    executed,
    clientMethods,
    prompt: (text) =>
      c.agent.request("session/prompt", {
        sessionId: id,
        prompt: [{ type: "text", text }],
      }),
    set: (configId, value) =>
      c.agent.request("session/set_config_option", {
        sessionId: id,
        configId,
        value,
      }),
    setMode: (modeId) =>
      c.agent.request("session/set_mode", { sessionId: id, modeId }),
    close: async () => {
      c.close();
      await agent.close();
    },
  };
}
const option = (result, id) =>
  result.configOptions.find((o) => o.id === id) ?? null;
const toolNames = (request) =>
  (request.tools ?? []).map((t) => t.function.name);
const mutating = (path) => [
  call("write_file", { path, content: "new" }),
  call("edit_file", { path, old_string: "old", new_string: "new" }),
  call("run_command", { executable: "touch", args: ["created.txt"] }),
];
const operationApprovals = (c) =>
  c.approvals.filter(
    (p) => !p.toolCall.title.startsWith("Activate exact workspace"),
  );

test("mode helpers map onto existing permission and workflow controls", () => {
  assert.equal(currentSessionMode("code", "scoped"), "code");
  assert.equal(currentSessionMode("code", "yolo"), "yolo");
  assert.equal(currentSessionMode("code", "development"), "code");
  assert.equal(currentSessionMode("code", "read_only"), "ask");
  assert.equal(currentSessionMode("plan", "read_only"), "plan");
  assert.equal(currentSessionMode("plan", "development"), "plan");
  assert.equal(currentSessionMode("plan", "yolo"), "plan");
  assert.throws(() => parseSessionMode("architect"), /Unknown mode/);
  assert.throws(() => parseSessionMode("full_access"), /Unknown mode/);
  for (const id of ["ask", "plan", "code", "yolo"])
    assert.deepEqual(parseSessionMode(id), { mode: id });
  // Permission-mode IDs from before the Mode selector (category "mode").
  // "ask" is also the Ask mode ID and keeps that meaning.
  assert.deepEqual(parseSessionMode("read_only"), { mode: "ask" });
  for (const id of ["scoped", "edits", "development"])
    assert.deepEqual(parseSessionMode(id), {
      mode: "code",
      permissionMode: id,
    });
  assert.deepEqual(
    availableSessionModes(undefined, true).map((m) => m.id),
    ["ask", "plan", "code", "yolo"],
  );
  assert.deepEqual(
    availableSessionModes(undefined, false).map((m) => m.id),
    ["ask", "plan", "code"],
  );
  assert.deepEqual(
    availableSessionModes(["read_only"], true).map((m) => m.id),
    ["ask", "plan"],
  );
  assert.deepEqual(
    availableSessionModes(["scoped", "edits"], true).map((m) => m.id),
    ["plan", "code"],
  );
  assert.deepEqual(
    availableSessionModes(["scoped", "yolo"], true).map((m) => m.id),
    ["plan", "code", "yolo"],
  );
  assert.deepEqual(
    availableSessionModes(["scoped", "yolo"], false).map((m) => m.id),
    ["plan", "code"],
  );
  // Code never restores an elevated mode or one the administrator denies.
  assert.equal(codePermissionMode("ask", undefined), "ask");
  assert.equal(codePermissionMode("development", undefined), "scoped");
  assert.equal(codePermissionMode("yolo", undefined), "scoped");
  assert.equal(codePermissionMode("scoped", ["ask", "read_only"]), "ask");
  assert.equal(
    codePermissionMode(undefined, ["read_only", "edits"]),
    undefined,
  );
});

test("thought level uses the server's declared levels, order and default", () => {
  const choices = reasoningChoices({
    provider_model_controls: { reasoning_effort: declaredEffort },
  });
  assert.deepEqual(
    choices.map((c) => c.name),
    [
      "Reasoning effort: Off",
      "Reasoning effort: low",
      "Reasoning effort: medium",
      "Reasoning effort: Max",
    ],
  );
  assert.equal(defaultReasoning(choices), '["reasoning_effort","medium"]');
  assert.deepEqual(
    reasoningPayload("fixture", '["reasoning_effort","none"]', choices),
    { reasoning_effort: "none" },
  );
  // No declared "none" means none is offered; no default keeps Model default.
  const undeclared = reasoningChoices({
    provider_model_controls: {
      reasoning_effort: {
        options: { low: { label: "Low" }, high: { label: "High" } },
      },
    },
  });
  assert.deepEqual(
    undeclared.map((c) => c.value),
    ["default", '["reasoning_effort","low"]', '["reasoning_effort","high"]'],
  );
  assert.equal(defaultReasoning(undeclared), "default");
  // A default naming an undeclared option is ignored.
  const invalid = reasoningChoices({
    provider_model_controls: {
      reasoning_effort: { default: "max", options: { low: {} } },
    },
  });
  assert.equal(defaultReasoning(invalid), "default");
  // Saved Open WebUI controls: one reasoning control with a default selects it;
  // several controls keep Model default because no single default applies.
  const saved = reasoningChoices({
    info: {
      params: {
        model_controls: {
          thinking: {
            default: "quick",
            options: { deep: { label: "Deep" }, quick: { label: "Quick" } },
          },
        },
      },
    },
  });
  assert.equal(defaultReasoning(saved), '["thinking","quick"]');
  assert.equal(saved.length, 2);
  const several = reasoningChoices({
    info: {
      params: {
        model_controls: {
          thinking: { default: "on", options: { on: {} } },
          reasoning: { default: "high", options: { high: {} } },
        },
      },
    },
  });
  assert.equal(defaultReasoning(several), "default");
  assert.equal(several.length, 3);
});

test("new sessions expose mode, model and thought level options plus v1 modes", async () => {
  const c = await client(await workspace());
  try {
    const ids = c.s.configOptions.map((o) => o.id);
    assert.deepEqual(ids.slice(0, 4), [
      "model",
      "reasoning",
      "mode",
      "permissions",
    ]);
    assert(!ids.includes("workflow"));
    assert.deepEqual(
      c.s.configOptions.filter((o) => o.category === "mode").map((o) => o.id),
      ["mode"],
    );
    const model = option(c.s, "model");
    assert.equal(model.category, "model");
    assert.equal(model.currentValue, "fixture");
    assert.deepEqual(
      model.options.map((o) => [o.value, o.name]),
      [
        ["fixture", "Fixture Model (fixture)"],
        ["plain", "plain"],
      ],
    );
    const reasoning = option(c.s, "reasoning");
    assert.equal(reasoning.category, "thought_level");
    assert.equal(reasoning.currentValue, '["reasoning_effort","medium"]');
    assert.deepEqual(
      reasoning.options.map((o) => o.value),
      ["none", "low", "medium", "xhigh"].map((v) =>
        JSON.stringify(["reasoning_effort", v]),
      ),
    );
    const mode = option(c.s, "mode");
    assert.equal(mode.currentValue, "code");
    assert.deepEqual(
      mode.options.map((o) => o.value),
      ["ask", "plan", "code", "yolo"],
    );
    assert.equal(c.s.modes.currentModeId, "code");
    assert.deepEqual(
      c.s.modes.availableModes.map((m) => m.id),
      ["ask", "plan", "code", "yolo"],
    );
    // The declared default is sent explicitly rather than omitted.
    requests = [];
    pending = [];
    await c.prompt("hello");
    assert.equal(requests[0].reasoning_effort, "medium");
  } finally {
    await c.close();
  }
});

test("Ask mode is the read-only permission mode: no writes, edits or commands", async () => {
  const cwd = await workspace();
  const c = await client(cwd);
  try {
    // Start from the broadest non-YOLO automatic mode to prove Ask narrows it.
    await c.set("permissions", "development");
    const result = await c.set("mode", "ask");
    assert.equal(option(result, "mode").currentValue, "ask");
    assert.equal(option(result, "permissions").currentValue, "read_only");
    requests = [];
    pending = [mutating("a.txt"), undefined];
    await c.prompt("change a.txt");
    assert.equal(await readFile(join(cwd, "a.txt"), "utf8"), "old");
    assert.deepEqual(c.executed, []);
    assert.deepEqual(operationApprovals(c), []);
    for (const name of ["write_file", "edit_file", "run_command"])
      assert(!toolNames(requests[0]).includes(name), name);
    assert.match(
      requests[0].messages.map((m) => m.content).join("\n"),
      /Ask mode is active/,
    );
    const failures = requests[1].messages.filter((m) => m.role === "tool");
    assert.equal(failures.length, 3);
    for (const m of failures) assert.match(m.content, /read-only mode/);
    // Code restores a non-elevated mode only: development is not re-enabled.
    const code = await c.set("mode", "code");
    assert.equal(option(code, "mode").currentValue, "code");
    assert.equal(option(code, "permissions").currentValue, "scoped");
  } finally {
    await c.close();
  }
});

test("Ask leaves YOLO and Code does not restore it", async () => {
  const c = await client(await workspace());
  try {
    await c.set("permissions", "yolo");
    const ask = await c.set("mode", "ask");
    assert.equal(option(ask, "permissions").currentValue, "read_only");
    assert.equal(option(ask, "sandbox").currentValue, "workspace");
    const code = await c.set("mode", "code");
    assert.equal(option(code, "permissions").currentValue, "scoped");
    // Ask each time is non-elevated and is restored after an Ask round trip.
    await c.set("permissions", "ask");
    await c.set("mode", "ask");
    const back = await c.set("mode", "code");
    assert.equal(option(back, "permissions").currentValue, "ask");
  } finally {
    await c.close();
  }
});

test("Plan mode via v1 session/set_mode blocks writes and commands and notifies both APIs", async () => {
  const cwd = await workspace();
  const c = await client(cwd);
  try {
    await c.set("permissions", "development");
    assert.deepEqual(await c.setMode("plan"), {});
    const modeUpdates = c.updates.filter(
      (u) => u.sessionUpdate === "current_mode_update",
    );
    assert.deepEqual(
      modeUpdates.map((u) => u.currentModeId),
      ["plan"],
    );
    const config = c.updates.findLast(
      (u) => u.sessionUpdate === "config_option_update",
    );
    assert.equal(option(config, "mode").currentValue, "plan");
    // Plan keeps the permission choice; the workflow blocks execution.
    assert.equal(option(config, "permissions").currentValue, "development");
    requests = [];
    pending = [mutating("a.txt"), undefined];
    await c.prompt("change a.txt");
    assert.equal(await readFile(join(cwd, "a.txt"), "utf8"), "old");
    assert.deepEqual(c.executed, []);
    assert.deepEqual(operationApprovals(c), []);
    for (const name of ["write_file", "edit_file", "run_command"])
      assert(!toolNames(requests[0]).includes(name), name);
    assert(toolNames(requests[0]).includes("update_plan"));
    await assert.rejects(c.setMode("architect"), /Unknown mode/);
    await c.setMode("code");
    assert.equal(
      c.updates.findLast((u) => u.sessionUpdate === "current_mode_update")
        .currentModeId,
      "code",
    );
  } finally {
    await c.close();
  }
});

test("mode changes from config options and slash commands announce v1 mode updates", async () => {
  const c = await client(await workspace());
  try {
    await c.set("mode", "ask");
    await c.prompt("/mode plan");
    await c.prompt("/plan off");
    await c.prompt("/permissions mode scoped");
    await c.set("reasoning", '["reasoning_effort","xhigh"]');
    assert.deepEqual(
      c.updates
        .filter((u) => u.sessionUpdate === "current_mode_update")
        .map((u) => u.currentModeId),
      ["ask", "plan", "ask", "code"],
    );
    await c.prompt("/mode");
    const status = JSON.parse(c.updates.at(-1).content.text);
    assert.equal(status.mode, "code");
    assert.deepEqual(status.modes, ["ask", "plan", "code", "yolo"]);
    await c.prompt("/mode architect");
    assert.match(c.updates.at(-1).content.text, /Unknown mode/);
    assert.equal(
      option(await c.set("autocompact", "on"), "mode").currentValue,
      "code",
    );
  } finally {
    await c.close();
  }
});

test("mode, model and thought level persist per session and restore", async () => {
  const cwd = await workspace();
  const first = await client(cwd);
  await first.set("reasoning", '["reasoning_effort","xhigh"]');
  await first.set("mode", "ask");
  const second = await client(cwd);
  await second.set("model", "plain");
  await second.set("mode", "plan");
  await first.close();
  await second.close();
  const a = await client(cwd, { load: first.id });
  try {
    assert.equal(a.s.modes.currentModeId, "ask");
    assert.equal(option(a.s, "mode").currentValue, "ask");
    assert.equal(
      option(a.s, "reasoning").currentValue,
      '["reasoning_effort","xhigh"]',
    );
    assert.equal(option(a.s, "model").currentValue, "fixture");
  } finally {
    await a.close();
  }
  const b = await client(cwd, { load: second.id });
  try {
    assert.equal(b.s.modes.currentModeId, "plan");
    assert.equal(option(b.s, "model").currentValue, "plain");
    assert.equal(option(b.s, "reasoning").currentValue, "default");
  } finally {
    await b.close();
  }
});

test("permission-mode IDs replayed onto the Mode selector map to modes", async () => {
  // Before the Mode selector, Permissions carried ACP category "mode" and
  // clients remember those IDs per category.
  const c = await client(await workspace());
  try {
    for (const [value, mode, permissions] of [
      ["development", "code", "development"],
      ["read_only", "ask", "read_only"],
      ["edits", "code", "edits"],
      ["scoped", "code", "scoped"],
      // "ask" is also the Ask mode ID and keeps that meaning.
      ["ask", "ask", "read_only"],
      ["yolo", "yolo", "yolo"],
    ]) {
      const result = await c.set("mode", value);
      assert.equal(option(result, "mode").currentValue, mode, value);
      assert.equal(
        option(result, "permissions").currentValue,
        permissions,
        value,
      );
    }
    for (const [value, mode, permissions] of [
      ["development", "code", "development"],
      ["read_only", "ask", "read_only"],
      ["scoped", "code", "scoped"],
    ]) {
      assert.deepEqual(await c.setMode(value), {});
      const config = c.updates.findLast(
        (u) => u.sessionUpdate === "config_option_update",
      );
      assert.equal(option(config, "mode").currentValue, mode, value);
      assert.equal(
        option(config, "permissions").currentValue,
        permissions,
        value,
      );
      assert.equal(
        c.updates.findLast((u) => u.sessionUpdate === "current_mode_update")
          .currentModeId,
        mode,
      );
    }
    for (const value of ["architect", "full_access", "workspace", "YOLO"]) {
      await assert.rejects(
        c.set("mode", value),
        /Unknown mode; choose ask, plan, code or yolo/,
      );
      await assert.rejects(
        c.setMode(value),
        /Unknown mode; choose ask, plan, code or yolo/,
      );
    }
    // Rejected values leave the session unchanged.
    const unchanged = await c.set("autocompact", "on");
    assert.equal(option(unchanged, "mode").currentValue, "code");
    assert.equal(option(unchanged, "permissions").currentValue, "scoped");
    assert.deepEqual(c.executed, []);
    assert.deepEqual(c.approvals, []);
  } finally {
    await c.close();
  }
  // A replayed permission-mode ID is subject to the administrator's rules.
  const limited = await client(await workspace(), {
    policy: snapshotPolicy({ version: 1, permissionModes: ["scoped", "ask"] }),
  });
  try {
    await assert.rejects(
      limited.set("mode", "development"),
      /Administrator policy denies/,
    );
    await assert.rejects(limited.setMode("read_only"), /do not allow ask mode/);
    assert.equal(option(limited.s, "permissions").currentValue, "scoped");
  } finally {
    await limited.close();
  }
});

test("administrator permission rules limit the offered modes", async () => {
  const readOnly = await client(await workspace(), {
    policy: snapshotPolicy({ version: 1, permissionModes: ["read_only"] }),
  });
  try {
    assert.equal(readOnly.s.modes.currentModeId, "ask");
    assert.deepEqual(
      option(readOnly.s, "mode").options.map((o) => o.value),
      ["ask", "plan"],
    );
    await assert.rejects(
      readOnly.set("mode", "code"),
      /do not allow code mode/,
    );
  } finally {
    await readOnly.close();
  }
  const noReadOnly = await client(await workspace(), {
    policy: snapshotPolicy({ version: 1, permissionModes: ["scoped"] }),
  });
  try {
    assert.deepEqual(
      noReadOnly.s.modes.availableModes.map((m) => m.id),
      ["plan", "code"],
    );
    await assert.rejects(noReadOnly.setMode("ask"), /do not allow ask mode/);
    assert.equal(option(noReadOnly.s, "permissions").currentValue, "scoped");
  } finally {
    await noReadOnly.close();
  }
});

test("a v2-shaped client negotiates ACP v1 and uses owned file and command implementations", async () => {
  const cwd = await workspace();
  // ACP v2 renames clientCapabilities/clientInfo; a v1 agent sees no fs or
  // terminal capability and must not call those client methods.
  const c = await client(cwd, {
    initialize: {
      protocolVersion: 2,
      capabilities: { fs: { readTextFile: true, writeTextFile: true } },
      info: { name: "v2-fixture", version: "0.0.0" },
    },
  });
  try {
    assert.equal(c.init.protocolVersion, 1);
    assert.equal(c.s.modes.currentModeId, "code");
    pending = [
      [
        call("edit_file", {
          path: "a.txt",
          old_string: "old",
          new_string: "new",
        }),
        call("run_command", { executable: "ls", args: [] }),
      ],
      undefined,
    ];
    await c.prompt("change a.txt and list files");
    assert.equal(await readFile(join(cwd, "a.txt"), "utf8"), "new");
    assert.deepEqual(c.executed, [{ executable: "ls", args: [] }]);
    assert.deepEqual(c.clientMethods, []);
  } finally {
    await c.close();
  }
});
