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

const temporary = await realpath(await mkdtemp(join(tmpdir(), "ow-reading-")));
process.env.OPENWEBUI_ACP_HOME = join(temporary, "state");
process.env.OPENWEBUI_API_KEY = "synthetic-reading-key";
const { createAgent } = await import("../dist/agent.js");
const { writeJson, configSchema } = await import("../dist/config.js");
const {
  pageText,
  withoutLineNumbers,
  searchLine,
  globMatch,
  SearchResults,
  READ_PAGE_CHARS,
} = await import("../dist/reading.js");
const { runtimeInstruction, needsRuntimeCheck, DONE_RULE } =
  await import("../dist/harness.js");

let pending = [];
const requests = [];
const server = createServer(async (req, res) => {
  res.setHeader("Content-Type", "application/json");
  if (req.url === "/api/models")
    return res.end(
      JSON.stringify({ data: [{ id: "fixture", max_output_tokens: 4096 }] }),
    );
  // Decode once: a multi-byte character can span two chunks.
  const chunks = [];
  for await (const part of req) chunks.push(part);
  const raw = Buffer.concat(chunks).toString("utf8");
  requests.push(JSON.parse(raw));
  const message = pending.shift() ?? { role: "assistant", content: "Done" };
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
const result = (id) =>
  requests
    .flatMap((r) => r.messages)
    .find((m) => m.role === "tool" && m.tool_call_id === id)?.content;
const lines = (n, f = (i) => `line ${i}`) =>
  Array.from({ length: n }, (_, i) => f(i + 1) + "\n").join("");

async function client(checks) {
  const cwd = await realpath(await mkdtemp(join(temporary, "project-")));
  if (checks)
    await writeJson(
      "config.json",
      configSchema.parse({
        url,
        model: "fixture",
        verify: { projects: [{ root: cwd, commands: checks }] },
      }),
    );
  const app = new ClientApp(),
    executed = [],
    agent = createAgent({
      sandboxCommand: async (executable, args) => {
        executed.push([executable, ...args]);
        return JSON.stringify({
          code: 0,
          output: "ok",
          limitedOrCancelled: false,
        });
      },
    }),
    updates = [];
  app.onNotification("session/update", ({ params }) =>
    updates.push(params.update),
  );
  app.onRequest("session/request_permission", async () => ({
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
  return {
    cwd,
    executed,
    state: () => agent.sessions.get(sessionId),
    text: () =>
      updates
        .filter((u) => u.sessionUpdate === "agent_message_chunk")
        .map((u) => u.content.text)
        .join(""),
    prompt: () =>
      connection.agent.request("session/prompt", {
        sessionId,
        prompt: [{ type: "text", text: "Work on the fixture" }],
      }),
    close: async () => {
      connection.close();
      await agent.close();
    },
  };
}

test("small files read whole with line numbers and a range footer", () => {
  assert.equal(
    pageText("a\n  b\n"),
    "1→a\n2→  b\n[lines 1–2 of 2; end of file]",
  );
  // No final newline: the last line still counts.
  assert.equal(pageText("a\nb"), "1→a\n2→b\n[lines 1–2 of 2; end of file]");
  assert.equal(pageText(""), "[empty file: 0 lines]");
  // Under 8 KB, more than one page of short lines still comes back whole.
  const short = lines(1000, () => "x");
  assert.match(
    pageText(short),
    /^1→x\n[\s\S]*\n1000→x\n\[lines 1–1000 of 1000; end of file\]$/,
  );
});

test("larger files page by offset and limit, ending with the last page", () => {
  const text = lines(1000, (i) => `value_${i} = compute(${i})  # padding`);
  assert(Buffer.byteLength(text) > 8192);
  const first = pageText(text);
  assert.equal(first.split("\n").length, 401);
  assert(first.startsWith("1→value_1 = compute(1)"));
  assert(first.endsWith("[lines 1–400 of 1000; continue with offset=401]"));
  const middle = pageText(text, 401, 10);
  assert(middle.startsWith("401→value_401"));
  assert(middle.endsWith("[lines 401–410 of 1000; continue with offset=411]"));
  const last = pageText(text, 901);
  assert(last.startsWith("901→"));
  assert(
    last.endsWith(
      "1000→value_1000 = compute(1000)  # padding\n[lines 901–1000 of 1000; end of file]",
    ),
  );
  // A limit past the end stops at the last line.
  assert(
    pageText(text, 999, 50).endsWith("[lines 999–1000 of 1000; end of file]"),
  );
  // An explicit limit pages even a small file.
  assert.equal(
    pageText("a\nb\nc\n", 2, 1),
    "2→b\n[lines 2–2 of 3; continue with offset=3]",
  );
  // An offset past the end returns the last page with a note, not an error.
  assert.equal(
    pageText(text, 1001),
    pageText(text, 601).replace(
      "[lines",
      "[offset 1001 is past the end; the file has 1000 lines; showing lines 601–1000; lines",
    ),
  );
  assert.equal(
    pageText(text, 1500, 10),
    pageText(text, 991).replace(
      "[lines",
      "[offset 1500 is past the end; the file has 1000 lines; showing lines 991–1000; lines",
    ),
  );
  assert.equal(
    pageText("a\n", 2),
    "1→a\n[offset 2 is past the end; the file has 1 lines; showing lines 1–1; lines 1–1 of 1; end of file]",
  );
  assert.equal(pageText("", 5), "[empty file: 0 lines]");
});

test("CRLF files show content without carriage returns and say so", () => {
  assert.equal(
    pageText("head\r\nold\r\ntail\r\n"),
    "1→head\n2→old\n3→tail\n[lines 1–3 of 3; end of file; CRLF line endings, shown without \\r]",
  );
});

test("long lines and pages of long lines are bounded", () => {
  const minified = "x".repeat(50000) + "\n";
  const page = pageText(minified);
  assert(page.length < 2200);
  assert.match(
    page,
    /^1→x{2000} … \[line truncated; 50000 characters\]\n\[lines 1–1 of 1; end of file\]$/,
  );
  const wide = lines(100, () => "y".repeat(1000));
  const capped = pageText(wide);
  assert(capped.length <= READ_PAGE_CHARS + 100);
  assert.match(capped, /\[lines 1–23 of 100; continue with offset=24\]$/);
});

test("line-number prefixes are recognized only when every line has one", () => {
  assert.equal(withoutLineNumbers("12→  a\n13→b\n"), "  a\nb\n");
  assert.equal(withoutLineNumbers("12→a"), "a");
  assert.equal(withoutLineNumbers("12→a\nb"), undefined);
  assert.equal(withoutLineNumbers("a"), undefined);
  assert.equal(withoutLineNumbers("12\ta"), undefined);
});

test("search lines are shortened around the match; globs match names or paths", () => {
  assert.equal(searchLine("short\r", "short"), "short");
  const long = "a".repeat(500) + "NEEDLE" + "b".repeat(500);
  const shown = searchLine(long, "NEEDLE");
  assert(shown.includes("NEEDLE"));
  assert(shown.startsWith("…") && shown.endsWith("…"));
  assert(shown.length <= 202);
  assert(globMatch("src/deep/a.py", "*.py"));
  assert(!globMatch("src/deep/a.py", "*.ts"));
  assert(globMatch("src/deep/a.ts", "src/**/*.ts"));
  assert(!globMatch("lib/a.ts", "src/**/*.ts"));
  assert(globMatch("src/a.tsx", "*.{ts,tsx}"));
  const results = new SearchResults("x", 2);
  results.add("a", "x\nx\nx\n");
  results.add("b", "x\n");
  assert.equal(
    results.format(),
    "a:1: x\na:2: x\n[2 more matches in 2 files not shown; narrow with path or glob, or search for longer text]",
  );
  assert.equal(new SearchResults("x").format(), "No matches");
});

test("done rule and examples are offered only with the tools they name", () => {
  const offered = (...names) => names.map((name) => ({ function: { name } }));
  assert.equal(
    runtimeInstruction(offered("read_file", "search_text"), new Map(), false),
    "",
  );
  assert(
    !runtimeInstruction(offered("edit_file"), new Map(), false).includes(
      "Definition of done",
    ),
  );
  const withRun = runtimeInstruction(
    offered("edit_file", "run_command"),
    new Map(),
    false,
  );
  assert(withRun.includes(DONE_RULE));
  assert.match(
    DONE_RULE,
    /first run something that fails for the reported reason/,
  );
  assert.match(DONE_RULE, /two attempts/);
  assert.match(
    DONE_RULE,
    /each command you ran with its result, and what was not verified/,
  );
  for (const path of [
    "README.md",
    "docs/guide.rst",
    "notes.txt",
    "LICENSE",
    "CHANGELOG.md",
  ])
    assert.equal(needsRuntimeCheck(path), false, path);
  for (const path of [
    "src/app.py",
    "Makefile",
    "package.json",
    "game.js",
    "requirements.txt",
    "CMakeLists.txt",
  ])
    assert.equal(needsRuntimeCheck(path), true, path);
});

test("read_file pages through the agent and edit_file works with or without copied prefixes", async () => {
  const c = await client();
  try {
    const body = lines(600, (i) => `def f${i}(): return ${i}  # padding text`);
    await writeFile(join(c.cwd, "big.py"), body);
    await writeFile(join(c.cwd, "small.py"), "a = 1\nb = 2\n");
    pending = [
      call("read_file", { path: "big.py" }, "page1"),
      call("read_file", { path: "big.py", offset: 401, limit: 5 }, "page2"),
      call("read_file", { path: "big.py", offset: 700 }, "beyond"),
      // Copied with prefixes: refused with a precise hint, nothing written.
      call(
        "edit_file",
        {
          path: "big.py",
          old_string:
            "402→def f402(): return 402  # padding text\n403→def f403(): return 403  # padding text\n",
          new_string:
            "402→def f402(): return -402  # padding text\n403→def f403(): return 403  # padding text\n",
        },
        "prefixed",
      ),
      call(
        "edit_file",
        {
          path: "big.py",
          old_string: "def f402(): return 402  # padding text\n",
          new_string: "def f402(): return -402  # padding text\n",
        },
        "clean",
      ),
      call(
        "write_file",
        { path: "small.py", before: "1→a = 1\n2→b = 2\n", after: "a = 3\n" },
        "prefixed-write",
      ),
      call("run_command", { executable: "python3", args: ["big.py"] }, "run"),
    ];
    await c.prompt();
    const page1 = result("page1");
    assert(page1.startsWith("1→def f1(): return 1"));
    assert(page1.endsWith("[lines 1–400 of 600; continue with offset=401]"));
    assert(!page1.includes("401→"));
    assert.equal(
      result("page2").split("\n")[0],
      "401→def f401(): return 401  # padding text",
    );
    assert.match(
      result("beyond"),
      /^201→def f201[\s\S]*600→def f600\(\): return 600  # padding text\n\[offset 700 is past the end; the file has 600 lines; showing lines 201–600; lines 201–600 of 600; end of file\]$/,
    );
    assert.match(
      result("prefixed"),
      /old_string includes line numbers; remove read_file's line-number prefixes \(for example "12→"\).*Nothing was written/,
    );
    assert.equal(result("clean").split(";")[0], "File updated");
    assert.match(result("prefixed-write"), /before includes line numbers/);
    assert.equal(
      await readFile(join(c.cwd, "small.py"), "utf8"),
      "a = 1\nb = 2\n",
    );
    const after = await readFile(join(c.cwd, "big.py"), "utf8");
    assert(after.includes("def f402(): return -402  # padding text\n"));
    assert.equal(after.split("\n").length, 601);
  } finally {
    await c.close();
  }
});

test("search_text caps results, narrows by path and glob and refuses unsafe scopes", async () => {
  const c = await client();
  try {
    await mkdir(join(c.cwd, "src/sub"), { recursive: true });
    await mkdir(join(c.cwd, "docs"), { recursive: true });
    await mkdir(join(c.cwd, ".venv/lib"), { recursive: true });
    for (let i = 0; i < 30; i++)
      await writeFile(
        join(c.cwd, `src/f${String(i).padStart(2, "0")}.py`),
        "hit()\nhit(a.b)\n",
      );
    await writeFile(join(c.cwd, "src/sub/deep.ts"), "const hit = 1;\n");
    await writeFile(
      join(c.cwd, "docs/hit.md"),
      "hit " + "z".repeat(400) + "\n",
    );
    await writeFile(join(c.cwd, ".venv/lib/hidden.py"), "hit()\n");
    await writeFile(join(c.cwd, "plain.txt"), "hit\n");
    pending = [
      call("search_text", { text: "hit" }, "default"),
      call("search_text", { text: "hit", max_results: 3 }, "three"),
      call("search_text", { text: "hit", path: "src/sub" }, "path"),
      call("search_text", { text: "hit", glob: "*.ts" }, "glob"),
      call("search_text", { text: "hit", glob: "docs/**" }, "pathglob"),
      call("search_text", { text: "(a.b)" }, "literal"),
      call("search_text", { text: "absent-text" }, "none"),
      call("search_text", { text: "hit", path: "../" }, "outside"),
      call("search_text", { text: "hit", path: ".git" }, "sensitive"),
      call("search_text", { text: "hit", path: "plain.txt" }, "file"),
      call("search_text", { text: "hit", max_results: 500 }, "toomany"),
    ];
    await c.prompt();
    const all = result("default").split("\n");
    assert.equal(all.length, 51);
    assert.equal(
      all[0],
      "docs/hit.md:1: " + searchLine("hit " + "z".repeat(400), "hit"),
    );
    assert.equal(all[0].length, "docs/hit.md:1: ".length + 201);
    assert.equal(all[1], "plain.txt:1: hit");
    assert.equal(all[2], "src/f00.py:1: hit()");
    // 63 visible matches: 2 + 60 + 1; .venv is a default ignore.
    assert.equal(
      all[50],
      "[13 more matches in 7 files not shown; narrow with path or glob, or search for longer text]",
    );
    assert(!result("default").includes(".venv"));
    assert.equal(result("three").split("\n").length, 4);
    assert.match(result("three"), /\[60 more matches in 31 files not shown/);
    assert.equal(result("path"), "src/sub/deep.ts:1: const hit = 1;");
    assert.equal(result("glob"), "src/sub/deep.ts:1: const hit = 1;");
    assert.match(result("pathglob"), /^docs\/hit\.md:1: hit z+…$/);
    assert.equal(result("literal").split("\n").length, 30);
    assert.equal(result("none"), "No matches");
    assert.match(result("outside"), /outside permitted scope/);
    assert.match(result("sensitive"), /outside permitted scope or sensitive/);
    assert.equal(result("file"), "plain.txt:1: hit");
    assert.match(
      result("toomany"),
      /Invalid tool arguments: max_results: keep within 200/,
    );
  } finally {
    await c.close();
  }
});

test("search_text accepts a single file and keeps every refusal", async () => {
  const c = await client();
  try {
    await mkdir(join(c.cwd, "build"), { recursive: true });
    await mkdir(join(c.cwd, "src"), { recursive: true });
    await writeFile(join(c.cwd, "build/out.js"), "x\nneedle\n");
    await writeFile(join(c.cwd, "src/a.py"), "needle one\nother\n");
    await writeFile(join(c.cwd, "src/b.py"), "needle two\n");
    await writeFile(join(c.cwd, ".env"), "needle\n");
    await mkdir(join(c.cwd, ".git"), { recursive: true });
    await writeFile(join(c.cwd, ".git/config"), "needle\n");
    await symlink(join(c.cwd, "src/a.py"), join(c.cwd, "link.py"));
    pending = [
      call("search_text", { text: "needle", path: "src/a.py" }, "one"),
      call("search_text", { text: "needle", path: "build/out.js" }, "ignored"),
      call("search_text", { text: "zzz", path: "src/a.py" }, "none"),
      call(
        "search_text",
        { text: "needle", path: "src/a.py", glob: "*.ts" },
        "glob",
      ),
      call("search_text", { text: "needle", path: ".env" }, "env"),
      call("search_text", { text: "needle", path: ".git/config" }, "git"),
      call("search_text", { text: "needle", path: "/etc/hosts" }, "outside"),
      call("search_text", { text: "needle", path: "link.py" }, "link"),
      call("search_text", { text: "needle", path: "missing.py" }, "missing"),
    ];
    await c.prompt();
    assert.equal(result("one"), "src/a.py:1: needle one");
    assert.equal(result("ignored"), "build/out.js:2: needle");
    assert.equal(result("none"), "No matches");
    assert.equal(result("glob"), "src/a.py:1: needle one");
    for (const id of ["env", "git", "outside"])
      assert.match(result(id), /outside permitted scope or sensitive/, id);
    assert.match(result("link"), /Symlink access refused/);
    assert.match(result("missing"), /ENOENT/);
  } finally {
    await c.close();
  }
});

test("run_command refuses a command line in executable without running it", async () => {
  const c = await client();
  try {
    await mkdir(join(c.cwd, "with space"));
    const spaced = join(c.cwd, "with space", "tool.sh");
    await writeFile(spaced, "#!/bin/sh\n");
    pending = [
      call("run_command", { executable: "python3 -m unittest", args: [] }, "a"),
      call(
        "run_command",
        { executable: "which python python3", args: ["-a"] },
        "b",
      ),
      call(
        "run_command",
        { executable: join(c.cwd, "missing dir", "tool"), args: [] },
        "c",
      ),
      call("run_command", { executable: spaced, args: ["x"] }, "d"),
      call("run_command", { executable: "python3", args: ["-V"] }, "e"),
    ];
    await c.prompt();
    assert(
      result("a").startsWith(
        'Tool failed: executable must be the program only; use executable: "python3", args: ["-m", "unittest"]. If the command needs quoting or shell syntax, use executable: "sh", args: ["-c", "..."]. Nothing was run.',
      ),
    );
    assert.match(
      result("b"),
      /use executable: "which", args: \["python", "python3", "-a"\]/,
    );
    assert.match(result("c"), /executable must be the program only/);
    assert.deepEqual(c.executed, [
      [spaced, "x"],
      ["python3", "-V"],
    ]);
  } finally {
    await c.close();
  }
});

const reminders = (c) =>
  c.state().messages.filter((m) => /^Check reminder/.test(m.content ?? ""));

test("one check reminder after a code edit with no later run", async () => {
  const c = await client();
  try {
    await writeFile(join(c.cwd, "game.js"), "let score = 0;\n");
    pending = [
      call(
        "edit_file",
        { path: "game.js", old_string: "0;", new_string: "1;" },
        "e1",
      ),
      { role: "assistant", content: "Changed the score." },
      // The model ignores the reminder; the turn still ends after one.
      { role: "assistant", content: "Still not run." },
    ];
    assert.equal((await c.prompt()).stopReason, "end_turn");
    assert.equal(requests.length, 3);
    assert.equal(reminders(c).length, 1);
    assert.match(
      reminders(c)[0].content,
      /^Check reminder \(sent once\): game\.js changed after your last run\. .*run_command/,
    );
    assert.match(c.text(), /Check reminder/);
    assert(
      requests[2].messages.some((m) => /^Check reminder/.test(m.content ?? "")),
    );
    // A new turn can remind again.
    pending = [
      call(
        "edit_file",
        { path: "game.js", old_string: "1;", new_string: "2;" },
        "e2",
      ),
      call("run_command", { executable: "node", args: ["game.js"] }, "r2"),
      call(
        "edit_file",
        { path: "game.js", old_string: "2;", new_string: "3;" },
        "e3",
      ),
    ];
    await c.prompt();
    assert.equal(reminders(c).length, 2);
  } finally {
    await c.close();
  }
});

test("no check reminder for docs-only edits or when a run follows the last edit", async () => {
  const c = await client();
  try {
    await writeFile(join(c.cwd, "README.md"), "# Title\n");
    await writeFile(join(c.cwd, "app.py"), "print(1)\n");
    pending = [
      call(
        "edit_file",
        { path: "README.md", old_string: "Title", new_string: "Name" },
        "doc",
      ),
    ];
    await c.prompt();
    assert.equal(requests.length, 2);
    pending = [
      call(
        "edit_file",
        { path: "app.py", old_string: "1", new_string: "2" },
        "code",
      ),
      call("run_command", { executable: "python3", args: ["app.py"] }, "run"),
      call(
        "edit_file",
        { path: "README.md", old_string: "Name", new_string: "Doc" },
        "doc2",
      ),
    ];
    await c.prompt();
    assert.equal(c.executed.length, 1);
    assert.equal(reminders(c).length, 0);
    assert.equal(requests.length, 6);
  } finally {
    await c.close();
  }
});

test("configured project checks count as the run, so no reminder is sent", async () => {
  const c = await client([{ executable: "npm", args: ["test"] }]);
  try {
    await writeFile(join(c.cwd, "app.py"), "print(1)\n");
    pending = [
      call(
        "edit_file",
        { path: "app.py", old_string: "1", new_string: "2" },
        "code",
      ),
    ];
    await c.prompt();
    assert.equal(reminders(c).length, 0);
    assert.deepEqual(c.executed, [["npm", "test"]]);
  } finally {
    await c.close();
  }
});

test("edit_file and run_command descriptions each carry valid example calls", async () => {
  const c = await client();
  try {
    await c.prompt();
    const description = (name) =>
      requests[0].tools.find((t) => t.function.name === name).function
        .description;
    const examples = (name) =>
      [...description(name).matchAll(/\{"[^{}]*\}/g)].map((m) =>
        JSON.parse(m[0]),
      );
    assert(!description("edit_file").includes("\n"));
    assert.deepEqual(examples("edit_file"), [
      {
        path: "src/app.py",
        old_string: "    return total - bonus\n",
        new_string: "    return total + bonus\n",
      },
    ]);
    assert.match(description("edit_file"), /without read_file's "N→" prefixes/);
    assert.match(
      description("write_file"),
      /small existing file \(up to 8 KB; larger files are refused, use edit_file\)/,
    );
    assert.deepEqual(examples("run_command"), [
      { executable: "python3", args: ["-m", "pytest"] },
      { executable: "sh", args: ["-c", "make | tail"] },
    ]);
    assert.match(description("read_file"), /offset is the 1-based first line/);
    assert.match(description("search_text"), /default 50/);
  } finally {
    await c.close();
  }
});
