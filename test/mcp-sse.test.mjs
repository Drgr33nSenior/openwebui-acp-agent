import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { z } from "zod";
import {
  ideMcpConnection,
  mcpSecrets,
  isIdeFileProblemsTool,
  ideFileProblemsArguments,
} from "../dist/ide-mcp.js";
import {
  link,
  mkdtemp,
  mkdir,
  realpath,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClientApp } from "@agentclientprotocol/sdk";
const temporary = await mkdtemp(join(tmpdir(), "ow-sse-"));
process.env.OPENWEBUI_ACP_HOME = join(temporary, "state");
process.env.OPENWEBUI_API_KEY = "synthetic-inference-only";
const { Mcp } = await import("../dist/mcp.js");
const { createAgent } = await import("../dist/agent.js");
const { configSchema, writeJson } = await import("../dist/config.js");
const { snapshotPolicy } = await import("../dist/policy.js");

function descriptor(port) {
  return {
    name: "ide-fixture",
    command: "/Applications/PyCharm.app/Contents/MacOS/pycharm",
    args: ["stdioMcpServer"],
    env: [
      { name: "IJ_MCP_SERVER_PORT", value: String(port) },
      { name: "IJ_MCP_SERVER_PROJECT_PATH", value: "/synthetic/project" },
      { name: "IJ_MCP_AUTH_TOKEN", value: "synthetic-ide-only" },
      { name: "IJ_MCP_ALLOWED_TOOLS", value: "lookup" },
      { name: "IJ_MCP_HEADER_X-Fixture", value: "synthetic-extra" },
      { name: "IJ_MCP_DEBUG", value: "false" },
    ],
  };
}

async function fixture(mode = "normal") {
  const requests = [];
  const connections = [];
  const http = createServer(async (req, res) => {
    requests.push({ url: req.url, headers: req.headers });
    if (mode === "401") return res.writeHead(401).end("synthetic-secret");
    if (mode === "redirect")
      return res.writeHead(307, { Location: "/unexpected" }).end();
    if (req.method === "GET") {
      if (["origin", "stall", "malformed"].includes(mode)) {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.write(": fixture\n\n");
        if (mode === "origin")
          res.write("event: endpoint\ndata: http://127.0.0.1:1/stolen\n\n");
        if (mode === "malformed") res.write("data: not-json\n\n");
        return;
      }
      const server = new McpServer({ name: "sse-fixture", version: "1" });
      server.registerTool(
        "lookup",
        { inputSchema: { query: z.string() } },
        async ({ query }) => ({ content: [{ type: "text", text: query }] }),
      );
      if (mode === "diagnostics")
        for (const name of [
          "get_file_problems",
          "execute_terminal_command",
          "get_run_configurations",
          "execute_run_configuration",
          "rename_refactoring",
          "write_file",
        ])
          server.registerTool(
            name,
            {
              inputSchema: {
                filePath: z.string(),
                errorsOnly: z.boolean().optional(),
                timeout: z.number().int().optional(),
                projectPath: z.string().optional(),
              },
              annotations: { readOnlyHint: true },
            },
            async ({ filePath }) => ({
              content: [
                {
                  type: "text",
                  text: JSON.stringify({ filePath, errors: [] }),
                },
              ],
            }),
          );
      const transport = new SSEServerTransport("/messages", res);
      connections.push({ server, transport, res });
      await server.connect(transport);
    } else {
      const id = new URL(req.url, "http://localhost").searchParams.get(
        "sessionId",
      );
      const connection = connections.find((c) => c.transport.sessionId === id);
      if (!connection) return res.writeHead(404).end();
      await connection.transport.handlePostMessage(req, res);
    }
  });
  await new Promise((r) => http.listen(0, "localhost", r));
  return {
    port: http.address().port,
    requests,
    connections,
    async close() {
      await Promise.all(connections.map((c) => c.server.close()));
      http.closeAllConnections();
      await new Promise((r) => http.close(r));
    },
  };
}

test("IDE bridge mapping preserves project, token and header semantics without executing a process", async () => {
  const f = await fixture();
  const m = new Mcp();
  const source = descriptor(f.port);
  try {
    await m.connect(
      [source],
      "/synthetic/project",
      async (label, server, paths, original) => {
        assert.equal(f.requests.length, 0);
        assert.equal(original, source);
        assert.equal(server.type, "sse");
        assert.equal(server.url, `http://localhost:${f.port}/sse`);
        assert.deepEqual(paths, []);
        assert.match(label, /direct IDE connection/);
        assert.match(label, /IDE project: \/synthetic\/project/);
        assert(!label.includes("synthetic-ide-only"));
        assert(!label.includes("synthetic-extra"));
      },
      AbortSignal.timeout(5000),
    );
    assert.match(
      await m.tools
        .get("mcp_0_0")
        .call({ query: "fixture success" }, AbortSignal.timeout(3000)),
      /fixture success/,
    );
    assert.deepEqual(m.tools.get("mcp_0_0").identity.source, source);
    assert(f.requests.length >= 4);
    for (const { headers } of f.requests) {
      assert.equal(headers.ij_mcp_auth_token, "synthetic-ide-only");
      assert.equal(headers.ij_mcp_server_project_path, "/synthetic/project");
      assert.equal(headers.ij_mcp_allowed_tools, "lookup");
      assert.equal(headers["x-fixture"], "synthetic-extra");
      assert.equal(headers.ij_mcp_server_port, String(f.port));
      assert.equal(headers.ij_mcp_debug, undefined);
      assert.equal(headers.authorization, undefined);
    }
  } finally {
    await m.close();
    await f.close();
  }
});

test("only verified IDE routing fields are excluded from MCP secret redaction", () => {
  const ide = descriptor(4321);
  assert.deepEqual(mcpSecrets([ide]), [
    "synthetic-ide-only",
    "lookup",
    "synthetic-extra",
  ]);
  for (const other of [
    { ...ide, command: "/arbitrary/program" },
    descriptor(0),
  ])
    assert.deepEqual(
      mcpSecrets([other]),
      other.env.map((e) => e.value),
    );
  const http = {
    type: "http",
    name: "remote",
    url: "https://example.com/mcp",
    headers: [{ name: "Authorization", value: "synthetic-http-key" }],
  };
  assert.deepEqual(mcpSecrets([http]), ["synthetic-http-key"]);
});

test("only the exact observed IDE file-problems schema qualifies for diagnostics", () => {
  const tool = {
    name: "get_file_problems",
    inputSchema: {
      type: "object",
      properties: {
        filePath: { type: "string" },
        errorsOnly: { type: "boolean" },
        projectPath: { type: "string" },
        timeout: { type: "integer" },
      },
      required: ["filePath"],
    },
  };
  assert.equal(isIdeFileProblemsTool(tool), true);
  for (const name of [
    "get_file_problems_extra",
    "execute_terminal_command",
    "get_run_configurations",
    "execute_run_configuration",
    "rename_refactoring",
  ])
    assert.equal(isIdeFileProblemsTool({ ...tool, name }), false);
  for (const change of [
    { required: [] },
    { required: ["filePath", "projectPath"] },
    {
      properties: {
        ...tool.inputSchema.properties,
        execute: { type: "boolean" },
      },
    },
    {
      properties: {
        ...tool.inputSchema.properties,
        timeout: { type: "string" },
      },
    },
    { properties: { filePath: { type: "string" } } },
  ])
    assert.equal(
      isIdeFileProblemsTool({
        ...tool,
        inputSchema: { ...tool.inputSchema, ...change },
      }),
      false,
    );
});

test("IDE diagnostic identity requires ACP provenance, canonical workspace and exact tool; annotations grant nothing", async () => {
  const workspace = await realpath(
    await mkdtemp(join(temporary, "diagnostics-")),
  );
  const other = await realpath(
    await mkdtemp(join(temporary, "other-project-")),
  );
  const f = await fixture("diagnostics");
  const source = descriptor(f.port);
  source.env.find((e) => e.name === "IJ_MCP_SERVER_PROJECT_PATH").value =
    workspace;
  const direct = ideMcpConnection(source);
  const wrongProject = structuredClone(source);
  wrongProject.env.find((e) => e.name === "IJ_MCP_SERVER_PROJECT_PATH").value =
    other;
  try {
    for (const [servers, provenance, expected] of [
      [[source], [source], true],
      [[source], [], false],
      [[source], [structuredClone(source)], false],
      [[direct], [direct], false],
      [[wrongProject], [wrongProject], false],
    ]) {
      const m = new Mcp();
      let approvals = 0;
      try {
        await m.connect(
          servers,
          workspace,
          async () => approvals++,
          AbortSignal.timeout(5000),
          undefined,
          provenance,
        );
        assert.equal(approvals, 1);
        const tools = [...m.tools.values()];
        const problems = tools.find((t) =>
          t.label.endsWith("/get_file_problems"),
        );
        assert.equal(problems.unsandboxed, true);
        assert.deepEqual(
          problems.ideFileProblems,
          expected ? { projectPath: workspace } : undefined,
        );
        for (const tool of tools.filter((t) => t !== problems)) {
          assert.equal(tool.unsandboxed, true);
          assert.equal(tool.ideFileProblems, undefined, tool.label);
        }
      } finally {
        await m.close();
      }
    }
  } finally {
    await f.close();
  }
});

test("IDE diagnostic arguments pin the project and reject paths outside ordinary read scope", async () => {
  const workspace = await realpath(
    await mkdtemp(join(temporary, "diagnostic-paths-")),
  );
  const other = await realpath(
    await mkdtemp(join(temporary, "diagnostic-outside-")),
  );
  await writeFile(join(workspace, "code.ts"), "const valid = true;\n");
  await writeFile(join(other, "outside.ts"), "const outside = true;\n");
  await writeFile(join(workspace, "large.ts"), "x".repeat(100001));
  await mkdir(join(workspace, "directory"));
  assert.deepEqual(
    await ideFileProblemsArguments(workspace, { filePath: "code.ts" }),
    {
      filePath: "code.ts",
      projectPath: workspace,
      errorsOnly: true,
      timeout: 10000,
    },
  );
  assert.equal(
    (await ideFileProblemsArguments(workspace, { filePath: "not-saved.ts" }))
      .filePath,
    "not-saved.ts",
  );
  for (const input of [
    { filePath: join(other, "outside.ts") },
    { filePath: "../outside.ts" },
    { filePath: ".env" },
    { filePath: "directory" },
    { filePath: "large.ts" },
    { filePath: "code.ts", projectPath: other },
    { filePath: "code.ts", timeout: 30001 },
    { filePath: "code.ts", timeout: 0 },
    { filePath: "code.ts", execute: true },
    { filePath: "code.ts", errorsOnly: "false" },
  ])
    await assert.rejects(ideFileProblemsArguments(workspace, input));
  if (process.platform !== "win32") {
    await symlink(join(other, "outside.ts"), join(workspace, "escape.ts"));
    await assert.rejects(
      ideFileProblemsArguments(workspace, { filePath: "escape.ts" }),
      /Symlink/,
    );
    await symlink(workspace, join(other, "workspace-alias"));
    assert.equal(
      (
        await ideFileProblemsArguments(workspace, {
          filePath: "code.ts",
          projectPath: join(other, "workspace-alias"),
        })
      ).projectPath,
      workspace,
    );
    await assert.rejects(
      ideFileProblemsArguments(join(other, "workspace-alias"), {
        filePath: "code.ts",
      }),
      /workspace path changed/,
    );
    await link(join(other, "outside.ts"), join(workspace, "hardlink.ts"));
    await assert.rejects(
      ideFileProblemsArguments(workspace, { filePath: "hardlink.ts" }),
      /bounded workspace text file/,
    );
  }
});

test("IDE bridge recognition is narrow and rejects ambiguous or invalid descriptors", () => {
  const original = descriptor(4321);
  for (const change of [
    { command: "/usr/bin/pycharm" },
    { command: "/Applications/Other.app/Contents/MacOS/other" },
    { args: ["stdioMcpServer", "extra"] },
    {
      env: [...original.env, { name: "JAVA_TOOL_OPTIONS", value: "anything" }],
    },
  ]) {
    const s = { ...original, ...change };
    assert.equal(ideMcpConnection(s), s);
  }
  for (const port of [0, 65536, "123/evil", "00123"]) {
    assert.throws(() => ideMcpConnection(descriptor(port)), /Invalid IDE MCP/);
  }
  assert.throws(
    () =>
      ideMcpConnection({
        ...original,
        env: [
          ...original.env,
          { name: "IJ_MCP_HEADER_ij_mcp_auth_token", value: "duplicate" },
        ],
      }),
    /Ambiguous/,
  );
  assert.throws(() =>
    ideMcpConnection({
      ...original,
      env: [
        ...original.env,
        { name: "IJ_MCP_HEADER_X-Test", value: "bad\r\nheader" },
      ],
    }),
  );
});

test("SSE and IDE bridge denial or late cancelled approval cause no HTTP requests", async () => {
  const f = await fixture();
  try {
    for (const cancelled of [false, true]) {
      const m = new Mcp();
      const controller = new AbortController();
      await assert.rejects(
        m.connect(
          [descriptor(f.port)],
          process.cwd(),
          async () => {
            if (cancelled) controller.abort();
            else throw new Error("denied");
          },
          controller.signal,
        ),
      );
      assert.equal(m.clients.length, 0);
      assert.equal(f.requests.length, 0);
    }
  } finally {
    await f.close();
  }
});

test("SSE refuses auth failures, redirects, cross-origin endpoints and malformed events; cancellation stops stalled startup", async () => {
  for (const mode of ["401", "redirect", "origin", "stall", "malformed"]) {
    const f = await fixture(mode);
    const m = new Mcp();
    try {
      await assert.rejects(
        m.connect(
          [
            {
              type: "sse",
              name: "fixture",
              url: `http://localhost:${f.port}/sse`,
              headers: [
                { name: "Authorization", value: "Bearer synthetic-only" },
              ],
            },
          ],
          process.cwd(),
          async () => {},
          AbortSignal.timeout(500),
        ),
        (error) => {
          assert(!error.message.includes("synthetic"));
          return true;
        },
      );
      assert.equal(m.clients.length, 0);
      assert.equal(f.requests.length, 1);
      assert.equal(f.requests[0].url, "/sse");
    } finally {
      await m.close();
      await f.close();
    }
  }
});

test("SSE disconnect closes the connection without reconnecting or retrying a tool", async () => {
  const f = await fixture();
  const m = new Mcp();
  try {
    await m.connect(
      [ideMcpConnection(descriptor(f.port))],
      process.cwd(),
      async () => {},
      AbortSignal.timeout(5000),
    );
    f.connections[0].res.end();
    await delay(50);
    await assert.rejects(
      m.tools
        .get("mcp_0_0")
        .call({ query: "no retry" }, AbortSignal.timeout(1000)),
      /MCP call failed/,
    );
    assert.equal(f.requests.filter((r) => r.url === "/sse").length, 1);
  } finally {
    await m.close();
    await f.close();
  }
});

test("ACP IDE MCP approval precedes connection and each tool call; inference never receives MCP credentials", async () => {
  const f = await fixture();
  const workspace = join(temporary, "workspace");
  await mkdir(workspace);
  let round = 0;
  const backend = createServer(async (req, res) => {
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/api/models") {
      res.end(JSON.stringify({ data: [{ id: "fixture" }] }));
      return;
    }
    let body = "";
    for await (const chunk of req) body += chunk;
    assert(!body.includes("synthetic-ide-only"));
    assert(!body.includes("IJ_MCP_AUTH_TOKEN"));
    const message =
      round++ === 0
        ? {
            role: "assistant",
            tool_calls: [
              {
                id: "fixture-call",
                type: "function",
                function: {
                  name: "mcp_0_0",
                  arguments: '{"query":"fixture lookup"}',
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
  await new Promise((r) => backend.listen(0, "127.0.0.1", r));
  await writeJson(
    "config.json",
    configSchema.parse({
      url: `http://127.0.0.1:${backend.address().port}`,
      model: "fixture",
    }),
  );
  const agent = createAgent();
  const app = new ClientApp();
  const approvals = [];
  app.onNotification("session/update", () => {});
  app.onRequest("session/request_permission", ({ params }) => {
    const title = params.toolCall.title;
    approvals.push(title);
    assert(!JSON.stringify(params).includes("synthetic-ide-only"));
    if (approvals.length <= 2) assert.equal(f.requests.length, 0);
    if (approvals.length === 3) {
      assert.match(title, /lookup/);
      assert.match(title, /outside the sandbox/);
      assert.equal(round, 1);
      // IDE tools run on this machine outside the sandbox: no reusable grant.
      assert.deepEqual(
        params.options.map((o) => o.optionId).filter((id) => id !== "deny"),
        ["once"],
      );
    }
    return { outcome: { outcome: "selected", optionId: "once" } };
  });
  const connection = app.connect(agent.app);
  try {
    const init = await connection.agent.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: {},
    });
    assert.equal(init.agentCapabilities.mcpCapabilities.sse, true);
    const source = descriptor(f.port);
    source.env.find((e) => e.name === "IJ_MCP_SERVER_PROJECT_PATH").value =
      workspace;
    const session = await connection.agent.request("session/new", {
      cwd: workspace,
      mcpServers: [source],
    });
    await connection.agent.request("session/prompt", {
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: "Use the lookup tool" }],
    });
    assert.equal(round, 2);
    assert.equal(approvals.length, 3);
    assert.match(approvals[1], /direct IDE connection/);
    for (const restrictions of [
      { allowStdioMcp: false },
      { mcpHttpUrls: [] },
    ]) {
      const policy = snapshotPolicy({ version: 1, ...restrictions });
      const restricted = createAgent({ loadPolicy: async () => policy });
      const client = new ClientApp();
      const messages = [];
      client.onNotification("session/update", ({ params }) =>
        messages.push(params),
      );
      client.onRequest("session/request_permission", () => ({
        outcome: { outcome: "selected", optionId: "once" },
      }));
      const c = client.connect(restricted.app);
      const count = f.requests.length;
      try {
        await c.agent.request("initialize", {
          protocolVersion: 1,
          clientCapabilities: {},
        });
        const s = await c.agent.request("session/new", {
          cwd: workspace,
          mcpServers: [source],
        });
        await c.agent.request("session/prompt", {
          sessionId: s.sessionId,
          prompt: [{ type: "text", text: "Use lookup" }],
        });
        assert.equal(f.requests.length, count);
        assert.match(JSON.stringify(messages), /Administrator policy denies/);
        assert.equal(round, 2);
      } finally {
        c.close();
        await restricted.close();
      }
    }
  } finally {
    await agent.close();
    connection.close();
    await f.close();
    backend.closeAllConnections();
    await new Promise((r) => backend.close(r));
  }
});
