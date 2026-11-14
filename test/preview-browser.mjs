// Explicit real-browser acceptance. Requires the documented local container.
// Fake inference drives the real ACP tool loop; no credentials are accessed.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, realpath, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ClientApp } from "@agentclientprotocol/sdk";

const temporary = await realpath(
  await mkdtemp(join(tmpdir(), "ow-preview-browser-")),
);
process.env.OPENWEBUI_ACP_HOME = join(temporary, "state");
process.env.OPENWEBUI_API_KEY = "synthetic-preview-browser";
const { createAgent } = await import("../dist/agent.js");
const { writeJson, configSchema } = await import("../dist/config.js");
const { sandboxPolicy } = await import("../dist/sandbox.js");
const root = join(temporary, "workspace");
await mkdir(join(root, "site/assets"), { recursive: true });
const allowed = JSON.parse(
  await readFile(
    new URL("../browser/allowed-tools.json", import.meta.url),
    "utf8",
  ),
);
const html =
  '<!doctype html><title>ACP preview game</title><button id="start">Start</button><button id="target" disabled>Target</button><button id="restart">Restart</button><output id="score" aria-live="polite">Score: 0</output><script src="/assets/game.js"></script>';
const javascript =
  'let score=0; const start=document.getElementById("start"), target=document.getElementById("target"), restart=document.getElementById("restart"), output=document.getElementById("score"); start.onclick=()=>{target.disabled=false;}; target.onclick=()=>{output.textContent="Score: "+ ++score;}; restart.onclick=()=>{score=0;output.textContent="Score: 0";target.disabled=true;};';
let stage = 0,
  preview,
  failed,
  snapshot = "";
const toolCalls = [];
function ref(text, name) {
  const line = text.split("\n").find((l) => l.includes(`button "${name}"`));
  const ref = line?.match(/\[ref=((?:f\d+)?e\d+)\]/)?.[1];
  assert(ref, `Missing button ${name}`);
  return ref;
}
function last(req) {
  return req.messages.filter((m) => m.role === "tool").at(-1)?.content;
}
function toolText(req) {
  const value = JSON.parse(last(req));
  assert.notEqual(value.isError, true);
  return value.content
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("\n");
}
const backend = createServer(async (req, res) => {
  res.setHeader("Content-Type", "application/json");
  if (req.url === "/api/models") {
    res.end(JSON.stringify({ data: [{ id: "fixture" }] }));
    return;
  }
  let body = "";
  for await (const chunk of req) body += chunk;
  const input = JSON.parse(body);
  const invoke = (name, args) => {
    const mapped = name.startsWith("browser_")
      ? input.tools.find((t) =>
          t.function.description.startsWith(`Untrusted MCP browser/${name}:`),
        )?.function.name
      : name;
    assert(mapped, `Tool ${name} missing`);
    toolCalls.push(name);
    return {
      id: `fixture-${stage}-${toolCalls.length}`,
      type: "function",
      function: { name: mapped, arguments: JSON.stringify(args) },
    };
  };
  let calls;
  try {
    switch (stage++) {
      case 0:
        calls = [
          invoke("write_file", {
            path: "site/index.html",
            before: null,
            after: html,
          }),
          invoke("write_file", {
            path: "site/assets/game.js",
            before: null,
            after: javascript,
          }),
        ];
        break;
      case 1:
        calls = [
          invoke("start_preview", {
            entry: "site/index.html",
            files: ["site/index.html", "site/assets/game.js"],
            timeout_ms: 60000,
          }),
        ];
        break;
      case 2:
        preview = JSON.parse(last(input));
        assert.match(preview.containerUrl, /\/index.html$/);
        calls = [invoke("browser_navigate", { url: preview.containerUrl })];
        break;
      case 3:
        toolText(input);
        calls = [invoke("browser_snapshot", {})];
        break;
      case 4:
        snapshot = toolText(input);
        assert.match(snapshot, /Score: 0/);
        calls = [
          invoke("browser_click", {
            target: ref(snapshot, "Start"),
            element: "Start the fixture game",
          }),
        ];
        break;
      case 5:
        toolText(input);
        calls = [invoke("browser_snapshot", {})];
        break;
      case 6:
        snapshot = toolText(input);
        calls = [
          invoke("browser_click", {
            target: ref(snapshot, "Target"),
            element: "Score one point",
          }),
        ];
        break;
      case 7:
        toolText(input);
        calls = [invoke("browser_snapshot", {})];
        break;
      case 8:
        snapshot = toolText(input);
        assert.match(snapshot, /Score: 1/);
        calls = [
          invoke("browser_click", {
            target: ref(snapshot, "Restart"),
            element: "Reset the fixture game",
          }),
        ];
        break;
      case 9:
        toolText(input);
        calls = [invoke("browser_snapshot", {})];
        break;
      case 10:
        snapshot = toolText(input);
        assert.match(snapshot, /Score: 0/);
        calls = [invoke("stop_preview", { id: preview.id })];
        break;
      case 11:
        assert.match(last(input), /Preview stopped/);
        await assert.rejects(fetch(preview.url));
        break;
      default:
        throw Error("Unexpected extra model round");
    }
  } catch (error) {
    failed = error;
  }
  const message =
    calls && !failed
      ? { role: "assistant", content: null, tool_calls: calls }
      : {
          role: "assistant",
          content: failed
            ? "Fixture failed"
            : "Start, scoring and restart verified; preview stopped.",
        };
  res.end(
    JSON.stringify({
      choices: [
        { message, finish_reason: message.tool_calls ? "tool_calls" : "stop" },
      ],
    }),
  );
});
await new Promise((r) => backend.listen(0, "127.0.0.1", r));
await writeJson(
  "config.json",
  configSchema.parse({
    url: `http://127.0.0.1:${backend.address().port}`,
    model: "fixture",
  }),
);
await writeJson("mcp.json", [
  {
    type: "http",
    name: "browser",
    url: "http://127.0.0.1:8931/mcp",
    headersFrom: {},
    options: {
      includeTools: allowed,
      alwaysApproveTools: ["browser_navigate"],
      callTimeoutMs: 60000,
      maxOutputChars: 24000,
      maxFrameBytes: 1000000,
      stripImages: true,
      rejectFileOutput: true,
    },
  },
]);
assert.equal(
  sandboxPolicy({ mode: "workspace", root }, join(temporary, "tmp")).network
    .allowLocalBinding,
  false,
);
const agent = createAgent({
    sandboxCommand: async () => {
      throw Error("No workspace command should be required for static preview");
    },
  }),
  app = new ClientApp(),
  approvals = [];
app.onNotification("session/update", () => {});
app.onRequest("session/request_permission", ({ params }) => {
  const title = params.toolCall.title;
  assert(
    title.startsWith("Activate ") ||
      title.startsWith("MCP browser:") ||
      title.startsWith("Write ") ||
      title.startsWith("Start static preview ") ||
      title.startsWith("Call browser/"),
    `Unexpected operation: ${title}`,
  );
  if (title.startsWith("Start static preview "))
    assert.equal(
      agent.sessions.values().next().value.preview.info(),
      undefined,
    );
  if (title.startsWith("Call browser/"))
    assert.deepEqual(
      params.options.map((o) => o.optionId),
      ["once", "deny"],
    );
  approvals.push(title.split(":")[0]);
  return { outcome: { outcome: "selected", optionId: "once" } };
});
const connection = app.connect(agent.app);
try {
  await connection.agent.request("initialize", {
    protocolVersion: 1,
    clientCapabilities: {},
  });
  const { sessionId } = await connection.agent.request("session/new", {
    cwd: root,
    mcpServers: [],
  });
  const response = await connection.agent.request("session/prompt", {
    sessionId,
    prompt: [
      {
        type: "text",
        text: "Create and play the static fixture, then close its preview.",
      },
    ],
  });
  if (failed) throw failed;
  assert.equal(response.stopReason, "end_turn");
  assert.equal(stage, 12);
  assert.equal(agent.sessions.get(sessionId).preview.info(), undefined);
  assert.equal(
    approvals.filter((t) => t.startsWith("Call browser/")).length,
    8,
  );
  console.log(
    JSON.stringify({
      result: "passed",
      workflow:
        "ACP write → approved preview → container navigation → Start → Target (score 1) → Restart (score 0) → stop",
      model: "deterministic fake",
      browser: "real configured container",
      toolCalls,
      approvals: approvals.length,
      commandSandboxChanged: false,
    }),
  );
} finally {
  connection.close();
  await agent.close();
  backend.closeAllConnections();
  await new Promise((r) => backend.close(r));
}
