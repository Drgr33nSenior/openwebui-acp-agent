// Private subprocess entrypoint: at most one per agent process on macOS and
// Linux. The agent registers each unsandboxed command's process group with its
// timeout. The agent's own timers and cleanup die with the agent, so this
// process kills each group at its deadline and kills every registered group
// when the IPC channel closes, which happens however the agent exits,
// including SIGKILL and crashes. It runs in its own process group, so a signal
// aimed at a command's group cannot reach it. Nothing is persisted.
const deadlines = new Map<number, ReturnType<typeof setTimeout>>();
function kill(group: number) {
  try {
    process.kill(-group, "SIGKILL");
  } catch {
    /* Already exited. */
  }
}
process.on("message", (raw: unknown) => {
  const message = raw as {
    type?: unknown;
    group?: unknown;
    timeoutMs?: unknown;
  } | null;
  const group = message?.group;
  // Never accept init, every process (-1), this process or the agent.
  if (
    typeof group !== "number" ||
    !Number.isSafeInteger(group) ||
    group <= 1 ||
    group === process.pid ||
    group === process.ppid
  )
    return;
  clearTimeout(deadlines.get(group));
  deadlines.delete(group);
  const timeoutMs = message?.timeoutMs;
  if (
    message?.type === "watch" &&
    typeof timeoutMs === "number" &&
    Number.isSafeInteger(timeoutMs) &&
    timeoutMs >= 1 &&
    timeoutMs <= 600000
  )
    deadlines.set(
      group,
      setTimeout(() => {
        deadlines.delete(group);
        kill(group);
      }, timeoutMs),
    );
});
process.once("disconnect", () => {
  for (const group of deadlines.keys()) kill(group);
  process.exit(0);
});
if (!process.send) process.exit(125);
