// Explicit live fixture only; never imported by ordinary tests.
// The child uses normal agent authentication. The parent never retrieves a key
// or reads/copies the user's auth-state.json. All writes use fresh scratch state.
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
import { pathToFileURL } from "node:url";
import { Readable, Writable } from "node:stream";
import { ClientApp, ndJsonStream } from "@agentclientprotocol/sdk";
import { editTask } from "./fixtures/edit-task.mjs";
import { inspectEditFixture } from "./fixtures/edit-report.mjs";

const args = process.argv.slice(2);
if (args[0] === "--child") {
  const directory = resolve(args[1]);
  const { Backend } = await import(
    pathToFileURL(join(directory, "dist/backend.js"))
  );
  const complete = Backend.prototype.complete;
  let request = 0;
  Backend.prototype.complete = async function (...input) {
    process.stderr.write(
      JSON.stringify({ event: "edit_benchmark_request", request: ++request }) +
        "\n",
    );
    try {
      return await complete.apply(this, input);
    } catch (error) {
      process.stderr.write(
        JSON.stringify({
          event: "edit_benchmark_failure",
          kind: error.kind ?? "other",
          status: error.status ?? null,
        }) + "\n",
      );
      throw error;
    }
  };
  process.argv = [process.execPath, join(directory, "dist/cli.js"), "acp"];
  await import(pathToFileURL(process.argv[1]));
} else {
  assert(
    args[0] === "--live" && args.length === 3,
    "Usage: node test/manual-edit-benchmark.mjs --live AGENT_DIRECTORY LABEL",
  );
  const agentDirectory = resolve(args[1]),
    label = args[2];
  assert.match(label, /^[a-z0-9-]{1,40}$/);
  const originalState =
    process.env.OPENWEBUI_ACP_HOME ??
    join(
      process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"),
      "openwebui-acp-agent",
    );
  const configPath = join(originalState, "config.json"),
    info = await lstat(configPath);
  assert(
    info.isFile() &&
      !info.isSymbolicLink() &&
      info.size < 100000 &&
      !(info.mode & 0o077),
  );
  const original = JSON.parse(await readFile(configPath, "utf8"));
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
  const root = await realpath(
    await mkdtemp(join(tmpdir(), `ow-edit-${label}-`)),
  );
  const workspace = join(root, "workspace"),
    state = join(root, "state");
  await mkdir(workspace, { mode: 0o700 });
  await mkdir(state, { mode: 0o700 });
  await writeFile(join(state, "config.json"), JSON.stringify(config), {
    mode: 0o600,
  });
  const task = editTask();
  for (const [path, content] of Object.entries(task.files))
    await writeFile(join(workspace, path), content, { mode: 0o600 });
  const sanitize = (value) =>
    String(value)
      .replaceAll(config.url, "[BACKEND]")
      .replaceAll(config.model, "[MODEL]")
      .replaceAll(root, "[SCRATCH]")
      .replaceAll(homedir(), "[HOME]");
  const report = {
    label,
    version: JSON.parse(
      await readFile(join(agentDirectory, "package.json"), "utf8"),
    ).version,
    requests: 0,
    recoveries: 0,
    modelFailures: [],
    toolCalls: {},
    toolFailures: {},
    approvals: 0,
    stopReason: null,
    elapsedMs: 0,
    latestContextTokens: null,
    promptTokens: null,
    finalText: "",
  };
  const env = {
    PATH: process.env.PATH,
    HOME: homedir(),
    OPENWEBUI_ACP_HOME: state,
  };
  for (const key of ["TMPDIR", "NODE_EXTRA_CA_CERTS"])
    if (process.env[key]) env[key] = process.env[key];
  const child = spawn(
    process.execPath,
    [new URL(import.meta.url).pathname, "--child", agentDirectory],
    { cwd: workspace, env, stdio: ["pipe", "pipe", "pipe"] },
  );
  let buffer = "";
  child.stderr.on("data", (chunk) => {
    buffer += chunk.toString();
    let end;
    while ((end = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      if (event.event === "edit_benchmark_request") report.requests++;
      if (event.event === "model_reply_recovery") report.recoveries++;
      if (event.event === "edit_benchmark_failure")
        report.modelFailures.push({ kind: event.kind, status: event.status });
    }
    if (buffer.length > 10000) buffer = "";
  });
  const tools = new Map(),
    failed = new Set(),
    app = new ClientApp();
  app.onNotification("session/update", ({ params }) => {
    const u = params.update;
    if (u.sessionUpdate === "tool_call" && /^[a-z_]+$/.test(u.title)) {
      tools.set(u.toolCallId, u.title);
      report.toolCalls[u.title] = (report.toolCalls[u.title] ?? 0) + 1;
    }
    if (
      u.sessionUpdate === "tool_call_update" &&
      u.status === "failed" &&
      tools.has(u.toolCallId) &&
      !failed.has(u.toolCallId)
    ) {
      failed.add(u.toolCallId);
      const message = (u.content ?? [])
        .filter((c) => c.type === "content" && c.content.type === "text")
        .map((c) => c.content.text)
        .join("\n");
      const key =
        tools.get(u.toolCallId) +
        ": " +
        sanitize(message.split("\n", 1)[0]).slice(0, 200);
      report.toolFailures[key] = (report.toolFailures[key] ?? 0) + 1;
    }
    if (u.sessionUpdate === "agent_message_chunk" && u.content.type === "text")
      report.finalText = (report.finalText + sanitize(u.content.text)).slice(
        -4000,
      );
    if (u.sessionUpdate === "usage_update") report.latestContextTokens = u.used;
  });
  app.onRequest("session/request_permission", ({ params }) => {
    const title = params.toolCall.title ?? "",
      input = params.toolCall.rawInput ?? {};
    const allow =
      title.startsWith("Activate exact workspace ") ||
      params.toolCall.kind === "edit" ||
      (title.startsWith("Run ") &&
        title.includes("OS sandbox: workspace") &&
        !/extra reads|extra writes/.test(title) &&
        !input.additional_read_paths?.length &&
        !input.additional_write_paths?.length &&
        input.sandbox_permissions !== "require_escalated");
    report.approvals++;
    return {
      outcome: { outcome: "selected", optionId: allow ? "once" : "deny" },
    };
  });
  const connection = app.connect(
    ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout)),
  );
  let sessionId;
  const started = Date.now(),
    timer = setTimeout(() => {
      if (sessionId)
        void connection.agent.notify("session/cancel", { sessionId });
    }, 900000);
  console.log(JSON.stringify({ scratch: root, label }));
  try {
    await connection.agent.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: {},
    });
    ({ sessionId } = await connection.agent.request("session/new", {
      cwd: workspace,
      mcpServers: [],
    }));
    report.stopReason = (
      await connection.agent.request("session/prompt", {
        sessionId,
        prompt: [{ type: "text", text: task.prompt }],
      })
    ).stopReason;
  } catch (error) {
    report.error = sanitize(error.message).slice(0, 500);
  } finally {
    clearTimeout(timer);
    connection.close();
    child.kill("SIGTERM");
    if (child.exitCode === null && child.signalCode === null)
      await new Promise((r) => {
        const t = setTimeout(r, 5000);
        child.once("exit", () => {
          clearTimeout(t);
          r();
        });
      });
    if (child.exitCode === null && child.signalCode === null)
      child.kill("SIGKILL");
    report.elapsedMs = Date.now() - started;
    report.logicalRounds = report.requests - report.recoveries;
    if (sessionId)
      Object.assign(
        report,
        await inspectEditFixture(
          workspace,
          join(state, `session-${sessionId}.json`),
        ),
      );
    await writeFile(
      join(root, "report.json"),
      JSON.stringify(report, null, 2),
      { mode: 0o600 },
    );
    console.log(JSON.stringify(report));
  }
}
