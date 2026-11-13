import test, { after } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  realpath,
  readFile,
  writeFile,
  stat,
  rename,
  symlink,
  unlink,
  chmod,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:http";
import { ClientApp } from "@agentclientprotocol/sdk";
const temp = await mkdtemp(join(tmpdir(), "ow-grants-"));
process.env.OPENWEBUI_ACP_HOME = join(temp, "state");
process.env.OPENWEBUI_API_KEY = "permission-fixture-not-real";
const { Permissions, grant, fingerprint, repeatableCommand } =
  await import("../dist/permissions.js");
const { writeJson, configSchema } = await import("../dist/config.js");
const { createAgent } = await import("../dist/agent.js");
const { snapshotPolicy } = await import("../dist/policy.js");
const signal = () => AbortSignal.timeout(10000);
const edits = grant(
  "edit",
  "workspace-text-edits",
  "all text edits within this workspace",
);
const pick = (optionId) => ({ outcome: { outcome: "selected", optionId } });
const call = (name, args) => ({
  id: "call-" + Math.random(),
  type: "function",
  function: { name, arguments: JSON.stringify(args) },
});
let pending = [],
  requests = [];
const server = createServer(async (req, res) => {
  res.setHeader("Content-Type", "application/json");
  if (req.url === "/api/models")
    return res.end(JSON.stringify({ data: [{ id: "fixture" }] }));
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
async function workspace() {
  const p = await mkdtemp(join(temp, "project-"));
  await writeFile(join(p, "a.txt"), "old");
  return realpath(p);
}
async function client(
  cwd,
  choose = () => "once",
  servers = [],
  load,
  terminalExit = 0,
  runHook,
  dependencies = {},
) {
  const executed = [];
  const agent = createAgent({
      ...dependencies,
      sandboxCommand: async (executable, args, run, signal) => {
        if (runHook) await runHook(run, signal);
        executed.push({
          command: executable,
          args,
          cwd: run.root,
          sandbox: run.mode,
        });
        return JSON.stringify({
          code: terminalExit,
          output: "ok",
          limitedOrCancelled: false,
        });
      },
    }),
    app = new ClientApp(),
    approvals = [],
    updates = [];
  app.onNotification("session/update", ({ params }) =>
    updates.push(params.update),
  );
  app.onRequest("session/request_permission", async ({ params }) => {
    approvals.push(params);
    const answer = await choose(params);
    return typeof answer === "string" ? pick(answer) : answer;
  });
  app.onRequest("terminal/create", ({ params }) => {
    executed.push(params);
    return { terminalId: "fixture" };
  });
  app.onRequest("terminal/wait_for_exit", () => ({ exitCode: terminalExit }));
  app.onRequest("terminal/output", () => ({
    output: "ok",
    truncated: false,
    exitStatus: { exitCode: terminalExit },
  }));
  app.onRequest("terminal/kill", () => ({}));
  app.onRequest("terminal/release", () => ({}));
  const c = app.connect(agent.app);
  await c.agent.request("initialize", {
    protocolVersion: 1,
    clientCapabilities: { terminal: true },
  });
  const s = await c.agent.request(load ? "session/load" : "session/new", {
    cwd,
    mcpServers: servers,
    ...(load ? { sessionId: load } : {}),
  });
  const id = load ?? s.sessionId;
  return {
    id,
    c,
    approvals,
    updates,
    executed,
    prompt: (text) =>
      c.agent.request("session/prompt", {
        sessionId: id,
        prompt: [{ type: "text", text }],
      }),
    close: async () => {
      c.close();
      await agent.close();
    },
  };
}
async function invoke(c, calls) {
  pending = [calls, undefined];
  return c.prompt("perform fixture task");
}
const isTool = (p) => !p.toolCall.title.startsWith("Activate exact workspace");

test("grant scopes separate roots, destinations, auth generations and sessions; remembered grants survive reconnect", async () => {
  const binding = { root: "/workspace/a", url, authEpoch: "one" };
  const p = new Permissions(binding),
    other = new Permissions(binding);
  const state = await p.prepare();
  await p.remember(edits, "session", state.epoch, signal());
  assert(p.has(edits, await p.snapshot()));
  assert(!other.has(edits, await other.snapshot()));
  await p.remember(edits, "remember", state.epoch, signal());
  assert(other.has(edits, await other.snapshot()));
  for (const changed of [
    { root: "/workspace/a-sibling" },
    { url: url + "/other" },
    { authEpoch: "two" },
  ]) {
    const isolated = new Permissions({ ...binding, ...changed });
    assert(!isolated.has(edits, await isolated.snapshot()));
  }
  await other.revoke();
  assert(!p.has(edits, await p.snapshot()));
  await assert.rejects(
    p.remember(edits, "remember", state.epoch, signal()),
    /revoked/,
  );
});

test("permission storage validates all records, rejects symlinks and unsafe modes, and preserves concurrent writes", async () => {
  const ps = Array.from(
    { length: 12 },
    (_, i) => new Permissions({ root: `concurrent-${i}` }),
  );
  await Promise.all(
    ps.map(async (p) => {
      const s = await p.prepare();
      await p.remember(edits, "remember", s.epoch, signal());
    }),
  );
  for (const p of ps) assert(p.has(edits, await p.snapshot()));
  const shared = new Permissions({ root: "concurrent-shared" });
  const epoch = (await shared.prepare()).epoch;
  await Promise.all(
    Array.from({ length: 12 }, (_, i) => {
      const p = new Permissions({ root: "concurrent-shared" });
      return p.remember(
        grant("command", ["git", "show", String(i)], "exact Git command"),
        "remember",
        epoch,
        signal(),
      );
    }),
  );
  assert.equal((await shared.inspect()).remembered.length, 12);
  const path = join(temp, "state", "permissions.json");
  const initial = await readFile(path, "utf8"),
    inode = (await stat(path)).ino;
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  await ps[0].revoke();
  assert.notEqual((await stat(path)).ino, inode);
  await writeFile(path, '{"version":1,"scopes":{"bad":{}}}');
  await assert.rejects(ps[0].revoke());
  assert.equal(
    await readFile(path, "utf8"),
    '{"version":1,"scopes":{"bad":{}}}',
  );
  await writeFile(path, initial);
  await chmod(path, 0o644);
  await assert.rejects(ps[0].snapshot());
  await chmod(path, 0o600);
  await rename(path, path + ".backup");
  await symlink(path + ".backup", path);
  await assert.rejects(ps[0].revoke());
  await unlink(path);
  await rename(path + ".backup", path);
});

test("tool identities include exact argv and MCP configuration/schema, without persisting secret values", async () => {
  const p = new Permissions({ root: "identity" }),
    s = await p.prepare();
  const server = {
    name: "same",
    url: "https://example.org/mcp",
    headers: [{ name: "Authorization", value: "mcp-fixture-secret" }],
  };
  const g = grant(
    "mcp-tool",
    { server, tool: { name: "search", inputSchema: {} } },
    "MCP search",
  );
  await p.remember(g, "remember", s.epoch, signal());
  assert(
    !(await readFile(join(temp, "state", "permissions.json"), "utf8")).includes(
      "mcp-fixture-secret",
    ),
  );
  assert.notEqual(
    g.id,
    grant(
      "mcp-tool",
      {
        server: { ...server, url: "https://other.example/mcp" },
        tool: { name: "search", inputSchema: {} },
      },
      "MCP search",
    ).id,
  );
  assert.notEqual(
    g.id,
    grant(
      "mcp-tool",
      { server, tool: { name: "write", inputSchema: {} } },
      "MCP search",
    ).id,
  );
  assert.notEqual(
    g.id,
    grant(
      "mcp-tool",
      { server, tool: { name: "search", inputSchema: { type: "object" } } },
      "MCP search",
    ).id,
  );
  assert.equal(fingerprint({ b: 2, a: 1 }), fingerprint({ a: 1, b: 2 }));
  assert.notEqual(
    grant("command", ["npm", "test"], "command").id,
    grant("command", ["npm", "test", "--changed"], "command").id,
  );
  for (const [exe, args] of [
    ["git", ["push"]],
    ["git", ["commit"]],
    ["git", ["clean", "-fd"]],
    ["rm", ["-rf", "x"]],
    ["npm", ["run", "deploy"]],
    ["kubectl", ["apply", "-f", "x"]],
    ["git", ["diff", "--ext-diff"]],
  ])
    assert(!repeatableCommand(exe, args));
  assert(repeatableCommand("git", ["status", "--short"]));
});

for (const lifetime of ["once", "session", "remember"]) {
  test(`ACP edits: ${lifetime}, actual diffs and reconnect/restore scope`, async () => {
    const cwd = await workspace();
    const c = await client(cwd, (p) => (isTool(p) ? lifetime : "once"));
    try {
      await invoke(c, [
        call("write_file", { path: "a.txt", before: "old", after: "one" }),
      ]);
      await invoke(c, [
        call("write_file", { path: "a.txt", before: "one", after: "two" }),
      ]);
      const approvals = c.approvals.filter(isTool);
      assert.equal(approvals.length, lifetime === "once" ? 2 : 1);
      assert.deepEqual(
        approvals[0].options.map((o) => [o.optionId, o.kind]),
        [
          ["once", "allow_once"],
          ["session", "allow_always"],
          ["remember", "allow_always"],
          ["deny", "reject_once"],
        ],
      );
      assert.equal(await readFile(join(cwd, "a.txt"), "utf8"), "two");
      assert.equal(
        new Set(
          c.updates
            .filter((u) => u.content?.[0]?.type === "diff")
            .map((u) => u.toolCallId),
        ).size,
        2,
      );
      assert.equal(
        c.updates.filter(
          (u) => u.status === "completed" && u.content?.[0]?.type === "diff",
        ).length,
        2,
      );
      await c.prompt("/permissions");
      const status = JSON.parse(c.updates.at(-1).content.text);
      assert.equal(
        status.toolGrants.session.length,
        lifetime === "session" ? 1 : 0,
      );
      assert.equal(
        status.toolGrants.remembered.length,
        lifetime === "remember" ? 1 : 0,
      );
    } finally {
      await c.close();
    }
    const loaded = await client(cwd, () => "once", [], c.id);
    try {
      await invoke(loaded, [
        call("write_file", { path: "a.txt", before: "two", after: "three" }),
      ]);
      assert.equal(
        loaded.approvals.filter(isTool).length,
        lifetime === "remember" ? 0 : 1,
      );
      // Workspace activation is still required, even with a remembered tool grant.
      assert(loaded.approvals.some((p) => !isTool(p)));
      await loaded.prompt("/permissions revoke-tools");
      await invoke(loaded, [
        call("write_file", { path: "a.txt", before: "three", after: "four" }),
      ]);
      assert.equal(
        loaded.approvals.filter(isTool).length,
        lifetime === "remember" ? 1 : 2,
      );
    } finally {
      await loaded.close();
    }
  });
}

async function setSandbox(c, value) {
  return c.c.agent.request("session/set_config_option", {
    sessionId: c.id,
    configId: "sandbox",
    value,
  });
}
test("sandbox selector and slash fallback preserve read-only but reset unsandboxed mode on restore and revocation", async () => {
  for (const mode of ["workspace", "read_only", "full_access"]) {
    const cwd = await workspace(),
      c = await client(cwd);
    await c.prompt(`/permissions sandbox ${mode}`);
    assert.equal((await status(c)).commandSandbox, mode);
    await assert.rejects(setSandbox(c, "invented"));
    const r = await setSandbox(c, mode);
    assert.equal(
      r.configOptions.find((o) => o.id === "sandbox").currentValue,
      mode,
    );
    await c.close();
    const restored = await client(cwd, () => "once", [], c.id);
    assert.equal(
      (await status(restored)).commandSandbox,
      mode === "full_access" ? "workspace" : mode,
    );
    await setSandbox(restored, "full_access");
    await restored.prompt("/permissions revoke-tools");
    assert.equal((await status(restored)).commandSandbox, "workspace");
    await restored.close();
  }
});
test("filesystem read-only overrides automatic edits; sandbox changes do not reuse command grants", async () => {
  const cwd = await workspace(),
    c = await client(cwd, (p) => (isTool(p) ? "remember" : "once"));
  try {
    await invoke(c, [call("run_command", { executable: "ls", args: [] })]);
    await setSandbox(c, "read_only");
    await invoke(c, [call("run_command", { executable: "ls", args: [] })]);
    assert.equal(c.approvals.filter(isTool).length, 2);
    await setMode(c, "edits");
    await invoke(c, [
      call("write_file", { path: "a.txt", before: "old", after: "bad" }),
    ]);
    assert.equal(await readFile(join(cwd, "a.txt"), "utf8"), "old");
  } finally {
    await c.close();
  }
});
test("scope expansion and unsandboxed requests cannot reuse grants or forge remembered approval", async () => {
  const cwd = await workspace(),
    outside = await workspace();
  const c = await client(cwd, (p) => (isTool(p) ? "remember" : "once"));
  try {
    await setMode(c, "development");
    await invoke(c, [
      call("run_command", {
        executable: "ls",
        args: [],
        additional_read_paths: [outside],
        justification: "Read the explicitly named fixture",
      }),
    ]);
    assert.equal(c.executed.length, 0);
    assert.deepEqual(
      c.approvals
        .filter(isTool)
        .at(-1)
        .options.map((o) => o.optionId),
      ["once", "deny"],
    );
    await invoke(c, [
      call("run_command", {
        executable: "ls",
        args: [],
        sandbox_permissions: "require_escalated",
        justification: "Fixture escape request",
      }),
    ]);
    assert.equal(c.executed.length, 0);
    assert.match(
      c.approvals.filter(isTool).at(-1).toolCall.title,
      /UNSANDBOXED/,
    );
    await setSandbox(c, "full_access");
    await invoke(c, [call("run_command", { executable: "ls", args: [] })]);
    assert.deepEqual(
      c.approvals
        .filter(isTool)
        .at(-1)
        .options.map((o) => o.optionId),
      ["once", "deny"],
    );
    assert.equal(c.executed.length, 0);
  } finally {
    await c.close();
  }
});
test("network permissions precede access, session grants are exact-host/port scoped and cancellation ignores late answers", async () => {
  let host = "example.test",
    port = 443,
    pendingReply,
    requested;
  const ready = new Promise((r) => {
    requested = r;
  });
  const c = await client(
    await workspace(),
    (p) => {
      if (!p.toolCall.title.startsWith("Allow sandbox network")) return "once";
      if (host === "cancel.test")
        return new Promise((r) => {
          pendingReply = r;
          requested();
        });
      return "session";
    },
    [],
    undefined,
    0,
    async (run, signal) => {
      const allowed = await run.network({ host, port }, signal);
      if (!allowed) throw new Error("Network denied");
    },
  );
  try {
    await setMode(c, "development");
    for (let i = 0; i < 2; i++)
      await invoke(c, [
        call("run_command", { executable: "gh", args: ["pr", "list"] }),
      ]);
    assert.equal(c.approvals.filter(isTool).length, 1);
    port = 8443;
    await invoke(c, [
      call("run_command", { executable: "gh", args: ["pr", "list"] }),
    ]);
    assert.equal(c.approvals.filter(isTool).length, 2);
    host = "cancel.test";
    const turn = invoke(c, [
      call("run_command", { executable: "gh", args: ["pr", "list"] }),
    ]);
    await ready;
    await c.c.agent.notify("session/cancel", { sessionId: c.id });
    pendingReply("remember");
    assert.equal((await turn).stopReason, "cancelled");
    assert.equal(c.executed.length, 3);
    assert.equal((await status(c)).toolGrants.remembered.length, 0);
  } finally {
    await c.close();
  }
});

test("remembered edits still reject stale content and paths outside the workspace", async () => {
  const cwd = await workspace(),
    c = await client(cwd, (p) => (isTool(p) ? "remember" : "once"));
  try {
    await invoke(c, [
      call("write_file", { path: "a.txt", before: "old", after: "one" }),
    ]);
    await writeFile(join(cwd, "a.txt"), "user edit");
    await invoke(c, [
      call("write_file", { path: "a.txt", before: "one", after: "bad" }),
      call("write_file", {
        path: "../outside.txt",
        before: null,
        after: "bad",
      }),
    ]);
    assert.equal(await readFile(join(cwd, "a.txt"), "utf8"), "user edit");
    assert.equal(c.updates.filter((u) => u.status === "failed").length, 2);
    assert.equal(c.approvals.filter(isTool).length, 1);
    await assert.rejects(readFile(join(cwd, "..", "outside.txt")));
  } finally {
    await c.close();
  }
});

test("exact command reuse skips only matching argv; high-risk commands cannot acquire grants", async () => {
  const cwd = await workspace(),
    c = await client(cwd, (p) =>
      isTool(p) && p.options.some((o) => o.optionId === "session")
        ? "session"
        : "once",
    );
  try {
    for (const args of [
      ["status"],
      ["status"],
      ["status", "--short"],
      ["push"],
      ["push"],
    ])
      await invoke(c, [call("run_command", { executable: "git", args })]);
    assert.equal(c.executed.length, 5);
    const a = c.approvals.filter(isTool);
    assert.equal(a.length, 4);
    assert(
      a
        .slice(-2)
        .every((p) => p.options.every((o) => o.kind !== "allow_always")),
    );
  } finally {
    await c.close();
  }
});

test("MCP connection and tool grants are separate and survive namespace index changes safely", async () => {
  const cwd = await workspace();
  const server = {
    name: "fixture",
    command: process.execPath,
    args: [resolve("test/fixtures/mcp.mjs")],
    env: [],
  };
  const c = await client(cwd, (p) => (isTool(p) ? "remember" : "once"), [
    server,
  ]);
  try {
    await invoke(c, [call("mcp_0_0", { query: "one" })]);
    await invoke(c, [call("mcp_0_0", { query: "two" })]);
    assert.equal(c.approvals.filter(isTool).length, 2);
    assert(
      c.updates.some((u) => JSON.stringify(u).includes("fixture result two")),
    );
  } finally {
    await c.close();
  }
  const d = await client(cwd, () => "once", [
    { ...server, name: "other" },
    server,
  ]);
  try {
    await invoke(d, [
      call("mcp_0_0", { query: "new" }),
      call("mcp_1_0", { query: "old" }),
    ]);
    assert.equal(d.approvals.filter(isTool).length, 2); // New server and new tool only.
    assert(
      d.approvals
        .filter(isTool)
        .every((p) => p.toolCall.title.includes("other")),
    );
  } finally {
    await d.close();
  }
});

for (const outcome of ["deny", "invalid", "cancel", "revoke"]) {
  test(`pending tool approval: ${outcome} causes no write or remembered grant`, async () => {
    const cwd = await workspace();
    let release, enter;
    const entered = new Promise((r) => {
      enter = r;
    });
    const c = await client(cwd, async (p) => {
      if (!isTool(p)) return "once";
      if (["deny", "invalid"].includes(outcome)) return outcome;
      enter();
      return new Promise((r) => {
        release = r;
      });
    });
    try {
      const turn = invoke(c, [
        call("write_file", { path: "a.txt", before: "old", after: "bad" }),
      ]);
      if (["cancel", "revoke"].includes(outcome)) {
        await entered;
        if (outcome === "cancel")
          await c.c.agent.notify("session/cancel", { sessionId: c.id });
        else {
          const other = await client(cwd);
          try {
            await other.prompt("/permissions revoke-tools");
          } finally {
            await other.close();
          }
        }
        release("remember");
      }
      await turn;
      assert.equal(await readFile(join(cwd, "a.txt"), "utf8"), "old");
      await c.prompt("/permissions");
      const status = JSON.parse(c.updates.at(-1).content.text);
      assert.deepEqual(status.toolGrants, { session: [], remembered: [] });
    } finally {
      await c.close();
    }
  });
}

for (const [executable, args] of [
  ["ls", ["-la"]],
  ["find", [".", "-type", "f"]],
  ["rg", ["TODO", "."]],
  ["/bin/bash", ["-lc", "ls -la"]],
  ["/bin/bash", ["-lc", "find . -name '*.ts' | head -20"]],
]) {
  test(`run_command approval choices and lifecycle: ${executable} ${args[0]}`, async () => {
    const cwd = await workspace();
    const c = await client(cwd, (p) => (isTool(p) ? "session" : "once"));
    try {
      const first = call("run_command", { executable, args });
      await invoke(c, [first]);
      await invoke(c, [call("run_command", { executable, args })]);
      const approvals = c.approvals.filter(isTool);
      assert.equal(approvals.length, 1);
      assert.deepEqual(
        approvals[0].options.map((o) => o.optionId),
        ["once", "session", "remember", "deny"],
      );
      assert.equal(approvals[0].toolCall.toolCallId, first.id);
      assert.deepEqual(approvals[0].toolCall.rawInput, {
        executable,
        args,
        cwd,
      });
      const events = c.updates.filter((u) => u.toolCallId === first.id);
      assert.equal(
        events.filter((u) => u.sessionUpdate === "tool_call").length,
        1,
      );
      assert.deepEqual(
        events.filter((u) => u.status).map((u) => u.status),
        ["pending", "pending", "in_progress", "completed"],
      );
      assert.equal(c.executed.length, 2);
    } finally {
      await c.close();
    }
  });
}

test("once-only command explanations are visible and forged repeat approvals cannot start a terminal", async () => {
  const cwd = await workspace();
  const c = await client(cwd, (p) => (isTool(p) ? "session" : "once"));
  try {
    const operation = call("run_command", {
      executable: "git",
      args: ["push"],
    });
    await invoke(c, [operation]);
    const approval = c.approvals.find(isTool);
    assert.match(
      approval.toolCall.content[0].content.text,
      /Approval is required each time/,
    );
    assert.deepEqual(
      approval.options.map((o) => o.optionId),
      ["once", "deny"],
    );
    assert.equal(c.executed.length, 0);
    const events = c.updates.filter((u) => u.toolCallId === operation.id);
    assert.equal(events.filter((u) => u.status === "failed").length, 1);
    assert(!events.some((u) => u.status === "completed"));
  } finally {
    await c.close();
  }
});

test("nonzero command exit produces a failed lifecycle with output retained", async () => {
  const cwd = await workspace(),
    c = await client(cwd, () => "once", [], undefined, 7);
  try {
    const operation = call("run_command", { executable: "ls", args: [] });
    await invoke(c, [operation]);
    const event = c.updates.filter((u) => u.toolCallId === operation.id).at(-1);
    assert.equal(event.status, "failed");
    assert.match(event.content[0].content.text, /"code":7/);
    assert.match(event.content[0].content.text, /"output":"ok"/);
  } finally {
    await c.close();
  }
});

async function setMode(c, value) {
  return c.c.agent.request("session/set_config_option", {
    sessionId: c.id,
    configId: "permissions",
    value,
  });
}
async function status(c) {
  await c.prompt("/permissions");
  return JSON.parse(c.updates.at(-1).content.text);
}

test("Permissions selector exposes five modes and rejects invalid values without inference", async () => {
  const c = await client(await workspace());
  try {
    const before = requests.length;
    const result = await setMode(c, "ask");
    const option = result.configOptions.find((o) => o.id === "permissions");
    assert.equal(option.category, "mode");
    assert.equal(option.currentValue, "ask");
    assert.deepEqual(
      option.options.map((o) => o.value),
      ["read_only", "ask", "scoped", "edits", "development"],
    );
    await assert.rejects(setMode(c, "full_access"));
    assert.equal((await status(c)).permissionMode, "ask");
    assert.equal(requests.length, before);
  } finally {
    await c.close();
  }
});

test("Ask each time ignores existing grants and exposes no reusable options", async () => {
  const c = await client(await workspace(), (p) =>
    isTool(p) && p.options.some((o) => o.optionId === "remember")
      ? "remember"
      : "once",
  );
  try {
    await invoke(c, [
      call("run_command", { executable: "gh", args: ["pr", "list"] }),
    ]);
    await setMode(c, "ask");
    await invoke(c, [
      call("run_command", { executable: "gh", args: ["pr", "list"] }),
    ]);
    await invoke(c, [
      call("run_command", { executable: "gh", args: ["pr", "list"] }),
    ]);
    assert.equal(c.approvals.filter(isTool).length, 3);
    assert(
      c.approvals
        .filter(isTool)
        .slice(1)
        .every((p) => p.options.length === 2),
    );
    await setMode(c, "scoped");
    await invoke(c, [
      call("run_command", { executable: "gh", args: ["pr", "list"] }),
    ]);
    assert.equal(c.approvals.filter(isTool).length, 3);
  } finally {
    await c.close();
  }
});

test("Development mode approves different eligible commands and edits, but still asks for mutations", async () => {
  const cwd = await workspace(),
    c = await client(cwd);
  try {
    await setMode(c, "development");
    await invoke(c, [
      call("run_command", { executable: "gh", args: ["pr", "list"] }),
      call("run_command", { executable: "gh", args: ["issue", "list"] }),
      call("write_file", { path: "a.txt", before: "old", after: "new" }),
    ]);
    assert.equal(c.approvals.filter(isTool).length, 0);
    assert.equal(c.approvals.filter((p) => !isTool(p)).length, 1); // Workspace activation still required.
    assert.equal(c.executed.length, 2);
    assert.equal(await readFile(join(cwd, "a.txt"), "utf8"), "new");
    await invoke(c, [
      call("run_command", { executable: "gh", args: ["pr", "merge", "12"] }),
    ]);
    assert.equal(c.approvals.filter(isTool).length, 1);
    assert(
      c.approvals
        .filter(isTool)[0]
        .options.every((o) => o.kind !== "allow_always"),
    );
    const s = await status(c);
    assert.equal(s.permissionMode, "development");
    assert.equal(s.commandSandbox, "workspace");
    assert.deepEqual(s.toolGrants, { session: [], remembered: [] });
  } finally {
    await c.close();
  }
});

test("Automatic edit mode leaves commands under scoped approval", async () => {
  const cwd = await workspace(),
    c = await client(cwd);
  try {
    await setMode(c, "edits");
    await invoke(c, [
      call("write_file", { path: "a.txt", before: "old", after: "new" }),
      call("run_command", { executable: "gh", args: ["pr", "list"] }),
    ]);
    assert.equal(c.approvals.filter(isTool).length, 1);
    assert.match(c.approvals.filter(isTool)[0].toolCall.title, /Run gh/);
    assert.equal(await readFile(join(cwd, "a.txt"), "utf8"), "new");
  } finally {
    await c.close();
  }
});

test("Read-only mode blocks writes, commands and MCP startup even with remembered tool grants", async () => {
  const cwd = await workspace(),
    c = await client(cwd, (p) => (isTool(p) ? "remember" : "once"));
  try {
    await invoke(c, [
      call("write_file", { path: "a.txt", before: "old", after: "new" }),
    ]);
    await setMode(c, "read_only");
    await invoke(c, [
      call("write_file", { path: "a.txt", before: "new", after: "bad" }),
      call("run_command", { executable: "ls", args: [] }),
    ]);
    assert.equal(await readFile(join(cwd, "a.txt"), "utf8"), "new");
    assert.equal(c.executed.length, 0);
    assert.deepEqual(
      requests.at(-1).tools.map((t) => t.function.name),
      ["list_files", "read_file", "search_text"],
    );
  } finally {
    await c.close();
  }
  const d = await client(
    cwd,
    (p) => {
      if (isTool(p)) throw new Error("No MCP startup allowed");
      return "once";
    },
    [{ name: "blocked", command: "must-not-start", args: [], env: [] }],
  );
  try {
    await setMode(d, "read_only");
    const before = requests.length;
    await invoke(d, [call("mcp_0_0", { query: "must not execute" })]);
    assert(requests.length > before);
    assert.equal(d.approvals.filter(isTool).length, 0);
    assert.deepEqual((await status(d)).tools, [
      "list_files",
      "read_file",
      "search_text",
    ]);
  } finally {
    await d.close();
  }
});

test("Session automatic modes reset on restore; restrictive modes persist; sessions remain isolated", async () => {
  for (const mode of ["development", "edits", "ask", "read_only"]) {
    const cwd = await workspace(),
      c = await client(cwd);
    await setMode(c, mode);
    const d = await client(cwd);
    try {
      assert.equal((await status(d)).permissionMode, "scoped");
    } finally {
      await d.close();
    }
    await c.close();
    const restored = await client(cwd, () => "once", [], c.id);
    try {
      assert.equal(
        (await status(restored)).permissionMode,
        ["development", "edits"].includes(mode) ? "scoped" : mode,
      );
    } finally {
      await restored.close();
    }
  }
});

test("Revocation resets automatic modes across sessions; slash fallback updates the selector", async () => {
  const cwd = await workspace(),
    a = await client(cwd),
    b = await client(cwd);
  try {
    await a.prompt("/permissions mode development");
    assert(
      a.updates.some(
        (u) =>
          u.sessionUpdate === "config_option_update" &&
          u.configOptions.find((o) => o.id === "permissions")?.currentValue ===
            "development",
      ),
    );
    await b.prompt("/permissions revoke-tools");
    await invoke(a, [
      call("run_command", { executable: "gh", args: ["pr", "list"] }),
    ]);
    assert.equal(a.approvals.filter(isTool).length, 1);
    assert.equal((await status(a)).permissionMode, "scoped");
  } finally {
    await a.close();
    await b.close();
  }
});

test("Permission selector cannot change policy while a tool approval is pending", async () => {
  let entered, release;
  const ready = new Promise((r) => {
    entered = r;
  });
  const c = await client(await workspace(), (p) => {
    if (!isTool(p)) return "once";
    entered();
    return new Promise((r) => {
      release = r;
    });
  });
  let turn;
  try {
    turn = invoke(c, [
      call("run_command", { executable: "gh", args: ["pr", "list"] }),
    ]);
    await ready;
    await assert.rejects(setMode(c, "development"), /Turn in progress/);
    release("once");
    await turn;
    assert.equal((await status(c)).permissionMode, "scoped");
  } finally {
    release?.("once");
    await turn?.catch(() => {});
    await c.close();
  }
});

test("administrator rules hide denied modes and deny escalation despite a forged approval", async () => {
  const p = snapshotPolicy({
    version: 1,
    sandboxModes: ["workspace"],
    permissionModes: ["scoped", "ask"],
    allowScopeExpansion: false,
  });
  const c = await client(
    await workspace(),
    () => "once",
    [],
    undefined,
    0,
    undefined,
    { loadPolicy: async () => p },
  );
  try {
    await assert.rejects(
      c.c.agent.request("session/set_config_option", {
        sessionId: c.id,
        configId: "sandbox",
        value: "full_access",
      }),
      /Administrator policy denies/,
    );
    await assert.rejects(
      c.c.agent.request("session/set_config_option", {
        sessionId: c.id,
        configId: "permissions",
        value: "development",
      }),
    );
    await invoke(c, [
      call("run_command", {
        executable: "ls",
        args: [],
        sandbox_permissions: "require_escalated",
        justification: "please",
      }),
    ]);
    assert.equal(c.executed.length, 0);
    assert.equal(c.approvals.filter(isTool).length, 0);
    assert(
      c.updates.some((u) =>
        JSON.stringify(u).includes("Administrator policy denies"),
      ),
    );
  } finally {
    await c.close();
  }
});

test("administrator alwaysAsk defeats development mode and remembered command grants", async () => {
  const p = snapshotPolicy({ version: 1, alwaysAsk: ["command"] });
  const c = await client(
    await workspace(),
    () => "once",
    [],
    undefined,
    0,
    undefined,
    { loadPolicy: async () => p },
  );
  try {
    await c.prompt("/permissions mode development");
    await invoke(c, [call("run_command", { executable: "ls", args: [] })]);
    await invoke(c, [call("run_command", { executable: "ls", args: [] })]);
    const prompts = c.approvals.filter(isTool);
    assert.equal(prompts.length, 2);
    assert(
      prompts.every(
        (p) => p.options.filter((o) => o.kind.startsWith("allow")).length === 1,
      ),
    );
  } finally {
    await c.close();
  }
});

test("changed administrator policy invalidates pending approvals and stops subsequent execution", async () => {
  let p = snapshotPolicy();
  const c = await client(
    await workspace(),
    (request) => {
      if (isTool(request))
        p = snapshotPolicy({ version: 1, alwaysAsk: ["command"] });
      return "once";
    },
    [],
    undefined,
    0,
    undefined,
    { loadPolicy: async () => p },
  );
  try {
    await invoke(c, [call("run_command", { executable: "ls", args: [] })]);
    assert.equal(c.executed.length, 0);
    assert(
      c.updates.some((u) =>
        JSON.stringify(u).includes("Administrator policy changed"),
      ),
    );
  } finally {
    await c.close();
  }
});

test("administrator denies MCP before startup and sandbox network before ACP approval", async () => {
  const p = snapshotPolicy({
    version: 1,
    allowStdioMcp: false,
    networkDestinations: [],
  });
  let networkAllowed;
  const c = await client(
    await workspace(),
    () => "once",
    [],
    undefined,
    0,
    async (run, s) => {
      networkAllowed = await run.network({ host: "example.com", port: 443 }, s);
    },
    { loadPolicy: async () => p },
  );
  try {
    await invoke(c, [call("run_command", { executable: "ls", args: [] })]);
    assert.equal(networkAllowed, false);
    assert(
      !c.approvals.some((p) => p.toolCall.title.includes("network connection")),
    );
  } finally {
    await c.close();
  }
  const other = await client(
    await workspace(),
    () => "once",
    [{ name: "blocked", command: "/usr/bin/true", args: [], env: [] }],
    undefined,
    0,
    undefined,
    { loadPolicy: async () => p },
  );
  try {
    await invoke(other, []);
    assert(!other.approvals.some((p) => p.toolCall.title.startsWith("MCP")));
    assert(
      other.updates.some((u) => JSON.stringify(u).includes("denies stdio MCP")),
    );
  } finally {
    await other.close();
  }
});

test("advisory approve still needs human consent, ignores automatic grants and resets on restore", async () => {
  let reviewed = 0;
  const c = await client(
    await workspace(),
    (p) => (isTool(p) ? "deny" : "once"),
    [],
    undefined,
    0,
    undefined,
    {
      reviewOperation: async () => {
        reviewed++;
        return { decision: "approve", reason: "Fixture advice" };
      },
    },
  );
  let savedRoot;
  try {
    await c.prompt("/permissions mode development");
    await c.prompt("/reviewer fixture");
    await invoke(c, [call("run_command", { executable: "ls", args: [] })]);
    assert.equal(reviewed, 1);
    assert.equal(c.executed.length, 0);
    const approval = c.approvals.find(isTool);
    assert(
      JSON.stringify(approval.toolCall.content).includes("Advisory review"),
    );
    assert.equal(approval.options.length, 2);
    const saved = JSON.parse(
      await readFile(join(temp, "state", `session-${c.id}.json`), "utf8"),
    );
    savedRoot = saved.root;
    assert(!JSON.stringify(saved).includes("Fixture advice"));
  } finally {
    await c.close();
  }
  const restored = await client(savedRoot, () => "once", [], c.id);
  try {
    await restored.prompt("/status");
    assert(
      restored.updates.some((u) =>
        u.content?.text?.includes('"approvalReviewer":"off"'),
      ),
    );
  } finally {
    await restored.close();
  }
});

test("policy monitoring cancels an active owned runner when administrator rules change", async () => {
  let p = snapshotPolicy();
  let aborted = false;
  const c = await client(
    await workspace(),
    () => "once",
    [],
    undefined,
    0,
    async (_run, signal) => {
      p = snapshotPolicy({ version: 1, alwaysAsk: ["command"] });
      await new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("Policy watcher did not cancel")),
          2000,
        );
        signal.addEventListener(
          "abort",
          () => {
            aborted = true;
            clearTimeout(timer);
            resolve();
          },
          { once: true },
        );
      });
      signal.throwIfAborted();
    },
    { loadPolicy: async () => p },
  );
  try {
    const result = await invoke(c, [
      call("run_command", { executable: "ls", args: [] }),
    ]);
    assert.equal(result.stopReason, "cancelled");
    assert.equal(aborted, true);
    assert.equal(c.executed.length, 0);
  } finally {
    await c.close();
  }
});
