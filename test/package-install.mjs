// Verify an already installed tarball from outside the source checkout.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, realpath, writeFile, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
const installed = resolve(process.argv[2], "node_modules/openwebui-acp-agent");
const temporary = await realpath(
  await mkdtemp(join(tmpdir(), "ow-installed-")),
);
const child = spawn(process.execPath, [join(installed, "dist/cli.js"), "acp"], {
  cwd: temporary,
  env: { PATH: process.env.PATH, OPENWEBUI_ACP_HOME: join(temporary, "state") },
  stdio: ["pipe", "pipe", "pipe"],
});
let output = "",
  errors = "";
child.stdout.on("data", (c) => {
  output += c;
});
child.stderr.on("data", (c) => {
  errors += c;
});
const exited = new Promise((r, j) => {
  child.on("exit", r);
  child.on("error", j);
});
const timeout = setTimeout(() => child.kill("SIGKILL"), 5000);
child.stdin.end(
  JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: 1,
      clientCapabilities: { auth: { terminal: true } },
    },
  }) + "\n",
);
try {
  assert.equal(await exited, 0, errors);
  const messages = output
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const response = messages.find((m) => m.id === 1);
  assert.equal(response.result.protocolVersion, 1);
  assert.equal(response.result.agentInfo.version, "0.3.0");
  assert.equal(response.result.authMethods[0].type, "terminal");
  assert.deepEqual(response.result.agentCapabilities.auth.logout, {});
  assert.deepEqual(response.result.agentCapabilities.mcpCapabilities, {
    http: true,
    sse: true,
  });
  assert.equal(errors, "");
} finally {
  clearTimeout(timeout);
}
const { sandboxCommand } = await import(
  pathToFileURL(join(installed, "dist/sandbox.js"))
);
const { SERVER_TOOLS_VERSION } = await import(
  pathToFileURL(join(installed, "dist/server-tools.js"))
);
assert.equal(SERVER_TOOLS_VERSION, "0.13.3");
const { contextSize, completionContextTokens } = await import(
  pathToFileURL(join(installed, "dist/usage.js"))
);
assert.equal(contextSize({ max_input_tokens: 1000 }), 1000);
assert.equal(
  contextSize({ context_window: 2000, max_input_tokens: 1000 }),
  2000,
);
assert.equal(
  completionContextTokens({ prompt_tokens: 120, completion_tokens: 30 }),
  150,
);
await writeFile(join(temporary, "fixture.txt"), "installed fixture");
const result = JSON.parse(
  await sandboxCommand(
    "/bin/cat",
    ["fixture.txt"],
    { root: temporary, mode: "workspace", network: async () => false },
    AbortSignal.timeout(10000),
  ),
);
assert.equal(result.code, 0, result.output);
assert.match(result.output, /installed fixture/);
assert.equal(
  await readFile(join(temporary, "fixture.txt"), "utf8"),
  "installed fixture",
);
console.log(
  "Installed 0.3.0: clean ACP v1 handshake, terminal authentication and logout discovery, context usage module, and real sandbox command passed outside the checkout",
);
