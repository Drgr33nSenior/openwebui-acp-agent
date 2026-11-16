// An unsandboxed job must not outlive the agent CLI process, even when the
// agent is SIGKILLed and runs no cleanup, and its timeout must not depend on
// the agent's timers.
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

// Starts the real CLI with an approved unsandboxed background job whose
// command has a child of its own. Returns the agent, the job's processes and
// their group, which the test must end.
async function agentWithJob(timeoutMs) {
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
    connection,
    group: undefined,
    end() {
      if (agent.exitCode === null && agent.signalCode === null)
        agent.kill("SIGKILL");
      if (this.group)
        try {
          process.kill(-this.group, "SIGKILL");
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
              executable: process.execPath,
              args: [
                "-e",
                `const c = require("node:child_process").spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
                 require("node:fs").writeFileSync("pids.txt", process.pid + " " + c.pid);
                 setInterval(() => {}, 1000);`,
              ],
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
    const [command, grandchild] = text.split(" ").map(Number);
    job.command = command;
    job.grandchild = grandchild;
    job.group = Number(processField(command, "pgid"));
    job.watchdog = Number(processField(command, "ppid"));
    return job;
  } catch (error) {
    job.end();
    throw error;
  }
}

test(
  "an unsandboxed job's process group ends when the agent is SIGKILLed",
  { skip: !posix && "macOS and Linux only", timeout: 30000 },
  async () => {
    const job = await agentWithJob(60000);
    try {
      // The command runs under its watchdog, which leads the job's group.
      assert.equal(job.group, job.watchdog);
      assert.notEqual(job.group, job.agent.pid);
      assert.match(processField(job.watchdog, "args"), /command-watchdog\.js/);
      assert.deepEqual(
        liveGroupMembers(job.group).sort((a, b) => a - b),
        [job.watchdog, job.command, job.grandchild].sort((a, b) => a - b),
      );
      job.agent.kill("SIGKILL");
      assert(
        await until(() => liveGroupMembers(job.group).length === 0, 5000),
        "Job processes outlived the agent",
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
      assert.equal(liveGroupMembers(job.group).length, 3);
      assert(
        await until(() => liveGroupMembers(job.group).length === 0, 8000),
        "Job processes outlived their timeout",
      );
    } finally {
      job.end();
    }
  },
);
