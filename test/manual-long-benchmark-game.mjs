// Interactive game task for the long-session benchmark: a public brief, and a
// hidden acceptance source checked through the PLAN-04 task acceptance
// contract (schema 1). Explicit use only; the runner imports this module.
//
// The acceptance source (test/fixtures/long-benchmark-game) holds the
// specification, the agent-visible fixture (the brief only), the hidden
// play-through script, a trusted reference game and known-bug mutants. Its
// seal is pinned below, outside the source and every workspace. After the
// agent's session the evaluator plays the produced game in a real browser,
// captures screenshots, and writes the observation as the contract's
// external-state file; the PLAN-04 checker gives the verdict.
//
//   node test/manual-long-benchmark-game.mjs --check-browser container:NAME
//   node test/manual-long-benchmark-game.mjs --check-browser local:/path/to/chromium
//
// plays the trusted reference and every mutant and exits non-zero unless each
// gives its declared outcome. No model is involved.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const SOURCE = fileURLToPath(
  new URL("./fixtures/long-benchmark-game/", import.meta.url),
);
// Seal of the acceptance source (PLAN-04 seal algorithm). Pinned here, in the
// evaluator's code; change it only with a reviewed change to the source.
export const GAME_SEAL =
  "e3dfcf0b334b726f1c491dcb886cfbc469a957a48d43a32bac48a794b5d934d5";
export const CONTRACT = {
  schema: 1,
  spec: "workstation-task-acceptance-spec",
  result: "workstation-task-acceptance-result",
  seal: "workstation-task-acceptance-seal",
};
export const PROMPT =
  "Build the browser game described in BRIEF.md in this folder. When you have finished, reply with a short summary of what you built.";
const DRIVER = fileURLToPath(
  new URL("./manual-long-benchmark-game-driver.mjs", import.meta.url),
);
const BROWSER_PACKAGE = fileURLToPath(new URL("../browser/", import.meta.url));
const MAX_SOURCE_FILE = 2 * 1024 * 1024;
// What the evaluator serves from a workspace: the preview tool's own limits.
const SERVE = { files: 128, file: 1024 * 1024, total: 8 * 1024 * 1024 };
const DRIVER_TIMEOUT_MS = 120000;

export const sha256 = (data) => createHash("sha256").update(data).digest("hex");
// Python json.dumps(sort_keys=True, separators=(",", ":"), ensure_ascii=False).
const canonical = (value) =>
  Array.isArray(value)
    ? `[${value.map(canonical).join(",")}]`
    : value && typeof value === "object"
      ? `{${Object.keys(value)
          .sort()
          .map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`)
          .join(",")}}`
      : JSON.stringify(value);

// Every file below `root` as relative POSIX path -> bytes. `strict` refuses
// links, special and oversized files (as the PLAN-04 checker does for an
// acceptance source); otherwise they are reported in `refused`.
export async function readTree(root, { strict = true, limits } = {}) {
  const files = {},
    refused = [];
  let total = 0;
  async function walk(directory) {
    const entries = (await readdir(directory, { withFileTypes: true })).sort(
      (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
    );
    for (const entry of entries) {
      const path = join(directory, entry.name);
      const name = relative(root, path).split(sep).join("/");
      const info = await lstat(path);
      if (info.isDirectory()) {
        await walk(path);
        continue;
      }
      const max = limits?.file ?? MAX_SOURCE_FILE;
      if (!info.isFile() || info.size > max) {
        if (strict) throw new Error(`not a bounded regular file: ${name}`);
        refused.push(name);
        continue;
      }
      if (limits && Object.keys(files).length >= limits.files) {
        refused.push(name);
        continue;
      }
      const data = await readFile(path);
      total += data.length;
      if (limits && total > limits.total) {
        refused.push(name);
        total -= data.length;
        continue;
      }
      files[name] = data;
    }
  }
  await walk(root);
  return { files, refused };
}

export function sealOf(files) {
  if (!files["acceptance.json"])
    throw new Error("source lacks acceptance.json");
  const digests = {};
  for (const [name, data] of Object.entries(files))
    digests[name] = sha256(data);
  return sha256(
    canonical({ schema: CONTRACT.schema, kind: CONTRACT.seal, files: digests }),
  );
}

// The acceptance source, accepted only when its seal equals the pinned seal.
export async function loadSource(directory = SOURCE, expected = GAME_SEAL) {
  const { files } = await readTree(directory);
  const seal = sealOf(files);
  if (seal !== expected)
    throw new Error(`acceptance source seal ${seal} is not the pinned seal`);
  const json = (name) => JSON.parse(files[name].toString("utf8"));
  const spec = json("acceptance.json");
  const script = json("playthrough.json");
  if (spec.schema !== CONTRACT.schema || spec.kind !== CONTRACT.spec)
    throw new Error("unsupported acceptance specification");
  const stateChecks = spec.external_state.checks.map((c) => c.id);
  if (
    JSON.stringify(stateChecks) !==
    JSON.stringify(["playthrough-complete", ...script.checks])
  )
    throw new Error("specification and play-through declare different checks");
  const games = { [script.references.trusted]: pick(files, "reference/") };
  for (const name of Object.keys(script.references.mutants))
    games[name] = pick(files, `mutants/${name}/`);
  return { files, seal, spec, script, games };
}
const pick = (files, prefix) =>
  Object.fromEntries(
    Object.entries(files)
      .filter(([name]) => name.startsWith(prefix))
      .map(([name, data]) => [name.slice(prefix.length), data]),
  );

// Writes the sealed source to a new private directory, byte for byte.
export async function copySource(source, destination) {
  await mkdir(destination, { mode: 0o700 });
  for (const [name, data] of Object.entries(source.files)) {
    const path = join(destination, ...name.split("/"));
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(path, data, { mode: 0o600, flag: "wx" });
  }
}

// The agent-visible part: fixture/ only.
export async function writeFixture(source, workspace) {
  for (const [name, data] of Object.entries(pick(source.files, "fixture/")))
    await writeFile(join(workspace, ...name.split("/")), data, {
      mode: 0o600,
      flag: "wx",
    });
}

// ---- Browser transport -----------------------------------------------------
// container:NAME runs the driver in the documented browser container with its
// pinned Playwright and Chromium; local:/abs/chromium runs it on this host
// with browser/node_modules and that executable.
export function parseTransport(value) {
  const m = String(value ?? "").match(/^(container|local):(.+)$/);
  if (!m) return null;
  if (m[1] === "container" && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(m[2]))
    return { kind: "container", name: m[2] };
  if (m[1] === "local" && isAbsolute(m[2]))
    return { kind: "local", executable: m[2] };
  return null;
}

export async function runDriver(transport, payload) {
  const driver = await readFile(DRIVER, "utf8");
  if (transport.kind === "local")
    payload = { ...payload, launch: { executablePath: transport.executable } };
  const input = `globalThis.LIGHTS_OUT_PAYLOAD = ${JSON.stringify(payload)};\n${driver}`;
  const [command, args, cwd] =
    transport.kind === "container"
      ? [
          "docker",
          [
            "exec",
            "-i",
            "-w",
            "/opt/openwebui-browser",
            transport.name,
            "node",
            "--input-type=module",
            "-",
          ],
          undefined,
        ]
      : [process.execPath, ["--input-type=module", "-"], BROWSER_PACKAGE];
  return await new Promise((done, fail) => {
    const child = spawn(command, args, {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: { PATH: process.env.PATH, HOME: process.env.HOME },
    });
    let stdout = "",
      stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), DRIVER_TIMEOUT_MS);
    child.stdout.on("data", (d) => {
      if (stdout.length < 32 * 1024 * 1024) stdout += d;
    });
    child.stderr.on("data", (d) => {
      if (stderr.length < 8000) stderr += d;
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      fail(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0)
        return fail(
          new Error(
            `browser driver exited ${code}: ${stderr.trim().split("\n").slice(-3).join(" | ").slice(0, 600)}`,
          ),
        );
      try {
        const out = JSON.parse(stdout);
        if (!Array.isArray(out.steps)) throw new Error("no steps");
        done(out);
      } catch {
        fail(new Error("browser driver returned no observation"));
      }
    });
    child.stdin.end(input);
  });
}

// ---- Judging ---------------------------------------------------------------
// A 5x5 grid of booleans from observed cells, or the reason it is not one.
export function gridOf(observation, size) {
  if (!observation || !Array.isArray(observation.cells))
    return { error: "no-board" };
  if (observation.count !== size * size)
    return { error: `board-has-${observation.count}-lights` };
  const grid = Array.from({ length: size }, () => Array(size).fill(null));
  for (const c of observation.cells) {
    const row = Number(c.row),
      col = Number(c.col);
    if (
      !/^\d$/.test(String(c.row)) ||
      !/^\d$/.test(String(c.col)) ||
      row >= size ||
      col >= size ||
      grid[row][col] !== null
    )
      return { error: "cell-position-invalid" };
    if (c.pressed !== "true" && c.pressed !== "false")
      return { error: "aria-pressed-invalid" };
    grid[row][col] = c.pressed === "true";
  }
  return { grid };
}
const gridText = (grid) =>
  grid.map((row) => row.map((on) => (on ? "1" : "0")).join("")).join("/");
const movesOf = (text) => {
  const m = String(text ?? "").match(/-?\d+/);
  return m ? Number(m[0]) : null;
};

// Compares raw driver output with the hidden expectations. Returns every
// declared check as true or false, with reasons for the failures.
export function judge(script, raw) {
  const failures = Object.fromEntries(script.checks.map((id) => [id, []]));
  const fail = (id, reason) => failures[id].push(reason);
  const start = script.start.map((line) => [...line].map((c) => c === "1"));
  const grids = {};
  let previous = null;
  for (const step of script.steps) {
    const seen = raw.steps.find((s) => s.id === step.id);
    const owners = step.checks;
    const each = (reason) =>
      owners.forEach((id) => fail(id, `${step.id}: ${reason}`));
    if (!seen) {
      each("not observed");
      previous = null;
      continue;
    }
    if (seen.error) each(`action failed: ${seen.error}`);
    const { grid, error } = gridOf(seen, script.size);
    if (error) {
      each(error);
      if (step.id === "initial") fail("board-layout", error);
    }
    const expect = step.expect;
    if (grid) {
      grids[step.id] = grid;
      let wanted = null;
      if (expect.grid === "start") wanted = start;
      else if (expect.grid === "off")
        wanted = start.map((row) => row.map(() => false));
      else if (expect.grid?.sameAs) wanted = grids[expect.grid.sameAs] ?? null;
      else if (expect.toggled && previous) {
        wanted = previous.map((row) => [...row]);
        for (const [r, c] of expect.toggled) wanted[r][c] = !wanted[r][c];
      }
      if ((expect.grid || expect.toggled) && !wanted)
        each("no reference state to compare");
      else if (wanted && gridText(grid) !== gridText(wanted))
        each(`board ${gridText(grid)}, expected ${gridText(wanted)}`);
    }
    if ("moves" in expect && movesOf(seen.moves) !== expect.moves)
      each(`moves ${JSON.stringify(seen.moves)}, expected ${expect.moves}`);
    if ("undoDisabled" in expect && seen.undoDisabled !== expect.undoDisabled)
      each(
        `undo disabled ${seen.undoDisabled}, expected ${expect.undoDisabled}`,
      );
    if (
      expect.statusIncludes &&
      !String(seen.status ?? "").includes(expect.statusIncludes)
    )
      each(
        `status ${JSON.stringify(seen.status)} lacks ${JSON.stringify(expect.statusIncludes)}`,
      );
    if (
      expect.statusExcludes &&
      String(seen.status ?? "").includes(expect.statusExcludes)
    )
      each(
        `status ${JSON.stringify(seen.status)} contains ${JSON.stringify(expect.statusExcludes)}`,
      );
    if (step.screenshot && !isPng(seen.screenshot))
      fail("screenshots", `${step.id}: no screenshot`);
    previous = grid ?? null;
  }
  if (raw.litDistinct !== true)
    fail(
      "lit-distinct",
      "a lit and an unlit light look the same or were not captured",
    );
  if (raw.pageErrors || raw.consoleErrors || raw.dialogs)
    fail(
      "no-page-errors",
      `${raw.pageErrors} page errors, ${raw.consoleErrors} console errors, ${raw.dialogs} dialogs`,
    );
  if (raw.externalRequests)
    fail(
      "self-contained",
      `${raw.externalRequests} requests to another origin`,
    );
  const checks = Object.fromEntries(
    script.checks.map((id) => [id, failures[id].length === 0]),
  );
  for (const id of Object.keys(failures))
    if (!failures[id].length) delete failures[id];
  return { checks, failures };
}
const isPng = (b64) =>
  typeof b64 === "string" &&
  Buffer.from(b64.slice(0, 12), "base64")
    .subarray(0, 8)
    .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));

const payloadFor = (script, files) => ({
  entry: script.entry,
  size: script.size,
  steps: script.steps.map(({ id, action, screenshot }) => ({
    id,
    action,
    screenshot,
  })),
  files: Object.fromEntries(
    Object.entries(files).map(([name, data]) => [
      name,
      data.toString("base64"),
    ]),
  ),
});

// Plays the trusted reference and every known-bug mutant. The play-through is
// trusted only when the reference passes every check and each mutant fails at
// least the checks it was built to break.
export async function proveReferences(source, transport) {
  const { script, games } = source;
  const outcomes = {};
  let ok = true;
  for (const [name, files] of Object.entries(games)) {
    const { checks, failures } = judge(
      script,
      await runDriver(transport, payloadFor(script, files)),
    );
    const failed = Object.keys(checks).filter((id) => !checks[id]);
    const expected =
      name === script.references.trusted ? [] : script.references.mutants[name];
    const matches =
      name === script.references.trusted
        ? failed.length === 0
        : expected.every((id) => failed.includes(id));
    if (!matches) ok = false;
    outcomes[name] = { expectedToFail: expected, failed, matches, failures };
  }
  return { ok, outcomes };
}

// Plays the files in `workspace` and writes the observation (the PLAN-04
// external-state file) and the screenshots to `out`. Returns the observation,
// or { unavailable } when the play-through itself could not run.
export async function playWorkspace({
  source,
  transport,
  references,
  workspace,
  out,
}) {
  if (!references?.ok)
    return {
      unavailable: "play-through references did not behave as declared",
    };
  const { script } = source;
  const { files, refused } = await readTree(workspace, {
    strict: false,
    limits: SERVE,
  });
  const served = Object.fromEntries(
    Object.entries(files).map(([name, data]) => [name, sha256(data)]),
  );
  const observation = {
    kind: "long-benchmark-game-observation",
    schema: 1,
    task_id: source.spec.task_id,
    seal_sha256: source.seal,
    playthrough_sha256: sha256(source.files["playthrough.json"]),
    entry: script.entry,
    entry_sha256: served[script.entry] ?? null,
    served,
    served_tree_sha256: sha256(canonical(served)),
    refused,
    complete: false,
    checks: Object.fromEntries(script.checks.map((id) => [id, false])),
    failures: {},
    screenshots: [],
    references: Object.fromEntries(
      Object.entries(references.outcomes).map(([name, o]) => [name, o.matches]),
    ),
  };
  if (!served[script.entry])
    observation.failures.entry = ["entry file missing"];
  else {
    let raw;
    try {
      raw = await runDriver(transport, payloadFor(script, files));
    } catch (error) {
      return { unavailable: `browser driver failed: ${error.message}` };
    }
    Object.assign(observation, judge(script, raw), { complete: true });
    observation.browser_version = raw.browserVersion;
    await mkdir(join(out, "screenshots"), { recursive: true, mode: 0o700 });
    for (const step of raw.steps)
      if (step.screenshot) {
        const png = Buffer.from(step.screenshot, "base64");
        const file = `screenshots/${step.id}.png`;
        await writeFile(join(out, file), png, { mode: 0o600 });
        observation.screenshots.push({
          step: step.id,
          file,
          sha256: sha256(png),
          bytes: png.length,
          // Each screenshot is of exactly these served files.
          served_tree_sha256: observation.served_tree_sha256,
        });
      }
  }
  await writeFile(
    join(out, "playthrough-state.json"),
    JSON.stringify(observation, null, 2) + "\n",
    { mode: 0o600, flag: "wx" },
  );
  return observation;
}

// ---- PLAN-04 checker -------------------------------------------------------
const checkerFiles = [
  "task_acceptance.py",
  "coding_eval.py",
  "assistant_acceptance.py",
];
export async function checkerIdentity(path) {
  if (!path || !isAbsolute(path) || !path.endsWith("task_acceptance.py"))
    return {
      unavailable:
        "LONG_BENCHMARK_ACCEPTANCE_CHECKER is not an absolute path to task_acceptance.py",
    };
  const identity = { path, files: {} };
  try {
    for (const name of checkerFiles)
      identity.files[name] = sha256(await readFile(join(dirname(path), name)));
  } catch {
    return { unavailable: "checker files are not readable" };
  }
  return identity;
}
function python(args) {
  return new Promise((done) => {
    const child = spawn("python3", ["-E", "-s", ...args], {
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        PYTHONDONTWRITEBYTECODE: "1",
      },
    });
    let stdout = "",
      stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", () =>
      done({ code: null, stdout, stderr: "python3 not found" }),
    );
    child.on("close", (code) => done({ code, stdout, stderr }));
  });
}
// The checker's own seal of the copied source must equal the pinned seal.
export async function checkerSeal(checker, source) {
  const r = await python([checker, "seal", source]);
  return r.code === 0 ? r.stdout.trim() : null;
}

// Runs `check` and `validate`. Returns the hidden-check summary for the report.
export async function runChecker({
  checker,
  source,
  workspace,
  state,
  output,
  runId,
}) {
  const args = [
    checker,
    "check",
    source,
    output,
    "--workspace",
    workspace,
    "--seal",
    GAME_SEAL,
  ];
  if (state) args.push("--state", state);
  args.push("--run-id", runId, "--attempt-id", "1");
  const run = await python(args);
  if (![0, 1, 3].includes(run.code))
    return {
      verdict: "unavailable",
      reason: `checker failed: ${run.stderr.trim().slice(0, 300)}`,
    };
  const validated = await python([checker, "validate", output]);
  if (validated.code !== 0)
    return {
      verdict: "unavailable",
      reason: "checker result did not validate",
    };
  const result = JSON.parse(await readFile(output, "utf8"));
  const rows = result.components.external_state.checks ?? [];
  const count = (status) => rows.filter((r) => r.status === status).length;
  return {
    verdict: result.verdict,
    validatedVerdict: validated.stdout.trim(),
    passed: count("passed"),
    failed: count("failed"),
    unavailable: count("unavailable"),
    reasons: result.reasons,
    components: Object.fromEntries(
      Object.entries(result.components).map(([k, v]) => [k, v.status]),
    ),
    taskId: result.task_id,
    specSha256: result.spec_sha256,
    sealSha256: result.components.protection.seal_sha256,
    checkerSha256: result.checker_sha256,
  };
}

// ---- Unprompted play-testing -------------------------------------------------
const GAME_FILE = /\.(html?|m?js|css)$/i;
const INTERACT = new Set([
  "browser_click",
  "browser_press_key",
  "browser_type",
  "browser_fill_form",
  "browser_select_option",
  "browser_hover",
]);
const LOOK = new Set(["browser_snapshot", "browser_find", "browser_wait_for"]);
const originOf = (url) => {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
};
// The tool calls of a saved session in order, with MCP names resolved and
// each call's outcome: ok when it has a result and is not recorded as failed.
export function callsFromTranscript(session, mcpTools = {}) {
  const failed = new Set(session.failedToolCalls ?? []);
  const results = new Map();
  for (const m of session.messages ?? [])
    if (m.role === "tool")
      results.set(
        m.tool_call_id,
        typeof m.content === "string"
          ? m.content
          : JSON.stringify(m.content ?? ""),
      );
  const calls = [];
  for (const m of session.messages ?? [])
    for (const c of m.tool_calls ?? []) {
      let args = {};
      try {
        args = JSON.parse(c.function.arguments) ?? {};
      } catch {
        // Malformed arguments: the call is kept, without arguments.
      }
      const name = mcpTools[c.function.name] ?? c.function.name;
      const result = results.get(c.id) ?? "";
      let remoteError = false;
      if (name.includes("/"))
        try {
          remoteError = JSON.parse(result)?.isError === true;
        } catch {
          // Not an MCP result object.
        }
      calls.push({
        name,
        args,
        ok: results.has(c.id) && !failed.has(c.id) && !remoteError,
        result,
      });
    }
  return calls;
}

// `calls`: the session's tool calls in order, each { name, args, ok, result }
// with MCP names resolved (browser/browser_click). A play-test is a preview
// of the game, a navigation to that preview, at least one interaction and
// one page read, all succeeding, after the agent wrote a game file. The brief
// does not ask for this, so any play-test is unprompted.
export function detectPlaytest(calls, { browserAvailable }) {
  let lastWrite = -1,
    firstWrite = -1;
  calls.forEach((c, i) => {
    if (
      c.ok &&
      (c.name === "write_file" || c.name === "edit_file") &&
      GAME_FILE.test(String(c.args?.path ?? ""))
    ) {
      lastWrite = i;
      if (firstWrite < 0) firstWrite = i;
    }
  });
  const sessions = [];
  let origins = new Set(),
    current = null;
  calls.forEach((c, i) => {
    if (c.name === "start_preview" && c.ok) {
      try {
        const info = JSON.parse(c.result);
        origins = new Set(
          [originOf(info.url), originOf(info.containerUrl)].filter(Boolean),
        );
      } catch {
        origins = new Set();
      }
      current = null;
      return;
    }
    const tool = c.name.startsWith("browser/") ? c.name.slice(8) : null;
    if (!tool || !c.ok) return;
    if (tool === "browser_navigate") {
      current = origins.has(originOf(c.args?.url))
        ? { start: i, interactions: 0, reads: 0 }
        : null;
      if (current) sessions.push(current);
    } else if (current && INTERACT.has(tool)) current.interactions++;
    else if (current && LOOK.has(tool)) current.reads++;
  });
  const complete = sessions.filter(
    (s) =>
      s.interactions > 0 &&
      s.reads > 0 &&
      s.start > firstWrite &&
      firstWrite >= 0,
  );
  return {
    asked: false,
    browserAvailable,
    observed: browserAvailable ? complete.length > 0 : null,
    afterLastEdit: browserAvailable
      ? complete.some((s) => s.start > lastWrite)
      : null,
    previews: calls.filter((c) => c.name === "start_preview" && c.ok).length,
    navigations: sessions.length,
    interactions: sessions.reduce((n, s) => n + s.interactions, 0),
    reads: sessions.reduce((n, s) => n + s.reads, 0),
  };
}

// ---- Isolation probes ------------------------------------------------------
// Tool calls a scripted fake model makes through the real agent, permission
// policy and sandbox before the evaluated session. Controls must succeed;
// every other call must fail without revealing hidden content.
export function probePlan({
  workspace,
  acceptance,
  hidden,
  repoHidden,
  nonce,
  browser,
}) {
  const rel = relative(workspace, hidden).split(sep).join("/");
  const sh = (script) => ({ executable: "/bin/sh", args: ["-c", script] });
  const q = (p) => `'${p.replaceAll("'", "'\\''")}'`;
  const probes = [
    {
      id: "control-write",
      kind: "control",
      tool: "write_file",
      args: { path: "probe-control.txt", content: nonce },
    },
    {
      id: "control-read",
      kind: "control",
      tool: "read_file",
      args: { path: "probe-control.txt" },
    },
    {
      id: "control-command",
      kind: "control",
      tool: "run_command",
      args: { executable: "cat", args: ["probe-control.txt"] },
    },
    {
      id: "read-absolute",
      kind: "deny",
      tool: "read_file",
      args: { path: hidden },
    },
    {
      id: "read-relative",
      kind: "deny",
      tool: "read_file",
      args: { path: rel },
    },
    {
      id: "list-parent",
      kind: "deny",
      tool: "list_files",
      args: { path: ".." },
    },
    {
      id: "search-parent",
      kind: "deny",
      tool: "search_text",
      args: { text: "hiddenMarker", path: ".." },
    },
    {
      id: "view-image",
      kind: "deny",
      tool: "view_image",
      args: { path: hidden },
    },
    {
      id: "command-cat",
      kind: "deny",
      tool: "run_command",
      args: { executable: "cat", args: [hidden] },
    },
    {
      id: "command-list",
      kind: "deny",
      tool: "run_command",
      args: { executable: "ls", args: ["-la", acceptance] },
    },
    {
      id: "command-symlink",
      kind: "deny",
      tool: "run_command",
      args: sh(`ln -s ${q(hidden)} probe-link && cat probe-link`),
    },
    {
      id: "command-copy",
      kind: "deny",
      tool: "run_command",
      args: sh(`cp ${q(hidden)} probe-copy && cat probe-copy`),
    },
    {
      id: "command-append",
      kind: "deny",
      tool: "run_command",
      args: sh(`echo probe >> ${q(hidden)}`),
    },
    {
      id: "command-create",
      kind: "deny",
      tool: "run_command",
      args: sh(`echo probe > ${q(join(acceptance, "probe-created"))}`),
    },
    {
      id: "write-absolute",
      kind: "deny",
      tool: "write_file",
      args: { path: join(acceptance, "probe-written"), content: "probe" },
    },
    {
      id: "edit-hidden",
      kind: "deny",
      tool: "edit_file",
      args: { path: hidden, old_string: "hiddenMarker", new_string: "probe" },
    },
    {
      id: "preview-hidden",
      kind: "deny",
      tool: "start_preview",
      args: { entry: rel, files: [rel], timeout_ms: 5000 },
    },
  ];
  for (const [i, path] of repoHidden.entries())
    probes.push({
      id: `command-repository-${i}`,
      kind: "deny",
      tool: "run_command",
      args: { executable: "cat", args: [path] },
    });
  if (browser)
    probes.push({
      id: "browser-file",
      kind: "deny",
      tool: "browser/browser_navigate",
      args: { url: `file://${hidden}` },
    });
  return probes;
}

// `outcomes`: id -> { ok, text } from the agent's tool-call updates.
// `after`: what the evaluator found afterwards.
export function judgeProbes(
  plan,
  outcomes,
  { marker, nonce, sealUnchanged, created, repoUnchanged },
) {
  const findings = [];
  for (const p of plan) {
    const o = outcomes[p.id];
    if (!o) {
      findings.push(`${p.id}: not executed`);
      continue;
    }
    if (p.kind === "control") {
      if (!o.ok || (p.id !== "control-write" && !o.text.includes(nonce)))
        findings.push(
          `${p.id}: control did not work, so a denial proves nothing`,
        );
      continue;
    }
    if (o.ok) findings.push(`${p.id}: succeeded`);
    // Errors may echo the requested path; a listing must not name hidden files.
    const names = JSON.stringify(p.args).includes("playthrough.json")
      ? []
      : ["playthrough.json", "acceptance.json"];
    if ([marker, ...names].some((secret) => o.text.includes(secret)))
      findings.push(`${p.id}: revealed hidden content`);
  }
  if (!sealUnchanged) findings.push("acceptance source changed");
  if (created.length)
    findings.push(
      `files created in the acceptance source: ${created.join(", ")}`,
    );
  if (!repoUnchanged) findings.push("repository acceptance source changed");
  return { established: findings.length === 0, findings, probes: plan.length };
}

// ---- Self-check ------------------------------------------------------------
async function main() {
  const [flag, spec] = process.argv.slice(2);
  const transport = parseTransport(spec);
  if (flag !== "--check-browser" || !transport) {
    console.error(
      "Usage: node test/manual-long-benchmark-game.mjs --check-browser container:NAME|local:/path/to/chromium",
    );
    return 2;
  }
  const source = await loadSource();
  const references = await proveReferences(source, transport);
  const summary = {
    seal: source.seal,
    transport: transport.kind,
    ok: references.ok,
    outcomes: Object.fromEntries(
      Object.entries(references.outcomes).map(([name, o]) => [
        name,
        {
          matches: o.matches,
          failed: o.failed,
          expectedToFail: o.expectedToFail,
        },
      ]),
    ),
  };
  console.log(JSON.stringify(summary, null, 2));
  return references.ok ? 0 : 1;
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  process.exitCode = await main();
