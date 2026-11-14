import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  realpath,
  writeFile,
  mkdir,
  symlink,
  link,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request, createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { ClientApp } from "@agentclientprotocol/sdk";

const temporary = await realpath(await mkdtemp(join(tmpdir(), "ow-preview-")));
process.env.OPENWEBUI_ACP_HOME = join(temporary, "state");
process.env.OPENWEBUI_API_KEY = "synthetic-preview-inference";
const { Preview, previewSchema, previewPaths } =
  await import("../dist/preview.js");
const { createAgent } = await import("../dist/agent.js");
const { writeJson, configSchema } = await import("../dist/config.js");
const { snapshotPolicy } = await import("../dist/policy.js");
const { changeTrust } = await import("../dist/workspace.js");
const page =
  "<!doctype html><title>Preview fixture</title><button>Start</button>";
async function workspace() {
  const root = await realpath(await mkdtemp(join(temporary, "workspace-")));
  await writeFile(join(root, "index.html"), page);
  await writeFile(join(root, "app.js"), 'document.title="Updated";');
  return root;
}
const input = (extra = {}) =>
  previewSchema.parse({
    files: ["index.html", "app.js"],
    entry: "index.html",
    ...extra,
  });
const allow = async () => {};
function raw(url, path, headers = {}, method = "GET") {
  return new Promise((resolve, reject) => {
    const req = request(new URL(url), { path, method, headers }, (res) => {
      let body = "";
      res.on("data", (b) => (body += b));
      res.on("end", () =>
        resolve({ status: res.statusCode, headers: res.headers, body }),
      );
    });
    req.on("error", reject);
    req.end();
  });
}

test("preview serves only its immutable explicit snapshot on loopback with bounded web headers", async () => {
  const root = await workspace(),
    preview = new Preview();
  const info = await preview.start(
    root,
    input(),
    allow,
    new AbortController().signal,
  );
  try {
    assert.match(info.url, /^http:\/\/127\.0\.0\.1:\d+\/index.html$/);
    assert.match(info.containerUrl, /^http:\/\/host\.docker\.internal:/);
    const response = await raw(info.url, "/index.html");
    assert.equal(response.status, 200);
    assert.equal(response.body, page);
    assert.equal(response.headers["cache-control"], "no-store");
    assert.match(
      response.headers["content-security-policy"],
      /connect-src 'self'/,
    );
    assert.match(
      response.headers["content-security-policy"],
      /form-action 'none'/,
    );
    assert.equal(
      response.headers["cross-origin-resource-policy"],
      "same-origin",
    );
    await writeFile(join(root, "index.html"), "changed after snapshot");
    assert.equal((await raw(info.url, "/index.html")).body, page);
    assert.equal((await raw(info.url, "/index.html", {}, "HEAD")).body, "");
    assert.equal((await raw(info.url, "/app.js")).status, 200);
    assert.equal((await raw(info.url, "/unlisted.html")).status, 404);
    assert.equal((await raw(info.url, "/index.html", {}, "POST")).status, 405);
    for (const path of [
      "/../index.html",
      "/%2e%2e/index.html",
      "/%252e%252e/index.html",
      "//index.html",
      "/index.html?secret=x",
      "/%00.html",
      "/%5cindex.html",
      "/%xx",
    ])
      assert.equal((await raw(info.url, path)).status, 403, path);
    for (const headers of [
      { Host: "evil.test" },
      { Origin: "https://evil.test" },
      { "Sec-Fetch-Site": "cross-site" },
      { "Sec-Fetch-Site": "same-site" },
    ])
      assert.equal((await raw(info.url, "/index.html", headers)).status, 403);
    assert.equal(
      (
        await raw(info.url, "/index.html", {
          Host: new URL(info.containerUrl).host,
        })
      ).status,
      200,
    );
    await assert.rejects(
      preview.start(root, input(), allow, new AbortController().signal),
      /Stop the current/,
    );
    await assert.rejects(
      preview.stop("another-session"),
      /Unknown active preview/,
    );
  } finally {
    await preview.close();
  }
  await assert.rejects(fetch(info.url));
});

test("preview refuses sensitive, traversing, symbolic and hard-linked files, unsupported types and limits", async () => {
  const root = await workspace(),
    outside = await workspace();
  await symlink(join(outside, "index.html"), join(root, "escape.html"));
  await link(join(outside, "index.html"), join(root, "hard.html"));
  await mkdir(join(root, ".env"));
  await writeFile(join(root, ".env", "index.html"), "synthetic-secret");
  for (const name of [
    "../index.html",
    "escape.html",
    ".env/index.html",
    "/index.html",
    "a/../index.html",
    "data.txt",
    "index.html?x",
    "bad\\index.html",
  ])
    await assert.rejects(previewPaths(root, [name]), undefined, name);
  assert.throws(() => input({ unknown: true }));
  assert.throws(() => input({ port: 80 }));
  assert.throws(() => input({ timeout_ms: 600001 }));
  assert.throws(() => input({ files: Array(129).fill("index.html") }));
  const preview = new Preview();
  await assert.rejects(
    preview.start(
      root,
      input({ files: ["hard.html"], entry: "hard.html" }),
      allow,
      new AbortController().signal,
    ),
    /Hard-linked/,
  );
  await writeFile(join(root, "large.js"), Buffer.alloc(1000001, 65));
  await assert.rejects(
    preview.start(
      root,
      input({ files: ["index.html", "large.js"] }),
      allow,
      new AbortController().signal,
    ),
    /bounded/,
  );
  const files = ["index.html"];
  for (let i = 0; i < 8; i++) {
    const name = `asset${i}.png`;
    files.push(name);
    await writeFile(join(root, name), Buffer.alloc(1000000));
  }
  await assert.rejects(
    preview.start(root, input({ files }), allow, new AbortController().signal),
    /total limit/,
  );
  assert.equal(preview.info(), undefined);
});

test("preview checks consent before reading and every response; cancellation, expiry and stop close the listener", async () => {
  const root = await workspace(),
    preview = new Preview();
  let reads = 0;
  await assert.rejects(
    preview.start(
      root,
      input(),
      async () => {
        throw Error("denied");
      },
      new AbortController().signal,
      async () => {
        reads++;
        return page;
      },
    ),
    /denied/,
  );
  assert.equal(reads, 0);
  let permitted = true;
  const info = await preview.start(
    root,
    input(),
    async () => {
      if (!permitted) throw Error("revoked");
    },
    new AbortController().signal,
  );
  permitted = false;
  const denied = await raw(info.url, "/index.html").catch(() => ({
    status: 0,
  }));
  assert.notEqual(denied.status, 200);
  await delay(20);
  assert.equal(preview.info(), undefined);
  await assert.rejects(fetch(info.url));
  const c = new AbortController();
  const next = await preview.start(root, input(), allow, c.signal);
  c.abort();
  await preview.close();
  await assert.rejects(fetch(next.url));
  const expiring = await preview.start(
    root,
    input({ timeout_ms: 1000 }),
    allow,
    new AbortController().signal,
  );
  await delay(1100);
  assert.equal(preview.info(), undefined);
  await assert.rejects(fetch(expiring.url));
  const stopped = await preview.start(
    root,
    input(),
    allow,
    new AbortController().signal,
  );
  await preview.stop(stopped.id);
  await assert.rejects(fetch(stopped.url));
});

test("cancellation during editor snapshot cannot start a late listener; editor content takes precedence", async () => {
  const root = await workspace(),
    preview = new Preview(),
    cancel = new AbortController();
  let release, entered;
  const ready = new Promise((r) => (entered = r));
  const pending = preview.start(
    root,
    input({ files: ["index.html"] }),
    allow,
    cancel.signal,
    () =>
      new Promise((r) => {
        release = r;
        entered();
      }),
  );
  await ready;
  cancel.abort();
  await assert.rejects(pending);
  release("late");
  await delay(20);
  assert.equal(preview.info(), undefined);
  const info = await preview.start(
    root,
    input({ files: ["index.html"] }),
    allow,
    new AbortController().signal,
    async () => "unsaved editor content",
  );
  assert.equal(await (await fetch(info.url)).text(), "unsaved editor content");
  await preview.close();
});

let respond;
const backend = createServer(async (req, res) => {
  res.setHeader("Content-Type", "application/json");
  if (req.url === "/api/models") {
    res.end(JSON.stringify({ data: [{ id: "fixture" }] }));
    return;
  }
  let raw = "";
  for await (const b of req) raw += b;
  const reply = await respond(JSON.parse(raw));
  res.end(
    JSON.stringify({
      choices: [
        {
          message: reply,
          finish_reason: reply.tool_calls ? "tool_calls" : "stop",
        },
      ],
    }),
  );
});
await new Promise((r) => backend.listen(0, "127.0.0.1", r));
test.after(() => new Promise((r) => backend.close(r)));
const call = (name, args, id = name) => ({
  role: "assistant",
  content: null,
  tool_calls: [
    {
      id,
      type: "function",
      function: { name, arguments: JSON.stringify(args) },
    },
  ],
});
const done = { role: "assistant", content: "Done" };
const results = (req) => req.messages.filter((m) => m.role === "tool");
async function client({ choose = () => "once", policy = { version: 1 } } = {}) {
  await writeJson(
    "config.json",
    configSchema.parse({
      url: `http://127.0.0.1:${backend.address().port}`,
      model: "fixture",
    }),
  );
  const root = await workspace(),
    agent = createAgent({ loadPolicy: async () => snapshotPolicy(policy) }),
    app = new ClientApp(),
    approvals = [];
  app.onNotification("session/update", () => {});
  app.onRequest("session/request_permission", async ({ params }) => {
    approvals.push(params);
    return { outcome: { outcome: "selected", optionId: await choose(params) } };
  });
  const c = app.connect(agent.app);
  await c.agent.request("initialize", {
    protocolVersion: 1,
    clientCapabilities: {},
  });
  const { sessionId } = await c.agent.request("session/new", {
    cwd: root,
    mcpServers: [],
  });
  return {
    root,
    agent,
    c,
    sessionId,
    approvals,
    prompt: () =>
      c.agent.request("session/prompt", {
        sessionId,
        prompt: [
          { type: "text", text: "Preview the application and check it" },
        ],
      }),
    close: async () => {
      c.close();
      await agent.close();
    },
  };
}

test("ACP preview approval precedes publishing, explicit stop and turn completion release snapshots", async () => {
  const c = await client();
  let round = 0,
    info;
  respond = async (req) => {
    if (round++ === 0) return call("start_preview", input());
    if (round === 2) {
      info = JSON.parse(results(req).at(-1).content);
      assert.equal((await fetch(info.url)).status, 200);
      return call("stop_preview", { id: info.id });
    }
    await assert.rejects(fetch(info.url));
    return done;
  };
  try {
    assert.equal((await c.prompt()).stopReason, "end_turn");
    assert.equal(c.approvals.length, 2);
    const p = c.approvals[1];
    assert.match(p.toolCall.title, /loopback only/);
    assert.deepEqual(
      p.options.map((o) => o.optionId),
      ["once", "deny"],
    );
    assert.equal(c.agent.sessions.get(c.sessionId).preview.info(), undefined);
    round = 0;
    respond = async (req) => {
      if (round++ === 0) return call("start_preview", input());
      info = JSON.parse(results(req).at(-1).content);
      return done;
    };
    await c.prompt();
    await assert.rejects(fetch(info.url));
  } finally {
    await c.close();
  }
});

test("ACP rejected/invalid preview grants and managed deny never start a preview", async () => {
  for (const option of ["deny", "session", "remember"]) {
    const c = await client({
      choose: (p) =>
        p.toolCall.title.startsWith("Activate") ? "once" : option,
    });
    let round = 0;
    respond = async (req) => {
      if (round++ === 0) return call("start_preview", input());
      assert.match(results(req).at(-1).content, /Permission declined/);
      return done;
    };
    try {
      await c.prompt();
      assert.equal(c.agent.sessions.get(c.sessionId).preview.info(), undefined);
    } finally {
      await c.close();
    }
  }
  const c = await client({ policy: { version: 1, allowPreviews: false } });
  let round = 0;
  respond = async (req) => {
    if (round++ === 0) return call("start_preview", input());
    assert.match(results(req).at(-1).content, /Administrator policy denies/);
    return done;
  };
  try {
    await c.prompt();
    assert.equal(c.approvals.length, 1);
  } finally {
    await c.close();
  }
});

test("ACP interrupt and external workspace revocation stop active previews", async () => {
  for (const action of ["cancel", "replace", "revoke"]) {
    const c = await client();
    let info, reached;
    const ready = new Promise((r) => (reached = r));
    let round = 0;
    respond = async (req) => {
      if (round++ === 0) return call("start_preview", input());
      if (round === 2) {
        info = JSON.parse(results(req).at(-1).content);
        reached();
        await delay(300);
        return done;
      }
      return done;
    };
    try {
      const pending = c.prompt();
      await ready;
      if (action === "cancel")
        await c.c.agent.notify("session/cancel", { sessionId: c.sessionId });
      if (action === "replace")
        assert.equal((await c.prompt()).stopReason, "end_turn");
      if (action === "revoke") {
        await changeTrust(
          c.root,
          `http://127.0.0.1:${backend.address().port}`,
          false,
        );
        const response = await fetch(info.url).catch(() => null);
        assert.notEqual(response?.status, 200);
      }
      await pending;
      await assert.rejects(fetch(info.url));
      assert.equal(c.agent.sessions.get(c.sessionId).preview.info(), undefined);
    } finally {
      await c.close();
    }
  }
});

test("preview mounts only explicit files below a nested entry, includes binary assets and never changes an occupied port", async () => {
  const root = await workspace();
  await mkdir(join(root, "dist/assets"), { recursive: true });
  await writeFile(join(root, "dist/index.html"), page);
  const png = Buffer.from([137, 80, 78, 71, 0, 1, 2]);
  await writeFile(join(root, "dist/assets/image.png"), png);
  const preview = new Preview(),
    other = new Preview();
  const info = await preview.start(
    root,
    input({
      entry: "dist/index.html",
      files: ["dist/index.html", "dist/assets/image.png"],
    }),
    allow,
    new AbortController().signal,
  );
  try {
    assert.equal(new URL(info.url).pathname, "/index.html");
    assert.equal(await (await fetch(info.url)).text(), page);
    assert.equal((await raw(info.url, "/")).body, page);
    const asset = await fetch(new URL("/assets/image.png", info.url));
    assert.deepEqual(Buffer.from(await asset.arrayBuffer()), png);
    assert.equal((await raw(info.url, "/dist/index.html")).status, 404);
    await assert.rejects(
      other.start(
        root,
        input({ port: Number(new URL(info.url).port) }),
        allow,
        new AbortController().signal,
      ),
      { code: "EADDRINUSE" },
    );
    assert.equal(other.info(), undefined);
    await assert.rejects(
      other.start(
        root,
        input({
          entry: "dist/index.html",
          files: ["dist/index.html", "app.js"],
        }),
        allow,
        new AbortController().signal,
      ),
      /entry's directory/,
    );
  } finally {
    await preview.close();
    await other.close();
  }
});

test("preview request and transfer budgets close the listener; a client filesystem denial has no fallback", async () => {
  const root = await workspace(),
    preview = new Preview();
  await assert.rejects(
    preview.start(
      root,
      input(),
      allow,
      new AbortController().signal,
      async () => {
        throw Error("IDE denied read");
      },
    ),
    /IDE denied read/,
  );
  assert.equal(preview.info(), undefined);
  let info = await preview.start(
    root,
    input(),
    allow,
    new AbortController().signal,
  );
  for (let i = 0; i < 512; i++)
    assert.equal((await raw(info.url, "/index.html")).status, 200);
  assert.notEqual(
    (await raw(info.url, "/index.html").catch(() => ({ status: 0 }))).status,
    200,
  );
  await delay(10);
  await assert.rejects(fetch(info.url));
  await writeFile(join(root, "large.png"), Buffer.alloc(1000000));
  info = await preview.start(
    root,
    input({ files: ["index.html", "large.png"] }),
    allow,
    new AbortController().signal,
  );
  for (let i = 0; i < 64; i++) {
    const r = await fetch(new URL("/large.png", info.url));
    assert.equal(r.status, 200);
    await r.arrayBuffer();
  }
  assert.notEqual(
    (await fetch(new URL("/large.png", info.url)).catch(() => null))?.status,
    200,
  );
  await preview.close();
  await assert.rejects(fetch(info.url));
});

test("ACP preview opens no socket before approval and a late approval after cancel cannot publish", async () => {
  const reserve = createServer();
  await new Promise((r) => reserve.listen(0, "127.0.0.1", r));
  const port = reserve.address().port;
  await new Promise((r) => reserve.close(r));
  let release, reached;
  const ready = new Promise((r) => (reached = r));
  const c = await client({
    choose: async (p) => {
      if (!p.toolCall.title.startsWith("Start static preview")) return "once";
      await assert.rejects(fetch(`http://127.0.0.1:${port}/index.html`));
      reached();
      return new Promise((r) => (release = r));
    },
  });
  let round = 0;
  respond = async () =>
    round++ === 0 ? call("start_preview", input({ port })) : done;
  try {
    const pending = c.prompt();
    await ready;
    await c.c.agent.notify("session/cancel", { sessionId: c.sessionId });
    assert.equal((await pending).stopReason, "cancelled");
    release("once");
    await delay(30);
    assert.equal(c.agent.sessions.get(c.sessionId).preview.info(), undefined);
    await assert.rejects(fetch(`http://127.0.0.1:${port}/index.html`));
  } finally {
    release?.("deny");
    await c.close();
  }
});
