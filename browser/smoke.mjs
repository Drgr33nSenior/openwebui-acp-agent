import assert from "node:assert/strict";
import http from "node:http";
import { readFile } from "node:fs/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const args = process.argv.slice(2);
let endpoint = "http://127.0.0.1:8931/mcp";
let fixtureHost = "host.docker.internal";
for (let i = 0; i < args.length; i += 2) {
  if (args[i] === "--url" && args[i + 1]) endpoint = args[i + 1];
  else if (args[i] === "--fixture-host" && args[i + 1])
    fixtureHost = args[i + 1];
  else
    throw new Error(
      "Usage: node smoke.mjs [--url http://127.0.0.1:PORT/mcp] [--fixture-host host.docker.internal|127.0.0.1]",
    );
}
const url = new URL(endpoint);
assert.ok(
  url.protocol === "http:" &&
    ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) &&
    !url.username &&
    !url.password &&
    url.pathname === "/mcp" &&
    !url.search &&
    !url.hash,
  "Smoke endpoint must be local HTTP /mcp",
);
assert.ok(
  ["host.docker.internal", "127.0.0.1", "localhost"].includes(fixtureHost),
);
const allowed = JSON.parse(
  await readFile(new URL("./allowed-tools.json", import.meta.url), "utf8"),
);
let fixtureRequests = 0;
const fixture = http.createServer((_req, res) => {
  fixtureRequests++;
  res.writeHead(200, {
    "Content-Type": "text/html",
    "Cache-Control": "no-store",
  });
  res.end(`<!doctype html><html lang="en"><title>Browser fixture</title><label>Name<input aria-label="Name"></label><button>Save</button><output role="status">Fresh profile</output><script>
    const input = document.querySelector('input');
    const output = document.querySelector('output');
    input.value = localStorage.getItem('name') || '';
    if (input.value) output.textContent = 'Restored ' + input.value;
    document.querySelector('button').onclick = () => { localStorage.setItem('name', input.value); output.textContent = 'Saved ' + input.value; };
  </script></html>`);
});
await new Promise((resolve) => fixture.listen(0, "127.0.0.1", resolve));
const target = `http://${fixtureHost}:${fixture.address().port}/`;
async function connect() {
  const transport = new StreamableHTTPClientTransport(url, {
    fetch: (input, init) =>
      fetch(input, {
        ...init,
        redirect: "error",
        ...(init?.method === "DELETE"
          ? {
              signal: AbortSignal.any([
                ...(init.signal ? [init.signal] : []),
                AbortSignal.timeout(1000),
              ]),
            }
          : {}),
      }),
  });
  const client = new Client({
    name: "openwebui-browser-smoke",
    version: "0.1.0",
  });
  try {
    await client.connect(transport, { timeout: 15000 });
  } catch (error) {
    await client.close().catch(() => {});
    throw error;
  }
  return {
    client,
    close: async () => {
      await transport.terminateSession().catch(() => {});
      await client.close();
    },
  };
}
let session;
let calls = 0;
async function call(name, arguments_) {
  assert.ok(
    allowed.includes(name),
    "Smoke tools must stay on the canonical allowlist",
  );
  calls++;
  const result = await session.client.callTool(
    { name, arguments: arguments_ },
    undefined,
    { timeout: 60000 },
  );
  const text = result.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");
  assert.notEqual(
    result.isError,
    true,
    `${name} failed: ${text.slice(0, 1500)}`,
  );
  assert.ok(
    result.content.every((part) => part.type !== "image"),
    "No image results expected",
  );
  return text;
}
function ref(text, role, name) {
  const line = text
    .split("\n")
    .find((line) => line.includes(`${role} "${name}"`));
  const result = line?.match(/\[ref=((?:f\d+)?e\d+)\]/)?.[1];
  assert.ok(result, `Accessibility reference for ${role} ${name} missing`);
  return result;
}
try {
  session = await connect();
  const catalog = await session.client.listTools();
  for (const name of allowed)
    assert.ok(
      catalog.tools.some((tool) => tool.name === name),
      `Pinned catalog is missing ${name}`,
    );
  await call("browser_navigate", { url: target });
  const name = await call("browser_find", { text: "Name", maxResults: 3 });
  await call("browser_type", {
    target: ref(name, "textbox", "Name"),
    text: "fixture value",
    element: "Fixture name",
  });
  const save = await call("browser_find", { text: "Save", maxResults: 3 });
  await call("browser_click", {
    target: ref(save, "button", "Save"),
    element: "Save the fixture name",
  });
  assert.match(await call("browser_snapshot", {}), /Saved fixture value/);
  await session.close();
  // Repeated launches catch Chromium processes left alive after MCP DELETE.
  // The locked-down container keeps its 256-PID limit throughout this check.
  for (let index = 1; index < 6; index++) {
    session = await connect();
    await call("browser_navigate", { url: target });
    const clean = await call("browser_snapshot", {});
    assert.match(clean, /Fresh profile/);
    assert.doesNotMatch(clean, /Restored fixture value/);
    await session.close();
    session = undefined;
  }
  console.log(
    JSON.stringify({
      smoke: "passed",
      toolsCalled: calls,
      fixtureRequests,
      sessions: 6,
      checks: [
        "navigate",
        "find",
        "type",
        "click",
        "snapshot",
        "six successive isolated sessions",
      ],
      externalServices: false,
    }),
  );
} finally {
  await session?.close();
  fixture.closeAllConnections();
  await new Promise((resolve) => fixture.close(resolve));
}
