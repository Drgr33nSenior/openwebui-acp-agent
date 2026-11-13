import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
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
  const chromium = {
    launch: async () => {
      counts.launch++;
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
  return { browser, context, counts, chromium };
}
async function fixture(fake, factory) {
  let getter;
  let effective;
  const settings = browserSettings("/tmp/owned-browser-fixture");
  const connection = await createOwnedConnection({
    chromium: fake.chromium,
    settings,
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
