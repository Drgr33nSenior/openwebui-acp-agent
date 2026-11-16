import { fork, spawn } from "node:child_process";
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
export async function command(
  executable: string,
  args: string[],
  cwd: string,
  signal: AbortSignal,
  limits = { timeoutMs: DEFAULT_COMMAND_TIMEOUT_MS, outputBytes: 100000 },
  onOutput?: OutputCallback,
  // Called with the child's PID. On POSIX it is the command's watchdog, which
  // leads the process group that contains the command and its descendants.
  onSpawn?: (pid: number) => void,
) {
  signal.throwIfAborted();
  validateCommandTimeout(limits.timeoutMs);
  return new Promise<string>((resolve, reject) => {
    // The watchdog ends the group when this process exits by any means and
    // enforces the timeout itself. Native Windows has no process groups here
    // and keeps the direct child; see docs/windows-plan.md.
    const child =
      process.platform === "win32"
        ? spawn(executable, args, {
            cwd,
            env: childEnv(),
            shell: false,
            stdio: ["ignore", "pipe", "pipe"],
          })
        : fork(
            fileURLToPath(new URL("./command-watchdog.js", import.meta.url)),
            [String(limits.timeoutMs), executable, ...args],
            {
              cwd,
              env: childEnv(),
              execArgv: [],
              detached: true,
              serialization: "json",
              stdio: ["ignore", "pipe", "pipe", "ipc"],
            },
          );
    if (child.pid) onSpawn?.(child.pid);
    let failed = false;
    let startFailed = false;
    child.on("message", (message: { type?: unknown } | null) => {
      if (message?.type === "timeout") failed = true;
      if (message?.type === "error") startFailed = true;
    });
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
    child.stdout!.on("data", (b: Buffer) => collect(b, "stdout"));
    child.stderr!.on("data", (b: Buffer) => collect(b, "stderr"));
    child.once("exit", () => {
      // Descendants retaining stdout/stderr can delay close indefinitely after
      // their parent exits. They still belong to this command's process group.
      if (process.platform !== "win32" && child.pid)
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          /* Already exited. */
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
      if (startFailed) {
        await output.finish();
        return reject(new Error("Command could not start"));
      }
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
