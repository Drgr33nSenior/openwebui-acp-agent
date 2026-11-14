// Offline context benchmark; never imported by ordinary tests and never
// contacts a real model. A scripted fake model replays one long coding session
// (60 tool rounds over two turns: listing, searches, whole-file reads, small
// edits, whole-file rewrites, commands and plan updates) against the agent
// built in AGENT_DIRECTORY, and the fake server records every request.
//
//   node test/manual-context-benchmark.mjs AGENT_DIRECTORY
//
// Run it against two builds to compare them. Tokens are serialized request
// characters divided by CHARS_PER_TOKEN, the estimate the fake server also
// reports as prompt_tokens; they are not tokenizer counts. All state lives in
// a fresh temporary directory.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";

assert(
  process.argv.length === 3,
  "Usage: node test/manual-context-benchmark.mjs AGENT_DIRECTORY",
);
const agentDirectory = resolve(process.argv[2]);
const CHARS_PER_TOKEN = 3.75;
const temporary = await realpath(await mkdtemp(join(tmpdir(), "ow-ctx-")));
process.env.OPENWEBUI_ACP_HOME = join(temporary, "state");
process.env.OPENWEBUI_API_KEY = "synthetic-benchmark-key";
const load = (name) =>
  import(pathToFileURL(join(agentDirectory, "dist", name)).href);
const { createAgent } = await load("agent.js");
// The client must be the SDK instance the measured build itself loads.
const { ClientApp } = await import(
  pathToFileURL(
    createRequire(join(agentDirectory, "package.json")).resolve(
      "@agentclientprotocol/sdk",
    ),
  ).href
);
const { directory, writeJson, configSchema } = await load("config.js");
assert.equal(directory, process.env.OPENWEBUI_ACP_HOME);

// ---- Workspace: source files sized like real ones (6k to 90k characters) ---
const SIZES = [6, 9, 12, 14, 18, 22, 26, 30, 36, 44, 60, 90];
const file = (n) => `src/module${String(n).padStart(2, "0")}.ts`;
function source(n, chars) {
  const lines = [];
  for (let i = 0; lines.join("\n").length < chars; i++)
    lines.push(
      i % 40 === 0
        ? `// marker-${n}-${i / 40}: TODO tidy section ${i / 40} of module ${n}`
        : `export function fn${n}_${i}(value: number): number { return value * ${i} + ${n}; }`,
    );
  return lines.join("\n") + "\n";
}
async function workspace() {
  const cwd = await realpath(await mkdtemp(join(temporary, "project-")));
  await mkdir(join(cwd, "src"));
  await mkdir(join(cwd, "lib"));
  for (const [i, k] of SIZES.entries())
    await writeFile(join(cwd, file(i + 1)), source(i + 1, k * 1000));
  for (let i = 0; i < 300; i++)
    await writeFile(
      join(cwd, "lib", `helper-${i}.ts`),
      `export const h${i} = ${i};\n`,
    );
  return cwd;
}

// ---- The scripted session ---------------------------------------------------
const plan = (done) => ({
  name: "update_plan",
  args: {
    entries: [
      "Survey the modules",
      "Tidy each module",
      "Run the checks",
      "Report",
    ].map((content, i) => ({
      content,
      priority: i < 2 ? "high" : "medium",
      status: i < done ? "completed" : i === done ? "in_progress" : "pending",
    })),
  },
});
const read = (n) => ({ name: "read_file", args: { path: file(n) } });
const edits = new Map();
// Replaces the next untouched marker line of module n.
const edit = (n) => () => {
  const k = edits.get(n) ?? 0;
  edits.set(n, k + 1);
  return {
    name: "edit_file",
    args: {
      path: file(n),
      old_string: `// marker-${n}-${k}: TODO tidy section ${k} of module ${n}`,
      new_string: `// section ${k} of module ${n}: tidied\nexport const tidied${n}_${k} = true;`,
    },
  };
};
// A whole-file rewrite: before is the current file, as write_file requires.
const rewrite = (n) => async (cwd) => {
  const before = await readFile(join(cwd, file(n)), "utf8");
  return {
    name: "write_file",
    args: {
      path: file(n),
      before,
      after: before.replaceAll("value *", "value /"),
    },
  };
};
const create = (name, chars) => () => ({
  name: "write_file",
  args: { path: name, before: null, after: source(99, chars) },
});
const search = (text) => ({ name: "search_text", args: { text } });
const run = (lines, code = 0) => ({
  name: "run_command",
  args: {
    executable: process.execPath,
    args: [
      "-e",
      `for (let i = 0; i < ${lines}; i++) console.log("ok " + i + " - module check passes with the expected value"); process.exit(${code});`,
    ],
  },
});
const TURNS = [
  {
    prompt: "Tidy the TODO sections across src and keep the checks passing.",
    steps: [
      plan(0),
      { name: "list_files", args: {} },
      search("export function fn1_"),
      read(1),
      read(2),
      read(3),
      read(4),
      read(5),
      read(6),
      edit(1),
      edit(2),
      run(160),
      plan(1),
      read(7),
      edit(7),
      rewrite(3),
      read(8),
      edit(8),
      run(160),
      read(9),
      edit(9),
      read(1),
      edit(1),
      search("TODO tidy section 1 "),
      read(10),
      edit(10),
      run(160, 1),
      read(10),
      edit(10),
      run(160),
      plan(1),
      read(11),
      edit(11),
      rewrite(4),
      read(12),
      edit(12),
      run(160),
      read(5),
      edit(5),
      read(6),
      edit(6),
      create("src/summary.ts", 8000),
      run(160),
      plan(2),
      read(2),
    ],
  },
  {
    prompt:
      "Now tidy the next section of the modules you rewrote and re-check.",
    steps: [
      read(3),
      edit(3),
      read(7),
      edit(7),
      run(160),
      read(9),
      edit(9),
      search("tidied"),
      read(11),
      edit(11),
      run(160),
      rewrite(1),
      run(160),
      plan(3),
      read(12),
    ],
  },
];

// ---- Fake Open WebUI --------------------------------------------------------
let model, cwd, queue, thinking, records;
const server = createServer(async (req, res) => {
  res.setHeader("Content-Type", "application/json");
  if (req.url === "/api/models")
    return res.end(JSON.stringify({ data: [model] }));
  let raw = "";
  for await (const part of req) raw += part;
  const request = JSON.parse(raw);
  const chars =
    JSON.stringify(request.messages).length +
    JSON.stringify(request.tools).length;
  const summary = request.tools.length === 0;
  let message;
  if (summary)
    message = {
      role: "assistant",
      content:
        "Task: tidy TODO sections across src. " +
        "Modules read and edited so far are listed in the transcript; checks passed after each batch. ".repeat(
          20,
        ),
    };
  else {
    const step = queue.shift();
    const next = typeof step === "function" ? await step(cwd) : step;
    message = next
      ? {
          role: "assistant",
          content: "",
          tool_calls: [
            {
              id: `call-${records.length}`,
              type: "function",
              function: {
                name: next.name,
                arguments: JSON.stringify(next.args),
              },
            },
          ],
        }
      : {
          role: "assistant",
          content: "The sections are tidied and the checks pass.",
        };
    if (thinking) message.reasoning_content = "t".repeat(thinking * 4);
  }
  const visible = Math.ceil(
    ((message.content ?? "").length +
      JSON.stringify(message.tool_calls ?? "").length) /
      CHARS_PER_TOKEN,
  );
  records.push({
    summary,
    chars,
    messages: JSON.stringify(request.messages),
    max_tokens: request.max_tokens ?? null,
  });
  res.end(
    JSON.stringify({
      choices: [
        { message, finish_reason: message.tool_calls ? "tool_calls" : "stop" },
      ],
      usage: {
        prompt_tokens: Math.ceil(chars / CHARS_PER_TOKEN),
        completion_tokens: visible + (summary ? 0 : thinking),
      },
    }),
  );
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const url = `http://127.0.0.1:${server.address().port}`;
await writeJson(
  "config.json",
  configSchema.parse({ url, model: "fixture", rounds: 100 }),
);

const efforts = {
  provider_model_controls: {
    reasoning_effort: {
      default: "medium",
      options: { medium: {}, high: {}, xhigh: {} },
    },
  },
};
const tokens = (chars) => Math.round(chars / CHARS_PER_TOKEN);

async function arm(label, metadata, effort, thinkingTokens) {
  model = { id: "fixture", ...metadata, ...efforts };
  cwd = await workspace();
  thinking = thinkingTokens;
  records = [];
  edits.clear();
  const app = new ClientApp(),
    agent = createAgent(),
    usage = [];
  app.onNotification("session/update", ({ params }) => {
    if (params.update.sessionUpdate === "usage_update")
      usage.push(params.update.used);
  });
  app.onRequest("session/request_permission", () => ({
    outcome: { outcome: "selected", optionId: "once" },
  }));
  const connection = app.connect(agent.app);
  await connection.agent.request("initialize", {
    protocolVersion: 1,
    clientCapabilities: {},
  });
  const { sessionId } = await connection.agent.request("session/new", {
    cwd,
    mcpServers: [],
  });
  await connection.agent.request("session/set_config_option", {
    sessionId,
    configId: "reasoning",
    value: JSON.stringify(["reasoning_effort", effort]),
  });
  const stops = [];
  let unplayed = 0;
  // The agent writes diagnostics (mask and recovery events) to stderr.
  const write = process.stderr.write;
  let masks = 0;
  process.stderr.write = (chunk) => {
    if (String(chunk).includes('"event":"context_mask"')) masks++;
    return true;
  };
  try {
    for (const turn of TURNS) {
      queue = [...turn.steps];
      try {
        const result = await connection.agent.request("session/prompt", {
          sessionId,
          prompt: [{ type: "text", text: turn.prompt }],
        });
        stops.push(result.stopReason);
      } catch (error) {
        stops.push("error: " + String(error.message).slice(0, 120));
      }
      unplayed += queue.length;
    }
  } finally {
    process.stderr.write = write;
  }
  const session = agent.sessions.get(sessionId);
  const results = session.messages.filter((m) => m.role === "tool");
  const coding = records.filter((r) => !r.summary);
  // Characters of each coding request that the previous one did not already
  // hold as its prefix: what a prefix cache has to prefill again.
  let fresh = 0;
  let rebuilt = 0;
  for (const [i, r] of coding.entries()) {
    const previous = coding[i - 1]?.messages ?? "";
    let shared = 0;
    const limit = Math.min(previous.length, r.messages.length);
    while (shared < limit && previous[shared] === r.messages[shared]) shared++;
    fresh += r.messages.length - shared;
    // A request that lost more of the previous one than a trailing note.
    if (i && previous.length - shared > 2000) rebuilt++;
  }
  connection.close();
  await agent.close();
  return {
    arm: label,
    codingRequests: coding.length,
    toolResults: results.length,
    toolResultChars: results.reduce((n, m) => n + m.content.length, 0),
    summedPromptTokens: tokens(coding.reduce((n, r) => n + r.chars, 0)),
    peakPromptTokens: tokens(Math.max(...coding.map((r) => r.chars))),
    compactions: records.filter((r) => r.summary).length,
    summaryRequestTokens: tokens(
      records.filter((r) => r.summary).reduce((n, r) => n + r.chars, 0),
    ),
    maskBatches: masks,
    prefixRebuilds: rebuilt,
    uncachedPromptTokens: tokens(fresh),
    peakReportedUsage: Math.max(...usage),
    maxTokensSent: [...new Set(coding.map((r) => r.max_tokens))],
    stopReasons: stops,
    scriptedStepsNotPlayed: unplayed,
  };
}

const family = { context_window: 100768, max_output_tokens: 12288 };
const coder = { context_window: 262112, max_output_tokens: 12288 };
const report = [
  await arm("family 100,768 / medium", family, "medium", 0),
  await arm(
    "family 100,768 / xhigh, 6,000 thinking tokens per reply",
    family,
    "xhigh",
    6000,
  ),
  await arm("coder 262,112 / medium", coder, "medium", 0),
];
server.close();
console.log(
  JSON.stringify(
    { agentDirectory, charsPerToken: CHARS_PER_TOKEN, report },
    null,
    2,
  ),
);
