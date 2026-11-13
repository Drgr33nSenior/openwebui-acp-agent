import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import {
  mkdtemp,
  realpath,
  writeFile,
  readFile,
  mkdir,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ClientApp } from "@agentclientprotocol/sdk";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { z } from "zod";

const temporary = await realpath(await mkdtemp(join(tmpdir(), "ow-verify-")));
process.env.OPENWEBUI_ACP_HOME = join(temporary, "state");
process.env.OPENWEBUI_API_KEY = "synthetic-verification-inference";
const { createAgent } = await import("../dist/agent.js");
const { configSchema, writeJson } = await import("../dist/config.js");
const { snapshotPolicy } = await import("../dist/policy.js");
const { changeTrust } = await import("../dist/workspace.js");
const {
  verificationSchema,
  fileProblemsResult,
  projectCheckResult,
  verificationCommands,
} = await import("../dist/verification.js");

const requests = [];
let respond;
const backend = createServer(async (req, res) => {
  res.setHeader("Content-Type", "application/json");
  if (req.url === "/api/models") {
    res.end(JSON.stringify({ data: [{ id: "fixture" }] }));
    return;
  }
  let body = "";
  for await (const part of req) body += part;
  assert(!body.includes("synthetic-ide-verification"));
  const request = JSON.parse(body);
  requests.push(request);
  await respond(request, res);
});
await new Promise((r) => backend.listen(0, "127.0.0.1", r));
const url = `http://127.0.0.1:${backend.address().port}`;
test.after(() => new Promise((r) => backend.close(r)));
test.beforeEach(() => {
  requests.length = 0;
  respond = (_request, res) => reply(res, "Finished.");
});

function reply(res, content, toolCalls) {
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
const tool = (name, args, id = name) => ({
  id,
  type: "function",
  function: { name, arguments: JSON.stringify(args) },
});
const edit = (after, before = "original", path = "a.txt", id = "edit") =>
  tool("write_file", { path, before, after }, id);
const problem = (description = "Fixture syntax error", severity = "ERROR") => ({
  severity,
  description,
  line: 2,
  column: 3,
});
const problemResult = (filePath, errors = [], extra = {}) => ({
  content: [
    { type: "text", text: JSON.stringify({ filePath, errors, ...extra }) },
  ],
});
const resultString = (code = 0, output = "check completed") =>
  JSON.stringify({ code, output, limitedOrCancelled: false });

async function ideFixture(workspace, diagnose, mutate) {
  const calls = [],
    mutations = [],
    connections = [];
  const server = createServer(async (req, res) => {
    if (req.method === "GET") {
      const mcp = new McpServer({ name: "diagnostic-fixture", version: "1" });
      mcp.registerTool(
        "get_file_problems",
        {
          inputSchema: {
            filePath: z.string(),
            errorsOnly: z.boolean().optional(),
            timeout: z.number().int().optional(),
            projectPath: z.string().optional(),
          },
        },
        async (args, extra) => {
          calls.push(args);
          return diagnose(args, extra);
        },
      );
      if (mutate)
        mcp.registerTool(
          "execute_terminal_command",
          {
            inputSchema: { command: z.string() },
          },
          async (args) => {
            mutations.push(args);
            return mutate(args);
          },
        );
      const transport = new SSEServerTransport("/messages", res);
      connections.push({ mcp, transport });
      await mcp.connect(transport);
      return;
    }
    const id = new URL(req.url, "http://localhost").searchParams.get(
      "sessionId",
    );
    const connection = connections.find((c) => c.transport.sessionId === id);
    if (!connection) return res.writeHead(404).end();
    await connection.transport.handlePostMessage(req, res);
  });
  await new Promise((r) => server.listen(0, "localhost", r));
  const port = server.address().port;
  return {
    calls,
    mutations,
    descriptor: {
      name: "ide-fixture",
      command: "/Applications/PyCharm.app/Contents/MacOS/pycharm",
      args: ["stdioMcpServer"],
      env: [
        { name: "IJ_MCP_SERVER_PROJECT_PATH", value: workspace },
        { name: "IJ_MCP_SERVER_PORT", value: String(port) },
        { name: "IJ_MCP_AUTH_TOKEN", value: "synthetic-ide-verification" },
      ],
    },
    generic: {
      name: "other-server",
      type: "sse",
      url: `http://localhost:${port}/sse`,
      headers: [],
    },
    close: async () => {
      await Promise.all(connections.map((c) => c.mcp.close()));
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
    },
  };
}

async function client({
  ide = true,
  generic = false,
  diagnose = ({ filePath }) => problemResult(filePath),
  mutate,
  choose = () => "once",
  verify = {},
  checks,
  policy,
  runner = async () => resultString(),
} = {}) {
  const cwd = await realpath(await mkdtemp(join(temporary, "workspace-")));
  await writeFile(join(cwd, "a.txt"), "original");
  const fixture = ide ? await ideFixture(cwd, diagnose, mutate) : undefined;
  await writeJson(
    "config.json",
    configSchema.parse({
      url,
      model: "fixture",
      verify: {
        ...verify,
        ...(checks ? { projects: [{ root: cwd, commands: checks }] } : {}),
      },
    }),
  );
  const agent = createAgent({
    sandboxCommand: runner,
    ...(policy ? { loadPolicy: async () => snapshotPolicy(policy) } : {}),
  });
  const app = new ClientApp(),
    updates = [],
    approvals = [];
  app.onNotification("session/update", ({ params }) =>
    updates.push(params.update),
  );
  app.onRequest("session/request_permission", async ({ params }) => {
    approvals.push(params);
    return { outcome: { outcome: "selected", optionId: await choose(params) } };
  });
  const connection = app.connect(agent.app);
  await connection.agent.request("initialize", {
    protocolVersion: 1,
    clientCapabilities: {},
  });
  const { sessionId } = await connection.agent.request("session/new", {
    cwd,
    mcpServers: fixture ? [generic ? fixture.generic : fixture.descriptor] : [],
  });
  return {
    cwd,
    fixture,
    approvals,
    updates,
    state: () => agent.sessions.get(sessionId),
    prompt: (text = "Edit the file") =>
      connection.agent.request("session/prompt", {
        sessionId,
        prompt: [{ type: "text", text }],
      }),
    cancel: () => connection.agent.notify("session/cancel", { sessionId }),
    select: (configId, value) =>
      connection.agent.request("session/set_config_option", {
        sessionId,
        configId,
        value,
      }),
    close: async () => {
      connection.close();
      await agent.close();
      await fixture?.close();
    },
  };
}
function paired(messages) {
  for (let i = 0; i < messages.length; i++) {
    assert.notEqual(messages[i].role, "tool", "orphan tool result");
    const calls = messages[i].tool_calls;
    if (!calls?.length) continue;
    const ids = new Set(calls.map((c) => c.id));
    for (let n = 0; n < calls.length; n++) {
      const result = messages[++i];
      assert.equal(result?.role, "tool");
      assert(
        ids.delete(result.tool_call_id),
        "result must correlate exactly once",
      );
    }
  }
}
const displayed = (c) =>
  c.updates
    .flatMap((u) => [
      u.content?.text ?? "",
      ...(Array.isArray(u.content)
        ? u.content.map((v) => v.content?.text ?? "")
        : []),
    ])
    .join("\n");

test("post-edit IDE errors feed a bounded fixing round with paired history and no per-diagnostic approval", async () => {
  const c = await client({
    diagnose: async ({ filePath }) =>
      problemResult(
        filePath,
        (await readFile(join(c.cwd, filePath), "utf8")) === "broken"
          ? [problem()]
          : [],
      ),
  });
  let round = 0;
  respond = (_request, res) => {
    switch (round++) {
      case 0:
        return reply(res, null, [edit("broken")]);
      case 1:
        return reply(res, "Initial edit finished.");
      case 2:
        return reply(res, null, [edit("fixed", "broken", "a.txt", "fix")]);
      default:
        return reply(res, "Corrected.");
    }
  };
  try {
    assert.equal((await c.prompt()).stopReason, "end_turn");
    assert.equal(await readFile(join(c.cwd, "a.txt"), "utf8"), "fixed");
    assert.equal(c.fixture.calls.length, 2);
    assert(
      c.fixture.calls.every(
        (a) => a.errorsOnly === true && a.projectPath === c.cwd,
      ),
    );
    assert.equal(requests.length, 4);
    assert.match(
      JSON.stringify(requests[2].messages),
      /a.txt:2:3 ERROR Fixture syntax error/,
    );
    assert(
      !requests[2].messages.some(
        (m) =>
          m.role === "system" && m.content.includes("Fixture syntax error"),
      ),
    );
    assert.equal(
      c.approvals.length,
      4,
      "workspace, MCP connection, edit, fix only",
    );
    assert(
      !c.approvals.some((a) => a.toolCall.title.includes("get_file_problems")),
    );
    const diagnosticCall = c
      .state()
      .messages.flatMap((m) => m.tool_calls ?? [])
      .find((call) => call.function.name === "mcp_0_0");
    assert(diagnosticCall);
    assert(
      c.updates.some(
        (u) =>
          u.sessionUpdate === "tool_call" &&
          u.toolCallId === diagnosticCall.id &&
          u.kind === "read" &&
          /IDE problems/.test(u.title),
      ),
    );
    assert(
      c.updates.some(
        (u) =>
          u.sessionUpdate === "tool_call_update" &&
          u.toolCallId === diagnosticCall.id &&
          u.status === "completed",
      ),
    );
    paired(c.state().messages);
  } finally {
    await c.close();
  }
});

test("read-only turns do not trigger automatic diagnostics", async () => {
  const c = await client();
  let round = 0;
  respond = (_request, res) =>
    round++ === 0
      ? reply(res, null, [tool("read_file", { path: "a.txt" })])
      : reply(res, "Read complete.");
  try {
    assert.equal((await c.prompt("Read the file")).stopReason, "end_turn");
    assert.equal(c.fixture.calls.length, 0);
    assert.equal(requests.length, 2);
  } finally {
    await c.close();
  }
});

test("persistent diagnostics stop after the configured two fix rounds and remain visible", async () => {
  const c = await client({
    diagnose: ({ filePath }) =>
      problemResult(filePath, [problem("Persistent fixture failure")]),
  });
  let round = 0;
  respond = (_request, res) =>
    round++ === 0
      ? reply(res, null, [edit("changed")])
      : reply(res, "Finished.");
  try {
    assert.equal((await c.prompt()).stopReason, "end_turn");
    assert.equal(
      requests.length,
      4,
      "initial tool round, attempted completion and two fixes",
    );
    assert.equal(c.fixture.calls.length, 3);
    assert.match(displayed(c), /Persistent fixture failure/);
    paired(c.state().messages);
  } finally {
    await c.close();
  }
});

test("verification caps files, deduplicates diagnostics and bounds normalized output", async () => {
  const c = await client({
    verify: { maxFiles: 2, maxFixRounds: 0, maxOutputChars: 1000 },
    diagnose: ({ filePath }) =>
      problemResult(filePath, [
        problem(),
        problem(),
        ...Array.from({ length: 40 }, (_, i) =>
          problem(`${i} ${"x".repeat(100)}`),
        ),
      ]),
  });
  let round = 0;
  respond = (_request, res) =>
    round++ === 0
      ? reply(res, null, [
          edit("a"),
          edit("b", null, "b.txt", "b"),
          edit("c", null, "c.txt", "c"),
        ])
      : reply(res, "Done.");
  try {
    assert.equal((await c.prompt()).stopReason, "end_turn");
    assert.equal(c.fixture.calls.length, 2);
    assert.deepEqual(
      c.fixture.calls.map((a) => a.filePath),
      ["a.txt", "b.txt"],
    );
    const diagnosticIds = new Set(
      c
        .state()
        .messages.flatMap((m) => m.tool_calls ?? [])
        .filter((call) => call.function.name === "mcp_0_0")
        .map((call) => call.id),
    );
    const results = c
      .state()
      .messages.filter(
        (m) => m.role === "tool" && diagnosticIds.has(m.tool_call_id),
      );
    assert.equal(results.length, 2);
    assert(results.reduce((total, m) => total + m.content.length, 0) <= 1000);
    assert.equal(results[0].content.match(/Fixture syntax error/g)?.length, 1);
  } finally {
    await c.close();
  }
  const settings = verificationSchema.parse({ maxOutputChars: 1000 });
  const root = join(temporary, "normalizer"),
    file = join(root, "a.txt");
  const normalized = fileProblemsResult(
    JSON.stringify(
      problemResult("a.txt", [
        problem(),
        problem(),
        ...Array.from({ length: 40 }, (_, i) =>
          problem(`${i} ${"x".repeat(100)}`),
        ),
      ]),
    ),
    root,
    file,
    settings,
  );
  assert(normalized.failures);
  assert(normalized.text.length <= 1000);
  assert.equal(normalized.text.match(/Fixture syntax error/g)?.length, 1);
  assert.match(normalized.text, /truncated/);
});

test("malformed, wrong-file and timed-out IDE responses never establish a clean result", () => {
  const settings = verificationSchema.parse({}),
    root = join(temporary, "normalizer"),
    file = join(root, "a.txt");
  for (const raw of [
    "not-json",
    JSON.stringify({ isError: true }),
    JSON.stringify(problemResult("other.txt")),
    JSON.stringify(problemResult("a.txt", [], { timedOut: true })),
    JSON.stringify(problemResult("a.txt", [problem("unexpected", "UNKNOWN")])),
  ]) {
    const result = fileProblemsResult(raw, root, file, settings);
    assert.equal(result.unavailable, true);
    assert.match(result.text, /no clean result established/);
  }
  assert.equal(
    fileProblemsResult(
      JSON.stringify(problemResult("a.txt", [problem("warning", "WARNING")])),
      root,
      file,
      settings,
    ).failures,
    false,
  );
  assert.equal(
    fileProblemsResult(
      JSON.stringify(problemResult("a.txt", [problem("warning", "WARNING")])),
      root,
      file,
      { ...settings, includeWarnings: true },
    ).failures,
    true,
  );
  const check = projectCheckResult(
    resultString(1, "x".repeat(4000)),
    "npm test",
    1000,
  );
  assert(check.failures && check.text.length <= 1000);
});

test("a same-named tool from a non-IDE server retains per-call approval", async () => {
  const c = await client({ generic: true });
  let round = 0;
  respond = (_request, res) =>
    round++ === 0
      ? reply(res, null, [tool("mcp_0_0", { filePath: "a.txt" })])
      : reply(res, "Checked.");
  try {
    assert.equal((await c.prompt()).stopReason, "end_turn");
    const permission = c.approvals.find((a) =>
      a.toolCall.title.includes("get_file_problems"),
    );
    assert(permission);
    assert.deepEqual(
      permission.options.map((o) => o.optionId).filter((id) => id !== "deny"),
      ["once"],
    );
    assert.equal(c.fixture.calls.length, 1);
  } finally {
    await c.close();
  }
});

test("administrator always-ask policy overrides the IDE diagnostic exemption", async () => {
  const c = await client({
    policy: { version: 1, alwaysAsk: ["mcp-tool"] },
    choose: (p) =>
      p.toolCall.title.includes("get_file_problems") ? "deny" : "once",
  });
  let round = 0;
  respond = (_request, res) =>
    round++ === 0 ? reply(res, null, [edit("changed")]) : reply(res, "Done.");
  try {
    assert.equal((await c.prompt()).stopReason, "end_turn");
    assert(
      c.approvals.some((p) => p.toolCall.title.includes("get_file_problems")),
    );
    assert.equal(c.fixture.calls.length, 0);
    assert.match(displayed(c), /Verification incomplete/);
  } finally {
    await c.close();
  }
});

test(
  "workspace revocation during diagnostics prevents later checks and correction inference",
  { timeout: 10000 },
  async () => {
    const entered = Promise.withResolvers(),
      release = Promise.withResolvers();
    const c = await client({
      diagnose: async ({ filePath }) => {
        entered.resolve();
        await release.promise;
        return problemResult(filePath, [problem()]);
      },
    });
    let round = 0;
    respond = (_request, res) =>
      round++ === 0
        ? reply(res, null, [edit("changed"), edit("b", null, "b.txt", "b")])
        : reply(res, "Done.");
    let pending;
    try {
      pending = c.prompt();
      await entered.promise;
      await changeTrust(c.cwd, url, false);
      release.resolve();
      await pending;
      assert.equal(c.fixture.calls.length, 1);
      assert.equal(requests.length, 2);
      paired(c.state().messages);
    } finally {
      release.resolve();
      await pending?.catch(() => {});
      await c.close();
    }
  },
);

test("an edit without a connected IDE bridge skips diagnostics silently", async () => {
  const c = await client({ ide: false });
  let round = 0;
  respond = (_request, res) =>
    round++ === 0 ? reply(res, null, [edit("changed")]) : reply(res, "Done.");
  try {
    assert.equal((await c.prompt()).stopReason, "end_turn");
    assert.equal(requests.length, 2);
    assert(!/diagnostic|verification/i.test(displayed(c)));
  } finally {
    await c.close();
  }
});

for (const interrupt of [false, true])
  test(
    `${interrupt ? "replacement prompt" : "cancel"} stops a pending diagnostic without replay or orphan history`,
    { timeout: 10000 },
    async () => {
      const entered = Promise.withResolvers(),
        release = Promise.withResolvers();
      const c = await client({
        diagnose: async ({ filePath }) => {
          entered.resolve();
          await release.promise;
          return problemResult(filePath, [problem("late result")]);
        },
      });
      let round = 0;
      respond = (_request, res) =>
        round++ === 0
          ? reply(res, null, [edit("changed")])
          : reply(res, "Done.");
      let first;
      try {
        first = c.prompt();
        await entered.promise;
        const next = interrupt ? c.prompt("Replacement request") : c.cancel();
        assert.equal((await first).stopReason, "cancelled");
        if (interrupt) assert.equal((await next).stopReason, "end_turn");
        else await next;
        release.resolve();
        assert.equal(c.fixture.calls.length, 1);
        assert(!JSON.stringify(c.state().messages).includes("late result"));
        paired(c.state().messages);
      } finally {
        release.resolve();
        await first?.catch(() => {});
        await c.close();
      }
    },
  );

test("project checks are exact-root opt-ins and pass their timeout into the sandbox", async () => {
  const runs = [];
  const c = await client({
    ide: false,
    checks: [{ executable: "npm", args: ["test"], timeout_ms: 450000 }],
    runner: async (...args) => {
      runs.push(args);
      return resultString();
    },
  });
  let round = 0;
  respond = (_request, res) =>
    round++ === 0 ? reply(res, null, [edit("changed")]) : reply(res, "Done.");
  try {
    assert.equal((await c.prompt()).stopReason, "end_turn");
    assert.equal(runs.length, 1);
    assert.equal(runs[0][0], "npm");
    assert.deepEqual(runs[0][1], ["test"]);
    assert.equal(runs[0][2].mode, "workspace");
    assert.equal(runs[0][2].root, c.cwd);
    assert.equal(runs[0][4].timeoutMs, 450000);
    assert(c.approvals.some((a) => a.toolCall.title.includes("npm")));
    const sibling = await realpath(await mkdtemp(join(temporary, "other-")));
    const settings = verificationSchema.parse({
      projects: [
        { root: c.cwd, commands: [{ executable: "npm", args: ["test"] }] },
      ],
    });
    assert.equal(
      (await verificationCommands(settings, c.cwd))[0].timeout_ms,
      120000,
    );
    assert.deepEqual(await verificationCommands(settings, sibling), []);
    await mkdir(join(c.cwd, "nested"));
    assert.deepEqual(
      await verificationCommands(settings, join(c.cwd, "nested")),
      [],
    );
  } finally {
    await c.close();
  }
});

test("failed project checks reach the model and are checked again after its repair", async () => {
  let runs = 0;
  const c = await client({
    ide: false,
    checks: [{ executable: "npm", args: ["test"] }],
    runner: async () =>
      ++runs === 1 ? resultString(1, "Fixture lint failed") : resultString(),
  });
  let round = 0;
  respond = (_request, res) => {
    switch (round++) {
      case 0:
        return reply(res, null, [edit("broken")]);
      case 1:
        return reply(res, "Done.");
      case 2:
        return reply(res, null, [edit("fixed", "broken", "a.txt", "repair")]);
      default:
        return reply(res, "Fixed.");
    }
  };
  try {
    assert.equal((await c.prompt()).stopReason, "end_turn");
    assert.equal(runs, 2);
    assert.equal(requests.length, 4);
    assert.match(JSON.stringify(requests[2].messages), /Fixture lint failed/);
    assert.equal(await readFile(join(c.cwd, "a.txt"), "utf8"), "fixed");
    paired(c.state().messages);
  } finally {
    await c.close();
  }
});

test("approved IDE mutations invalidate cached project checks even if the remote tool reports failure", async () => {
  let runs = 0;
  const c = await client({
    checks: [{ executable: "npm", args: ["test"] }],
    runner: async () =>
      ++runs === 1 ? resultString(1, "Fixture check failed") : resultString(),
    mutate: async () => {
      await writeFile(join(c.cwd, "a.txt"), "fixed by IDE");
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: "Fixture reports failure after a partial mutation",
          },
        ],
      };
    },
  });
  let round = 0;
  respond = (request, res) => {
    switch (round++) {
      case 0:
        return reply(res, null, [edit("broken")]);
      case 1:
        return reply(res, "Done.");
      case 2: {
        const name = request.tools.find((t) =>
          t.function.description.includes("execute_terminal_command"),
        ).function.name;
        return reply(res, null, [
          tool(name, { command: "fixture repair" }, "ide-repair"),
        ]);
      }
      default:
        return reply(res, "Fixed.");
    }
  };
  try {
    assert.equal((await c.prompt()).stopReason, "end_turn");
    assert.equal(runs, 2);
    assert.equal(requests.length, 4);
    assert.equal(c.fixture.mutations.length, 1);
    const approval = c.approvals.find((p) =>
      p.toolCall.title.includes("execute_terminal_command"),
    );
    assert(approval);
    assert.deepEqual(
      approval.options
        .filter((o) => o.optionId !== "deny")
        .map((o) => o.optionId),
      ["once"],
    );
    assert.equal(await readFile(join(c.cwd, "a.txt"), "utf8"), "fixed by IDE");
    paired(c.state().messages);
  } finally {
    await c.close();
  }
});

test("a timed-out diagnostic with errors is not replayed or treated as current after a repair", async () => {
  const c = await client({
    diagnose: ({ filePath }) =>
      problemResult(filePath, [problem("Incomplete fixture error")], {
        timedOut: true,
      }),
  });
  let round = 0;
  respond = (_request, res) => {
    switch (round++) {
      case 0:
        return reply(res, null, [edit("broken")]);
      case 1:
        return reply(res, "Done.");
      case 2:
        return reply(res, null, [edit("fixed", "broken", "a.txt", "repair")]);
      default:
        return reply(res, "Fixed.");
    }
  };
  try {
    assert.equal((await c.prompt()).stopReason, "end_turn");
    assert.equal(requests.length, 4);
    assert.equal(c.fixture.calls.length, 1);
    assert.match(
      JSON.stringify(requests[2].messages),
      /Incomplete fixture error/,
    );
    const lastText = c.updates
      .filter((u) => u.sessionUpdate === "agent_message_chunk")
      .at(-1).content.text;
    assert.match(lastText, /^\s*Verification incomplete\./);
    assert.match(lastText, /Previous incomplete check/);
    assert(!lastText.includes("remaining problems"));
    assert(
      lastText.indexOf("Previous incomplete check") <
        lastText.indexOf("Incomplete fixture error"),
    );
    paired(c.state().messages);
  } finally {
    await c.close();
  }
});

test("unchanged repairs reuse failed project results and never repeat a declined check", async () => {
  for (const decline of [false, true]) {
    const requestsBefore = requests.length;
    let runs = 0;
    const c = await client({
      ide: decline,
      diagnose: ({ filePath }) => problemResult(filePath, [problem()]),
      checks: [{ executable: "npm", args: ["test"] }],
      choose: (p) =>
        decline && p.toolCall.title.includes("npm") ? "deny" : "once",
      runner: async () => {
        runs++;
        return resultString(1, "Fixture lint failed");
      },
    });
    let round = 0;
    respond = (_request, res) =>
      round++ === 0 ? reply(res, null, [edit("changed")]) : reply(res, "Done.");
    try {
      assert.equal((await c.prompt()).stopReason, "end_turn");
      assert.equal(requests.length - requestsBefore, 4);
      assert.equal(runs, decline ? 0 : 1);
      assert.equal(
        c.approvals.filter((p) => p.toolCall.title.includes("npm")).length,
        1,
      );
    } finally {
      await c.close();
    }
  }
});

test("declined project checks and full-access mode never automatically execute a check", async () => {
  for (const fullAccess of [false, true]) {
    let runs = 0;
    const c = await client({
      ide: false,
      checks: [{ executable: "npm", args: ["test"] }],
      choose: (p) => (p.toolCall.title.includes("npm") ? "deny" : "once"),
      runner: async () => {
        runs++;
        return resultString();
      },
    });
    let round = 0;
    respond = (_request, res) =>
      round++ === 0 ? reply(res, null, [edit("changed")]) : reply(res, "Done.");
    try {
      if (fullAccess) await c.select("sandbox", "full_access");
      assert.equal((await c.prompt()).stopReason, "end_turn");
      assert.equal(runs, 0);
      assert.match(displayed(c), /Verification incomplete/);
      if (fullAccess)
        assert(!c.approvals.some((p) => p.toolCall.title.includes("npm")));
    } finally {
      await c.close();
    }
  }
});

test("run_command forwards validated per-call timeout and uses the two-minute default", async () => {
  const runs = [];
  const c = await client({
    ide: false,
    runner: async (...args) => {
      runs.push(args);
      return resultString();
    },
  });
  let round = 0;
  respond = (_request, res) =>
    round++ === 0
      ? reply(res, null, [
          tool(
            "run_command",
            { executable: "npm", args: ["test"], timeout_ms: 600000 },
            "explicit",
          ),
          tool("run_command", { executable: "npm", args: ["test"] }, "default"),
          tool(
            "run_command",
            { executable: "npm", args: ["test"], timeout_ms: 600001 },
            "invalid",
          ),
        ])
      : reply(res, "Done.");
  try {
    assert.equal((await c.prompt()).stopReason, "end_turn");
    assert.deepEqual(
      runs.map((args) => args[4].timeoutMs),
      [600000, 120000],
    );
  } finally {
    await c.close();
  }
});
