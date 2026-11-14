import test from "node:test";
import assert from "node:assert/strict";
import "./fixtures/keyring.mjs";
import { createServer } from "node:http";
import { mkdtemp, realpath } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { ClientApp } from "@agentclientprotocol/sdk";

const directory = await mkdtemp(join(tmpdir(), "ow-background-agent-"));
process.env.OPENWEBUI_ACP_HOME = join(directory, "state");
process.env.OPENWEBUI_API_KEY = "synthetic-background-credential";
const { createAgent } = await import("../dist/agent.js");
const { configSchema, writeJson } = await import("../dist/config.js");
const { changeTrust } = await import("../dist/workspace.js");
let pending = [];
const requests = [];
const server = createServer(async (req, res) => {
  res.setHeader("Content-Type", "application/json");
  if (req.url === "/api/models")
    return res.end(JSON.stringify({ data: [{ id: "fixture" }] }));
  let raw = "";
  for await (const chunk of req) raw += chunk;
  requests.push(JSON.parse(raw));
  const calls = pending.shift();
  res.end(
    JSON.stringify({
      choices: [
        {
          message: calls
            ? { role: "assistant", content: null, tool_calls: calls }
            : { role: "assistant", content: "done" },
          finish_reason: calls ? "tool_calls" : "stop",
        },
      ],
    }),
  );
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const url = `http://127.0.0.1:${server.address().port}`;
await writeJson("config.json", configSchema.parse({ url, model: "fixture" }));
test.after(() => new Promise((resolve) => server.close(resolve)));
test.beforeEach(() => {
  pending = [];
  requests.length = 0;
});

async function waitFor(predicate) {
  const end = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() > end) throw new Error("Background fixture timed out");
    await delay(10);
  }
}
const call = (background = true, id = "background-call") => ({
  id,
  type: "function",
  function: {
    name: "run_command",
    arguments: JSON.stringify({
      executable: "ls",
      args: [],
      background,
      timeout_ms: 5000,
    }),
  },
});
const result = (output, aborted = false) =>
  JSON.stringify({
    code: aborted ? 143 : 0,
    output,
    limitedOrCancelled: aborted,
  });
async function client({ runner, choose = () => "once", cwd, load } = {}) {
  cwd ??= await realpath(await mkdtemp(join(directory, "workspace-")));
  const updates = [],
    approvals = [],
    executed = [];
  const agent = createAgent({
    sandboxCommand: async (executable, args, run, signal, limits, onOutput) => {
      const execution = { executable, args, run, signal, limits };
      executed.push(execution);
      if (runner) return runner(execution, onOutput);
      await onOutput?.("ready\n");
      if (!signal.aborted)
        await new Promise((resolve) =>
          signal.addEventListener("abort", resolve, { once: true }),
        );
      return result("ready\nstopped", true);
    },
  });
  const app = new ClientApp()
    .onNotification("session/update", ({ params }) =>
      updates.push(params.update),
    )
    .onRequest("session/request_permission", ({ params }) => {
      approvals.push(params);
      return { outcome: { outcome: "selected", optionId: choose(params) } };
    });
  const connection = app.connect(agent.app);
  await connection.agent.request("initialize", { protocolVersion: 1 });
  const response = await connection.agent.request(
    load ? "session/load" : "session/new",
    { cwd, mcpServers: [], ...(load ? { sessionId: load } : {}) },
  );
  const id = load ?? response.sessionId;
  return {
    agent,
    id,
    cwd,
    connection,
    updates,
    approvals,
    executed,
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
async function start(c, id = "background-call") {
  pending = [[call(true, id)]];
  assert.equal(
    (await c.prompt("Start the requested background task")).stopReason,
    "end_turn",
  );
  await waitFor(() => c.executed.length > 0);
  return c.state().jobs.list().at(-1);
}

test("background jobs survive normal turn completion and always ask once in development mode", async () => {
  const c = await client();
  try {
    await c.select("permissions", "development");
    const job = await start(c);
    assert.equal(c.state().jobs.poll(job.id).state, "running");
    assert.equal(c.executed[0].signal.aborted, false);
    const approval = c.approvals.find((p) =>
      p.toolCall.title.startsWith("Run "),
    );
    assert.deepEqual(
      approval.options.map((o) => o.optionId),
      ["once", "deny"],
    );
    assert.match(approval.toolCall.title, /background job.*timeout 5000 ms/);
    await c.prompt(`/jobs poll ${job.id}`);
    assert.equal(c.state().jobs.poll(job.id).state, "running");
    await c.prompt(`/jobs stop ${job.id}`);
    assert.equal(c.state().jobs.poll(job.id).state, "stopped");
    assert.equal(c.executed[0].signal.aborted, true);
  } finally {
    await c.close();
  }
});

test("invalid remembered approval cannot start a background process", async () => {
  const c = await client({
    choose: (p) => (p.toolCall.title.startsWith("Run ") ? "session" : "once"),
  });
  try {
    pending = [[call()]];
    await c.prompt("Start a task");
    assert.equal(c.executed.length, 0);
    assert.equal(c.state().jobs.list().length, 0);
  } finally {
    await c.close();
  }
});

test("foreground output streams before completion and does not leak split credentials", async () => {
  let finish;
  const gate = new Promise((resolve) => {
    finish = resolve;
  });
  const c = await client({
    runner: async (_execution, output) => {
      await output("ready synthetic-back");
      await output("ready synthetic-background-credential\n");
      await gate;
      return result("ready synthetic-background-credential\n");
    },
  });
  try {
    pending = [[call(false, "foreground")]];
    let done = false;
    const turn = c.prompt("Run a foreground command").then((r) => {
      done = true;
      return r;
    });
    await waitFor(() =>
      c.updates.some(
        (u) =>
          u.toolCallId === "foreground" &&
          JSON.stringify(u.content ?? []).includes("ready"),
      ),
    );
    assert.equal(done, false);
    assert(!JSON.stringify(c.updates).includes("synthetic-back"));
    finish();
    await turn;
    assert(!JSON.stringify(c.updates).includes("synthetic-back"));
    assert(JSON.stringify(c.updates).includes("[REDACTED]"));
  } finally {
    finish();
    await c.close();
  }
});

test("an immediately completed background job cannot be reset to in-progress", async () => {
  const c = await client({
    runner: async (_execution, output) => {
      await output("finished");
      return result("finished");
    },
  });
  try {
    const job = await start(c, "fast");
    await waitFor(() => c.state().jobs.poll(job.id).state === "completed");
    await delay(20);
    const events = c.updates.filter((u) => u.toolCallId === "fast");
    const finalIndex = events.findIndex((u) => u.status === "completed");
    assert(finalIndex >= 0);
    assert(
      events.slice(finalIndex + 1).every((u) => u.status !== "in_progress"),
    );
  } finally {
    await c.close();
  }
});

for (const operation of [
  "cancel",
  "revoke",
  "mode",
  "close",
  "external-trust",
]) {
  test(`${operation} stops running session jobs`, async () => {
    const c = await client();
    try {
      const job = await start(c);
      if (operation === "cancel")
        await c.connection.agent.notify("session/cancel", { sessionId: c.id });
      else if (operation === "revoke")
        await c.prompt("/permissions revoke-tools");
      else if (operation === "mode") await c.select("workflow", "plan");
      else if (operation === "external-trust")
        await changeTrust(c.cwd, url, false);
      else await c.agent.close();
      await waitFor(() => c.state().jobs.poll(job.id).state !== "running");
      assert(c.executed[0].signal.aborted);
    } finally {
      await c.close();
    }
  });
}

test("jobs are session-isolated and saved history never restarts a process", async () => {
  const a = await client(),
    b = await client();
  try {
    const job = await start(a);
    assert.throws(() => b.state().jobs.poll(job.id), /Unknown job/);
    assert.equal(b.executed.length, 0);
    await a.prompt(`/jobs stop ${job.id}`);
    const restored = await client({ cwd: a.cwd, load: a.id });
    try {
      assert.equal(restored.state().jobs.list().length, 0);
      assert.equal(restored.executed.length, 0);
    } finally {
      await restored.close();
    }
  } finally {
    await a.close();
    await b.close();
  }
});

test("logout stops jobs before clearing authentication", async () => {
  const c = await client();
  try {
    const job = await start(c);
    await c.prompt("/logout");
    assert(c.executed[0].signal.aborted);
    assert.equal(c.state().jobs.poll(job.id).state, "stopped");
  } finally {
    await c.close();
  }
});
