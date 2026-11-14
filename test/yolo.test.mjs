import test from "node:test";
import assert from "node:assert/strict";
import "./fixtures/keyring.mjs";
import { createServer } from "node:http";
import {
  mkdtemp,
  realpath,
  writeFile,
  readFile,
  access,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { ClientApp } from "@agentclientprotocol/sdk";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

const temporary = await realpath(await mkdtemp(join(tmpdir(), "ow-yolo-")));
process.env.OPENWEBUI_ACP_HOME = join(temporary, "state");
process.env.OPENWEBUI_API_KEY = "synthetic-yolo-key";
const { createAgent } = await import("../dist/agent.js");
const { configSchema, writeJson, directory } =
  await import("../dist/config.js");
const { snapshotPolicy } = await import("../dist/policy.js");
const { forkStoredSession } = await import("../dist/session-store.js");
assert.equal(directory, process.env.OPENWEBUI_ACP_HOME);
let rounds = [],
  requests = [];
const server = createServer(async (req, res) => {
  res.setHeader("Content-Type", "application/json");
  if (req.url === "/api/models")
    return res.end(JSON.stringify({ data: [{ id: "fixture" }] }));
  let body = "";
  for await (const c of req) body += c;
  requests.push(JSON.parse(body));
  const tools = rounds.shift();
  res.end(
    JSON.stringify({
      choices: [
        {
          message: tools
            ? { role: "assistant", content: null, tool_calls: tools }
            : { role: "assistant", content: "done" },
          finish_reason: tools ? "tool_calls" : "stop",
        },
      ],
    }),
  );
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const url = `http://127.0.0.1:${server.address().port}`;
test.after(() => new Promise((r) => server.close(r)));
test.beforeEach(async () => {
  process.env.OPENWEBUI_API_KEY = "synthetic-yolo-key";
  rounds = [];
  requests = [];
  await writeJson("auth-state.json", null);
  await writeJson("mcp.json", []);
  await writeJson("config.json", configSchema.parse({ url, model: "fixture" }));
});
const isYolo = (p) => p.toolCall.title.startsWith("Enable YOLO");
const chooseYolo = (p) => (isYolo(p) ? "enable-yolo" : "once");
const call = (name, args, id = name) => ({
  id,
  type: "function",
  function: { name, arguments: JSON.stringify(args) },
});
const run = (code, extra = {}) =>
  call("run_command", {
    executable: process.execPath,
    args: ["-e", code],
    ...extra,
  });
async function waitFor(predicate) {
  const deadline = Date.now() + 5000;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw Error("Fixture wait timed out");
    await delay(10);
  }
}
async function client({
  choose = chooseYolo,
  cwd,
  mcp = [],
  load,
  policy = snapshotPolicy(),
  readTextFile,
} = {}) {
  cwd ??= await realpath(await mkdtemp(join(temporary, "project-")));
  const agent = createAgent({
    loadPolicy: async () => (typeof policy === "function" ? policy() : policy),
  });
  const app = new ClientApp(),
    approvals = [],
    updates = [];
  app.onNotification("session/update", ({ params }) =>
    updates.push(params.update),
  );
  app.onRequest("session/request_permission", async ({ params }) => {
    approvals.push(params);
    const answer = await choose(params);
    return typeof answer === "string"
      ? { outcome: { outcome: "selected", optionId: answer } }
      : answer;
  });
  if (readTextFile) app.onRequest("fs/read_text_file", readTextFile);
  const connection = app.connect(agent.app);
  await connection.agent.request("initialize", {
    protocolVersion: 1,
    clientCapabilities: readTextFile ? { fs: { readTextFile: true } } : {},
  });
  const initial = await connection.agent.request(
    load ? "session/load" : "session/new",
    { cwd, mcpServers: mcp, ...(load ? { sessionId: load } : {}) },
  );
  const id = load ?? initial.sessionId;
  return {
    cwd,
    id,
    initial,
    approvals,
    updates,
    state: () => agent.sessions.get(id),
    prompt: (text) =>
      connection.agent.request("session/prompt", {
        sessionId: id,
        prompt: [{ type: "text", text }],
      }),
    set: (configId, value) =>
      connection.agent.request("session/set_config_option", {
        sessionId: id,
        configId,
        value,
      }),
    cancel: () => connection.agent.notify("session/cancel", { sessionId: id }),
    close: async () => {
      connection.close();
      await agent.close();
    },
  };
}
async function invoke(c, calls = []) {
  rounds = [calls.length ? calls : undefined, undefined];
  return c.prompt("perform fixture task");
}
async function enabled(c) {
  await c.set("permissions", "yolo");
  await invoke(c);
}

test("YOLO selector defers consent until a workspace prompt, then skips arbitrary command/edit approvals across turns", async () => {
  const c = await client();
  const outside = join(temporary, "outside-" + c.id + ".txt");
  try {
    await writeFile(join(c.cwd, "a.txt"), "old");
    await c.prompt("/permissions mode yolo");
    assert.equal(c.approvals.length, 0);
    assert.equal(requests.length, 0);
    assert.equal(c.state().sandbox, "workspace");
    await invoke(c, [
      call("write_file", { path: "a.txt", before: "old", after: "new" }),
      run(
        `require('node:fs').writeFileSync(${JSON.stringify(outside)}, 'explicit full-access fixture')`,
      ),
    ]);
    assert.equal(
      await readFile(outside, "utf8"),
      "explicit full-access fixture",
    );
    assert.equal(await readFile(join(c.cwd, "a.txt"), "utf8"), "new");
    assert.equal(c.approvals.length, 2); // workspace and one YOLO decision only
    assert.match(c.approvals[0].toolCall.title, /Activate exact workspace/);
    assert.match(
      c.approvals[1].toolCall.title,
      /UNSANDBOXED.*destructive.*not remembered/,
    );
    assert.deepEqual(
      c.approvals[1].options.map((o) => o.optionId),
      ["enable-yolo", "deny"],
    );
    assert.equal(c.state().sandbox, "full_access");
    await invoke(c, [run("console.log('next turn')")]);
    assert.equal(c.approvals.length, 2);
    assert(
      c.updates.some(
        (u) => u.title?.startsWith("Run ") && u.status === "pending",
      ),
    );
    assert.deepEqual(await c.state().permissions.inspect(), {
      session: [],
      remembered: [],
    });
  } finally {
    await c.close();
  }
});

for (const answer of [
  "deny",
  "remember",
  { outcome: { outcome: "cancelled" } },
]) {
  test(`YOLO ${JSON.stringify(answer)} cannot transmit project context, run tools or enable full access`, async () => {
    let reads = 0;
    const c = await client({
      choose: (p) => (isYolo(p) ? answer : "once"),
      readTextFile: () => {
        reads++;
        return { content: "must not read" };
      },
    });
    try {
      await writeFile(
        join(c.cwd, "AGENTS.md"),
        "Must remain local until confirmation",
      );
      await c.set("permissions", "yolo");
      await invoke(c, [run("throw Error('must not run')")]);
      assert(
        c.updates.some((u) => /Permission declined/.test(u.content?.text)),
      );
      assert.equal(reads, 0);
      assert.equal(requests.length, 0);
      assert.equal(c.state().permissions.currentMode, "scoped");
      assert.equal(c.state().sandbox, "workspace");
      assert.equal(c.state().yoloEpoch, undefined);
    } finally {
      await c.close();
    }
  });
}

test("Stop during YOLO confirmation ignores late approval and a replacement stays scoped", async () => {
  let release;
  const c = await client({
    choose: (p) => (isYolo(p) ? new Promise((r) => (release = r)) : "once"),
  });
  try {
    await c.set("permissions", "yolo");
    const first = invoke(c);
    await waitFor(() => release);
    await c.cancel();
    assert.equal((await first).stopReason, "cancelled");
    release("enable-yolo");
    await delay(20);
    assert.equal(c.state().permissions.currentMode, "scoped");
    assert.equal(c.state().sandbox, "workspace");
    assert.equal(requests.length, 0);
    await invoke(c, [
      call("write_file", { path: "a.txt", before: null, after: "new" }),
    ]);
    assert(c.approvals.some((p) => p.toolCall.title.startsWith("Write ")));
  } finally {
    release?.("deny");
    await c.close();
  }
});

test("YOLO is isolated, never saved or forked, and forged saved elevation resets on load", async () => {
  const c = await client();
  try {
    await enabled(c);
    const second = await client({ cwd: c.cwd });
    assert.equal(second.state().permissions.currentMode, "scoped");
    assert.equal(second.state().sandbox, "workspace");
    await second.close();
    const file = join(directory, `session-${c.id}.json`);
    const saved = JSON.parse(await readFile(file, "utf8"));
    assert.equal(saved.permissionMode, "scoped");
    assert.equal(saved.sandboxMode, "workspace");
    assert.equal(saved.yoloEpoch, undefined);
    const fork = await forkStoredSession(
      c.id,
      { url, cwd: c.cwd },
      { redact: (x) => x },
    );
    assert.equal(fork.record.permissionMode, "scoped");
    assert.equal(fork.record.sandboxMode, "workspace");
    await c.close();
    await writeJson(`session-${c.id}.json`, {
      ...saved,
      permissionMode: "yolo",
      sandboxMode: "full_access",
      yoloEpoch: "forged",
    });
    const restored = await client({ cwd: c.cwd, load: c.id });
    assert.equal(restored.state().permissions.currentMode, "scoped");
    assert.equal(restored.state().sandbox, "workspace");
    assert.equal(restored.state().yoloEpoch, undefined);
    await restored.close();
  } finally {
    await c.close();
  }
});

for (const change of [
  ["permissions", "ask"],
  ["sandbox", "workspace"],
  ["reviewer", "fixture"],
]) {
  test(`changing ${change[0]} exits YOLO and removes unsandboxed automatic access`, async () => {
    const c = await client();
    try {
      await enabled(c);
      await c.set(...change);
      assert.equal(
        c.state().permissions.currentMode,
        change[0] === "permissions" ? "ask" : "scoped",
      );
      assert.equal(c.state().sandbox, "workspace");
      assert.equal(c.state().yoloEpoch, undefined);
    } finally {
      await c.close();
    }
  });
}

test("administrator mode/sandbox/network restrictions hide and reject YOLO", async () => {
  for (const rules of [
    { permissionModes: ["scoped", "ask"] },
    { sandboxModes: ["workspace"] },
    { networkDestinations: [] },
  ]) {
    const c = await client({
      policy: snapshotPolicy({ version: 1, ...rules }),
    });
    try {
      assert(
        !c.initial.configOptions
          .find((o) => o.id === "permissions")
          .options.some((o) => o.value === "yolo"),
      );
      await assert.rejects(
        c.set("permissions", "yolo"),
        /Administrator policy denies/,
      );
      assert.equal(c.approvals.length, 0);
      assert.equal(c.state().sandbox, "workspace");
    } finally {
      await c.close();
    }
  }
});

test("administrator alwaysAsk still prompts for edits, undo and arbitrary commands in YOLO", async () => {
  const c = await client({
    policy: snapshotPolicy({ version: 1, alwaysAsk: ["command", "edit"] }),
  });
  try {
    await writeFile(join(c.cwd, "a.txt"), "old");
    await enabled(c);
    await invoke(c, [
      call("write_file", { path: "a.txt", before: "old", after: "new" }),
      run("console.log('fixture')"),
    ]);
    await c.prompt("/undo");
    assert.equal(c.approvals.length, 5);
    assert.equal(await readFile(join(c.cwd, "a.txt"), "utf8"), "old");
    assert(
      c.approvals.some((p) => p.toolCall.title.startsWith("Undo agent edit")),
    );
  } finally {
    await c.close();
  }
});

test("YOLO retains schema validation, stale-file checks, path boundaries and Plan enforcement", async () => {
  const c = await client();
  try {
    await writeFile(join(c.cwd, "a.txt"), "old");
    await enabled(c);
    await invoke(c, [
      call("write_file", { path: "a.txt", before: "wrong", after: "bad" }),
      call(
        "write_file",
        { path: "../escape.txt", before: null, after: "bad" },
        "escape",
      ),
      call("run_command", { executable: false }, "malformed"),
    ]);
    assert.equal(await readFile(join(c.cwd, "a.txt"), "utf8"), "old");
    assert(
      c
        .state()
        .messages.some(
          (m) => m.role === "tool" && /Stale edit/.test(m.content),
        ),
    );
    await c.set("workflow", "plan");
    await invoke(c, [run("throw Error('must not run')")]);
    assert(
      c
        .state()
        .messages.some(
          (m) => m.role === "tool" && /read-only mode/.test(m.content),
        ),
    );
    assert.equal(c.approvals.length, 2);
  } finally {
    await c.close();
  }
});

test("revocation stops an unsandboxed background job and removes YOLO across the workspace scope", async () => {
  const c = await client(),
    outside = join(temporary, "must-not-run-" + c.id);
  const other = await client({ cwd: c.cwd });
  try {
    await enabled(c);
    await invoke(c, [
      run(
        `console.log('ready');setTimeout(()=>require('node:fs').writeFileSync(${JSON.stringify(outside)},'bad'),2500);setInterval(()=>{},1000)`,
        { background: true, timeout_ms: 10000 },
      ),
    ]);
    assert.equal(c.state().jobs.hasRunning, true);
    const id = c.state().jobs.list()[0].id;
    await waitFor(() => c.state().jobs.poll(id).output.includes("ready"));
    await other.prompt("/permissions revoke-tools");
    await waitFor(() => !c.state().jobs.hasRunning);
    await c.prompt("/status");
    assert.equal(c.state().permissions.currentMode, "scoped");
    assert.equal(c.state().sandbox, "workspace");
    await assert.rejects(access(outside));
  } finally {
    await other.close();
    await c.close();
  }
});

test("YOLO approves configured stdio MCP startup and tools without expanding the catalog", async () => {
  const c = await client({
    mcp: [
      {
        name: "fixture",
        command: process.execPath,
        args: [resolve("test/fixtures/mcp.mjs")],
        env: [],
      },
    ],
  });
  try {
    await c.set("permissions", "yolo");
    await invoke(c, [
      call("mcp_0_0", { query: "first" }),
      call("mcp_0_0", { query: "second" }, "second"),
    ]);
    assert(
      c
        .state()
        .messages.some(
          (m) => m.role === "tool" && /fixture result first/.test(m.content),
        ),
    );
    assert.equal(c.approvals.length, 2);
  } finally {
    await c.close();
  }
});

test("local HTTP MCP per-call requirements yield to YOLO but administrator MCP approval still wins", async () => {
  let count = 0;
  const instances = [];
  const http = createServer(async (req, res) => {
    assert.equal(req.headers.authorization, undefined);
    const mcp = new McpServer({ name: "fixture", version: "1" });
    mcp.registerTool(
      "lookup",
      { inputSchema: { query: z.string() } },
      async ({ query }) => {
        count++;
        return { content: [{ type: "text", text: query }] };
      },
    );
    mcp.registerTool("unsafe", { inputSchema: {} }, async () => {
      assert.fail("YOLO must not expose excluded tools");
    });
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    instances.push(mcp);
    await mcp.connect(transport);
    let body = "";
    for await (const chunk of req) body += chunk;
    await transport.handleRequest(
      req,
      res,
      body ? JSON.parse(body) : undefined,
    );
  });
  await new Promise((r) => http.listen(0, "127.0.0.1", r));
  try {
    for (const ask of [false, true]) {
      await writeJson("mcp.json", [
        {
          type: "http",
          name: "fixture",
          url: `http://127.0.0.1:${http.address().port}/mcp`,
          options: { includeTools: ["lookup"], alwaysApproveTools: ["lookup"] },
        },
      ]);
      const c = await client({
        policy: snapshotPolicy({
          version: 1,
          ...(ask ? { alwaysAsk: ["mcp-tool"] } : {}),
        }),
      });
      try {
        await c.set("permissions", "yolo");
        await invoke(c, [
          call("mcp_0_0", { query: "one" }),
          call("mcp_0_0", { query: "two" }, "two"),
          call("mcp_0_1", {}, "excluded"),
        ]);
        assert.equal(c.approvals.length, ask ? 4 : 2);
        assert(
          c
            .state()
            .messages.some(
              (m) => m.role === "tool" && /Unknown tool/.test(m.content),
            ),
        );
      } finally {
        await c.close();
      }
    }
    assert.equal(count, 4);
  } finally {
    await Promise.all(instances.map((s) => s.close()));
    await new Promise((r) => http.close(r));
  }
});

for (const change of ["administrator", "revocation", "backend"]) {
  test(`${change} change during YOLO confirmation invalidates a late allow`, async () => {
    let release;
    let policy = snapshotPolicy();
    const c = await client({
      policy: () => policy,
      choose: (p) => (isYolo(p) ? new Promise((r) => (release = r)) : "once"),
    });
    try {
      await c.set("permissions", "yolo");
      const pending = invoke(c, [run("throw Error('must not run')")]);
      await waitFor(() => release);
      if (change === "administrator")
        policy = snapshotPolicy({ version: 1, sandboxModes: ["workspace"] });
      else if (change === "revocation") await c.state().permissions.revoke();
      else
        await writeJson(
          "config.json",
          configSchema.parse({ url: url + "/changed", model: "fixture" }),
        );
      release("enable-yolo");
      await pending;
      assert.equal(requests.length, 0);
      assert.equal(c.state().yoloEpoch, undefined);
      assert.equal(c.state().sandbox, "workspace");
    } finally {
      release?.("deny");
      await c.close();
    }
  });
}

test("automatic project checks use confirmed YOLO but plain full access still requires a sandbox", async () => {
  const cwd = await realpath(await mkdtemp(join(temporary, "checks-")));
  const checked = join(temporary, "check-result");
  await writeJson(
    "config.json",
    configSchema.parse({
      url,
      model: "fixture",
      verify: {
        projects: [
          {
            root: cwd,
            commands: [
              {
                executable: process.execPath,
                args: [
                  "-e",
                  `require('node:fs').writeFileSync(${JSON.stringify(checked)},'checked')`,
                ],
              },
            ],
          },
        ],
      },
    }),
  );
  const c = await client({ cwd });
  try {
    await c.set("sandbox", "full_access");
    await invoke(c, [
      call("write_file", { path: "a.txt", before: null, after: "first" }),
    ]);
    await assert.rejects(access(checked));
    assert(
      c.updates.some((u) => /Select an OS sandbox/.test(JSON.stringify(u))),
    );
    await c.set("permissions", "yolo");
    const before = c.approvals.length;
    await invoke(c, [
      call("write_file", { path: "a.txt", before: "first", after: "second" }),
    ]);
    assert.equal(await readFile(checked, "utf8"), "checked");
    assert.equal(c.approvals.length, before + 1);
  } finally {
    await c.close();
  }
});

test("Stop kills an owned foreground command in YOLO before a delayed side effect", async () => {
  const c = await client();
  const ready = join(temporary, "foreground-ready-" + c.id);
  const late = join(temporary, "foreground-late-" + c.id);
  try {
    await enabled(c);
    const pending = invoke(c, [
      run(
        `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(ready)},String(process.pid));setTimeout(()=>fs.writeFileSync(${JSON.stringify(late)},'bad'),10000);setInterval(()=>{},1000)`,
      ),
    ]);
    await waitFor(() =>
      access(ready).then(
        () => true,
        () => false,
      ),
    );
    const pid = Number(await readFile(ready, "utf8"));
    await c.cancel();
    assert.equal((await pending).stopReason, "cancelled");
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
    await assert.rejects(access(late));
    assert.equal(c.approvals.length, 2);
  } finally {
    await c.close();
  }
});

for (const action of ["logout", "disconnect"]) {
  test(`${action} clears confirmed YOLO state`, async () => {
    const c = await client();
    try {
      await enabled(c);
      assert(c.state().yoloEpoch);
      if (action === "logout") await c.prompt("/logout");
      else await c.close();
      assert.equal(c.state().yoloEpoch, undefined);
      assert.equal(c.state().permissions.currentMode, "scoped");
      assert.equal(c.state().sandbox, "workspace");
    } finally {
      await c.close();
    }
  });
}
