import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { t3McpConnection } from "../dist/t3-mcp.js";
import { mcpSecrets } from "../dist/ide-mcp.js";
import { Mcp } from "../dist/mcp.js";

function descriptor(url = "http://127.0.0.1:3773/mcp") {
  return {
    name: "t3-code",
    command: "/Applications/T3 Code (Beta).app/Contents/MacOS/T3 Code (Beta)",
    args: [
      "/Applications/T3 Code (Beta).app/Contents/Resources/app.asar/apps/server/dist/bin.mjs",
      "acp-mcp-bridge",
    ],
    env: [
      { name: "ELECTRON_RUN_AS_NODE", value: "1" },
      { name: "T3_ACP_MCP_ENDPOINT", value: url },
      { name: "T3_ACP_MCP_AUTHORIZATION", value: "Bearer synthetic-t3-only" },
    ],
  };
}

test("T3 Electron bridge maps only the verified descriptor to its loopback HTTP endpoint", () => {
  const source = descriptor();
  assert.deepEqual(t3McpConnection(source), {
    name: "t3-code",
    type: "http",
    url: "http://127.0.0.1:3773/mcp",
    headers: [{ name: "Authorization", value: "Bearer synthetic-t3-only" }],
  });
  for (const host of ["localhost", "[::1]"])
    assert.equal(
      t3McpConnection(descriptor(`http://${host}:3773/mcp`)).type,
      "http",
    );
  for (const change of [
    { name: "other-server" },
    { command: "/Applications/Other.app/Contents/MacOS/Other" },
    { args: [...source.args, "unexpected"] },
    { args: ["/unrelated/bin.mjs", "acp-mcp-bridge"] },
    { env: [...source.env, { name: "EXTRA_SECRET", value: "synthetic" }] },
    { env: source.env.slice(1) },
  ]) {
    const server = { ...source, ...change };
    assert.equal(t3McpConnection(server), server);
  }
  const remote = {
    type: "http",
    name: "t3-code",
    url: "https://example.com/mcp",
    headers: [],
  };
  assert.equal(t3McpConnection(remote), remote);
});

test("T3 descriptor rejects changed destinations, URL credentials, ambiguous fields and header injection", () => {
  for (const url of [
    "https://127.0.0.1:3773/mcp",
    "http://example.com:3773/mcp",
    "http://127.0.0.1.example.com:3773/mcp",
    "http://127.0.0.1:3773/other",
    "http://127.0.0.1:3773/mcp?token=synthetic",
    "http://127.0.0.1:3773/mcp#fragment",
    "http://user:synthetic@127.0.0.1:3773/mcp",
    "http://127.0.0.1/mcp",
    "invalid",
  ])
    assert.throws(() => t3McpConnection(descriptor(url)), /Invalid T3 MCP/);
  for (const [name, value] of [
    ["ELECTRON_RUN_AS_NODE", "0"],
    ["T3_ACP_MCP_AUTHORIZATION", "Bearer synthetic\r\nX-Secret: leak"],
    ["T3_ACP_MCP_AUTHORIZATION", ""],
  ]) {
    const source = descriptor();
    source.env.find((field) => field.name === name).value = value;
    assert.throws(() => t3McpConnection(source), /Invalid T3 MCP/);
  }
  const duplicate = descriptor();
  duplicate.env[0] = duplicate.env[1];
  assert.throws(() => t3McpConnection(duplicate), /Ambiguous T3 MCP/);
});

test("T3 credential redaction retains its token but not the public Electron flag", () => {
  const source = descriptor();
  assert.deepEqual(mcpSecrets([source]), [
    source.env[1].value,
    "Bearer synthetic-t3-only",
  ]);
  const unrelated = { ...source, name: "unverified" };
  assert(mcpSecrets([unrelated]).includes("1"));
  const invalid = descriptor("http://example.com:3773/mcp");
  assert(mcpSecrets([invalid]).includes("1"));
});

test("T3 direct connection requires client provenance and approval, preserves credentials and grants no diagnostic exemption", async () => {
  const requests = [];
  const servers = [];
  const http = createServer(async (request, response) => {
    requests.push(request.headers);
    const server = new McpServer({ name: "t3-fixture", version: "1" });
    server.registerTool("get_file_problems", { inputSchema: {} }, async () => ({
      content: [{ type: "text", text: "fixture" }],
    }));
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    servers.push(server);
    await server.connect(transport);
    let body = "";
    for await (const chunk of request) body += chunk;
    await transport.handleRequest(
      request,
      response,
      body ? JSON.parse(body) : undefined,
    );
  });
  await new Promise((resolve) => http.listen(0, "127.0.0.1", resolve));
  const source = descriptor(`http://127.0.0.1:${http.address().port}/mcp`);
  const mcp = new Mcp();
  try {
    for (const clientSupplied of [false, true]) {
      await assert.rejects(
        mcp.connect(
          [source],
          process.cwd(),
          async (_label, mapped, _readPaths, original) => {
            assert.equal("command" in mapped, !clientSupplied);
            assert.equal(original, clientSupplied ? source : undefined);
            throw new Error("denied before any connection");
          },
          AbortSignal.timeout(5000),
          undefined,
          clientSupplied ? [source] : [],
        ),
      );
      assert.equal(requests.length, 0);
    }
    await mcp.connect(
      [source],
      process.cwd(),
      async (label, mapped, readPaths, original) => {
        assert.equal(requests.length, 0);
        assert.equal(original, source);
        assert.equal(mapped.type, "http");
        assert.deepEqual(readPaths, []);
        assert.match(label, /direct T3 Code connection/);
        assert(!label.includes("synthetic-t3-only"));
      },
      AbortSignal.timeout(5000),
      undefined,
      [source],
    );
    const tool = mcp.tools.get("mcp_0_0");
    assert.equal(tool.unsandboxed, true);
    assert.equal(tool.ideFileProblems, undefined);
    assert.equal(tool.identity.source, source);
    assert.match(await tool.call({}, AbortSignal.timeout(5000)), /fixture/);
    assert(
      requests.every(
        (headers) => headers.authorization === "Bearer synthetic-t3-only",
      ),
    );
  } finally {
    await mcp.close();
    await Promise.all(servers.map((server) => server.close()));
    await new Promise((resolve) => http.close(resolve));
  }
});
