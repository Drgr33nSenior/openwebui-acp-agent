import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  realpath,
  symlink,
  access,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir, homedir } from "node:os";
import { createServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { execFileSync } from "node:child_process";
import {
  sandboxCommand,
  sandboxPolicy,
  commandSchema,
  scopePaths,
  sandboxDiagnostics,
  startSandbox,
} from "../dist/sandbox.js";
import { protectMacKeychain } from "../dist/macos-sandbox.js";
import { target } from "../dist/workspace.js";

const temp = await realpath(await mkdtemp(join(tmpdir(), "ow-isolation-")));
const root = join(temp, "project [literal] 'quoted'");
const sibling = join(temp, "sibling");
await mkdir(root);
await mkdir(sibling);
await writeFile(join(root, "public.txt"), "public");
await writeFile(join(root, ".env"), "synthetic-not-a-real-secret");
await mkdir(join(root, ".git"));
await writeFile(join(root, ".git", "config"), "fixture-git-config");
await mkdir(join(root, "deploy"));
await writeFile(join(root, "deploy", "id_ed25519"), "synthetic-key-fixture");
await writeFile(join(root, ".netrc"), "synthetic-netrc-fixture");
await mkdir(join(root, ".husky"));
await mkdir(join(root, ".claude"));
await writeFile(join(sibling, "private.txt"), "synthetic-outside-content");
await symlink(sibling, join(root, "escape"));
const plan = { mode: "workspace", root, network: async () => false };
async function run(code, policy = plan, limits) {
  return JSON.parse(
    await sandboxCommand(
      process.execPath,
      ["-e", code],
      policy,
      AbortSignal.timeout(20000),
      limits,
    ),
  );
}

test("sandbox input and scope exceptions validate exact paths", async () => {
  assert.equal(
    commandSchema.parse({ executable: "echo", args: [] }).sandbox_permissions,
    "use_default",
  );
  assert.throws(() =>
    commandSchema.parse({
      executable: "echo",
      args: [],
      sandbox_permissions: "require_escalated",
    }),
  );
  assert.throws(() =>
    commandSchema.parse({
      executable: "echo",
      args: [],
      additional_write_paths: [sibling],
    }),
  );
  assert.throws(() =>
    commandSchema.parse({ executable: "bad\0name", args: [] }),
  );
  await assert.rejects(scopePaths(["relative"]));
  await assert.rejects(scopePaths([homedir()]));
  await assert.rejects(scopePaths(["/"]));
  assert.deepEqual(await scopePaths([join(root, "escape")]), [sibling]);
  const p = sandboxPolicy(plan, "/private/tmp/isolated");
  assert(p.filesystem.allowWrite.some((x) => x.path === root && x.literal));
  assert.equal(p.network.allowAllUnixSockets, false);
  assert.equal(p.enableWeakerNestedSandbox, false);
  assert.deepEqual(p.network.allowedDomains, []);
  await assert.rejects(
    target(process.cwd(), "dist/sandbox-worker.js", true),
    /protected/,
  );
  await target(process.cwd(), "dist/sandbox-worker.js");
});

test("real OS sandbox permits workspace writes and denies sibling, symlink, sensitive-file and Git-metadata access", async () => {
  const sharedFile = join(await mkdtemp("/tmp/ow-shared-denied-"), "game.js");
  const result = await run(`
    const fs=require('node:fs');const path=require('node:path');const r={};
    for(const [name,fn] of Object.entries({
      read:()=>fs.readFileSync('public.txt','utf8'),
      write:()=>fs.writeFileSync('created.txt','ok'),
      sensitive:()=>fs.readFileSync('.env','utf8'),
      outsideRead:()=>fs.readFileSync(${JSON.stringify(join(sibling, "private.txt"))},'utf8'),
      outsideWrite:()=>fs.writeFileSync(${JSON.stringify(join(sibling, "bad.txt"))},'bad'),
      escape:()=>fs.readFileSync('escape/private.txt','utf8'),
      gitWrite:()=>fs.writeFileSync('.git/config','bad'),
      sharedTemporary:()=>fs.writeFileSync(${JSON.stringify(sharedFile)},'bad'),
      gitConfigRead:()=>fs.readFileSync('.git/config','utf8'),
      keyRead:()=>fs.readFileSync('deploy/id_ed25519','utf8'),
      netrcRead:()=>fs.readFileSync('.netrc','utf8'),
      hookWrite:()=>fs.writeFileSync('.husky/pre-commit','bad'),
      claudeWrite:()=>fs.writeFileSync('.claude/settings.json','bad'),
      envrcWrite:()=>fs.writeFileSync('.envrc','bad'),
      temporary:()=>fs.writeFileSync(path.join(process.env.TMPDIR,'local.txt'),'ok')
    })) { try { fn(); r[name]=true; } catch { r[name]=false; } }
    console.log(JSON.stringify(r));
  `);
  assert.equal(result.code, 0, result.output);
  assert.deepEqual(JSON.parse(result.output), {
    read: true,
    write: true,
    sensitive: false,
    outsideRead: false,
    outsideWrite: false,
    escape: false,
    gitWrite: false,
    sharedTemporary: false,
    gitConfigRead: true,
    keyRead: false,
    netrcRead: false,
    hookWrite: false,
    claudeWrite: false,
    envrcWrite: false,
    temporary: true,
  });
  assert.equal(
    await readFile(join(root, ".git/config"), "utf8"),
    "fixture-git-config",
  );
  await assert.rejects(access(join(sibling, "bad.txt")));
  await assert.rejects(access(sharedFile));
});

test("private scratch storage works in both sandbox modes and ends with each command", async () => {
  for (const mode of ["workspace", "read_only"]) {
    const result = await run(
      `
      const fs=require('node:fs');const path=require('node:path');
      const file=path.join(require('node:os').tmpdir(),'game.js');
      fs.writeFileSync(file,'scratch');
      console.log(JSON.stringify({file,contents:fs.readFileSync(file,'utf8')}));
      ${mode === "workspace" ? "fs.writeFileSync('persistent.js','workspace artifact');" : ""}
    `,
      { ...plan, mode },
    );
    assert.equal(result.code, 0, result.output);
    const scratch = JSON.parse(result.output);
    assert.equal(scratch.contents, "scratch");
    await assert.rejects(access(scratch.file));
  }
  const later = await run(
    "console.log(require('node:fs').readFileSync('persistent.js','utf8'))",
  );
  assert.equal(later.code, 0, later.output);
  assert.equal(later.output.trim(), "workspace artifact");
});

test("read-only sandbox denies project writes while explicit scope grants remain bounded", async () => {
  const denied = await run(
    `require('node:fs').writeFileSync('readonly-denied.txt','bad')`,
    { ...plan, mode: "read_only" },
  );
  assert.notEqual(denied.code, 0);
  const granted = await run(
    `console.log(require('node:fs').readFileSync(${JSON.stringify(join(sibling, "private.txt"))},'utf8'))`,
    { ...plan, readPaths: [sibling] },
  );
  assert.equal(granted.code, 0, granted.output);
  const readonly = await run(
    `require('node:fs').writeFileSync(${JSON.stringify(join(sibling, "still-denied.txt"))},'bad')`,
    { ...plan, readPaths: [sibling] },
  );
  assert.notEqual(readonly.code, 0);
});

test("argv remains literal and agent secrets do not enter sandbox children", async () => {
  process.env.OPENWEBUI_API_KEY = "synthetic-do-not-inherit";
  const literal = "$(touch injected) `touch other` ' ; echo escaped";
  const result = JSON.parse(
    await sandboxCommand(
      process.execPath,
      [
        "-e",
        "console.log(JSON.stringify({arg:process.argv[1],key:process.env.OPENWEBUI_API_KEY??null,nodeOptions:process.env.NODE_OPTIONS??null}))",
        literal,
      ],
      plan,
      AbortSignal.timeout(15000),
    ),
  );
  assert.equal(result.code, 0, result.output);
  assert.deepEqual(JSON.parse(result.output), {
    arg: literal,
    key: null,
    nodeOptions: null,
  });
  await assert.rejects(access(join(root, "injected")));
});

test("network proxy requests approval before a connection, denial prevents traffic and direct sockets cannot bypass it", async () => {
  let hits = 0,
    approvals = 0;
  const server = createServer((req, res) => {
    hits++;
    res.end("fixture-network-ok");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  try {
    const curl = async (allow) =>
      JSON.parse(
        await sandboxCommand(
          "/usr/bin/curl",
          [
            "--silent",
            "--show-error",
            "--fail",
            "--max-time",
            "5",
            `http://127.0.0.1:${port}/`,
          ],
          {
            ...plan,
            network: async (request) => {
              assert.equal(request.host, "127.0.0.1");
              assert.equal(request.port, port);
              assert.equal(hits, 0);
              approvals++;
              return allow;
            },
          },
          AbortSignal.timeout(15000),
        ),
      );
    const denied = await curl(false);
    assert.notEqual(denied.code, 0);
    assert.equal(hits, 0);
    assert.equal(approvals, 1, denied.output);
    const allowed = await curl(true);
    assert.equal(allowed.code, 0, allowed.output);
    assert.equal(hits, 1);
    const direct = await run(
      `const n=require('node:net').connect(${port},'127.0.0.1');n.on('connect',()=>process.exit(7));n.on('error',()=>process.exit(0));setTimeout(()=>process.exit(0),500)`,
    );
    assert.equal(direct.code, 0, direct.output);
    assert.equal(hits, 1);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test("timeout, output limits and cancellation stop sandbox processes; temporary state is removed", async () => {
  const result = await run(
    "console.log(process.env.TMPDIR);setInterval(()=>{},1000)",
    plan,
    { timeoutMs: 1500, outputBytes: 1000 },
  );
  assert.equal(result.limitedOrCancelled, true);
  await assert.rejects(access(result.output.trim()));
  const bounded = await run(
    "process.stdout.write('x'.repeat(200000));setInterval(()=>{},1000)",
    plan,
    { timeoutMs: 5000, outputBytes: 1000 },
  );
  assert.equal(bounded.limitedOrCancelled, true);
  assert(Buffer.byteLength(bounded.output) <= 1000);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    sandboxCommand("/bin/echo", ["never"], plan, controller.signal),
  );
});

test("concurrent sandbox invocations do not share roots or exception policy", async () => {
  const code = `try { console.log(require('node:fs').readFileSync(${JSON.stringify(join(sibling, "private.txt"))},'utf8')) } catch { console.log('denied') }`;
  const [a, b] = await Promise.all([
    run(code),
    run(code, { ...plan, root: sibling }),
  ]);
  assert.equal(a.output.trim(), "denied");
  assert.equal(b.output.trim(), "synthetic-outside-content");
});

test("diagnostics report dependencies without running workspace code", async () => {
  const d = await sandboxDiagnostics();
  assert.equal(typeof d.available, "boolean");
  assert(Array.isArray(d.errors));
});

test("profile hardening refuses an unexpected wrapper rather than losing credential IPC protection", () => {
  assert.throws(() => protectMacKeychain(["/bin/sh", "-c", "echo unexpected"]));
  assert.throws(() =>
    protectMacKeychain(["/bin/bash", "-c", "echo unexpected"]),
  );
});

test(
  "macOS credential-service IPC is denied without opening or reading a keychain",
  { skip: process.platform !== "darwin" },
  async () => {
    const source = join(root, "mach-check.c"),
      binary = join(root, "mach-check");
    // A native fixture is needed to test Mach IPC. It only looks up the service
    // port; it never requests a credential or opens any real keychain file.
    await writeFile(
      source,
      '#include <servers/bootstrap.h>\nint main(void) { mach_port_t p; return bootstrap_look_up(bootstrap_port,"com.apple.securityd.xpc",&p) == KERN_SUCCESS ? 0 : 7; }\n',
    );
    execFileSync("/usr/bin/clang", [source, "-o", binary]);
    execFileSync(binary); // Establish that denial isn't simply a missing service.
    const result = JSON.parse(
      await sandboxCommand(binary, [], plan, AbortSignal.timeout(10000)),
    );
    assert.equal(result.code, 7, result.output);
  },
);

test("ephemeral proxy credentials are redacted even when output is fragmented", async () => {
  const result = await run(
    `const u=new URL(process.env.HTTP_PROXY);process.stdout.write(u.password.slice(0,7));setTimeout(()=>process.stdout.write(u.password.slice(7)+'\\n'),50)`,
  );
  assert.equal(result.code, 0, result.output);
  assert.equal(result.output.trim(), "[REDACTED]");
});

test("cancelling a command kills descendants and a late network reply cannot restart it", async () => {
  const controller = new AbortController();
  const marker = join(root, "descendant-marker");
  const p = await startSandbox(
    process.execPath,
    [
      "-e",
      `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(`setTimeout(()=>require('node:fs').writeFileSync(${JSON.stringify(marker)},'bad'),900)`)}],{stdio:'ignore'});console.log('ready');setInterval(()=>{},1000)`,
    ],
    plan,
    controller.signal,
  );
  p.child.stderr.resume();
  await new Promise((r, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Child did not start")),
      5000,
    );
    p.child.stdout.once("data", () => {
      clearTimeout(timer);
      r();
    });
  });
  controller.abort();
  await p.done;
  await new Promise((r) => setTimeout(r, 1000));
  await assert.rejects(access(marker));

  let hits = 0,
    reply,
    requested;
  const ready = new Promise((r) => {
    requested = r;
  });
  const server = createServer((req, res) => {
    hits++;
    res.end("unexpected");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const c = new AbortController();
  const runPromise = sandboxCommand(
    "/usr/bin/curl",
    [
      "--silent",
      "--max-time",
      "5",
      `http://127.0.0.1:${server.address().port}/`,
    ],
    {
      ...plan,
      network: async () =>
        new Promise((r) => {
          reply = r;
          requested();
        }),
    },
    c.signal,
  );
  try {
    await Promise.race([
      ready,
      runPromise.then((output) => {
        throw new Error("Command exited before network approval: " + output);
      }),
    ]);
    c.abort();
    await runPromise;
    reply(true);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(hits, 0);
  } finally {
    c.abort();
    await new Promise((r) => server.close(r));
  }
});

test("HTTPS through the sandbox preserves certificate validation and supports an explicitly supplied CA", async () => {
  const certificate = join(root, "fixture-ca.crt"),
    key = join(temp, "synthetic-tls.key"),
    config = join(temp, "fixture-openssl.cnf");
  await writeFile(
    config,
    "[req]\ndistinguished_name=dn\nx509_extensions=v3\nprompt=no\n[dn]\nCN=localhost\n[v3]\nsubjectAltName=DNS:localhost,IP:127.0.0.1\n",
  );
  execFileSync(
    "/usr/bin/openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      key,
      "-out",
      certificate,
      "-days",
      "1",
      "-config",
      config,
    ],
    { stdio: "ignore" },
  );
  const server = createHttpsServer(
    { key: await readFile(key), cert: await readFile(certificate) },
    (_req, res) => res.end("tls-verified"),
  );
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const url = `https://127.0.0.1:${server.address().port}/`;
  const policy = { ...plan, network: async () => true };
  try {
    const untrusted = JSON.parse(
      await sandboxCommand(
        "/usr/bin/curl",
        ["--silent", "--show-error", "--fail", "--max-time", "5", url],
        policy,
        AbortSignal.timeout(10000),
      ),
    );
    assert.notEqual(untrusted.code, 0);
    const trusted = JSON.parse(
      await sandboxCommand(
        "/usr/bin/curl",
        [
          "--silent",
          "--show-error",
          "--fail",
          "--max-time",
          "5",
          "--cacert",
          certificate,
          url,
        ],
        policy,
        AbortSignal.timeout(10000),
      ),
    );
    assert.equal(trusted.code, 0, trusted.output);
    assert.equal(trusted.output, "tls-verified");
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test("Git deny ordering protects missing metadata and worktree files without blocking ordinary writes", async () => {
  for (const kind of ["empty-directory", "worktree-file"]) {
    const project = await mkdtemp(join(temp, "git-case-"));
    if (kind === "empty-directory") await mkdir(join(project, ".git"));
    else
      await writeFile(
        join(project, ".git"),
        "gitdir: ../unapproved-metadata\n",
      );
    const code = `const fs=require('node:fs'); fs.writeFileSync('allowed.txt','ok'); const out={}; for(const [name,action] of Object.entries({config:()=>fs.writeFileSync('.git/config','bad'),hooks:()=>fs.mkdirSync('.git/hooks'),replace:()=>fs.renameSync('.git','.git-moved'),metadata:()=>fs.writeFileSync('.git','bad')})) {try {action();out[name]='allowed'}catch{out[name]='denied'}} console.log(JSON.stringify(out))`;
    const result = JSON.parse(
      await sandboxCommand(
        process.execPath,
        ["-e", code],
        { ...plan, root: project },
        AbortSignal.timeout(10000),
      ),
    );
    assert.equal(result.code, 0, result.output);
    assert.deepEqual(JSON.parse(result.output), {
      config: "denied",
      hooks: "denied",
      replace: "denied",
      metadata: "denied",
    });
    assert.equal(await readFile(join(project, "allowed.txt"), "utf8"), "ok");
  }
});
