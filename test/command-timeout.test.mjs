import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { command } from "../dist/commands.js";
import { commandSchema, sandboxCommand } from "../dist/sandbox.js";

const root = await realpath(await mkdtemp(join(tmpdir(), "ow-timeout-")));
const sandbox = { root, mode: "workspace", network: async () => false };

test("command timeout defaults to two minutes and accepts at most ten minutes", () => {
  const input = { executable: "npm", args: ["test"] };
  assert.equal(commandSchema.parse(input).timeout_ms, 120000);
  for (const timeout_ms of [1, 120000, 600000])
    assert.equal(
      commandSchema.parse({ ...input, timeout_ms }).timeout_ms,
      timeout_ms,
    );
  for (const timeout_ms of [0, -1, 1.5, 600001, Infinity, NaN, "120000", null])
    assert.throws(() => commandSchema.parse({ ...input, timeout_ms }));
});

test("both command runners reject invalid timeouts before starting a process", async () => {
  for (const timeoutMs of [0, -1, 0.5, 600001, Infinity, NaN]) {
    const limits = { timeoutMs, outputBytes: 1000 };
    await assert.rejects(
      command(
        "missing-executable",
        [],
        root,
        AbortSignal.timeout(1000),
        limits,
      ),
      /Command timeout must be an integer from 1 to 600000 ms/,
    );
    await assert.rejects(
      sandboxCommand(
        "missing-executable",
        [],
        sandbox,
        AbortSignal.timeout(1000),
        limits,
      ),
      /Command timeout must be an integer from 1 to 600000 ms/,
    );
  }
});

test(
  "a short per-command timeout stops the owned process without cancelling its caller",
  { timeout: 10000 },
  async () => {
    const controller = new AbortController();
    const result = JSON.parse(
      await command(
        process.execPath,
        ["-e", "console.log(process.pid);setInterval(()=>{},1000)"],
        root,
        controller.signal,
        { timeoutMs: 2000, outputBytes: 1000 },
      ),
    );
    assert.equal(result.limitedOrCancelled, true);
    assert.notEqual(result.code, 0);
    assert.equal(controller.signal.aborted, false);
    const pid = Number(result.output.trim());
    assert(Number.isInteger(pid) && pid > 0);
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  },
);
