import { readFile, lstat } from "node:fs/promises";
import { join } from "node:path";
import { editTask } from "./edit-task.mjs";

// Read only this runner's synthetic scratch workspace and transcript.
export async function inspectEditFixture(workspace, session) {
  const originals = editTask().files;
  const unchanged = {};
  for (const [name, before] of Object.entries(originals)) {
    const path = join(workspace, name),
      info = await lstat(path);
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      info.nlink !== 1 ||
      info.size > 100000
    )
      throw Error("Unexpected fixture file");
    const after = await readFile(path, "utf8");
    unchanged[name] =
      name === "test_game.py"
        ? after === before
        : after.split("\n\ndef ", 1)[0] === before.split("\n\ndef ", 1)[0];
  }
  const history = JSON.parse(await readFile(session, "utf8"));
  const commands = new Set(
    history.messages
      .flatMap((m) => m.tool_calls ?? [])
      .filter((c) => c.function.name === "run_command")
      .map((c) => c.id),
  );
  const commandResults = [];
  for (const m of history.messages) {
    if (m.role !== "tool" || !commands.has(m.tool_call_id)) continue;
    let result;
    try {
      result = JSON.parse(m.content);
    } catch {
      continue;
    }
    if (typeof result.code !== "number" || typeof result.output !== "string")
      continue;
    const count = result.output.match(/Ran (\d+) tests?/);
    commandResults.push({
      code: result.code,
      testCount: count ? Number(count[1]) : null,
      testOutcome: count
        ? /\bFAILED\b/.test(result.output)
          ? "failed"
          : /\bOK\b/.test(result.output)
            ? "passed"
            : "unknown"
        : null,
    });
  }
  return { catalogsAndTestsUnchanged: unchanged, commandResults };
}
