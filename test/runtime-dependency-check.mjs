import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

// Exercise the actual resolved dependency, both in the checkout and in a
// separately installed tarball. npm ignores dependency-level overrides.
export async function checkRuntimeDependency(packageRoot) {
  const agentRequire = createRequire(join(packageRoot, "package.json"));
  const runtimeEntry = agentRequire.resolve("@anthropic-ai/sandbox-runtime");
  const runtimeRequire = createRequire(runtimeEntry);
  assert.equal(
    runtimeRequire("zod/package.json").version,
    agentRequire("./package.json").dependencies.zod,
    "The runtime must resolve the patched, pinned Zod package after installation",
  );
  const { z: v3 } = await import(
    pathToFileURL(
      join(dirname(runtimeRequire.resolve("zod/package.json")), "v3/index.js"),
    )
  );
  const { SandboxRuntimeConfigSchema, GitConfigSchema } = await import(
    pathToFileURL(join(dirname(runtimeEntry), "sandbox/sandbox-config.js"))
  );
  assert.ok(SandboxRuntimeConfigSchema instanceof v3.ZodType);
  const config = {
    network: { allowedDomains: ["example.com:443"], deniedDomains: ["*:22"] },
    filesystem: { denyRead: [], allowWrite: [], denyWrite: [] },
  };
  assert.deepEqual(SandboxRuntimeConfigSchema.parse(config), config);
  assert.deepEqual(GitConfigSchema.parse({}), { safeDirectories: [] });
  const invalid = SandboxRuntimeConfigSchema.safeParse({
    ...config,
    network: { ...config.network, allowedDomains: ["*"] },
  });
  assert.equal(invalid.success, false);
  assert.ok(invalid.error.issues.length > 0);
  assert.equal(invalid.error.errors, invalid.error.issues);

  // GHSA-mrhx-c7xc-m3w5 concerns the bundled v4 collection implementation.
  // An oversized constrained array must fail before visiting its elements.
  const { z: v4 } = runtimeRequire("zod");
  let visits = 0;
  const result = v4
    .array(
      v4.preprocess((value) => {
        visits++;
        return value;
      }, v4.string()),
    )
    .max(2)
    .safeParse(Array(10000).fill(0));
  assert.equal(result.success, false);
  assert.equal(visits, 0);
  assert.equal(result.error.issues.length, 1);
  assert.equal(result.error.issues[0].code, "too_big");
}
