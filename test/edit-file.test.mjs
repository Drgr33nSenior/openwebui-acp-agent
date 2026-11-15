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
async function client({ choose = () => "once", editor, cwd, load } = {}) {
  if (!cwd) {
    cwd = await realpath(await mkdtemp(join(temporary, "project-")));
    await writeFile(join(cwd, "a.txt"), "head\r\nold\r\ntail\r\n");
  }
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
  const sessionId =
    load ??
    (await connection.agent.request("session/new", { cwd, mcpServers: [] }))
      .sessionId;
  if (load)
    await connection.agent.request("session/load", {
      sessionId,
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
            : { path, content: "new" };
        // A read first, so a write_file refusal is the mode's, not a missing read.
        const read = (path) => call("read_file", { path }, "read-" + path);
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
          ].flatMap((path) => [read(path), call(tool, args(path))]);
        } else pending = [read("a.txt"), call(tool, args("a.txt"))];
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
          ...(tool === "write_file" && during
            ? [call("read_file", { path: "sub/a.txt" }, "r1")]
            : []),
          call(
            tool,
            tool === "edit_file"
              ? { path: "sub/a.txt", old_string: "old", new_string: "new" }
              : { path: "sub/a.txt", content: "new" },
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

test("write_file refuses existing files over 8 KB before approval and still writes new and small files", async () => {
  const c = await client();
  try {
    const big = "start" + "x".repeat(8188);
    await writeFile(join(c.cwd, "big.txt"), big);
    await writeFile(join(c.cwd, "edge.txt"), "y".repeat(8192));
    pending = [
      // Reading does not lift the size limit.
      call("read_file", { path: "big.txt" }, "r1"),
      call("write_file", { path: "big.txt", content: "short" }, "w1"),
      call("write_file", { path: "new.txt", content: "fresh" }, "w2"),
      call("read_file", { path: "a.txt" }, "r3"),
      call("write_file", { path: "a.txt", content: "small" }, "w3"),
      call("read_file", { path: "edge.txt" }, "r4"),
      call("write_file", { path: "edge.txt", content: "ok" }, "w4"),
      call(
        "edit_file",
        { path: "big.txt", old_string: "start", new_string: "begin" },
        "e1",
      ),
    ];
    await c.prompt();
    const refused = results().find((r) => r.startsWith("Tool failed"));
    assert.match(
      refused,
      /write_file replaces whole files; this file is 8 KB.*cut off by the output limit\. Use edit_file for targeted changes.*Nothing was written/,
    );
    assert.equal(await readFile(join(c.cwd, "new.txt"), "utf8"), "fresh");
    assert.equal(await readFile(join(c.cwd, "a.txt"), "utf8"), "small");
    assert.equal(await readFile(join(c.cwd, "edge.txt"), "utf8"), "ok");
    assert.equal(
      await readFile(join(c.cwd, "big.txt"), "utf8"),
      "begin" + "x".repeat(8188),
    );
    // Three write_file approvals (new, small, edge) plus one edit_file; none for the refusal.
    assert.equal(
      c.approvals.filter((p) => p.toolCall.kind === "edit").length,
      4,
    );
    assert.equal(c.state().checkpoints.length, 4);
  } finally {
    await c.close();
  }
});

// write_file takes {path, content}. An existing file is replaced only when the
// agent read it (any page) or wrote it last, and it has not changed since.
const write = (path, content, id) =>
  call("write_file", { path, content }, id ?? "write-" + path);
const read = (path, id, extra = {}) =>
  call("read_file", { path, ...extra }, id ?? "read-" + path);
const resultFor = (c, id) =>
  c.state().messages.findLast((m) => m.role === "tool" && m.tool_call_id === id)
    ?.content;
const editApprovals = (c) =>
  c.approvals.filter((p) => p.toolCall.kind === "edit").length;

test("content-only write_file creates, refuses unread or changed files before approval and replaces after a read", async () => {
  const c = await client();
  try {
    await writeFile(join(c.cwd, "b.txt"), "bee\n");
    pending = [
      write("new.txt", "fresh\n", "create"),
      write("a.txt", "unread", "unread"),
      read("b.txt", "read-b"),
      write("b.txt", "bee two\n", "replace"),
    ];
    await c.prompt();
    assert.equal(await readFile(join(c.cwd, "new.txt"), "utf8"), "fresh\n");
    assert.match(resultFor(c, "create"), /^File updated; checkpoint/);
    assert.equal(
      resultFor(c, "unread"),
      "Tool failed: a.txt already exists and you have not read it in this session. Read it with read_file before replacing it, or change it with edit_file. Nothing was written.\nInspect the error and any partial effects before proposing a correction. Do not retry a denied action.",
    );
    assert.equal(
      await readFile(join(c.cwd, "a.txt"), "utf8"),
      "head\r\nold\r\ntail\r\n",
    );
    assert.equal(await readFile(join(c.cwd, "b.txt"), "utf8"), "bee two\n");
    // Approvals for the creation and the replacement only.
    assert.equal(editApprovals(c), 2);
    assert.equal(c.state().checkpoints.length, 2);

    // Changed after the agent's last write (a command, the user, another
    // process): refused before approval; a fresh read allows it again.
    await writeFile(join(c.cwd, "b.txt"), "user change\n");
    pending = [
      write("b.txt", "agent text\n", "stale"),
      read("b.txt", "reread"),
      write("b.txt", "agent text\n", "after-reread"),
    ];
    await c.prompt();
    assert.match(
      resultFor(c, "stale"),
      /^Tool failed: b\.txt changed since you last read or wrote it \(in the editor, by a command or by another process\)\. Read it with read_file again before replacing it.*Nothing was written\./,
    );
    assert.match(resultFor(c, "after-reread"), /^File updated; checkpoint/);
    assert.equal(await readFile(join(c.cwd, "b.txt"), "utf8"), "agent text\n");
    assert.equal(editApprovals(c), 3);

    // Undo still restores through the checkpoint written by the new form.
    pending = [call("undo_edit", { id: "latest" })];
    await c.prompt();
    assert.equal(await readFile(join(c.cwd, "b.txt"), "utf8"), "user change\n");
    // The undo changed the file after the agent's write: read it again first.
    pending = [write("b.txt", "again\n", "after-undo")];
    await c.prompt();
    assert.match(resultFor(c, "after-undo"), /changed since you last read/);
  } finally {
    await c.close();
  }
});

test("a page read counts as seen; a blind edit_file does not, a read-based one keeps the view current", async () => {
  const c = await client();
  try {
    await writeFile(join(c.cwd, "p.txt"), "one\ntwo\nthree\n");
    await writeFile(join(c.cwd, "q.txt"), "alpha\nbeta\n");
    pending = [
      // Only line 2 is returned; the record is of the whole file.
      read("p.txt", "page", { offset: 2, limit: 1 }),
      write("p.txt", "replaced\n", "after-page"),
      // edit_file without a read changes q.txt but does not make it seen.
      call(
        "edit_file",
        { path: "q.txt", old_string: "beta", new_string: "gamma" },
        "blind-edit",
      ),
      write("q.txt", "whole\n", "after-blind-edit"),
      read("q.txt", "read-q"),
      call(
        "edit_file",
        { path: "q.txt", old_string: "gamma", new_string: "delta" },
        "read-edit",
      ),
      write("q.txt", "whole\n", "after-read-edit"),
    ];
    await c.prompt();
    assert.equal(resultFor(c, "page").split("\n")[0], "2→two");
    assert.match(resultFor(c, "after-page"), /^File updated/);
    assert.match(
      resultFor(c, "after-blind-edit"),
      /q\.txt already exists and you have not read it/,
    );
    assert.match(resultFor(c, "after-read-edit"), /^File updated/);
    assert.equal(await readFile(join(c.cwd, "p.txt"), "utf8"), "replaced\n");
    assert.equal(await readFile(join(c.cwd, "q.txt"), "utf8"), "whole\n");
  } finally {
    await c.close();
  }
});

test("write_file through the editor checks unsaved text for changes after the read", async () => {
  let content = "unsaved\n";
  const c = await client({
    editor: {
      read: async (path) =>
        path.endsWith("/a.txt") ? content : await readFile(path, "utf8"),
      write: async (_path, next) => {
        content = next;
      },
    },
  });
  try {
    pending = [read("a.txt")];
    await c.prompt();
    content = "typed in the editor\n";
    pending = [write("a.txt", "agent\n", "stale"), read("a.txt", "again")];
    await c.prompt();
    assert.match(resultFor(c, "stale"), /changed since you last read/);
    assert.equal(content, "typed in the editor\n");
    pending = [write("a.txt", "agent\n", "current")];
    await c.prompt();
    assert.match(resultFor(c, "current"), /^File updated/);
    assert.equal(content, "agent\n");
    // The disk copy was never the source of truth.
    assert.equal(
      await readFile(join(c.cwd, "a.txt"), "utf8"),
      "head\r\nold\r\ntail\r\n",
    );
  } finally {
    await c.close();
  }
});

test("legacy write_file {before, after}: after is the content, before is ignored, the result names the new form", async () => {
  const c = await client();
  try {
    pending = [
      // A stale or retyped before no longer fails the write.
      read("a.txt"),
      call(
        "write_file",
        { path: "a.txt", before: "not the file", after: "legacy\n" },
        "legacy",
      ),
      call(
        "write_file",
        { path: "created.txt", before: null, after: "made\n" },
        "legacy-create",
      ),
      // The seen rule still applies to legacy calls.
      call(
        "write_file",
        { path: "unread.txt", before: "x", after: "bad" },
        "legacy-unread",
      ),
      // With content present, a stray after is shed like any undeclared
      // field of a complete call: content is what gets written.
      call(
        "write_file",
        { path: "a.txt", content: "one", after: "two" },
        "mixed",
      ),
    ];
    await writeFile(join(c.cwd, "unread.txt"), "x");
    await c.prompt();
    assert.equal(await readFile(join(c.cwd, "a.txt"), "utf8"), "one");
    assert.equal(await readFile(join(c.cwd, "created.txt"), "utf8"), "made\n");
    assert.equal(await readFile(join(c.cwd, "unread.txt"), "utf8"), "x");
    for (const id of ["legacy", "legacy-create"])
      assert.match(
        resultFor(c, id),
        /^File updated; checkpoint [^\n]+\nNote: write_file takes \{path, content\}; before is no longer needed and was ignored\.$/,
      );
    assert.match(resultFor(c, "legacy-unread"), /you have not read it/);
    assert.match(resultFor(c, "mixed"), /^File updated; checkpoint [^\n]+$/);
    assert.equal(c.state().checkpoints[0].after, "legacy\n");
    assert.equal(editApprovals(c), 3);
  } finally {
    await c.close();
  }
});

test("missing files and folders get clear messages instead of raw ENOENT", async () => {
  const c = await client();
  try {
    pending = [
      call(
        "edit_file",
        { path: "missing.py", old_string: "a", new_string: "b" },
        "edit-missing",
      ),
      call(
        "edit_file",
        { path: "pkg/missing.py", old_string: "a", new_string: "b" },
        "edit-missing-folder",
      ),
      write("pkg/__main__.py", "print(1)\n", "write-missing-folder"),
      call(
        "write_file",
        { path: "__main__.py", before: "print(0)\n", after: "print(1)\n" },
        "legacy-before-for-new-file",
      ),
    ];
    await c.prompt();
    for (const id of ["edit-missing", "edit-missing-folder"])
      assert.match(
        resultFor(c, id),
        /^Tool failed: (pkg\/)?missing\.py does not exist; create it with write_file\. Nothing was written\./,
      );
    assert.match(
      resultFor(c, "write-missing-folder"),
      /^Tool failed: The folder for pkg\/__main__\.py does not exist; create the folder first, then write the file\. Nothing was written\./,
    );
    // A before sent for a file that does not exist yet creates it.
    assert.match(resultFor(c, "legacy-before-for-new-file"), /^File updated/);
    assert.equal(
      await readFile(join(c.cwd, "__main__.py"), "utf8"),
      "print(1)\n",
    );
    for (const m of c.state().messages)
      if (m.role === "tool") assert.doesNotMatch(m.content, /ENOENT|lstat/);
  } finally {
    await c.close();
  }
});

test("files seen survive a restore; a rewind requires a fresh read", async () => {
  const c = await client();
  let loaded;
  try {
    pending = [read("a.txt"), write("a.txt", "one\n", "w1")];
    await c.prompt();
    assert.match(resultFor(c, "w1"), /^File updated/);
    const id = c.sessionId;
    const saved = JSON.parse(
      await readFile(
        join(process.env.OPENWEBUI_ACP_HOME, `session-${id}.json`),
        "utf8",
      ),
    );
    // Hashed paths and content hashes only: no file text or path is stored.
    const views = Object.entries(saved.fileViews);
    assert.equal(views.length, 1);
    for (const [key, value] of views) {
      assert.match(key, /^[a-f0-9]{64}$/);
      assert.match(value, /^[a-f0-9]{64}$/);
    }
    await c.close();
    loaded = await client({ cwd: c.cwd, load: id });
    pending = [write("a.txt", "two\n", "w2")];
    await loaded.prompt();
    assert.match(resultFor(loaded, "w2"), /^File updated/);
    assert.equal(await readFile(join(c.cwd, "a.txt"), "utf8"), "two\n");
    await loaded.connection.agent.request("session/prompt", {
      sessionId: id,
      prompt: [{ type: "text", text: "/rewind 2 --keep-files" }],
    });
    pending = [write("a.txt", "three\n", "w3")];
    await loaded.prompt();
    assert.match(resultFor(loaded, "w3"), /you have not read it/);
    assert.equal(await readFile(join(c.cwd, "a.txt"), "utf8"), "two\n");
  } finally {
    await loaded?.close();
  }
});

test("an unreadable saved file-view map is dropped, not fatal", async () => {
  const c = await client();
  pending = [read("a.txt")];
  await c.prompt();
  const id = c.sessionId;
  await c.close();
  const path = join(process.env.OPENWEBUI_ACP_HOME, `session-${id}.json`);
  const saved = JSON.parse(await readFile(path, "utf8"));
  saved.fileViews = { "not-a-hash": "a.txt" };
  await writeFile(path, JSON.stringify(saved));
  const loaded = await client({ cwd: c.cwd, load: id });
  try {
    pending = [write("a.txt", "x", "w")];
    await loaded.prompt();
    assert.match(resultFor(loaded, "w"), /you have not read it/);
  } finally {
    await loaded.close();
  }
});
