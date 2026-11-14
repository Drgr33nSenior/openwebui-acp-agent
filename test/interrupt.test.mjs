import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import {
  mkdtemp,
  realpath,
  readFile,
  writeFile,
  access,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { ClientApp } from "@agentclientprotocol/sdk";

const temporary = await mkdtemp(join(tmpdir(), "ow-interrupt-"));
process.env.OPENWEBUI_ACP_HOME = join(temporary, "state");
process.env.OPENWEBUI_API_KEY = "synthetic-interruption-credential";
const { createAgent } = await import("../dist/agent.js");
const { configSchema, writeJson, readJson } = await import("../dist/config.js");
const { command } = await import("../dist/commands.js");
const { contextMessages } = await import("../dist/compaction.js");

const requests = [];
let respond;
const server = createServer(async (req, res) => {
  if (req.url === "/api/models") {
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ data: [{ id: "fixture" }] }));
    return;
  }
  let body = "";
  for await (const chunk of req) body += chunk;
  const request = JSON.parse(body);
  requests.push(request);
  await respond(request, res);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const url = `http://127.0.0.1:${server.address().port}`;
await writeJson("config.json", configSchema.parse({ url, model: "fixture" }));
test.after(() => new Promise((resolve) => server.close(resolve)));
test.beforeEach(() => {
  requests.length = 0;
  respond = (_request, res) => reply(res, "completed");
});
const deferred = () => Promise.withResolvers();
const latestUser = (request) =>
  request.messages.findLast((m) => m.role === "user")?.content;
const call = (name, args, id = name) => ({
  id,
  type: "function",
  function: { name, arguments: JSON.stringify(args) },
});
function reply(res, content, toolCalls) {
  res.setHeader("Content-Type", "application/json");
  res.end(
    JSON.stringify({
      choices: [
        {
          message: {
            role: "assistant",
            content,
            ...(toolCalls ? { tool_calls: toolCalls } : {}),
          },
          finish_reason: toolCalls ? "tool_calls" : "stop",
        },
      ],
    }),
  );
}
function stream(res, delta) {
  if (!res.headersSent)
    res.writeHead(200, { "Content-Type": "text/event-stream" });
  res.write(`data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`);
}
async function waitFor(check) {
  const deadline = Date.now() + 5000;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("Interrupt fixture timed out");
    await delay(5);
  }
}
function paired(messages) {
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
    assert.notEqual(message.role, "tool", "orphan tool result");
    if (!message.tool_calls?.length) continue;
    const ids = new Set(message.tool_calls.map((c) => c.id));
    for (let j = 0; j < message.tool_calls.length; j++) {
      const result = messages[++i];
      assert.equal(result?.role, "tool");
      assert(
        ids.delete(result.tool_call_id),
        "result must match its assistant call exactly once",
      );
    }
    assert.equal(ids.size, 0);
  }
}
async function client({ choose = () => "once", runner, cwd, load } = {}) {
  cwd ??= await realpath(await mkdtemp(join(temporary, "workspace-")));
  if (!load) await writeFile(join(cwd, "a.txt"), "original");
  const updates = [],
    approvals = [];
  const agent = createAgent(runner ? { sandboxCommand: runner } : {});
  const app = new ClientApp();
  app.onNotification("session/update", ({ params }) => updates.push(params));
  app.onRequest("session/request_permission", async ({ params, signal }) => {
    approvals.push(params);
    const optionId = await choose(params, signal);
    return optionId === "cancelled"
      ? { outcome: { outcome: "cancelled" } }
      : { outcome: { outcome: "selected", optionId } };
  });
  const connection = app.connect(agent.app);
  await connection.agent.request("initialize", {
    protocolVersion: 1,
    clientCapabilities: {},
  });
  const created = await connection.agent.request(
    load ? "session/load" : "session/new",
    { cwd, mcpServers: [], ...(load ? { sessionId: load } : {}) },
  );
  const id = load ?? created.sessionId;
  return {
    id,
    cwd,
    agent,
    connection,
    updates,
    approvals,
    state: () => agent.sessions.get(id),
    prompt: (text, options) =>
      connection.agent.request(
        "session/prompt",
        { sessionId: id, prompt: [{ type: "text", text }] },
        options,
      ),
    cancel: () => connection.agent.notify("session/cancel", { sessionId: id }),
    close: async () => {
      connection.close();
      await agent.close();
    },
  };
}
function holdCleanup(c) {
  const entered = deferred(),
    release = deferred();
  const original = c.state().mcp.close.bind(c.state().mcp);
  let held = false;
  c.state().mcp.close = async () => {
    if (!held) {
      held = true;
      entered.resolve();
      await release.promise;
    }
    await original();
  };
  return { entered: entered.promise, release: () => release.resolve() };
}

test(
  "bare overlapping prompt preserves interrupted text and paired completed tools without replay",
  { timeout: 10000 },
  async () => {
    let rounds = 0;
    const streamStarted = deferred();
    respond = (request, res) => {
      if (latestUser(request) === "replacement")
        return reply(res, "replacement complete");
      if (rounds++ === 0)
        return reply(res, null, [
          call("read_file", { path: "a.txt" }, "read-before-interrupt"),
        ]);
      stream(res, {
        content:
          "Retained partial assistant reply. " + "safe evidence ".repeat(12),
      });
      // These unfinished arguments are never an executable call or persisted history.
      stream(res, {
        tool_calls: [
          {
            index: 0,
            id: "fragment-only",
            type: "function",
            function: { name: "write_file", arguments: '{"path":"a.txt",' },
          },
        ],
      });
      streamStarted.resolve();
    };
    const c = await client();
    let first;
    try {
      first = c.prompt("original request");
      await streamStarted.promise;
      await waitFor(() =>
        c.updates.some((u) =>
          u.update.content?.text?.includes("Retained partial assistant reply"),
        ),
      );
      const second = c.prompt("replacement");
      assert.equal((await first).stopReason, "cancelled");
      assert.equal((await second).stopReason, "end_turn");
      const context = requests.at(-1).messages;
      paired(context);
      assert(
        context.some(
          (m) =>
            m.role === "assistant" &&
            m.content?.includes("Retained partial assistant reply"),
        ),
      );
      assert(
        context.some(
          (m) =>
            m.role === "tool" &&
            m.tool_call_id === "read-before-interrupt" &&
            m.content === "original",
        ),
      );
      assert(
        context.some((m) => /previous turn interrupted/i.test(m.content ?? "")),
      );
      assert(!JSON.stringify(context).includes("fragment-only"));
      assert(
        !JSON.stringify(context).includes("synthetic-interruption-credential"),
      );
      assert.equal(await readFile(join(c.cwd, "a.txt"), "utf8"), "original");
      const stored = await readJson(`session-${c.id}.json`);
      paired(stored.messages);
      const markerIndex = stored.messages.findIndex((m) =>
        /previous turn interrupted/i.test(m.content ?? ""),
      );
      const compacted = contextMessages(stored.messages, {
        through: markerIndex + 1,
        summary: "Earlier tool completed and reply was interrupted.",
        count: 1,
        automatic: true,
      });
      const pinned = compacted.find((m) =>
        m.content?.startsWith("Latest user request in the summarized history"),
      );
      assert.match(pinned.content, /original request/);
      assert.doesNotMatch(pinned.content, /Previous turn interrupted/);
      assert(
        stored.messages.some((m) =>
          m.content?.includes("Retained partial assistant reply"),
        ),
      );
      await c.close();
      const count = requests.length;
      const restored = await client({ cwd: c.cwd, load: c.id });
      try {
        assert.equal(requests.length, count);
        assert.deepEqual(restored.state().messages, stored.messages);
        assert.equal(await readFile(join(c.cwd, "a.txt"), "utf8"), "original");
      } finally {
        await restored.close();
      }
    } finally {
      await c.cancel().catch(() => {});
      await first?.catch(() => {});
      await c.close();
    }
  },
);

test(
  "cancel followed immediately by a prompt waits for the entire old cleanup",
  { timeout: 10000 },
  async () => {
    const running = deferred();
    respond = (request, res) =>
      latestUser(request) === "first"
        ? running.resolve()
        : reply(res, "replacement");
    const c = await client();
    const cleanup = holdCleanup(c);
    try {
      const first = c.prompt("first");
      await running.promise;
      await c.cancel();
      const second = c.prompt("second");
      await cleanup.entered;
      await delay(30);
      assert.equal(
        requests.length,
        1,
        "replacement must wait for close and persistence",
      );
      cleanup.release();
      assert.equal((await first).stopReason, "cancelled");
      assert.equal((await second).stopReason, "end_turn");
      assert.equal(c.state().abort, undefined);
    } finally {
      cleanup.release();
      await c.cancel();
      await c.close();
    }
  },
);

test(
  "three prompts use latest-wins even while the first successful reply is winding down",
  { timeout: 10000 },
  async () => {
    const c = await client();
    const cleanup = holdCleanup(c);
    try {
      const first = c.prompt("first successful reply");
      await cleanup.entered;
      const second = c.prompt("superseded waiting request");
      await delay(10);
      const third = c.prompt("latest request");
      assert.equal((await second).stopReason, "cancelled");
      assert.equal(
        requests.length,
        1,
        "superseding a waiter cannot release the active turn barrier",
      );
      cleanup.release();
      assert.equal(
        (await first).stopReason,
        "cancelled",
        "cancellation during finally must change the old stop reason",
      );
      assert.equal((await third).stopReason, "end_turn");
      assert.equal(requests.length, 2);
      assert.equal(latestUser(requests.at(-1)), "latest request");
      assert(
        !JSON.stringify(c.state().messages).includes(
          "superseded waiting request",
        ),
      );
      paired(c.state().messages);
    } finally {
      cleanup.release();
      await c.cancel();
      await c.close();
    }
  },
);

test(
  "a waiting replacement respects its own request cancellation",
  { timeout: 10000 },
  async () => {
    const c = await client();
    const cleanup = holdCleanup(c);
    const controller = new AbortController();
    try {
      const first = c.prompt("first");
      await cleanup.entered;
      const second = c.prompt("cancel this waiter", {
        cancellationSignal: controller.signal,
      });
      await delay(10);
      controller.abort();
      assert.equal((await second).stopReason, "cancelled");
      assert.equal(requests.length, 1);
      cleanup.release();
      assert.equal((await first).stopReason, "cancelled");
      assert.equal(
        (await c.prompt("later independent request")).stopReason,
        "end_turn",
      );
      assert(
        !JSON.stringify(c.state().messages).includes("cancel this waiter"),
      );
    } finally {
      controller.abort();
      cleanup.release();
      await c.cancel();
      await c.close();
    }
  },
);

test(
  "Stop cancels a queued replacement as well as the winding-down turn",
  { timeout: 10000 },
  async () => {
    const c = await client();
    const cleanup = holdCleanup(c);
    try {
      const first = c.prompt("first");
      await cleanup.entered;
      const second = c.prompt("queued then stopped");
      await delay(10);
      await c.cancel();
      assert.equal((await second).stopReason, "cancelled");
      cleanup.release();
      assert.equal((await first).stopReason, "cancelled");
      assert.equal(requests.length, 1);
      assert(
        !JSON.stringify(c.state().messages).includes("queued then stopped"),
      );
    } finally {
      cleanup.release();
      await c.cancel();
      await c.close();
    }
  },
);

test(
  "interruption cancels pending approval and a late allow cannot authorize the replacement",
  { timeout: 10000 },
  async () => {
    const pending = deferred(),
      permissionCancelled = deferred(),
      late = deferred();
    let edits = 0;
    const c = await client({
      choose: (params, signal) => {
        if (!params.toolCall.title.startsWith("Write ")) return "once";
        if (++edits !== 1) return "deny";
        signal.addEventListener("abort", () => permissionCancelled.resolve(), {
          once: true,
        });
        pending.resolve();
        return late.promise;
      },
    });
    respond = (request, res) => {
      const last = request.messages.at(-1);
      if (last.role === "tool") return reply(res, "operation not approved");
      reply(res, null, [
        call(
          "write_file",
          { path: "a.txt", before: "original", after: "must remain unapplied" },
          latestUser(request) === "first" ? "old-edit" : "new-edit",
        ),
      ]);
    };
    try {
      const first = c.prompt("first");
      await pending.promise;
      const second = c.prompt("replacement");
      await permissionCancelled.promise;
      assert.equal((await first).stopReason, "cancelled");
      assert.equal((await second).stopReason, "end_turn");
      late.resolve("once");
      await delay(20);
      assert.equal(edits, 2, "new operation must request its own approval");
      assert.equal(await readFile(join(c.cwd, "a.txt"), "utf8"), "original");
      paired(c.state().messages);
      assert.equal(
        c.state().messages.filter((m) => m.role === "tool").length,
        2,
      );
    } finally {
      late.resolve("deny");
      await c.cancel();
      await c.close();
    }
  },
);

test(
  "replacing a turn kills its real owned command and descendants before the next inference",
  { timeout: 10000 },
  async () => {
    let finished = false;
    const c = await client({
      runner: async (executable, args, run, signal) => {
        const result = await command(executable, args, run.root, signal, {
          timeoutMs: 5000,
          outputBytes: 10000,
        });
        finished = true;
        return result;
      },
    });
    const pidFile = join(c.cwd, "pid.json"),
      marker = join(c.cwd, "descendant-must-not-finish.txt");
    const childCode = `setTimeout(()=>require('node:fs').writeFileSync(${JSON.stringify(marker)},'unwanted'),900);setInterval(()=>{},1000)`;
    const code = `const child=require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(childCode)}],{stdio:'inherit'});require('node:fs').writeFileSync(${JSON.stringify(pidFile)},JSON.stringify({parent:process.pid,child:child.pid}));setInterval(()=>{},1000)`;
    respond = (request, res) => {
      if (latestUser(request) === "replacement") {
        assert(
          finished,
          "next inference cannot start until command cleanup finishes",
        );
        return reply(res, "replacement complete");
      }
      reply(res, null, [
        call(
          "run_command",
          { executable: process.execPath, args: ["-e", code] },
          "owned-command",
        ),
      ]);
    };
    try {
      const first = c.prompt("run the fixture command");
      await waitFor(async () => {
        try {
          await access(pidFile);
          return true;
        } catch {
          return false;
        }
      });
      const pid = JSON.parse(await readFile(pidFile, "utf8"));
      const second = c.prompt("replacement");
      assert.equal((await first).stopReason, "cancelled");
      assert.equal((await second).stopReason, "end_turn");
      assert.throws(
        () => process.kill(pid.parent, 0),
        (e) => e.code === "ESRCH",
      );
      await delay(1000);
      await assert.rejects(access(marker), (e) => e.code === "ENOENT");
      const result = c
        .state()
        .messages.find((m) => m.tool_call_id === "owned-command");
      assert.equal(JSON.parse(result.content).limitedOrCancelled, true);
      paired(c.state().messages);
    } finally {
      await c.cancel();
      await c.close();
    }
  },
);

test(
  "interrupting one session does not cancel another session",
  { timeout: 10000 },
  async () => {
    const started = deferred();
    let otherResponse;
    respond = (request, res) => {
      if (latestUser(request) === "keep running") {
        otherResponse = res;
        started.resolve();
        return;
      }
      if (latestUser(request) === "interrupt me") return;
      reply(res, "done");
    };
    const c = await client();
    const otherRoot = await realpath(await mkdtemp(join(temporary, "other-")));
    const other = await c.connection.agent.request("session/new", {
      cwd: otherRoot,
      mcpServers: [],
    });
    try {
      const otherTurn = c.connection.agent.request("session/prompt", {
        sessionId: other.sessionId,
        prompt: [{ type: "text", text: "keep running" }],
      });
      await started.promise;
      const first = c.prompt("interrupt me");
      await waitFor(() =>
        requests.some((r) => latestUser(r) === "interrupt me"),
      );
      const replacement = c.prompt("replacement");
      assert.equal((await first).stopReason, "cancelled");
      assert.equal((await replacement).stopReason, "end_turn");
      assert.equal(
        c.agent.sessions.get(other.sessionId).abort.signal.aborted,
        false,
      );
      reply(otherResponse, "other session complete");
      assert.equal((await otherTurn).stopReason, "end_turn");
      assert(
        !JSON.stringify(
          c.agent.sessions.get(other.sessionId).messages,
        ).includes("replacement"),
      );
    } finally {
      otherResponse?.end();
      await c.cancel();
      await c.close();
    }
  },
);

test(
  "completed edits remain in history but their one-use approval does not carry into replacement",
  { timeout: 10000 },
  async () => {
    const streamed = deferred();
    let editApprovals = 0;
    const c = await client({
      choose: (params) => {
        if (!params.toolCall.title.startsWith("Write ")) return "once";
        return ++editApprovals === 1 ? "once" : "deny";
      },
    });
    respond = (request, res) => {
      const replacement = latestUser(request) === "replacement";
      if (request.messages.at(-1).role === "tool") {
        if (replacement) return reply(res, "replacement edit denied");
        stream(res, {
          content: "The first edit completed. " + "retained result ".repeat(10),
        });
        streamed.resolve();
        return;
      }
      reply(res, null, [
        call(
          "write_file",
          {
            path: "a.txt",
            before: replacement ? "edited" : "original",
            after: replacement ? "unapproved replacement" : "edited",
          },
          replacement ? "replacement-edit" : "completed-edit",
        ),
      ]);
    };
    try {
      const first = c.prompt("first edit");
      await streamed.promise;
      await waitFor(() =>
        c.updates.some((u) =>
          u.update.content?.text?.includes("first edit completed"),
        ),
      );
      assert.equal(await readFile(join(c.cwd, "a.txt"), "utf8"), "edited");
      const second = c.prompt("replacement");
      assert.equal((await first).stopReason, "cancelled");
      assert.equal((await second).stopReason, "end_turn");
      assert.equal(editApprovals, 2);
      assert.equal(await readFile(join(c.cwd, "a.txt"), "utf8"), "edited");
      paired(c.state().messages);
      assert(
        c
          .state()
          .messages.some(
            (m) =>
              m.tool_call_id === "completed-edit" &&
              m.content === "File updated",
          ),
      );
    } finally {
      await c.cancel();
      await c.close();
    }
  },
);

test(
  "a cancelled slash command cannot widen permissions after its initial mode read",
  { timeout: 10000 },
  async () => {
    const c = await client();
    const entered = deferred(),
      release = deferred();
    const mode = c.state().permissions.mode.bind(c.state().permissions);
    let held = false;
    c.state().permissions.mode = async () => {
      if (!held) {
        held = true;
        entered.resolve();
        await release.promise;
      }
      return mode();
    };
    try {
      const first = c.prompt("/permissions mode development");
      await entered.promise;
      const replacement = c.prompt("/status");
      await waitFor(() => c.state().turns.queued > 0);
      release.resolve();
      assert.equal((await first).stopReason, "cancelled");
      assert.equal((await replacement).stopReason, "end_turn");
      assert.equal(c.state().permissions.currentMode, "scoped");
      assert.equal(requests.length, 0);
    } finally {
      release.resolve();
      await c.cancel();
      await c.close();
    }
  },
);

for (const control of ["mode development", "sandbox full_access"]) {
  test(
    `a cancelled permission selector cannot commit after prepare: ${control}`,
    { timeout: 10000 },
    async () => {
      const c = await client();
      const entered = deferred(),
        release = deferred();
      const prepare = c.state().permissions.prepare.bind(c.state().permissions);
      let held = false;
      c.state().permissions.prepare = async () => {
        if (!held) {
          held = true;
          entered.resolve();
          await release.promise;
        }
        return prepare();
      };
      try {
        const first = c.prompt(`/permissions ${control}`);
        await entered.promise;
        const replacement = c.prompt("/status");
        await waitFor(() => c.state().turns.queued > 0);
        release.resolve();
        assert.equal((await first).stopReason, "cancelled");
        assert.equal((await replacement).stopReason, "end_turn");
        assert.equal(c.state().permissions.currentMode, "scoped");
        assert.equal(c.state().sandbox, "workspace");
        assert.equal(c.state().sandboxEpoch, undefined);
        assert.equal(requests.length, 0);
      } finally {
        release.resolve();
        await c.cancel();
        await c.close();
      }
    },
  );
}

test(
  "cancelled model selection discards metadata returned after interruption",
  { timeout: 10000 },
  async () => {
    const c = await client();
    const entered = deferred(),
      release = deferred();
    c.state().models.push("alternate");
    const originalMetadata = c.state().metadata;
    let modelSignal;
    c.state().backend.modelMetadata = async (signal) => {
      modelSignal = signal;
      entered.resolve();
      await release.promise;
      return [{ id: "fixture" }, { id: "alternate" }];
    };
    try {
      const first = c.prompt("/model alternate");
      await entered.promise;
      const replacement = c.prompt("/status");
      await waitFor(() => c.state().turns.queued > 0);
      assert.equal(modelSignal.aborted, true);
      release.resolve();
      assert.equal((await first).stopReason, "cancelled");
      assert.equal((await replacement).stopReason, "end_turn");
      assert.equal(c.state().config.model, "fixture");
      assert.equal(c.state().metadata, originalMetadata);
      assert.equal(requests.length, 0);
    } finally {
      release.resolve();
      await c.cancel();
      await c.close();
    }
  },
);

test(
  "cleanup failure releases the turn barrier without leaving a stale abort controller",
  { timeout: 10000 },
  async () => {
    const c = await client();
    const entered = deferred(),
      release = deferred();
    const close = c.state().mcp.close.bind(c.state().mcp);
    let held = false;
    c.state().mcp.close = async () => {
      if (!held) {
        held = true;
        entered.resolve();
        await release.promise;
        throw new Error("Synthetic cleanup failure");
      }
      await close();
    };
    try {
      const first = c.prompt("first");
      const failed = assert.rejects(first);
      await entered.promise;
      const replacement = c.prompt("replacement");
      await waitFor(() => c.state().turns.queued > 0);
      release.resolve();
      await failed;
      assert.equal((await replacement).stopReason, "end_turn");
      assert.equal(c.state().abort, undefined);
      assert.equal(c.state().turns.busy, false);
      assert.equal(c.state().turns.queued, 0);
      paired(c.state().messages);
    } finally {
      release.resolve();
      await c.cancel();
      await c.close();
    }
  },
);

async function queueMode(c) {
  const result = await c.connection.agent.request("session/set_config_option", {
    sessionId: c.id,
    configId: "prompt_mode",
    value: "queue",
  });
  assert.equal(
    result.configOptions.find((o) => o.id === "prompt_mode").currentValue,
    "queue",
  );
}

test(
  "queued prompts finish FIFO after cleanup and see complete prior tool results",
  { timeout: 10000 },
  async () => {
    const c = await client();
    await queueMode(c);
    const cleanup = holdCleanup(c);
    respond = (request, res) => {
      if (
        latestUser(request) === "first" &&
        request.messages.at(-1).role === "user"
      )
        return reply(res, null, [
          call("read_file", { path: "a.txt" }, "first-read"),
        ]);
      reply(res, `done ${latestUser(request)}`);
    };
    try {
      const first = c.prompt("first");
      await cleanup.entered;
      const second = c.prompt("second");
      const third = c.prompt("third");
      await waitFor(() => c.state().turns.queued === 2);
      assert.equal(c.state().abort.signal.aborted, false);
      assert.equal(requests.length, 2);
      assert(!JSON.stringify(c.state().messages).includes("second"));
      const saved = await readJson(`session-${c.id}.json`);
      assert(!JSON.stringify(saved).includes("second"));
      cleanup.release();
      const results = await Promise.all([first, second, third]);
      assert.deepEqual(
        results.map((r) => r.stopReason),
        ["end_turn", "end_turn", "end_turn"],
      );
      assert.deepEqual(requests.map(latestUser), [
        "first",
        "first",
        "second",
        "third",
      ]);
      paired(requests.at(-1).messages);
      assert(
        requests
          .at(-1)
          .messages.some(
            (m) => m.tool_call_id === "first-read" && m.content === "original",
          ),
      );
      assert(requests.at(-1).messages.some((m) => m.content === "done second"));
      assert(
        !JSON.stringify(c.state().messages).includes(
          "Previous turn interrupted",
        ),
      );
    } finally {
      cleanup.release();
      await c.cancel();
      await c.close();
    }
  },
);

test(
  "cancelling a queued request removes only that request without releasing the active barrier",
  { timeout: 10000 },
  async () => {
    const c = await client();
    await queueMode(c);
    const cleanup = holdCleanup(c);
    const controller = new AbortController();
    try {
      const first = c.prompt("first");
      await cleanup.entered;
      const second = c.prompt("remove this message", {
        cancellationSignal: controller.signal,
      });
      const third = c.prompt("third");
      await waitFor(() => c.state().turns.queued === 2);
      controller.abort();
      assert.equal((await second).stopReason, "cancelled");
      assert.equal(c.state().turns.queued, 1);
      assert.equal(requests.length, 1);
      assert.equal(c.state().abort.signal.aborted, false);
      cleanup.release();
      assert.equal((await first).stopReason, "end_turn");
      assert.equal((await third).stopReason, "end_turn");
      assert.deepEqual(requests.map(latestUser), ["first", "third"]);
      assert(
        !JSON.stringify(c.state().messages).includes("remove this message"),
      );
    } finally {
      controller.abort();
      cleanup.release();
      await c.cancel();
      await c.close();
    }
  },
);

test(
  "Stop empties the FIFO queue and a new prompt waits for cancelled turn cleanup",
  { timeout: 10000 },
  async () => {
    const c = await client();
    await queueMode(c);
    const cleanup = holdCleanup(c);
    try {
      const first = c.prompt("first");
      await cleanup.entered;
      const second = c.prompt("discard second");
      const third = c.prompt("discard third");
      await waitFor(() => c.state().turns.queued === 2);
      await c.cancel();
      assert.equal((await second).stopReason, "cancelled");
      assert.equal((await third).stopReason, "cancelled");
      const next = c.prompt("after Stop");
      await waitFor(() => c.state().turns.queued === 1);
      assert.equal(requests.length, 1);
      cleanup.release();
      assert.equal((await first).stopReason, "cancelled");
      assert.equal((await next).stopReason, "end_turn");
      assert.deepEqual(requests.map(latestUser), ["first", "after Stop"]);
      assert(!JSON.stringify(c.state().messages).includes("discard"));
    } finally {
      cleanup.release();
      await c.cancel();
      await c.close();
    }
  },
);

test(
  "queue bounds and invalid prompts fail without interrupting or doing workspace work",
  { timeout: 10000 },
  async () => {
    const activation = deferred(),
      late = deferred();
    const c = await client({
      choose: () => {
        activation.resolve();
        return late.promise;
      },
    });
    await queueMode(c);
    try {
      const first = c.prompt("first");
      await activation.promise;
      const waiting = Array.from({ length: 10 }, (_, i) =>
        c.prompt(`queued ${i}`),
      );
      await waitFor(() => c.state().turns.queued === 10);
      await assert.rejects(c.prompt("overflow"), /Prompt queue is full/);
      await assert.rejects(c.prompt("x".repeat(100001)), (error) => {
        assert.match(JSON.stringify(error.data), /Prompt too large/);
        return true;
      });
      assert.equal(c.state().abort.signal.aborted, false);
      assert.equal(requests.length, 0);
      assert.equal(c.approvals.length, 1);
      assert.deepEqual(c.state().messages, []);
      await c.cancel();
      for (const result of await Promise.all([first, ...waiting]))
        assert.equal(result.stopReason, "cancelled");
      late.resolve("once");
      await delay(20);
      assert.equal(
        requests.length,
        0,
        "late activation cannot start a queued prompt",
      );
      assert.equal(c.state().turns.queued, 0);
    } finally {
      late.resolve("deny");
      await c.cancel();
      await c.close();
    }
  },
);

test(
  "queue controls persist the mode but never restore waiting requests",
  { timeout: 10000 },
  async () => {
    const c = await client();
    let held;
    try {
      assert.equal(c.state().promptMode, "interrupt");
      await c.prompt("/queue on");
      assert.equal(c.state().promptMode, "queue");
      await c.prompt("/queue nope");
      assert.equal(c.state().promptMode, "queue");
      await assert.rejects(
        c.connection.agent.request("session/set_config_option", {
          sessionId: c.id,
          configId: "prompt_mode",
          value: "invented",
        }),
        /Unknown incoming prompt mode/,
      );
      await c.prompt("/queue");
      const status = JSON.parse(
        c.updates.findLast((u) =>
          u.update.content?.text?.startsWith('{"backend"'),
        ).update.content.text,
      );
      assert.deepEqual(status.promptQueue, {
        mode: "queue",
        waiting: 0,
        limit: 10,
        stopCancelsWaiting: true,
      });
      assert(
        c.updates.some((u) =>
          u.update.availableCommands?.some((cmd) => cmd.name === "queue"),
        ),
      );
      assert.equal(requests.length, 0);
      held = holdCleanup(c);
      const first = c.prompt("completed before save");
      await held.entered;
      const second = c.prompt("never restore this queued request");
      await waitFor(() => c.state().turns.queued === 1);
      const saved = await readJson(`session-${c.id}.json`);
      assert.equal(saved.promptMode, "queue");
      assert(!JSON.stringify(saved).includes("never restore"));
      await c.cancel();
      held.release();
      assert.equal((await first).stopReason, "cancelled");
      assert.equal((await second).stopReason, "cancelled");
      await c.close();
      const count = requests.length;
      const restored = await client({ cwd: c.cwd, load: c.id });
      try {
        assert.equal(restored.state().promptMode, "queue");
        assert.equal(restored.state().turns.queued, 0);
        assert.equal(requests.length, count);
        await restored.prompt("/queue off");
        assert.equal(restored.state().promptMode, "interrupt");
      } finally {
        await restored.close();
      }
    } finally {
      held?.release();
      await c.cancel().catch(() => {});
      await c.close();
    }
  },
);

test(
  "queued edits request their own approval and preserve history ordering",
  { timeout: 10000 },
  async () => {
    const approvals = deferred(),
      release = deferred();
    let edits = 0;
    const c = await client({
      choose: (params) => {
        if (!params.toolCall.title.startsWith("Write ")) return "once";
        if (++edits === 1) {
          approvals.resolve();
          return release.promise;
        }
        return "deny";
      },
    });
    await queueMode(c);
    respond = (request, res) => {
      if (request.messages.at(-1).role === "tool")
        return reply(res, "edit result recorded");
      const first = latestUser(request) === "first";
      reply(res, null, [
        call(
          "write_file",
          {
            path: "a.txt",
            before: first ? "original" : "edited",
            after: first ? "edited" : "denied edit",
          },
          first ? "first-edit" : "second-edit",
        ),
      ]);
    };
    try {
      const first = c.prompt("first");
      await approvals.promise;
      const second = c.prompt("second");
      await waitFor(() => c.state().turns.queued === 1);
      assert.equal(edits, 1);
      release.resolve("once");
      assert.equal((await first).stopReason, "end_turn");
      assert.equal((await second).stopReason, "end_turn");
      assert.equal(edits, 2);
      assert.equal(await readFile(join(c.cwd, "a.txt"), "utf8"), "edited");
      paired(c.state().messages);
    } finally {
      release.resolve("deny");
      await c.cancel();
      await c.close();
    }
  },
);

test(
  "queue waits for an owned command and Stop kills it without starting waiting work",
  { timeout: 10000 },
  async () => {
    const started = deferred();
    let pid,
      finished = false;
    const c = await client({
      runner: async (executable, args, run, signal) => {
        const result = await command(executable, args, run.root, signal, {
          timeoutMs: 5000,
          outputBytes: 10000,
        });
        finished = true;
        return result;
      },
    });
    await queueMode(c);
    const pidFile = join(c.cwd, "queued-command-pid");
    respond = (_request, res) => {
      started.resolve();
      reply(res, null, [
        call("run_command", {
          executable: process.execPath,
          args: [
            "-e",
            `require('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setInterval(()=>{},1000)`,
          ],
        }),
      ]);
    };
    try {
      const first = c.prompt("run command");
      await started.promise;
      await waitFor(async () => {
        try {
          pid = Number(await readFile(pidFile, "utf8"));
          return pid > 0;
        } catch {
          return false;
        }
      });
      const second = c.prompt("queued behind command");
      await waitFor(() => c.state().turns.queued === 1);
      assert.equal(finished, false);
      assert.equal(requests.length, 1);
      await c.cancel();
      assert.equal((await first).stopReason, "cancelled");
      assert.equal((await second).stopReason, "cancelled");
      assert.equal(finished, true);
      assert.throws(
        () => process.kill(pid, 0),
        (e) => e.code === "ESRCH",
      );
      assert.equal(requests.length, 1);
      paired(c.state().messages);
    } finally {
      await c.cancel();
      await c.close();
    }
  },
);

test(
  "closing the agent cancels active and queued prompts",
  { timeout: 10000 },
  async () => {
    const started = deferred();
    respond = () => started.resolve();
    const c = await client();
    await queueMode(c);
    try {
      const first = c.prompt("active");
      await started.promise;
      const second = c.prompt("waiting on disconnect");
      await waitFor(() => c.state().turns.queued === 1);
      await c.agent.close();
      assert.equal((await first).stopReason, "cancelled");
      assert.equal((await second).stopReason, "cancelled");
      assert.equal(requests.length, 1);
      assert.equal(c.state().turns.busy, false);
    } finally {
      await c.close();
    }
  },
);

test(
  "queued prompts recheck authentication when their turn starts",
  { timeout: 10000 },
  async () => {
    const c = await client();
    await queueMode(c);
    const cleanup = holdCleanup(c);
    try {
      const first = c.prompt("first");
      await cleanup.entered;
      const second = c.prompt("must not use expired authentication");
      const rejected = assert.rejects(second, (error) => error.code === -32000);
      await waitFor(() => c.state().turns.queued === 1);
      // Model the epoch changing while waiting, without reading or changing credentials.
      c.state().authEpoch = { stale: true };
      cleanup.release();
      await first;
      await rejected;
      assert.equal(requests.length, 1);
      assert.equal(c.state().turns.busy, false);
    } finally {
      cleanup.release();
      await c.cancel();
      await c.close();
    }
  },
);

test(
  "another session runs independently and revocation cancels matching queued work",
  { timeout: 10000 },
  async () => {
    const running = deferred();
    respond = (request, res) =>
      latestUser(request) === "first"
        ? running.resolve()
        : reply(res, "other session done");
    const c = await client();
    await queueMode(c);
    const other = await c.connection.agent.request("session/new", {
      cwd: c.cwd,
      mcpServers: [],
    });
    const promptOther = (text) =>
      c.connection.agent.request("session/prompt", {
        sessionId: other.sessionId,
        prompt: [{ type: "text", text }],
      });
    try {
      const first = c.prompt("first");
      await running.promise;
      const second = c.prompt("must be cancelled on revocation");
      await waitFor(() => c.state().turns.queued === 1);
      assert.equal(
        c.agent.sessions.get(other.sessionId).promptMode,
        "interrupt",
      );
      assert.equal(
        (await promptOther("other session request")).stopReason,
        "end_turn",
      );
      assert.equal(c.state().abort.signal.aborted, false);
      assert.equal(
        (await promptOther("/permissions revoke-tools")).stopReason,
        "end_turn",
      );
      assert.equal((await first).stopReason, "cancelled");
      assert.equal((await second).stopReason, "cancelled");
      assert.deepEqual(requests.map(latestUser), [
        "first",
        "other session request",
      ]);
    } finally {
      await c.cancel();
      await c.close();
    }
  },
);

test(
  "a queued revocation finishes but cancels subsequent prompts in its own session",
  { timeout: 10000 },
  async () => {
    const c = await client();
    await queueMode(c);
    const cleanup = holdCleanup(c);
    try {
      const first = c.prompt("first");
      await cleanup.entered;
      const revoke = c.prompt("/permissions revoke-tools");
      const later = c.prompt("cancel this after revocation");
      await waitFor(() => c.state().turns.queued === 2);
      cleanup.release();
      assert.equal((await first).stopReason, "end_turn");
      assert.equal((await revoke).stopReason, "end_turn");
      assert.equal((await later).stopReason, "cancelled");
      assert.equal(requests.length, 1);
    } finally {
      cleanup.release();
      await c.cancel();
      await c.close();
    }
  },
);
