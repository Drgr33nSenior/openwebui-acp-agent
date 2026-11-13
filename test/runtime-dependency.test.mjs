import test from "node:test";
import { fileURLToPath } from "node:url";
import { checkRuntimeDependency } from "./runtime-dependency-check.mjs";

test("sandbox runtime retains v3 schema behavior with patched Zod collection code", async () => {
  await checkRuntimeDependency(fileURLToPath(new URL("..", import.meta.url)));
});
