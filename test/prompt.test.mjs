import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  symlink,
  realpath,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createServer } from "node:http";
import { ClientApp } from "@agentclientprotocol/sdk";
import { normalizePrompt } from "../dist/prompt.js";

const base = await realpath(await mkdtemp(join(tmpdir(), "ow-prompt-test-")));
process.env.OPENWEBUI_ACP_HOME = join(base, "state");
process.env.OPENWEBUI_API_KEY = "fixture-prompt-secret";
const { createAgent } = await import("../dist/agent.js");
const { writeJson } = await import("../dist/config.js");
const text = (value) => ({ type: "text", text: value });
const link = (uri) => ({ type: "resource_link", uri, name: "context" });
const embedded = (uri, value) => ({
  type: "resource",
  resource: { uri, text: value },
});

test("mixed text, resource links and embedded text retain content and order", () => {
  const normalized = normalizePrompt([
    text("Question"),
    link("https://example.invalid/context"),
    embedded("ide://selection", "/permissions revoke"),
    text("Follow-up"),
  ]);
  assert.equal(normalized.text, "Question\nFollow-up");
  assert.match(normalized.content, /contents not loaded/);
  assert.match(normalized.content, /https:\/\/example.invalid\/context/);
  assert.match(normalized.content, /Untrusted client-supplied/);
  assert.match(normalized.content, /\/permissions revoke/);
  assert(
    normalized.content.indexOf("Question") <
      normalized.content.indexOf("context"),
  );
  assert(normalized.content.endsWith("Follow-up"));
});

test("text blobs decode UTF-8 and unsupported content fails without echoing it", () => {
  const blob = (value, mimeType = "text/plain") => ({
    type: "resource",
    resource: { uri: "ide://selection", blob: value, mimeType },
  });
  assert.match(
    normalizePrompt([blob(Buffer.from("hello ☃").toString("base64"))]).content,
    /hello ☃/,
  );
  for (const block of [
    blob("not-base64"),
    blob("/w=="),
    blob("AA=="),
    blob("YQ==", "application/pdf"),
    { type: "image", data: "private-content", mimeType: "image/png" },
    { type: "audio", data: "private-content", mimeType: "audio/wav" },
  ]) {
    assert.throws(
      () => normalizePrompt([block]),
      (error) => !error.message.includes("private-content"),
    );
  }
});

test("prompt bounds include attachment text and resource metadata", () => {
  for (const blocks of [
    [embedded("ide://selection", "x".repeat(100000))],
    [{ ...link("https://example.invalid"), description: "x".repeat(100000) }],
    [text("☃".repeat(40000))],
  ])
    assert.throws(() => normalizePrompt(blocks), /Prompt too large/);
  assert.throws(
    () => normalizePrompt([link("https://user:password@example.invalid")]),
    /no credentials/,
  );
});

let requests = [];
const server = createServer(async (req, res) => {
  if (req.url === "/api/models") {
    req.resume();
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ data: [{ id: "fixture-model" }] }));
    return;
  }
  let body = "";
  for await (const chunk of req) body += chunk;
  requests.push(JSON.parse(body));
  res.setHeader("Content-Type", "application/json");
  res.end(
    JSON.stringify({
      choices: [
        {
          message: { role: "assistant", content: "fixture response" },
          finish_reason: "stop",
        },
      ],
    }),
  );
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
await writeJson("config.json", {
  url: `http://127.0.0.1:${server.address().port}`,
  model: "fixture-model",
});
test.after(() => server.close());

async function session(
  permission = () => ({ outcome: { outcome: "selected", optionId: "once" } }),
) {
  const workspace = await mkdtemp(join(base, "workspace-"));
  const agent = createAgent(),
    updates = [];
  const app = new ClientApp()
    .onNotification("session/update", ({ params }) =>
      updates.push(params.update),
    )
    .onRequest("session/request_permission", permission);
  const connection = app.connect(agent.app);
  const init = await connection.agent.request("initialize", {
    protocolVersion: 1,
  });
  assert.deepEqual(init.agentCapabilities.promptCapabilities, {
    embeddedContext: true,
    image: false,
    audio: false,
  });
  const s = await connection.agent.request("session/new", {
    cwd: workspace,
    mcpServers: [],
  });
  return {
    workspace,
    agent,
    connection,
    s,
    updates,
    prompt: (prompt) =>
      connection.agent.request("session/prompt", {
        sessionId: s.sessionId,
        prompt,
      }),
    close: async () => {
      connection.close();
      await agent.close();
    },
  };
}

test("IDE resource links no longer reject messaging and are never eagerly fetched", async () => {
  requests = [];
  const c = await session(() => {
    assert.equal(requests.length, 0);
    return { outcome: { outcome: "selected", optionId: "once" } };
  });
  try {
    await c.prompt([
      text("Hello"),
      link(pathToFileURL(join(c.workspace, "missing.txt")).href),
      link("https://example.invalid/context"),
    ]);
    assert.equal(requests.length, 1);
    const prompt = requests[0].messages.at(-1).content;
    assert.match(prompt, /Hello/);
    assert.match(prompt, /missing.txt/);
    assert.match(prompt, /contents not loaded/);
    assert.equal(
      c.updates.some((u) => u.content?.text?.includes("Only text")),
      false,
    );
  } finally {
    await c.close();
  }
});

test("embedded context preserves unsaved content, redacts credentials and restores without replay", async () => {
  requests = [];
  const c = await session();
  try {
    const path = join(c.workspace, "a.txt");
    await writeFile(path, "disk text");
    await c.prompt([
      text("Review"),
      embedded(
        pathToFileURL(path).href,
        "unsaved editor text fixture-prompt-secret",
      ),
    ]);
    assert.equal(requests.length, 1);
    const prompt = requests[0].messages.at(-1).content;
    assert.match(prompt, /unsaved editor text \[REDACTED\]/);
    assert(!prompt.includes("disk text"));
    const persisted = await readFile(
      join(base, "state", `session-${c.s.sessionId}.json`),
      "utf8",
    );
    assert(!persisted.includes("fixture-prompt-secret"));
    const restored = createAgent();
    const connection = new ClientApp()
      .onNotification("session/update", () => {})
      .connect(restored.app);
    try {
      await connection.agent.request("initialize", { protocolVersion: 1 });
      await connection.agent.request("session/load", {
        sessionId: c.s.sessionId,
        cwd: c.workspace,
        mcpServers: [],
      });
      assert.equal(requests.length, 1);
      assert.match(
        restored.sessions
          .get(c.s.sessionId)
          .messages.find((m) => m.role === "user").content,
        /unsaved editor text/,
      );
    } finally {
      connection.close();
      await restored.close();
    }
  } finally {
    await c.close();
  }
});

test("decline and invalid approval never transmit or persist attached contents", async () => {
  for (const optionId of ["deny", "invalid"]) {
    requests = [];
    const c = await session(() => ({
      outcome: { outcome: "selected", optionId },
    }));
    try {
      await c.prompt([
        text("Review"),
        embedded("ide://selection", "private attachment"),
      ]);
      assert.equal(requests.length, 0);
      const stored = await readFile(
        join(base, "state", `session-${c.s.sessionId}.json`),
        "utf8",
      );
      assert(!stored.includes("private attachment"));
    } finally {
      await c.close();
    }
  }
});

test("cancelled attachment approval ignores a late allow reply", async () => {
  requests = [];
  let entered, release;
  const ready = new Promise((resolve) => {
    entered = resolve;
  });
  const c = await session(() => {
    entered();
    return new Promise((resolve) => {
      release = resolve;
    });
  });
  try {
    const turn = c.prompt([
      text("Review"),
      embedded("ide://selection", "private attachment"),
    ]);
    await ready;
    await c.connection.agent.notify("session/cancel", {
      sessionId: c.s.sessionId,
    });
    assert.equal((await turn).stopReason, "cancelled");
    release({ outcome: { outcome: "selected", optionId: "once" } });
    assert.equal(requests.length, 0);
    assert.equal(c.agent.sessions.get(c.s.sessionId).messages.length, 0);
  } finally {
    await c.close();
  }
});

test("embedded files outside the workspace, sensitive files and symlinks are refused", async () => {
  requests = [];
  const c = await session();
  try {
    const outside = join(base, "outside.txt");
    await writeFile(outside, "outside");
    await writeFile(join(c.workspace, ".env"), "sensitive");
    await symlink(outside, join(c.workspace, "escape"));
    for (const path of [
      outside,
      join(c.workspace, ".env"),
      join(c.workspace, "escape"),
    ]) {
      await c.prompt([
        text("Review"),
        embedded(pathToFileURL(path).href, "not to transmit"),
      ]);
      assert.equal(requests.length, 0);
    }
    await mkdir(join(c.workspace, "new"));
    await c.prompt([
      text("Review"),
      embedded(
        pathToFileURL(join(c.workspace, "new/unsaved.txt")).href,
        "unsaved new file",
      ),
    ]);
    assert.equal(requests.length, 1);
  } finally {
    await c.close();
  }
});

test("slash commands ignore attached context without activation or inference", async () => {
  requests = [];
  const c = await session(() => {
    throw new Error("Must not request workspace access");
  });
  try {
    await c.prompt([
      text("/status"),
      link("https://example.invalid/context"),
      embedded("ide://selection", "private attachment"),
    ]);
    await c.prompt([text("/doctor"), link("https://example.invalid/context")]);
    assert.equal(requests.length, 0);
    assert.equal(c.agent.sessions.get(c.s.sessionId).active, false);
    assert.equal(c.agent.sessions.get(c.s.sessionId).messages.length, 0);
  } finally {
    await c.close();
  }
});
