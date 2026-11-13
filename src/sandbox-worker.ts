// Private subprocess entrypoint. Never run on the ACP stream. Configuration and
// explicit MCP credentials arrive over IPC, not command-line arguments or disk.
import { spawn, type ChildProcess } from "node:child_process";
import {
  SandboxManager,
  type SandboxRuntimeConfig,
} from "@anthropic-ai/sandbox-runtime";
import { z } from "zod";
import { childEnv } from "./commands.js";
import { protectMacKeychain } from "./macos-sandbox.js";
import { Transform } from "node:stream";
import { StringDecoder } from "node:string_decoder";

// Hold a bounded suffix so a proxy credential split across writes is redacted.
function redactedOutput(secrets: string[]) {
  const decoder = new StringDecoder("utf8");
  let pending = "";
  function take(final: boolean) {
    for (const secret of secrets)
      pending = pending.replaceAll(secret, "[REDACTED]");
    let held = 0;
    if (!final)
      for (const secret of secrets)
        for (let n = 1; n < secret.length && n <= pending.length; n++)
          if (pending.endsWith(secret.slice(0, n))) held = Math.max(held, n);
    const end = pending.length - held;
    const text = pending.slice(0, end);
    pending = pending.slice(end);
    return text;
  }
  return new Transform({
    transform(chunk, _encoding, done) {
      pending += decoder.write(chunk);
      done(null, take(false));
    },
    flush(done) {
      pending += decoder.end();
      done(null, take(true));
    },
  });
}

const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";
let child: ChildProcess | undefined;
let stopping = false;
const pending = new Map<number, (value: boolean) => void>();
let sequence = 0;
async function finish(code: number) {
  if (stopping) return;
  stopping = true;
  for (const reply of pending.values()) reply(false);
  pending.clear();
  child?.kill("SIGKILL");
  await SandboxManager.reset().catch(() => {});
  await Promise.all([
    new Promise<void>((r) => process.stdout.write("", () => r())),
    new Promise<void>((r) => process.stderr.write("", () => r())),
  ]);
  process.exit(code);
}
process.once("SIGTERM", () => void finish(143));
process.once("SIGINT", () => void finish(130));
process.once("disconnect", () => void finish(1));
let started = false;
let stage = "input";
const executionEnvironment = childEnv();
// Helpers run outside the boundary. Do not resolve them from project PATH.
process.env.PATH =
  process.platform === "linux"
    ? "/usr/bin:/bin"
    : "/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:/usr/local/bin";
process.on("message", async (raw: any) => {
  if (raw?.type === "network-reply") {
    pending.get(raw.id)?.(raw.allow === true && !stopping);
    pending.delete(raw.id);
    return;
  }
  if (started || raw?.type !== "start") return;
  started = true;
  try {
    if (JSON.stringify(raw).length > 128000) throw new Error("IPC limit");
    const input = z
      .object({
        mode: z.enum(["workspace", "read_only", "full_access"]),
        executable: z.string().min(1).max(4096),
        args: z.array(z.string().max(10000)).max(100),
        root: z.string().max(4096),
        temporary: z.string().max(4096),
        config: z
          .object({ network: z.unknown(), filesystem: z.unknown() })
          .passthrough(),
        env: z.record(
          z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
          z.string().max(16000),
        ),
      })
      .parse(raw);
    if (
      Object.keys(input.env).some((name) =>
        /^(?:LD_|DYLD_|NODE_OPTIONS$|NODE_PATH$|BASH_ENV$|ENV$|PATH$|HOME$|SHELL$|SRT_|CLAUDE_)/i.test(
          name,
        ),
      )
    )
      throw new Error("Unsafe MCP launcher environment variable");
    let argv = [input.executable, ...input.args];
    if (input.mode !== "full_access") {
      stage = "dependencies";
      const deps = await SandboxManager.checkDependenciesAsync();
      if (deps.errors.length) throw new Error("Missing sandbox dependencies");
      process.env.CLAUDE_CODE_TMPDIR = input.temporary;
      stage = "initialization";
      await SandboxManager.initialize(
        input.config as SandboxRuntimeConfig,
        async ({ host, port }) => {
          if (
            stopping ||
            !process.connected ||
            port === undefined ||
            pending.size >= 16
          )
            return false;
          const id = ++sequence;
          return new Promise<boolean>((resolve) => {
            const timer = setTimeout(() => {
              pending.delete(id);
              resolve(false);
            }, 60000);
            pending.set(id, (answer) => {
              clearTimeout(timer);
              resolve(answer);
            });
            process.send!(
              { type: "network", id, host, port },
              undefined,
              undefined,
              () => {},
            );
          });
        },
        false,
      );
      if (stopping) return;
      stage = "policy";
      const wrapped = await SandboxManager.wrapWithSandboxArgv(
        "exec " +
          [
            "/usr/bin/env",
            "PATH=" + (executionEnvironment.PATH ?? "/usr/bin:/bin"),
            "NO_PROXY=",
            "no_proxy=",
            "TMPDIR=" + input.temporary,
            input.executable,
            ...input.args,
          ]
            .map(quote)
            .join(" "),
        "/bin/sh",
        undefined,
        undefined,
        input.root,
      );
      if (stopping) return;
      argv =
        process.platform === "darwin"
          ? protectMacKeychain(wrapped.argv)
          : wrapped.argv;
    }
    stage = "launch";
    child = spawn(argv[0]!, argv.slice(1), {
      cwd: input.root,
      shell: false,
      env: {
        ...(input.mode === "full_access" ? executionEnvironment : childEnv()),
        TMPDIR: input.temporary,
        TMP: input.temporary,
        TEMP: input.temporary,
        ...input.env,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    process.stdin.pipe(child.stdin!);
    const secrets = [SandboxManager.getProxyAuthToken()].filter(
      (s): s is string => !!s,
    );
    child.stdout!.pipe(redactedOutput(secrets)).pipe(process.stdout);
    child.stderr!.pipe(redactedOutput(secrets)).pipe(process.stderr);
    child.once("error", () => {
      process.send?.({ type: "error", stage });
      void finish(126);
    });
    child.once("close", (code) => void finish(code ?? 1));
  } catch {
    // Never forward runtime errors: they can include argv, env or proxy tokens.
    process.send?.({ type: "error", stage });
    await finish(125);
  }
});
if (!process.send) process.exit(125);
