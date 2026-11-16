// Private subprocess entrypoint for unsandboxed commands on macOS and Linux.
// The agent starts it as a new process-group leader with an IPC channel; the
// command runs in that group. The agent's own timers and cleanup die with the
// agent, so this process enforces the command timeout and kills its whole
// group when the channel closes, which happens however the agent exits,
// including SIGKILL and crashes. It never reads or relays command output.
import { spawn } from "node:child_process";

function stopGroup(): never {
  try {
    process.kill(-process.pid, "SIGKILL");
  } catch {
    /* Not a group leader; still never leave the command unsupervised. */
  }
  process.exit(1);
}
// Tell a live agent why the group is ending; a dead agent cannot delay it.
function report(type: "timeout" | "error") {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, 1000);
    try {
      if (!process.connected) return resolve();
      process.send!({ type }, undefined, undefined, () => resolve());
    } catch {
      resolve();
    }
  });
}

const [timeoutText, executable, ...args] = process.argv.slice(2);
const timeoutMs = Number(timeoutText);
if (!process.send || !executable || !Number.isSafeInteger(timeoutMs))
  process.exit(125);
process.once("disconnect", stopGroup);
setTimeout(() => void report("timeout").then(stopGroup), timeoutMs);
// Working directory and environment are the agent's choice for the command.
const child = spawn(executable, args, {
  shell: false,
  stdio: ["ignore", "inherit", "inherit"],
});
child.once("error", () => void report("error").then(stopGroup));
child.once("exit", (code) => {
  // A signal-terminated command reports no exit code, as before. Ending the
  // group also removes descendants that outlive the command.
  if (code === null) stopGroup();
  process.exit(code);
});
