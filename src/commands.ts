import { spawn } from "node:child_process";
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
    let output = "",
      failed = false;
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
    const timer = setTimeout(stop, limits.timeoutMs);
    signal.addEventListener("abort", stop, { once: true });
    const collect = (b: Buffer) => {
      output += b.toString("utf8");
      if (Buffer.byteLength(output) > limits.outputBytes) {
        output = Buffer.from(output)
          .subarray(0, limits.outputBytes)
          .toString("utf8");
        stop();
      }
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    child.once("error", () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", stop);
      reject(new Error("Command could not start"));
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", stop);
      resolve(JSON.stringify({ code, output, limitedOrCancelled: failed }));
    });
  });
}
