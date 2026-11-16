import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import http from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { createOwnedConnection } from "../connection.mjs";
import { browserSettings } from "../settings.mjs";
import { startHttpServer } from "../server.mjs";

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function fakeBrowser({
  launchGate,
  contextGate,
  closeGate,
  failContext = false,
} = {}) {
  const browser = new EventEmitter();
  const context = new EventEmitter();
  const counts = { launch: 0, contexts: 0, closed: 0, reaped: 0 };
  const launched = [];
  const chromium = {
    launch: async (options) => {
      counts.launch++;
      launched.push(options);
      await launchGate?.promise;
      return browser;
    },
  };
  browser.newContext = async (options) => {
    counts.contexts++;
    assert.equal(options.acceptDownloads, false);
    assert.equal(options.serviceWorkers, "block");
    await contextGate?.promise;
    if (failContext) throw new Error("Context could not start");
    return context;
  };
  browser.close = async () => {
    counts.closed++;
    await closeGate?.promise;
    counts.reaped++;
    context.emit("close");
    browser.emit("disconnected");
  };
  return { browser, context, counts, chromium, launched };
}
async function fixture(fake, factory, { confined, environment } = {}) {
  let getter;
  let effective;
  const settings = browserSettings("/tmp/owned-browser-fixture", environment);
  const connection = await createOwnedConnection({
    chromium: fake.chromium,
    settings,
    confined,
    createConnection: async (config, getContext) => {
      effective = config;
      getter = getContext;
      return factory
        ? factory(getContext)
        : {
            close: async () => {},
            connect: async () => {},
          };
    },
  });
  return { connection, getContext: () => getter(), effective, settings };
}

test("owned browser launches lazily into a fresh context and is awaited on close", async () => {
  const closeGate = deferred();
  const fake = fakeBrowser({ closeGate });
  const f = await fixture(fake);
  assert.equal(fake.counts.launch, 0);
  assert.equal(f.settings.browser.isolated, true);
  assert.equal(
    f.effective.browser.isolated,
    false,
    "MCP must use our supplied nonpersistent context",
  );
  assert.equal(f.effective.browser.userDataDir, undefined);
  assert.equal(await f.getContext(), fake.context);
  assert.equal(await f.getContext(), fake.context);
  assert.equal(fake.counts.launch, 1);
  let finished = false;
  const closing = f.connection.close().then(() => {
    finished = true;
  });
  await delay(0);
  assert.equal(fake.counts.closed, 1);
  assert.equal(finished, false);
  closeGate.resolve();
  await closing;
  assert.equal(fake.counts.reaped, 1);
  await f.connection.close();
  assert.equal(fake.counts.closed, 1);
  await assert.rejects(f.getContext(), /session is closed/);
});

test("closing while launch is pending releases the late browser without creating a context", async () => {
  const launchGate = deferred();
  const fake = fakeBrowser({ launchGate });
  const f = await fixture(fake);
  const opening = f.getContext();
  const rejected = assert.rejects(opening, /session is closed/);
  const closing = f.connection.close();
  launchGate.resolve();
  await Promise.all([closing, rejected]);
  assert.deepEqual(fake.counts, {
    launch: 1,
    contexts: 0,
    closed: 1,
    reaped: 1,
  });
});

test("closing while context creation is pending closes its browser immediately", async () => {
  const contextGate = deferred();
  const fake = fakeBrowser({ contextGate });
  const f = await fixture(fake);
  const opening = f.getContext();
  const rejected = assert.rejects(opening, /session is closed/);
  await delay(0);
  const closing = f.connection.close();
  await delay(0);
  assert.equal(fake.counts.reaped, 1);
  contextGate.resolve();
  await Promise.all([closing, rejected]);
  assert.equal(fake.counts.closed, 1);
});

test("failed context creation and a transport close both release the owned process", async () => {
  const failed = fakeBrowser({ failContext: true });
  const f = await fixture(failed);
  await assert.rejects(f.getContext(), /Context could not start/);
  assert.equal(failed.counts.reaped, 1);
  await f.connection.close();
  const connected = fakeBrowser();
  const g = await fixture(connected);
  await g.getContext();
  g.connection.onclose();
  await g.connection.close();
  assert.equal(connected.counts.reaped, 1);
});

// One GET through a proxy, as a browser sends it.
function proxied(proxy, target) {
  const { hostname, port } = new URL(proxy.server);
  return new Promise((resolve, reject) => {
    const request = http.request(
      { host: hostname, port, path: target },
      (response) => {
        let body = "";
        response.on("data", (chunk) => (body += chunk));
        response.on("end", () => resolve([response.statusCode, body]));
      },
    );
    request.on("error", reject);
    request.end();
  });
}

test("an ordinary connection launches Chromium with the configured options", async () => {
  const environment = { HTTP_PROXY: "http://localhost:1234" };
  const fake = fakeBrowser();
  const f = await fixture(fake, undefined, { environment });
  await f.getContext();
  assert.equal(fake.launched.length, 1);
  assert.equal(fake.launched[0], f.settings.browser.launchOptions);
  assert.equal(fake.launched[0].proxy.server, "http://localhost:1234");
  await f.connection.close();
});

test("a confined connection launches Chromium behind a boundary that only client navigation opens", async () => {
  const page = http.createServer((_req, res) => res.end("opened page"));
  await new Promise((resolve) => page.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${page.address().port}`;
  const fake = fakeBrowser();
  // A configured proxy does not carry a confined session.
  const f = await fixture(fake, undefined, {
    confined: true,
    environment: { HTTP_PROXY: "http://localhost:1234" },
  });
  try {
    assert.equal(fake.counts.launch, 0);
    const delivered = [];
    const transport = { onmessage: (message) => delivered.push(message) };
    await f.connection.connect(transport);
    await f.getContext();
    const { proxy, ...launch } = fake.launched[0];
    const { proxy: configured, ...expected } = f.settings.browser.launchOptions;
    assert.deepEqual(launch, expected);
    assert.equal(configured.server, "http://localhost:1234");
    assert.match(proxy.server, /^http:\/\/127\.0\.0\.1:[1-9]\d*$/);
    assert.equal(proxy.bypass, "<-loopback>");
    assert.deepEqual(Object.keys(proxy).sort(), ["bypass", "server"]);
    // Refused until the client itself navigates there; other MCP traffic and
    // page-controlled values never open an origin.
    for (const message of [
      { method: "tools/list" },
      {
        method: "tools/call",
        params: { name: "browser_type", arguments: { text: `${origin}/` } },
      },
    ])
      transport.onmessage(message);
    assert.equal((await proxied(proxy, `${origin}/`))[0], 403);
    const navigation = {
      method: "tools/call",
      params: { name: "browser_navigate", arguments: { url: `${origin}/` } },
    };
    transport.onmessage(navigation);
    assert.deepEqual(await proxied(proxy, `${origin}/`), [200, "opened page"]);
    // Every message still reaches the MCP server unchanged.
    assert.equal(delivered.length, 3);
    assert.equal(delivered[2], navigation);
    await f.connection.close();
    assert.equal(fake.counts.reaped, 1);
    await assert.rejects(proxied(proxy, `${origin}/`));
  } finally {
    await f.connection.close();
    page.closeAllConnections();
    await new Promise((resolve) => page.close(resolve));
  }
});

test("a confined connection that never starts leaves no boundary listening", async () => {
  const fake = fakeBrowser();
  await assert.rejects(
    createOwnedConnection({
      chromium: fake.chromium,
      settings: browserSettings("/tmp/owned-browser-fixture"),
      confined: true,
      createConnection: async () => {
        throw new Error("MCP server could not start");
      },
    }),
    /MCP server could not start/,
  );
  assert.equal(fake.counts.launch, 0);
});

test("HTTP DELETE waits for owned Chromium cleanup across repeated sessions", async () => {
  let running = 0;
  let peak = 0;
  let launched = 0;
  const server = await startHttpServer({
    port: 0,
    createConnection: async () => {
      const fake = fakeBrowser();
      const launch = fake.chromium.launch;
      fake.chromium.launch = async () => {
        const browser = await launch();
        launched++;
        running++;
        peak = Math.max(peak, running);
        const close = browser.close;
        browser.close = async () => {
          await delay(10);
          await close();
          running--;
        };
        return browser;
      };
      const f = await fixture(fake, (getContext) => {
        const mcp = new Server(
          { name: "owned-browser-fixture", version: "0.1.0" },
          { capabilities: { tools: {} } },
        );
        mcp.setRequestHandler(CallToolRequestSchema, async () => {
          await getContext();
          return { content: [{ type: "text", text: "fresh context" }] };
        });
        return mcp;
      });
      return f.connection;
    },
  });
  try {
    for (let index = 0; index < 6; index++) {
      const transport = new StreamableHTTPClientTransport(new URL(server.url));
      const client = new Client({ name: "cleanup-test", version: "0.1.0" });
      try {
        await client.connect(transport);
        assert.equal(running, 0, "initialization must not launch Chromium");
        await client.callTool({ name: "fixture", arguments: {} });
        assert.equal(running, 1);
        await transport.terminateSession();
        assert.equal(running, 0, "DELETE must await process cleanup");
      } finally {
        await client.close();
      }
    }
    assert.equal(launched, 6);
    assert.equal(peak, 1);
  } finally {
    await server.close();
  }
});
