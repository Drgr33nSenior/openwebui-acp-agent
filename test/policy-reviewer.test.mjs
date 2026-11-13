import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, chmod, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
const temporary = await mkdtemp(join(tmpdir(), "ow-policy-review-"));
process.env.OPENWEBUI_ACP_HOME = join(temporary, "state");
process.env.OPENWEBUI_API_KEY = "advisory-test-secret-not-real";
const {
  snapshotPolicy,
  enforceDestination,
  enforceSandbox,
  enforceMcp,
  enforceNetwork,
  readPolicyFile,
  enforcePermissionMode,
} = await import("../dist/policy.js");
const { reviewOperation } = await import("../dist/reviewer.js");
const { probeLinuxNamespaces } = await import("../dist/sandbox.js");
const config = {
  url: "https://example.invalid/prefix",
  model: "coding",
  header: "Authorization",
  timeoutMs: 1000,
  rounds: 2,
};
const signal = () => AbortSignal.timeout(3000);

test("policy validates entire document; absence differs from managed empty policy", () => {
  for (const p of [
    null,
    { version: 2 },
    { version: 1, typo: true },
    { version: 1, sandboxModes: ["full_access"] },
    { version: 1, permissionModes: ["development"] },
    { version: 1, networkDestinations: [{ host: "*", port: 443 }] },
    { version: 1, inferenceUrls: ["https://name:secret@example.invalid"] },
  ])
    assert.throws(() => snapshotPolicy(p), /Invalid administrator policy/);
  assert.notEqual(
    snapshotPolicy().revision,
    snapshotPolicy({ version: 1 }).revision,
  );
});

test("administrator restrictions are exact; network policy also forbids unsandboxed bypass", () => {
  const p = snapshotPolicy({
    version: 1,
    inferenceUrls: ["https://example.invalid/prefix"],
    mcpHttpUrls: [],
    allowStdioMcp: false,
    networkDestinations: [{ host: "EXAMPLE.COM", port: 443 }],
    allowScopeExpansion: false,
    permissionModes: ["ask"],
  });
  enforceDestination(p, "inference", "https://example.invalid/prefix/");
  for (const u of [
    "https://example.invalid",
    "https://example.invalid/prefix/child",
    "https://other.invalid/prefix",
  ])
    assert.throws(() => enforceDestination(p, "inference", u));
  assert.throws(() =>
    enforceMcp(p, { name: "stdio", command: "echo", args: [], env: [] }),
  );
  assert.throws(() =>
    enforceMcp(p, {
      name: "http",
      type: "http",
      url: "https://example.invalid/mcp",
      headers: [],
    }),
  );
  enforceNetwork(p, "example.com", 443);
  assert.throws(() => enforceNetwork(p, "example.com", 80));
  assert.throws(() => enforceNetwork(p, "child.example.com", 443));
  assert.throws(() => enforceSandbox(p, "full_access"));
  assert.throws(() => enforceSandbox(p, "workspace", true));
  assert.throws(() => enforcePermissionMode(p, "development"));
});

test("user-controlled policy files and symlinks cannot become administrator authority", async () => {
  const path = join(temporary, "policy.json");
  await writeFile(path, '{"version":1}', { mode: 0o600 });
  await assert.rejects(readPolicyFile(path));
  const link = join(temporary, "link.json");
  await symlink(path, link);
  await assert.rejects(readPolicyFile(link));
  await chmod(path, 0o666);
  await assert.rejects(readPolicyFile(path));
});

test("reviewer validates verdicts, redacts secrets and fails to manual decisions", async () => {
  const result = await reviewOperation(
    config,
    "review-model",
    "run ls",
    signal(),
    async (backend, data) => {
      assert.equal(backend.config.model, "review-model");
      assert.equal(data, "run ls");
      return {
        content: JSON.stringify({
          decision: "approve",
          reason: process.env.OPENWEBUI_API_KEY,
        }),
      };
    },
  );
  assert.equal(result.decision, "approve");
  assert.equal(result.reason, "[REDACTED]");
  for (const content of [
    "not json",
    '{"decision":"execute","reason":"bad"}',
    '{"decision":"approve","reason":"ok","extra":true}',
    JSON.stringify({ decision: "approve", reason: "x".repeat(1001) }),
  ]) {
    assert.equal(
      (
        await reviewOperation(
          config,
          "review-model",
          "run ls",
          signal(),
          async () => ({ content }),
        )
      ).decision,
      "uncertain",
    );
  }
  assert.equal(
    (
      await reviewOperation(
        config,
        "review-model",
        "run ls",
        signal(),
        async () => ({
          content: '{"decision":"approve","reason":"ok"}',
          tool_calls: [{}],
        }),
      )
    ).decision,
    "uncertain",
  );
  assert.equal(
    (
      await reviewOperation(
        config,
        "review-model",
        "x".repeat(24001),
        signal(),
        async () => {
          throw new Error("must not send");
        },
      )
    ).decision,
    "uncertain",
  );
  const cancelled = new AbortController();
  cancelled.abort();
  await assert.rejects(
    reviewOperation(
      config,
      "review-model",
      "run ls",
      cancelled.signal,
      async () => {
        throw new Error("cancel");
      },
    ),
  );
});

test("review HTTP contract uses selected model, no history or tools; oversized output is bounded", async () => {
  let response = JSON.stringify({
    decision: "uncertain",
    reason: "No intent provided",
  });
  const bodies = [];
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const part of req) body += part;
    bodies.push(JSON.parse(body));
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({
        choices: [
          {
            message: { role: "assistant", content: response },
            finish_reason: "stop",
          },
        ],
      }),
    );
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    const c = {
      ...config,
      url: `http://127.0.0.1:${server.address().port}/prefix`,
    };
    assert.equal(
      (await reviewOperation(c, "review-model", "untrusted command", signal()))
        .decision,
      "uncertain",
    );
    const b = bodies[0];
    assert.equal(b.model, "review-model");
    assert.deepEqual(b.tools, []);
    assert.equal(b.messages.length, 2);
    assert.equal(b.messages[1].content, "untrusted command");
    assert(!("tool_ids" in b));
    assert(!("features" in b));
    assert(!("chat_id" in b));
    response = "x".repeat(10000);
    assert.match(
      (await reviewOperation(c, "review-model", "run ls", signal())).reason,
      /unavailable/,
    );
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
});

test("namespace diagnostics distinguish missing tools, host denial and other failures without leaking stderr", async () => {
  const allowed = await probeLinuxNamespaces(async (exe, args, options) => {
    assert.equal(exe, "/usr/bin/bwrap");
    assert(args.includes("--unshare-net"));
    assert(args.includes("--ro-bind"));
    assert.equal(args.at(-1), "/usr/bin/true");
    assert.equal(options.timeout, 5000);
    return { stdout: "", stderr: "" };
  });
  assert.equal(allowed.available, true);
  for (const [error, pattern] of [
    [{ code: "ENOENT" }, /missing/],
    [{ stderr: "Operation not permitted secret" }, /Host or outer container/],
    [{ stderr: "secret" }, /failed or timed out/],
  ]) {
    const r = await probeLinuxNamespaces(async () => {
      throw error;
    });
    assert.equal(r.available, false);
    assert.match(r.detail, pattern);
    assert(!r.detail.includes("secret"));
  }
});

test("inference destination policy rejects before any HTTP request or credential transmission", async () => {
  const { Backend } = await import("../dist/backend.js");
  const b = new Backend(config, "do-not-send", async () =>
    snapshotPolicy({ version: 1, inferenceUrls: [] }),
  );
  await assert.rejects(b.models(signal()), /Administrator policy denies/);
  await assert.rejects(
    b.complete([], [], signal(), async () => {}),
    /Administrator policy denies/,
  );
});

test("review deadline returns manual uncertainty even if a completion never resolves", async () => {
  const keepAlive = setInterval(() => {}, 1000);
  try {
    const result = await reviewOperation(
      config,
      "review-model",
      "run ls",
      new AbortController().signal,
      async () => new Promise(() => {}),
    );
    assert.equal(result.decision, "uncertain");
    assert.match(result.reason, /timed out/);
  } finally {
    clearInterval(keepAlive);
  }
});
