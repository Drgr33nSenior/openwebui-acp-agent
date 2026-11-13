// Operator-created, root-owned fixtures on an isolated Linux test VM only.
// Not part of the default suite: requires administrator ownership fixtures.
import assert from "node:assert/strict";
import { readPolicyFile } from "../dist/policy.js";
const root = process.argv[2];
assert(root?.startsWith("/opt/openwebui-policy-fixtures-"));
assert.equal((await readPolicyFile(root + "/valid.json")).managed, true);
assert.equal((await readPolicyFile(root + "/missing.json")).managed, false);
for (const name of [
  "null.json",
  "bad.json",
  "unknown.json",
  "writable.json",
  "user-owned.json",
  "symlink.json",
  "dangling.json",
  "oversized.json",
  "fifo",
  "writable-parent/valid.json",
  "symlink-parent/valid.json",
])
  await assert.rejects(readPolicyFile(root + "/" + name), undefined, name);
console.log(
  "Administrator file tests: valid root-owned policy accepted; missing allowed; 11 unsafe/corrupt cases refused",
);
