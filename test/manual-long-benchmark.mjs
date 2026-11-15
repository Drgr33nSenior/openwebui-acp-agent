// Long-session benchmark runner; explicit use only, never imported by ordinary
// tests. It gives the agent built in AGENT_DIRECTORY the synthetic 126-test
// project from manual-long-benchmark-fixture.mjs and records how the session
// went. Live runs on a shared server go through manual-long-benchmark-wait.mjs,
// which enforces the overnight window and an idle inference server.
//
//   LONG_BENCHMARK_RESULTS=/absolute/results/dir \
//     node test/manual-long-benchmark.mjs --live AGENT_DIRECTORY LABEL [TIMEOUT_MINUTES] [--task long|game]
//
// --task game (manual-long-benchmark-game.mjs) builds a browser game from a
// brief and is judged by hidden checks through the PLAN-04 contract. It
// starts a session only after proving the hidden source is out of the
// agent's reach; see prepareGame() for its settings.
//
// The child uses the agent's normal authentication: the OS credential store,
// or OPENWEBUI_API_KEY when that variable is already set for this process. The
// parent never retrieves a key and never reads or copies auth-state.json; it
// copies only non-secret config fields into fresh scratch state. The workspace
// and state stay in a fresh scratch directory (kept for inspection); the
// report goes to $LONG_BENCHMARK_RESULTS/LABEL.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { Readable, Writable } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { longTask } from "./manual-long-benchmark-fixture.mjs";
import * as GAME from "./manual-long-benchmark-game.mjs";

const MAX_CONTINUATIONS = 8;
const CONTINUE_PROMPT = "Continue with the remaining work.";
const USAGE_WAIT_MS = 2000;
const args = process.argv.slice(2);

// The browser tools an evaluated agent may use: the wrapper's allowlist.
const BROWSER_TOOLS = new Set(
  JSON.parse(
    await readFile(
      new URL("../browser/allowed-tools.json", import.meta.url),
      "utf8",
    ),
  ),
);
const originOf = (url) => {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
};
const updateText = (u) =>
  (u.content ?? [])
    .filter((c) => c.type === "content" && c.content?.type === "text")
    .map((c) => c.content.text)
    .join("\n");

// One permission decision for the evaluated session and the isolation probes.
// Allowed: workspace activation, edits (the agent refuses paths outside the
// workspace before asking), commands in the workspace sandbox without extra
// paths or escalation. For the game task also a static preview and the
// allowlisted browser tools, with navigation only to a preview this session
// started. Everything else is denied.
function decide(params, { game, previewOrigins, browserUrl }) {
  const title = params.toolCall.title ?? "",
    input = params.toolCall.rawInput ?? {};
  if (title.startsWith("Activate exact workspace ")) return true;
  if (params.toolCall.kind === "edit") return true;
  if (
    title.startsWith("Run ") &&
    title.includes("OS sandbox: workspace") &&
    !/extra reads|extra writes/.test(title) &&
    !input.additional_read_paths?.length &&
    !input.additional_write_paths?.length &&
    input.sandbox_permissions !== "require_escalated"
  )
    return true;
  if (!game) return false;
  if (title.startsWith("Start static preview of ")) return true;
  // Connecting the configured browser server, and no other MCP server.
  if (browserUrl && title.startsWith(`MCP browser: http ${browserUrl};`))
    return true;
  // The agent marks every HTTP MCP server as running outside its sandbox.
  const call = title.match(
    /^Call browser\/(browser_[a-z_]+)(?: \(runs on this machine outside the sandbox\))?: (.*)$/s,
  );
  if (!call || !BROWSER_TOOLS.has(call[1])) return false;
  if (call[1] !== "browser_navigate") return true;
  try {
    return previewOrigins.has(originOf(JSON.parse(call[2]).url));
  } catch {
    return false;
  }
}

// Records the origins of a preview the agent started, from its result.
function trackPreview(u, tools, previewOrigins) {
  if (
    u.sessionUpdate !== "tool_call_update" ||
    u.status !== "completed" ||
    tools.get(u.toolCallId) !== "start_preview"
  )
    return;
  try {
    const info = JSON.parse(updateText(u));
    for (const url of [info.url, info.containerUrl])
      if (originOf(url)) previewOrigins.add(originOf(url));
  } catch {
    // Not a preview result.
  }
}

const textOf = (content) =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content.map((c) => c?.text ?? "").join("")
      : "";

// Token counts reported by the server for one chat completion, taken from a
// copy of the HTTP response: a JSON body or the last server-sent event that
// carries usage. Missing counts stay null; nothing is estimated.
function usageFromBody(body) {
  let usage;
  const take = (value) => {
    if (value && typeof value === "object" && value.usage) usage = value.usage;
  };
  const trimmed = body.trim();
  if (trimmed.startsWith("{")) {
    try {
      take(JSON.parse(trimmed));
    } catch {
      // Not JSON; no usage recorded.
    }
  } else
    for (const line of body.split("\n")) {
      const data = line.match(/^data:\s?(.*)$/)?.[1];
      if (!data || data === "[DONE]") continue;
      try {
        take(JSON.parse(data));
      } catch {
        // A partial or non-JSON event; ignore it.
      }
    }
  const count = (value) =>
    Number.isSafeInteger(value) && value >= 0 ? value : null;
  return {
    promptTokens: count(usage?.prompt_tokens ?? usage?.prompt_eval_count),
    completionTokens: count(usage?.completion_tokens ?? usage?.eval_count),
    reasoningTokens: count(usage?.completion_tokens_details?.reasoning_tokens),
  };
}

if (args[0] === "--child") {
  const directory = resolve(args[1]);
  const { Backend } = await import(
    pathToFileURL(join(directory, "dist/backend.js"))
  );
  const emit = (event) => process.stderr.write(JSON.stringify(event) + "\n");
  // Observe, without changing, the response of each chat completion request so
  // the report can use the server's own prompt and completion token counts.
  const realFetch = globalThis.fetch;
  let pending = null;
  globalThis.fetch = async function (input, init) {
    const response = await realFetch(input, init);
    const url = String(input?.url ?? input);
    if (pending && url.endsWith("/api/chat/completions") && response.body) {
      const record = pending;
      pending = null;
      record.usage = response
        .clone()
        .text()
        .then(usageFromBody, () => null);
    }
    return response;
  };
  const complete = Backend.prototype.complete;
  let request = 0,
    lastMcp = "";
  Backend.prototype.complete = async function (...input) {
    const [messages, tools] = input;
    const n = ++request;
    // MCP tools reach the model as mcp_<server>_<tool>; the description names
    // the real tool. Sent whenever the mapping changes.
    const mcp = {};
    for (const t of Array.isArray(tools) ? tools : []) {
      const label = t?.function?.description?.match(
        /^Untrusted MCP ([^:\s]+):/,
      )?.[1];
      if (label) mcp[t.function.name] = label;
    }
    const started = Date.now();
    let cleared = 0,
      elided = 0;
    for (const m of messages) {
      const text = textOf(m.content);
      if (text.startsWith("[cleared from context: ")) cleared++;
      for (const c of m.tool_calls ?? [])
        if (c.function?.arguments?.includes("[elided from context: ")) elided++;
    }
    const record = {
      event: "long_benchmark_request",
      request: n,
      kind: Array.isArray(tools) && tools.length === 0 ? "summary" : "coding",
      messages: messages.length,
      chars: JSON.stringify(messages).length + JSON.stringify(tools).length,
      clearedResults: cleared,
      elidedCalls: elided,
      maxTokens: input[4]?.max_tokens ?? null,
      reasoning: input[4]?.reasoning_effort ?? input[4]?.reasoning ?? null,
      promptTokens: null,
      completionTokens: null,
      reasoningTokens: null,
    };
    if (JSON.stringify(mcp) !== lastMcp) {
      lastMcp = JSON.stringify(mcp);
      record.mcpTools = mcp;
    }
    const observed = {};
    pending = observed;
    const onUsage = input[6];
    if (typeof onUsage === "function")
      input[6] = async (used, prompt) => {
        record.used = used;
        record.prompt = prompt ?? null;
        return onUsage(used, prompt);
      };
    const finish = async () => {
      record.ms = Date.now() - started;
      if (pending === observed) pending = null;
      if (observed.usage) {
        let timer;
        const usage = await Promise.race([
          observed.usage,
          new Promise((r) => (timer = setTimeout(r, USAGE_WAIT_MS))),
        ]);
        clearTimeout(timer);
        if (usage) Object.assign(record, usage);
      }
      emit(record);
    };
    try {
      const reply = await complete.apply(this, input);
      record.toolCalls = (reply.tool_calls ?? []).map((c) => c.function.name);
      record.replyChars = textOf(reply.content).length;
      await finish();
      return reply;
    } catch (error) {
      record.failure = {
        kind: error.kind ?? "other",
        status: error.status ?? null,
        message: String(error.message ?? "").slice(0, 300),
      };
      await finish();
      throw error;
    }
  };
  process.argv = [process.execPath, join(directory, "dist/cli.js"), "acp"];
  await import(pathToFileURL(process.argv[1]));
} else {
  let taskName = "long";
  const taskAt = args.indexOf("--task");
  if (taskAt >= 0) {
    taskName = args[taskAt + 1];
    args.splice(taskAt, 2);
  }
  assert(
    args[0] === "--live" &&
      (args.length === 3 || args.length === 4) &&
      ["long", "game"].includes(taskName),
    "Usage: LONG_BENCHMARK_RESULTS=DIR node test/manual-long-benchmark.mjs --live AGENT_DIRECTORY LABEL [TIMEOUT_MINUTES] [--task long|game]",
  );
  const game = taskName === "game";
  const agentDirectory = resolve(args[1]),
    label = args[2],
    timeoutMinutes = Number(args[3] ?? 30);
  assert.match(label, /^[a-z0-9-]{1,40}$/, "LABEL: a-z, 0-9 and -, 1-40");
  assert(
    Number.isInteger(timeoutMinutes) &&
      timeoutMinutes >= 1 &&
      timeoutMinutes <= 240,
    "TIMEOUT_MINUTES: a whole number from 1 to 240",
  );
  const resultsRoot = process.env.LONG_BENCHMARK_RESULTS;
  assert(
    resultsRoot && isAbsolute(resultsRoot),
    "Set LONG_BENCHMARK_RESULTS to an absolute directory for the results",
  );
  const results = join(resultsRoot, label);
  await mkdir(results, { recursive: true, mode: 0o700 });
  const existing = await lstat(join(results, "report.json")).catch(() => null);
  assert(!existing, `${results} already holds a report; use a new label`);
  const { ClientApp, ndJsonStream } = await import(
    pathToFileURL(
      createRequire(join(agentDirectory, "package.json")).resolve(
        "@agentclientprotocol/sdk",
      ),
    ).href
  );
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
    "config.json must be a private regular file",
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
  // A long task needs more than the default rounds per prompt; 100 is the
  // schema maximum. The same for every build.
  config.rounds = 100;
  assert.equal(typeof config.url, "string");
  assert.equal(typeof config.model, "string");
  const root = await realpath(
    await mkdtemp(join(tmpdir(), `ow-long-${label}-`)),
  );
  const workspace = join(root, "workspace"),
    state = join(root, "state");
  await mkdir(workspace, { mode: 0o700 });
  await mkdir(state, { mode: 0o700 });
  await writeFile(join(state, "config.json"), JSON.stringify(config), {
    mode: 0o600,
  });
  const task = game ? { prompt: GAME.PROMPT } : longTask();
  let gameSetup = null;
  if (game)
    gameSetup = await prepareGame({
      root,
      workspace,
      state,
      agentDirectory,
      ClientApp,
      ndJsonStream,
    });
  else
    for (const [path, content] of Object.entries(task.files))
      await writeFile(join(workspace, path), content, { mode: 0o600 });
  const apiKey = process.env.OPENWEBUI_API_KEY;
  const sanitize = (value) => {
    let text = String(value);
    if (apiKey) text = text.replaceAll(apiKey, "[REDACTED]");
    return text
      .replaceAll(config.url, "[BACKEND]")
      .replaceAll(config.model, "[MODEL]")
      .replaceAll(root, "[SCRATCH]")
      .replaceAll(homedir(), "[HOME]");
  };
  const report = {
    label,
    task: game ? "lights-out-browser" : "long-suite",
    // Configuration identity: the model ID and request limits used. The
    // backend address is not recorded.
    model: config.model,
    rounds: config.rounds,
    requestTimeouts: {
      timeoutMs: config.timeoutMs ?? null,
      firstContentTimeoutMs: config.firstContentTimeoutMs ?? null,
      idleTimeoutMs: config.idleTimeoutMs ?? null,
    },
    agent: sanitize(agentDirectory),
    commit:
      spawnSync("git", ["-C", agentDirectory, "rev-parse", "--short", "HEAD"], {
        encoding: "utf8",
      }).stdout?.trim() || null,
    version: JSON.parse(
      await readFile(join(agentDirectory, "package.json"), "utf8"),
    ).version,
    startedAt: new Date().toISOString(),
    timeoutMinutes,
    requests: 0,
    codingRequests: 0,
    summaryRequests: 0,
    recoveries: 0,
    modelFailures: [],
    maskBatches: [],
    toolCalls: {},
    toolCallsTotal: 0,
    toolFailures: {},
    toolFailuresByTool: {},
    toolFailuresTotal: 0,
    nonzeroCommandExits: 0,
    checkpointBlocks: 0,
    checkpointClears: 0,
    approvals: 0,
    denied: 0,
    tokens: {
      requests: 0,
      promptReported: 0,
      completionReported: 0,
      reasoningReported: 0,
      promptSum: 0,
      completionSum: 0,
      reasoningSum: 0,
      promptPeak: null,
    },
    viewImage: { calls: 0, failed: 0 },
    // The long task has no hidden checks and no interactive program to
    // play-test; null means not applicable, not "none".
    hiddenChecks: game
      ? { verdict: "unavailable", reason: "not evaluated" }
      : null,
    unpromptedPlaytest: game
      ? { observed: null, reason: "not evaluated" }
      : null,
    stopReason: null,
    timedOut: false,
    elapsedMs: 0,
    usageUpdates: [],
    peakContextTokens: null,
    latestContextTokens: null,
    contextSize: null,
  };
  if (game) {
    report.mcpTools = {};
    report.browserMcp = Boolean(gameSetup.browserMcp);
    report.evaluator = {
      seal: GAME.GAME_SEAL,
      transport: gameSetup.transport?.kind ?? null,
      checker: gameSetup.checker ? { files: gameSetup.checker.files } : null,
      references: gameSetup.references
        ? Object.fromEntries(
            Object.entries(gameSetup.references.outcomes).map(([k, v]) => [
              k,
              { matches: v.matches, failed: v.failed },
            ]),
          )
        : null,
    };
    report.isolation = gameSetup.isolation;
    if (gameSetup.problems.length) {
      // Fail closed: no evaluated session without every precondition.
      report.error = "game preconditions not met; no session was started";
      report.preconditions = gameSetup.problems.map(sanitize);
      report.hiddenChecks = {
        verdict: "unavailable",
        reason: "preconditions not met",
      };
      report.unpromptedPlaytest = { observed: null, reason: "no session" };
      report.scratch = root;
      await writeFile(
        join(results, "report.json"),
        JSON.stringify(report, null, 2),
        { mode: 0o600 },
      );
      console.log(
        JSON.stringify({
          label,
          error: report.error,
          preconditions: report.preconditions,
        }),
      );
      process.exit(4);
    }
  }
  const previewOrigins = new Set();
  const requests = [];
  const env = {
    PATH: process.env.PATH,
    HOME: homedir(),
    OPENWEBUI_ACP_HOME: state,
  };
  for (const key of ["TMPDIR", "NODE_EXTRA_CA_CERTS", "OPENWEBUI_API_KEY"])
    if (process.env[key]) env[key] = process.env[key];
  const child = spawn(
    process.execPath,
    [fileURLToPath(import.meta.url), "--child", agentDirectory],
    { cwd: workspace, env, stdio: ["pipe", "pipe", "pipe"] },
  );
  const stderrLines = [];
  let buffer = "";
  const onRequest = (event) => {
    delete event.event;
    event.at = Date.now();
    requests.push(event);
    report.requests++;
    if (event.kind === "summary") report.summaryRequests++;
    else report.codingRequests++;
    const t = report.tokens;
    t.requests++;
    if (event.promptTokens !== null) {
      t.promptReported++;
      t.promptSum += event.promptTokens;
      t.promptPeak = Math.max(t.promptPeak ?? 0, event.promptTokens);
    }
    if (event.completionTokens !== null) {
      t.completionReported++;
      t.completionSum += event.completionTokens;
    }
    if (event.reasoningTokens !== null) {
      t.reasoningReported++;
      t.reasoningSum += event.reasoningTokens;
    }
    if (event.failure) {
      event.failure.message = sanitize(event.failure.message);
      report.modelFailures.push(event.failure);
    }
    if (event.mcpTools && report.mcpTools)
      Object.assign(report.mcpTools, event.mcpTools);
  };
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
        stderrLines.push(sanitize(line).slice(0, 2000));
        continue;
      }
      if (event?.event === "long_benchmark_request") {
        onRequest(event);
        continue;
      }
      if (event?.event === "model_reply_recovery") report.recoveries++;
      if (event?.event === "context_mask") {
        const batch = { ...event, afterRequest: report.requests };
        delete batch.event;
        report.maskBatches.push(batch);
      }
      stderrLines.push(sanitize(line).slice(0, 2000));
    }
    if (buffer.length > 100000) buffer = "";
  });
  const tools = new Map(),
    failed = new Set(),
    app = new ClientApp();
  let agentText = "";
  const count = (pattern) => (agentText.match(pattern) ?? []).length;
  app.onNotification("session/update", ({ params }) => {
    const u = params.update;
    // Model tool calls are titled with the tool name; automatic checks and
    // permission prompts use descriptive titles and are not counted.
    trackPreview(u, tools, previewOrigins);
    if (u.sessionUpdate === "tool_call" && /^[a-z][a-z0-9_]*$/.test(u.title)) {
      tools.set(u.toolCallId, u.title);
      report.toolCalls[u.title] = (report.toolCalls[u.title] ?? 0) + 1;
      report.toolCallsTotal++;
      if (u.title === "view_image") report.viewImage.calls++;
    }
    if (
      u.sessionUpdate === "tool_call_update" &&
      u.status === "failed" &&
      tools.has(u.toolCallId) &&
      !failed.has(u.toolCallId)
    ) {
      failed.add(u.toolCallId);
      const name = tools.get(u.toolCallId);
      report.toolFailuresTotal++;
      report.toolFailuresByTool[name] =
        (report.toolFailuresByTool[name] ?? 0) + 1;
      if (name === "view_image") report.viewImage.failed++;
      const message = (u.content ?? [])
        .filter((c) => c.type === "content" && c.content.type === "text")
        .map((c) => c.content.text)
        .join("\n");
      if (/Checkpoint (storage budget exceeded|limit reached)/.test(message))
        report.checkpointBlocks++;
      const exit =
        name === "run_command" && message.match(/^\s*\{"code":\s*(-?\d+)/);
      if (exit && exit[1] !== "0") report.nonzeroCommandExits++;
      // Grouped by tool and failure; command output is not part of the key.
      const key = exit
        ? `${name}: exit code ${exit[1]}`
        : name + ": " + sanitize(message.split("\n", 1)[0]).slice(0, 200);
      report.toolFailures[key] = (report.toolFailures[key] ?? 0) + 1;
    }
    if (u.sessionUpdate === "agent_message_chunk" && u.content.type === "text")
      agentText += sanitize(u.content.text);
    if (u.sessionUpdate === "usage_update") {
      report.latestContextTokens = u.used;
      report.contextSize = u.size;
      report.peakContextTokens = Math.max(
        report.peakContextTokens ?? 0,
        u.used,
      );
      report.usageUpdates.push(u.used);
    }
  });
  app.onRequest("session/request_permission", ({ params }) => {
    const allow = decide(params, {
      game,
      previewOrigins,
      browserUrl: gameSetup?.browserMcp,
    });
    report.approvals++;
    if (!allow) {
      report.denied++;
      (report.deniedOperations ??= []).push(
        sanitize(params.toolCall.title ?? "").slice(0, 160),
      );
    }
    return {
      outcome: { outcome: "selected", optionId: allow ? "once" : "deny" },
    };
  });
  const connection = app.connect(
    ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout)),
  );
  let sessionId, killTimer;
  const started = Date.now(),
    timer = setTimeout(() => {
      report.timedOut = true;
      if (sessionId)
        void connection.agent.notify("session/cancel", { sessionId });
      killTimer = setTimeout(() => child.kill("SIGTERM"), 90000);
    }, timeoutMinutes * 60000);
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
    report.sessionId = sessionId;
    // Each turn is capped at 64 tool calls by the agent; a user continues.
    report.turns = [];
    let text = task.prompt,
      blocksSeen = 0;
    for (let turn = 0; turn <= MAX_CONTINUATIONS; turn++) {
      const begin = Date.now(),
        firstRequest = report.requests;
      report.stopReason = (
        await connection.agent.request("session/prompt", {
          sessionId,
          prompt: [{ type: "text", text }],
        })
      ).stopReason;
      const blocked = report.checkpointBlocks > blocksSeen;
      blocksSeen = report.checkpointBlocks;
      report.turns.push({
        stopReason: report.stopReason,
        requests: report.requests - firstRequest,
        ms: Date.now() - begin,
        checkpointBlocked: blocked,
      });
      if (report.timedOut) break;
      if (report.stopReason !== "max_turn_requests" && !blocked) break;
      // As the owner would: the edit error says to clear checkpoints.
      if (blocked) {
        await connection.agent.request("session/prompt", {
          sessionId,
          prompt: [{ type: "text", text: "/checkpoints clear" }],
        });
        report.checkpointClears++;
      }
      text = CONTINUE_PROMPT;
    }
  } catch (error) {
    report.error = sanitize(error.message ?? error).slice(0, 1000);
  } finally {
    clearTimeout(timer);
    clearTimeout(killTimer);
    report.elapsedMs = Date.now() - started;
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
    report.logicalRounds = report.codingRequests - report.recoveries;
    report.notices = {
      compacting: count(/Compacting model context/g),
      compacted: count(/Context compacted\./g),
      compactionFailed: count(/Automatic compaction failed/g),
      contextFull:
        count(/Context is full/g) +
        (/Context is full/.test(report.error ?? "") ? 1 : 0),
      contextUsageWarning: count(/\[Reported context usage:/g),
    };
    report.finalText = agentText.slice(-3000);
    try {
      if (game) {
        renameMcp(report);
        Object.assign(
          report,
          await inspectGame({
            setup: gameSetup,
            workspace,
            state,
            sessionId,
            results,
            label,
            mcpTools: report.mcpTools,
          }),
        );
      } else
        Object.assign(report, await inspect(workspace, state, sessionId, task));
    } catch (error) {
      report.inspectError = sanitize(error.message).slice(0, 500);
    }
    report.scratch = root;
    const write = (name, text) =>
      writeFile(join(results, name), text, { mode: 0o600 });
    await write("report.json", JSON.stringify(report, null, 2));
    await write(
      "requests.jsonl",
      requests.map((r) => JSON.stringify(r)).join("\n") + "\n",
    );
    await write("agent-text.txt", agentText);
    await write("stderr.log", stderrLines.join("\n") + "\n");
    if (sessionId)
      await copyFile(
        join(state, `session-${sessionId}.json`),
        join(results, "session.json"),
      ).catch(() => {});
    const brief = { ...report };
    delete brief.usageUpdates;
    delete brief.finalText;
    console.log(JSON.stringify(brief));
  }
}

// Reads only this run's synthetic scratch workspace and transcript.
async function inspect(workspace, state, sessionId, task) {
  const unchanged = { tables: {}, tests: {} };
  for (const [name, table] of Object.entries(task.tables)) {
    const text = await readFile(join(workspace, name), "utf8");
    unchanged.tables[name] = text.includes(table);
  }
  for (const [name, test] of Object.entries(task.tests))
    unchanged.tests[name] =
      (await readFile(join(workspace, name), "utf8")) === test;
  const tablesUnchanged = Object.values(unchanged.tables).every(Boolean);
  const testsUnchanged = Object.values(unchanged.tests).every(Boolean);
  // Run the suite ourselves after the session. Unknown when it cannot run.
  const run = spawnSync("python3", ["-m", "unittest"], {
    cwd: workspace,
    encoding: "utf8",
    timeout: 120000,
    env: {
      PATH: process.env.PATH,
      HOME: homedir(),
      PYTHONDONTWRITEBYTECODE: "1",
    },
  });
  const out = (run.stderr ?? "") + (run.stdout ?? "");
  const ranMatch = out.match(/Ran (\d+) tests?/);
  const ran = ranMatch ? Number(ranMatch[1]) : null;
  const failures = Number(out.match(/failures=(\d+)/)?.[1] ?? 0);
  const errors = Number(out.match(/errors=(\d+)/)?.[1] ?? 0);
  const failing = [...out.matchAll(/^(?:FAIL|ERROR): (\w+) \((\w+)\./gm)].map(
    (m) => `${m[2]}.${m[1]}`,
  );
  const finalSuite = {
    exitCode: run.status,
    ran,
    passed: ran === null ? null : ran - failures - errors,
    expected: task.testCount,
    failing,
  };
  if (!sessionId)
    return { tablesUnchanged, testsUnchanged, unchanged, finalSuite };
  const session = JSON.parse(
    await readFile(join(state, `session-${sessionId}.json`), "utf8"),
  );
  const messages = session.messages ?? [];
  // Tool-call timeline from the stored transcript.
  const calls = [];
  messages.forEach((m, index) => {
    for (const c of m.tool_calls ?? []) {
      let a = {};
      try {
        a = JSON.parse(c.function.arguments);
      } catch {
        // Malformed arguments; the call is still counted.
      }
      calls.push({ index, id: c.id, name: c.function.name, args: a ?? {} });
    }
  });
  const resultFor = (call) => {
    for (
      let i = call.index + 1;
      i < messages.length && messages[i].role === "tool";
      i++
    )
      if (messages[i].tool_call_id === call.id) return messages[i];
    return undefined;
  };
  const norm = (p) => (typeof p === "string" ? p.replace(/^\.\//, "") : p);
  const readKey = (a) =>
    JSON.stringify(
      Object.keys(a)
        .sort()
        .map((k) => [k, k === "path" ? norm(a.path) : a[k]]),
    );
  // Repeat reads: same file and range read again. "No edit" when no write to
  // that file happened in between (the model re-read without a change).
  const lastRead = new Map(),
    lastWrite = new Map();
  let reads = 0,
    repeatReads = 0,
    repeatReadsNoEdit = 0,
    readChars = 0;
  const readFiles = new Set();
  for (const c of calls) {
    const path = norm(c.args.path);
    if (c.name === "read_file" && path) {
      reads++;
      readFiles.add(path);
      readChars += textOf(resultFor(c)?.content).length;
      const key = readKey(c.args);
      if (lastRead.has(key)) {
        repeatReads++;
        if ((lastWrite.get(path) ?? -1) < lastRead.get(key))
          repeatReadsNoEdit++;
      }
      lastRead.set(key, c.index);
    }
    if ((c.name === "edit_file" || c.name === "write_file") && path)
      lastWrite.set(path, c.index);
  }
  // Done rule: was the full suite run after the last edit, and what did it say?
  // run_command takes executable and args; older transcripts may use command.
  const commandText = (a) =>
    [
      a.executable,
      ...(Array.isArray(a.args) ? a.args : []),
      ...(Array.isArray(a.command) ? a.command : [a.command]),
    ]
      .filter((x) => typeof x === "string")
      .join(" ") || JSON.stringify(a);
  let lastEdit = -1;
  for (const c of calls)
    if (c.name === "edit_file" || c.name === "write_file")
      lastEdit = Math.max(lastEdit, c.index);
  const suiteRuns = calls
    .filter(
      (c) => c.name === "run_command" && /unittest/.test(commandText(c.args)),
    )
    .map((c) => {
      const text = textOf(resultFor(c)?.content);
      let output = text;
      try {
        const parsed = JSON.parse(text);
        if (typeof parsed.output === "string") output = parsed.output;
      } catch {
        // Plain-text result.
      }
      const n = output.match(/Ran (\d+) tests?/);
      return {
        index: c.index,
        command: commandText(c.args)
          .replaceAll(homedir(), "[HOME]")
          .slice(0, 160),
        full: n ? Number(n[1]) === task.testCount : false,
        ran: n ? Number(n[1]) : null,
        outcome: n
          ? /\bFAILED\b/.test(output)
            ? "failed"
            : /\bOK\b/.test(output)
              ? "passed"
              : "unknown"
          : null,
        afterLastEdit: c.index > lastEdit,
      };
    });
  const finalAssistant = [...messages]
    .reverse()
    .find((m) => m.role === "assistant" && !m.tool_calls?.length);
  return {
    tablesUnchanged,
    testsUnchanged,
    unchanged,
    finalSuite,
    session: {
      messages: messages.length,
      compaction: session.compaction
        ? {
            count: session.compaction.count,
            through: session.compaction.through,
            summaryChars: session.compaction.summary?.length ?? 0,
          }
        : null,
      contextMask: session.contextMask ?? null,
      plan: Array.isArray(session.plan) ? session.plan.length : null,
    },
    reads: {
      calls: reads,
      files: readFiles.size,
      repeatReads,
      repeatReadsNoEdit,
      resultChars: readChars,
    },
    edits: calls.filter((c) => c.name === "edit_file").length,
    writes: calls.filter((c) => c.name === "write_file").length,
    suiteRuns,
    doneRule: {
      fullSuiteAfterLastEdit: suiteRuns.some((r) => r.full && r.afterLastEdit),
      lastSuiteOutcome: suiteRuns.at(-1)?.outcome ?? null,
      finalAssistantChars: textOf(finalAssistant?.content).length,
    },
  };
}

// ---- Game task ---------------------------------------------------------------
// Every precondition is checked before the evaluated session; any problem
// stops the run. Site settings come only from the environment:
//   LONG_BENCHMARK_GAME_BROWSER        container:NAME or local:/abs/chromium
//   LONG_BENCHMARK_ACCEPTANCE_CHECKER  /abs/.../lib/workstation/task_acceptance.py
//   LONG_BENCHMARK_ACCEPTANCE_CHECKER_SHA256  optional pin of that file
//   LONG_BENCHMARK_BROWSER_MCP_URL     http://127.0.0.1:PORT/mcp for the agent
async function prepareGame(context) {
  const { root, workspace, state } = context;
  const setup = {
    problems: [],
    acceptance: join(root, "acceptance"),
    source: null,
    transport: null,
    checker: null,
    references: null,
    isolation: null,
    browserMcp: null,
  };
  const problem = (text) => setup.problems.push(text);
  try {
    setup.source = await GAME.loadSource();
  } catch (error) {
    problem(`acceptance source: ${error.message}`);
    return setup;
  }
  await GAME.copySource(setup.source, setup.acceptance);
  await GAME.writeFixture(setup.source, workspace);
  const mcpUrl = process.env.LONG_BENCHMARK_BROWSER_MCP_URL;
  let mcpJson = null;
  if (!mcpUrl)
    problem(
      "LONG_BENCHMARK_BROWSER_MCP_URL is not set; the agent needs the browser to play-test",
    );
  else if (!/^http:\/\/127\.0\.0\.1:[1-9]\d{0,4}\/mcp$/.test(mcpUrl))
    problem("LONG_BENCHMARK_BROWSER_MCP_URL must be http://127.0.0.1:PORT/mcp");
  else {
    setup.browserMcp = mcpUrl;
    // The browser wrapper's documented entry (browser/config.mjs --agent).
    mcpJson = [
      {
        type: "http",
        name: "browser",
        url: mcpUrl,
        headersFrom: {},
        options: {
          includeTools: [...BROWSER_TOOLS],
          alwaysApproveTools: ["browser_navigate"],
          maxOutputChars: 24000,
          callTimeoutMs: 60000,
          maxFrameBytes: 1000000,
          stripImages: true,
          rejectFileOutput: true,
        },
      },
    ];
    await writeFile(join(state, "mcp.json"), JSON.stringify(mcpJson), {
      mode: 0o600,
    });
  }
  const checkerPath = process.env.LONG_BENCHMARK_ACCEPTANCE_CHECKER;
  const identity = await GAME.checkerIdentity(checkerPath);
  if (identity.unavailable) problem(identity.unavailable);
  else {
    const pin = process.env.LONG_BENCHMARK_ACCEPTANCE_CHECKER_SHA256;
    const seal = await GAME.checkerSeal(checkerPath, setup.acceptance);
    if (pin && pin !== identity.files["task_acceptance.py"])
      problem(
        "task_acceptance.py does not match LONG_BENCHMARK_ACCEPTANCE_CHECKER_SHA256",
      );
    else if (seal !== GAME.GAME_SEAL)
      problem(
        `the checker's seal of the source (${seal}) is not the pinned seal`,
      );
    else setup.checker = identity;
  }
  setup.transport = GAME.parseTransport(
    process.env.LONG_BENCHMARK_GAME_BROWSER,
  );
  if (!setup.transport)
    problem(
      "LONG_BENCHMARK_GAME_BROWSER must be container:NAME or local:/abs/chromium",
    );
  else
    try {
      setup.references = await GAME.proveReferences(
        setup.source,
        setup.transport,
      );
      if (!setup.references.ok)
        problem(
          "the play-through did not give the declared reference and known-bug outcomes",
        );
    } catch (error) {
      problem(`evaluator browser: ${error.message}`);
    }
  setup.isolation = await runProbes({ ...context, setup, mcpJson });
  if (!setup.isolation.established)
    problem(
      `isolation not established: ${setup.isolation.findings.join("; ")}`,
    );
  return setup;
}

// Isolation probes: a scripted fake model sends tool calls through the same
// agent build, child wrapper, permission policy and sandbox as the evaluated
// session, from a sibling workspace, while the hidden source sits where it
// stays during that session. Only pass/fail per probe is kept; tool output is
// discarded so that a leak cannot reach the report.
async function runProbes({
  root,
  setup,
  mcpJson,
  agentDirectory,
  ClientApp,
  ndJsonStream,
}) {
  const workspace = join(root, "probe"),
    state = join(root, "probe-state");
  await mkdir(workspace, { mode: 0o700 });
  await mkdir(state, { mode: 0o700 });
  const hidden = join(setup.acceptance, "playthrough.json");
  const repoHidden = [join(GAME.SOURCE, "playthrough.json")];
  const agentCopy = join(
    agentDirectory,
    "test/fixtures/long-benchmark-game/playthrough.json",
  );
  if (
    (await lstat(agentCopy).catch(() => null)) &&
    (await realpath(agentCopy)) !== (await realpath(repoHidden[0]))
  )
    repoHidden.push(agentCopy);
  const nonce = randomUUID();
  const plan = GAME.probePlan({
    workspace,
    acceptance: setup.acceptance,
    hidden,
    repoHidden,
    nonce,
    browser: Boolean(mcpJson),
  });
  const queue = [...plan];
  const server = createServer(async (req, res) => {
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/api/models")
      return res.end(JSON.stringify({ data: [{ id: "probe" }] }));
    let raw = "";
    for await (const part of req) raw += part;
    const request = JSON.parse(raw);
    let message = { role: "assistant", content: "Probe finished." };
    while (request.tools.length && queue.length) {
      const next = queue.shift();
      const name = next.tool.startsWith("browser/")
        ? request.tools.find((t) =>
            t.function.description?.startsWith(`Untrusted MCP ${next.tool}:`),
          )?.function.name
        : next.tool;
      if (!name) continue;
      message = {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: `probe-${next.id}`,
            type: "function",
            function: { name, arguments: JSON.stringify(next.args) },
          },
        ],
      };
      break;
    }
    res.end(
      JSON.stringify({
        choices: [
          {
            message,
            finish_reason: message.tool_calls ? "tool_calls" : "stop",
          },
        ],
      }),
    );
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  await writeFile(
    join(state, "config.json"),
    JSON.stringify({
      url: `http://127.0.0.1:${server.address().port}`,
      model: "probe",
      rounds: 100,
    }),
    { mode: 0o600 },
  );
  if (mcpJson)
    await writeFile(join(state, "mcp.json"), JSON.stringify(mcpJson), {
      mode: 0o600,
    });
  // A synthetic key: the probe never uses the real credential.
  const env = {
    PATH: process.env.PATH,
    HOME: homedir(),
    OPENWEBUI_ACP_HOME: state,
    OPENWEBUI_API_KEY: "synthetic-isolation-probe",
  };
  if (process.env.TMPDIR) env.TMPDIR = process.env.TMPDIR;
  const child = spawn(
    process.execPath,
    [fileURLToPath(import.meta.url), "--child", agentDirectory],
    { cwd: workspace, env, stdio: ["pipe", "pipe", "ignore"] },
  );
  const tools = new Map(),
    outcomes = {},
    previewOrigins = new Set(),
    app = new ClientApp();
  app.onNotification("session/update", ({ params }) => {
    const u = params.update;
    trackPreview(u, tools, previewOrigins);
    if (u.sessionUpdate === "tool_call") tools.set(u.toolCallId, u.title);
    if (
      u.sessionUpdate === "tool_call_update" &&
      ["completed", "failed"].includes(u.status) &&
      String(u.toolCallId).startsWith("probe-")
    )
      outcomes[u.toolCallId.slice(6)] = {
        ok: u.status === "completed",
        text: updateText(u),
      };
  });
  app.onRequest("session/request_permission", ({ params }) => ({
    outcome: {
      outcome: "selected",
      optionId: decide(params, {
        game: true,
        previewOrigins,
        browserUrl: mcpJson?.[0].url,
      })
        ? "once"
        : "deny",
    },
  }));
  const connection = app.connect(
    ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout)),
  );
  let error = null;
  const timer = setTimeout(() => child.kill("SIGKILL"), 300000);
  try {
    await connection.agent.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: {},
    });
    const { sessionId } = await connection.agent.request("session/new", {
      cwd: workspace,
      mcpServers: [],
    });
    await connection.agent.request("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: "Run the isolation probe." }],
    });
  } catch (e) {
    error = String(e?.message ?? e).slice(0, 300);
  } finally {
    clearTimeout(timer);
    connection.close();
    child.kill("SIGTERM");
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
  const after = await GAME.readTree(setup.acceptance, { strict: false });
  const sealUnchanged =
    after.refused.length === 0 && GAME.sealOf(after.files) === GAME.GAME_SEAL;
  const created = Object.keys(after.files).filter(
    (name) => !(name in setup.source.files),
  );
  let repoUnchanged = true;
  try {
    await GAME.loadSource();
  } catch {
    repoUnchanged = false;
  }
  const judged = GAME.judgeProbes(plan, outcomes, {
    marker: setup.source.script.marker,
    nonce,
    sealUnchanged,
    created,
    repoUnchanged,
  });
  if (error) {
    judged.established = false;
    judged.findings.push(`probe session failed: ${error}`);
  }
  return {
    ...judged,
    // Per probe: outcome and, for a refusal, the first line of the agent's
    // error with local paths replaced. Output that holds the marker is dropped.
    results: Object.fromEntries(
      plan.map((p) => {
        const o = outcomes[p.id];
        const line = String(o?.text ?? "")
          .split("\n", 1)[0]
          .replaceAll(root, "[SCRATCH]")
          .replaceAll(GAME.SOURCE, "[SOURCE]/")
          .replaceAll(homedir(), "[HOME]")
          .slice(0, 160);
        return [
          p.id,
          {
            kind: p.kind,
            ok: o?.ok ?? null,
            ...(p.kind === "deny" &&
            o &&
            !o.ok &&
            !line.includes(setup.source.script.marker)
              ? { reason: line }
              : {}),
          },
        ];
      }),
    ),
    paths: {
      workspaceSibling: true,
      repositorySources: repoHidden.length,
      browser: Boolean(mcpJson),
    },
  };
}

// Tool names in the report: MCP tools by their real names.
function renameMcp(report) {
  const map = report.mcpTools ?? {};
  for (const key of ["toolCalls", "toolFailuresByTool"]) {
    const renamed = {};
    for (const [name, n] of Object.entries(report[key]))
      renamed[map[name] ?? name] = (renamed[map[name] ?? name] ?? 0) + n;
    report[key] = renamed;
  }
  const failures = {};
  for (const [key, n] of Object.entries(report.toolFailures)) {
    const [name, ...rest] = key.split(": ");
    failures[[map[name] ?? name, ...rest].join(": ")] = n;
  }
  report.toolFailures = failures;
}

// After the session: unprompted play-testing from the transcript, then the
// hidden play-through and the PLAN-04 verdict.
async function inspectGame({
  setup,
  workspace,
  state,
  sessionId,
  results,
  label,
  mcpTools,
}) {
  const out = {};
  if (sessionId) {
    const session = JSON.parse(
      await readFile(join(state, `session-${sessionId}.json`), "utf8"),
    );
    out.unpromptedPlaytest = GAME.detectPlaytest(
      GAME.callsFromTranscript(session, mcpTools),
      { browserAvailable: Boolean(setup.browserMcp) },
    );
  } else out.unpromptedPlaytest = { observed: null, reason: "no session" };
  const observation = await GAME.playWorkspace({
    source: setup.source,
    transport: setup.transport,
    references: setup.references,
    workspace,
    out: results,
  });
  const hidden = await GAME.runChecker({
    checker: setup.checker.path,
    source: setup.acceptance,
    workspace,
    state: observation.unavailable
      ? null
      : join(results, "playthrough-state.json"),
    output: join(results, "acceptance-result.json"),
    runId: label,
  });
  hidden.observation = observation.unavailable
    ? { unavailable: observation.unavailable }
    : {
        complete: observation.complete,
        entrySha256: observation.entry_sha256,
        servedTreeSha256: observation.served_tree_sha256,
        failures: observation.failures,
        screenshots: observation.screenshots,
        browserVersion: observation.browser_version ?? null,
      };
  out.hiddenChecks = hidden;
  return out;
}
