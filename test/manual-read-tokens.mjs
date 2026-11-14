// Offline measurement only; never imported by ordinary tests and never contacts a
// model. A scripted fake model replays a read-heavy exploration against a built
// agent and reports the size of every tool result it receives.
//
//   node test/manual-read-tokens.mjs <agent checkout> <fixture directory> [default|full]
//
// The checkout must contain dist/ (npm run build). The fixture directory is
// copied into a fresh workspace. "full" follows each read_file footer to the end
// of the file; builds without paging have no footer, so both modes match there.
// Tokens are estimated at four characters each; no tokenizer is loaded.
import { cp, mkdtemp, readdir, realpath } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { ClientApp } from "@agentclientprotocol/sdk";

const [checkout, fixture, mode = "default"] = process.argv.slice(2);
if (!checkout || !fixture || !["default", "full"].includes(mode)) {
  process.stderr.write(
    "usage: node test/manual-read-tokens.mjs <checkout> <fixture> [default|full]\n",
  );
  process.exit(2);
}
const scratch = await realpath(
  await mkdtemp(join(tmpdir(), "ow-read-tokens-")),
);
process.env.OPENWEBUI_ACP_HOME = join(scratch, "state");
process.env.OPENWEBUI_API_KEY = "synthetic-read-tokens-key";
const dist = (name) =>
  import(pathToFileURL(join(resolve(checkout), "dist", name)).href);
const { createAgent } = await dist("agent.js");
const { writeJson, configSchema } = await dist("config.js");

const cwd = join(scratch, "workspace");
await cp(resolve(fixture), cwd, { recursive: true });
const sources = [];
for (const entry of await readdir(cwd, {
  recursive: true,
  withFileTypes: true,
}))
  if (entry.isFile())
    sources.push(
      relative(cwd, join(entry.parentPath, entry.name)).replaceAll("\\", "/"),
    );
sources.sort();

// The task: orient, search for the entry points, read the relevant files, then
// look up one helper. The same calls go to every build.
const plan = [
  ["list_files", {}],
  ["search_text", { text: "export function" }],
  ...sources.map((path) => ["read_file", { path }]),
  ["search_text", { text: "redact(" }],
];
const results = [];
let next = 0;
let id = 0;
const server = createServer(async (req, res) => {
  res.setHeader("Content-Type", "application/json");
  if (req.url === "/api/models")
    return res.end(
      JSON.stringify({
        data: [{ id: "fixture", context_window: 10_000_000 }],
      }),
    );
  // Decode once: a multi-byte character can span two chunks.
  const chunks = [];
  for await (const part of req) chunks.push(part);
  const raw = Buffer.concat(chunks).toString("utf8");
  const request = JSON.parse(raw);
  const last = request.messages.at(-1);
  if (last?.role === "tool") {
    const call = results.at(-1);
    call.chars = last.content.length;
    const more = /continue with offset=(\d+)\]$/.exec(last.content);
    if (mode === "full" && call.name === "read_file" && more)
      plan.splice(next, 0, [
        "read_file",
        { path: call.args.path, offset: Number(more[1]) },
      ]);
  }
  const step = plan[next++];
  let message = { role: "assistant", content: "Done" };
  if (step) {
    const [name, args] = step;
    results.push({ name, args });
    message = {
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: `call-${++id}`,
          type: "function",
          function: { name, arguments: JSON.stringify(args) },
        },
      ],
    };
  }
  res.end(
    JSON.stringify({
      choices: [{ message, finish_reason: step ? "tool_calls" : "stop" }],
    }),
  );
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const url = `http://127.0.0.1:${server.address().port}`;
await writeJson(
  "config.json",
  configSchema.parse({ url, model: "fixture", rounds: 100 }),
);
const app = new ClientApp();
const agent = createAgent();
app.onNotification("session/update", () => {});
app.onRequest("session/request_permission", () => ({
  // Workspace activation only: reads and searches need no operation approval.
  outcome: { outcome: "selected", optionId: "once" },
}));
const connection = app.connect(agent.app);
try {
  await connection.agent.request("initialize", {
    protocolVersion: 1,
    clientCapabilities: {},
  });
  const { sessionId } = await connection.agent.request("session/new", {
    cwd,
    mcpServers: [],
  });
  await connection.agent.request("session/prompt", {
    sessionId,
    prompt: [{ type: "text", text: "Explain how sessions are stored" }],
  });
} finally {
  connection.close();
  await agent.close();
  server.close();
}
const total = (filter) =>
  results.filter(filter).reduce((sum, r) => sum + (r.chars ?? 0), 0);
const summary = {
  mode,
  calls: results.length,
  readCalls: results.filter((r) => r.name === "read_file").length,
  readChars: total((r) => r.name === "read_file"),
  searchChars: total((r) => r.name === "search_text"),
  listChars: total((r) => r.name === "list_files"),
  allChars: total(() => true),
};
summary.estimatedReadTokens = Math.round(summary.readChars / 4);
summary.estimatedSearchTokens = Math.round(summary.searchChars / 4);
summary.estimatedAllTokens = Math.round(summary.allChars / 4);
process.stdout.write(
  JSON.stringify(
    {
      ...summary,
      perCall: results.map((r) => [
        r.name,
        r.args.path ?? r.args.text ?? "",
        r.chars,
      ]),
    },
    null,
    1,
  ) + "\n",
);
