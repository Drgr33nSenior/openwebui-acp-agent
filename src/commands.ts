import { fork, spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { abortable } from "./cancel.js";
import { StringDecoder } from "node:string_decoder";

export const DEFAULT_COMMAND_TIMEOUT_MS = 120000;
export const MAX_COMMAND_TIMEOUT_MS = 600000;
export function validateCommandTimeout(timeoutMs: number) {
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > MAX_COMMAND_TIMEOUT_MS
  )
    throw new Error("Command timeout must be an integer from 1 to 600000 ms");
}

// Snapshots replace earlier output; they are not append-only chunks. Callers
// must redact their own credentials, including incomplete secret prefixes.
export type OutputCallback = (snapshot: string) => void | Promise<void>;
export function utf8Prefix(bytes: Uint8Array, limit: number): string {
  // Streaming decode omits a trailing partial codepoint rather than producing
  // a replacement character that could exceed the output budget.
  const decoded = new TextDecoder().decode(bytes, { stream: true });
  return new TextDecoder().decode(Buffer.from(decoded).subarray(0, limit), {
    stream: true,
  });
}

export class CommandOutput {
  private bytes = Buffer.alloc(0);
  private received = 0;
  private decoders = {
    stdout: new StringDecoder("utf8"),
    stderr: new StringDecoder("utf8"),
  };
  private timer?: ReturnType<typeof setTimeout>;
  private pending?: Promise<void>;
  private dirty = false;
  private closed = false;
  constructor(
    private readonly limit: number,
    private readonly callback?: OutputCallback,
    private readonly failed: () => void = () => {},
  ) {}
  get text() {
    return utf8Prefix(this.bytes, this.limit);
  }
  write(bytes: Buffer, channel: "stdout" | "stderr" = "stdout"): boolean {
    if (this.closed) return false;
    const room = Math.max(0, this.limit - this.received);
    const accepted = bytes.subarray(0, room);
    this.received += accepted.length;
    // Each pipe has its own UTF-8 sequence boundaries. A stderr chunk must not
    // be inserted inside a partially received stdout codepoint, or vice versa.
    const rendered = Buffer.from(this.decoders[channel].write(accepted));
    const outputRoom = Math.max(0, this.limit - this.bytes.length);
    this.bytes = Buffer.concat([this.bytes, rendered.subarray(0, outputRoom)]);
    this.dirty = true;
    if (this.callback && !this.timer && !this.pending)
      this.timer = setTimeout(() => {
        this.timer = undefined;
        void this.publish();
      }, 50);
    return bytes.length > room || rendered.length > outputRoom;
  }
  private publish(): Promise<void> {
    if (this.pending) return this.pending;
    const work = async () => {
      while (this.dirty && this.callback) {
        this.dirty = false;
        await abortable(
          Promise.resolve().then(() => this.callback!(this.text)),
          AbortSignal.timeout(2000),
        );
      }
    };
    this.pending = work()
      .catch(() => {
        this.dirty = false;
        this.failed();
      })
      .finally(() => {
        this.pending = undefined;
      });
    return this.pending;
  }
  async finish() {
    this.closed = true;
    clearTimeout(this.timer);
    await this.publish();
    return this.text;
  }
}
export function childEnv() {
  const env: Record<string, string> = {};
  for (const name of [
    "PATH",
    "HOME",
    "XDG_CONFIG_HOME",
    "SystemRoot",
    "WINDIR",
    "TEMP",
    "TMP",
    "LANG",
  ]) {
    const v = process.env[name];
    if (v) env[name] = v;
  }
  return env;
}
// Unsandboxed POSIX commands lead their own process groups, and their timeout
// timers live in this process. A supervisor process, started on first use,
// also holds each running command's group and deadline, so the timeout still
// holds and the group is killed when this process dies without cleanup. The
// map is in memory only and lists only this process's running commands; it
// re-registers them if a supervisor has to be restarted.
const supervised = new Map<number, number>();
let supervisor: ChildProcess | undefined;
function tellSupervisor(message: object) {
  try {
    supervisor?.send(message, (error) => {
      if (error) supervisor = undefined;
    });
  } catch {
    supervisor = undefined;
  }
}
function supervise(group: number, timeoutMs: number) {
  supervised.set(group, Date.now() + timeoutMs);
  if (!supervisor?.connected) {
    supervisor = undefined;
    try {
      const child = fork(
        fileURLToPath(new URL("./command-supervisor.js", import.meta.url)),
        [],
        {
          cwd: "/",
          env: childEnv(),
          execArgv: [],
          detached: true,
          serialization: "json",
          stdio: ["ignore", "ignore", "ignore", "ipc"],
        },
      );
      child.once("error", () => {});
      child.once("disconnect", () => {
        if (supervisor === child) supervisor = undefined;
      });
      // It must not keep an otherwise finished agent process running.
      child.unref();
      child.channel?.unref();
      supervisor = child;
    } catch {
      // The command keeps this process's timeout and exit cleanup.
      return;
    }
    for (const [running, deadline] of supervised)
      tellSupervisor({
        type: "watch",
        group: running,
        timeoutMs: Math.max(1, deadline - Date.now()),
      });
  } else tellSupervisor({ type: "watch", group, timeoutMs });
}
function unsupervise(group: number) {
  if (!supervised.delete(group)) return;
  tellSupervisor({ type: "unwatch", group });
}

export async function command(
  executable: string,
  args: string[],
  cwd: string,
  signal: AbortSignal,
  limits = { timeoutMs: DEFAULT_COMMAND_TIMEOUT_MS, outputBytes: 100000 },
  onOutput?: OutputCallback,
  // Called with the child's PID, which leads its own process group on POSIX.
  onSpawn?: (pid: number) => void,
) {
  signal.throwIfAborted();
  validateCommandTimeout(limits.timeoutMs);
  return new Promise<string>((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd,
      env: childEnv(),
      shell: false,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    // Register before anything can yield to the event loop: the message is
    // written to the supervisor's channel synchronously.
    if (process.platform !== "win32" && child.pid)
      supervise(child.pid, limits.timeoutMs);
    if (child.pid) onSpawn?.(child.pid);
    const deadline = Date.now() + limits.timeoutMs;
    let failed = false;
    const stop = () => {
      failed = true;
      try {
        if (process.platform !== "win32" && child.pid)
          process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {
        /* Already exited. */
      }
    };
    const output = new CommandOutput(limits.outputBytes, onOutput, stop);
    const timer = setTimeout(stop, limits.timeoutMs);
    signal.addEventListener("abort", stop, { once: true });
    const collect = (b: Buffer, channel: "stdout" | "stderr") => {
      if (output.write(b, channel)) stop();
    };
    child.stdout.on("data", (b) => collect(b, "stdout"));
    child.stderr.on("data", (b) => collect(b, "stderr"));
    child.once("exit", () => {
      // Descendants retaining stdout/stderr can delay close indefinitely after
      // their parent exits. They still belong to this command's process group.
      if (process.platform !== "win32" && child.pid) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          /* Already exited. */
        }
        unsupervise(child.pid);
      }
    });
    child.once("error", () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", stop);
      reject(new Error("Command could not start"));
    });
    child.once("close", async (code) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", stop);
      // The supervisor may have ended the group while this process was stalled.
      if (code === null && Date.now() >= deadline) failed = true;
      resolve(
        JSON.stringify({
          code,
          output: await output.finish(),
          limitedOrCancelled: failed,
        }),
      );
    });
    if (signal.aborted) stop();
  });
}
