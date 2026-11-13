import test from "node:test";
import assert from "node:assert/strict";
import { sandboxDiagnostics, startSandbox } from "../dist/sandbox.js";

if (process.platform === "win32") {
  test("native Windows refuses execution instead of silently dropping the sandbox", async () => {
    const checks = await sandboxDiagnostics();
    assert.equal(checks.available, false);
    assert.match(checks.errors.join(" "), /Windows/);
    await assert.rejects(
      startSandbox(
        "must-not-start",
        [],
        { root: process.cwd(), mode: "workspace", network: async () => true },
        AbortSignal.timeout(1000),
      ),
      /unavailable/,
    );
  });
}
