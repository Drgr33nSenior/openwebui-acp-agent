import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { startHttpServer } from "../server.mjs";

const initialize = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-11-25",
    clientInfo: { name: "fixture", version: "1" },
    capabilities: {},
  },
});
const headers = {
  "Content-Type": "application/json",
  Accept: "application/json, text/event-stream",
};
async function fixture({ delay = 0 } = {}) {
  let created = 0;
  const instances = [];
  const started = await startHttpServer({
    host: "127.0.0.1",
    port: 0,
    createConnection: async () => {
      if (delay) await new Promise((r) => setTimeout(r, delay));
      const id = ++created;
      const server = new Server(
        { name: "browser-fixture", version: "1" },
        { capabilities: { tools: {} } },
      );
      instances.push(server);
      server.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: [
          {
            name: "fixture",
            inputSchema: {
              type: "object",
              properties: {},
              additionalProperties: false,
            },
          },
        ],
      }));
      server.setRequestHandler(CallToolRequestSchema, async () => ({
        content: [{ type: "text", text: `session-${id}` }],
      }));
      return server;
    },
  });
  return { ...started, created: () => created, instances };
}
async function connect(url) {
  const transport = new StreamableHTTPClientTransport(new URL(url));
  const client = new Client({ name: "fixture", version: "1" });
  try {
    await client.connect(transport, { timeout: 2000 });
  } catch (error) {
    await client.close();
    throw error;
  }
  return {
    client,
    transport,
    close: async () => {
      await transport.terminateSession().catch(() => {});
      await client.close();
    },
  };
}

test("HTTP browser sessions work with the official SDK, stay isolated and release on DELETE", async () => {
  const server = await fixture();
  const clients = [];
  try {
    clients.push(await connect(server.url), await connect(server.url));
    const values = [];
    for (const { client } of clients) {
      assert.equal((await client.listTools()).tools[0].name, "fixture");
      values.push(
        (await client.callTool({ name: "fixture", arguments: {} })).content[0]
          .text,
      );
    }
    assert.notEqual(values[0], values[1]);
    await clients[0].close();
    clients.shift();
    clients.push(await connect(server.url));
    assert.equal(server.created(), 3);
  } finally {
    await Promise.all(clients.map((c) => c.close()));
    await server.close();
  }
});

test("Origin and cross-site metadata fail before creating a browser", async () => {
  const server = await fixture();
  try {
    for (const extra of [
      { Origin: "https://untrusted.example" },
      { Origin: "null" },
      { Origin: "" },
      { "Sec-Fetch-Site": "cross-site" },
      { "Sec-Fetch-Site": "same-site" },
    ]) {
      const response = await fetch(server.url, {
        method: "POST",
        headers: { ...headers, ...extra },
        body: initialize,
      });
      assert.ok(
        response.status >= 400 && response.status < 500,
        `must refuse ${Object.keys(extra).join(",")}`,
      );
      await response.body?.cancel();
    }
    assert.equal(server.created(), 0);
  } finally {
    await server.close();
  }
});

test("HTTP MCP rejects other paths, content types, oversized bodies and malformed JSON", async () => {
  const server = await fixture();
  try {
    for (const [suffix, contentType, body] of [
      ["/other", "application/json", initialize],
      ["", "text/plain", initialize],
      ["", "application/json", "x".repeat(256001)],
      ["", "application/json", "{broken"],
    ]) {
      const response = await fetch(server.url + suffix, {
        method: "POST",
        headers: { ...headers, "Content-Type": contentType },
        body,
      });
      assert.ok(response.status >= 400 && response.status < 500);
      await response.body?.cancel();
    }
    assert.equal(server.created(), 0);
  } finally {
    await server.close();
  }
});

function rawPost(url, requestHeaders) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const request = http.request(
      {
        hostname: u.hostname,
        port: u.port,
        path: u.pathname,
        method: "POST",
        setHost: false,
        headers: requestHeaders,
      },
      (response) => {
        response.resume();
        response.once("end", () => resolve(response.statusCode));
      },
    );
    request.on("error", reject);
    request.setTimeout(2000, () =>
      request.destroy(new Error("Fixture request timeout")),
    );
    request.end(initialize);
  });
}
test("invalid, missing or duplicated Host headers cannot reach browser initialization", async () => {
  const server = await fixture();
  const common = [
    "Content-Type",
    "application/json",
    "Accept",
    "application/json, text/event-stream",
    "Content-Length",
    String(Buffer.byteLength(initialize)),
  ];
  try {
    for (const requestHeaders of [
      common,
      ...[
        "untrusted.example",
        "localhost.untrusted.example",
        "localhost:8931@untrusted.example",
      ].map((host) => ["Host", host, ...common]),
      [
        "Host",
        new URL(server.url).host,
        "Host",
        "untrusted.example",
        ...common,
      ],
    ]) {
      const status = await rawPost(server.url, requestHeaders);
      assert.ok(status >= 400 && status < 500);
    }
    assert.equal(server.created(), 0);
  } finally {
    await server.close();
  }
});

test("concurrent initializations cannot exceed four sessions and DELETE frees capacity", async () => {
  const server = await fixture({ delay: 20 });
  const clients = [];
  try {
    const results = await Promise.allSettled(
      Array.from({ length: 5 }, () => connect(server.url)),
    );
    clients.push(
      ...results.filter((r) => r.status === "fulfilled").map((r) => r.value),
    );
    assert.equal(clients.length, 4);
    assert.equal(results.filter((r) => r.status === "rejected").length, 1);
    assert.equal(server.created(), 4);
    await clients.shift().close();
    clients.push(await connect(server.url));
    assert.equal(server.created(), 5);
  } finally {
    await Promise.all(clients.map((c) => c.close()));
    await server.close();
  }
});

test("closing the HTTP listener closes all owned MCP server connections", async () => {
  const server = await fixture();
  const connection = await connect(server.url);
  let closed = 0;
  const onclose = server.instances[0].onclose;
  server.instances[0].onclose = () => {
    closed++;
    onclose?.();
  };
  await server.close();
  try {
    assert.equal(closed, 1);
  } finally {
    await connection.client.close();
  }
});
