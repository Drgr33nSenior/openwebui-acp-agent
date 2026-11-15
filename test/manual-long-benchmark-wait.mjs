// Runs test/manual-long-benchmark.mjs once on a shared inference server, only
// overnight and only when SGLang and the separate service-tools service (MCP,
// media and research tools) are idle. Explicit use only.
//
//   LONG_BENCHMARK_SSH=user@server LONG_BENCHMARK_NAMESPACE=namespace \
//   LONG_BENCHMARK_SERVICE=service LONG_BENCHMARK_METRICS_PORT=port \
//   LONG_BENCHMARK_TOOLS_NAMESPACE=namespace LONG_BENCHMARK_TOOLS_SERVICE=service \
//   LONG_BENCHMARK_TOOLS_PORT=port LONG_BENCHMARK_RESULTS=/absolute/results/dir \
//     node test/manual-long-benchmark-wait.mjs LABEL AGENT_DIRECTORY [TIMEOUT_MINUTES]
//
// Optional: LONG_BENCHMARK_NOT_BEFORE (ISO time with offset, e.g.
// 2026-11-16T20:00:00Z) and LONG_BENCHMARK_IDLE_SECONDS (quiet period before
// starting, default 300, minimum 60).
//
// Site settings have no defaults. Over ssh it only reads: `kubectl get svc` and
// `get endpointslices`, SGLang /metrics, and service-tools /health and
// /metrics. A sample that is unavailable, incomplete or ambiguous never counts
// as idle. The run starts only between 20:00 and 07:00 local time, when it can
// finish before 07:00, and after every sample for the whole quiet period shows
// no SGLang request running or queued, no service-tools work in flight and no
// change in the service-tools counters. Exit status 3 means the window closed
// without a start. The process environment, including the agent's normal
// authentication, is passed to the runner.
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const WINDOW_START_HOUR = 20;
export const WINDOW_END_HOUR = 7;
// Time allowed after the runner's own timeout: cancellation grace, process
// cleanup, the post-run test suite and the final metrics read.
export const FINISH_MARGIN_MS = 5 * 60000;
export const POLL_MS = 30000;
export const SAMPLE_MS = 15000;
const DNS_LABEL = /^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/;
const SSH_DESTINATION =
  /^[A-Za-z0-9_][A-Za-z0-9._-]*(@[A-Za-z0-9_][A-Za-z0-9._-]*)?$/;
const EXPLICIT_OFFSET = /(Z|[+-]\d\d:\d\d)$/;

export function inWindow(date) {
  const hour = date.getHours();
  return hour >= WINDOW_START_HOUR || hour < WINDOW_END_HOUR;
}

// The next 07:00 local time after `date`.
export function windowEnd(date) {
  const end = new Date(date);
  end.setHours(WINDOW_END_HOUR, 0, 0, 0);
  if (end <= date) end.setDate(end.getDate() + 1);
  return end;
}

export function canFinish(date, timeoutMinutes) {
  return (
    inWindow(date) &&
    date.getTime() + timeoutMinutes * 60000 + FINISH_MARGIN_MS <=
      windowEnd(date).getTime()
  );
}

// Site settings come only from the environment; every value is validated
// because it becomes part of a remote shell command.
export function settingsFromEnv(env) {
  const problems = [];
  const required = (name, pattern, hint) => {
    const value = env[name];
    if (value === undefined || value === "")
      problems.push(`${name} is not set`);
    else if (!pattern.test(value)) problems.push(`${name} must be ${hint}`);
    return value;
  };
  const port = (name) => {
    const text = required(name, /^[1-9]\d{0,4}$/, "a port number");
    if (/^[1-9]\d{0,4}$/.test(text ?? "") && Number(text) > 65535)
      problems.push(`${name} must be a port number`);
    return Number(text);
  };
  const ssh = required(
    "LONG_BENCHMARK_SSH",
    SSH_DESTINATION,
    "an ssh destination such as user@host or a configured host alias",
  );
  const namespace = required(
    "LONG_BENCHMARK_NAMESPACE",
    DNS_LABEL,
    "a Kubernetes namespace name",
  );
  const service = required(
    "LONG_BENCHMARK_SERVICE",
    DNS_LABEL,
    "a Kubernetes service name",
  );
  const metricsPort = port("LONG_BENCHMARK_METRICS_PORT");
  // service-tools (MCP, media and research) is a separate service with its
  // own settings; nothing is derived from the SGLang ones.
  const toolsNamespace = required(
    "LONG_BENCHMARK_TOOLS_NAMESPACE",
    DNS_LABEL,
    "a Kubernetes namespace name",
  );
  const toolsService = required(
    "LONG_BENCHMARK_TOOLS_SERVICE",
    DNS_LABEL,
    "a Kubernetes service name",
  );
  const toolsPort = port("LONG_BENCHMARK_TOOLS_PORT");
  const results = env.LONG_BENCHMARK_RESULTS;
  if (!results) problems.push("LONG_BENCHMARK_RESULTS is not set");
  else if (!isAbsolute(results))
    problems.push("LONG_BENCHMARK_RESULTS must be an absolute path");
  let idleSeconds = 300;
  if (env.LONG_BENCHMARK_IDLE_SECONDS !== undefined) {
    idleSeconds = Number(env.LONG_BENCHMARK_IDLE_SECONDS);
    if (!Number.isInteger(idleSeconds) || idleSeconds < 60)
      problems.push("LONG_BENCHMARK_IDLE_SECONDS must be a whole number >= 60");
  }
  let notBefore = null;
  if (env.LONG_BENCHMARK_NOT_BEFORE !== undefined) {
    notBefore = new Date(env.LONG_BENCHMARK_NOT_BEFORE);
    if (
      !EXPLICIT_OFFSET.test(env.LONG_BENCHMARK_NOT_BEFORE) ||
      Number.isNaN(notBefore.getTime())
    )
      problems.push(
        "LONG_BENCHMARK_NOT_BEFORE must be an ISO time with Z or a +hh:mm offset",
      );
  }
  if (problems.length) throw new Error(problems.join("; "));
  return {
    ssh,
    namespace,
    service,
    port: metricsPort,
    toolsNamespace,
    toolsService,
    toolsPort,
    results,
    idleSeconds,
    notBefore,
  };
}

// Read-only: resolve both service addresses, read SGLang /metrics, count the
// service-tools endpoints and read its /health and /metrics. Each part prints
// a marker first; a failure stops the chain, so a missing "### end" means the
// sample is incomplete.
export function remoteCommand(settings) {
  const { namespace, service, port, toolsNamespace, toolsService, toolsPort } =
    settings;
  return [
    `sg=$(kubectl -n ${namespace} get svc ${service} -o jsonpath='{.spec.clusterIP}')`,
    `st=$(kubectl -n ${toolsNamespace} get svc ${toolsService} -o jsonpath='{.spec.clusterIP}')`,
    "echo '### sglang-metrics'",
    `curl -sf --max-time 10 "http://$sg:${port}/metrics"`,
    "echo '### tools-endpoints'",
    `kubectl -n ${toolsNamespace} get endpointslices -l kubernetes.io/service-name=${toolsService} -o jsonpath='{range .items[*].endpoints[*]}{.conditions.ready}{"\\n"}{end}'`,
    "echo '### tools-health'",
    `curl -sf --max-time 10 "http://$st:${toolsPort}/health"`,
    "echo",
    "echo '### tools-metrics'",
    `curl -sf --max-time 10 "http://$st:${toolsPort}/metrics"`,
    "echo '### end'",
  ].join(" && ");
}

const SECTIONS = [
  "sglang-metrics",
  "tools-endpoints",
  "tools-health",
  "tools-metrics",
  "end",
];

// The SGLang series used here, from rank 0 when ranks are labelled. Returns
// null unless both request gauges are present and numeric: missing data is
// never read as zero.
export function parseMetrics(text) {
  if (typeof text !== "string") return null;
  const series = [];
  for (const line of text.split("\n")) {
    const m = line.match(
      /^sglang:(num_running_reqs|num_queue_reqs|prefill_effective_tokens_total|realtime_tokens_total)\{([^}]*)\} (\S+)$/,
    );
    if (!m) continue;
    const value = Number(m[3]);
    if (!Number.isFinite(value)) continue;
    const rank = m[2].match(/(?:^|,)tp_rank="(\d+)"/)?.[1];
    const mode = m[2].match(/(?:^|,)mode="(\w+)"/)?.[1] ?? null;
    series.push({ line, name: m[1], rank, mode, value });
  }
  const used = series.some((s) => s.rank !== undefined)
    ? series.filter((s) => s.rank === "0")
    : series;
  const sum = (name) => {
    const values = used.filter((s) => s.name === name).map((s) => s.value);
    return values.length ? values.reduce((a, b) => a + b, 0) : null;
  };
  const running = sum("num_running_reqs"),
    queued = sum("num_queue_reqs");
  if (running === null || queued === null) return null;
  const counters = {};
  for (const s of used)
    if (s.name.endsWith("_total") && s.mode)
      counters[`${s.name}:${s.mode}`] =
        (counters[`${s.name}:${s.mode}`] ?? 0) + s.value;
  return { running, queued, counters, lines: used.map((s) => s.line) };
}

// service-tools /health: in-flight media, research and KV-tail work. Returns
// the reasons it is busy (empty when idle), or null when any field is missing
// or has an unexpected type: an ambiguous answer is never read as idle.
export function parseToolsHealth(text) {
  let h;
  try {
    h = JSON.parse(text);
  } catch {
    return null;
  }
  const count = (v) => Number.isSafeInteger(v) && v >= 0;
  const flag = (v) => typeof v === "boolean";
  const optional = (o, field) =>
    o !== null &&
    typeof o === "object" &&
    (o.enabled === false || (o.enabled === true && count(o[field])));
  if (
    !h ||
    typeof h !== "object" ||
    h.status !== "process-ready" ||
    !count(h.image_active) ||
    !flag(h.image_busy) ||
    !flag(h.image_recovery_required) ||
    !flag(h.video_active) ||
    !optional(h.deep_research, "active") ||
    !optional(h.kv_tail, "jobs")
  )
    return null;
  const busy = [];
  if (h.image_active > 0) busy.push(`image_active=${h.image_active}`);
  if (h.image_busy) busy.push("image_busy");
  if (h.image_recovery_required) busy.push("image_recovery_required");
  if (h.video_active) busy.push("video_active");
  if (h.deep_research.active > 0)
    busy.push(`deep_research.active=${h.deep_research.active}`);
  if (h.kv_tail.jobs > 0) busy.push(`kv_tail.jobs=${h.kv_tail.jobs}`);
  return busy;
}

// service-tools /metrics has outcome counters and histograms but no in-flight
// gauge; all series start at zero. Their total only grows while the process
// runs, so a change between samples means calls finished (or a restart).
// Returns null for a page without these families.
export function parseToolsCounters(text) {
  if (!/^# TYPE workstation_assistant_\w+ (counter|histogram)$/m.test(text))
    return null;
  let total = 0,
    series = 0;
  for (const line of text.split("\n")) {
    const m = line.match(
      /^workstation_assistant_\w+?(?:_total|_count)\{[^}]*\} (\S+)$/,
    );
    if (!m) continue;
    const value = Number(m[1]);
    if (!Number.isFinite(value) || value < 0) return null;
    total += value;
    series++;
  }
  return series ? { total, series } : null;
}

// One combined sample from the remote command's output. Returns
// { unavailable: reason } unless every part is present and unambiguous.
export function parseSample(text, exitCode = 0) {
  const parts = {};
  let current = null;
  for (const line of String(text ?? "").split("\n")) {
    const marker = line.match(/^### ([a-z-]+)$/)?.[1];
    if (marker && SECTIONS.includes(marker)) {
      current = marker;
      parts[current] = [];
    } else if (current) parts[current].push(line);
  }
  const last = SECTIONS.filter((name) => name in parts).at(-1);
  if (exitCode !== 0 || !("end" in parts))
    return {
      unavailable: last
        ? `remote read failed after ${last}`
        : "remote read failed before any data",
    };
  const sglang = parseMetrics(parts["sglang-metrics"].join("\n"));
  if (!sglang) return { unavailable: "SGLang request gauges missing" };
  const endpoints = parts["tools-endpoints"].join("\n").replace(/\n$/, "");
  if (endpoints !== "true")
    return {
      unavailable:
        "service-tools must have exactly one ready endpoint, got " +
        JSON.stringify(endpoints.split("\n")),
    };
  const busy = parseToolsHealth(parts["tools-health"].join("\n"));
  if (!busy) return { unavailable: "service-tools /health ambiguous" };
  const counters = parseToolsCounters(parts["tools-metrics"].join("\n"));
  if (!counters) return { unavailable: "service-tools /metrics unreadable" };
  return {
    ...sglang,
    tools: {
      busy,
      counterTotal: counters.total,
      health: parts["tools-health"].join("\n").trim(),
    },
  };
}

// Whether a sample shows the shared services idle. `previous` is the last
// readable sample; a change in the service-tools counter total since then is
// activity. `ownRequests` is 1 during our own run, 0 before it.
export function activity(sample, previous, ownRequests = 0) {
  if (!sample || sample.unavailable)
    return {
      state: "unavailable",
      reasons: [sample?.unavailable ?? "no sample"],
    };
  const reasons = [];
  if (sample.running > ownRequests || sample.queued > 0)
    reasons.push(`sglang running=${sample.running} queued=${sample.queued}`);
  for (const reason of sample.tools.busy)
    reasons.push(`service-tools ${reason}`);
  if (
    previous &&
    !previous.unavailable &&
    previous.tools.counterTotal !== sample.tools.counterTotal
  )
    reasons.push(
      `service-tools counters ${previous.tools.counterTotal} -> ${sample.tools.counterTotal}`,
    );
  return { state: reasons.length ? "busy" : "idle", reasons };
}

export function counterDelta(before, after) {
  if (!before || !after) return null;
  const delta = {};
  for (const [key, value] of Object.entries(before.counters))
    if (key in after.counters) delta[key] = after.counters[key] - value;
  return delta;
}

// Waits for a start. `metrics` returns a parseSample result.
export async function waitForIdle({
  metrics,
  now = () => new Date(),
  sleep,
  log,
  timeoutMinutes,
  idleSeconds,
  notBefore = null,
}) {
  if (notBefore && !inWindow(notBefore))
    return { started: false, reason: "not-before is outside 20:00-07:00" };
  let quietSince = null,
    previous = null,
    announced = false;
  for (;;) {
    const time = now();
    if (notBefore && time < notBefore) {
      if (!announced) log(`waiting until ${notBefore.toISOString()}`);
      announced = true;
      await sleep(Math.min(POLL_MS, notBefore - time));
      continue;
    }
    if (!canFinish(time, timeoutMinutes))
      return {
        started: false,
        reason: inWindow(time)
          ? "too close to 07:00 to finish"
          : "outside 20:00-07:00",
      };
    const sample = await metrics();
    const seen = activity(sample, previous);
    if (seen.state !== "unavailable") previous = sample;
    if (seen.state === "unavailable") {
      log(`unavailable (${seen.reasons[0]}); not treated as idle`);
      quietSince = null;
    } else if (seen.state === "busy") {
      log(`busy (${seen.reasons.join("; ")})`);
      quietSince = null;
    } else {
      quietSince ??= time.getTime();
      if (time.getTime() - quietSince >= idleSeconds * 1000)
        return { started: true, before: sample };
      log(
        `idle for ${Math.round((time.getTime() - quietSince) / 1000)} s of ${idleSeconds} s`,
      );
    }
    await sleep(POLL_MS);
  }
}

// Load from someone else while the run was going. SGLang: more than our own
// one request running, or anything queued. service-tools: any in-flight work
// or a counter change; the benchmarked agent does not call service-tools.
// Unknown (null) when no sample could be read.
export function contention(samples, before = null) {
  let previous = before;
  let sglang = false,
    tools = false,
    read = 0;
  const reasons = new Set();
  for (const sample of samples) {
    const seen = activity(sample, previous, 1);
    if (seen.state === "unavailable") continue;
    read++;
    previous = sample;
    for (const reason of seen.reasons) {
      if (reason.startsWith("sglang")) sglang = true;
      else tools = true;
      reasons.add(reason.replace(/[=\s].*$/, ""));
    }
  }
  const available = samples.filter((s) => s && !s.unavailable);
  return {
    samples: samples.length,
    unavailable: samples.length - read,
    maxRunning: read ? Math.max(...available.map((s) => s.running)) : null,
    maxQueued: read ? Math.max(...available.map((s) => s.queued)) : null,
    sglangContended: read ? sglang : null,
    toolsActive: read ? tools : null,
    contended: read ? sglang || tools : null,
    kinds: [...reasons].sort(),
  };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length < 2 || args.length > 3) {
    console.error(
      "Usage: node test/manual-long-benchmark-wait.mjs LABEL AGENT_DIRECTORY [TIMEOUT_MINUTES]",
    );
    return 2;
  }
  const [label, agent] = [args[0], resolve(args[1])];
  const minutes = Number(args[2] ?? 30);
  if (!/^[a-z0-9-]{1,40}$/.test(label)) {
    console.error("LABEL: a-z, 0-9 and -, 1-40 characters");
    return 2;
  }
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 240) {
    console.error("TIMEOUT_MINUTES: a whole number from 1 to 240");
    return 2;
  }
  let settings;
  try {
    settings = settingsFromEnv(process.env);
  } catch (error) {
    console.error(error.message);
    return 2;
  }
  const out = join(settings.results, label);
  await mkdir(out, { recursive: true, mode: 0o700 });
  const idleLog = createWriteStream(join(out, "idle-wait.log"), {
    flags: "a",
    mode: 0o600,
  });
  const log = (message) => {
    const line = `${new Date().toISOString()} ${label}: ${message}`;
    console.log(line);
    idleLog.write(line + "\n");
  };
  const command = remoteCommand(settings);
  const metrics = () =>
    new Promise((done) => {
      const child = spawn(
        "ssh",
        [
          "-o",
          "BatchMode=yes",
          "-o",
          "ConnectTimeout=10",
          "--",
          settings.ssh,
          command,
        ],
        { stdio: ["ignore", "pipe", "ignore"] },
      );
      let text = "";
      const timer = setTimeout(() => child.kill("SIGTERM"), 30000);
      child.stdout.on("data", (chunk) => {
        if (text.length < 4000000) text += chunk;
      });
      child.on("error", () => {
        clearTimeout(timer);
        done({ unavailable: "ssh could not be started" });
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        done(parseSample(text, code ?? 1));
      });
    });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const wait = await waitForIdle({
    metrics,
    sleep,
    log,
    timeoutMinutes: minutes,
    idleSeconds: settings.idleSeconds,
    notBefore: settings.notBefore,
  });
  if (!wait.started) {
    log(`not starting: ${wait.reason}`);
    idleLog.end();
    return 3;
  }
  const before = wait.before;
  await writeFile(
    join(out, "tools-health-before.json"),
    before.tools.health + "\n",
    {
      mode: 0o600,
    },
  );
  await writeFile(
    join(out, "metrics-before.txt"),
    before.lines.join("\n") + "\n",
    {
      mode: 0o600,
    },
  );
  // Sample the server during the run, one read at a time.
  const samples = [];
  const sampleLog = createWriteStream(join(out, "running-samples.txt"), {
    mode: 0o600,
  });
  let sampling = true,
    wake = () => {};
  const sampler = (async () => {
    while (sampling) {
      await new Promise((r) => {
        const timer = setTimeout(r, SAMPLE_MS);
        wake = () => {
          clearTimeout(timer);
          r();
        };
      });
      if (!sampling) return;
      const s = await metrics();
      samples.push(s);
      sampleLog.write(
        `${new Date().toISOString()} ` +
          (s.unavailable
            ? `unavailable (${s.unavailable})`
            : `running=${s.running} queued=${s.queued} tools=${s.tools.busy.join(",") || "idle"} tools_counters=${s.tools.counterTotal}`) +
          "\n",
      );
    }
  })();
  const startedAt = new Date().toISOString();
  log("starting");
  const runner = spawn(
    process.execPath,
    [
      fileURLToPath(new URL("./manual-long-benchmark.mjs", import.meta.url)),
      "--live",
      agent,
      label,
      String(minutes),
    ],
    {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, LONG_BENCHMARK_RESULTS: settings.results },
    },
  );
  const stdout = createWriteStream(join(out, "runner-stdout.jsonl"), {
    mode: 0o600,
  });
  const stderr = createWriteStream(join(out, "runner-stderr.log"), {
    mode: 0o600,
  });
  runner.stdout.pipe(stdout);
  runner.stderr.pipe(stderr);
  const exitCode = await new Promise((r) =>
    runner.on("close", (code, signal) => r(code ?? (signal ? 128 : 1))),
  );
  sampling = false;
  wake();
  await sampler;
  const sampled = await metrics();
  const after = sampled.unavailable ? null : sampled;
  if (after)
    await writeFile(
      join(out, "tools-health-after.json"),
      after.tools.health + "\n",
      {
        mode: 0o600,
      },
    );
  if (after)
    await writeFile(
      join(out, "metrics-after.txt"),
      after.lines.join("\n") + "\n",
      {
        mode: 0o600,
      },
    );
  const delta = counterDelta(before, after);
  await writeFile(
    join(out, "sglang-delta.json"),
    JSON.stringify(delta ?? { unavailable: true }, null, 1) + "\n",
    { mode: 0o600 },
  );
  const summary = {
    label,
    startedAt,
    endedAt: new Date().toISOString(),
    runnerExitCode: exitCode,
    idleSeconds: settings.idleSeconds,
    contention: contention(after ? [...samples, after] : samples, before),
    toolsCounterTotal: {
      before: before.tools.counterTotal,
      after: after?.tools.counterTotal ?? null,
    },
    sglangDelta: delta,
  };
  await writeFile(
    join(out, "wrapper.json"),
    JSON.stringify(summary, null, 2) + "\n",
    {
      mode: 0o600,
    },
  );
  log(`finished: runner exit ${exitCode}`);
  console.log(JSON.stringify(summary));
  sampleLog.end();
  idleLog.end();
  return exitCode;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  process.exitCode = await main();
