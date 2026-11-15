// Explicit live check; never imported by the normal test suite. One turn sends
// a 640×480 two-colour PNG through view_image and the real inference path
// (agent -> Open WebUI -> whatever serves the model) and prints what the model
// said it saw, with the reported context usage per request.
//
//   node test/manual-image-check.mjs --live AGENT_DIRECTORY
//
// The child agent authenticates through its normal OS credential-store flow.
// This client copies only named non-secret connection settings; it never reads
// a key or the sign-in state, and never copies transcripts, trust or commands.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { lstat, mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Readable, Writable } from "node:stream";
import { crc32, deflateSync } from "node:zlib";
import { ClientApp, ndJsonStream } from "@agentclientprotocol/sdk";

const args = process.argv.slice(2);
if (args[0] !== "--live" || !args[1] || args.length > 2) {
  console.error(
    "Usage: node test/manual-image-check.mjs --live AGENT_DIRECTORY",
  );
  process.exit(2);
}
const agentDirectory = resolve(args[1]);
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
const config = Object.fromEntries(
  [
    "url",
    "model",
    "header",
    "timeoutMs",
    "firstContentTimeoutMs",
    "idleTimeoutMs",
  ]
    .filter((k) => original[k] !== undefined)
    .map((k) => [k, original[k]]),
);
assert.equal(typeof config.url, "string");
assert.equal(typeof config.model, "string");
// The view_image round and the answer; nothing else.
config.rounds = 3;

// Left half red, right half blue.
function png(width, height) {
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const out = Buffer.alloc(8 + data.length + 4);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc32(body), 8 + data.length);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  const row = Buffer.alloc(1 + width * 3);
  for (let x = 0; x < width; x++)
    row.set(x < width / 2 ? [220, 30, 30] : [30, 30, 220], 1 + x * 3);
  return Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(Buffer.concat(Array(height).fill(row)))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const root = await mkdtemp(join(tmpdir(), "ow-image-check-"));
const workspace = join(root, "workspace"),
  state = join(root, "state");
await mkdir(workspace, { mode: 0o700 });
await mkdir(state, { mode: 0o700 });
await writeFile(join(state, "config.json"), JSON.stringify(config), {
  mode: 0o600,
});
await writeFile(join(workspace, "probe.png"), png(640, 480));
const sanitize = (s) =>
  String(s)
    .replaceAll(config.url, "[BACKEND]")
    .replaceAll(config.model, "[MODEL]")
    .replaceAll(root, "[SCRATCH]")
    .replaceAll(homedir(), "[HOME]");

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
  {
    cwd: workspace,
    env,
    stdio: ["pipe", "pipe", "pipe"],
  },
);
let stderr = "";
child.stderr.on("data", (chunk) => {
  if (stderr.length < 20000) stderr += chunk;
});
const report = { tools: [], usage: [], text: "", stopReason: null };
const app = new ClientApp();
app.onNotification("session/update", ({ params }) => {
  const u = params.update;
  if (u.sessionUpdate === "agent_message_chunk") report.text += u.content.text;
  if (u.sessionUpdate === "usage_update") report.usage.push(u.used);
  if (u.sessionUpdate === "tool_call") report.tools.push(u.title);
  if (u.sessionUpdate === "tool_call_update" && u.status)
    report.tools.push(
      `${u.status}: ${(u.content ?? [])
        .map((c) => c.content?.text ?? "")
        .join(" ")
        .slice(0, 200)}`,
    );
});
app.onRequest("session/request_permission", ({ params }) => {
  // Only the scratch workspace activation is approved.
  const permit = (params.toolCall.title ?? "").startsWith(
    "Activate exact workspace ",
  );
  const optionId = permit ? "once" : "deny";
  report.tools.push(
    `permission ${optionId}: ${sanitize(params.toolCall.title).slice(0, 120)}`,
  );
  return { outcome: { outcome: "selected", optionId } };
});
const connection = app.connect(
  ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout)),
);
try {
  await connection.agent.request("initialize", {
    protocolVersion: 1,
    clientCapabilities: {},
  });
  const { sessionId } = await connection.agent.request("session/new", {
    cwd: workspace,
    mcpServers: [],
  });
  const response = await connection.agent.request("session/prompt", {
    sessionId,
    prompt: [
      {
        type: "text",
        text: "Call view_image once with path probe.png. Then answer in one short sentence: which colour is on the left half and which on the right half? Call no other tool.",
      },
    ],
  });
  report.stopReason = response.stopReason;
} catch (e) {
  report.error = sanitize(e.message).slice(0, 2000);
} finally {
  connection.close();
  child.kill("SIGTERM");
}
report.text = sanitize(report.text).slice(0, 4000);
report.tools = report.tools.map(sanitize);
if (report.error || report.stopReason !== "end_turn")
  report.stderr = sanitize(stderr).slice(-4000);
console.log(JSON.stringify(report, null, 2));
