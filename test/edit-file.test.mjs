import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  realpath,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClientApp } from "@agentclientprotocol/sdk";

const temporary = await realpath(await mkdtemp(join(tmpdir(), "ow-edits-")));
process.env.OPENWEBUI_ACP_HOME = join(temporary, "state");
process.env.OPENWEBUI_API_KEY = "synthetic-edit-key";
const { createAgent } = await import("../dist/agent.js");
const { writeJson, configSchema } = await import("../dist/config.js");
const { replaceText } = await import("../dist/edits.js");
let pending = [];
const requests = [];
const server = createServer(async (req, res) => {
  res.setHeader("Content-Type", "application/json");
  if (req.url === "/api/models")
    return res.end(
      JSON.stringify({ data: [{ id: "fixture", max_output_tokens: 4096 }] }),
    );
  let raw = "";
  for await (const part of req) raw += part;
  const request = JSON.parse(raw);
  requests.push(request);
  const next = pending.shift();
  const message =
    typeof next === "function"
      ? await next(request)
      : (next ?? { role: "assistant", content: "Done" });
  res.end(
    JSON.stringify({
      choices: [
        { message, finish_reason: message.tool_calls ? "tool_calls" : "stop" },
      ],
    }),
  );
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const url = `http://127.0.0.1:${server.address().port}`;
test.after(() => new Promise((r) => server.close(r)));
test.beforeEach(async () => {
  pending = [];
  requests.length = 0;
  await writeJson("config.json", configSchema.parse({ url, model: "fixture" }));
});
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
const edit = (args = {}) =>
  call("edit_file", {
    path: "a.txt",
    old_string: "old",
    new_string: "new",
    ...args,
  });
const results = () =>
  requests.flatMap((r) =>
    r.messages.filter((m) => m.role === "tool").map((m) => m.content),
  );
async function client({ choose = () => "once", editor } = {}) {
  const cwd = await realpath(await mkdtemp(join(temporary, "project-")));
  await writeFile(join(cwd, "a.txt"), "head\r\nold\r\ntail\r\n");
  const app = new ClientApp(),
    agent = createAgent(),
    approvals = [],
    updates = [];
  app.onNotification("session/update", ({ params }) =>
    updates.push(params.update),
  );
  app.onRequest("session/request_permission", async ({ params }) => {
    approvals.push(params);
    return {
      outcome: { outcome: "selected", optionId: await choose(params, cwd) },
    };
  });
  if (editor) {
    app.onRequest("fs/read_text_file", async ({ params }) => ({
      content: await editor.read(params.path),
    }));
    app.onRequest("fs/write_text_file", async ({ params }) => {
      await editor.write(params.path, params.content);
      return {};
    });
  }
  const connection = app.connect(agent.app);
  await connection.agent.request("initialize", {
    protocolVersion: 1,
    clientCapabilities: editor
      ? { fs: { readTextFile: true, writeTextFile: true } }
      : {},
  });
  const { sessionId } = await connection.agent.request("session/new", {
    cwd,
    mcpServers: [],
  });
  return {
    cwd,
    approvals,
    updates,
    connection,
    sessionId,
    state: () => agent.sessions.get(sessionId),
    prompt: () =>
      connection.agent.request("session/prompt", {
        sessionId,
        prompt: [{ type: "text", text: "Edit the fixture" }],
      }),
    close: async () => {
      connection.close();
      await agent.close();
    },
  };
}

test("literal edit uniqueness, overlap ambiguity, replace_all, line endings and size bounds", () => {
  assert.throws(
    () => replaceText("old", "missing", "new"),
    /matched 0 occurrences.*Re-read/,
  );
  assert.throws(
    () => replaceText("old old", "old", "new"),
    /matched 2 occurrences.*surrounding lines/,
  );
  assert.throws(() => replaceText("aaa", "aa", "new"), /matched 2 occurrences/);
  assert.equal(replaceText("old old", "old", "$&", true), "$& $&");
  assert.equal(replaceText("aaa", "aa", "x", true), "xa");
  assert.equal(replaceText("a\r\nold\r\n", "old", "new"), "a\r\nnew\r\n");
  assert.equal(replaceText("a\nold", "old", "new"), "a\nnew");
  assert.throws(() => replaceText("old", "", "new"), /must not be empty/);
  assert.throws(
    () => replaceText("xx", "x", "a".repeat(100000), true),
    /100,000/,
  );
  assert.equal(replaceText("x", "x", "a".repeat(100000)).length, 100000);
});

test("edit_file presents the full diff, keeps CRLF, checkpoints and supports undo", async () => {
  const c = await client();
  pending = [edit()];
  try {
    await c.prompt();
    assert.equal(
      await readFile(join(c.cwd, "a.txt"), "utf8"),
      "head\r\nnew\r\ntail\r\n",
    );
    assert.equal(c.state().checkpoints.length, 1);
    const approval = c.approvals.find((p) => p.toolCall.kind === "edit");
    assert.deepEqual(approval.toolCall.content, [
      {
        type: "diff",
        path: join(c.cwd, "a.txt"),
        oldText: "head\r\nold\r\ntail\r\n",
        newText: "head\r\nnew\r\ntail\r\n",
      },
    ]);
    assert(
      c.updates.some(
        (u) =>
          u.sessionUpdate === "tool_call" &&
          u.title === "edit_file" &&
          u.kind === "edit",
      ),
    );
    // The client can open the edited line from the approval and the update.
    const locations = [{ path: join(c.cwd, "a.txt"), line: 2 }];
    assert.deepEqual(approval.toolCall.locations, locations);
    assert(
      c.updates.some(
        (u) =>
          u.sessionUpdate === "tool_call_update" &&
          u.toolCallId === "edit_file" &&
          JSON.stringify(u.locations) === JSON.stringify(locations),
      ),
    );
    const done = c.updates.find(
      (u) => u.toolCallId === "edit_file" && u.status === "completed",
    );
    assert.deepEqual(done.content[0], approval.toolCall.content[0]);
    pending = [call("undo_edit", { id: "latest" })];
    await c.prompt();
    assert.equal(
      await readFile(join(c.cwd, "a.txt"), "utf8"),
      "head\r\nold\r\ntail\r\n",
    );
    assert.equal(c.state().checkpoints[0].status, "undone");
  } finally {
    await c.close();
  }
});

test("edit_file called with write_file's argument names is told which fields to drop", async () => {
  const c = await client();
  try {
    pending = [
      call("edit_file", { path: "a.txt", before: "old", after: "new" }),
      // A complete call still sheds a stray field, as before.
      edit({ note: "stray" }),
    ];
    await c.prompt();
    assert(
      results().some((r) =>
        /^Invalid tool arguments: remove undeclared fields before, after; .*old_string: expected string.*Nothing was executed\.$/.test(
          r,
        ),
      ),
    );
    assert.equal(
      c.approvals.filter((p) => p.toolCall.kind === "edit").length,
      1,
    );
    assert.equal(
      await readFile(join(c.cwd, "a.txt"), "utf8"),
      "head\r\nnew\r\ntail\r\n",
    );
  } finally {
    await c.close();
  }
});

test("empty, missing and ambiguous old_string fail before edit approval; replace_all is explicit", async () => {
  const c = await client();
  try {
    await writeFile(join(c.cwd, "a.txt"), "old old\n");
    pending = [
      edit({ old_string: "" }),
      edit({ old_string: "absent" }),
      edit(),
      edit({ replace_all: true }),
    ];
    await c.prompt();
    assert(results().some((r) => /Invalid tool arguments.*old_string/.test(r)));
    assert(results().some((r) => /matched 0 occurrences/.test(r)));
    assert(results().some((r) => /matched 2 occurrences/.test(r)));
    assert.equal(
      c.approvals.filter((p) => p.toolCall.kind === "edit").length,
      1,
    );
    assert.equal(await readFile(join(c.cwd, "a.txt"), "utf8"), "new new\n");
  } finally {
    await c.close();
  }
});

test("edit_file and write_file both refuse read-only modes and protected/outside paths", async () => {
  for (const tool of ["edit_file", "write_file"])
    for (const mode of ["sandbox", "permissions", "plan", "paths"]) {
      const c = await client();
      try {
        if (mode === "sandbox") c.state().sandbox = "read_only";
        if (mode === "permissions")
          await c.state().permissions.selectMode("read_only");
        if (mode === "plan") c.state().workflow = "plan";
        const args = (path) =>
          tool === "edit_file"
            ? { path, old_string: "old", new_string: "new" }
            : {
                path,
                before: mode === "paths" ? "old" : "head\r\nold\r\ntail\r\n",
                after: "new",
              };
        if (mode === "paths") {
          const outside = join(temporary, "outside.txt");
          await writeFile(outside, "old");
          await mkdir(join(c.cwd, ".git"));
          await writeFile(join(c.cwd, ".git/config"), "old");
          await writeFile(join(c.cwd, ".env"), "old");
          await symlink(outside, join(c.cwd, "escape.txt"));
          pending = [
            ".env",
            ".git/config",
            "../outside.txt",
            outside,
            "escape.txt",
          ].map((path) => call(tool, args(path)));
        } else pending = [call(tool, args("a.txt"))];
        await c.prompt();
        assert.equal(
          c.approvals.filter((p) => p.toolCall.kind === "edit").length,
          0,
          `${tool} ${mode}`,
        );
        assert.equal(c.state().checkpoints.length, 0);
        assert.equal(
          await readFile(join(c.cwd, "a.txt"), "utf8"),
          "head\r\nold\r\ntail\r\n",
        );
      } finally {
        await c.close();
      }
    }
});

test("edit_file rejects declined/invalid permissions and content changed during local approval", async () => {
  for (const action of ["deny", "invalid", "stale"]) {
    const c = await client({
      choose: async (p, cwd) => {
        if (p.toolCall.kind !== "edit") return "once";
        if (action === "stale") {
          await writeFile(join(cwd, "a.txt"), "user change");
          return "once";
        }
        return action;
      },
    });
    pending = [edit()];
    try {
      await c.prompt();
      assert.equal(c.state().checkpoints.length, 0);
      assert.equal(
        await readFile(join(c.cwd, "a.txt"), "utf8"),
        action === "stale" ? "user change" : "head\r\nold\r\ntail\r\n",
      );
      assert(
        results().some((r) =>
          action === "stale" ? /Stale/.test(r) : /^Permission declined/.test(r),
        ),
      );
    } finally {
      await c.close();
    }
  }
});

test("cancelling edit_file ignores a late approval and records no checkpoint", async () => {
  let release;
  const waiting = Promise.withResolvers();
  const c = await client({
    choose: async (p) => {
      if (p.toolCall.kind !== "edit") return "once";
      const answer = new Promise((r) => {
        release = r;
      });
      waiting.resolve();
      return answer;
    },
  });
  pending = [edit()];
  try {
    const turn = c.prompt();
    await waiting.promise;
    await c.connection.agent.notify("session/cancel", {
      sessionId: c.sessionId,
    });
    assert.equal((await turn).stopReason, "cancelled");
    release("once");
    await new Promise((r) => setImmediate(r));
    assert.equal(
      await readFile(join(c.cwd, "a.txt"), "utf8"),
      "head\r\nold\r\ntail\r\n",
    );
    assert.equal(c.state().checkpoints.length, 0);
  } finally {
    release?.("deny");
    await c.close();
  }
});

test("edit_file uses unsaved editor content, detects pending editor changes, and never falls back on client denial", async () => {
  for (const action of ["success", "stale", "denied"]) {
    let content = "unsaved old\n",
      writes = 0;
    const c = await client({
      editor: {
        read: async (path) =>
          path.endsWith("/a.txt") ? content : await readFile(path, "utf8"),
        write: async (_path, next) => {
          if (action === "denied") throw Error("IDE denied write");
          writes++;
          content = next;
        },
      },
      choose: (p) => {
        if (p.toolCall.kind === "edit" && action === "stale")
          content = "editor changed";
        return "once";
      },
    });
    pending = [edit()];
    try {
      await c.prompt();
      assert.equal(writes, action === "success" ? 1 : 0);
      assert.equal(c.state().checkpoints.length, action === "success" ? 1 : 0);
      assert.equal(
        content,
        action === "success"
          ? "unsaved new\n"
          : action === "stale"
            ? "editor changed"
            : "unsaved old\n",
      );
      assert.equal(
        await readFile(join(c.cwd, "a.txt"), "utf8"),
        "head\r\nold\r\ntail\r\n",
      );
    } finally {
      await c.close();
    }
  }
});

test("both editing tools enforce newly discovered and changed-during-approval instructions", async () => {
  for (const tool of ["edit_file", "write_file"])
    for (const during of [false, true]) {
      const c = await client({
        choose: async (p, cwd) => {
          if (during && p.toolCall.kind === "edit")
            await writeFile(join(cwd, "AGENTS.md"), "New scoped instructions");
          return "once";
        },
      });
      try {
        await mkdir(join(c.cwd, "sub"));
        await writeFile(join(c.cwd, "sub/a.txt"), "old");
        if (!during)
          await writeFile(join(c.cwd, "sub/AGENTS.md"), "Scoped instructions");
        pending = [
          call(
            tool,
            tool === "edit_file"
              ? { path: "sub/a.txt", old_string: "old", new_string: "new" }
              : { path: "sub/a.txt", before: "old", after: "new" },
          ),
        ];
        await c.prompt();
        assert(results().some((r) => /instructions changed/i.test(r)));
        assert.equal(c.state().checkpoints.length, 0);
        assert.equal(await readFile(join(c.cwd, "sub/a.txt"), "utf8"), "old");
        assert.equal(
          c.approvals.filter((p) => p.toolCall.kind === "edit").length,
          during ? 1 : 0,
        );
      } finally {
        await c.close();
      }
    }
});
