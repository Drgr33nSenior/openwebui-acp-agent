// Offline self-test for the long-benchmark game task
// (test/manual-long-benchmark-game*.mjs and the runner's --task game). No
// model and no remote service. Two parts need tools that CI does not have and
// are skipped there with the reason shown: the PLAN-04 checker
// (LONG_BENCHMARK_ACCEPTANCE_CHECKER) and an evaluator browser
// (LONG_BENCHMARK_GAME_BROWSER). The browser container workflow plays the
// reference and the known-bug mutants in the real container.
import assert from "node:assert/strict";
import test from "node:test";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import {
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const temporary = await realpath(
  await mkdtemp(join(tmpdir(), "ow-game-test-")),
);
process.env.OPENWEBUI_ACP_HOME = join(temporary, "unused-state");
test.after(() => rm(temporary, { recursive: true, force: true }));

const GAME = await import("./manual-long-benchmark-game.mjs");
const here = dirname(fileURLToPath(import.meta.url));
const checkout = dirname(here);
const CHECKER = process.env.LONG_BENCHMARK_ACCEPTANCE_CHECKER;
const BROWSER = process.env.LONG_BENCHMARK_GAME_BROWSER;
const source = await GAME.loadSource();
const { script } = source;

test("the acceptance source is sealed, consistent and pinned outside itself", async () => {
  assert.equal(GAME.sealOf(source.files), GAME.GAME_SEAL);
  assert.equal(source.spec.oracle.applicable, false);
  assert.deepEqual(
    source.spec.external_state.checks.map((c) => [c.path, c.equals]),
    [
      [["complete"], true],
      ...script.checks.map((id) => [["checks", id], true]),
    ],
  );
  assert.deepEqual(source.spec.linkage.checks[0], {
    id: "played-entry",
    left: { from: "state", path: ["entry_sha256"] },
    right: { from: "artifact-sha256", name: "game-entry" },
  });
  // The pin is not inside the source, and a changed byte changes the seal.
  for (const data of Object.values(source.files))
    assert(!data.toString("latin1").includes(GAME.GAME_SEAL));
  const changed = { ...source.files };
  changed["playthrough.json"] = Buffer.concat([
    changed["playthrough.json"],
    Buffer.from(" "),
  ]);
  assert.notEqual(GAME.sealOf(changed), GAME.GAME_SEAL);
  // The visible fixture is the brief only.
  assert.deepEqual(
    Object.keys(source.files).filter((n) => n.startsWith("fixture/")),
    ["fixture/BRIEF.md"],
  );
  assert.deepEqual(Object.keys(source.games).sort(), [
    "diagonal",
    "no-lock",
    "reference",
    "restart-moves",
    "solved-text",
    "undo-count",
    "wraps",
  ]);
});

test(
  "the PLAN-04 checker computes the same seal",
  { skip: !CHECKER && "LONG_BENCHMARK_ACCEPTANCE_CHECKER is not set" },
  async () => {
    assert.equal(await GAME.checkerSeal(CHECKER, GAME.SOURCE), GAME.GAME_SEAL);
  },
);

test("the brief never asks for play-testing and hidden content stays hidden", async () => {
  const brief = source.files["fixture/BRIEF.md"].toString("utf8");
  for (const text of [brief, GAME.PROMPT])
    assert.doesNotMatch(
      text,
      /play-?test|\btest(s|ing)?\b|preview|browser tool|screenshot|view_image|verify|check (it|that|the game)|try (it|the game)/i,
    );
  // The marker and hidden expectations appear in no agent-visible text and
  // in no evaluator code that could be shown to the model.
  const visible = [
    brief,
    GAME.PROMPT,
    await readFile(join(here, "manual-long-benchmark.mjs"), "utf8"),
    await readFile(join(here, "manual-long-benchmark-game.mjs"), "utf8"),
    await readFile(join(here, "manual-long-benchmark-game-driver.mjs"), "utf8"),
  ];
  for (const text of visible) {
    assert(!text.includes(script.marker));
    assert(!text.includes("Solved in 6 moves"));
  }
  // The brief states the rules the hidden checks enforce.
  for (const rule of [
    "11110",
    "Solved in N moves",
    "does not",
    "aria-pressed",
    "data-row",
    "id `undo`",
    "id `restart`",
  ])
    assert(brief.includes(rule), rule);
});

// A rule simulator for the reference and each known bug, producing the raw
// observations the browser driver would return.
const PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0,
]).toString("base64");
function simulate(variant, overrides = {}) {
  const start = () => script.start.map((l) => [...l].map((c) => c === "1"));
  let grid = start(),
    history = [],
    solved = false;
  const toggle = (row, col) => {
    const near =
      variant === "diagonal"
        ? [
            [row, col],
            [row - 1, col - 1],
            [row + 1, col],
            [row, col - 1],
            [row, col + 1],
          ]
        : [
            [row, col],
            [row - 1, col],
            [row + 1, col],
            [row, col - 1],
            [row, col + 1],
          ];
    for (const [r, c] of near)
      if (variant === "wraps") {
        const rr = (r + 5) % 5,
          cc = (c + 5) % 5;
        grid[rr][cc] = !grid[rr][cc];
      } else if (r >= 0 && r < 5 && c >= 0 && c < 5) grid[r][c] = !grid[r][c];
  };
  const play = (row, col) => {
    if (solved && variant !== "no-lock") return;
    toggle(row, col);
    history.push([row, col]);
    solved = grid.every((l) => l.every((on) => !on));
  };
  const steps = [];
  for (const step of script.steps) {
    if (step.action.load) {
      grid = start();
      history = [];
      solved = false;
    }
    for (const [r, c] of step.action.clicks ?? []) play(r, c);
    if (step.action.button === "undo") {
      const last = variant === "undo-count" ? history.at(-1) : history.pop();
      if (last) {
        toggle(...last);
        solved = false;
      }
    }
    if (step.action.button === "restart") {
      grid = start();
      if (variant !== "restart-moves") history = [];
      solved = false;
    }
    steps.push({
      id: step.id,
      count: 25,
      cells: grid.flatMap((l, r) =>
        l.map((on, c) => ({
          row: String(r),
          col: String(c),
          pressed: String(on),
        })),
      ),
      moves: String(history.length),
      status: solved
        ? variant === "solved-text"
          ? "You win!"
          : `Solved in ${history.length} moves`
        : "",
      undoDisabled: history.length === 0,
      ...(step.screenshot ? { screenshot: PNG } : {}),
    });
  }
  return {
    steps,
    pageErrors: 0,
    consoleErrors: 0,
    externalRequests: 0,
    dialogs: 0,
    litDistinct: true,
    ...overrides,
  };
}
const failing = (raw) =>
  Object.entries(GAME.judge(script, raw).checks)
    .filter(([, ok]) => !ok)
    .map(([id]) => id);

test("the judge passes the reference rules and fails each known bug as declared", () => {
  assert.deepEqual(failing(simulate("reference")), []);
  for (const [name, expected] of Object.entries(script.references.mutants)) {
    const failed = failing(simulate(name));
    for (const id of expected) assert(failed.includes(id), `${name}: ${id}`);
  }
  // Recorded in a real browser by --check-browser (docs/verification.md):
  // the simulator must agree exactly.
  assert.deepEqual(failing(simulate("no-lock")), ["solved-locked"]);
  assert.deepEqual(failing(simulate("restart-moves")), ["restart"]);
  assert.deepEqual(failing(simulate("diagonal")), [
    "edge-move",
    "solve",
    "solved-locked",
  ]);
});

test("the judge fails on page faults, missing elements and missing screenshots", () => {
  assert.deepEqual(failing(simulate("reference", { pageErrors: 1 })), [
    "no-page-errors",
  ]);
  assert.deepEqual(failing(simulate("reference", { externalRequests: 2 })), [
    "self-contained",
  ]);
  assert.deepEqual(failing(simulate("reference", { litDistinct: false })), [
    "lit-distinct",
  ]);
  const raw = simulate("reference");
  delete raw.steps[0].screenshot;
  assert.deepEqual(failing(raw), ["screenshots"]);
  const broken = simulate("reference");
  broken.steps[0].count = 24;
  broken.steps[0].cells.pop();
  assert.deepEqual(failing(broken).slice(0, 2), [
    "board-layout",
    "start-state",
  ]);
  const clickFailed = simulate("reference");
  clickFailed.steps[1].error = "locator.click: Timeout 3000ms exceeded.";
  assert(failing(clickFailed).includes("corner-move"));
  const missing = simulate("reference");
  missing.steps.splice(5, 1);
  assert(failing(missing).includes("solve"));
  // A board drawn with the wrong attributes is not a board.
  const pressed = simulate("reference");
  pressed.steps[0].cells[3].pressed = "yes";
  assert.equal(GAME.gridOf(pressed.steps[0], 5).error, "aria-pressed-invalid");
});

const call = (name, args, ok = true, result = "") => ({
  name,
  args,
  ok,
  result,
});
const preview = call(
  "start_preview",
  { entry: "index.html", files: ["index.html"] },
  true,
  JSON.stringify({
    url: "http://127.0.0.1:4100/index.html",
    containerUrl: "http://host.docker.internal:4100/index.html",
  }),
);
const write = call("write_file", { path: "index.html" });
const nav = (url) => call("browser/browser_navigate", { url });

test("unprompted play-testing needs a preview, navigation, interaction and a page read", () => {
  const detect = (calls) =>
    GAME.detectPlaytest(calls, { browserAvailable: true });
  const full = [
    write,
    preview,
    nav("http://host.docker.internal:4100/index.html"),
    call("browser/browser_click", { target: "e3" }),
    call("browser/browser_snapshot", {}),
  ];
  assert.equal(detect(full).observed, true);
  assert.equal(detect(full).afterLastEdit, true);
  assert.equal(detect(full).asked, false);
  // Each missing element: no play-test.
  assert.equal(detect([write]).observed, false);
  assert.equal(detect([write, preview]).observed, false);
  assert.equal(detect(full.filter((c) => c !== full[3])).observed, false);
  assert.equal(detect(full.filter((c) => c !== full[4])).observed, false);
  // Navigation elsewhere, failed calls and play before any game file do not count.
  assert.equal(
    detect([write, preview, nav("https://example.com/"), full[3], full[4]])
      .observed,
    false,
  );
  assert.equal(
    detect([write, preview, full[2], { ...full[3], ok: false }, full[4]])
      .observed,
    false,
  );
  assert.equal(
    detect([preview, full[2], full[3], full[4], write]).observed,
    false,
  );
  // Played, then edited again: observed, but not after the last edit.
  const stale = detect([...full, call("edit_file", { path: "index.html" })]);
  assert.deepEqual([stale.observed, stale.afterLastEdit], [true, false]);
  // Without a browser the behaviour cannot be measured.
  assert.equal(
    GAME.detectPlaytest(full, { browserAvailable: false }).observed,
    null,
  );
  // Transcript reading: MCP names resolved, failures and MCP errors not ok.
  const calls = GAME.callsFromTranscript(
    {
      failedToolCalls: ["b"],
      messages: [
        {
          role: "assistant",
          tool_calls: [
            {
              id: "a",
              function: { name: "mcp_0_3", arguments: '{"target":"e1"}' },
            },
            { id: "b", function: { name: "read_file", arguments: "{}" } },
            { id: "c", function: { name: "mcp_0_4", arguments: "not json" } },
          ],
        },
        { role: "tool", tool_call_id: "a", content: '{"content":[]}' },
        { role: "tool", tool_call_id: "b", content: "refused" },
        { role: "tool", tool_call_id: "c", content: '{"isError":true}' },
      ],
    },
    { mcp_0_3: "browser/browser_click", mcp_0_4: "browser/browser_snapshot" },
  );
  assert.deepEqual(
    calls.map((c) => [c.name, c.ok]),
    [
      ["browser/browser_click", true],
      ["read_file", false],
      ["browser/browser_snapshot", false],
    ],
  );
});

test("isolation is established only when controls work and nothing leaks", () => {
  const plan = GAME.probePlan({
    workspace: "/scratch/probe",
    acceptance: "/scratch/acceptance",
    hidden: "/scratch/acceptance/playthrough.json",
    repoHidden: ["/repo/test/fixtures/long-benchmark-game/playthrough.json"],
    nonce: "nonce-1",
    browser: true,
  });
  const ids = plan.map((p) => p.id);
  for (const id of [
    "read-absolute",
    "read-relative",
    "command-cat",
    "command-symlink",
    "command-copy",
    "command-append",
    "command-create",
    "write-absolute",
    "edit-hidden",
    "preview-hidden",
    "command-repository-0",
    "browser-file",
  ])
    assert(ids.includes(id), id);
  assert.equal(
    plan.find((p) => p.id === "read-relative").args.path,
    "../acceptance/playthrough.json",
  );
  const good = Object.fromEntries(
    plan.map((p) => [
      p.id,
      p.kind === "control"
        ? { ok: true, text: "nonce-1" }
        : { ok: false, text: `refused ${JSON.stringify(p.args)}` },
    ]),
  );
  const after = {
    marker: "MARKER",
    nonce: "nonce-1",
    sealUnchanged: true,
    created: [],
    repoUnchanged: true,
  };
  assert.deepEqual(GAME.judgeProbes(plan, good, after), {
    established: true,
    findings: [],
    probes: plan.length,
  });
  const leak = { ...good, "command-cat": { ok: false, text: "x MARKER" } };
  assert.deepEqual(GAME.judgeProbes(plan, leak, after).findings, [
    "command-cat: revealed hidden content",
  ]);
  const listed = {
    ...good,
    "command-list": { ok: false, text: "acceptance.json\nplaythrough.json" },
  };
  assert.equal(GAME.judgeProbes(plan, listed, after).established, false);
  const ran = { ...good, "command-append": { ok: true, text: "" } };
  assert.deepEqual(GAME.judgeProbes(plan, ran, after).findings, [
    "command-append: succeeded",
  ]);
  const brokenControl = {
    ...good,
    "control-command": { ok: false, text: "sandbox unavailable" },
  };
  assert.equal(GAME.judgeProbes(plan, brokenControl, after).established, false);
  const missing = { ...good };
  delete missing["browser-file"];
  assert.deepEqual(GAME.judgeProbes(plan, missing, after).findings, [
    "browser-file: not executed",
  ]);
  for (const changed of [
    { sealUnchanged: false },
    { created: ["probe-created"] },
    { repoUnchanged: false },
  ])
    assert.equal(
      GAME.judgeProbes(plan, good, { ...after, ...changed }).established,
      false,
    );
  assert.equal(
    GAME.parseTransport("container:openwebui-acp-browser-browser-1").kind,
    "container",
  );
  assert.equal(GAME.parseTransport("local:/usr/bin/chromium").kind, "local");
  for (const bad of [
    "",
    "container:a b",
    "container:-x",
    "local:relative",
    "docker:x",
  ])
    assert.equal(GAME.parseTransport(bad), null, bad);
});

// ---- Through the runner --------------------------------------------------
async function userState(url) {
  const state = await mkdtemp(join(temporary, "user-state-"));
  await writeFile(
    join(state, "config.json"),
    JSON.stringify({ url, model: "fixture" }),
    { mode: 0o600 },
  );
  return state;
}
function runner(label, env) {
  return new Promise((done) => {
    const child = spawn(
      process.execPath,
      [
        join(here, "manual-long-benchmark.mjs"),
        "--live",
        checkout,
        label,
        "5",
        "--task",
        "game",
      ],
      { env, stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "",
      stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => done({ code, stdout, stderr }));
  });
}

test(
  "without an evaluator the runner proves isolation, then refuses to start",
  { timeout: 240000 },
  async () => {
    const results = join(temporary, "results-closed");
    const env = {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      OPENWEBUI_ACP_HOME: await userState("http://127.0.0.1:9"),
      LONG_BENCHMARK_RESULTS: results,
      TMPDIR: temporary,
    };
    const run = await runner("closed-1", env);
    assert.equal(run.code, 4, run.stderr);
    const report = JSON.parse(
      await readFile(join(results, "closed-1", "report.json"), "utf8"),
    );
    assert.equal(report.sessionId, undefined);
    assert.equal(report.requests, 0);
    assert.deepEqual(report.hiddenChecks, {
      verdict: "unavailable",
      reason: "preconditions not met",
    });
    assert.equal(report.unpromptedPlaytest.observed, null);
    // Report the actual isolation failure before checking dependent preconditions.
    assert.equal(
      report.isolation.established,
      true,
      JSON.stringify({
        findings: report.isolation.findings,
        controls: Object.fromEntries(
          Object.entries(report.isolation.results).filter(
            ([, result]) => result.kind === "control",
          ),
        ),
      }),
    );
    assert.deepEqual(
      report.preconditions.map((p) => p.split(" ")[0]),
      [
        "LONG_BENCHMARK_BROWSER_MCP_URL",
        "LONG_BENCHMARK_ACCEPTANCE_CHECKER",
        "LONG_BENCHMARK_GAME_BROWSER",
      ],
    );
    // The probes ran through the real agent and sandbox on this platform.
    for (const [id, r] of Object.entries(report.isolation.results))
      assert.equal(r.ok, r.kind === "control", id);
    const text = await readFile(
      join(results, "closed-1", "report.json"),
      "utf8",
    );
    assert(!text.includes(script.marker));
  },
);

// A fake browser MCP server with the three tools a play-test needs.
async function fakeBrowser() {
  const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
  const { StreamableHTTPServerTransport } =
    await import("@modelcontextprotocol/sdk/server/streamableHttp.js");
  const { z } = await import("zod");
  const calls = [];
  const http = createServer(async (req, res) => {
    const server = new McpServer({ name: "browser", version: "1" });
    for (const [name, shape] of [
      ["browser_navigate", { url: z.string() }],
      ["browser_click", { target: z.string(), element: z.string().optional() }],
      ["browser_snapshot", {}],
    ])
      server.registerTool(name, { inputSchema: shape }, async (args) => {
        calls.push([name, args]);
        return {
          content: [{ type: "text", text: `- button "Light" [ref=e1]` }],
        };
      });
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    await server.connect(transport);
    let body = "";
    for await (const c of req) body += c;
    await transport.handleRequest(
      req,
      res,
      body ? JSON.parse(body) : undefined,
    );
  });
  await new Promise((r) => http.listen(0, "127.0.0.1", r));
  return {
    url: `http://127.0.0.1:${http.address().port}/mcp`,
    calls,
    close: () => {
      http.closeAllConnections();
      return new Promise((r) => http.close(r));
    },
  };
}
// A scripted model that writes `html` as index.html and, when `play` is set,
// previews and plays it without being asked.
async function fakeModel(html, play) {
  const steps = [
    () => ({ name: "write_file", args: { path: "index.html", content: html } }),
  ];
  if (play)
    steps.push(
      () => ({
        name: "start_preview",
        args: { entry: "index.html", files: ["index.html"], timeout_ms: 60000 },
      }),
      (last) => ({
        name: "browser/browser_navigate",
        args: { url: JSON.parse(last).containerUrl },
      }),
      () => ({
        name: "browser/browser_click",
        args: { target: "e1", element: "light" },
      }),
      () => ({ name: "browser/browser_snapshot", args: {} }),
    );
  let round = 0;
  const server = createServer(async (req, res) => {
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/api/models")
      return res.end(JSON.stringify({ data: [{ id: "fixture" }] }));
    let raw = "";
    for await (const p of req) raw += p;
    const request = JSON.parse(raw);
    const last = request.messages
      .filter((m) => m.role === "tool")
      .at(-1)?.content;
    const step = request.tools.length ? steps[round++] : undefined;
    let message = {
      role: "assistant",
      content: "Built Lights Out in index.html.",
    };
    if (step) {
      const next = step(last);
      const name = next.name.startsWith("browser/")
        ? request.tools.find((t) =>
            t.function.description.startsWith(`Untrusted MCP ${next.name}:`),
          ).function.name
        : next.name;
      message = {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: `call-${round}`,
            type: "function",
            function: { name, arguments: JSON.stringify(next.args) },
          },
        ],
      };
    }
    res.end(
      JSON.stringify({
        choices: [
          {
            message,
            finish_reason: message.tool_calls ? "tool_calls" : "stop",
          },
        ],
        usage: {
          prompt_tokens: Math.ceil(raw.length / 4),
          completion_tokens: 30,
        },
      }),
    );
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    close: () => {
      server.closeAllConnections();
      return new Promise((r) => server.close(r));
    },
  };
}

test(
  "a full run: hidden verdict, screenshots and unprompted play-testing",
  {
    timeout: 600000,
    skip:
      (!CHECKER || !BROWSER) &&
      "needs LONG_BENCHMARK_ACCEPTANCE_CHECKER and LONG_BENCHMARK_GAME_BROWSER",
  },
  async () => {
    const browser = await fakeBrowser();
    const results = join(temporary, "results-full");
    try {
      for (const [label, game, play, verdict] of [
        ["reference-1", "reference", true, "accepted"],
        ["no-lock-1", "no-lock", false, "rejected"],
      ]) {
        const model = await fakeModel(
          source.games[game]["index.html"].toString("utf8"),
          play,
        );
        try {
          const run = await runner(label, {
            PATH: process.env.PATH,
            HOME: process.env.HOME,
            OPENWEBUI_ACP_HOME: await userState(model.url),
            OPENWEBUI_API_KEY: "synthetic-game-run",
            LONG_BENCHMARK_RESULTS: results,
            LONG_BENCHMARK_ACCEPTANCE_CHECKER: CHECKER,
            LONG_BENCHMARK_GAME_BROWSER: BROWSER,
            LONG_BENCHMARK_BROWSER_MCP_URL: browser.url,
            TMPDIR: temporary,
          });
          assert.equal(run.code, 0, run.stderr + run.stdout.slice(-2000));
          const dir = join(results, label);
          const report = JSON.parse(
            await readFile(join(dir, "report.json"), "utf8"),
          );
          assert.equal(
            report.isolation.established,
            true,
            JSON.stringify(report.isolation.findings),
          );
          assert.equal(
            report.hiddenChecks.verdict,
            verdict,
            JSON.stringify(report.hiddenChecks),
          );
          assert.equal(report.hiddenChecks.validatedVerdict, verdict);
          assert.equal(
            report.hiddenChecks.passed + report.hiddenChecks.failed,
            13,
          );
          assert.equal(report.hiddenChecks.sealSha256, GAME.GAME_SEAL);
          assert.equal(
            report.unpromptedPlaytest.observed,
            play,
            JSON.stringify({
              p: report.unpromptedPlaytest,
              t: report.toolCalls,
              d: report.deniedOperations,
              m: report.mcpTools,
            }),
          );
          if (play) {
            assert.equal(report.toolCalls["browser/browser_click"], 1);
            assert.equal(report.unpromptedPlaytest.afterLastEdit, true);
          }
          if (verdict === "rejected")
            assert.deepEqual(report.hiddenChecks.reasons, [
              "external_state:solved-locked",
            ]);
          // Screenshots are files tied to the played bytes.
          const state = JSON.parse(
            await readFile(join(dir, "playthrough-state.json"), "utf8"),
          );
          const html = source.games[game]["index.html"];
          assert.equal(state.entry_sha256, GAME.sha256(html));
          assert.deepEqual(
            state.screenshots.map((s) => s.step),
            ["initial", "corner", "solve", "restart"],
          );
          for (const s of state.screenshots) {
            const png = await readFile(join(dir, s.file));
            assert.equal(GAME.sha256(png), s.sha256);
            assert.equal(s.served_tree_sha256, state.served_tree_sha256);
          }
          assert.deepEqual((await readdir(join(dir, "screenshots"))).length, 4);
          for (const name of [
            "report.json",
            "requests.jsonl",
            "agent-text.txt",
          ])
            assert(
              !(await readFile(join(dir, name), "utf8")).includes(
                script.marker,
              ),
              name,
            );
          assert.equal(report.tokens.promptReported, report.tokens.requests);
        } finally {
          await model.close();
        }
      }
      assert(browser.calls.some(([name]) => name === "browser_click"));
      // Navigation went only to the preview the agent started.
      for (const [name, args] of browser.calls)
        if (name === "browser_navigate")
          assert.match(
            args.url,
            /^http:\/\/host\.docker\.internal:\d+\/index\.html$/,
          );
    } finally {
      await browser.close();
    }
  },
);

test("the evaluator CLI refuses an unknown browser transport", () => {
  const run = spawnSync(
    process.execPath,
    [
      join(here, "manual-long-benchmark-game.mjs"),
      "--check-browser",
      "docker:x",
    ],
    { encoding: "utf8" },
  );
  assert.equal(run.status, 2);
  assert.match(run.stderr, /container:NAME\|local:/);
});

test("the summary shows the hidden verdict and play-testing explicitly", async () => {
  const { summaryRow } = await import("./manual-long-benchmark-summary.mjs");
  const row = (hiddenChecks, unpromptedPlaytest) =>
    summaryRow("game-1", { hiddenChecks, unpromptedPlaytest });
  const accepted = row(
    { verdict: "accepted", passed: 13, failed: 0, unavailable: 0 },
    { observed: true, afterLastEdit: true },
  );
  assert.equal(accepted.hidden, "accepted: 13 passed, 0 failed");
  assert.equal(accepted.playtest, "yes");
  const rejected = row(
    { verdict: "rejected", passed: 12, failed: 1, unavailable: 0 },
    { observed: true, afterLastEdit: false },
  );
  assert.equal(rejected.hidden, "rejected: 12 passed, 1 failed");
  assert.equal(rejected.playtest, "yes (before last edit)");
  const closed = row(
    { verdict: "unavailable", reason: "preconditions not met" },
    { observed: null, reason: "no session" },
  );
  assert.equal(closed.hidden, "unavailable (preconditions not met)");
  assert.equal(closed.playtest, "unknown (no session)");
  const partial = row(
    { verdict: "unavailable", passed: 0, failed: 0, unavailable: 13 },
    { observed: false },
  );
  assert.equal(
    partial.hidden,
    "unavailable: 0 passed, 0 failed, 13 unavailable",
  );
  assert.equal(partial.playtest, "no");
});
