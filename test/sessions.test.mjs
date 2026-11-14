import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, realpath, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { ClientApp } from "@agentclientprotocol/sdk";

const temporary = await mkdtemp(join(tmpdir(), "ow-sessions-"));
process.env.OPENWEBUI_ACP_HOME = join(temporary, "state");
process.env.OPENWEBUI_API_KEY = "synthetic-sessions-credential";
const { createAgent } = await import("../dist/agent.js");
const { configSchema, writeJson, readJson } = await import("../dist/config.js");
const { Turns } = await import("../dist/turns.js");
const { Jobs, jobStatusText } = await import("../dist/jobs.js");
const {
  userTurns,
  tagCheckpoints,
  turnSummaries,
  rewindPlan,
  truncatedCompaction,
} = await import("../dist/rewind.js");
const { prepareCheckpoint, recordCheckpoint, CheckpointError } =
  await import("../dist/checkpoints.js");
const { compactionStateSchema } = await import("../dist/compaction.js");

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
const afterTool = (request) => request.messages.at(-1).role === "tool";
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
async function waitFor(check) {
  const deadline = Date.now() + 5000;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("Sessions fixture timed out");
    await delay(5);
  }
}
const texts = (updates) =>
  updates
    .filter((u) => u.update.sessionUpdate === "agent_message_chunk")
    .map((u) => u.update.content.text)
    .join("");

async function client({
  method = "session/new",
  sessionId,
  cwd,
  runner,
  capabilities = {},
  choose = () => "once",
} = {}) {
  cwd ??= await realpath(await mkdtemp(join(temporary, "workspace-")));
  if (method === "session/new") await writeFile(join(cwd, "a.txt"), "original");
  const updates = [],
    approvals = [],
    executed = [];
  const agent = createAgent(
    runner
      ? {
          sandboxCommand: async (
            executable,
            args,
            run,
            signal,
            limits,
            out,
          ) => {
            const execution = { executable, args, signal };
            executed.push(execution);
            return runner(execution, out);
          },
        }
      : {},
  );
  const app = new ClientApp();
  app.onNotification("session/update", ({ params }) => updates.push(params));
  app.onRequest("session/request_permission", async ({ params }) => {
    approvals.push(params);
    return { outcome: { outcome: "selected", optionId: choose(params) } };
  });
  const connection = app.connect(agent.app);
  const initialized = await connection.agent.request("initialize", {
    protocolVersion: 1,
    clientCapabilities: capabilities,
  });
  const response = await connection.agent.request(method, {
    cwd,
    mcpServers: [],
    ...(sessionId ? { sessionId } : {}),
  });
  const id = sessionId ?? response.sessionId;
  return {
    id,
    cwd,
    agent,
    initialized,
    response,
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

// Two turns, each with one approved agent edit to a.txt.
async function twoEdits(c) {
  respond = (request, res) => {
    if (afterTool(request)) return reply(res, `done ${latestUser(request)}`);
    if (latestUser(request) === "first edit")
      return reply(res, null, [
        call(
          "write_file",
          { path: "a.txt", before: "original", after: "one" },
          "w1",
        ),
      ]);
    if (latestUser(request) === "second edit")
      return reply(res, null, [
        call(
          "write_file",
          { path: "a.txt", before: "one", after: "two" },
          "w2",
        ),
      ]);
    reply(res, "unexpected");
  };
  assert.equal((await c.prompt("first edit")).stopReason, "end_turn");
  assert.equal((await c.prompt("second edit")).stopReason, "end_turn");
  assert.equal(await readFile(join(c.cwd, "a.txt"), "utf8"), "two");
}

// ---------------------------------------------------------------- units

test("rewind plans restore the earliest agent state and refuse gaps", () => {
  const messages = [
    { role: "system", content: "s" },
    { role: "user", content: "one" },
    { role: "assistant", content: "a" },
    { role: "user", content: "two  \n words" },
    { role: "assistant", content: "b" },
    { role: "user", content: "three" },
  ];
  assert.deepEqual(userTurns(messages), [1, 3, 5]);
  let records = [];
  const add = (before, after, path = "f.txt") => {
    const cp = prepareCheckpoint(records, path, before, after);
    records = recordCheckpoint(records, cp);
    return cp.id;
  };
  const first = add("x", "y");
  let tags = tagCheckpoints({}, records, 1);
  const second = add("y", "z");
  const created = add(null, "new", "g.txt");
  tags = tagCheckpoints(tags, records, 2);
  assert.deepEqual(tags, { [first]: 1, [second]: 2, [created]: 2 });
  assert.deepEqual(
    turnSummaries(messages, records, tags).map((t) => [
      t.turn,
      t.preview,
      t.agentEdits,
    ]),
    [
      [1, "one", 1],
      [2, "two words", 2],
      [3, "three", 0],
    ],
  );
  const plan = rewindPlan(messages, records, tags, 2);
  assert.equal(plan.cut, 3);
  assert.deepEqual(plan.files, [
    { path: "f.txt", expected: "z", restored: "y" },
    { path: "g.txt", expected: "new", restored: null },
  ]);
  assert.deepEqual(plan.rewound, [second, created]);
  assert.deepEqual(rewindPlan(messages, records, tags, 1).files[0], {
    path: "f.txt",
    expected: "z",
    restored: "x",
  });
  assert.throws(() => rewindPlan(messages, records, tags, 4), CheckpointError);
  assert.throws(() => rewindPlan(messages, records, tags, 0), CheckpointError);
  // Untagged (legacy) checkpoints are never reverted.
  assert.equal(rewindPlan(messages, records, {}, 1).files.length, 0);
  assert.equal(rewindPlan(messages, records, {}, 1).untracked, 3);
  // Another writer changed the file between two agent edits.
  add("changed by user", "w");
  tags = tagCheckpoints(tags, records, 3);
  assert.throws(
    () => rewindPlan(messages, records, tags, 2),
    /changed between agent edits/,
  );
  const compaction = compactionStateSchema.parse({
    summary: "s",
    through: 3,
    count: 2,
  });
  assert.equal(truncatedCompaction(compaction, 3), compaction);
  assert.deepEqual(truncatedCompaction(compaction, 1), {
    summary: "",
    through: 0,
    count: 2,
    automatic: true,
  });
});

test("steering joins the active turn in order and falls back to a queued turn", async () => {
  const turns = new Turns();
  const release = deferred();
  const ran = [];
  const active = turns.run("steer", new AbortController().signal, async () => {
    ran.push("active");
    await release.promise;
    return { stopReason: "end_turn" };
  });
  const a = turns.run(
    "steer",
    new AbortController().signal,
    async () => ran.push("a"),
    "A",
  );
  const command = turns.run("steer", new AbortController().signal, async () => {
    ran.push("command");
    return { stopReason: "end_turn" };
  });
  const b = turns.run(
    "steer",
    new AbortController().signal,
    async () => {
      ran.push("b");
      return { stopReason: "end_turn" };
    },
    "B",
  );
  await delay(1);
  // Only the steering prefix is offered; a command breaks it.
  const offered = turns.steering();
  assert.deepEqual(
    offered.map((c) => c.payload),
    ["A"],
  );
  assert.equal(offered[0].take(), true);
  assert.equal(offered[0].take(), false);
  assert.equal(turns.queued, 2);
  release.resolve();
  assert.deepEqual(await active, { stopReason: "end_turn" });
  assert.deepEqual(await a, { stopReason: "end_turn" });
  assert.deepEqual(await command, { stopReason: "end_turn" });
  // B was never absorbed, so it ran as its own turn after the command.
  assert.deepEqual(await b, { stopReason: "end_turn" });
  assert.deepEqual(ran, ["active", "command", "b"]);
  await turns.drain();
  assert.equal(turns.busy, false);
});

test("a cancelled steering request is never absorbed and Stop cancels joined prompts", async () => {
  const turns = new Turns();
  const release = deferred();
  const active = turns.run("steer", new AbortController().signal, async () => {
    await release.promise;
    return { stopReason: "end_turn" };
  });
  const own = new AbortController();
  const withdrawn = turns.run("steer", own.signal, async () => {}, "W");
  const joined = turns.run(
    "steer",
    new AbortController().signal,
    async () => {},
    "J",
  );
  await delay(1);
  own.abort();
  assert.deepEqual(await withdrawn, { stopReason: "cancelled" });
  const [candidate] = turns.steering();
  assert.equal(candidate.payload, "J");
  assert(candidate.take());
  turns.cancel();
  release.resolve();
  assert.deepEqual(await active, { stopReason: "cancelled" });
  assert.deepEqual(await joined, { stopReason: "cancelled" });
});

test("job progress is coalesced, sized and reported to the model once", async () => {
  const jobs = new Jobs();
  const progress = [];
  const finish = deferred();
  const completed = deferred();
  const info = jobs.start(
    async (_signal, output) => {
      let text = "";
      for (let i = 0; i < 40; i++) {
        text += `line ${i}\n`;
        await output(text);
      }
      await finish.promise;
      return JSON.stringify({
        code: 0,
        output: text,
        limitedOrCancelled: false,
      });
    },
    {
      progressMs: 50,
      onOutput: (snapshot) => progress.push(snapshot),
      onComplete: (snapshot) => completed.resolve(snapshot),
    },
  );
  assert.equal(info.outputChars, 0);
  await waitFor(() => progress.length > 0);
  await delay(120);
  assert(progress.length <= 3, `coalesced progress, got ${progress.length}`);
  assert.equal(progress.at(-1).outputChars, progress.at(-1).output.length);
  assert.deepEqual(jobs.takeFinished(), []);
  finish.resolve();
  const done = await completed.promise;
  assert.equal(done.state, "completed");
  const status = jobStatusText(done);
  assert.match(status, /: completed, exit code 0, \d+s, \d+ output characters/);
  assert.match(status, /line 39/);
  const reported = jobs.takeFinished();
  assert.deepEqual(
    reported.map((j) => [j.id, j.state]),
    [[info.id, "completed"]],
  );
  assert.deepEqual(jobs.takeFinished(), []);
  const long = jobStatusText({ ...done, output: "x".repeat(5000) });
  assert.match(long, /Last 2000 characters; \/jobs poll .* 3000 shows them/);
  assert(long.length < 2300);
});

// ---------------------------------------------------------- protocol

test("capabilities advertise load, list, resume and close", async () => {
  const c = await client();
  try {
    assert.deepEqual(c.initialized.agentCapabilities.sessionCapabilities, {
      list: {},
      resume: {},
      close: {},
    });
    assert.equal(c.initialized.agentCapabilities.loadSession, true);
  } finally {
    await c.close();
  }
});

test("load replays text and tool calls with recorded outcomes without re-running them", async () => {
  const c = await client();
  respond = (request, res) => {
    if (afterTool(request)) return reply(res, "inspected");
    reply(res, "looking", [
      call("read_file", { path: "a.txt" }, "ok-read"),
      call("read_file", { path: "missing.txt" }, "bad-read"),
    ]);
  };
  try {
    await c.prompt("inspect files");
  } finally {
    await c.close();
  }
  const before = requests.length;
  await writeFile(join(c.cwd, "a.txt"), "changed later");
  const loaded = await client({
    method: "session/load",
    sessionId: c.id,
    cwd: c.cwd,
  });
  try {
    assert.equal(requests.length, before, "load makes no inference request");
    const kinds = loaded.updates.map((u) => u.update.sessionUpdate);
    assert(kinds.includes("user_message_chunk"));
    const calls = loaded.updates
      .map((u) => u.update)
      .filter((u) => u.sessionUpdate === "tool_call");
    assert.deepEqual(
      calls.map((u) => [u.toolCallId, u.status, u.title]),
      [
        ["ok-read", "completed", "read_file"],
        ["bad-read", "failed", "read_file"],
      ],
    );
    // The replayed result is the recorded one, not a new read.
    assert.equal(calls[0].content[0].content.text, "original");
    assert.equal(loaded.approvals.length, 0);
    assert.match(texts(loaded.updates), /looking.*inspected/s);
  } finally {
    await loaded.close();
  }
});

test("resume restores state without replaying history, and close frees the session", async () => {
  let finish;
  const c = await client({
    runner: async (execution) => {
      await new Promise((resolve) => {
        finish = resolve;
        execution.signal.addEventListener("abort", resolve, { once: true });
      });
      return JSON.stringify({
        code: execution.signal.aborted ? 143 : 0,
        output: "",
        limitedOrCancelled: execution.signal.aborted,
      });
    },
  });
  respond = (_request, res) => reply(res, "hello");
  try {
    await c.prompt("hi");
  } finally {
    await c.close();
  }
  const resumed = await client({
    method: "session/resume",
    sessionId: c.id,
    cwd: c.cwd,
    runner: async (execution) => {
      await new Promise((resolve) => {
        finish = resolve;
        execution.signal.addEventListener("abort", resolve, { once: true });
      });
      return JSON.stringify({
        code: 143,
        output: "",
        limitedOrCancelled: true,
      });
    },
  });
  try {
    assert(resumed.response.configOptions.length > 0);
    assert.equal(resumed.response.modes.currentModeId, "code");
    assert(
      !resumed.updates.some((u) =>
        ["user_message_chunk", "agent_message_chunk", "tool_call"].includes(
          u.update.sessionUpdate,
        ),
      ),
    );
    assert.equal(resumed.state().messages.at(-1).content, "hello");
    // Start a background job, then close: the job stops and the slot is freed.
    respond = (request, res) =>
      afterTool(request)
        ? reply(res, "started")
        : reply(res, null, [
            call(
              "run_command",
              {
                executable: "ls",
                args: [],
                background: true,
                timeout_ms: 5000,
              },
              "job",
            ),
          ]);
    await resumed.prompt("start a job");
    await waitFor(() => resumed.executed.length === 1);
    const s = resumed.state();
    const length = s.messages.length;
    await resumed.prompt("/rewind 1");
    assert.match(
      texts(resumed.updates),
      /Stop background jobs before rewinding/,
    );
    assert.equal(s.messages.length, length);
    assert.deepEqual(
      await resumed.connection.agent.request("session/close", {
        sessionId: resumed.id,
      }),
      {},
    );
    assert.equal(resumed.agent.sessions.has(resumed.id), false);
    assert(resumed.executed[0].signal.aborted);
    assert.equal(s.jobs.list()[0].state, "stopped");
    await assert.rejects(resumed.prompt("after close"));
    // Closing again is harmless; the transcript stays loadable.
    await resumed.connection.agent.request("session/close", {
      sessionId: resumed.id,
    });
    const saved = await readJson(`session-${resumed.id}.json`);
    assert(saved.messages.some((m) => m.content === "start a job"));
  } finally {
    finish?.();
    await resumed.close();
  }
});

test("steering adds a message to the running turn after its tool step", async () => {
  const c = await client();
  await c.select("prompt_mode", "steer");
  const gate = deferred();
  respond = async (request, res) => {
    if (latestUser(request) === "first" && !afterTool(request)) {
      await gate.promise;
      return reply(res, null, [call("read_file", { path: "a.txt" }, "r1")]);
    }
    reply(res, `done ${latestUser(request)}`);
  };
  try {
    const first = c.prompt("first");
    await waitFor(() => requests.length === 1);
    const steer = c.prompt("also check b");
    await waitFor(() => c.state().turns.queued === 1);
    gate.resolve();
    const results = await Promise.all([first, steer]);
    assert.deepEqual(
      results.map((r) => r.stopReason),
      ["end_turn", "end_turn"],
    );
    assert.equal(requests.length, 2, "one turn, two model rounds");
    const messages = requests[1].messages;
    const toolIndex = messages.findIndex((m) => m.tool_call_id === "r1");
    assert(toolIndex > 0);
    assert.equal(messages.at(-1).role, "user");
    assert.equal(messages.at(-1).content, "also check b");
    assert.match(texts(c.updates), /1 steering message added/);
    const saved = await readJson(`session-${c.id}.json`);
    assert.equal(saved.promptMode, "steer");
  } finally {
    gate.resolve();
    await c.close();
  }
});

test("steering during the final reply continues the turn; commands are never absorbed", async () => {
  const c = await client();
  await c.select("prompt_mode", "steer");
  const gate = deferred();
  respond = async (request, res) => {
    if (latestUser(request) === "first") {
      await gate.promise;
      return reply(res, "first answer");
    }
    reply(res, `done ${latestUser(request)}`);
  };
  try {
    const first = c.prompt("first");
    await waitFor(() => requests.length === 1);
    const steer = c.prompt("and one more thing");
    const status = c.prompt("/status");
    await waitFor(() => c.state().turns.queued === 2);
    gate.resolve();
    const results = await Promise.all([first, steer, status]);
    assert.deepEqual(
      results.map((r) => r.stopReason),
      ["end_turn", "end_turn", "end_turn"],
    );
    assert.equal(requests.length, 2);
    assert.equal(latestUser(requests[1]), "and one more thing");
    assert(
      requests[1].messages.some((m) => m.content === "first answer"),
      "earlier final reply stays in context",
    );
    assert(!JSON.stringify(c.state().messages).includes("/status"));
    assert.match(texts(c.updates), /"mode":"steer"/);
  } finally {
    gate.resolve();
    await c.close();
  }
});

test("/queue steer selects steering and invalid modes are rejected", async () => {
  const c = await client();
  try {
    await c.prompt("/queue steer");
    assert.equal(c.state().promptMode, "steer");
    await assert.rejects(c.select("prompt_mode", "sometimes"));
    await c.prompt("/queue off");
    assert.equal(c.state().promptMode, "interrupt");
  } finally {
    await c.close();
  }
});

test("/rewind lists turns and restores agent edits from discarded turns", async () => {
  const c = await client();
  try {
    await twoEdits(c);
    c.updates.length = 0;
    await c.prompt("/rewind");
    assert.match(texts(c.updates), /1\. first edit \[1 agent edit\]/);
    assert.match(texts(c.updates), /2\. second edit \[1 agent edit\]/);
    const approvals = c.approvals.length;
    c.updates.length = 0;
    assert.equal((await c.prompt("/rewind 2")).stopReason, "end_turn");
    assert.equal(await readFile(join(c.cwd, "a.txt"), "utf8"), "one");
    const approval = c.approvals.at(-1);
    assert.equal(c.approvals.length, approvals + 1);
    assert.match(approval.toolCall.title, /^Rewind to before turn 2/);
    assert.equal(approval.toolCall.content[0].oldText, "two");
    assert.equal(approval.toolCall.content[0].newText, "one");
    const s = c.state();
    // Turn 1 is kept whole, including any verification note after its reply.
    assert.equal(
      s.messages.findLast((m) => m.role === "user").content,
      "first edit",
    );
    assert(s.messages.some((m) => m.content === "done first edit"));
    assert(!JSON.stringify(s.messages).includes("second edit"));
    assert.equal(s.checkpoints.length, 1);
    assert.match(texts(c.updates), /Rewound to before turn 2/);
    const saved = await readJson(`session-${c.id}.json`);
    assert(!JSON.stringify(saved.messages).includes("second edit"));
    assert.equal(Object.keys(saved.checkpointTurns).length, 1);
    // The next prompt continues from the shortened history.
    respond = (request, res) =>
      reply(res, `continued ${request.messages.length}`);
    await c.prompt("next");
    assert(!JSON.stringify(requests.at(-1)).includes("second edit"));
    assert.equal(latestUser(requests.at(-1)), "next");
  } finally {
    await c.close();
  }
});

test("/rewind never overwrites a later user change and --keep-files keeps files", async () => {
  const c = await client();
  try {
    await twoEdits(c);
    await writeFile(join(c.cwd, "a.txt"), "user change");
    const length = c.state().messages.length;
    c.updates.length = 0;
    const approvals = c.approvals.length;
    await c.prompt("/rewind 1");
    assert.match(texts(c.updates), /changed after the agent's last edit/);
    assert.equal(await readFile(join(c.cwd, "a.txt"), "utf8"), "user change");
    assert.equal(c.state().messages.length, length);
    assert.equal(c.approvals.length, approvals);
    c.updates.length = 0;
    await c.prompt("/rewind 2 --keep-files");
    assert.equal(await readFile(join(c.cwd, "a.txt"), "utf8"), "user change");
    assert(!JSON.stringify(c.state().messages).includes("second edit"));
    // Both edits remain for /undo; the kept one now belongs to turn 1.
    assert.equal(c.state().checkpoints.length, 2);
    assert.deepEqual(Object.values(c.state().checkpointTurns).sort(), [1, 1]);
    assert.match(texts(c.updates), /Files were left as they are/);
  } finally {
    await c.close();
  }
});

test("/rewind refuses in read-only mode and on bad arguments", async () => {
  const c = await client();
  try {
    await twoEdits(c);
    c.updates.length = 0;
    await c.prompt("/rewind 2 now");
    assert.match(texts(c.updates), /Use \/rewind/);
    await c.prompt("/rewind 9");
    assert.match(texts(c.updates), /Choose a turn from 1 to 2/);
    await c.select("permissions", "read_only");
    await c.prompt("/rewind 2");
    assert.match(texts(c.updates), /disabled in read-only mode/);
    assert.equal(await readFile(join(c.cwd, "a.txt"), "utf8"), "two");
    assert(JSON.stringify(c.state().messages).includes("second edit"));
  } finally {
    await c.close();
  }
});

test("rewinding an agent-created file needs a safe delete", async () => {
  const c = await client();
  respond = (request, res) =>
    afterTool(request)
      ? reply(res, "created")
      : reply(res, null, [
          call(
            "write_file",
            { path: "new.txt", before: null, after: "fresh" },
            "c1",
          ),
        ]);
  try {
    await c.prompt("create a file");
    c.updates.length = 0;
    await c.prompt("/rewind 1");
    if (process.platform === "linux") {
      await assert.rejects(readFile(join(c.cwd, "new.txt"), "utf8"));
      assert.match(texts(c.updates), /Rewound to before turn 1/);
    } else {
      assert.match(texts(c.updates), /safe removal is unavailable/);
      assert.equal(await readFile(join(c.cwd, "new.txt"), "utf8"), "fresh");
      // After the user deletes it, the rewind can proceed.
      const { rm } = await import("node:fs/promises");
      await rm(join(c.cwd, "new.txt"));
      c.updates.length = 0;
      await c.prompt("/rewind 1");
      assert.match(texts(c.updates), /1 file already matched/);
      assert.equal(c.state().checkpoints.length, 0);
    }
  } finally {
    await c.close();
  }
});

test("background job status updates the tool call, raises a notice and reaches the model once", async () => {
  const release = deferred();
  const c = await client({
    capabilities: { session: { notices: {} } },
    runner: async (_execution, output) => {
      await output("server ready\n");
      await release.promise;
      return JSON.stringify({
        code: 0,
        output: "server ready\nall tests passed\n",
        limitedOrCancelled: false,
      });
    },
  });
  respond = (request, res) => {
    if (latestUser(request) === "start" && !afterTool(request))
      return reply(res, null, [
        call(
          "run_command",
          {
            executable: "npm",
            args: ["test"],
            background: true,
            timeout_ms: 5000,
          },
          "bg",
        ),
      ]);
    reply(res, "ok");
  };
  try {
    await c.prompt("start");
    await waitFor(() =>
      c.updates.some(
        (u) =>
          u.update.toolCallId === "bg" &&
          u.update.status === "in_progress" &&
          JSON.stringify(u.update.content ?? []).includes("server ready"),
      ),
    );
    const progress = c.updates.find(
      (u) =>
        u.update.toolCallId === "bg" &&
        u.update.status === "in_progress" &&
        u.update.content?.length,
    );
    assert.match(
      progress.update.content[0].content.text,
      /^Background job [0-9a-f-]+: running, \d+s, \d+ output characters/,
    );
    release.resolve();
    await waitFor(() =>
      c.updates.some((u) => u.update.sessionUpdate === "notice"),
    );
    const final = c.updates.findLast((u) => u.update.toolCallId === "bg");
    assert.equal(final.update.status, "completed");
    assert.match(final.update.content[0].content.text, /all tests passed/);
    const notice = c.updates.find((u) => u.update.sessionUpdate === "notice");
    assert.equal(notice.update.severity, "info");
    assert.equal(notice.update.title, "Background job completed");
    await c.prompt("what happened");
    const note = requests
      .at(-1)
      .messages.find((m) => m.content?.startsWith("[Background job status"));
    assert(note, "finished job is reported to the model");
    assert.equal(note.role, "assistant");
    assert.match(note.content, /completed, exit code 0/);
    await c.prompt("and now");
    assert.equal(
      requests
        .at(-1)
        .messages.filter((m) => m.content?.startsWith("[Background job status"))
        .length,
      1,
      "reported once",
    );
  } finally {
    release.resolve();
    await c.close();
  }
});

test("without the notices capability no notice is sent", async () => {
  const c = await client({
    runner: async () =>
      JSON.stringify({ code: 1, output: "boom", limitedOrCancelled: false }),
  });
  respond = (request, res) =>
    afterTool(request)
      ? reply(res, "ok")
      : reply(res, null, [
          call(
            "run_command",
            { executable: "ls", args: [], background: true, timeout_ms: 5000 },
            "bg",
          ),
        ]);
  try {
    await c.prompt("start");
    await waitFor(() =>
      c.updates.some(
        (u) => u.update.toolCallId === "bg" && u.update.status === "failed",
      ),
    );
    assert(!c.updates.some((u) => u.update.sessionUpdate === "notice"));
  } finally {
    await c.close();
  }
});
