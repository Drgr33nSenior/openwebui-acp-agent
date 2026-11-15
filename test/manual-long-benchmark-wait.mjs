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
// /metrics. service-tools must report its request lifecycle (PLAN-01:
// requests in flight and started per work route, and its process start); a
// service without it is unavailable, never idle. A sample that is
// unavailable, incomplete or ambiguous never counts as idle. The run starts
// only between 20:00 and 07:00 local time, when it can finish before 07:00,
// and after every sample for the whole quiet period shows no SGLang request
// running or queued, no service-tools request or background work in flight,
// and the same service-tools process with no request started since the
// previous sample. Exit status 3 means the window closed without a start. The
// process environment, including the agent's normal authentication, is passed
// to the runner.
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

// Work routes of service-tools whose requests the request lifecycle counts
// (PLAN-01: /mcp, the picture adapter, web search and fetch).
export const TOOLS_ROUTES = ["image", "mcp", "web"];
const count = (v) => Number.isSafeInteger(v) && v >= 0;
const routeCounts = (o) =>
  o !== null &&
  typeof o === "object" &&
  !Array.isArray(o) &&
  JSON.stringify(Object.keys(o).sort()) === JSON.stringify(TOOLS_ROUTES) &&
  TOOLS_ROUTES.every((route) => count(o[route]));

// service-tools /health. Busy reasons come from the request lifecycle
// (requests in flight on the work routes, for their whole response) and from
// background media, research and KV-tail work. Returns { error } when any
// field is missing or has an unexpected type: an ambiguous answer, or a
// service without the request lifecycle, is never read as idle.
export function parseToolsHealth(text) {
  let h;
  try {
    h = JSON.parse(text);
  } catch {
    return { error: "service-tools /health is not JSON" };
  }
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
    return { error: "service-tools /health ambiguous" };
  const r = h.requests;
  if (
    !r ||
    typeof r !== "object" ||
    !count(r.active) ||
    !routeCounts(r.active_by_route) ||
    !routeCounts(r.started_total) ||
    typeof h.process_started_unix_seconds !== "number" ||
    !Number.isFinite(h.process_started_unix_seconds) ||
    h.process_started_unix_seconds <= 0
  )
    return {
      error:
        "service-tools /health lacks the request lifecycle (requests, process_started_unix_seconds)",
    };
  const sum = TOOLS_ROUTES.reduce((n, k) => n + r.active_by_route[k], 0);
  if (sum !== r.active)
    return { error: "service-tools request counts do not add up" };
  const busy = [];
  if (r.active > 0)
    busy.push(
      `requests.active=${r.active} (${TOOLS_ROUTES.map((k) => `${k}=${r.active_by_route[k]}`).join(" ")})`,
    );
  if (h.image_active > 0) busy.push(`image_active=${h.image_active}`);
  if (h.image_busy) busy.push("image_busy");
  if (h.image_recovery_required) busy.push("image_recovery_required");
  if (h.video_active) busy.push("video_active");
  if (h.deep_research.active > 0)
    busy.push(`deep_research.active=${h.deep_research.active}`);
  if (h.kv_tail.jobs > 0) busy.push(`kv_tail.jobs=${h.kv_tail.jobs}`);
  return {
    busy,
    started: r.started_total,
    processStarted: h.process_started_unix_seconds,
  };
}

// service-tools /metrics: the seeded outcome counters and histograms, whose
// total only grows within one process, and the lifecycle series
// workstation_assistant_active_requests{route},
// workstation_assistant_requests_started_total{route} and
// workstation_assistant_process_start_time_seconds. Returns null for a page
// without the outcome families, and lifecycle null when its series are absent.
export function parseToolsCounters(text) {
  if (!/^# TYPE workstation_assistant_\w+ (counter|histogram)$/m.test(text))
    return null;
  let total = 0,
    series = 0,
    processStarted = null;
  const active = {},
    started = {};
  for (const line of text.split("\n")) {
    const life = line.match(
      /^workstation_assistant_(active_requests|requests_started_total)\{route="([a-z]+)"\} (\S+)$/,
    );
    if (life) {
      const value = Number(life[3]);
      if (!count(value)) return null;
      (life[1] === "active_requests" ? active : started)[life[2]] = value;
    }
    const start = line.match(
      /^workstation_assistant_process_start_time_seconds (\S+)$/,
    );
    if (start) processStarted = Number(start[1]);
    const m = line.match(
      /^workstation_assistant_\w+?(?:_total|_count)\{[^}]*\} (\S+)$/,
    );
    if (!m) continue;
    const value = Number(m[1]);
    if (!Number.isFinite(value) || value < 0) return null;
    total += value;
    series++;
  }
  if (!series) return null;
  const lifecycle =
    routeCounts(active) &&
    routeCounts(started) &&
    Number.isFinite(processStarted) &&
    processStarted > 0
      ? { active, started, processStarted }
      : null;
  return { total, series, lifecycle };
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
  const health = parseToolsHealth(parts["tools-health"].join("\n"));
  if (health.error) return { unavailable: health.error };
  const counters = parseToolsCounters(parts["tools-metrics"].join("\n"));
  if (!counters) return { unavailable: "service-tools /metrics unreadable" };
  if (!counters.lifecycle)
    return {
      unavailable: "service-tools /metrics lacks the request lifecycle series",
    };
  // /health and /metrics are two reads of one process. A different process
  // identity is ambiguous; a different count means requests in between.
  if (
    Math.abs(counters.lifecycle.processStarted - health.processStarted) >= 0.01
  )
    return {
      unavailable:
        "service-tools /health and /metrics come from different processes",
    };
  const busy = [...health.busy];
  if (
    TOOLS_ROUTES.some(
      (k) =>
        counters.lifecycle.active[k] > 0 ||
        counters.lifecycle.started[k] !== health.started[k],
    )
  )
    busy.push("/metrics shows requests in flight or started after /health");
  return {
    ...sglang,
    tools: {
      busy,
      started: health.started,
      processStarted: health.processStarted,
      counterTotal: counters.total,
      health: parts["tools-health"].join("\n").trim(),
    },
  };
}

// Whether a sample shows the shared services idle. `previous` is the last
// readable sample. Against it, service-tools must show the same process, the
// same number of started requests on every route and the same outcome-counter
// total: with no request in flight at either read, no request ran between
// them. `ownRequests` is 1 during our own run, 0 before it.
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
  if (previous && !previous.unavailable) {
    const before = previous.tools,
      now = sample.tools;
    if (before.processStarted !== now.processStarted)
      reasons.push("service-tools process changed");
    else {
      const changed = TOOLS_ROUTES.filter(
        (k) => before.started[k] !== now.started[k],
      );
      if (changed.length)
        reasons.push(
          `service-tools requests started (${changed.map((k) => `${k} ${before.started[k]} -> ${now.started[k]}`).join(", ")})`,
        );
      if (before.counterTotal !== now.counterTotal)
        reasons.push(
          `service-tools counters ${before.counterTotal} -> ${now.counterTotal}`,
        );
    }
  }
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
  if (
    args.length < 2 ||
    args.length > 4 ||
    !["long", "game", undefined].includes(args[3])
  ) {
    console.error(
      "Usage: node test/manual-long-benchmark-wait.mjs LABEL AGENT_DIRECTORY [TIMEOUT_MINUTES] [long|game]",
    );
    return 2;
  }
  const [label, agent] = [args[0], resolve(args[1])];
  const minutes = Number(args[2] ?? 30);
  const task = args[3] ?? "long";
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
      "--task",
      task,
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
    // Observation identity: one ready endpoint and the one process it reached.
    // Requests that another process or replica serves are not observed.
    serviceTools: {
      readyEndpoints: 1,
      processStartedBefore: before.tools.processStarted,
      processStartedAfter: after?.tools.processStarted ?? null,
      requestsStartedBefore: before.tools.started,
      requestsStartedAfter: after?.tools.started ?? null,
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
