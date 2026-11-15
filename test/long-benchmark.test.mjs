// Offline self-test for the long-session benchmark kit
// (test/manual-long-benchmark*.mjs). No model, no network beyond a loopback
// fake Open WebUI, no site settings and a fresh temporary application state.
import assert from "node:assert/strict";
import test from "node:test";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const temporary = await realpath(
  await mkdtemp(join(tmpdir(), "ow-long-test-")),
);
process.env.OPENWEBUI_ACP_HOME = join(temporary, "unused-state");
test.after(() => rm(temporary, { recursive: true, force: true }));

const { longTask } = await import("./manual-long-benchmark-fixture.mjs");
const wait = await import("./manual-long-benchmark-wait.mjs");
const { summaryRow, markdown } =
  await import("./manual-long-benchmark-summary.mjs");
const here = dirname(fileURLToPath(import.meta.url));
const checkout = dirname(here);
const python = spawnSync("python3", ["--version"]).status === 0;

async function project(task) {
  const dir = await mkdtemp(join(temporary, "fixture-"));
  for (const [path, content] of Object.entries(task.files))
    await writeFile(join(dir, path), content);
  return dir;
}
const unittest = (cwd) =>
  spawnSync("python3", ["-m", "unittest"], {
    cwd,
    encoding: "utf8",
    env: { PATH: process.env.PATH, PYTHONDONTWRITEBYTECODE: "1" },
  });

test("the fixture is deterministic and sized as documented", () => {
  const a = longTask(),
    b = longTask();
  assert.deepEqual(a, b);
  const modules = Object.keys(a.files).filter(
    (p) => p.endsWith(".py") && !p.startsWith("test_"),
  );
  assert.equal(modules.length, 14);
  assert.equal(a.testCount, 126);
  assert.equal(a.bugs.length, 28);
  for (const name of modules) {
    const lines = a.files[name].split("\n").length;
    assert(lines >= 390 && lines <= 910, `${name}: ${lines} lines`);
  }
  const fixed = longTask({ fixed: true });
  assert.deepEqual(fixed.tests, a.tests);
  assert.deepEqual(fixed.tables, a.tables);
  assert.notDeepEqual(fixed.files, a.files);
});

test(
  "the buggy fixture fails exactly its seeded tests; the fixed one passes",
  { skip: !python && "python3 is not available" },
  async () => {
    const task = longTask();
    const buggy = unittest(await project(task));
    assert.match(buggy.stderr, /Ran 126 tests/);
    const failing = [
      ...buggy.stderr.matchAll(/^(?:FAIL|ERROR): (\w+) \((\w+)\./gm),
    ].map((m) => `${m[2]}.${m[1]}`);
    const expected = task.bugs.map((bug) => {
      const [module, fn] = bug.split(".");
      return `test_${module}.test_${fn}`;
    });
    assert.deepEqual(failing.sort(), expected.sort());
    const fixed = unittest(await project(longTask({ fixed: true })));
    assert.equal(fixed.status, 0);
    assert.match(fixed.stderr, /Ran 126 tests[\s\S]*\nOK\n/);
  },
);

test("site settings come only from the environment and are validated", () => {
  assert.throws(
    () => wait.settingsFromEnv({}),
    (error) =>
      [
        "LONG_BENCHMARK_SSH",
        "LONG_BENCHMARK_NAMESPACE",
        "LONG_BENCHMARK_SERVICE",
        "LONG_BENCHMARK_METRICS_PORT",
        "LONG_BENCHMARK_RESULTS",
      ].every((name) => error.message.includes(`${name} is not set`)),
  );
  const valid = {
    LONG_BENCHMARK_SSH: "bench@server.example",
    LONG_BENCHMARK_NAMESPACE: "inference",
    LONG_BENCHMARK_SERVICE: "sglang",
    LONG_BENCHMARK_METRICS_PORT: "30000",
    LONG_BENCHMARK_RESULTS: join(temporary, "results"),
  };
  const settings = wait.settingsFromEnv(valid);
  assert.equal(settings.idleSeconds, 300);
  assert.equal(settings.notBefore, null);
  assert.equal(
    wait.remoteCommand(settings),
    'ip=$(kubectl -n inference get svc sglang -o jsonpath={.spec.clusterIP}) && curl -sf --max-time 10 "http://$ip:30000/metrics"',
  );
  for (const [name, value] of [
    ["LONG_BENCHMARK_SSH", "-oProxyCommand=touch"],
    ["LONG_BENCHMARK_SSH", "host;id"],
    ["LONG_BENCHMARK_SSH", "user@host extra"],
    ["LONG_BENCHMARK_NAMESPACE", "ns$(id)"],
    ["LONG_BENCHMARK_NAMESPACE", "Upper"],
    ["LONG_BENCHMARK_SERVICE", "svc;id"],
    ["LONG_BENCHMARK_METRICS_PORT", "0"],
    ["LONG_BENCHMARK_METRICS_PORT", "70000"],
    ["LONG_BENCHMARK_METRICS_PORT", "80 && id"],
    ["LONG_BENCHMARK_RESULTS", "relative/results"],
    ["LONG_BENCHMARK_IDLE_SECONDS", "10"],
    ["LONG_BENCHMARK_NOT_BEFORE", "2026-11-16T20:00:00"],
    ["LONG_BENCHMARK_NOT_BEFORE", "tomorrow"],
  ])
    assert.throws(
      () => wait.settingsFromEnv({ ...valid, [name]: value }),
      new RegExp(name),
      `${name}=${value}`,
    );
  const later = wait.settingsFromEnv({
    ...valid,
    LONG_BENCHMARK_NOT_BEFORE: "2026-11-16T20:00:00Z",
    LONG_BENCHMARK_IDLE_SECONDS: "600",
  });
  assert.equal(later.notBefore.toISOString(), "2026-11-16T20:00:00.000Z");
  assert.equal(later.idleSeconds, 600);
});

test("the kit files carry no host addresses or site defaults", async () => {
  for (const name of [
    "manual-long-benchmark.mjs",
    "manual-long-benchmark-fixture.mjs",
    "manual-long-benchmark-summary.mjs",
    "manual-long-benchmark-wait.mjs",
  ]) {
    const text = await readFile(join(here, name), "utf8");
    const addresses = (text.match(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g) ?? []).filter(
      (a) => a !== "127.0.0.1",
    );
    assert.deepEqual(addresses, [], name);
    assert.doesNotMatch(text, /auth-state\.json"|readFile\([^)]*auth-state/);
  }
});

const METRICS = [
  "# HELP sglang:num_running_reqs running",
  'sglang:num_running_reqs{model_name="m",tp_rank="0"} 0.0',
  'sglang:num_running_reqs{model_name="m",tp_rank="1"} 0.0',
  'sglang:num_queue_reqs{model_name="m",tp_rank="0"} 0.0',
  'sglang:num_queue_reqs{model_name="m",tp_rank="1"} 0.0',
  'sglang:prefill_effective_tokens_total{mode="input",tp_rank="0"} 1000.0',
  'sglang:prefill_effective_tokens_total{mode="input",tp_rank="1"} 1000.0',
  'sglang:realtime_tokens_total{mode="decode",tp_rank="0"} 50.0',
  'sglang:other_metric{tp_rank="0"} 7.0',
].join("\n");

test("metrics parsing never reads missing data as idle", () => {
  const idle = wait.parseMetrics(METRICS);
  assert.equal(idle.running, 0);
  assert.equal(idle.queued, 0);
  assert.deepEqual(idle.counters, {
    "prefill_effective_tokens_total:input": 1000,
    "realtime_tokens_total:decode": 50,
  });
  assert.equal(idle.lines.length, 4);
  for (const text of [
    undefined,
    "",
    "curl: (7) Failed to connect",
    METRICS.split("\n")
      .filter((l) => !l.includes("num_queue_reqs"))
      .join("\n"),
    'sglang:num_running_reqs{tp_rank="0"} NaN\nsglang:num_queue_reqs{tp_rank="0"} 0',
  ])
    assert.equal(wait.parseMetrics(text), null, String(text).slice(0, 40));
  const busy = wait.parseMetrics(
    'sglang:num_running_reqs{a="b"} 1\nsglang:num_queue_reqs{a="b"} 2\n',
  );
  assert.deepEqual([busy.running, busy.queued], [1, 2]);
  const after = wait.parseMetrics(
    METRICS.replace(
      'mode="input",tp_rank="0"} 1000.0',
      'mode="input",tp_rank="0"} 4500.0',
    ),
  );
  assert.deepEqual(wait.counterDelta(idle, after), {
    "prefill_effective_tokens_total:input": 3500,
    "realtime_tokens_total:decode": 0,
  });
  assert.equal(wait.counterDelta(idle, null), null);
  assert.deepEqual(wait.contention([null, null]), {
    samples: 2,
    unavailable: 2,
    maxRunning: null,
    maxQueued: null,
    contended: null,
  });
  assert.equal(
    wait.contention([idle, { running: 1, queued: 0 }]).contended,
    false,
  );
  assert.equal(
    wait.contention([{ running: 2, queued: 0 }, null]).contended,
    true,
  );
});

// A fake clock: sleep advances it; metrics come from a script per call.
function clock(start, script) {
  let time = new Date(start).getTime();
  const log = [];
  let calls = 0;
  return {
    log,
    calls: () => calls,
    options: {
      now: () => new Date(time),
      sleep: async (ms) => {
        time += ms;
      },
      log: (line) => log.push(line),
      metrics: async () => script(calls++, new Date(time)),
    },
  };
}
const at = (hour, minute = 0, day = 15) =>
  new Date(2026, 10, day, hour, minute, 0, 0);
const IDLE = { running: 0, queued: 0, counters: {}, lines: [] };

test("the wrapper waits for the window, a quiet period and real metrics", async () => {
  assert.equal(wait.inWindow(at(19, 59)), false);
  assert.equal(wait.inWindow(at(20)), true);
  assert.equal(wait.inWindow(at(6, 59)), true);
  assert.equal(wait.inWindow(at(7)), false);
  assert.deepEqual(wait.windowEnd(at(23)), at(7, 0, 16));
  assert.deepEqual(wait.windowEnd(at(2)), at(7));
  assert.equal(wait.canFinish(at(6, 20), 30), true);
  assert.equal(wait.canFinish(at(6, 30), 30), false);

  // Daytime: refuse without reading metrics.
  let c = clock(at(12), () => IDLE);
  let result = await wait.waitForIdle({
    ...c.options,
    timeoutMinutes: 30,
    idleSeconds: 300,
  });
  assert.deepEqual(result, { started: false, reason: "outside 20:00-07:00" });
  assert.equal(c.calls(), 0);

  // Metrics never available: never starts, gives up when the window closes.
  c = clock(at(23), () => null);
  result = await wait.waitForIdle({
    ...c.options,
    timeoutMinutes: 30,
    idleSeconds: 300,
  });
  assert.deepEqual(result, {
    started: false,
    reason: "too close to 07:00 to finish",
  });
  assert(c.calls() > 100);
  assert(c.log.every((l) => l === "metrics unavailable; not treated as idle"));

  // Busy, then idle with a gap of unavailable metrics: the quiet period
  // restarts after the gap and the run starts only once it is complete.
  const pattern = ["busy", "busy", "idle", "idle", "none", "idle"];
  c = clock(at(21), (n) =>
    pattern[n] === "busy"
      ? { running: 1, queued: 3, counters: {}, lines: [] }
      : pattern[n] === "none"
        ? null
        : IDLE,
  );
  result = await wait.waitForIdle({
    ...c.options,
    timeoutMinutes: 30,
    idleSeconds: 300,
  });
  assert.equal(result.started, true);
  // Quiet from sample 5 (index 5): 300 s more at 30 s intervals = 10 polls.
  assert.equal(c.calls(), 16);
  assert.equal(c.log[0], "busy (running=1 queued=3)");
  assert(c.log.includes("metrics unavailable; not treated as idle"));

  // Not-before: waits (also from the daytime) without reading metrics, then
  // applies the normal checks.
  c = clock(at(18), () => IDLE);
  result = await wait.waitForIdle({
    ...c.options,
    timeoutMinutes: 30,
    idleSeconds: 60,
    notBefore: at(20, 0, 16),
  });
  assert.equal(result.started, true);
  assert.equal(c.log[0], `waiting until ${at(20, 0, 16).toISOString()}`);
  assert(c.options.now() >= at(20, 1, 16));
  assert.equal(c.calls(), 3);
  result = await wait.waitForIdle({
    ...clock(at(18), () => IDLE).options,
    timeoutMinutes: 30,
    idleSeconds: 60,
    notBefore: at(12, 0, 16),
  });
  assert.deepEqual(result, {
    started: false,
    reason: "not-before is outside 20:00-07:00",
  });
});

test("the summary marks unknown and not-applicable values explicitly", () => {
  const row = summaryRow("old-1", {
    stopReason: "end_turn",
    elapsedMs: 120000,
    codingRequests: 10,
    toolCallsTotal: 4,
    toolFailuresTotal: 3,
    toolFailures: { 'run_command: {"code": 1': 2, "edit_file: no match": 1 },
  });
  assert.equal(row.hidden, "unknown");
  assert.equal(row.suite, "unknown");
  assert.equal(row.prompt, "unknown");
  assert.equal(row.viewImage, "unknown");
  assert.equal(row.playtest, "unknown");
  assert.equal(row.contended, "unknown");
  assert.equal(row.failedByTool, "run_command 2, edit_file 1");
  const current = summaryRow(
    "new-1",
    {
      stopReason: "end_turn",
      elapsedMs: 60000,
      logicalRounds: 7,
      finalSuite: { passed: 126, expected: 126 },
      hiddenChecks: null,
      unpromptedPlaytest: null,
      viewImage: { calls: 0, failed: 0 },
      toolFailuresByTool: {},
      tokens: {
        requests: 8,
        promptReported: 7,
        completionReported: 8,
        promptSum: 7000,
        completionSum: 800,
      },
    },
    { contention: { contended: false } },
    { "prefill_effective_tokens_total:input:input": 900 },
  );
  assert.equal(current.hidden, "n/a");
  assert.equal(current.playtest, "n/a");
  assert.equal(current.viewImage, "no");
  assert.equal(current.prompt, ">= 7000 (7/8 reported)");
  assert.equal(current.completion, 800);
  assert.equal(current.failedByTool, "none");
  assert.equal(current.prefill, 900);
  assert.equal(current.decode, null);
  assert.equal(current.contended, "no");
  const table = markdown([row, current]);
  assert.match(table, /\| new-1 \| n\/a \| 126\/126 \| 7 \|/);
  assert.match(table, /\*\*new mean \(n=1\)\*\*/);
  assert.match(table, /\| unknown \|/);
});

// ---- The runner end to end against a scripted fake Open WebUI --------------
test(
  "the runner reports a scripted session without a model",
  { timeout: 180000 },
  async () => {
    const task = longTask();
    const inventory = task.files["inventory.py"];
    assert.equal(inventory.split("    start = page * size\n").length, 2);
    const call = (name, args) => ({ name, args });
    const unittestCall = call("run_command", {
      executable: "python3",
      args: ["-m", "unittest"],
    });
    const steps = [
      unittestCall,
      call("read_file", { path: "inventory.py" }),
      call("edit_file", {
        path: "inventory.py",
        old_string: "    start = page * size + 1\n",
        new_string: "    start = (page - 1) * size\n",
      }),
      call("edit_file", {
        path: "inventory.py",
        old_string: "    start = page * size\n",
        new_string: "    start = (page - 1) * size\n",
      }),
      call("view_image", { path: "screenshot.png" }),
      unittestCall,
    ];
    const sent = { prompt: 0, completion: 0, reasoning: 0, requests: 0 };
    const server = createServer(async (req, res) => {
      if (req.url === "/api/models") {
        res.setHeader("Content-Type", "application/json");
        return res.end(
          JSON.stringify({
            data: [
              {
                id: "fixture",
                context_window: 100768,
                max_output_tokens: 12288,
              },
            ],
          }),
        );
      }
      req.setEncoding("utf8");
      let raw = "";
      for await (const part of req) raw += part;
      const request = JSON.parse(raw);
      const step = request.tools.length ? steps.shift() : undefined;
      sent.requests++;
      const delta = step
        ? {
            tool_calls: [
              {
                index: 0,
                id: `call-${sent.requests}`,
                type: "function",
                function: {
                  name: step.name,
                  arguments: JSON.stringify(step.args),
                },
              },
            ],
          }
        : { content: "Fixed one bug; other tests still fail." };
      const events = [
        { choices: [{ delta }] },
        {
          choices: [{ delta: {}, finish_reason: step ? "tool_calls" : "stop" }],
        },
      ];
      // The final reply carries no usage, so coverage is partial.
      if (step) {
        const usage = {
          prompt_tokens: Math.ceil(raw.length / 4),
          completion_tokens: 40 + sent.requests,
          completion_tokens_details: { reasoning_tokens: 10 },
        };
        sent.prompt += usage.prompt_tokens;
        sent.completion += usage.completion_tokens;
        sent.reasoning += 10;
        events.push({ choices: [], usage });
      }
      res.setHeader("Content-Type", "text/event-stream");
      res.end(
        events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("") +
          "data: [DONE]\n\n",
      );
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    try {
      const state = join(temporary, "user-state");
      await mkdir(state, { mode: 0o700 });
      await writeFile(
        join(state, "config.json"),
        JSON.stringify({
          url: `http://127.0.0.1:${server.address().port}`,
          model: "fixture",
        }),
        { mode: 0o600 },
      );
      const results = join(temporary, "results");
      const env = {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        OPENWEBUI_ACP_HOME: state,
        OPENWEBUI_API_KEY: "synthetic-long-benchmark-key",
        LONG_BENCHMARK_RESULTS: results,
        // The runner keeps its scratch directory; put it in ours.
        TMPDIR: temporary,
      };
      const runner = spawn(
        process.execPath,
        [
          join(here, "manual-long-benchmark.mjs"),
          "--live",
          checkout,
          "selftest-1",
          "3",
        ],
        { env, stdio: ["ignore", "pipe", "pipe"] },
      );
      let stdout = "",
        stderr = "";
      runner.stdout.on("data", (d) => (stdout += d));
      runner.stderr.on("data", (d) => (stderr += d));
      const code = await new Promise((r) => runner.on("close", r));
      assert.equal(code, 0, stderr);
      const report = JSON.parse(
        await readFile(join(results, "selftest-1", "report.json"), "utf8"),
      );
      assert.equal(report.error, undefined, report.error);
      assert.equal(report.inspectError, undefined, report.inspectError);
      assert.equal(steps.length, 0, "every scripted step was played");
      assert.equal(report.stopReason, "end_turn");
      assert.equal(report.model, "fixture");
      assert.equal(report.rounds, 100);
      assert.equal(report.codingRequests, 7);
      assert.equal(report.logicalRounds, 7);
      assert.equal(report.summaryRequests, 0);
      assert.deepEqual(report.toolCalls, {
        run_command: 2,
        read_file: 1,
        edit_file: 2,
        view_image: 1,
      });
      assert.equal(report.toolCallsTotal, 6);
      // Both suite runs fail (bugs remain, or the sandbox refuses python3),
      // one edit has no match and the screenshot does not exist.
      assert.deepEqual(report.toolFailuresByTool, {
        run_command: 2,
        edit_file: 1,
        view_image: 1,
      });
      assert.equal(report.toolFailuresTotal, 4);
      if (python)
        assert.equal(report.toolFailures["run_command: exit code 1"], 2);
      assert.deepEqual(report.viewImage, { calls: 1, failed: 1 });
      assert.deepEqual(report.tokens, {
        requests: 7,
        promptReported: 6,
        completionReported: 6,
        reasoningReported: 6,
        promptSum: sent.prompt,
        completionSum: sent.completion,
        reasoningSum: sent.reasoning,
        promptPeak: report.tokens.promptPeak,
      });
      assert(report.tokens.promptPeak > 0);
      assert.equal(report.hiddenChecks, null);
      assert.equal(report.unpromptedPlaytest, null);
      assert(report.elapsedMs > 0);
      assert.equal(report.edits, 2);
      assert.equal(report.tablesUnchanged, true);
      assert.equal(report.testsUnchanged, true);
      assert.equal(report.suiteRuns.length, 2);
      assert.equal(report.suiteRuns.at(-1).afterLastEdit, true);
      if (python) {
        // The runner's own suite run: one of 28 seeded bugs was fixed.
        assert.equal(report.finalSuite.ran, 126);
        assert.equal(report.finalSuite.passed, 126 - 27);
      }
      const requests = (
        await readFile(join(results, "selftest-1", "requests.jsonl"), "utf8")
      )
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l));
      assert.equal(requests.length, 7);
      assert.equal(requests.at(-1).promptTokens, null);
      // The synthetic key and backend address never reach the results.
      for (const name of [
        "report.json",
        "requests.jsonl",
        "agent-text.txt",
        "stderr.log",
      ]) {
        const text = await readFile(join(results, "selftest-1", name), "utf8");
        assert(!text.includes("synthetic-long-benchmark-key"), name);
        assert(!text.includes(`127.0.0.1:${server.address().port}`), name);
      }
      assert(!stdout.includes("synthetic-long-benchmark-key"));
      const row = summaryRow("selftest-1", report);
      assert.equal(row.viewImage, "1 (1 failed)");
      assert.equal(row.prompt, `>= ${sent.prompt} (6/7 reported)`);
      assert.equal(row.hidden, "n/a");
      // A second run with the same label is refused.
      const again = spawnSync(
        process.execPath,
        [
          join(here, "manual-long-benchmark.mjs"),
          "--live",
          checkout,
          "selftest-1",
          "3",
        ],
        { env, encoding: "utf8" },
      );
      assert.notEqual(again.status, 0);
      assert.match(again.stderr, /already holds a report/);
    } finally {
      server.close();
    }
  },
);

test("the wrapper refuses to start without site settings", async () => {
  // A stand-in ssh on PATH records any call; none may happen.
  const bin = await mkdtemp(join(temporary, "bin-"));
  const marker = join(bin, "called");
  await writeFile(join(bin, "ssh"), `#!/bin/sh\ntouch "${marker}"\nexit 1\n`, {
    mode: 0o700,
  });
  const run = spawnSync(
    process.execPath,
    [join(here, "manual-long-benchmark-wait.mjs"), "nightly-1", checkout, "30"],
    {
      encoding: "utf8",
      env: { PATH: `${bin}:${process.env.PATH}`, HOME: process.env.HOME },
    },
  );
  assert.equal(run.status, 2);
  assert.match(run.stderr, /LONG_BENCHMARK_SSH is not set/);
  assert.match(run.stderr, /LONG_BENCHMARK_RESULTS is not set/);
  await assert.rejects(readFile(marker));
});
