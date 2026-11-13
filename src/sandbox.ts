import { fork, execFile, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, realpath, rm, access } from "node:fs/promises";
import { constants } from "node:fs";
import { isIP } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join, resolve, relative, isAbsolute, parse } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";
import { directory } from "./config.js";
import { childEnv } from "./commands.js";
import {
  agentCodePaths,
  EXECUTION_DIRECTORIES,
  EXECUTION_FILES,
  mentions,
  SECRET_NAMES,
} from "./protected-paths.js";

export const sandboxModes = [
  {
    value: "workspace",
    name: "Workspace write",
    description:
      "OS sandbox: workspace writes, isolated temporary files, network approval.",
  },
  {
    value: "read_only",
    name: "Read-only filesystem",
    description:
      "OS sandbox: no workspace writes. Command approval policy still applies.",
  },
  {
    value: "full_access",
    name: "Unsandboxed (session)",
    description:
      "No OS isolation. Every command requires explicit approval. Resets on restore/revocation.",
  },
] as const;
export type SandboxMode = (typeof sandboxModes)[number]["value"];
export function parseSandboxMode(value: string): SandboxMode {
  if (!sandboxModes.some((m) => m.value === value))
    throw new Error("Unknown sandbox mode");
  return value as SandboxMode;
}
export class SandboxError extends Error {}
export const commandSchema = z
  .object({
    executable: z
      .string()
      .min(1)
      .max(4096)
      .refine((s) => !s.includes("\0")),
    args: z
      .array(
        z
          .string()
          .max(10000)
          .refine((s) => !s.includes("\0")),
      )
      .max(100),
    sandbox_permissions: z
      .enum(["use_default", "require_escalated"])
      .default("use_default"),
    justification: z.string().min(1).max(1000).optional(),
    additional_read_paths: z.array(z.string().max(4096)).max(8).default([]),
    additional_write_paths: z.array(z.string().max(4096)).max(8).default([]),
  })
  .strict()
  .refine(
    (s) =>
      (s.sandbox_permissions !== "require_escalated" &&
        !s.additional_read_paths.length &&
        !s.additional_write_paths.length) ||
      !!s.justification,
    "Scope expansion requires a justification",
  );
export type CommandInput = z.infer<typeof commandSchema>;
export type NetworkRequest = { host: string; port: number };
export type SandboxRun = {
  mode: SandboxMode;
  root: string;
  readPaths?: string[];
  writePaths?: string[];
  // Only explicitly configured MCP variables, never the agent's environment.
  env?: Record<string, string>;
  network: (request: NetworkRequest, signal: AbortSignal) => Promise<boolean>;
};
const literal = (path: string) => ({ path, literal: true as const });
// This bundled executable runs inside the Linux boundary. Home is otherwise
// hidden, including per-user npm installations. Grant only this installed file.
const linuxHelper = fileURLToPath(
  new URL(
    `../vendor/seccomp/${process.arch}/apply-seccomp`,
    import.meta.resolve("@anthropic-ai/sandbox-runtime"),
  ),
);
const inside = (parent: string, path: string) => {
  const r = relative(parent, path);
  return !r || (!isAbsolute(r) && !r.split(/[\\/]/).includes(".."));
};
export async function scopePaths(paths: string[]) {
  const out: string[] = [];
  for (const path of paths) {
    if (!isAbsolute(path))
      throw new SandboxError(
        "Sandbox exceptions require existing absolute paths",
      );
    const p = await realpath(path);
    if (
      p === parse(p).root ||
      p === (await realpath(homedir())) ||
      inside(resolve(directory), p) ||
      mentions(
        [
          ...SECRET_NAMES,
          ".config",
          ".codex",
          ".agents",
          "workstation-agent",
          "Keychains",
        ],
        p,
      )
    )
      throw new SandboxError(
        "Sandbox exception targets a protected path or broad root",
      );
    out.push(p);
  }
  return out;
}
export function sandboxPolicy(
  run: SandboxRun,
  temporary: string,
): SandboxRuntimeConfig {
  // Shared with the file tools (protected-paths.ts): sandboxed commands may not
  // write what later runs outside the sandbox either.
  const protectedPaths = [...EXECUTION_DIRECTORIES, ...EXECUTION_FILES];
  // Literal entries prevent metacharacters in workspace names broadening scope.
  const privatePaths = [
    resolve(directory),
    join(homedir(), ".ssh"),
    join(homedir(), ".aws"),
    join(homedir(), ".config"),
    join(homedir(), ".codex"),
    join(homedir(), "Library/Keychains"),
  ];
  const contentRoots = [
    run.root,
    ...(run.readPaths ?? []),
    ...(run.writePaths ?? []),
  ];
  const globLiteral = (p: string) => p.replace(/[?*[]/g, (c) => `[${c}]`);
  return {
    network: {
      allowedDomains: [],
      deniedDomains: [],
      allowUnixSockets: [],
      allowAllUnixSockets: false,
      allowLocalBinding: false,
    },
    filesystem: {
      denyRead: [
        ...[
          homedir(),
          "/Users",
          "/home",
          "/root",
          tmpdir(),
          "/tmp",
          "/private/tmp",
          "/var/tmp",
          ...privatePaths,
        ].map(literal),
        ...contentRoots.flatMap((r) =>
          SECRET_NAMES.map((name) => join(globLiteral(r), "**", name)),
        ),
      ],
      allowRead: [
        run.root,
        temporary,
        ...(run.readPaths ?? []),
        ...(process.platform === "linux" ? [linuxHelper] : []),
      ].map(literal),
      allowWrite: [
        temporary,
        ...(run.mode === "workspace"
          ? [run.root, ...(run.writePaths ?? [])]
          : []),
      ].map(literal),
      denyWrite: [
        ...privatePaths,
        ...[run.root, ...(run.writePaths ?? [])].flatMap((r) =>
          // SRT 0.0.83 appends mandatory Git child denies after configured
          // parents. On Linux, a missing child then cannot get its mountpoint
          // below the read-only parent. Emit the SAME child denies first; the
          // runtime deduplicates its copies. Keep the full .git deny as well.
          // The same applies to .claude: the runtime adds .claude/commands and
          // .claude/agents after a configured .claude parent.
          [
            ".git/hooks",
            ".git/config",
            ".claude/commands",
            ".claude/agents",
            ...protectedPaths,
          ].map((p) => join(r, p)),
        ),
        ...agentCodePaths(),
        "/tmp/claude",
        "/private/tmp/claude",
      ].map(literal),
    },
    enableWeakerNestedSandbox: false,
    enableWeakerNetworkIsolation: false,
    allowPty: false,
  };
}
export async function probeLinuxNamespaces(run = promisify(execFile)) {
  try {
    await run(
      "/usr/bin/bwrap",
      [
        "--unshare-user",
        "--unshare-pid",
        "--unshare-net",
        "--unshare-ipc",
        "--unshare-uts",
        "--die-with-parent",
        "--new-session",
        "--ro-bind",
        "/",
        "/",
        "--proc",
        "/proc",
        "--dev",
        "/dev",
        "/usr/bin/true",
      ],
      {
        cwd: "/",
        env: { PATH: "/usr/bin:/bin" },
        timeout: 5000,
        maxBuffer: 4096,
      },
    );
    return {
      available: true,
      detail:
        "Bubblewrap namespace creation succeeded; full filesystem/network enforcement tests are still required",
    };
  } catch (error) {
    const e = error as NodeJS.ErrnoException & { stderr?: string };
    return {
      available: false,
      detail:
        e.code === "ENOENT"
          ? "Bubblewrap is missing"
          : /not permitted|permission denied|user namespace/i.test(
                e.stderr ?? "",
              )
            ? "Host or outer container denied namespace creation. Ask the host administrator to inspect kernel, AppArmor/SELinux and container restrictions; do not disable them globally."
            : "Bubblewrap namespace probe failed or timed out; inspect host support before running commands",
    };
  }
}
export async function sandboxDiagnostics(probe = false) {
  if (process.platform === "win32")
    return {
      platform: process.platform,
      available: false,
      errors: [
        "Native Windows requires verified storage ACLs and sandbox installation; use WSL2 for this preview",
      ],
      warnings: [],
    };
  const paths =
    process.platform === "darwin"
      ? ["/usr/bin/sandbox-exec"]
      : process.platform === "linux"
        ? ["/usr/bin/bwrap", "/usr/bin/socat", "/usr/bin/rg", linuxHelper]
        : [];
  const errors: string[] = paths.length
    ? []
    : ["Unsupported OS sandbox platform"];
  for (const path of paths)
    await access(path, constants.X_OK).catch(() =>
      errors.push(`Missing sandbox dependency: ${path}`),
    );
  const namespaces =
    probe && process.platform === "linux" && !errors.length
      ? await probeLinuxNamespaces()
      : undefined;
  if (namespaces && !namespaces.available) errors.push(namespaces.detail);
  return {
    platform: process.platform,
    available: errors.length === 0,
    errors,
    warnings: [],
    namespaces,
    verification: namespaces
      ? "Executable presence and namespace probe; full enforcement tests still required"
      : "Executable presence only; namespace/Seatbelt enforcement is checked when running",
  };
}

// One broker process per invocation. The runtime has global mutable state;
// sharing it across sessions could mix roots, credentials and network grants.
export async function startSandbox(
  executable: string,
  args: string[],
  run: SandboxRun,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  if (!["darwin", "linux"].includes(process.platform))
    throw new SandboxError(
      "OS sandbox unavailable on this platform; native Windows preview is blocked pending ACL and runner validation",
    );
  if (process.platform === "linux")
    await access(linuxHelper, constants.X_OK).catch(() => {
      throw new SandboxError(
        "Bundled Linux seccomp helper is missing or not executable; refusing execution",
      );
    });
  const temporary = await realpath(
    await mkdtemp(join(tmpdir(), "openwebui-sandbox-")),
  );
  let child: ChildProcess;
  try {
    child = fork(
      fileURLToPath(new URL("./sandbox-worker.js", import.meta.url)),
      [],
      {
        cwd: run.root,
        // The runtime creates Linux proxy bridge sockets via os.tmpdir(). Keep
        // them in this invocation's allowed temp scope before importing it;
        // otherwise the filesystem deny hides its sockets under the shared /tmp.
        env: {
          ...childEnv(),
          TMPDIR: temporary,
          TMP: temporary,
          TEMP: temporary,
        },
        execArgv: [],
        detached: true,
        stdio: ["pipe", "pipe", "pipe", "ipc"],
      },
    );
  } catch {
    await rm(temporary, { recursive: true, force: true });
    throw new SandboxError("Sandbox broker could not start");
  }
  let stopped = false,
    error: string | undefined;
  const lifetime = new AbortController();
  const networkSignal = AbortSignal.any([signal, lifetime.signal]);
  const kill = (name: NodeJS.Signals) => {
    try {
      if (child.pid) process.kill(-child.pid, name);
    } catch {
      /* Already exited. */
    }
  };
  const stop = () => {
    if (stopped) return;
    stopped = true;
    lifetime.abort();
    kill("SIGTERM");
    // Also kill descendants if the broker exits before they do.
    setTimeout(() => kill("SIGKILL"), 500).unref();
  };
  signal.addEventListener("abort", stop, { once: true });
  const done = new Promise<{ code: number | null; error?: string }>(
    (resolve) => {
      child.once("error", () => {
        error = "Sandbox broker could not start";
      });
      child.once("close", async (code) => {
        lifetime.abort();
        signal.removeEventListener("abort", stop);
        kill("SIGKILL");
        await rm(temporary, { recursive: true, force: true }).catch(() => {});
        resolve({ code, error });
      });
    },
  );
  let networkCount = 0;
  // Serialize requests from one process so a hostile client cannot flood ACP.
  let queue = Promise.resolve();
  child.on("message", (message: any) => {
    if (message?.type === "error") {
      const stage = [
        "input",
        "dependencies",
        "initialization",
        "policy",
        "launch",
      ].includes(message.stage)
        ? message.stage
        : "execution";
      error = `Sandbox ${stage} failed; run /doctor. No unrestricted retry was performed.`;
    }
    if (message?.type !== "network" || stopped || signal.aborted) return;
    const { id, host, port } = message;
    if (
      typeof id !== "number" ||
      typeof host !== "string" ||
      host.length > 253 ||
      (!isIP(host) && !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(host)) ||
      !Number.isInteger(port) ||
      port < 1 ||
      port > 65535 ||
      ++networkCount > 32
    ) {
      if (child.connected)
        child.send({ type: "network-reply", id, allow: false });
      return;
    }
    queue = queue.then(async () => {
      let allow = false;
      if (!stopped && !signal.aborted)
        allow = await run
          .network({ host, port }, networkSignal)
          .catch(() => false);
      if (child.connected)
        child.send(
          {
            type: "network-reply",
            id,
            allow: !stopped && !signal.aborted && allow,
          },
          () => {},
        );
    });
  });
  if (signal.aborted) stop();
  else
    child.send(
      {
        type: "start",
        mode: run.mode,
        executable,
        args,
        root: run.root,
        temporary,
        config: sandboxPolicy(run, temporary),
        env: run.env ?? {},
      },
      (e) => {
        if (e) stop();
      },
    );
  return { child, done, stop };
}

export async function sandboxCommand(
  executable: string,
  args: string[],
  run: SandboxRun,
  signal: AbortSignal,
  limits = { timeoutMs: 30000, outputBytes: 100000 },
): Promise<string> {
  const process = await startSandbox(executable, args, run, signal);
  process.child.stdin!.end();
  let output = Buffer.alloc(0),
    limitedOrCancelled = false;
  const stop = () => {
    limitedOrCancelled = true;
    process.stop();
  };
  const timer = setTimeout(stop, limits.timeoutMs);
  signal.addEventListener("abort", stop, { once: true });
  const collect = (bytes: Buffer) => {
    const room = limits.outputBytes - output.length;
    output = Buffer.concat([output, bytes.subarray(0, Math.max(0, room))]);
    if (bytes.length > room) stop();
  };
  process.child.stdout!.on("data", collect);
  process.child.stderr!.on("data", collect);
  try {
    const result = await process.done;
    if (result.error) throw new SandboxError(result.error);
    return JSON.stringify({
      code: result.code,
      output: output.toString("utf8"),
      limitedOrCancelled: limitedOrCancelled || signal.aborted,
    });
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", stop);
  }
}
