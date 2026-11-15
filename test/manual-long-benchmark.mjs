// Long-session benchmark runner; explicit use only, never imported by ordinary
// tests. It gives the agent built in AGENT_DIRECTORY the synthetic 126-test
// project from manual-long-benchmark-fixture.mjs and records how the session
// went. Live runs on a shared server go through manual-long-benchmark-wait.mjs,
// which enforces the overnight window and an idle inference server.
//
//   LONG_BENCHMARK_RESULTS=/absolute/results/dir \
//     node test/manual-long-benchmark.mjs --live AGENT_DIRECTORY LABEL [TIMEOUT_MINUTES]
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
import { longTask } from "./manual-long-benchmark-fixture.mjs";

const MAX_CONTINUATIONS = 8;
const CONTINUE_PROMPT = "Continue with the remaining work.";
const USAGE_WAIT_MS = 2000;
const args = process.argv.slice(2);

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
  let request = 0;
  Backend.prototype.complete = async function (...input) {
    const [messages, tools] = input;
    const n = ++request;
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
  assert(
    args[0] === "--live" && (args.length === 3 || args.length === 4),
    "Usage: LONG_BENCHMARK_RESULTS=DIR node test/manual-long-benchmark.mjs --live AGENT_DIRECTORY LABEL [TIMEOUT_MINUTES]",
  );
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
  const task = longTask();
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
    task: "long-suite",
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
    // This task has no hidden checks and no interactive program to play-test;
    // null means not applicable, not "none".
    hiddenChecks: null,
    unpromptedPlaytest: null,
    stopReason: null,
    timedOut: false,
    elapsedMs: 0,
    usageUpdates: [],
    peakContextTokens: null,
    latestContextTokens: null,
    contextSize: null,
  };
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
    if (u.sessionUpdate === "tool_call" && /^[a-z_]+$/.test(u.title)) {
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
    if (!allow) report.denied++;
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
