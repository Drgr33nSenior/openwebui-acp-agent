import test from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { createServer } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { Mcp } from "../dist/mcp.js";
import { mkdtemp, writeFile, realpath, access } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
const stdio = {
  name: "same-name",
  command: process.execPath,
  args: [resolve("test/fixtures/mcp.mjs")],
  env: [],
};
test("MCP stdio approval precedes startup, namespaces collisions, validates and calls tools", async () => {
  const m = new Mcp();
  let approvals = 0;
  try {
    await m.connect(
      [stdio, stdio],
      process.cwd(),
      async () => {
        assert.equal(m.clients.length, approvals);
        approvals++;
      },
      AbortSignal.timeout(10000),
    );
    assert.equal(approvals, 2);
    assert.deepEqual([...m.tools.keys()], ["mcp_0_0", "mcp_1_0"]);
    const tool = m.tools.get("mcp_0_0");
    assert(!tool.validate({ query: 8 }));
    assert(tool.validate({ query: "test" }));
    assert.match(
      await tool.call({ query: "test" }, AbortSignal.timeout(5000)),
      /fixture result test/,
    );
  } finally {
    await m.close();
  }
});
test("MCP startup denial and cancellation start no process", async () => {
  for (const cancelled of [true, false]) {
    const m = new Mcp();
    const controller = new AbortController();
    if (cancelled) controller.abort();
    await assert.rejects(
      m.connect(
        [stdio],
        process.cwd(),
        async () => {
          throw new Error("denied");
        },
        controller.signal,
      ),
    );
    assert.equal(m.clients.length, 0);
  }
});
test("MCP Streamable HTTP separates credentials and forbids redirects", async () => {
  let headers;
  const servers = [];
  const http = createServer(async (req, res) => {
    headers = req.headers;
    if (req.url === "/redirect") {
      res.writeHead(307, { Location: "/mcp" }).end();
      return;
    }
    const server = new McpServer({ name: "http-fixture", version: "1" });
    server.registerTool(
      "lookup",
      { inputSchema: { query: z.string() } },
      async ({ query }) => ({ content: [{ type: "text", text: query }] }),
    );
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    servers.push(server);
    await server.connect(transport);
    let body = "";
    for await (const c of req) body += c;
    await transport.handleRequest(
      req,
      res,
      body ? JSON.parse(body) : undefined,
    );
  });
  await new Promise((r) => http.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${http.address().port}`;
  const m = new Mcp();
  try {
    await m.connect(
      [
        {
          type: "http",
          name: "http",
          url: base + "/mcp",
          headers: [
            { name: "Authorization", value: "Bearer mcp-fixture-only" },
          ],
        },
      ],
      process.cwd(),
      async () => {},
      AbortSignal.timeout(10000),
    );
    assert.equal(headers.authorization, "Bearer mcp-fixture-only");
    assert.match(
      await m.tools
        .get("mcp_0_0")
        .call({ query: "lookup" }, AbortSignal.timeout(5000)),
      /lookup/,
    );
    await m.close();
    await assert.rejects(
      m.connect(
        [
          {
            type: "http",
            name: "redirect",
            url: base + "/redirect",
            headers: [],
          },
        ],
        process.cwd(),
        async () => {},
        AbortSignal.timeout(5000),
      ),
    );
  } finally {
    await m.close();
    await Promise.all(servers.map((s) => s.close()));
    await new Promise((r) => http.close(r));
  }
});

test("local MCP sandbox denies outside access, supplies only its own credential and bounds protocol frames", async () => {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), "ow-mcp-root-")));
  const outside = await realpath(
    await mkdtemp(join(tmpdir(), "ow-mcp-other-")),
  );
  const path = join(outside, "synthetic.txt");
  await writeFile(path, "synthetic fixture content");
  process.env.OPENWEBUI_API_KEY = "synthetic-agent-never-to-mcp";
  const m = new Mcp();
  const approvals = [];
  try {
    await m.connect(
      [
        {
          name: "restricted",
          command: process.execPath,
          args: [resolve("test/fixtures/sandbox-mcp.mjs")],
          env: [{ name: "MCP_FIXTURE_KEY", value: "synthetic-mcp-only" }],
        },
      ],
      cwd,
      async (label) => {
        approvals.push(label);
      },
      AbortSignal.timeout(15000),
    );
    assert.match(
      approvals[0],
      /sandbox read access to explicit program installation/,
    );
    assert(!approvals[0].includes("synthetic-mcp-only"));
    const result = JSON.parse(
      await m.tools.get("mcp_0_0").call({ path }, AbortSignal.timeout(5000)),
    );
    assert.deepEqual(JSON.parse(result.content[0].text), {
      read: false,
      write: false,
      ownCredential: true,
      agentCredential: false,
    });
    await assert.rejects(access(path + ".new"));
    await assert.rejects(
      m.tools.get("mcp_0_1").call({}, AbortSignal.timeout(5000)),
      /MCP call failed/,
    );
  } finally {
    await m.close();
  }
});
