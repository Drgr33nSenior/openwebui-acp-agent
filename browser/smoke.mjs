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
// A second origin for the origin-boundary check: it serves a marker and
// counts its connections.
const marker = `second-origin-${Math.random().toString(36).slice(2)}`;
let elsewhereConnections = 0;
const elsewhere = http.createServer((_req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/html",
    "Cache-Control": "no-store",
  });
  res.end(`<!doctype html><title>Elsewhere</title><p>${marker}</p>`);
});
elsewhere.on("connection", () => elsewhereConnections++);
await new Promise((resolve) => elsewhere.listen(0, "127.0.0.1", resolve));
const second = `http://${fixtureHost}:${elsewhere.address().port}/`;
let fixtureRequests = 0;
const fixture = http.createServer((req, res) => {
  fixtureRequests++;
  if (req.url === "/hop") {
    res.writeHead(302, {
      Location: `${second}hop`,
      "Cache-Control": "no-store",
    });
    return res.end();
  }
  res.writeHead(200, {
    "Content-Type": "text/html",
    "Cache-Control": "no-store",
  });
  if (req.url === "/boundary")
    return res.end(
      `<!doctype html><html lang="en"><title>Boundary fixture</title><p>Boundary fixture</p><a href="${second}link">Elsewhere</a></html>`,
    );
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
async function connect(endpointUrl = url) {
  const transport = new StreamableHTTPClientTransport(endpointUrl, {
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
  // Origin boundary. Control: the second origin serves its marker to this
  // script, and an ordinary session follows the fixture's link to it.
  const direct = await fetch(`http://127.0.0.1:${elsewhere.address().port}/`);
  assert.ok((await direct.text()).includes(marker));
  const follow = async () => {
    await call("browser_navigate", { url: `${target}boundary` });
    const page = await call("browser_snapshot", {});
    assert.match(page, /Boundary fixture/);
    await call("browser_click", {
      target: ref(page, "link", "Elsewhere"),
      element: "Link to the second origin",
    });
    return call("browser_snapshot", {});
  };
  session = await connect();
  assert.ok((await follow()).includes(marker), "Ordinary sessions changed");
  await session.close();
  // A session of the confined endpoint reads the same fixture, but neither
  // its link nor a redirect from it reaches the second origin.
  elsewhereConnections = 0;
  session = await connect(new URL(`${url.href}/confined`));
  const seen = [await follow()];
  seen.push(await call("browser_navigate", { url: `${target}hop` }));
  seen.push(await call("browser_snapshot", {}));
  await session.close();
  session = undefined;
  for (const text of seen)
    assert.ok(!text.includes(marker), "Confined session read another origin");
  assert.match(seen[0], /Blocked by the browser origin boundary/);
  assert.match(seen[2], /Blocked by the browser origin boundary/);
  assert.equal(
    elsewhereConnections,
    0,
    "Confined session reached another origin",
  );
  console.log(
    JSON.stringify({
      smoke: "passed",
      toolsCalled: calls,
      fixtureRequests,
      sessions: 8,
      checks: [
        "navigate",
        "find",
        "type",
        "click",
        "snapshot",
        "six successive isolated sessions",
        "ordinary session follows a link to a second origin",
        "confined session reaches no second origin by link or redirect",
      ],
      externalServices: false,
    }),
  );
} finally {
  await session?.close();
  for (const server of [fixture, elsewhere]) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}
