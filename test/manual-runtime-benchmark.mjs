// Explicit live benchmark; never imported by the normal test suite.
// The agent authenticates normally. This client never retrieves an API key.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  lstat,
  realpath,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Readable, Writable } from "node:stream";
import { ClientApp, ndJsonStream } from "@agentclientprotocol/sdk";

const args = process.argv.slice(2);
if (args[0] !== "--live" || !args[1] || !args[2] || args.length > 4) {
  console.error(
    "Usage: node test/manual-runtime-benchmark.mjs --live AGENT_DIRECTORY LABEL [TASK_ID]",
  );
  process.exit(2);
}
const agentDirectory = resolve(args[1]);
const label = args[2];
assert.match(label, /^[a-z0-9-]{1,40}$/);
const cases = JSON.parse(
  await readFile(
    new URL("./fixtures/runtime-tasks.json", import.meta.url),
    "utf8",
  ),
);
if (args[3]) assert(cases.some((c) => c.id === args[3]));
const originalState =
  process.env.OPENWEBUI_ACP_HOME ??
  join(
    process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"),
    "openwebui-acp-agent",
  );
const configPath = join(originalState, "config.json");
const info = await lstat(configPath);
assert(
  info.isFile() &&
    !info.isSymbolicLink() &&
    info.size < 100000 &&
    !(info.mode & 0o077),
);
const original = JSON.parse(await readFile(configPath, "utf8"));
// Do not copy project commands, executable configuration, trust or transcripts.
const config = Object.fromEntries(
  [
    "url",
    "model",
    "header",
    "rounds",
    "timeoutMs",
    "firstContentTimeoutMs",
    "idleTimeoutMs",
  ]
    .filter((k) => original[k] !== undefined)
    .map((k) => [k, original[k]]),
);
assert.equal(typeof config.url, "string");
assert.equal(typeof config.model, "string");
const authPath = join(originalState, "auth-state.json");
const authInfo = await lstat(authPath).catch((e) => {
  if (e.code === "ENOENT") return undefined;
  throw e;
});
let authState;
if (authInfo) {
  assert(
    authInfo.isFile() &&
      !authInfo.isSymbolicLink() &&
      authInfo.size < 10000 &&
      !(authInfo.mode & 0o077),
  );
  const metadata = JSON.parse(await readFile(authPath, "utf8"));
  assert.equal(typeof metadata.epoch, "string");
  assert.match(metadata.epoch, /^[a-f0-9-]{36}$/);
  authState = JSON.stringify({
    epoch: metadata.epoch,
    loggedOut: metadata.loggedOut === true,
  });
}
assert(
  !authState || JSON.parse(authState).loggedOut !== true,
  "Sign in through the normal IDE flow first",
);
const root = await mkdtemp(join(tmpdir(), `ow-runtime-${label}-`));
const canonicalRoot = await realpath(root);
const allowed = JSON.parse(
  await readFile(
    new URL("../browser/allowed-tools.json", import.meta.url),
    "utf8",
  ),
);
const sanitize = (s) =>
  String(s)
    .replaceAll(config.url, "[BACKEND]")
    .replaceAll(config.model, "[MODEL]")
    .replaceAll(canonicalRoot, "[SCRATCH]")
    .replaceAll(root, "[SCRATCH]")
    .replaceAll(homedir(), "[HOME]");
console.log(
  JSON.stringify({
    scratch: root,
    label,
    agentVersion: JSON.parse(
      await readFile(join(agentDirectory, "package.json"), "utf8"),
    ).version,
  }),
);

for (const task of cases.filter((c) => !args[3] || c.id === args[3])) {
  const workspace = join(root, task.id),
    state = join(root, `${task.id}-state`);
  await mkdir(workspace, { mode: 0o700 });
  await mkdir(state, { mode: 0o700 });
  await writeFile(join(state, "config.json"), JSON.stringify(config), {
    mode: 0o600,
  });
  if (authState)
    await writeFile(join(state, "auth-state.json"), authState, { mode: 0o600 });
  await writeFile(
    join(state, "mcp.json"),
    JSON.stringify([
      {
        type: "http",
        name: "browser",
        url: "http://127.0.0.1:8931/mcp",
        headersFrom: {},
        options: {
          includeTools: allowed,
          alwaysApproveTools: ["browser_navigate"],
          maxOutputChars: 24000,
          callTimeoutMs: 60000,
          maxFrameBytes: 1000000,
          stripImages: true,
          rejectFileOutput: true,
        },
      },
    ]),
    { mode: 0o600 },
  );
  for (const [path, content] of Object.entries(task.files))
    await writeFile(join(workspace, path), content);
  const report = {
    task: task.id,
    label,
    permissions: [],
    updates: [],
    stopReason: null,
    elapsedMs: 0,
  };
  const started = Date.now();
  const env = {
    PATH: process.env.PATH,
    HOME: homedir(),
    OPENWEBUI_ACP_HOME: state,
  };
  if (process.env.TMPDIR) env.TMPDIR = process.env.TMPDIR;
  if (process.env.NODE_EXTRA_CA_CERTS)
    env.NODE_EXTRA_CA_CERTS = process.env.NODE_EXTRA_CA_CERTS;
  const child = spawn(
    process.execPath,
    [join(agentDirectory, "dist/cli.js"), "acp"],
    { cwd: workspace, env, stdio: ["pipe", "pipe", "pipe"] },
  );
  let stderrBytes = 0;
  let capturedChars = 0;
  child.stderr.on("data", (chunk) => {
    stderrBytes += chunk.length;
  });
  const app = new ClientApp();
  let sessionId;
  app.onNotification("session/update", ({ params }) => {
    const update = params.update;
    const serialized = sanitize(JSON.stringify(update));
    capturedChars += serialized.length;
    if (report.updates.length < 10000 && capturedChars <= 4000000)
      report.updates.push(JSON.parse(serialized));
    else report.transcriptTruncated = true;
    if (update.sessionUpdate === "tool_call")
      console.log(
        JSON.stringify({ task: task.id, tool: sanitize(update.title) }),
      );
  });
  app.onRequest("session/request_permission", ({ params }) => {
    const title = params.toolCall.title ?? "";
    const input = params.toolCall.rawInput ?? {};
    // ACP decisions remain per operation. These bounded scratch tasks authorize
    // normal workspace tools, never privilege/scope expansion or remote commands.
    let permit =
      title.startsWith("Activate exact workspace ") ||
      title.startsWith("MCP browser: http http://127.0.0.1:8931/mcp");
    if (params.toolCall.kind === "edit") permit = true;
    if (
      title.startsWith("Run ") &&
      title.includes("OS sandbox: workspace") &&
      !/extra reads|extra writes/i.test(title) &&
      !input.additional_read_paths?.length &&
      !input.additional_write_paths?.length &&
      input.sandbox_permissions !== "require_escalated"
    )
      permit = true;
    if (title.startsWith("Allow sandbox network connection to "))
      permit =
        /^Allow sandbox network connection to (127\.0\.0\.1|localhost):\d+\?/.test(
          title,
        );
    if (title.startsWith("Call browser/")) {
      const name = title.match(/^Call browser\/([^ ]+)/)?.[1];
      permit = allowed.includes(name);
      if (name === "browser_navigate") {
        try {
          const url = new URL(input.url);
          permit =
            !url.username &&
            !url.password &&
            !url.search &&
            ((url.protocol === "http:" &&
              ["127.0.0.1", "localhost", "host.docker.internal"].includes(
                url.hostname,
              ) &&
              Number(url.port) >= 1024) ||
              (url.protocol === "https:" &&
                url.hostname === "nodejs.org" &&
                url.pathname === "/api/test.html"));
        } catch {
          permit = false;
        }
      }
    }
    const optionId = permit ? "once" : "deny";
    assert(params.options.some((o) => o.optionId === optionId));
    report.permissions.push({
      title: sanitize(title),
      input: JSON.parse(sanitize(JSON.stringify(input))),
      optionId,
    });
    console.log(
      JSON.stringify({
        task: task.id,
        permission: sanitize(title).slice(0, 180),
        optionId,
      }),
    );
    return { outcome: { outcome: "selected", optionId } };
  });
  const connection = app.connect(
    ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout)),
  );
  const timer = setTimeout(() => {
    if (sessionId)
      void connection.agent.notify("session/cancel", { sessionId });
  }, 900000);
  try {
    await connection.agent.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: {},
    });
    ({ sessionId } = await connection.agent.request("session/new", {
      cwd: workspace,
      mcpServers: [],
    }));
    const response = await connection.agent.request("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: task.prompt }],
    });
    report.stopReason = response.stopReason;
  } catch (e) {
    report.error = sanitize(e.message).slice(0, 2000);
  } finally {
    clearTimeout(timer);
    connection.close();
    child.kill("SIGTERM");
    if (child.exitCode === null && child.signalCode === null)
      await new Promise((r) => {
        const deadline = setTimeout(r, 10000);
        child.once("exit", () => {
          clearTimeout(deadline);
          r();
        });
      });
    if (child.exitCode === null && child.signalCode === null)
      child.kill("SIGKILL");
    report.elapsedMs = Date.now() - started;
    report.stderrBytes = stderrBytes;
    await writeFile(
      join(root, `${task.id}.json`),
      JSON.stringify(report, null, 2),
      { mode: 0o600 },
    );
    console.log(
      JSON.stringify({
        task: task.id,
        stopReason: report.stopReason,
        elapsedMs: report.elapsedMs,
        approvals: report.permissions.length,
        error: report.error,
      }),
    );
  }
}
