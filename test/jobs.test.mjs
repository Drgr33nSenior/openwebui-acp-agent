import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, realpath, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Jobs } from "../dist/jobs.js";
import { command, CommandOutput } from "../dist/commands.js";
import { sandboxCommand, commandSchema } from "../dist/sandbox.js";
import { Backend } from "../dist/backend.js";

const root = await realpath(await mkdtemp(join(tmpdir(), "ow-jobs-")));
const result = (output = "done", code = 0) =>
  JSON.stringify({ code, output, limitedOrCancelled: false });
async function waitFor(predicate) {
  const end = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() >= end) throw new Error("Fixture timed out");
    await delay(10);
  }
}
const untilStopped = async (signal) => {
  signal.throwIfAborted();
  await new Promise((resolve) =>
    signal.addEventListener("abort", resolve, { once: true }),
  );
  return result("stopped");
};

test("job schema keeps foreground defaults and bounds background duration", () => {
  const parsed = commandSchema.parse({ executable: "echo", args: [] });
  assert.equal(parsed.background, false);
  assert.equal(parsed.timeout_ms, 120000);
  assert.equal(
    commandSchema.parse({
      executable: "echo",
      args: [],
      background: true,
      timeout_ms: 600000,
    }).background,
    true,
  );
  for (const timeout_ms of [0, -1, 600001, 1.5])
    assert.throws(() =>
      commandSchema.parse({ executable: "echo", args: [], timeout_ms }),
    );
});

test("output collection keeps independent UTF-8 streams and byte bounds", async () => {
  const output = new CommandOutput(100);
  const euro = Buffer.from("€");
  output.write(euro.subarray(0, 1), "stdout");
  output.write(Buffer.from("notice "), "stderr");
  output.write(euro.subarray(1), "stdout");
  assert.equal(await output.finish(), "notice €");
  const bounded = new CommandOutput(5);
  assert(bounded.write(Buffer.from([255, 255, 255])));
  assert(Buffer.byteLength(await bounded.finish()) <= 5);
});

test("stream redaction handles overlapping complete secrets and unfinished prefixes", () => {
  const backend = new Backend(
    { url: "http://127.0.0.1:9", model: "fixture" },
    "ababa",
  );
  assert.equal(backend.redactSnapshot("ababa"), "[REDACTED]");
  assert.equal(backend.redactSnapshot("ready aba"), "ready ");
  assert.equal(
    backend.redactSnapshot("ready ababa done"),
    "ready [REDACTED] done",
  );
  backend.addSecrets(["other-secret"]);
  assert.equal(backend.redactSnapshot("ready other-se"), "ready ");
  assert.equal(
    backend.redactSnapshot("ababa other-secret done"),
    "[REDACTED] [REDACTED] done",
  );
});

test("jobs return immediately, isolate sessions and enforce active and retained limits", async () => {
  const jobs = new Jobs(),
    other = new Jobs();
  let started = 0;
  const run = (signal) => {
    started++;
    return untilStopped(signal);
  };
  const entries = Array.from({ length: 4 }, () => jobs.start(run));
  assert.equal(started, 0);
  assert.throws(() => jobs.start(run), /four/);
  assert.throws(() => other.poll(entries[0].id), /Unknown job/);
  const separate = other.start(untilStopped);
  await waitFor(() => started === 4);
  await jobs.stopAll();
  assert(jobs.list().every((j) => j.state === "stopped"));
  assert.equal(other.poll(separate.id).state, "running");
  await other.stopAll();
  for (let i = 0; i < 20; i++) {
    const item = jobs.start(async () => result());
    await waitFor(() => jobs.poll(item.id).state === "completed");
  }
  assert.equal(jobs.list().length, 16);
  assert.throws(() => jobs.poll(entries[0].id), /Unknown job/);
});

test("job cancellation before launch prevents work and timeout stops running work", async () => {
  const jobs = new Jobs();
  let executed = false;
  const first = jobs.start(async () => {
    executed = true;
    return result();
  });
  await jobs.stop(first.id);
  assert.equal(executed, false);
  assert.equal(jobs.poll(first.id).state, "stopped");
  const timed = jobs.start(untilStopped, { timeoutMs: 100 });
  await waitFor(() => jobs.poll(timed.id).state === "stopped");
  assert.equal(jobs.poll(timed.id).limitedOrCancelled, true);
  const controller = new AbortController();
  controller.abort();
  assert.throws(() =>
    jobs.start(async () => result(), { signal: controller.signal }),
  );
  assert.throws(() => jobs.start(async () => result(), { timeoutMs: 600001 }));
});

test("job output uses bounded cursor pages and never exposes arbitrary exceptions", async () => {
  const jobs = new Jobs();
  const text = "😀".repeat(20000);
  const item = jobs.start(async (_signal, output) => {
    await output(text);
    return result(text);
  });
  await waitFor(() => jobs.poll(item.id).state === "completed");
  let combined = "",
    cursor = 0;
  do {
    const page = jobs.poll(item.id, cursor);
    assert(page.output.length <= 16000);
    assert(!page.output.includes("�"));
    combined += page.output;
    if (page.nextOffset === cursor) break;
    cursor = page.nextOffset;
  } while (true);
  assert.equal(combined, text);
  assert.throws(() => jobs.poll(item.id, -1));
  const bad = jobs.start(async () => {
    throw new Error("synthetic-private-error-must-not-escape");
  });
  await waitFor(() => jobs.poll(bad.id).state === "failed");
  assert(!jobs.poll(bad.id).output.includes("synthetic-private"));
  const malformed = jobs.start(async () => "not json");
  await waitFor(() => jobs.poll(malformed.id).state === "failed");
});

test("job output overflow aborts its runner and preserves only bounded output", async () => {
  const jobs = new Jobs();
  let aborted = false;
  const item = jobs.start(async (signal, output) => {
    await output("x".repeat(200000));
    aborted = signal.aborted;
    return result("x".repeat(200000));
  });
  await waitFor(() => jobs.poll(item.id).state !== "running");
  assert(aborted);
  assert.equal(jobs.poll(item.id).limitedOrCancelled, true);
  let cursor = 0;
  while (true) {
    const page = jobs.poll(item.id, cursor);
    if (page.nextOffset === cursor) break;
    cursor = page.nextOffset;
  }
  assert.equal(cursor, 100000);
});

for (const sandboxed of [false, true]) {
  test(`command output streams before exit and preserves fragmented UTF-8 (${sandboxed ? "sandboxed" : "local"})`, async () => {
    const snapshots = [];
    let completed = false;
    const run = sandboxed
      ? (code, callback) =>
          sandboxCommand(
            process.execPath,
            ["-e", code],
            { root, mode: "workspace", network: async () => false },
            AbortSignal.timeout(10000),
            undefined,
            callback,
          )
      : (code, callback) =>
          command(
            process.execPath,
            ["-e", code],
            root,
            AbortSignal.timeout(10000),
            undefined,
            callback,
          );
    const response = run(
      "process.stdout.write('ready\\n');const euro=Buffer.from('€');setTimeout(()=>process.stdout.write(euro.subarray(0,1)),80);setTimeout(()=>process.stdout.write(euro.subarray(1)),160);setTimeout(()=>process.stdout.write(' done\\n'),350)",
      (output) => {
        assert.equal(completed, false);
        snapshots.push(output);
      },
    ).then((value) => {
      completed = true;
      return JSON.parse(value);
    });
    await waitFor(() => snapshots.some((s) => s === "ready\n"));
    const actual = await response;
    assert.equal(actual.code, 0, actual.output);
    assert.equal(actual.output, "ready\n€ done\n");
    assert(snapshots.every((s) => !s.includes("�")));
    assert.equal(snapshots.at(-1), actual.output);
  });
}

test("sandbox progress never emits a fragmented ephemeral proxy credential", async () => {
  const snapshots = [];
  const raw = await sandboxCommand(
    process.execPath,
    [
      "-e",
      "const password=new URL(process.env.HTTP_PROXY).password;process.stdout.write('ready\\n');setTimeout(()=>process.stdout.write(password.slice(0,7)),80);setTimeout(()=>process.stdout.write(password.slice(7)+'\\n'),200);setTimeout(()=>{},400)",
    ],
    { root, mode: "workspace", network: async () => false },
    AbortSignal.timeout(10000),
    undefined,
    (text) => snapshots.push(text),
  );
  const actual = JSON.parse(raw);
  assert.equal(actual.code, 0, actual.output);
  assert.equal(actual.output, "ready\n[REDACTED]\n");
  assert(snapshots.length > 0);
  assert(
    snapshots.every((s) => s === "ready\n" || s === "ready\n[REDACTED]\n"),
  );
});

test("stopping an actual background command cleans up its descendants", async () => {
  const jobs = new Jobs();
  const marker = join(root, "background-descendant-marker");
  const code = `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(`setTimeout(()=>require('node:fs').writeFileSync(${JSON.stringify(marker)},'bad'),800)`)}],{stdio:'ignore'});console.log('ready');setInterval(()=>{},1000)`;
  const item = jobs.start((signal, output) =>
    command(
      process.execPath,
      ["-e", code],
      root,
      signal,
      { timeoutMs: 3000, outputBytes: 10000 },
      output,
    ),
  );
  await waitFor(() => jobs.poll(item.id).output.includes("ready"));
  const stopped = await jobs.stop(item.id);
  assert.equal(stopped.state, "stopped");
  await delay(900);
  await assert.rejects(access(marker));
});

test("proxy output ending mid-credential remains redacted at EOF", async () => {
  const snapshots = [];
  const raw = await sandboxCommand(
    process.execPath,
    [
      "-e",
      "process.stdout.write(new URL(process.env.HTTP_PROXY).password.slice(0,7))",
    ],
    { root, mode: "workspace", network: async () => false },
    AbortSignal.timeout(10000),
    undefined,
    (text) => snapshots.push(text),
  );
  const actual = JSON.parse(raw);
  assert.equal(actual.code, 0, actual.output);
  assert.equal(actual.output, "[REDACTED]");
  assert(snapshots.every((s) => s === "[REDACTED]"));
});

test("a command's natural exit also releases descendants retaining its pipes", async () => {
  const marker = join(root, "exited-parent-marker");
  const childCode = `setTimeout(()=>require('node:fs').writeFileSync(${JSON.stringify(marker)},'bad'),1000)`;
  const code = `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(childCode)}],{stdio:'inherit'});process.exit(0)`;
  const raw = await command(
    process.execPath,
    ["-e", code],
    root,
    AbortSignal.timeout(5000),
    { timeoutMs: 2000, outputBytes: 10000 },
  );
  const actual = JSON.parse(raw);
  assert.equal(actual.code, 0);
  assert.equal(actual.limitedOrCancelled, false);
  await delay(1100);
  await assert.rejects(access(marker));
});

for (const sandboxed of [false, true]) {
  test(`a failed progress callback stops its owned process (${sandboxed ? "sandboxed" : "local"})`, async () => {
    const args = ["-e", "console.log('ready');setInterval(()=>{},1000)"];
    const limits = { timeoutMs: 5000, outputBytes: 10000 };
    const output = () => {
      throw new Error("Synthetic private callback failure");
    };
    const started = Date.now();
    const raw = sandboxed
      ? await sandboxCommand(
          process.execPath,
          args,
          { root, mode: "workspace", network: async () => false },
          AbortSignal.timeout(10000),
          limits,
          output,
        )
      : await command(
          process.execPath,
          args,
          root,
          AbortSignal.timeout(10000),
          limits,
          output,
        );
    assert(Date.now() - started < 4000);
    const actual = JSON.parse(raw);
    assert.equal(actual.limitedOrCancelled, true);
    assert.equal(actual.output, "ready\n");
    assert(!raw.includes("Synthetic private callback failure"));
  });
}
