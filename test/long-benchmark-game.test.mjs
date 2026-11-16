// Offline self-test for the long-benchmark game task
// (test/manual-long-benchmark-game*.mjs and the runner's --task game). No
// model and no remote service. The checker session protocol runs against a
// scripted session bootstrap everywhere. Two parts need tools that CI does not
// have and are skipped there with the reason shown: the real PLAN-04 checker
// from a stack checkout (LONG_BENCHMARK_ACCEPTANCE_CHECKER), whose session is
// then driven through the agent's real routes, and an evaluator browser
// (LONG_BENCHMARK_GAME_BROWSER). The browser container workflow plays the
// reference and the known-bug mutants in the real container.
import assert from "node:assert/strict";
import test from "node:test";
import { spawn, spawnSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { ownedProcesses } from "../dist/loopback.js";
import { createServer } from "node:http";
import {
  appendFile,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const temporary = await realpath(
  await mkdtemp(join(tmpdir(), "ow-game-test-")),
);
process.env.OPENWEBUI_ACP_HOME = join(temporary, "unused-state");
const activeRuns = new Set();
let retainScratch = false;
test.after(async () => {
  await Promise.all([...activeRuns]);
  if (retainScratch)
    console.error(`Retained cancelled game scratch: ${temporary}`);
  else await rm(temporary, { recursive: true, force: true });
});

// Node cancellation does not await an async test body. Join its finally blocks
// before the file-level hook can delete scratch used by runners and browsers.
function lifecycleTest(name, options, body) {
  test(name, options, (t) => {
    const cancelled = () => {
      retainScratch = true;
    };
    t.signal.addEventListener("abort", cancelled, { once: true });
    const running = body(t).finally(() => {
      t.signal.removeEventListener("abort", cancelled);
    });
    activeRuns.add(running);
    t.after(async () => {
      try {
        await running;
      } catch (error) {
        if (error !== t.signal.reason) throw error;
      } finally {
        activeRuns.delete(running);
      }
    });
    return running;
  });
}

const GAME = await import("./manual-long-benchmark-game.mjs");
const here = dirname(fileURLToPath(import.meta.url));
const checkout = dirname(here);
const CHECKER = process.env.LONG_BENCHMARK_ACCEPTANCE_CHECKER;
const BROWSER = process.env.LONG_BENCHMARK_GAME_BROWSER;
// An absolute directory that receives each enabled run's results (optional).
const EVIDENCE = process.env.LONG_BENCHMARK_GAME_EVIDENCE;
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
    foreignPort: 4999,
    node: "/usr/bin/node",
  });
  const ids = plan.map((p) => p.id);
  assert.equal(new Set(ids).size, ids.length);
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
    "command-network-curl",
    "command-network-node",
    "server-task",
    "browser-preview",
    "browser-control",
    "browser-link",
    "browser-tab-link-select",
    "browser-window",
    "browser-redirect-look",
    "browser-back-look",
    "browser-navigate-file",
    "browser-new-tab-file",
    "browser-foreign-preview",
    "browser-foreign-control",
    "browser-playable",
    "browser-foreign-link-look",
    "browser-foreign-back-look",
    "browser-foreign-forward-look",
    "browser-foreign-location-look",
    "browser-foreign-tab-link-select",
    "browser-foreign-tab-link-look",
    "browser-foreign-window-look",
    "browser-foreign-redirect-look",
    "browser-foreign-embed-look",
    "browser-navigate-foreign",
    "browser-new-tab-foreign",
  ])
    assert(ids.includes(id), id);
  assert.equal(
    plan.find((p) => p.id === "read-relative").args.path,
    "../acceptance/playthrough.json",
  );
  // An agent turn ends after 64 tool calls, and a preview and a browser
  // session live for one turn: each group of probes fits one turn.
  assert.deepEqual([...new Set(plan.map((p) => p.turn ?? 0))], [0, 1, 2]);
  for (const turn of [0, 1, 2]) {
    const calls = plan.filter((p) => p.tool && (p.turn ?? 0) === turn);
    assert(calls.length > 0 && calls.length <= 60, `turn ${turn}`);
  }
  // The other network routes aim at the foreign origin on this host.
  const step = (id) => plan.find((p) => p.id === id);
  assert.match(
    step("command-network-curl").args.args[1],
    /^curl .*'http:\/\/127\.0\.0\.1:4999\/command-curl'$/,
  );
  assert.deepEqual(
    [
      step("command-network-node").args.executable,
      step("command-network-node").args.args.at(-1),
    ],
    ["/usr/bin/node", "http://127.0.0.1:4999/command-node"],
  );
  assert.equal(step("server-task").tool, "openwebui_task");
  assert.deepEqual(step("server-task").args.features, ["web_search"]);
  // The second turn's pages name the foreign origin as the browser that read
  // the first preview names this host; without that reading, nothing runs.
  const page = step("browser-write-foreign-control.html");
  assert.equal(page.next("", {}), null);
  for (const [form, host] of [
    ["host", "127.0.0.1"],
    ["container", "host.docker.internal"],
  ]) {
    const written = Object.fromEntries(
      plan
        .filter((p) => p.id.startsWith("browser-write-foreign-"))
        .map((p) => {
          const { path, content } = p.next("", { form });
          return [path, content];
        }),
    );
    assert.deepEqual(Object.keys(written), [
      "foreign-control.html",
      "foreign-control.js",
      "foreign-redirect.html",
      "foreign-redirect.js",
      "foreign-embed.html",
      "foreign-embed.js",
    ]);
    const origin = `http://${host}:4999`;
    for (const [file, route] of [
      ["foreign-control.html", `<a href="${origin}/link">foreign link</a>`],
      ["foreign-control.html", `target="_blank" href="${origin}/tab"`],
      ["foreign-control.js", `window.open("${origin}/window")`],
      ["foreign-control.js", `location.href = "${origin}/location"`],
      ["foreign-control.js", "history.forward()"],
      ["foreign-control.js", '"played-nonce-1"'],
      ["foreign-redirect.html", `content="0;url=${origin}/meta"`],
      ["foreign-redirect.js", `location.replace("${origin}/replace")`],
      ["foreign-embed.html", `<iframe src="${origin}/frame">`],
      ["foreign-embed.html", `<script src="${origin}/script">`],
      ["foreign-embed.js", `fetch("${origin}/fetch")`],
      ["foreign-embed.js", `new WebSocket("ws://${host}:4999/socket")`],
    ])
      assert(written[file].includes(route), `${form}: ${route}`);
    // The second preview is opened under the same form of host name.
    const preview = JSON.stringify({
      url: "http://127.0.0.1:4200/foreign-control.html",
      containerUrl: "http://host.docker.internal:4200/foreign-control.html",
    });
    assert.deepEqual(step("browser-foreign-open").next(preview, { form }), {
      url: `http://${host}:4200/foreign-control.html`,
    });
  }
  assert.equal(step("browser-foreign-open").next("{}", {}), null);
  assert.equal(
    step("browser-navigate-foreign").args.url,
    "http://127.0.0.1:4999/navigate",
  );
  assert.deepEqual(step("browser-new-tab-foreign").args, {
    action: "new",
    url: "http://host.docker.internal:4999/new-tab",
  });
  // Controls work, denials are refused, page attempts run, page reads show
  // no hidden content, and the host preview showed the nonce.
  const good = Object.fromEntries(
    plan
      .filter((p) => p.kind !== "browser-control")
      .map((p) => [
        p.id,
        p.optional
          ? { skipped: true }
          : p.kind === "control"
            ? { ok: true, text: "nonce-1" }
            : p.kind === "deny"
              ? { ok: false, text: `refused ${JSON.stringify(p.args)}` }
              : ["browser-look-host", "browser-foreign-look"].includes(p.id)
                ? { ok: true, text: '- paragraph: nonce-1\n- link "file link"' }
                : p.id === "browser-play-look"
                  ? { ok: true, text: "- status: played-nonce-1" }
                  : { ok: true, text: "- paragraph: page" },
      ]),
  );
  const after = {
    marker: "MARKER",
    nonce: "nonce-1",
    sealUnchanged: true,
    created: [],
    repoUnchanged: true,
    foreign: { marker: "FOREIGN-TEXT", served: true, reached: 0 },
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
  delete missing["browser-navigate-file"];
  assert.deepEqual(GAME.judgeProbes(plan, missing, after).findings, [
    "browser-navigate-file: not executed",
  ]);
  // The browser route: each failure leaves isolation unproven.
  for (const [change, finding] of [
    [
      { "browser-tab-link-look": { ok: true, text: "{ MARKER }" } },
      "browser-tab-link-look: revealed hidden content",
    ],
    [
      { "browser-look-host": { ok: true, text: "- paragraph: error page" } },
      "browser-control: the browser did not read the workspace preview, so a denial proves nothing",
    ],
    [
      { "browser-redirect-look": { ok: false, text: "No open pages" } },
      "browser-redirect-look: the browser state could not be read",
    ],
    [
      { "browser-window-look": { skipped: true } },
      "browser-window-look: not executed",
    ],
    // A policy that let a tab open at the hidden file.
    [
      {
        "browser-new-tab-file": {
          ok: true,
          text: "- 1: (current) [](file:///x)",
        },
      },
      "browser-new-tab-file: succeeded",
    ],
    // The foreign origin: a page that shows its marker, in the tab or in a
    // popup; a control page that the second preview did not show; a page
    // that no longer responds to a click; a policy that let the browser or a
    // command go there; a server task that ran.
    [
      {
        "browser-foreign-link-look": {
          ok: true,
          text: "- paragraph: FOREIGN-TEXT",
        },
      },
      "browser-foreign-link-look: read the foreign origin",
    ],
    [
      {
        "browser-foreign-window-look": { ok: true, text: "FOREIGN-TEXT" },
      },
      "browser-foreign-window-look: read the foreign origin",
    ],
    [
      { "browser-foreign-look": { ok: true, text: "- paragraph: blocked" } },
      "browser-foreign-control: the browser did not read the workspace preview, so a denial proves nothing",
    ],
    [
      { "browser-play-look": { ok: true, text: "- paragraph: nonce-1" } },
      "browser-playable: the browser did not operate the workspace preview, so a denial proves nothing",
    ],
    [
      { "browser-foreign-forward-look": { skipped: true } },
      "browser-foreign-forward-look: not executed",
    ],
    [
      { "browser-navigate-foreign": { ok: true, text: "- Page URL: x" } },
      "browser-navigate-foreign: succeeded",
    ],
    [
      { "command-network-curl": { ok: true, text: '{"code":0}' } },
      "command-network-curl: succeeded",
    ],
    [{ "server-task": { ok: true, text: "done" } }, "server-task: succeeded"],
  ])
    assert.deepEqual(
      GAME.judgeProbes(plan, { ...good, ...change }, after).findings,
      [finding],
    );
  // A command that was answered by the foreign origin failed twice over.
  assert.deepEqual(
    GAME.judgeProbes(
      plan,
      {
        ...good,
        "command-network-node": { ok: true, text: "FOREIGN-TEXT" },
      },
      after,
    ).findings,
    [
      "command-network-node: succeeded",
      "command-network-node: read the foreign origin",
    ],
  );
  // What the foreign origin itself saw decides, whatever the results say: a
  // connection from anything but the harness, or no proof that it served.
  assert.deepEqual(
    GAME.judgeProbes(plan, good, {
      ...after,
      foreign: { ...after.foreign, reached: 2 },
    }).findings,
    ["the foreign origin was reached (connections: 2)"],
  );
  assert.deepEqual(
    GAME.judgeProbes(plan, good, {
      ...after,
      foreign: { ...after.foreign, served: false },
    }).findings,
    [
      "foreign-origin-control: the foreign origin did not serve its marker to the harness, so a denial proves nothing",
    ],
  );
  // A browser in a container reads the preview through containerUrl.
  const container = {
    ...good,
    "browser-look-host": { ok: true, text: "chrome-error" },
    "browser-open-container": { ok: true, text: "" },
    "browser-look-container": { ok: true, text: "nonce-1" },
  };
  assert.equal(GAME.judgeProbes(plan, container, after).established, true);
  // Snapshots may show a link's URL; only content is a leak there.
  const echoed = {
    ...good,
    "browser-link-look-control": {
      ok: true,
      text: '- link "file link": /url: file:///scratch/acceptance/playthrough.json',
    },
  };
  assert.equal(GAME.judgeProbes(plan, echoed, after).established, true);
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

test("command control markers survive proxy-credential prefix redaction", async () => {
  const nonce = "control-marker";
  const workspace = await mkdtemp(join(temporary, "redaction-control-"));
  const plan = GAME.probePlan({
    workspace,
    acceptance: join(temporary, "acceptance"),
    hidden: join(temporary, "acceptance/playthrough.json"),
    repoHidden: [],
    nonce,
    browser: false,
  });
  const ending = plan
    .find((probe) => probe.id === "control-write")
    .args.content.slice(nonce.length);
  const { sandboxCommand } = await import("../dist/sandbox.js");
  // Force the collision with the runtime's synthetic proxy credential. Never
  // print that credential: assertions below expose only booleans on failure.
  const result = JSON.parse(
    await sandboxCommand(
      process.execPath,
      [
        "-e",
        `const prefix = new URL(process.env.HTTP_PROXY).password[0];
         process.stdout.write("control-marker-" + prefix + ${JSON.stringify(ending)});`,
      ],
      { mode: "workspace", root: workspace, network: async () => false },
      AbortSignal.timeout(20000),
    ),
  );
  assert.equal(result.code, 0);
  assert.equal(
    /^control-marker-[0-9a-f]\n$/.test(result.output),
    true,
    "the complete control marker must survive prefix redaction",
  );
});

// ---- PLAN-04 checker session ---------------------------------------------
// A checker tree in `directory`: task_acceptance.py plus `extra` files.
async function checkerTree(name, extra = {}) {
  const directory = await mkdtemp(join(temporary, `${name}-`));
  await writeFile(join(directory, "task_acceptance.py"), "# checker\n");
  for (const [file, text] of Object.entries(extra))
    await writeFile(join(directory, file), text);
  return join(directory, "task_acceptance.py");
}

test("a checker without the supported session protocol is refused", async () => {
  // Before stack PR #243: no session bootstrap at all.
  const stale = await GAME.checkerIdentity(await checkerTree("stale"));
  assert.match(
    stale.unavailable,
    /^LONG_BENCHMARK_ACCEPTANCE_CHECKER: the checker has no task_acceptance_session\.py; it predates the PLAN-04 session protocol/,
  );
  // A different bootstrap is a different protocol.
  const changed = await GAME.checkerIdentity(
    await checkerTree("changed", {
      "task_acceptance_session.py": "# another protocol\n",
    }),
  );
  assert.match(
    changed.unavailable,
    /task_acceptance_session\.py has SHA-256 [0-9a-f]{64}, not the session protocol that this harness implements \(619316431b1f…, stack 7c2ff06\)/,
  );
  for (const bad of ["", "relative/task_acceptance.py", "/abs/other.py"])
    assert.match(
      (await GAME.checkerIdentity(bad)).unavailable,
      /not an absolute path to task_acceptance\.py/,
    );
});

test("only the pinned complete checker manifest is accepted", () => {
  // A manifest with the pinned bootstrap and modules but another module set:
  // the bootstrap alone never admits a checker.
  const pinned = {
    [GAME.CHECKER_SESSION.file]: GAME.CHECKER_SESSION.sha256,
    ...GAME.CHECKER_MANIFEST.modules,
  };
  const other = GAME.manifestMismatch({
    ...pinned,
    "coding_eval.py": "0".repeat(64),
  });
  assert.match(
    other,
    /^the checker manifest \(4 files, SHA-256 [0-9a-f]{64}\) is not the pinned checker \(58 files, c85163f80abe…, stack 59eac79\)$/,
  );
  // A changed decision or record module is named.
  const changed = GAME.manifestMismatch({
    ...pinned,
    "run_record.py": "1".repeat(64),
  });
  assert.match(changed, /; differing: run_record\.py\)/);
  assert.match(
    GAME.manifestMismatch({ ...pinned, "task_acceptance.py": "2".repeat(64) }),
    /; differing: task_acceptance\.py\)/,
  );
  assert.equal(GAME.CHECKER_MANIFEST.files, 58);
  assert.equal(
    GAME.CHECKER_MANIFEST.modules["task_acceptance.py"],
    "4e48e1516f050d8e4382b74e02038cc23aa8783be29e80110773978ef4ba4212",
  );
});

test(
  "the configured checker is the pinned complete manifest",
  { skip: !CHECKER && "LONG_BENCHMARK_ACCEPTANCE_CHECKER is not set" },
  async () => {
    const checker = await GAME.checkerIdentity(CHECKER);
    assert.equal(checker.unavailable, undefined, checker.unavailable);
    assert.equal(checker.treeSha256, GAME.CHECKER_MANIFEST.sha256);
    assert.equal(Object.keys(checker.files).length, 58);
    assert.equal(GAME.manifestMismatch(checker.files), null);
  },
);

test("checker probes go through the agent's real file tools and command sandbox", async () => {
  const root = await realpath(await mkdtemp(join(temporary, "routes-")));
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  await writeFile(join(workspace, "control"), "acceptance control\n");
  const outside = join(root, "evaluator");
  await mkdir(outside);
  await writeFile(join(outside, "pin.json"), "{}\n");
  // Sacrificial directories as the checker makes them: one per operation.
  const owned = async (parent, name) => {
    await mkdir(join(parent, name));
    await writeFile(join(parent, name, "entry"), "owned\n");
    return join(parent, name);
  };
  const agent = await GAME.startRouteAgent({
    agentDirectory: checkout,
    workspace,
    state: join(root, "state"),
  });
  const seen = {};
  try {
    for (const route of GAME.ROUTES)
      for (const [where, parent, file] of [
        ["workspace", workspace, join(workspace, "control")],
        ["outside", outside, join(outside, "pin.json")],
      ])
        for (const operation of ["read", "write", "create", "rename", "unlink"])
          seen[`${route} ${operation} ${where}`] = await agent.probe(
            route,
            operation,
            ["read", "write"].includes(operation)
              ? file
              : await owned(parent, `${route}-${operation}`),
          );
  } finally {
    await agent.close();
  }
  const expected = {};
  for (const operation of ["read", "write", "create", "rename", "unlink"]) {
    const files = ["read", "write", "create"].includes(operation);
    expected[`agent-file-tools ${operation} workspace`] = files
      ? "allowed"
      : "unsupported";
    expected[`agent-file-tools ${operation} outside`] = files
      ? "denied"
      : "unsupported";
    expected[`agent-sandboxed-commands ${operation} workspace`] = "allowed";
    expected[`agent-sandboxed-commands ${operation} outside`] = "denied";
  }
  assert.deepEqual(seen, expected);
  // Read and write probes changed no bytes; outside, nothing changed at all.
  assert.equal(
    await readFile(join(workspace, "control"), "utf8"),
    "acceptance control\n",
  );
  assert.deepEqual((await readdir(outside)).sort(), [
    "agent-file-tools-create",
    "agent-file-tools-rename",
    "agent-file-tools-unlink",
    "agent-sandboxed-commands-create",
    "agent-sandboxed-commands-rename",
    "agent-sandboxed-commands-unlink",
    "pin.json",
  ]);
  for (const name of await readdir(outside))
    if (name !== "pin.json")
      assert.deepEqual(await readdir(join(outside, name)), ["entry"]);
  // In the workspace each allowed mutation happened, and nothing else.
  assert.deepEqual((await readdir(workspace)).sort(), [
    "agent-file-tools-create",
    "agent-file-tools-rename",
    "agent-file-tools-unlink",
    "agent-sandboxed-commands-create",
    "agent-sandboxed-commands-rename.moved",
    "agent-sandboxed-commands-unlink",
    "control",
  ]);
});

test("probe outcomes: refusals are denials, other failures are unavailable", () => {
  const command = (output, code = 0, ok = true) => ({
    ok,
    text: JSON.stringify({ code, output, limitedOrCancelled: false }),
  });
  const outcome = (result, operation = "write") =>
    GAME.routeOutcome("agent-sandboxed-commands", operation, result);
  assert.equal(outcome(command("probe-allowed\n")), "allowed");
  for (const refusal of [
    "probe: /x/pin.json: Operation not permitted", // macOS sandbox
    "cat: /x/pin.json: No such file or directory", // GNU
    "sh: 1: cannot create /x/pin.json: Directory nonexistent", // dash
    "sh: 1: cannot open /x/pin.json: No such file", // dash
    "mkdir: cannot create directory '/x/created': Permission denied",
    "mv: cannot move '/x' to '/x.moved': Read-only file system",
  ])
    assert.equal(outcome(command(`${refusal}\nprobe-failed\n`)), "denied");
  // A failure that is not a refusal, or a command that did not run.
  assert.equal(
    outcome(
      command("mkdir: cannot create directory: File exists\nprobe-failed\n"),
    ),
    "unavailable",
  );
  // A path or label that merely contains refusal words is not a refusal.
  assert.equal(
    outcome(
      command(
        "mkdir: cannot create directory '/x/Permission denied/created': File exists\nprobe-failed\n",
      ),
    ),
    "unavailable",
  );
  assert.equal(outcome(command("", 1, false)), "unavailable");
  assert.equal(
    outcome({ ok: false, text: "Sandbox failed to start" }),
    "unavailable",
  );
  const file = (ok, text, operation) =>
    GAME.routeOutcome("agent-file-tools", operation, { ok, text });
  assert.equal(file(true, "1→x", "read"), "allowed");
  assert.equal(
    file(
      false,
      "old_string matched 0 occurrences; expected at least 1.",
      "write",
    ),
    "allowed",
  );
  assert.equal(
    file(false, "Path outside permitted scope or sensitive", "read"),
    "denied",
  );
  assert.equal(file(false, "Tool call limit exceeded", "read"), "unavailable");
  assert.equal(GAME.routeCall("agent-file-tools", "rename", "/x", "n"), null);
});

// A scripted session bootstrap that speaks the protocol: probes through each
// declared route, one probe with an unknown route and one with another lease,
// then echoes what the parent sent.
const SCRIPTED_SESSION = `import json, sys
def receive():
    return json.loads(sys.stdin.readline())
def send(value):
    print(json.dumps(value), flush=True)
start = receive()
lease = start["capability_lease"]
if start.get("behaviour") == "refuse":
    print("session unavailable: checker tree does not match the parent-held immutable pin", file=sys.stderr)
    raise SystemExit(3)
outcomes = []
for route, path, held in [(r, start["workspace"], lease) for r in start["routes"]] + [
        ("unknown-route", start["workspace"], lease), (start["routes"][0], start["workspace"], "another")]:
    send({"probe": "read", "path": path, "route": route, "capability_lease": held})
    outcomes.append(receive())
send({"ready": start.get("behaviour") != "not-ready", "protection": {"status": "passed", "probes": [{"status": "passed"}]}, "capability_lease": lease})
final = receive()
send({"probe": "unlink", "path": start["source"], "route": start["routes"][1], "capability_lease": lease})
outcomes.append(receive())
send({"result": {"final": final, "outcomes": outcomes, "start": start}})
`;

test("the parent speaks the session protocol over private pipes (scripted session)", async () => {
  const directory = await scriptedChecker("scripted-session", SCRIPTED_SESSION);
  const start = (behaviour) => ({
    source: "/evaluator/source",
    workspace: "/evaluator/workspace",
    seal: GAME.GAME_SEAL,
    checker: {},
    configuration: [],
    routes: GAME.ROUTES,
    capability_lease: "lease-fixed",
    behaviour,
  });
  const calls = [];
  const route = async (name, operation, path) => {
    calls.push([name, operation, path]);
    return operation === "read" ? "allowed" : "denied";
  };
  const session = GAME.openCheckerSession({ directory, start: start() });
  const begun = await session.begin(route);
  assert.deepEqual(begun, {
    ready: true,
    protection: { status: "passed", probes: [{ status: "passed" }] },
  });
  const done = await session.finish({ observation: { complete: true } }, route);
  assert.equal(done.exitCode, 0);
  // The parent probed only declared routes under its own lease.
  assert.deepEqual(calls, [
    ["agent-file-tools", "read", "/evaluator/workspace"],
    ["agent-sandboxed-commands", "read", "/evaluator/workspace"],
    ["agent-sandboxed-commands", "unlink", "/evaluator/source"],
  ]);
  assert.deepEqual(
    done.result.outcomes.map((o) => o.outcome),
    ["allowed", "allowed", "unavailable", "unavailable", "denied"],
  );
  for (const o of done.result.outcomes)
    assert.equal(o.capability_lease, "lease-fixed");
  assert.deepEqual(done.result.final, {
    observation: { complete: true },
    capability_lease: "lease-fixed",
  });
  assert.equal(session.probes, 5);
  // Not ready: the parent must not enable the agent.
  const waiting = GAME.openCheckerSession({
    directory,
    start: start("not-ready"),
  });
  assert.equal((await waiting.begin(route)).ready, false);
  waiting.close();
  // A session that stops gives its reason, not a verdict.
  const refused = await GAME.openCheckerSession({
    directory,
    start: start("refuse"),
  }).begin(route);
  assert.equal(refused.ready, false);
  assert.match(
    refused.reason,
    /status 3: session unavailable: checker tree does not match/,
  );
});

// ---- Capability lease (scripted sessions through beginAcceptance) ---------
async function scriptedChecker(name, script) {
  const directory = await mkdtemp(join(temporary, `${name}-`));
  await writeFile(join(directory, "task_acceptance_session.py"), script);
  return directory;
}
// One read probe of the brief through the real file tools, then ready; after
// the final message one more probe, then the final message echoed back.
// `dirty` writes into the workspace during setup, as a misbehaving probe would.
const LEASE_SESSION = (dirty) => `import json, os, sys
def receive():
    return json.loads(sys.stdin.readline())
def send(value):
    print(json.dumps(value), flush=True)
start = receive()
lease = start["capability_lease"]
probe = {"probe": "read", "path": os.path.join(start["workspace"], "BRIEF.md"),
         "route": "agent-file-tools", "capability_lease": lease}
send(probe)
setup = receive()["outcome"]
${dirty ? 'open(os.path.join(start["workspace"], "left-behind"), "w").close()' : ""}
send({"ready": setup == "allowed", "protection": {"status": "passed"}, "capability_lease": lease})
final = receive()
send(probe)
send({"result": {"final": final, "setup": setup, "after": receive()["outcome"]}})
`;
async function leaseSetup(name, script) {
  const root = await realpath(await mkdtemp(join(temporary, `${name}-`)));
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  await writeFile(join(workspace, "BRIEF.md"), "brief\n");
  const configuration = [join(root, "config.json")];
  await writeFile(configuration[0], '{"model":"fixture"}');
  return {
    root,
    workspace,
    configuration,
    acceptance: join(root, "acceptance"),
    checker: { installed: await scriptedChecker(name, script), files: {} },
    agentDirectory: checkout,
    scratch: root,
    runId: name,
  };
}

test("the lease goes to the checker only while the capability policy is unchanged", async () => {
  // Unchanged: the final message carries the lease and the observation.
  const kept = await leaseSetup("lease-kept", LEASE_SESSION(false));
  const attempt = await GAME.beginAcceptance(kept);
  assert.equal(attempt.ready, true, attempt.reason);
  assert.deepEqual(attempt.record.unprobedRoutes, GAME.UNPROBED_ROUTES);
  const output = join(kept.root, "result.json");
  assert.deepEqual(
    await attempt.finish({ observation: { complete: true }, output }),
    { exitCode: 0 },
  );
  const echoed = JSON.parse(await readFile(output, "utf8"));
  assert.deepEqual(echoed.final.observation, { complete: true });
  assert.match(echoed.final.capability_lease, /^lease-/);
  assert.equal(echoed.setup, "allowed");
  assert.equal(echoed.after, "allowed");
  // Configuration changed during the attempt: no lease, no result.
  const changed = await leaseSetup("lease-changed", LEASE_SESSION(false));
  const second = await GAME.beginAcceptance(changed);
  assert.equal(second.ready, true, second.reason);
  await writeFile(changed.configuration[0], '{"model":"other"}');
  const refused = join(changed.root, "result.json");
  assert.deepEqual(await second.finish({ observation: {}, output: refused }), {
    unavailable: "the agent's capability policy changed during the attempt",
  });
  await assert.rejects(readFile(refused));
});

test("a workspace changed during the setup probes never starts the attempt", async () => {
  const setup = await leaseSetup("lease-dirty", LEASE_SESSION(true));
  const attempt = await GAME.beginAcceptance(setup);
  assert.equal(attempt.ready, false);
  assert.equal(attempt.reason, "the workspace changed during the setup probes");
  assert.equal(attempt.record.ready, false);
});

test("the capability policy covers build, dependencies, package files and configuration", async () => {
  const agent = await mkdtemp(join(temporary, "policy-agent-"));
  for (const dir of ["dist", "node_modules/pkg"])
    await mkdir(join(agent, dir), { recursive: true });
  await writeFile(join(agent, "dist/agent.js"), "agent");
  // Over the 2 MiB limit of the source reader: still hashed by content.
  const large = 3 * 1024 * 1024;
  await writeFile(join(agent, "dist/large.js"), Buffer.alloc(large));
  await writeFile(join(agent, "node_modules/pkg/index.js"), "pkg");
  await symlink("index.js", join(agent, "node_modules/pkg/link.js"));
  await writeFile(join(agent, "package.json"), "{}");
  await writeFile(join(agent, "package-lock.json"), "{}");
  const config = join(agent, "config.json");
  await writeFile(config, "{}");
  const policy = () => GAME.capabilityPolicy(agent, [config]);
  assert.equal(await policy(), await policy());
  for (const [name, change] of [
    ["dist/agent.js", () => writeFile(join(agent, "dist/agent.js"), "agent2")],
    [
      "dist/large.js",
      () =>
        writeFile(
          join(agent, "dist/large.js"),
          Buffer.concat([Buffer.alloc(large - 1), Buffer.from("x")]),
        ),
    ],
    [
      "node_modules/pkg/index.js",
      () => writeFile(join(agent, "node_modules/pkg/index.js"), "pkg2"),
    ],
    [
      "node_modules/pkg/link.js",
      async () => {
        await rm(join(agent, "node_modules/pkg/link.js"));
        await symlink("other.js", join(agent, "node_modules/pkg/link.js"));
      },
    ],
    ["package.json", () => writeFile(join(agent, "package.json"), "[]")],
    [
      "package-lock.json",
      () => writeFile(join(agent, "package-lock.json"), "[]"),
    ],
    ["config.json", () => writeFile(config, "[]")],
  ]) {
    const before = await policy();
    await change();
    assert.notEqual(await policy(), before, name);
  }
});

// Builds a game attempt for the real checker: the copied source, the
// fixture workspace, the agent's configuration and the installed checker.
async function attemptSetup(name) {
  const root = await realpath(await mkdtemp(join(temporary, `${name}-`)));
  const acceptance = join(root, "acceptance"),
    workspace = join(root, "workspace"),
    state = join(root, "state");
  await GAME.copySource(source, acceptance);
  await mkdir(workspace, { mode: 0o700 });
  await mkdir(state, { mode: 0o700 });
  await GAME.writeFixture(source, workspace);
  const configuration = [join(state, "config.json"), join(state, "mcp.json")];
  await writeFile(
    configuration[0],
    JSON.stringify({ url: "http://127.0.0.1:9", model: "fixture" }),
    { mode: 0o600 },
  );
  await writeFile(configuration[1], "[]", { mode: 0o600 });
  const checker = await GAME.checkerIdentity(CHECKER);
  assert.equal(checker.unavailable, undefined, checker.unavailable);
  checker.installed = await GAME.installChecker(checker, join(root, "checker"));
  return { root, acceptance, workspace, configuration, checker };
}

test(
  "the real checker accepts or rejects an attempt only through its session",
  {
    timeout: 1800000,
    skip: !CHECKER && "LONG_BENCHMARK_ACCEPTANCE_CHECKER is not set",
  },
  async () => {
    for (const [game, verdict] of [
      ["reference", "accepted"],
      ["no-lock", "rejected"],
    ]) {
      const setup = await attemptSetup(`attempt-${game}`);
      const attempt = await GAME.beginAcceptance({
        ...setup,
        agentDirectory: checkout,
        scratch: setup.root,
        runId: `self-test-${game}`,
      });
      try {
        assert.equal(attempt.ready, true, attempt.reason);
        assert.equal(attempt.record.protection.status, "passed");
        assert(attempt.record.setupProbes > 0);
        // The attempt: the agent's deliverable, then the evaluator's fresh
        // observation of it (the browser play-through, simulated here).
        const html = source.games[game]["index.html"];
        await writeFile(join(setup.workspace, "index.html"), html);
        const output = join(setup.root, "acceptance-result.json");
        const done = await attempt.finish({
          observation: {
            complete: true,
            entry_sha256: GAME.sha256(html),
            ...GAME.judge(script, simulate(game)),
          },
          output,
        });
        assert.equal(done.unavailable, undefined, done.unavailable);
        assert.equal(done.exitCode, verdict === "accepted" ? 0 : 1);
        assert(attempt.record.finalProbes > 0);
        const hidden = await GAME.summarizeResult({
          checker: join(setup.checker.installed, "task_acceptance.py"),
          output,
        });
        assert.equal(hidden.verdict, verdict, JSON.stringify(hidden));
        assert.equal(hidden.validatedVerdict, verdict);
        assert.equal(hidden.components.protection, "passed");
        assert.equal(hidden.sealSha256, GAME.GAME_SEAL);
        assert.equal(hidden.checkerTreeSha256, setup.checker.treeSha256);
        assert.deepEqual(
          hidden.reasons,
          verdict === "accepted" ? [] : ["external_state:solved-locked"],
        );
        if (game !== "reference") continue;
        // What the harness did before the session protocol: a one-shot check
        // after the attempt. The checker can never accept that.
        const state = join(setup.root, "observation.json");
        await writeFile(
          state,
          JSON.stringify({
            complete: true,
            entry_sha256: GAME.sha256(html),
            ...GAME.judge(script, simulate(game)),
          }),
        );
        const oneShot = spawnSync(
          "python3",
          [
            "-E",
            "-s",
            "-B",
            join(setup.checker.installed, "task_acceptance.py"),
            "check",
            setup.acceptance,
            join(setup.root, "one-shot.json"),
            "--workspace",
            setup.workspace,
            "--seal",
            GAME.GAME_SEAL,
            "--state",
            state,
          ],
          { encoding: "utf8" },
        );
        assert.equal(oneShot.status, 3, oneShot.stderr);
        const result = JSON.parse(
          await readFile(join(setup.root, "one-shot.json"), "utf8"),
        );
        assert.equal(result.verdict, "unavailable");
        assert(
          result.reasons.includes(
            "protection:attempt-lifetime-not-established",
          ),
        );
      } finally {
        attempt.close();
      }
    }
  },
);

test(
  "a checker changed after it was pinned never establishes the attempt",
  {
    timeout: 120000,
    skip: !CHECKER && "LONG_BENCHMARK_ACCEPTANCE_CHECKER is not set",
  },
  async () => {
    const setup = await attemptSetup("attempt-swapped");
    await appendFile(
      join(setup.checker.installed, "coding_eval.py"),
      "\n# swapped\n",
    );
    const attempt = await GAME.beginAcceptance({
      ...setup,
      agentDirectory: checkout,
      scratch: setup.root,
      runId: "self-test-swapped",
    });
    assert.equal(attempt.ready, false);
    assert.match(
      attempt.reason,
      /checker tree does not match the parent-held immutable pin/,
    );
  },
);

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
// Each runner leads a private group. Snapshot descendants as well because ACP
// commands can lead their own groups. Never select by executable name.
function processTable() {
  const result = spawnSync(
    "ps",
    ["-A", "-o", "pid=", "-o", "ppid=", "-o", "pgid=", "-o", "stat="],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  return result.stdout
    .trim()
    .split("\n")
    .map((line) => {
      const [pid, ppid, pgid, stat] = line.trim().split(/\s+/);
      return { pid: Number(pid), ppid: Number(ppid), pgid: Number(pgid), stat };
    });
}
async function stopRunner(child) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null)
    return;
  if (process.platform === "win32") {
    const result = spawnSync("taskkill", [
      "/pid",
      String(child.pid),
      "/T",
      "/F",
    ]);
    assert.equal(result.status, 0, "owned runner taskkill failed");
    return;
  }
  const signal = (pid, name) => {
    try {
      process.kill(pid, name);
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
  };
  // Freeze each discovered descendant before taking the next snapshot so it
  // cannot spawn more work while the tree is being stopped.
  const owned = new Set([child.pid]);
  signal(child.pid, "SIGSTOP");
  for (;;) {
    const found = ownedProcesses(processTable(), [...owned]);
    const added = [...found].filter((pid) => !owned.has(pid));
    for (const pid of added) {
      signal(pid, "SIGSTOP");
      owned.add(pid);
    }
    if (!added.length) break;
  }
  for (const pid of [...owned].reverse()) signal(pid, "SIGKILL");
  const deadline = Date.now() + 10000;
  while (
    processTable().some((p) => owned.has(p.pid) && !p.stat.startsWith("Z"))
  ) {
    assert(
      Date.now() < deadline,
      "owned runner tree did not stop; retain scratch",
    );
    await delay(25);
  }
}
async function ownedRunner(args, env, signal) {
  signal.throwIfAborted();
  const child = spawn(process.execPath, args, {
    env,
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "",
    stderr = "",
    stopping;
  child.stdout.on("data", (d) => (stdout += d));
  child.stderr.on("data", (d) => (stderr += d));
  const closed = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
  let rejectStopped;
  const stopped = new Promise((_, reject) => {
    rejectStopped = reject;
  });
  const abort = () => {
    stopping ??= stopRunner(child).then(async () => {
      let timer;
      try {
        await Promise.race([
          closed,
          new Promise((_, reject) => {
            timer = setTimeout(
              () => reject(new Error("owned runner pipes did not close")),
              10000,
            );
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
      throw signal.reason;
    });
    stopping.catch(rejectStopped);
  };
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  try {
    const result = await Promise.race([closed, stopped]);
    await stopping;
    signal.throwIfAborted();
    return result;
  } finally {
    signal.removeEventListener("abort", abort);
  }
}
function runner(label, env, signal) {
  return ownedRunner(
    [
      join(here, "manual-long-benchmark.mjs"),
      "--live",
      checkout,
      label,
      "5",
      "--task",
      "game",
    ],
    env,
    signal,
  );
}

lifecycleTest(
  "cancellation stops the owned runner tree before scratch cleanup",
  { timeout: 20000 },
  async (t) => {
    const scratch = await mkdtemp(join(temporary, "cancel-"));
    const marker = join(scratch, "child.pid");
    const controller = new AbortController();
    const descendant = `require('node:fs').writeFileSync(${JSON.stringify(marker)}, String(process.pid));setInterval(()=>{},1000)`;
    const code = `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{detached:true,stdio:'inherit'});setInterval(()=>{},1000)`;
    const running = ownedRunner(
      ["-e", code],
      { PATH: process.env.PATH },
      AbortSignal.any([controller.signal, t.signal]),
    );
    const rejected = assert.rejects(running, { name: "AbortError" });
    try {
      let pid;
      while (!pid) {
        try {
          pid = Number(await readFile(marker, "utf8"));
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
        }
        await delay(25);
        t.signal.throwIfAborted();
      }
      controller.abort();
      await rejected;
      if (process.platform !== "win32")
        assert(
          !processTable().some((p) => p.pid === pid && !p.stat.startsWith("Z")),
        );
      else assert.throws(() => process.kill(pid, 0));
      await rm(scratch, { recursive: true });
    } finally {
      controller.abort();
      await rejected;
    }
  },
);

lifecycleTest(
  "without an evaluator the runner proves isolation, then refuses to start",
  { timeout: 240000 },
  async (t) => {
    const results = join(temporary, "results-closed");
    const env = {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      OPENWEBUI_ACP_HOME: await userState("http://127.0.0.1:9"),
      LONG_BENCHMARK_RESULTS: results,
      // A checker from before the session protocol.
      LONG_BENCHMARK_ACCEPTANCE_CHECKER: await checkerTree("closed-checker"),
      TMPDIR: temporary,
    };
    const run = await runner("closed-1", env, t.signal);
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
        "LONG_BENCHMARK_ACCEPTANCE_CHECKER:",
        "LONG_BENCHMARK_GAME_BROWSER",
      ],
    );
    assert.match(
      report.preconditions[1],
      /predates the PLAN-04 session protocol/,
    );
    assert.equal(report.evaluator.session, undefined);
    // The probes ran through the real agent and sandbox on this platform.
    for (const [id, r] of Object.entries(report.isolation.results))
      assert.equal(r.ok, r.kind === "control", id);
    // The other routes to a network: a sandboxed command, directly and
    // through the sandbox proxy, and an Open WebUI server task. Each call
    // ran and failed, and the foreign origin, which had served its marker to
    // the harness, counted no connection.
    for (const id of [
      "command-network-curl",
      "command-network-node",
      "server-task",
    ])
      assert.equal(report.isolation.results[id].ok, false, id);
    assert.match(
      report.isolation.results["server-task"].reason,
      /Enable \/server-tools on first/,
    );
    assert.deepEqual(report.isolation.foreignOrigin, {
      served: true,
      reached: 0,
    });
    const text = await readFile(
      join(results, "closed-1", "report.json"),
      "utf8",
    );
    assert(!text.includes(script.marker));
    assert.doesNotMatch(text, /foreign-origin-[0-9a-f-]{36}/);
  },
);

lifecycleTest(
  "a browser without the confined endpoint never gets a session",
  { timeout: 240000 },
  async (t) => {
    // A browser wrapper from before the origin boundary: it serves /mcp and
    // nothing else. The agent is given only the confined endpoint, so it has
    // no browser, the controls fail and the run stops before a session.
    const requested = [];
    const older = createServer((req, res) => {
      requested.push(req.url);
      res.writeHead(req.url === "/mcp" ? 400 : 404).end();
    });
    await new Promise((r) => older.listen(0, "127.0.0.1", r));
    const results = join(temporary, "results-no-confined");
    try {
      const run = await runner(
        "no-confined-1",
        {
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          OPENWEBUI_ACP_HOME: await userState("http://127.0.0.1:9"),
          LONG_BENCHMARK_RESULTS: results,
          LONG_BENCHMARK_BROWSER_MCP_URL: `http://127.0.0.1:${older.address().port}/mcp`,
          TMPDIR: temporary,
        },
        t.signal,
      );
      assert.equal(run.code, 4, run.stderr);
      const report = JSON.parse(
        await readFile(join(results, "no-confined-1", "report.json"), "utf8"),
      );
      assert.equal(report.sessionId, undefined);
      assert.equal(report.requests, 0);
      assert.equal(report.isolation.established, false);
      // The first finding gives the agent's own reason.
      assert.match(
        report.isolation.findings[0],
        /^probe session failed: no probe ran; the agent said: MCP server 1 failed during transport connection or initialization/,
      );
      assert(
        report.isolation.findings.includes(
          "browser-control: the browser did not read the workspace preview, so a denial proves nothing",
        ),
        JSON.stringify(report.isolation.findings),
      );
      assert.match(
        report.preconditions.join("\n"),
        /isolation not established/,
      );
      // Only the confined endpoint was ever requested.
      assert(requested.length > 0);
      assert.deepEqual([...new Set(requested)], ["/mcp/confined"]);
    } finally {
      older.closeAllConnections();
      await new Promise((r) => older.close(r));
    }
  },
);

// ---- The real browser route ------------------------------------------------
// The repository's browser wrapper (browser/: its HTTP listener with Host and
// Origin checks, owned connection, fixed settings and the pinned
// @playwright/mcp tools) on host loopback. The only difference from the
// container is Chromium: the local executable from
// LONG_BENCHMARK_GAME_BROWSER=local:/abs/chromium, running on this host with
// access to host files - the worst case for the boundary.
const LOCAL_CHROMIUM = /^local:(\/.+)$/.exec(BROWSER ?? "")?.[1];
// `confine: false` gives the same wrapper without its origin boundary: its
// confined endpoint then opens ordinary sessions, as a browser that cannot
// establish the restriction would.
async function realBrowser({ confine = true } = {}) {
  const executable = LOCAL_CHROMIUM;
  const dir = join(checkout, "browser");
  const load = (name) => import(pathToFileURL(join(dir, name)).href);
  const resolveIn = createRequire(join(dir, "package.json")).resolve;
  const { startHttpServer } = await load("server.mjs");
  const { createOwnedConnection } = await load("connection.mjs");
  const { browserSettings } = await load("settings.mjs");
  // The resolved entries are CommonJS: named exports may sit on default.
  const mcp = await import(pathToFileURL(resolveIn("@playwright/mcp")).href);
  const createConnection = mcp.createConnection ?? mcp.default.createConnection;
  const pw = await import(pathToFileURL(resolveIn("playwright")).href);
  const chromium = pw.chromium ?? pw.default.chromium;
  const scratch = await mkdtemp(join(temporary, "browser-"));
  const settings = browserSettings(scratch, { PATH: process.env.PATH });
  settings.browser.launchOptions.executablePath = executable;
  const server = await startHttpServer({
    createConnection: ({ confined }) =>
      createOwnedConnection({
        createConnection,
        chromium,
        settings,
        confined: confine && confined,
      }),
    host: "127.0.0.1",
    port: 0,
  });
  return { url: server.url, close: server.close, previewKey: "url" };
}
const realBrowserSkip =
  !LOCAL_CHROMIUM &&
  "needs LONG_BENCHMARK_GAME_BROWSER=local:/abs/chromium and browser/node_modules";

lifecycleTest(
  "real browser route: with a host browser, no agent path reaches the hidden file",
  { timeout: 600000, skip: realBrowserSkip },
  async (t) => {
    const browser = await realBrowser();
    try {
      // The wrapper's own layer, without the harness policy: the pinned MCP
      // server refuses browser-initiated file: navigation, in place and in a
      // new tab, and the browser shows nothing of the file.
      const { Client } =
        await import("@modelcontextprotocol/sdk/client/index.js");
      const { StreamableHTTPClientTransport } =
        await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
      const owned = join(await mkdtemp(join(temporary, "owned-")), "x.json");
      const ownedMarker = `owned-marker-${process.pid}`;
      await writeFile(owned, JSON.stringify({ ownedMarker }));
      const client = new Client({ name: "boundary-check", version: "1" });
      await client.connect(
        new StreamableHTTPClientTransport(new URL(browser.url)),
      );
      try {
        const text = async (name, args) =>
          JSON.stringify(await client.callTool({ name, arguments: args }));
        const url = pathToFileURL(owned).href;
        for (const [name, args] of [
          ["browser_navigate", { url }],
          ["browser_tabs", { action: "new", url }],
        ]) {
          const refused = await text(name, args);
          assert.match(refused, /"isError":true/, name);
          assert.match(
            refused,
            /Access to \\"file:\\" protocol is blocked/,
            name,
          );
          const seen = await text("browser_snapshot", {});
          assert.match(seen, /Page URL: about:blank/, name);
          assert(!seen.includes(ownedMarker), name);
        }
      } finally {
        await client.close();
      }
      // Through the agent and the runner's policy, with this same browser:
      // the isolation probes (no checker: the run stops before a session).
      const results = join(temporary, "results-browser-route");
      const run = await runner(
        "browser-route-1",
        {
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          OPENWEBUI_ACP_HOME: await userState("http://127.0.0.1:9"),
          LONG_BENCHMARK_RESULTS: results,
          LONG_BENCHMARK_BROWSER_MCP_URL: browser.url,
          TMPDIR: temporary,
        },
        t.signal,
      );
      const dir = join(results, "browser-route-1");
      if (EVIDENCE)
        await cp(dir, join(EVIDENCE, "browser-route-1"), { recursive: true });
      assert.equal(run.code, 4, run.stderr);
      const report = JSON.parse(
        await readFile(join(dir, "report.json"), "utf8"),
      );
      const iso = report.isolation;
      assert.equal(iso.established, true, JSON.stringify(iso.findings));
      const r = iso.results;
      // Positive control: this host browser read the workspace preview.
      for (const id of [
        "browser-preview",
        "browser-open-host",
        "browser-look-host",
      ])
        assert.equal(r[id].ok, true, id);
      // The policy refused every browser-initiated route to the file and to
      // the foreign origin.
      for (const id of [
        "browser-navigate-file",
        "browser-new-tab-file",
        "browser-navigate-foreign",
        "browser-new-tab-foreign",
      ])
        assert.equal(r[id].ok, false, id);
      // Every page read after a page-initiated attempt ran and showed nothing.
      for (const id of [
        "browser-link-look",
        "browser-tab-link-tabs",
        "browser-tab-link-look",
        "browser-window-tabs",
        "browser-window-look",
        "browser-redirect-look",
        "browser-back-look",
        "browser-foreign-link-look",
        "browser-foreign-back-look",
        "browser-foreign-forward-look",
        "browser-foreign-location-look",
        "browser-foreign-tab-link-tabs",
        "browser-foreign-tab-link-look",
        "browser-foreign-window-tabs",
        "browser-foreign-window-look",
        "browser-foreign-redirect-look",
        "browser-foreign-embed-look",
      ])
        assert.equal(r[id].ok, true, id);
      // The clicks and tab selections themselves ran.
      for (const id of [
        "browser-link",
        "browser-tab-link",
        "browser-tab-link-select",
        "browser-window",
        "browser-redirect",
      ])
        assert.notEqual(r[id].ok, null, id);
      // The foreign origin, in the second turn. Positive controls: this
      // browser read the second preview and a click ran its script. Each
      // attempt to leave the preview ran, as a completed tool call.
      for (const id of [
        "browser-foreign-preview",
        "browser-foreign-open",
        "browser-foreign-look",
        "browser-play",
        "browser-play-look",
        "browser-foreign-link",
        "browser-foreign-back",
        "browser-foreign-forward",
        "browser-foreign-location",
        "browser-foreign-tab-link",
        "browser-foreign-tab-link-select",
        "browser-foreign-window",
        "browser-foreign-window-select",
        "browser-foreign-redirect",
        "browser-foreign-embed",
      ])
        assert.equal(r[id].ok, true, id);
      // It served its marker to the harness and counted no other connection.
      assert.deepEqual(iso.foreignOrigin, { served: true, reached: 0 });
      assert(!JSON.stringify(report).includes(script.marker));
      assert.doesNotMatch(
        JSON.stringify(report),
        /foreign-origin-[0-9a-f-]{36}/,
      );
    } finally {
      await browser.close();
    }
  },
);

// One MCP session with the wrapper, without the agent or its policy. Every
// tool result is kept, so that a test can search all of them.
async function wrapperSession(url) {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StreamableHTTPClientTransport } =
    await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
  const client = new Client({ name: "boundary-check", version: "1" });
  const transport = new StreamableHTTPClientTransport(new URL(url));
  await client.connect(transport);
  const results = [];
  return {
    results,
    async call(name, args = {}) {
      const result = await client.callTool({ name, arguments: args });
      results.push(JSON.stringify(result));
      return (result.content ?? [])
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\n");
    },
    async close() {
      await transport.terminateSession().catch(() => {});
      await client.close();
    },
  };
}
const snapshotRef = (text, name) =>
  text.match(
    new RegExp(`(?:link|button) "${name}"[^\\n]*?\\[ref=([a-z0-9]+)\\]`),
  )?.[1];

test(
  "real browser boundary: a confined wrapper session never reads another origin",
  { timeout: 600000, skip: realBrowserSkip },
  async () => {
    const browser = await realBrowser();
    // Two harness-owned origins on this host. The second serves the marker.
    // The first is what the client opens: a page without any content
    // security policy, which tries every way to the foreign origin.
    const foreign = await GAME.startForeignOrigin();
    const second = `http://127.0.0.1:${foreign.port}`;
    const opened = createServer((req, res) => {
      if (req.url === "/hop") {
        res.writeHead(302, { Location: `${second}/hop` });
        return res.end();
      }
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      if (req.url === "/refresh")
        return res.end(
          `<!doctype html><title>refresh</title><meta http-equiv="refresh" content="0;url=${second}/meta"><p>refreshing</p>`,
        );
      res.end(`<!doctype html><title>opened</title><p id="state">opened-page</p>
<a href="${second}/link">foreign link</a> <a target="_blank" href="${second}/tab">foreign tab link</a>
<a href="/hop">hop link</a> <a href="/refresh">refresh link</a>
<button onclick="window.open('${second}/window')">open window</button>
<button onclick="location.href='${second}/location'">set location</button>
<button onclick="history.forward()">go forward</button>
<button onclick="document.getElementById('state').textContent='played-page'">play</button>
<iframe src="${second}/frame"></iframe><img src="${second}/image" alt=""><script src="${second}/script"></script>
<script>
fetch('${second}/fetch').then((r) => r.text()).then((t) => { document.title = t; }).catch(() => {});
try { new WebSocket('ws://127.0.0.1:${foreign.port}/socket'); } catch {}
</script>`);
    });
    await new Promise((r) => opened.listen(0, "127.0.0.1", r));
    const first = `http://127.0.0.1:${opened.address().port}/`;
    let confined, ordinary;
    try {
      // Positive control: the foreign origin serves its marker to this test.
      assert.equal(await foreign.serves(), true);
      confined = await wrapperSession(`${browser.url}/confined`);
      const { call } = confined;
      const click = async (name) => {
        const target = snapshotRef(await call("browser_snapshot"), name);
        assert(target, `no reference for ${name}`);
        return call("browser_click", { target, element: name });
      };
      // Positive controls: the session reads the page that the client
      // opened, with its own subresource-free content, and operates it.
      await call("browser_navigate", { url: first });
      assert.match(await call("browser_snapshot"), /opened-page/);
      await click("play");
      assert.match(await call("browser_snapshot"), /played-page/);
      // Page-initiated navigation in the tab: a link, an HTTP redirect from
      // the opened origin, a location change and a meta refresh. Then
      // history: back to the opened page and forward again.
      for (const name of [
        "foreign link",
        "hop link",
        "set location",
        "refresh link",
      ]) {
        await call("browser_navigate", { url: first });
        await click(name);
        await call("browser_wait_for", { time: 1 });
        const blocked = await call("browser_snapshot");
        assert.match(blocked, /Blocked by the browser origin boundary/, name);
        await call("browser_navigate_back");
        if (name !== "refresh link") {
          await click("go forward");
          assert.match(
            await call("browser_snapshot"),
            /Blocked by the browser origin boundary/,
            `${name}, forward`,
          );
        }
      }
      // New tabs: a target=_blank link and window.open.
      for (const [name, index] of [
        ["foreign tab link", 1],
        ["open window", 2],
      ]) {
        await call("browser_navigate", { url: first });
        await click(name);
        assert.match(
          await call("browser_tabs", { action: "list" }),
          new RegExp(`- ${index}:`),
          name,
        );
        await call("browser_tabs", { action: "select", index });
        assert.match(
          await call("browser_snapshot"),
          /Blocked by the browser origin boundary/,
          name,
        );
        await call("browser_tabs", { action: "select", index: 0 });
      }
      // A second browser context of the same session is behind the boundary.
      await call("browser_tabs", {
        action: "new",
        isolatedContext: "second",
        url: first,
      });
      assert.match(await call("browser_snapshot"), /opened-page/);
      await click("foreign link");
      assert.match(
        await call("browser_snapshot"),
        /Blocked by the browser origin boundary/,
      );
      // What the browser recorded of its own requests and console.
      await call("browser_network_requests", { static: true });
      await call("browser_console_messages", { level: "info" });
      // HTTPS needs a tunnel, which the boundary never opens.
      assert.match(
        await call("browser_navigate", {
          url: `https://127.0.0.1:${foreign.port}/tunnel`,
        }),
        /ERR_TUNNEL_CONNECTION_FAILED/,
      );
      await confined.close();
      // Frames, images, scripts, fetch, a WebSocket and every navigation
      // above: the foreign origin counted no connection, and no tool result
      // of the session holds its marker.
      assert.equal(foreign.reached(), 0);
      assert(confined.results.length > 40);
      for (const result of confined.results)
        assert(!result.includes(foreign.marker));
      // The same wrapper's ordinary endpoint is unchanged, and shows that
      // the attempts were real: the same page and the same link read the
      // marker there.
      ordinary = await wrapperSession(browser.url);
      await ordinary.call("browser_navigate", { url: first });
      const target = snapshotRef(
        await ordinary.call("browser_snapshot"),
        "foreign link",
      );
      await ordinary.call("browser_click", { target, element: "foreign link" });
      assert(
        (await ordinary.call("browser_snapshot")).includes(foreign.marker),
      );
      assert(foreign.reached() > 0);
    } finally {
      await confined?.close().catch(() => {});
      await ordinary?.close().catch(() => {});
      await browser.close();
      await foreign.close();
      opened.closeAllConnections();
      await new Promise((r) => opened.close(r));
    }
  },
);

lifecycleTest(
  "real browser route: a browser that does not confine the session never gets one",
  { timeout: 600000, skip: realBrowserSkip },
  async (t) => {
    // The same wrapper and Chromium, but its confined endpoint opens
    // ordinary sessions. Everything else is as in a real run without a
    // checker. The probes must find the open route and stop the run.
    const browser = await realBrowser({ confine: false });
    try {
      const results = join(temporary, "results-browser-unconfined");
      const run = await runner(
        "browser-unconfined-1",
        {
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          OPENWEBUI_ACP_HOME: await userState("http://127.0.0.1:9"),
          LONG_BENCHMARK_RESULTS: results,
          LONG_BENCHMARK_BROWSER_MCP_URL: browser.url,
          TMPDIR: temporary,
        },
        t.signal,
      );
      const dir = join(results, "browser-unconfined-1");
      if (EVIDENCE)
        await cp(dir, join(EVIDENCE, "browser-unconfined-1"), {
          recursive: true,
        });
      assert.equal(run.code, 4, run.stderr);
      const text = await readFile(join(dir, "report.json"), "utf8");
      const report = JSON.parse(text);
      const iso = report.isolation;
      assert.equal(iso.established, false);
      // The controls worked: the browser read and operated both previews,
      // and the foreign origin had served its marker to the harness.
      const r = iso.results;
      for (const id of [
        "browser-look-host",
        "browser-foreign-look",
        "browser-play-look",
      ])
        assert.equal(r[id].ok, true, id);
      assert(!iso.findings.some((f) => /control|playable/.test(f)));
      assert.equal(iso.foreignOrigin.served, true);
      // The open route was found from both sides: the foreign origin counted
      // connections, and a page read held its marker.
      assert(iso.foreignOrigin.reached > 0);
      assert(
        iso.findings.includes(
          `the foreign origin was reached (connections: ${iso.foreignOrigin.reached})`,
        ),
        JSON.stringify(iso.findings),
      );
      for (const id of [
        "browser-foreign-link-look",
        "browser-foreign-forward-look",
        "browser-foreign-location-look",
        "browser-foreign-tab-link-look",
        "browser-foreign-window-look",
        "browser-foreign-redirect-look",
      ])
        assert(
          iso.findings.includes(`${id}: read the foreign origin`),
          `${id}: ${JSON.stringify(iso.findings)}`,
        );
      // The policy, which does not depend on the browser, still refused.
      for (const id of ["browser-navigate-foreign", "browser-new-tab-foreign"])
        assert.equal(r[id].ok, false, id);
      // No session, no verdict, and the marker is not in the report.
      assert.equal(report.sessionId, undefined);
      assert.equal(report.requests, 0);
      assert.equal(
        report.error,
        "game preconditions not met; no session was started",
      );
      assert.match(
        report.preconditions.join("\n"),
        /isolation not established: .*the foreign origin was reached/,
      );
      assert.deepEqual(report.hiddenChecks, {
        verdict: "unavailable",
        reason: "preconditions not met",
      });
      assert.doesNotMatch(text, /foreign-origin-[0-9a-f-]{36}/);
    } finally {
      await browser.close();
    }
  },
);

// A scripted model that writes `html` as index.html and, when `play` is set,
// previews and plays it without being asked.
async function fakeModel(html, play, previewKey = "containerUrl") {
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
        args: { url: JSON.parse(last)[previewKey] },
      }),
      // The real MCP server returns isError for a stale reference while the
      // ACP call itself completes. It must count once as a failed tool call.
      () => ({
        name: "browser/browser_click",
        args: { target: "benchmark_missing_ref", element: "a missing light" },
      }),
      () => ({ name: "browser/browser_snapshot", args: {} }),
      // A light, by the reference in the real snapshot.
      (last) => ({
        name: "browser/browser_click",
        args: {
          target: String(last)
            .replaceAll('\\"', '"')
            .match(/button "Light[^"]*"[^\n]*?\[ref=([a-z0-9]+)\]/)?.[1],
          element: "a light",
        },
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

for (const [label, game, play, verdict] of [
  ["reference-1", "reference", true, "accepted"],
  ["no-lock-1", "no-lock", false, "rejected"],
])
  lifecycleTest(
    `a full run (${game}): hidden verdict, screenshots and unprompted play-testing`,
    {
      timeout: 600000,
      skip:
        (!CHECKER ||
          !BROWSER ||
          (!LOCAL_CHROMIUM && !process.env.LONG_BENCHMARK_BROWSER_MCP_URL)) &&
        "needs LONG_BENCHMARK_ACCEPTANCE_CHECKER, LONG_BENCHMARK_GAME_BROWSER and a real agent browser (local:/abs/chromium or LONG_BENCHMARK_BROWSER_MCP_URL)",
    },
    async (t) => {
      // The agent's real browser: a configured one (the container) or the
      // repository's wrapper with the local Chromium.
      const browser = process.env.LONG_BENCHMARK_BROWSER_MCP_URL
        ? {
            url: process.env.LONG_BENCHMARK_BROWSER_MCP_URL,
            previewKey: "containerUrl",
            close: async () => {},
          }
        : await realBrowser();
      const results = join(temporary, "results-full");
      try {
        {
          const model = await fakeModel(
            source.games[game]["index.html"].toString("utf8"),
            play,
            browser.previewKey,
          );
          try {
            const run = await runner(
              label,
              {
                PATH: process.env.PATH,
                HOME: process.env.HOME,
                OPENWEBUI_ACP_HOME: await userState(model.url),
                OPENWEBUI_API_KEY: "synthetic-game-run",
                LONG_BENCHMARK_RESULTS: results,
                LONG_BENCHMARK_ACCEPTANCE_CHECKER: CHECKER,
                LONG_BENCHMARK_GAME_BROWSER: BROWSER,
                LONG_BENCHMARK_BROWSER_MCP_URL: browser.url,
                TMPDIR: temporary,
              },
              t.signal,
            );
            const dir = join(results, label);
            // Optional: keep this run's results outside the temporary tree.
            if (EVIDENCE)
              await cp(dir, join(EVIDENCE, label), { recursive: true });
            assert.equal(run.code, 0, run.stderr + run.stdout.slice(-2000));
            const report = JSON.parse(
              await readFile(join(dir, "report.json"), "utf8"),
            );
            assert.equal(
              report.isolation.established,
              true,
              JSON.stringify(report.isolation.findings),
            );
            // The browser route was probed, with a working preview control,
            // before the attempt and again after it, under the same policy.
            for (const iso of [report.isolation, report.isolationAfter]) {
              assert.equal(iso.established, true, JSON.stringify(iso.findings));
              assert(
                iso.results["browser-look-host"].ok === true ||
                  iso.results["browser-look-container"].ok === true,
              );
              for (const id of [
                "browser-navigate-file",
                "browser-new-tab-file",
                "browser-navigate-foreign",
                "browser-new-tab-foreign",
                "command-network-curl",
                "command-network-node",
                "server-task",
              ])
                assert.equal(iso.results[id].ok, false, id);
              // The second preview was read and operated, and the second
              // origin stayed unreached, before the attempt and after it.
              assert.equal(iso.results["browser-foreign-look"].ok, true);
              assert.equal(iso.results["browser-play-look"].ok, true);
              assert.deepEqual(iso.foreignOrigin, { served: true, reached: 0 });
            }
            assert.deepEqual(report.evaluator.session.unprobedRoutes, []);
            assert.deepEqual(
              report.evaluator.session.harnessRoutes.map((r) => r.route),
              [
                "browser-mcp",
                "sandboxed-command-network",
                "open-webui-server-tasks",
              ],
            );
            assert.equal(
              report.hiddenChecks.verdict,
              verdict,
              JSON.stringify(report.hiddenChecks),
            );
            assert.equal(report.hiddenChecks.validatedVerdict, verdict);
            // The session began before the agent and lived through the attempt.
            assert.equal(report.evaluator.session.ready, true);
            assert(report.evaluator.session.finalProbes > 0);
            assert.equal(report.hiddenChecks.components.protection, "passed");
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
              assert.equal(report.toolCalls["browser/browser_click"], 2);
              assert.equal(report.toolFailuresTotal, 1);
              assert.deepEqual(report.toolFailuresByTool, {
                "browser/browser_click": 1,
              });
              assert.deepEqual(report.toolFailures, {
                "browser/browser_click: MCP isError": 1,
              });
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
            assert.deepEqual(
              (await readdir(join(dir, "screenshots"))).length,
              4,
            );
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

test("the browser policy admits navigation only to the agent's own preview", () => {
  const previewOrigins = new Set([
    "http://127.0.0.1:4100",
    "http://host.docker.internal:4100",
  ]);
  const call = (tool, args) =>
    GAME.decide(
      {
        toolCall: {
          title: `Call browser/${tool} (runs on this machine outside the sandbox): ${JSON.stringify(args)}`,
        },
      },
      { game: true, previewOrigins },
    );
  const preview = "http://127.0.0.1:4100/index.html";
  const file = "file:///scratch/acceptance/playthrough.json";
  assert.equal(call("browser_navigate", { url: preview }), true);
  assert.equal(
    call("browser_navigate", { url: "http://host.docker.internal:4100/x" }),
    true,
  );
  for (const url of [
    file,
    "http://127.0.0.1:9/",
    "about:blank",
    "chrome://version",
  ])
    assert.equal(call("browser_navigate", { url }), false, url);
  // A tab at a URL is browser-initiated navigation too.
  assert.equal(call("browser_tabs", { action: "new", url: file }), false);
  assert.equal(
    call("browser_tabs", { action: "new", url: "http://127.0.0.1:9/" }),
    false,
  );
  assert.equal(call("browser_tabs", { action: "new", url: preview }), true);
  assert.equal(call("browser_tabs", { action: "new" }), true);
  for (const action of ["list", "select", "close"])
    assert.equal(call("browser_tabs", { action, index: 0 }), true, action);
  assert.equal(
    call("browser_tabs", { action: "select", index: 1, url: file }),
    false,
  );
  assert.equal(call("browser_tabs", { action: "reload" }), false);
  // Page tools take no URL; one that does is refused.
  assert.equal(call("browser_click", { target: "e3", element: "link" }), true);
  assert.equal(call("browser_click", { target: "e3", url: file }), false);
  assert.equal(call("browser_snapshot", {}), true);
  // Tools outside the wrapper allowlist, and malformed arguments.
  assert.equal(call("browser_evaluate", { function: "() => 1" }), false);
  assert.equal(call("browser_take_screenshot", {}), false);
  assert.equal(
    GAME.decide(
      { toolCall: { title: "Call browser/browser_click: not json" } },
      { game: true, previewOrigins },
    ),
    false,
  );
  // The agent is connected to the wrapper's confined endpoint and to no
  // other MCP server, the wrapper's ordinary endpoint included.
  const browserUrl = GAME.confinedEndpoint("http://127.0.0.1:8931/mcp");
  assert.equal(browserUrl, "http://127.0.0.1:8931/mcp/confined");
  const titled = (title) =>
    GAME.decide(
      { toolCall: { title } },
      { game: true, previewOrigins, browserUrl },
    );
  assert.equal(
    titled(
      "MCP browser: http http://127.0.0.1:8931/mcp/confined; authentication headers are redacted",
    ),
    true,
  );
  for (const title of [
    "MCP browser: http http://127.0.0.1:8931/mcp; authentication headers are redacted",
    "MCP browser: http http://127.0.0.1:8931/mcp/confined/x; authentication headers are redacted",
    "MCP other: http http://127.0.0.1:8931/mcp/confined; authentication headers are redacted",
    // The other routes to a network: a sandboxed command's connection, to a
    // public host or to this one, an unsandboxed command and a server task.
    "Allow sandbox network connection to raw.githubusercontent.com:443? This destination may receive command data; approval does not authorize remote mutations.",
    "Allow sandbox network connection to 127.0.0.1:4999? This destination may receive command data; approval does not authorize remote mutations.",
    'Run curl ["https://raw.githubusercontent.com/"]; cwd /w; foreground; timeout 1000 ms; UNSANDBOXED: full user-level filesystem/network access',
    'Delegate to Open WebUI at http://127.0.0.1:9, model fixture. Create and retain a server chat with this prompt. Requested features: ["web_search"]; tool IDs: [].',
    "Enable YOLO for this session in /w? Commands and local MCP will run UNSANDBOXED with your user account's filesystem and network access.",
  ])
    assert.equal(titled(title), false, title);
});
