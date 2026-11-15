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

const SITE = {
  LONG_BENCHMARK_SSH: "bench@server.example",
  LONG_BENCHMARK_NAMESPACE: "inference",
  LONG_BENCHMARK_SERVICE: "sglang",
  LONG_BENCHMARK_METRICS_PORT: "30000",
  LONG_BENCHMARK_TOOLS_NAMESPACE: "assistant",
  LONG_BENCHMARK_TOOLS_SERVICE: "service-tools",
  LONG_BENCHMARK_TOOLS_PORT: "8000",
  LONG_BENCHMARK_RESULTS: join(temporary, "results"),
};

test("site settings come only from the environment and are validated", () => {
  assert.throws(
    () => wait.settingsFromEnv({}),
    (error) =>
      [
        "LONG_BENCHMARK_SSH",
        "LONG_BENCHMARK_NAMESPACE",
        "LONG_BENCHMARK_SERVICE",
        "LONG_BENCHMARK_METRICS_PORT",
        "LONG_BENCHMARK_TOOLS_NAMESPACE",
        "LONG_BENCHMARK_TOOLS_SERVICE",
        "LONG_BENCHMARK_TOOLS_PORT",
        "LONG_BENCHMARK_RESULTS",
      ].every((name) => error.message.includes(`${name} is not set`)),
  );
  // The service-tools settings are separate: SGLang settings alone fail.
  const sglangOnly = { ...SITE };
  for (const name of Object.keys(sglangOnly))
    if (name.startsWith("LONG_BENCHMARK_TOOLS_")) delete sglangOnly[name];
  assert.throws(
    () => wait.settingsFromEnv(sglangOnly),
    /LONG_BENCHMARK_TOOLS_NAMESPACE is not set; LONG_BENCHMARK_TOOLS_SERVICE is not set; LONG_BENCHMARK_TOOLS_PORT is not set/,
  );
  const settings = wait.settingsFromEnv(SITE);
  assert.equal(settings.idleSeconds, 300);
  assert.equal(settings.notBefore, null);
  assert.deepEqual(
    [settings.toolsNamespace, settings.toolsService, settings.toolsPort],
    ["assistant", "service-tools", 8000],
  );
  const command = wait.remoteCommand(settings);
  assert.equal(
    command,
    [
      "sg=$(kubectl -n inference get svc sglang -o jsonpath='{.spec.clusterIP}')",
      "st=$(kubectl -n assistant get svc service-tools -o jsonpath='{.spec.clusterIP}')",
      "echo '### sglang-metrics'",
      'curl -sf --max-time 10 "http://$sg:30000/metrics"',
      "echo '### tools-endpoints'",
      "kubectl -n assistant get endpointslices -l kubernetes.io/service-name=service-tools -o jsonpath='{range .items[*].endpoints[*]}{.conditions.ready}{\"\\n\"}{end}'",
      "echo '### tools-health'",
      'curl -sf --max-time 10 "http://$st:8000/health"',
      "echo",
      "echo '### tools-metrics'",
      'curl -sf --max-time 10 "http://$st:8000/metrics"',
      "echo '### end'",
    ].join(" && "),
  );
  // Only reads: no kubectl verb other than get, no curl method or data.
  assert.deepEqual(
    [...command.matchAll(/kubectl -n \S+ (\S+)/g)].map((m) => m[1]),
    ["get", "get", "get"],
  );
  assert.doesNotMatch(command, /curl[^&]*( -X| -d| --data| -T)/);
  if (process.platform !== "win32")
    assert.equal(spawnSync("sh", ["-n", "-c", command]).status, 0);
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
    ["LONG_BENCHMARK_TOOLS_NAMESPACE", "a'b"],
    ["LONG_BENCHMARK_TOOLS_SERVICE", "svc$(id)"],
    ["LONG_BENCHMARK_TOOLS_SERVICE", "a,b"],
    ["LONG_BENCHMARK_TOOLS_PORT", "8000;id"],
    ["LONG_BENCHMARK_TOOLS_PORT", "65536"],
    ["LONG_BENCHMARK_RESULTS", "relative/results"],
    ["LONG_BENCHMARK_IDLE_SECONDS", "10"],
    ["LONG_BENCHMARK_NOT_BEFORE", "2026-11-16T20:00:00"],
    ["LONG_BENCHMARK_NOT_BEFORE", "tomorrow"],
  ])
    assert.throws(
      () => wait.settingsFromEnv({ ...SITE, [name]: value }),
      new RegExp(name),
      `${name}=${value}`,
    );
  const later = wait.settingsFromEnv({
    ...SITE,
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
const BUSY_METRICS = METRICS.replace(
  'num_running_reqs{model_name="m",tp_rank="0"} 0.0',
  'num_running_reqs{model_name="m",tp_rank="0"} 1.0',
).replace(
  'num_queue_reqs{model_name="m",tp_rank="0"} 0.0',
  'num_queue_reqs{model_name="m",tp_rank="0"} 3.0',
);
// Synthetic service-tools /health, shaped like the stack's ServiceTools.health.
const health = (changes = {}) =>
  JSON.stringify({
    status: "process-ready",
    image_busy: false,
    image_active: 0,
    image_slots: 1,
    image_recovery_required: false,
    video_active: false,
    image_profile: "profile",
    workflow_sha256: "0".repeat(64),
    kv_tail: { enabled: true, backed: true, jobs: 0, last: null },
    retrieval: { reranker_state: "active" },
    deep_research: { enabled: true, active: 0, limit: 1 },
    web_search: { status: "disabled" },
    ...changes,
  });
// Synthetic service-tools /metrics: seeded counters and a histogram.
const toolsMetrics = (calls = 0, kvTail = 0) =>
  [
    "# HELP workstation_assistant_web_requests_total Web tool calls.",
    "# TYPE workstation_assistant_web_requests_total counter",
    `workstation_assistant_web_requests_total{outcome="ok",tool="search"} ${calls}`,
    'workstation_assistant_web_requests_total{outcome="error",tool="search"} 0',
    "# TYPE workstation_assistant_kv_tail_duration_seconds histogram",
    `workstation_assistant_kv_tail_duration_seconds_bucket{op="grow",le="1"} ${kvTail}`,
    `workstation_assistant_kv_tail_duration_seconds_sum{op="grow"} ${kvTail * 0.5}`,
    `workstation_assistant_kv_tail_duration_seconds_count{op="grow"} ${kvTail}`,
    "# TYPE workstation_assistant_kv_tail_state gauge",
    'workstation_assistant_kv_tail_state{state="ready"} 1',
    "",
  ].join("\n");
// The remote command's output: each part after its marker.
const remote = ({
  sglang = METRICS,
  endpoints = "true\n",
  toolsHealth = health(),
  tools = toolsMetrics(),
} = {}) =>
  `### sglang-metrics\n${sglang}\n### tools-endpoints\n${endpoints}` +
  `### tools-health\n${toolsHealth}\n### tools-metrics\n${tools}### end\n`;
const sample = (parts) => wait.parseSample(remote(parts));

test("SGLang metrics parsing never reads missing data as idle", () => {
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
  const busy = wait.parseMetrics(BUSY_METRICS);
  assert.deepEqual([busy.running, busy.queued], [1, 3]);
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
});

test("service-tools health and counters: busy, idle and ambiguous", () => {
  assert.deepEqual(wait.parseToolsHealth(health()), []);
  assert.deepEqual(
    wait.parseToolsHealth(
      health({
        kv_tail: { enabled: false },
        deep_research: { enabled: false },
      }),
    ),
    [],
  );
  for (const [changes, reasons] of [
    [{ image_active: 1, image_busy: true }, ["image_active=1", "image_busy"]],
    [{ image_recovery_required: true }, ["image_recovery_required"]],
    [{ video_active: true }, ["video_active"]],
    [
      { deep_research: { enabled: true, active: 2, limit: 2 } },
      ["deep_research.active=2"],
    ],
    [{ kv_tail: { enabled: true, jobs: 1 } }, ["kv_tail.jobs=1"]],
  ])
    assert.deepEqual(wait.parseToolsHealth(health(changes)), reasons);
  for (const text of [
    "",
    "not json",
    "[]",
    "null",
    health({ status: "starting" }),
    health({ image_active: "0" }),
    health({ image_active: -1 }),
    health({ video_active: 0 }),
    health({ image_recovery_required: undefined }),
    health({ deep_research: { enabled: true, limit: 1 } }),
    health({ deep_research: undefined }),
    health({ kv_tail: { enabled: "yes" } }),
  ])
    assert.equal(wait.parseToolsHealth(text), null, text.slice(0, 60));
  assert.deepEqual(wait.parseToolsCounters(toolsMetrics(4, 2)), {
    total: 6,
    series: 3,
  });
  for (const text of [
    "",
    toolsMetrics().replaceAll(/^# TYPE .*\n/gm, ""),
    "# TYPE workstation_assistant_web_requests_total counter\n",
    toolsMetrics().replace("} 0\n", "} NaN\n"),
    toolsMetrics().replace("} 0\n", "} -1\n"),
  ])
    assert.equal(wait.parseToolsCounters(text), null, text.slice(0, 60));
});

test("a combined sample is unavailable unless every part is clear", () => {
  const idle = sample();
  assert.equal(idle.unavailable, undefined);
  assert.deepEqual(
    [idle.running, idle.queued, idle.tools.busy, idle.tools.counterTotal],
    [0, 0, [], 0],
  );
  assert.deepEqual(wait.activity(idle, null), { state: "idle", reasons: [] });
  for (const [text, code, reason] of [
    ["", 255, "remote read failed before any data"],
    [
      `### sglang-metrics\n${METRICS}\n### tools-endpoints\ntrue\n### tools-health\n`,
      7,
      "remote read failed after tools-health",
    ],
    [
      remote().replace("### end\n", ""),
      0,
      "remote read failed after tools-metrics",
    ],
    [remote(), 1, "remote read failed after end"],
    [remote({ sglang: "" }), 0, "SGLang request gauges missing"],
    [
      remote({ endpoints: "" }),
      0,
      'service-tools must have exactly one ready endpoint, got [""]',
    ],
    [
      remote({ endpoints: "\n" }),
      0,
      'service-tools must have exactly one ready endpoint, got [""]',
    ],
    [
      remote({ endpoints: "false\n" }),
      0,
      'service-tools must have exactly one ready endpoint, got ["false"]',
    ],
    [
      remote({ endpoints: "true\ntrue\n" }),
      0,
      'service-tools must have exactly one ready endpoint, got ["true","true"]',
    ],
    [
      remote({ toolsHealth: health({ video_active: null }) }),
      0,
      "service-tools /health ambiguous",
    ],
    [
      remote({ tools: "404 page not found\n" }),
      0,
      "service-tools /metrics unreadable",
    ],
  ]) {
    const parsed = wait.parseSample(text, code);
    assert.deepEqual(parsed, { unavailable: reason });
    assert.deepEqual(wait.activity(parsed, idle), {
      state: "unavailable",
      reasons: [reason],
    });
  }
  // Busy from either service, each named separately.
  assert.deepEqual(wait.activity(sample({ sglang: BUSY_METRICS }), idle), {
    state: "busy",
    reasons: ["sglang running=1 queued=3"],
  });
  assert.deepEqual(
    wait.activity(
      sample({ toolsHealth: health({ video_active: true }) }),
      idle,
    ),
    { state: "busy", reasons: ["service-tools video_active"] },
  );
  // Short tool calls finish between samples; only the counters show them.
  assert.deepEqual(wait.activity(sample({ tools: toolsMetrics(1) }), idle), {
    state: "busy",
    reasons: ["service-tools counters 0 -> 1"],
  });
  // A restart resets the counters: also not idle.
  assert.deepEqual(
    wait.activity(sample(), sample({ tools: toolsMetrics(5) })),
    { state: "busy", reasons: ["service-tools counters 5 -> 0"] },
  );
  // During our own run one running SGLang request is ours.
  const own = sample({
    sglang: METRICS.replace(
      'num_running_reqs{model_name="m",tp_rank="0"} 0.0',
      'num_running_reqs{model_name="m",tp_rank="0"} 1.0',
    ),
  });
  assert.equal(wait.activity(own, idle).state, "busy");
  assert.equal(wait.activity(own, idle, 1).state, "idle");

  assert.deepEqual(wait.contention([null, { unavailable: "x" }]), {
    samples: 2,
    unavailable: 2,
    maxRunning: null,
    maxQueued: null,
    sglangContended: null,
    toolsActive: null,
    contended: null,
    kinds: [],
  });
  assert.deepEqual(wait.contention([own, own, { unavailable: "x" }], idle), {
    samples: 3,
    unavailable: 1,
    maxRunning: 1,
    maxQueued: 0,
    sglangContended: false,
    toolsActive: false,
    contended: false,
    kinds: [],
  });
  const toolsDuringRun = wait.contention(
    [own, sample({ tools: toolsMetrics(0, 1) })],
    idle,
  );
  assert.equal(toolsDuringRun.sglangContended, false);
  assert.equal(toolsDuringRun.toolsActive, true);
  assert.equal(toolsDuringRun.contended, true);
  assert.deepEqual(toolsDuringRun.kinds, ["service-tools"]);
  assert.equal(
    wait.contention([sample({ sglang: BUSY_METRICS })], idle).sglangContended,
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
const IDLE = sample();
const UNAVAILABLE = wait.parseSample("", 255);

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

  // Never readable: never starts, gives up when the window closes.
  c = clock(at(23), () => UNAVAILABLE);
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
  assert(
    c.log.every(
      (l) =>
        l ===
        "unavailable (remote read failed before any data); not treated as idle",
    ),
  );

  // SGLang idle all night but service-tools never readable: never starts.
  c = clock(at(23), () => sample({ endpoints: "true\ntrue\n" }));
  result = await wait.waitForIdle({
    ...c.options,
    timeoutMinutes: 30,
    idleSeconds: 300,
  });
  assert.equal(result.started, false);

  // SGLang busy, then service-tools busy, a gap, a finished tool call, then
  // idle: each resets the quiet period, which must then complete.
  const script = [
    sample({ sglang: BUSY_METRICS }),
    sample({ toolsHealth: health({ image_active: 1, image_busy: true }) }),
    IDLE,
    IDLE,
    UNAVAILABLE,
    IDLE,
    sample({ tools: toolsMetrics(1) }),
    sample({ tools: toolsMetrics(1) }),
  ];
  c = clock(at(21), (n) => script[Math.min(n, script.length - 1)]);
  result = await wait.waitForIdle({
    ...c.options,
    timeoutMinutes: 30,
    idleSeconds: 300,
  });
  assert.equal(result.started, true);
  // Quiet from sample 7 (index 7): 300 s more at 30 s intervals = 10 polls.
  assert.equal(c.calls(), 18);
  assert.deepEqual(c.log.slice(0, 2), [
    "busy (sglang running=1 queued=3)",
    "busy (service-tools image_active=1; service-tools image_busy)",
  ]);
  assert(c.log.includes("busy (service-tools counters 0 -> 1)"));
  assert(
    c.log.includes(
      "unavailable (remote read failed before any data); not treated as idle",
    ),
  );

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
  assert.match(run.stderr, /LONG_BENCHMARK_TOOLS_SERVICE is not set/);
  assert.match(run.stderr, /LONG_BENCHMARK_RESULTS is not set/);
  await assert.rejects(readFile(marker));
});
