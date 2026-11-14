// Optional pinned-package contract check: build the agent and install browser/
// dependencies first. No browser binary, backend, credentials or user state.
import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { startHttpServer } from "../browser/server.mjs";
import { browserSettings } from "../browser/settings.mjs";

const temporary = await realpath(await mkdtemp(join(tmpdir(), "ow-catalog-")));
process.env.OPENWEBUI_ACP_HOME = join(temporary, "state");
const { directory } = await import("../dist/config.js");
assert.equal(directory, process.env.OPENWEBUI_ACP_HOME);
const { Mcp } = await import("../dist/mcp.js");
const { parseUserMcp } = await import("../dist/user-mcp.js");
const require = createRequire(
  new URL("../browser/package.json", import.meta.url),
);
const { createConnection } = require("@playwright/mcp");
const includeTools = JSON.parse(
  await readFile(
    new URL("../browser/allowed-tools.json", import.meta.url),
    "utf8",
  ),
);
const server = await startHttpServer({
  createConnection: () => createConnection(browserSettings(temporary)),
  port: 0,
});
const mcp = new Mcp();
let approvals = 0;
try {
  await mcp.connect(
    parseUserMcp([
      {
        type: "http",
        name: "browser",
        url: server.url,
        options: { includeTools },
      },
    ]),
    temporary,
    async () => {
      approvals++;
    },
    AbortSignal.timeout(15000),
  );
  assert.equal(approvals, 1);
  assert.deepEqual(
    [...mcp.tools.values()].map((t) => t.label.split("/")[1]).sort(),
    [...includeTools].sort(),
  );
  for (const tool of mcp.tools.values()) {
    assert.equal(
      tool.definition.function.parameters.$schema,
      "https://json-schema.org/draft/2020-12/schema",
    );
    assert.equal(tool.unsandboxed, true);
    assert.equal(tool.ideFileProblems, undefined);
    assert.equal(tool.validate({ filename: "forbidden.txt" }), false);
  }
  const navigate = [...mcp.tools.values()].find(
    (t) => t.label === "browser/browser_navigate",
  );
  assert.equal(navigate.forceOnce, true);
  assert.equal(navigate.validate({ url: "http://127.0.0.1:34567/" }), true);
  assert.equal(navigate.validate({ url: 42 }), false);
  assert.equal(navigate.validate({}), false);
  console.log(
    "Pinned Playwright catalog through agent: 17 filtered tools, declared dialect, argument validation and permission scope passed; no browser launched",
  );
} finally {
  await mcp.close();
  await server.close();
}
