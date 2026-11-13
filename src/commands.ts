import { spawn } from "node:child_process";
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
  limits = { timeoutMs: 30000, outputBytes: 100000 },
) {
  signal.throwIfAborted();
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
