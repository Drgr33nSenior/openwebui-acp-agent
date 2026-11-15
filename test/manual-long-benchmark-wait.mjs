// Runs test/manual-long-benchmark.mjs once on a shared inference server, only
// overnight and only when the SGLang server is idle. Explicit use only.
//
//   LONG_BENCHMARK_SSH=user@server LONG_BENCHMARK_NAMESPACE=namespace \
//   LONG_BENCHMARK_SERVICE=service LONG_BENCHMARK_METRICS_PORT=port \
//   LONG_BENCHMARK_RESULTS=/absolute/results/dir \
//     node test/manual-long-benchmark-wait.mjs LABEL AGENT_DIRECTORY [TIMEOUT_MINUTES]
//
// Optional: LONG_BENCHMARK_NOT_BEFORE (ISO time with offset, e.g.
// 2026-11-16T20:00:00Z) and LONG_BENCHMARK_IDLE_SECONDS (quiet period before
// starting, default 300, minimum 60).
//
// Site settings have no defaults. Over ssh it only reads: `kubectl get svc` for
// the service address, then the SGLang /metrics page. Unavailable or
// incomplete metrics never count as idle. The run starts only between 20:00
// and 07:00 local time, when it can finish before 07:00, and after the server
// has reported no running or queued requests for the whole quiet period. Exit
// status 3 means the window closed without a start. The process environment,
// including the agent's normal authentication, is passed to the runner.
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
  const portText = required(
    "LONG_BENCHMARK_METRICS_PORT",
    /^[1-9]\d{0,4}$/,
    "a port number",
  );
  const port = Number(portText);
  if (portText && /^[1-9]\d{0,4}$/.test(portText) && port > 65535)
    problems.push("LONG_BENCHMARK_METRICS_PORT must be a port number");
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
  return { ssh, namespace, service, port, results, idleSeconds, notBefore };
}

// Read-only: resolve the service address, then fetch the metrics page.
export function remoteCommand({ namespace, service, port }) {
  return (
    `ip=$(kubectl -n ${namespace} get svc ${service} -o jsonpath={.spec.clusterIP})` +
    ` && curl -sf --max-time 10 "http://$ip:${port}/metrics"`
  );
}

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

export function counterDelta(before, after) {
  if (!before || !after) return null;
  const delta = {};
  for (const [key, value] of Object.entries(before.counters))
    if (key in after.counters) delta[key] = after.counters[key] - value;
  return delta;
}

// Waits for a start. `metrics` returns parseMetrics output or null.
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
    if (!sample) {
      log("metrics unavailable; not treated as idle");
      quietSince = null;
    } else if (sample.running + sample.queued > 0) {
      log(`busy (running=${sample.running} queued=${sample.queued})`);
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

// Requests from someone else while the run was going: more than our own one
// running, or anything queued. Unknown when no sample could be read.
export function contention(samples) {
  const read = samples.filter((s) => s);
  return {
    samples: samples.length,
    unavailable: samples.length - read.length,
    maxRunning: read.length ? Math.max(...read.map((s) => s.running)) : null,
    maxQueued: read.length ? Math.max(...read.map((s) => s.queued)) : null,
    contended: read.length
      ? read.some((s) => s.running > 1 || s.queued > 0)
      : null,
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
        done(null);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        done(code === 0 ? parseMetrics(text) : null);
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
          (s ? `running=${s.running} queued=${s.queued}` : "unavailable") +
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
  const after = await metrics();
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
    contention: contention(samples),
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
