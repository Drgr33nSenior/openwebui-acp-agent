// An unsandboxed job must not outlive the agent CLI process, even when the
// agent is SIGKILLed and runs no cleanup, and its timeout must not depend on
// the agent's timers. Commands keep leading their own process groups.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:http";
import { Readable, Writable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { ClientApp, ndJsonStream } from "@agentclientprotocol/sdk";

const posix = process.platform === "darwin" || process.platform === "linux";
const temp = await realpath(await mkdtemp(join(tmpdir(), "ow-lifetime-")));
const state = join(temp, "state");
process.env.OPENWEBUI_ACP_HOME = state;
const { writeJson, configSchema } = await import("../dist/config.js");
const { command } = await import("../dist/commands.js");

let pending = [];
const server = createServer(async (req, res) => {
  res.setHeader("Content-Type", "application/json");
  if (req.url === "/api/models")
    return res.end(JSON.stringify({ data: [{ id: "fixture" }] }));
  await new Promise((r) => req.resume().once("end", r));
  const calls = pending.shift();
  res.end(
    JSON.stringify({
      choices: [
        {
          message: calls
            ? { role: "assistant", content: null, tool_calls: calls }
            : { role: "assistant", content: "done" },
        },
      ],
    }),
  );
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
await writeJson(
  "config.json",
  configSchema.parse({
    url: `http://127.0.0.1:${server.address().port}`,
    model: "fixture",
  }),
);
after(async () => {
  await new Promise((r) => server.close(r));
  await rm(temp, { recursive: true, force: true });
});

// Members of a process group that have not exited. A zombie has exited but
// stays listed until its parent (here possibly a stopped agent) reaps it.
function liveGroupMembers(group) {
  return execFileSync(
    "ps",
    ["-A", "-o", "pid=", "-o", "pgid=", "-o", "stat="],
    {
      encoding: "utf8",
    },
  )
    .split("\n")
    .map((line) => line.trim().split(/\s+/))
    .filter(
      ([, pgid, stat]) => Number(pgid) === group && !stat?.startsWith("Z"),
    )
    .map(([pid]) => Number(pid));
}
function processField(pid, field) {
  return execFileSync("ps", ["-o", `${field}=`, "-p", String(pid)], {
    encoding: "utf8",
  }).trim();
}
async function until(check, ms) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) return false;
    await delay(100);
  }
  return true;
}
function alive(pid) {
  try {
    return !processField(pid, "stat").startsWith("Z");
  } catch {
    return false; // ps exits nonzero for an unknown process.
  }
}
// The agent's supervisor: its child running command-supervisor.js.
function supervisorOf(agent) {
  return execFileSync(
    "ps",
    ["-A", "-o", "pid=", "-o", "ppid=", "-o", "args="],
    {
      encoding: "utf8",
    },
  )
    .split("\n")
    .map((line) => line.trim().split(/\s+/))
    .filter(
      ([, ppid, ...args]) =>
        Number(ppid) === agent.pid &&
        args.some((a) => a.endsWith("command-supervisor.js")),
    )
    .map(([pid]) => Number(pid));
}
let python;
try {
  execFileSync("python3", ["-c", ""], { stdio: "ignore" });
  python = "python3";
} catch {
  python = undefined;
}
// Tries to leave the command's process group and session, then waits.
const escapeScript = `import os, time
for move in (lambda: os.setpgid(0, 0), os.setsid):
    try:
        move()
        print("moved", flush=True)
    except OSError:
        print("refused", flush=True)
open("pids.txt", "w").write(str(os.getpid()))
time.sleep(60)`;
const nodeJob = [
  process.execPath,
  [
    "-e",
    `const c = require("node:child_process").spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
     require("node:fs").writeFileSync("pids.txt", process.pid + " " + c.pid);
     setInterval(() => {}, 1000);`,
  ],
];

// Starts the real CLI with an approved unsandboxed background job. The job
// writes its PIDs to pids.txt. Returns the agent, the job's processes, their
// group and the agent's supervisor; the test must call end().
async function agentWithJob(timeoutMs, [executable, args] = nodeJob) {
  const cwd = await realpath(await mkdtemp(join(temp, "project-")));
  const home = join(temp, "home");
  await mkdir(home, { recursive: true });
  const agent = spawn(
    process.execPath,
    [
      "--import",
      resolve("test/fixtures/keyring.mjs"),
      resolve("dist/cli.js"),
      "acp",
    ],
    {
      cwd,
      env: {
        PATH: process.env.PATH,
        HOME: home,
        OPENWEBUI_ACP_HOME: state,
        OPENWEBUI_API_KEY: "lifetime-fixture-not-real",
      },
      stdio: ["pipe", "pipe", "ignore"],
    },
  );
  const app = new ClientApp();
  // Workspace activation and the escalated background launch.
  app.onRequest("session/request_permission", () => ({
    outcome: { outcome: "selected", optionId: "once" },
  }));
  const connection = app.connect(
    ndJsonStream(Writable.toWeb(agent.stdin), Readable.toWeb(agent.stdout)),
  );
  const job = {
    agent,
    pids: [],
    supervisors: [],
    end() {
      if (agent.exitCode === null && agent.signalCode === null)
        agent.kill("SIGKILL");
      for (const target of [-this.group, ...this.pids, ...this.supervisors])
        if (target)
          try {
            process.kill(target, "SIGKILL");
          } catch {
            /* Already gone, as expected. */
          }
      connection.close();
    },
  };
  try {
    await connection.agent.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: {},
    });
    const { sessionId } = await connection.agent.request("session/new", {
      cwd,
      mcpServers: [],
    });
    pending = [
      [
        {
          id: "call-job",
          type: "function",
          function: {
            name: "run_command",
            arguments: JSON.stringify({
              executable,
              args,
              background: true,
              timeout_ms: timeoutMs,
              sandbox_permissions: "require_escalated",
              justification: "fixture process lifetime",
            }),
          },
        },
      ],
    ];
    await connection.agent.request("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: "start the fixture job" }],
    });
    let text = "";
    for (const end = Date.now() + 10000; !text; await delay(50)) {
      if (Date.now() > end) throw new Error("Fixture job did not start");
      text = await readFile(join(cwd, "pids.txt"), "utf8").catch(() => "");
    }
    job.pids = text.trim().split(" ").map(Number);
    job.command = job.pids[0];
    job.group = Number(processField(job.command, "pgid"));
    job.supervisors = supervisorOf(agent);
    return job;
  } catch (error) {
    job.end();
    throw error;
  }
}

test(
  "an unsandboxed job's process group and the supervisor end when the agent is SIGKILLed",
  { skip: !posix && "macOS and Linux only", timeout: 30000 },
  async () => {
    const job = await agentWithJob(60000);
    try {
      // The command leads its own group, as before; the supervisor is a
      // separate child of the agent in a group of its own.
      assert.equal(job.group, job.command);
      assert.equal(Number(processField(job.command, "ppid")), job.agent.pid);
      assert.equal(job.supervisors.length, 1);
      const [supervisor] = job.supervisors;
      assert.equal(Number(processField(supervisor, "pgid")), supervisor);
      assert.deepEqual(
        liveGroupMembers(job.group).sort((a, b) => a - b),
        [...job.pids].sort((a, b) => a - b),
      );
      job.agent.kill("SIGKILL");
      assert(
        await until(() => liveGroupMembers(job.group).length === 0, 5000),
        "Job processes outlived the agent",
      );
      assert(
        await until(() => !alive(supervisor), 5000),
        "Supervisor outlived the agent",
      );
    } finally {
      job.end();
    }
  },
);

test(
  "an unsandboxed job's timeout holds without the agent's timers",
  { skip: !posix && "macOS and Linux only", timeout: 30000 },
  async () => {
    const job = await agentWithJob(3000);
    try {
      // A stopped agent keeps its IPC channel open but runs no timers.
      job.agent.kill("SIGSTOP");
      assert.equal(liveGroupMembers(job.group).length, 2);
      assert(
        await until(() => liveGroupMembers(job.group).length === 0, 8000),
        "Job processes outlived their timeout",
      );
    } finally {
      job.end();
    }
  },
);

test(
  "a job that tries to leave its process group or session still ends with the agent",
  {
    skip: (!posix || !python) && "macOS and Linux with python3 only",
    timeout: 30000,
  },
  async () => {
    const job = await agentWithJob(60000, [python, ["-c", escapeScript]]);
    try {
      assert.equal(job.group, job.command);
      job.agent.kill("SIGKILL");
      assert(
        await until(() => !alive(job.command), 5000),
        "Job outlived the agent",
      );
    } finally {
      job.end();
    }
  },
);

test(
  "a command that tries to leave its process group or session is still stopped at its timeout",
  {
    skip: (!posix || !python) && "macOS and Linux with python3 only",
    timeout: 20000,
  },
  async () => {
    const cwd = await realpath(await mkdtemp(join(temp, "escape-")));
    const started = Date.now();
    const result = JSON.parse(
      await command(
        python,
        ["-c", escapeScript],
        cwd,
        AbortSignal.timeout(10000),
        {
          timeoutMs: 800,
          outputBytes: 1000,
        },
      ),
    );
    assert(Date.now() - started < 3000, "Command outlived its timeout");
    assert.equal(result.limitedOrCancelled, true);
    // A session leader can neither change group nor start a new session.
    assert.equal(result.output, "refused\nrefused\n");
    const pid = Number(await readFile(join(cwd, "pids.txt"), "utf8"));
    assert(!alive(pid));
  },
);

test(
  "commands can signal their own process group",
  { skip: !posix && "macOS and Linux only", timeout: 20000 },
  async () => {
    const run = async (script) =>
      JSON.parse(
        await command(
          "/bin/bash",
          ["-c", script],
          temp,
          AbortSignal.timeout(10000),
          {
            timeoutMs: 5000,
            outputBytes: 1000,
          },
        ),
      );
    // The group signal reaches the command's own trap, and nothing else.
    assert.deepEqual(
      await run("trap 'echo survived; exit 0' TERM; kill -TERM 0; sleep 5"),
      { code: 0, output: "survived\n", limitedOrCancelled: false },
    );
    // The common cleanup idiom: $$ is the command's process group.
    const idiom = await run(
      "sleep 30 & echo $!; trap 'trap - TERM && kill -- -$$' INT TERM EXIT; echo done",
    );
    const [background, done] = idiom.output.trim().split("\n");
    assert.equal(done, "done");
    assert.doesNotMatch(idiom.output, /No such process/);
    assert.equal(idiom.code, null);
    assert(await until(() => !alive(Number(background)), 3000));
  },
);

test(
  "a replacement supervisor takes over running commands' deadlines",
  { skip: !posix && "macOS and Linux only", timeout: 20000 },
  async () => {
    const supervisors = () => supervisorOf({ pid: process.pid });
    let pid;
    const started = Date.now();
    const first = command(
      "/bin/sleep",
      ["30"],
      temp,
      AbortSignal.timeout(15000),
      { timeoutMs: 2000, outputBytes: 1000 },
      undefined,
      (p) => (pid = p),
    );
    try {
      assert(await until(() => supervisors().length === 1, 5000));
      const [old] = supervisors();
      process.kill(old, "SIGKILL");
      assert(await until(() => !alive(old), 5000));
      await delay(200); // Let this process observe the disconnect.
      // The next command starts a new supervisor, which also receives the
      // first command's remaining time.
      await command("/usr/bin/true", [], temp, AbortSignal.timeout(5000));
      assert.equal(supervisors().filter((s) => s !== old).length, 1);
      // Block this process's event loop past the first deadline, so only the
      // supervisor can stop the command, and check before the loop resumes.
      const remaining = started + 3500 - Date.now();
      if (remaining > 0)
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, remaining);
      assert(!alive(pid), "Command outlived its timeout");
      assert.equal(JSON.parse(await first).limitedOrCancelled, true);
    } finally {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        /* Already gone, as expected. */
      }
    }
  },
);
