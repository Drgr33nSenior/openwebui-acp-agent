import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { workerEnvironment } from "./settings.mjs";

const mode = process.argv[2] ?? "--stdio";
if (process.argv.length > 3 || !["--stdio", "--http"].includes(mode)) {
  console.error("Usage: node index.mjs [--stdio|--http]");
  process.exit(2);
}
const child = spawn(
  process.execPath,
  [fileURLToPath(new URL("./worker.mjs", import.meta.url)), mode],
  {
    env: workerEnvironment(process.env),
    stdio: "inherit",
    shell: false,
  },
);
let stopping = false;
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"])
  process.once(signal, () => {
    if (stopping) return;
    stopping = true;
    child.kill(signal);
    setTimeout(() => child.kill("SIGKILL"), 5000).unref();
  });
child.once("error", () => {
  console.error("Browser wrapper could not start");
  process.exitCode = 1;
});
child.once("exit", (code) => {
  process.exitCode = code ?? 1;
});
