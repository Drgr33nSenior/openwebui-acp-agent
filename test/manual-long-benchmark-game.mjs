// Interactive game task for the long-session benchmark: a public brief, and a
// hidden acceptance source checked through the PLAN-04 task acceptance
// contract (schema 1). Explicit use only; the runner imports this module.
//
// The acceptance source (test/fixtures/long-benchmark-game) holds the
// specification, the agent-visible fixture (the brief only), the hidden
// play-through script, a trusted reference game and known-bug mutants. Its
// seal is pinned below, outside the source and every workspace. After the
// agent's session the evaluator plays the produced game in a real browser,
// captures screenshots and hands the observation to the PLAN-04 checker,
// whose private session was started before the agent's tools were enabled
// (see beginAcceptance); the checker gives the verdict.
//
//   node test/manual-long-benchmark-game.mjs --check-browser container:NAME
//   node test/manual-long-benchmark-game.mjs --check-browser local:/path/to/chromium
//
// plays the trusted reference and every mutant and exits non-zero unless each
// gives its declared outcome. No model is involved.
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  readdir,
  readFile,
  readlink,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { Readable, Writable } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";

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

// ---- Permission policy -----------------------------------------------------
// Shared by the runner's evaluated session, its isolation probes and the
// checker's route probes.
// The browser tools an evaluated agent may use: the wrapper's allowlist.
export const BROWSER_TOOLS = new Set(
  JSON.parse(
    await readFile(
      new URL("../browser/allowed-tools.json", import.meta.url),
      "utf8",
    ),
  ),
);
const originOf = (url) => {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
};
export const updateText = (u) =>
  (u.content ?? [])
    .filter((c) => c.type === "content" && c.content?.type === "text")
    .map((c) => c.content.text)
    .join("\n");

// One permission decision for the evaluated session and the isolation probes.
// Allowed: workspace activation, edits (the agent refuses paths outside the
// workspace before asking), commands in the workspace sandbox without extra
// paths or escalation. For the game task also a static preview and the
// allowlisted browser tools, with navigation only to a preview this session
// started. Everything else is denied.
export function decide(params, { game, previewOrigins, browserUrl }) {
  const title = params.toolCall.title ?? "",
    input = params.toolCall.rawInput ?? {};
  if (title.startsWith("Activate exact workspace ")) return true;
  if (params.toolCall.kind === "edit") return true;
  if (
    title.startsWith("Run ") &&
    title.includes("OS sandbox: workspace") &&
    !/extra reads|extra writes/.test(title) &&
    !input.additional_read_paths?.length &&
    !input.additional_write_paths?.length &&
    input.sandbox_permissions !== "require_escalated"
  )
    return true;
  if (!game) return false;
  if (title.startsWith("Start static preview of ")) return true;
  // Connecting the configured browser server, and no other MCP server.
  if (browserUrl && title.startsWith(`MCP browser: http ${browserUrl};`))
    return true;
  // The agent marks every HTTP MCP server as running outside its sandbox.
  const call = title.match(
    /^Call browser\/(browser_[a-z_]+)(?: \(runs on this machine outside the sandbox\))?: (.*)$/s,
  );
  if (!call || !BROWSER_TOOLS.has(call[1])) return false;
  let args;
  try {
    args = JSON.parse(call[2]);
  } catch {
    return false;
  }
  if (!args || typeof args !== "object") return false;
  const preview = (url) => previewOrigins.has(originOf(url));
  // Browser-initiated navigation reaches any URL, file:// included: only a
  // preview this session started. browser_tabs can open a tab at a URL.
  if (call[1] === "browser_navigate") return preview(args.url);
  if (call[1] === "browser_tabs") {
    if (["list", "select", "close"].includes(args.action))
      return args.url === undefined;
    return (
      args.action === "new" && (args.url === undefined || preview(args.url))
    );
  }
  // No other allowlisted tool takes a URL; refuse one that does.
  return !Object.keys(args).some((key) => /url/i.test(key));
}

// Records the origins of a preview the agent started, from its result.
export function trackPreview(u, tools, previewOrigins) {
  if (
    u.sessionUpdate !== "tool_call_update" ||
    u.status !== "completed" ||
    tools.get(u.toolCallId) !== "start_preview"
  )
    return;
  try {
    const info = JSON.parse(updateText(u));
    for (const url of [info.url, info.containerUrl])
      if (originOf(url)) previewOrigins.add(originOf(url));
  } catch {
    // Not a preview result.
  }
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
// The checker accepts an attempt only through its private session protocol
// (stack PR #243): the parent starts task_acceptance_session.py BEFORE the
// agent's tools are enabled, pins the complete checker manifest, keeps a
// fixed capability lease for the whole attempt, performs each access probe
// through the agent's real routes and sends the play-through observation over
// the session's private pipe. A one-shot `check` returns `unavailable`
// (`protection:attempt-lifetime-not-established`).
//
// The protocol this harness implements is pinned by the bootstrap's digest.
// Any other bootstrap, or a checker without one, is refused before a session.
export const CHECKER_SESSION = {
  file: "task_acceptance_session.py",
  sha256: "619316431b1f3460ea042b4eafd6e944bd00d5f95f31ebcb6b14f31ccad20b0c",
  stackCommit: "7c2ff064a30964eb701ec19c7e55c4ee4752d9fe",
};
// The complete checker this harness accepts: the canonical digest of the
// manifest (every *.py beside task_acceptance.py, as the bootstrap computes
// it), its size and the modules that decide and record a verdict. Stack
// commit 59eac79 is the final PLAN-04 producer with the PLAN-01 run-record
// correction; run_record.py is one of the 58 modules. Any other manifest,
// even with the same bootstrap, is refused before a session starts.
export const CHECKER_MANIFEST = {
  sha256: "c85163f80abe3d4bcbec790c4c81251d5b34fd632265dbecb3a9d822c8def22e",
  files: 58,
  modules: {
    "task_acceptance.py":
      "4e48e1516f050d8e4382b74e02038cc23aa8783be29e80110773978ef4ba4212",
    "run_record.py":
      "403f9dbd0c9967044f1a90b5684523cac8dc5cad5d705666804c374e93f1c66e",
  },
  stackCommit: "59eac797b611680190b5e7de8251c4b8fd96f6a8",
};

// Compares a manifest (relative path -> SHA-256) with CHECKER_MANIFEST.
// Returns null when it is the pinned checker, else the reason it is not.
export function manifestMismatch(files) {
  const digest = sha256(canonical(files));
  const count = Object.keys(files).length;
  const modules = Object.entries(CHECKER_MANIFEST.modules)
    .filter(([name, hash]) => files[name] !== hash)
    .map(([name]) => name);
  if (
    digest === CHECKER_MANIFEST.sha256 &&
    count === CHECKER_MANIFEST.files &&
    !modules.length
  )
    return null;
  return (
    `the checker manifest (${count} files, SHA-256 ${digest}` +
    (modules.length ? `; differing: ${modules.join(", ")}` : "") +
    `) is not the pinned checker (${CHECKER_MANIFEST.files} files, ` +
    `${CHECKER_MANIFEST.sha256.slice(0, 12)}…, stack ` +
    `${CHECKER_MANIFEST.stackCommit.slice(0, 7)})`
  );
}
// Every way the agent's tools reach files, named by their enforcement point:
//   agent-file-tools: the agent's workspace path guard. read_file, write_file,
//     edit_file, list_files, search_text, view_image and start_preview all
//     resolve paths through it. The browser reaches files only through a
//     preview: the permission policy allows navigation to preview origins only.
//   agent-sandboxed-commands: run_command, foreground or background, in the
//     agent's OS sandbox.
export const ROUTES = ["agent-file-tools", "agent-sandboxed-commands"];
// Exposed routes the checker does not probe and the harness does not either.
// None: an exposed route that nobody probes would leave protection unproven.
export const UNPROBED_ROUTES = [];
// Routes the harness probes itself, through the agent's real tools and the
// same permission policy, before and after the attempt (isolation probes).
export const HARNESS_ROUTES = [
  {
    route: "browser-mcp",
    proof:
      "not registered with the checker, whose controls need host-file access that the browser does not have; the isolation probes, before and after the attempt, require the configured browser to read a workspace preview (positive control), show that a file link, a new-tab link with tab selection, window.open, a meta refresh with a script redirect and history never reach the hidden file, and show that the permission policy refuses browser_navigate and browser_tabs new to a file or to another origin",
  },
];
const OPERATIONS = new Set(["read", "write", "create", "rename", "unlink"]);
const CHECKER_VARIABLE = "LONG_BENCHMARK_ACCEPTANCE_CHECKER";
const MAX_CHECKER_FILE = 2 * 1024 * 1024;
const PHASE_TIMEOUT_MS = 20 * 60000;
const PROBE_TIMEOUT_MS = 120000;
const RUNNER = fileURLToPath(
  new URL("./manual-long-benchmark.mjs", import.meta.url),
);

// The complete checker manifest: every *.py below the directory of
// task_acceptance.py (as the session bootstrap computes it), with the bytes
// read once here. Refused unless the bootstrap is the supported protocol.
export async function checkerIdentity(path) {
  if (!path || !isAbsolute(path) || basename(path) !== "task_acceptance.py")
    return {
      unavailable: `${CHECKER_VARIABLE} is not an absolute path to task_acceptance.py`,
    };
  const directory = dirname(path),
    contents = {};
  async function walk(folder) {
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      const full = join(folder, entry.name);
      if (entry.isDirectory() && entry.name !== "__pycache__") await walk(full);
      else if (entry.name.endsWith(".py") && !entry.isDirectory()) {
        const info = await lstat(full);
        if (!info.isFile() || info.size > MAX_CHECKER_FILE)
          throw new Error(`${entry.name} is not a bounded regular file`);
        contents[relative(directory, full).split(sep).join("/")] =
          await readFile(full);
      }
    }
  }
  try {
    await walk(directory);
  } catch (error) {
    return {
      unavailable: `${CHECKER_VARIABLE}: the checker files are not readable (${error.message})`,
    };
  }
  const files = Object.fromEntries(
    Object.keys(contents)
      .sort()
      .map((name) => [name, sha256(contents[name])]),
  );
  const session = files[CHECKER_SESSION.file];
  const supported = `${CHECKER_SESSION.sha256.slice(0, 12)}…, stack ${CHECKER_SESSION.stackCommit.slice(0, 7)}`;
  if (!session)
    return {
      unavailable: `${CHECKER_VARIABLE}: the checker has no ${CHECKER_SESSION.file}; it predates the PLAN-04 session protocol that this harness requires (${supported})`,
    };
  if (session !== CHECKER_SESSION.sha256)
    return {
      unavailable: `${CHECKER_VARIABLE}: ${CHECKER_SESSION.file} has SHA-256 ${session}, not the session protocol that this harness implements (${supported}); update the harness for that checker`,
    };
  const mismatch = manifestMismatch(files);
  if (mismatch) return { unavailable: `${CHECKER_VARIABLE}: ${mismatch}` };
  return {
    path,
    files,
    contents,
    treeSha256: sha256(canonical(files)),
  };
}

// Copies the verified checker bytes to a new private directory outside the
// workspace; the session runs from there. Returns that directory.
export async function installChecker(identity, destination) {
  await copySource({ files: identity.contents }, destination);
  return destination;
}

function python(args) {
  return new Promise((done) => {
    const child = spawn("python3", ["-E", "-s", "-B", ...args], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { PATH: process.env.PATH, HOME: process.env.HOME },
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

// The session bootstrap as a child with private pipes. `begin(route)` sends
// the start message and services the setup probes until the checker is ready;
// `finish(final, route)` sends the observation and services the final probes
// until the result. `route(name, operation, path)` returns the outcome of one
// probe. Nothing from these pipes reaches the agent.
export function openCheckerSession({ directory, start }) {
  const lease = start.capability_lease;
  const child = spawn(
    "python3",
    ["-I", "-B", join(directory, CHECKER_SESSION.file)],
    {
      cwd: directory,
      stdio: ["pipe", "pipe", "pipe"],
      env: { PATH: process.env.PATH },
    },
  );
  const queue = [];
  let buffer = "",
    stderr = "",
    ended = null,
    wake = null,
    probes = 0;
  const exited = new Promise((done) =>
    child.on("close", (code) => {
      ended ??= { code };
      wake?.();
      done(code);
    }),
  );
  child.on("error", (error) => {
    ended = { error: error.message };
    wake?.();
  });
  child.stdin.on("error", () => {
    // The session has ended; the next read reports why.
  });
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let end;
    while ((end = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      try {
        const message = JSON.parse(line);
        queue.push(
          message && typeof message === "object" ? message : { malformed: 1 },
        );
      } catch {
        queue.push({ malformed: true });
      }
    }
    wake?.();
  });
  child.stderr.on("data", (chunk) => {
    if (stderr.length < 4000) stderr += chunk;
  });
  const next = async (deadline) => {
    while (!queue.length && !ended && Date.now() < deadline) {
      let timer;
      await new Promise((r) => {
        wake = r;
        timer = setTimeout(r, deadline - Date.now());
      });
      clearTimeout(timer);
      wake = null;
    }
    return queue.shift() ?? null;
  };
  const why = () => {
    if (ended?.error) return `checker session could not start: ${ended.error}`;
    const last = stderr.trim().split("\n").at(-1)?.slice(0, 300);
    return `checker session ended${ended ? ` with status ${ended.code}` : ""}: ${last || "no message"}`;
  };
  async function exchange(message, route, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    child.stdin.write(JSON.stringify(message) + "\n");
    for (;;) {
      const m = await next(deadline);
      if (!m) {
        const reason =
          ended || queue.length ? why() : "checker session timed out";
        child.kill("SIGKILL");
        return { unavailable: reason };
      }
      if (m.malformed) {
        child.kill("SIGKILL");
        return { unavailable: "checker session sent a malformed message" };
      }
      if (!("probe" in m)) return m;
      probes++;
      let outcome = "unavailable";
      if (
        m.capability_lease === lease &&
        ROUTES.includes(m.route) &&
        OPERATIONS.has(m.probe) &&
        typeof m.path === "string" &&
        isAbsolute(m.path)
      )
        outcome = await route(m.route, m.probe, m.path).catch(
          () => "unavailable",
        );
      child.stdin.write(
        JSON.stringify({ outcome, capability_lease: lease }) + "\n",
      );
    }
  }
  return {
    get probes() {
      return probes;
    },
    async begin(route, timeoutMs = PHASE_TIMEOUT_MS) {
      const m = await exchange(start, route, timeoutMs);
      if (m.unavailable) return { ready: false, reason: m.unavailable };
      if (m.capability_lease !== lease || typeof m.ready !== "boolean") {
        child.kill("SIGKILL");
        return {
          ready: false,
          reason: "checker session answered off-protocol",
        };
      }
      return { ready: m.ready, protection: m.protection ?? null };
    },
    async finish(final, route, timeoutMs = PHASE_TIMEOUT_MS) {
      const m = await exchange(
        { ...final, capability_lease: lease },
        route,
        timeoutMs,
      );
      if (m.unavailable) return m;
      if (!m.result || typeof m.result !== "object") {
        child.kill("SIGKILL");
        return { unavailable: "checker session sent no result" };
      }
      let timer;
      const exitCode = await Promise.race([
        exited,
        new Promise((r) => (timer = setTimeout(() => r(null), 30000))),
      ]);
      clearTimeout(timer);
      if (exitCode === null) child.kill("SIGKILL");
      return { result: m.result, exitCode };
    },
    close() {
      if (!ended) child.kill("SIGKILL");
    },
  };
}

// One checker probe as one tool call through a route. Read and write open a
// file without returning or changing its bytes; create, rename and unlink
// receive only the checker's own sacrificial directories. null: the route
// does not expose that capability (no file tool renames or deletes a path).
export function routeCall(route, operation, path, nonce) {
  if (route === "agent-file-tools") {
    if (operation === "read")
      return { tool: "read_file", args: { path, limit: 1 } };
    // Replacing a random text with itself: a match changes nothing, and no
    // match fails after the path passed the write check.
    if (operation === "write")
      return {
        tool: "edit_file",
        args: { path, old_string: nonce, new_string: nonce },
      };
    if (operation === "create")
      return {
        tool: "write_file",
        args: { path: join(path, "created"), content: "" },
      };
    return null;
  }
  const action = {
    read: 'true <"$1"',
    write: 'true >>"$1"',
    create: 'mkdir "$1/created"',
    rename: 'mv "$1" "$1.moved"',
    unlink: 'rm "$1/entry"',
  }[operation];
  return {
    tool: "run_command",
    args: {
      executable: "/bin/sh",
      args: [
        "-c",
        `exec 2>&1; if ${action}; then echo probe-allowed; else echo probe-failed; fi`,
        "probe",
        path,
      ],
    },
  };
}
// EPERM, EACCES, ENOENT and EROFS as the shell reports them, at the end of an
// error line, so an echoed path or label cannot match. dash (Linux /bin/sh)
// reports ENOENT as "No such file", or on a redirection's directory as
// "Directory nonexistent": what a sandbox that hides a path gives.
const COMMAND_DENIAL =
  /: (operation not permitted|permission denied|no such file( or directory)?|directory nonexistent|read-only file system)$/im;
const FILE_DENIAL =
  /Path outside permitted scope|Application state is outside tool scope|Agent executable and dependency files are protected|Protected path:|Symlink access refused|Hard-linked file refused|does not exist|EACCES|EPERM|ENOENT/;
// `allowed`, `denied` or `unavailable` from one tool call's result. A tool
// failure that is not a refusal of the path is unavailable, never a denial.
export function routeOutcome(route, operation, { ok, text }) {
  if (route === "agent-sandboxed-commands") {
    // run_command returns {"code":N,"output":"..."}; the script exits 0.
    let output = null;
    try {
      const result = JSON.parse(text);
      if (ok && result.code === 0) output = String(result.output);
    } catch {
      // Not a command result: the command did not run.
    }
    if (output === null) return "unavailable";
    if (/^probe-allowed$/m.test(output)) return "allowed";
    return /^probe-failed$/m.test(output) && COMMAND_DENIAL.test(output)
      ? "denied"
      : "unavailable";
  }
  if (ok) return "allowed";
  if (operation === "write" && /old_string matched 0 occurrences/.test(text))
    return "allowed";
  return FILE_DENIAL.test(text) ? "denied" : "unavailable";
}

// A scripted model drives the agent build under test, through the runner's
// child wrapper, permission policy and sandbox, in the evaluated workspace
// with its own state: each probe is one tool call. Only outcomes are kept.
export async function startRouteAgent({ agentDirectory, workspace, state }) {
  const require = createRequire(join(agentDirectory, "package.json"));
  const { ClientApp, ndJsonStream } = await import(
    pathToFileURL(require.resolve("@agentclientprotocol/sdk")).href
  );
  const nonce = `route-probe-${randomUUID()}`;
  // Only the route agent knows this path: other local processes get 404.
  const secret = `/${randomUUID()}`;
  const pending = new Map(),
    calls = [];
  let waiting = null,
    closing = false,
    broken = null,
    count = 0;
  const nextCall = () =>
    calls.length || closing
      ? Promise.resolve(calls.shift() ?? null)
      : new Promise((r) => (waiting = r));
  const server = createServer(async (req, res) => {
    res.setHeader("Content-Type", "application/json");
    if (!req.url?.startsWith(`${secret}/`)) {
      res.statusCode = 404;
      return res.end("{}");
    }
    if (req.url === `${secret}/api/models`)
      return res.end(JSON.stringify({ data: [{ id: "route-probe" }] }));
    let raw = "",
      request;
    for await (const part of req) raw += part;
    try {
      request = JSON.parse(raw);
    } catch {
      res.statusCode = 400;
      return res.end("{}");
    }
    const call = request?.tools?.length ? await nextCall() : null;
    const message = call
      ? {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: call.id,
              type: "function",
              function: {
                name: call.tool,
                arguments: JSON.stringify(call.args),
              },
            },
          ],
        }
      : { role: "assistant", content: "Route probes finished." };
    res.end(
      JSON.stringify({
        choices: [{ message, finish_reason: call ? "tool_calls" : "stop" }],
      }),
    );
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  await mkdir(state, { mode: 0o700 });
  await writeFile(
    join(state, "config.json"),
    JSON.stringify({
      url: `http://127.0.0.1:${server.address().port}${secret}`,
      model: "route-probe",
      rounds: 100,
    }),
    { mode: 0o600 },
  );
  // A synthetic key: route probes never use the real credential.
  const env = {
    PATH: process.env.PATH,
    HOME: homedir(),
    OPENWEBUI_ACP_HOME: state,
    OPENWEBUI_API_KEY: "synthetic-route-probe",
  };
  if (process.env.TMPDIR) env.TMPDIR = process.env.TMPDIR;
  const child = spawn(process.execPath, [RUNNER, "--child", agentDirectory], {
    cwd: workspace,
    env,
    stdio: ["pipe", "pipe", "ignore"],
  });
  const fail = (reason) => {
    broken ??= reason;
    for (const [, resolve] of pending)
      resolve({ ok: false, text: `route agent unavailable: ${broken}` });
    pending.clear();
  };
  child.on("exit", () => fail("agent exited"));
  const app = new ClientApp();
  app.onNotification("session/update", ({ params }) => {
    const u = params.update;
    if (
      u.sessionUpdate === "tool_call_update" &&
      ["completed", "failed"].includes(u.status) &&
      pending.has(u.toolCallId)
    ) {
      const resolve = pending.get(u.toolCallId);
      pending.delete(u.toolCallId);
      resolve({ ok: u.status === "completed", text: updateText(u) });
    }
  });
  app.onRequest("session/request_permission", ({ params }) => ({
    outcome: {
      outcome: "selected",
      optionId: decide(params, {
        game: true,
        previewOrigins: new Set(),
        browserUrl: null,
      })
        ? "once"
        : "deny",
    },
  }));
  const connection = app.connect(
    ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout)),
  );
  const close = async () => {
    closing = true;
    waiting?.(null);
    waiting = null;
    let timer;
    await Promise.race([
      driving,
      new Promise((r) => (timer = setTimeout(r, 30000))),
    ]);
    clearTimeout(timer);
    connection.close();
    child.kill("SIGTERM");
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  };
  let driving = Promise.resolve();
  try {
    await connection.agent.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: {},
    });
    const { sessionId } = await connection.agent.request("session/new", {
      cwd: workspace,
      mcpServers: [],
    });
    // The agent ends a turn after 64 tool calls; continue until closed.
    driving = (async () => {
      while (!closing) {
        const { stopReason } = await connection.agent.request(
          "session/prompt",
          {
            sessionId,
            prompt: [{ type: "text", text: "Run the route probes." }],
          },
        );
        if (!closing && stopReason !== "max_turn_requests")
          return fail(`turn ended: ${stopReason}`);
      }
    })().catch((error) => fail(String(error?.message ?? error)));
  } catch (error) {
    await close();
    throw error;
  }
  const call = (tool, args) =>
    new Promise((resolve) => {
      if (broken)
        return resolve({
          ok: false,
          text: `route agent unavailable: ${broken}`,
        });
      const id = `route-${++count}`;
      const item = { id, tool, args };
      const timer = setTimeout(() => {
        pending.delete(id);
        // Never handed to the model later.
        if (calls.includes(item)) calls.splice(calls.indexOf(item), 1);
        resolve({ ok: false, text: "route probe timed out" });
      }, PROBE_TIMEOUT_MS);
      pending.set(id, (result) => {
        clearTimeout(timer);
        resolve(result);
      });
      if (waiting) {
        const w = waiting;
        waiting = null;
        w(item);
      } else calls.push(item);
    });
  return {
    async probe(route, operation, path) {
      const planned = routeCall(route, operation, path, nonce);
      if (!planned) return "unsupported";
      return routeOutcome(
        route,
        operation,
        await call(planned.tool, planned.args),
      );
    },
    close,
  };
}

async function withRouteAgent(options, work) {
  let agent;
  try {
    agent = await startRouteAgent(options);
  } catch (error) {
    return {
      unavailable: `route agent did not start: ${String(error?.message ?? error).slice(0, 200)}`,
    };
  }
  try {
    return await work((...probe) => agent.probe(...probe));
  } finally {
    await agent.close();
  }
}

// The administrator policy the agent reads (src/policy.ts, policyPath).
const ADMIN_POLICY =
  process.platform === "darwin"
    ? "/private/etc/openwebui-acp-agent/policy.json"
    : "/etc/openwebui-acp-agent/policy.json";
// One entry by content: a file's SHA-256 at any size, a link by its target
// (never followed), otherwise its kind; `absent` when missing.
async function entryDigest(path) {
  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    if (error.code === "ENOENT") return "absent";
    throw error;
  }
  if (info.isSymbolicLink()) return `link:${await readlink(path)}`;
  if (info.isFile()) return sha256(await readFile(path));
  return info.isDirectory() ? "directory" : "special";
}
async function treeDigests(root, prefix, into) {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    into[prefix] = "absent";
    return;
  }
  for (const entry of entries.sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  )) {
    const path = join(root, entry.name),
      name = `${prefix}/${entry.name}`;
    if (entry.isDirectory()) await treeDigests(path, name, into);
    else into[name] = await entryDigest(path);
  }
}
// Digest of what fixes the agent's capabilities for the attempt: its build,
// dependencies and package files, the harness code that wraps it and decides
// its permissions, the administrator policy and the configuration files the
// checker protects. The lease is sent with the final message only if this is
// unchanged.
export async function capabilityPolicy(agentDirectory, configuration) {
  const digests = {};
  for (const tree of ["dist", "node_modules"])
    await treeDigests(join(agentDirectory, tree), tree, digests);
  for (const name of ["package.json", "package-lock.json"])
    digests[name] = await entryDigest(join(agentDirectory, name));
  digests["harness:runner"] = await entryDigest(RUNNER);
  digests["harness:policy"] = await entryDigest(fileURLToPath(import.meta.url));
  digests["administrator-policy"] = await entryDigest(ADMIN_POLICY);
  for (const path of configuration) digests[path] = await entryDigest(path);
  return sha256(canonical(digests));
}

const sameTree = (a, b) =>
  JSON.stringify(Object.keys(a.files)) ===
    JSON.stringify(Object.keys(b.files)) &&
  Object.keys(a.files).every((name) => a.files[name].equals(b.files[name])) &&
  JSON.stringify(a.refused) === JSON.stringify(b.refused);

// Counts of the checker's probe rows and controls, without paths.
const probeSummary = (record) => {
  if (!record || typeof record !== "object") return null;
  const tally = (rows) =>
    (Array.isArray(rows) ? rows : []).reduce(
      (t, row) => ({ ...t, [row.status]: (t[row.status] ?? 0) + 1 }),
      {},
    );
  return {
    status: record.status ?? null,
    reason: record.reason ?? null,
    probes: tally(record.probes),
    controls: tally(record.controls),
  };
};

// Starts the checker's private session before the agent's tools are enabled.
// `checker` is the identity from checkerIdentity with `installed`, the private
// copy it runs from. Returns { ready, reason, record, finish, close }; enable
// the agent only when `ready` is true. The session stays alive until finish.
export async function beginAcceptance({
  checker,
  acceptance,
  workspace,
  configuration,
  agentDirectory,
  scratch,
  runId,
}) {
  const lease = `lease-${randomUUID()}`;
  const policy = await capabilityPolicy(agentDirectory, configuration);
  const session = openCheckerSession({
    directory: checker.installed,
    start: {
      source: acceptance,
      workspace,
      seal: GAME_SEAL,
      checker: checker.files,
      configuration,
      routes: ROUTES,
      capability_lease: lease,
      run_id: runId,
      attempt_id: "1",
    },
  });
  const unchanged = await readTree(workspace, { strict: false });
  const begun = await withRouteAgent(
    { agentDirectory, workspace, state: join(scratch, "route-probe-setup") },
    (route) => session.begin(route),
  );
  const record = {
    protocol: CHECKER_SESSION.sha256,
    routes: ROUTES,
    unprobedRoutes: UNPROBED_ROUTES,
    harnessRoutes: HARNESS_ROUTES,
    ready: begun.ready === true,
    setupProbes: session.probes,
    protection: probeSummary(begun.protection),
  };
  let reason = begun.reason ?? begun.unavailable;
  if (begun.ready === false && !reason)
    reason = `protection ${record.protection?.status ?? "unknown"}${record.protection?.reason ? ` (${record.protection.reason})` : ""}`;
  if (
    !reason &&
    !sameTree(unchanged, await readTree(workspace, { strict: false }))
  )
    reason = "the workspace changed during the setup probes";
  if (reason) {
    session.close();
    record.ready = false;
    return { ready: false, reason, record, close() {} };
  }
  return {
    ready: true,
    record,
    close: () => session.close(),
    // The observation is the evaluator's fresh play-through, or null when it
    // could not run. Writes the checker's result to `output`.
    async finish({ observation, output }) {
      if ((await capabilityPolicy(agentDirectory, configuration)) !== policy) {
        session.close();
        return {
          unavailable:
            "the agent's capability policy changed during the attempt",
        };
      }
      const before = session.probes;
      const done = await withRouteAgent(
        {
          agentDirectory,
          workspace,
          state: join(scratch, "route-probe-final"),
        },
        (route) => session.finish(observation ? { observation } : {}, route),
      );
      record.finalProbes = session.probes - before;
      if (done.unavailable) return done;
      await writeFile(output, JSON.stringify(done.result, null, 2) + "\n", {
        mode: 0o600,
        flag: "wx",
      });
      return { exitCode: done.exitCode };
    },
  };
}

// Validates a written result with the checker's own `validate` and returns
// the summary for the report.
export async function summarizeResult({ checker, output }) {
  const validated = await python([checker, "validate", output]);
  if (validated.code !== 0)
    return {
      verdict: "unavailable",
      reason: "checker result did not validate",
    };
  const result = JSON.parse(await readFile(output, "utf8"));
  const rows = result.components.external_state.checks ?? [];
  const count = (status) => rows.filter((r) => r.status === status).length;
  const protection = result.components.protection;
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
    protection: probeSummary(protection),
    taskId: result.task_id,
    specSha256: result.spec_sha256,
    sealSha256: protection.seal_sha256,
    checkerSha256: result.checker_sha256,
    checkerTreeSha256: protection.checker_tree_sha256 ?? null,
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
  otherOrigin = "http://127.0.0.1:9",
}) {
  const rel = relative(workspace, hidden).split(sep).join("/");
  const sh = (script) => ({ executable: "/bin/sh", args: ["-c", script] });
  const q = (p) => `'${p.replaceAll("'", "'\\''")}'`;
  const probes = [
    {
      id: "control-write",
      kind: "control",
      tool: "write_file",
      // End the marker's line so conservative credential-prefix redaction at
      // EOF cannot mask an innocent final character of the nonce.
      args: { path: "probe-control.txt", content: `${nonce}\n` },
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
  if (browser) probes.push(...browserProbes({ hidden, nonce, otherOrigin }));
  return probes;
}

// The browser route, through the agent's real browser tools and the same
// permission policy: a positive control (the agent previews a page in its
// workspace and the browser reads its nonce), then every way the browser
// could be steered to the hidden file. Browser-initiated navigation (direct,
// a new tab at a URL, another origin) must be refused by the policy; page-
// initiated navigation (a link, a new-tab link, window.open, a meta refresh
// and a script redirect, history) must not reach the file. The hidden marker
// may appear in no result. Steps with `next` are computed from the previous
// tool result; `null` skips an optional step.
export function browserProbes({ hidden, nonce, otherOrigin }) {
  const target = pathToFileURL(hidden).href;
  const html = (body) =>
    `<!doctype html><meta charset="utf-8"><title>probe</title>${body}`;
  const files = {
    "browser-control.html": html(
      `<p>${nonce}</p><a href="${target}">file link</a> ` +
        `<a target="_blank" href="${target}">tab link</a> ` +
        `<a href="redirect.html">redirect link</a> ` +
        `<button id="open">open window</button>` +
        `<script src="browser-control.js"></script>`,
    ),
    "browser-control.js": `document.getElementById("open").addEventListener("click", () => window.open(${JSON.stringify(target)}));\n`,
    "redirect.html": html(
      `<meta http-equiv="refresh" content="0;url=${target}"><p>redirecting</p><script src="redirect.js"></script>`,
    ),
    "redirect.js": `location.href = ${JSON.stringify(target)};\n`,
  };
  const ref = (last, name) =>
    String(last ?? "")
      .replaceAll("\\n", "\n")
      .replaceAll('\\"', '"')
      .match(
        new RegExp(`(?:link|button) "${name}"[^\\n]*?\\[ref=([a-z0-9]+)\\]`),
      )?.[1];
  const tabs = (last) =>
    Math.max(
      0,
      ...[...String(last ?? "").matchAll(/- (\d+):/g)].map((m) => Number(m[1])),
    );
  const nav = (memo) => memo.origin;
  // Return to the control page and read it, before each page-initiated try.
  const reopen = (id) => [
    {
      id: `${id}-reopen`,
      kind: "attempt",
      tool: "browser/browser_navigate",
      next: (_, memo) => (nav(memo) ? { url: nav(memo) } : null),
    },
    {
      id: `${id}-look-control`,
      kind: "look",
      tool: "browser/browser_snapshot",
      next: () => ({}),
    },
  ];
  const click = (id, name, element) => ({
    id,
    kind: "attempt",
    tool: "browser/browser_click",
    next: (last) => {
      const target = ref(last, name);
      return target ? { target, element } : null;
    },
  });
  const newTab = (id) => [
    {
      id: `${id}-tabs`,
      kind: "look",
      tool: "browser/browser_tabs",
      next: () => ({ action: "list" }),
    },
    {
      id: `${id}-select`,
      kind: "attempt",
      tool: "browser/browser_tabs",
      next: (last) => ({ action: "select", index: tabs(last) }),
    },
    {
      id: `${id}-look`,
      kind: "look",
      tool: "browser/browser_snapshot",
      next: () => ({}),
    },
    {
      id: `${id}-home`,
      kind: "attempt",
      tool: "browser/browser_tabs",
      next: () => ({ action: "select", index: 0 }),
    },
  ];
  return [
    ...Object.entries(files).map(([path, content]) => ({
      id: `browser-write-${path}`,
      kind: "control",
      tool: "write_file",
      args: { path, content },
    })),
    {
      id: "browser-preview",
      kind: "control",
      tool: "start_preview",
      args: {
        entry: "browser-control.html",
        files: Object.keys(files),
        timeout_ms: 300000,
      },
    },
    // A browser on this host opens `url`; the documented container opens
    // `containerUrl`. The first one that shows the nonce is the control.
    {
      id: "browser-open-host",
      kind: "attempt",
      tool: "browser/browser_navigate",
      next: (last, memo) => {
        try {
          memo.preview = JSON.parse(last);
        } catch {
          return null;
        }
        return { url: memo.preview.url };
      },
    },
    {
      id: "browser-look-host",
      kind: "look",
      tool: "browser/browser_snapshot",
      next: () => ({}),
      after: (text, memo) => {
        if (text.includes(nonce)) memo.origin = memo.preview?.url;
      },
    },
    {
      id: "browser-open-container",
      kind: "attempt",
      optional: true,
      tool: "browser/browser_navigate",
      next: (_, memo) =>
        memo.origin || !memo.preview
          ? null
          : { url: memo.preview.containerUrl },
    },
    {
      id: "browser-look-container",
      kind: "look",
      optional: true,
      tool: "browser/browser_snapshot",
      next: (_, memo) => (memo.origin ? null : {}),
      after: (text, memo) => {
        if (text.includes(nonce)) memo.origin = memo.preview?.containerUrl;
      },
    },
    {
      id: "browser-control",
      kind: "browser-control",
      of: ["browser-look-host", "browser-look-container"],
    },
    ...reopen("browser-link"),
    click("browser-link", "file link", "file link"),
    {
      id: "browser-link-look",
      kind: "look",
      tool: "browser/browser_snapshot",
      next: () => ({}),
    },
    ...reopen("browser-tab-link"),
    click("browser-tab-link", "tab link", "new-tab link"),
    ...newTab("browser-tab-link"),
    ...reopen("browser-window"),
    click("browser-window", "open window", "window.open button"),
    ...newTab("browser-window"),
    ...reopen("browser-redirect"),
    click("browser-redirect", "redirect link", "redirect page link"),
    {
      id: "browser-redirect-wait",
      kind: "attempt",
      tool: "browser/browser_wait_for",
      next: () => ({ time: 2 }),
    },
    {
      id: "browser-redirect-look",
      kind: "look",
      tool: "browser/browser_snapshot",
      next: () => ({}),
    },
    {
      id: "browser-back",
      kind: "attempt",
      tool: "browser/browser_navigate_back",
      next: () => ({}),
    },
    {
      id: "browser-back-look",
      kind: "look",
      tool: "browser/browser_snapshot",
      next: () => ({}),
    },
    // Browser-initiated navigation: the permission policy must refuse it.
    {
      id: "browser-navigate-file",
      kind: "deny",
      tool: "browser/browser_navigate",
      args: { url: target },
    },
    {
      id: "browser-new-tab-file",
      kind: "deny",
      tool: "browser/browser_tabs",
      args: { action: "new", url: target },
    },
    {
      id: "browser-navigate-other",
      kind: "deny",
      tool: "browser/browser_navigate",
      args: { url: `${otherOrigin}/` },
    },
  ];
}

// `outcomes`: id -> { ok, text } from the agent's tool-call updates, or
// { skipped: true } for a computed step that did not apply.
// `after`: what the evaluator found afterwards.
export function judgeProbes(
  plan,
  outcomes,
  { marker, nonce, sealUnchanged, created, repoUnchanged },
) {
  const findings = [];
  for (const p of plan) {
    if (p.kind === "browser-control") {
      // The browser read the agent's own preview: denials below mean something.
      if (!p.of.some((id) => outcomes[id]?.text?.includes(nonce)))
        findings.push(
          `${p.id}: the browser did not read the workspace preview, so a denial proves nothing`,
        );
      continue;
    }
    const o = outcomes[p.id];
    if (!o || (o.skipped && !p.optional)) {
      findings.push(`${p.id}: not executed`);
      continue;
    }
    if (o.skipped) continue;
    if (p.kind === "control") {
      const read = p.id === "control-read" || p.id === "control-command";
      if (!o.ok || (read && !o.text.includes(nonce)))
        findings.push(
          `${p.id}: control did not work, so a denial proves nothing`,
        );
      continue;
    }
    if (p.kind === "deny" && o.ok) findings.push(`${p.id}: succeeded`);
    // A look must have observed the page; an attempt may fail either way.
    if (p.kind === "look" && !o.ok)
      findings.push(`${p.id}: the browser state could not be read`);
    // Errors and page snapshots may echo the requested path (a link's URL);
    // a listing must not name hidden files, and no result may hold content.
    const names =
      p.tool.startsWith("browser/") ||
      JSON.stringify(p.args ?? {}).includes("playthrough.json")
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
