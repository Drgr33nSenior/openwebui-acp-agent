import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import {
  canonicalAddress,
  controlPorts,
  excludedLoopbackPort,
  isLoopbackAddress,
  loopbackAddresses,
  ownedListenerDecision,
  ownedProcesses,
  ownsLoopbackListener,
  parseLsof,
  parseProcNetTcp,
  parseProcStat,
  parsePs,
  reaches,
  sensitiveLoopbackPorts,
} from "../dist/loopback.js";

test("only literal loopback addresses and locally resolved localhost qualify", async () => {
  for (const a of ["127.0.0.1", "127.9.8.7", "::1", "0:0:0:0:0:0:0:1"])
    assert(isLoopbackAddress(a), a);
  for (const a of ["128.0.0.1", "::2", "10.0.0.1", "0.0.0.0", "::", "127.1"])
    assert(!isLoopbackAddress(a), a);
  assert.equal(canonicalAddress("::ffff:127.0.0.1"), "127.0.0.1");
  assert.equal(canonicalAddress("0:0:0:0:0:0:0:1"), "::1");
  const resolver = (answers) => async (host) => {
    assert.equal(host, "localhost");
    if (answers instanceof Error) throw answers;
    return answers;
  };
  const both = resolver([
    { address: "::1", family: 6 },
    { address: "127.0.0.1", family: 4 },
  ]);
  assert.deepEqual(await loopbackAddresses("127.0.0.1", both), ["127.0.0.1"]);
  assert.deepEqual(await loopbackAddresses("::ffff:127.0.0.2", both), [
    "127.0.0.2",
  ]);
  assert.deepEqual(await loopbackAddresses("LocalHost", both), [
    "::1",
    "127.0.0.1",
  ]);
  // A localhost that resolves anywhere else, or cannot be resolved, is not loopback.
  assert.equal(
    await loopbackAddresses(
      "localhost",
      resolver([
        { address: "127.0.0.1", family: 4 },
        { address: "192.0.2.1", family: 4 },
      ]),
    ),
    undefined,
  );
  assert.equal(await loopbackAddresses("localhost", resolver([])), undefined);
  assert.equal(
    await loopbackAddresses("localhost", resolver(new Error("no resolver"))),
    undefined,
  );
  // Names that merely resolve to loopback keep the ordinary per-host prompt.
  for (const host of [
    "127.1",
    "2130706433",
    "0x7f.0.0.1",
    "app.localhost",
    "localhost.example.org",
    "localtest.me",
    "example.org",
    "192.0.2.1",
  ])
    assert.equal(await loopbackAddresses(host, both), undefined, host);
});

test("reserved service and control-channel ports are excluded", () => {
  const control = controlPorts([
    "http://127.0.0.1:8080/openwebui",
    "http://localhost:64999/sse",
    "https://[::1]/mcp",
    "http://chat.example.org:3000",
    "not a url",
  ]);
  assert.deepEqual(
    [...control].sort((a, b) => a - b),
    [443, 8080, 64999],
  );
  for (const port of [
    63342, 63350, 63361, 64342, 2375, 2376, 5432, 3306, 6379, 27017, 9200,
    11434, 9222, 9229, 8080, 64999, 443,
  ])
    assert(excludedLoopbackPort(port, control), String(port));
  for (const port of [3000, 5173, 8000, 63362, 4173, 54321])
    assert(!excludedLoopbackPort(port, control), String(port));
  assert(!excludedLoopbackPort(8080, new Set()));
  for (const entry of sensitiveLoopbackPorts) {
    assert(entry.from <= entry.to && entry.service.length > 3);
  }
});

test("macOS ps and lsof output is parsed into processes and listeners", () => {
  assert.deepEqual(parsePs("    1     0     1\n  354     1   354\nbad\n"), [
    { pid: 1, ppid: 0, pgid: 1 },
    { pid: 354, ppid: 1, pgid: 354 },
  ]);
  const listeners = parseLsof(
    [
      "p765",
      "f10",
      "tIPv4",
      "n*:56664",
      "f11",
      "tIPv6",
      "n*:56664",
      "p1341",
      "f57",
      "tIPv4",
      "n127.0.0.1:30000",
      "f58",
      "tIPv6",
      "n[::1]:30001",
      "f59",
      "tIPv6",
      "n[fe80::1%lo0]:30002",
      "f60",
      "tIPv4",
      "n127.0.0.1:1->127.0.0.1:2",
      "",
    ].join("\n"),
  );
  assert.deepEqual(listeners, [
    { address: "0.0.0.0", port: 56664, pid: 765 },
    { address: "::", port: 56664, pid: 765 },
    { address: "127.0.0.1", port: 30000, pid: 1341 },
    { address: "::1", port: 30001, pid: 1341 },
    { address: "fe80::1", port: 30002, pid: 1341 },
  ]);
});

test("Linux /proc stat and tcp tables are parsed for both byte orders", () => {
  assert.deepEqual(
    parseProcStat("4242 (node (dev) server) S 4200 4200 4200 0 -1 4194560"),
    { pid: 4242, ppid: 4200, pgid: 4200 },
  );
  assert.equal(parseProcStat("garbage"), undefined);
  const header =
    "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n";
  const v4 =
    header +
    "   0: 0100007F:0BB8 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 111 1 0000000000000000 100 0 0 10 0\n" +
    "   1: 00000000:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 222 1 0000000000000000 100 0 0 10 0\n" +
    "   2: 0100007F:0BB8 0100007F:D431 01 00000000:00000000 00:00000000 00000000  1000        0 333 1 0000000000000000 20 4 30 10 -1\n";
  assert.deepEqual(parseProcNetTcp(v4, true), [
    { address: "127.0.0.1", port: 3000, inode: "111" },
    { address: "0.0.0.0", port: 8080, inode: "222" },
  ]);
  assert.deepEqual(
    parseProcNetTcp(
      header +
        "   0: 7F000001:0BB8 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 444 1\n",
      false,
    ),
    [{ address: "127.0.0.1", port: 3000, inode: "444" }],
  );
  const v6 =
    header +
    "   0: 00000000000000000000000001000000:0BB8 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 555 1\n" +
    "   1: 00000000000000000000000000000000:0BB9 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 666 1\n" +
    "   2: 0000000000000000FFFF00000100007F:0BBA 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 777 1\n";
  assert.deepEqual(parseProcNetTcp(v6, true), [
    { address: "::1", port: 3000, inode: "555" },
    { address: "::", port: 3001, inode: "666" },
    { address: "127.0.0.1", port: 3002, inode: "777" },
  ]);
  assert.deepEqual(
    parseProcNetTcp(
      header +
        "   0: 00000000000000000000000000000001:0BB8 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 888 1\n",
      false,
    ),
    [{ address: "::1", port: 3000, inode: "888" }],
  );
});

test("ownership covers job descendants and process groups; every answering listener must be owned", () => {
  const table = [
    { pid: 1, ppid: 0, pgid: 1 },
    { pid: 100, ppid: 1, pgid: 100 }, // job root
    { pid: 101, ppid: 100, pgid: 100 }, // child
    { pid: 102, ppid: 101, pgid: 102 }, // grandchild in its own group
    { pid: 103, ppid: 1, pgid: 100 }, // orphan still in the job's group
    { pid: 200, ppid: 1, pgid: 200 }, // unrelated
  ];
  assert.deepEqual(
    [...ownedProcesses(table, [100])].sort((a, b) => a - b),
    [100, 101, 102, 103],
  );
  assert(reaches("0.0.0.0", "127.0.0.1"));
  assert(reaches("::", "127.0.0.1"));
  assert(reaches("::", "::1"));
  assert(!reaches("0.0.0.0", "::1"));
  assert(!reaches("127.0.0.1", "::1"));
  assert(!reaches("127.0.0.2", "127.0.0.1"));
  const owned = new Set([100, 101, 102]);
  const isOwned = (l) => owned.has(l.pid);
  const mine = { address: "127.0.0.1", port: 3000, pid: 101 };
  assert(ownedListenerDecision([mine], isOwned, ["127.0.0.1"], 3000));
  assert(!ownedListenerDecision([mine], isOwned, ["127.0.0.1"], 3001));
  assert(!ownedListenerDecision([mine], isOwned, ["::1"], 3000));
  // localhost resolving to both families: an unanswered family is fine, a
  // foreign listener on the other loopback address is not.
  assert(ownedListenerDecision([mine], isOwned, ["::1", "127.0.0.1"], 3000));
  const foreign = { address: "::1", port: 3000, pid: 200 };
  assert(
    !ownedListenerDecision(
      [mine, foreign],
      isOwned,
      ["::1", "127.0.0.1"],
      3000,
    ),
  );
  assert(ownedListenerDecision([mine, foreign], isOwned, ["127.0.0.1"], 3000));
  const wildcard = { address: "::", port: 3000, pid: 200 };
  assert(
    !ownedListenerDecision([mine, wildcard], isOwned, ["127.0.0.1"], 3000),
  );
  assert(!ownedListenerDecision([], isOwned, ["127.0.0.1"], 3000));
});

const posix = process.platform === "darwin" || process.platform === "linux";
test(
  "real listeners: a job's descendant is owned, other listeners and failures are not",
  { skip: !posix && "macOS and Linux only" },
  async (t) => {
    // The root is its own process-group leader, as the job runner starts it;
    // the listener is in a grandchild.
    const child = spawn(
      process.execPath,
      [
        "-e",
        `const { spawn } = require("node:child_process");
         const c = spawn(process.execPath, ["-e", "const s = require('node:net').createServer().listen(0, '127.0.0.1', () => console.log(s.address().port)); setInterval(() => {}, 1000)"], { stdio: ["ignore", "inherit", "inherit"] });
         setInterval(() => {}, 1000);`,
      ],
      { detached: true, stdio: ["ignore", "pipe", "inherit"] },
    );
    t.after(() => {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        /* Already exited. */
      }
    });
    const [line] = await once(child.stdout, "data");
    const port = Number(String(line).trim());
    assert(port > 0);
    const query = { roots: [child.pid], targets: ["127.0.0.1"], port };
    assert.equal(await ownsLoopbackListener(query), true);
    // localhost-style targets: the unanswered ::1 does not block the decision.
    assert.equal(
      await ownsLoopbackListener({ ...query, targets: ["::1", "127.0.0.1"] }),
      true,
    );
    assert.equal(await ownsLoopbackListener({ ...query, roots: [] }), false);
    assert.equal(
      await ownsLoopbackListener({ ...query, targets: ["127.0.0.2"] }),
      false,
    );
    assert.equal(
      await ownsLoopbackListener({ ...query, platform: "win32" }),
      false,
    );
    // Detection failure (here, an already-cancelled request) is never an allow.
    const cancelled = new AbortController();
    cancelled.abort();
    assert.equal(
      await ownsLoopbackListener({
        ...query,
        port: port === 65535 ? 65534 : port + 1,
        signal: cancelled.signal,
      }),
      false,
    );

    // A listener outside the job's process tree is not owned.
    const other = createServer().listen(0, "127.0.0.1");
    await once(other, "listening");
    t.after(() => other.close());
    const otherPort = other.address().port;
    assert.equal(
      await ownsLoopbackListener({ ...query, port: otherPort }),
      false,
    );
    // An individually named process (the agent's static preview) is owned
    // for its own listeners only.
    assert.equal(
      await ownsLoopbackListener({
        roots: [],
        pids: [process.pid],
        targets: ["127.0.0.1"],
        port: otherPort,
      }),
      true,
    );
    // A stopped job is no longer an owner once its listener closes.
    process.kill(-child.pid, "SIGKILL");
    await once(child, "exit");
    await delay(1600); // Past the positive-answer cache.
    assert.equal(await ownsLoopbackListener(query), false);
  },
);
