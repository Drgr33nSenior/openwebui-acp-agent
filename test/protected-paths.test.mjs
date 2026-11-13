import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
const {
  EXECUTION_DIRECTORIES,
  EXECUTION_FILES,
  SECRET_NAMES,
  PROMPT_ARGUMENT_NAMES,
  mentions,
} = await import("../dist/protected-paths.js");
const { target } = await import("../dist/workspace.js");
const { repeatableCommand } = await import("../dist/permissions.js");

test("protected lists cover everything the pinned sandbox runtime protects", async () => {
  const runtime = dirname(
    fileURLToPath(import.meta.resolve("@anthropic-ai/sandbox-runtime")),
  );
  const utils = await import(
    pathToFileURL(join(runtime, "sandbox", "sandbox-utils.js")).href
  );
  for (const file of utils.DANGEROUS_FILES)
    assert(EXECUTION_FILES.includes(file), file);
  for (const dir of utils.getDangerousDirectories())
    assert(EXECUTION_DIRECTORIES.includes(dir.split("/")[0]), dir);
  for (const name of SECRET_NAMES)
    assert(PROMPT_ARGUMENT_NAMES.includes(name), name);
});

test("runtime child denies precede their protected parents (Linux bubblewrap mountpoints)", async () => {
  // bwrap cannot create a mountpoint for a child below an already read-only
  // parent, and the runtime appends its own child denies after ours.
  const { sandboxPolicy } = await import("../dist/sandbox.js");
  const runtime = dirname(
    fileURLToPath(import.meta.resolve("@anthropic-ai/sandbox-runtime")),
  );
  const utils = await import(
    pathToFileURL(join(runtime, "sandbox", "sandbox-utils.js")).href
  );
  const root = "/workspace/project";
  const denied = sandboxPolicy(
    { mode: "workspace", root, network: async () => false },
    "/tmp/isolated",
  ).filesystem.denyWrite.map((entry) => entry.path ?? entry);
  const children = [
    ".git/hooks",
    ".git/config",
    ...utils.getDangerousDirectories().filter((d) => d.includes("/")),
  ];
  for (const child of children) {
    const parent = child.split("/")[0];
    if (!EXECUTION_DIRECTORIES.includes(parent)) continue;
    const c = denied.indexOf(join(root, child)),
      p = denied.indexOf(join(root, parent));
    assert(c >= 0 && p >= 0 && c < p, `${child} must precede ${parent}`);
  }
});

test("names match whole path segments at any depth, never substrings", () => {
  for (const value of [
    "deploy/id_ed25519",
    "--file=.env.local",
    ".git/config",
    "infra/prod.tfstate",
    "C:\\work\\.ssh\\config",
  ])
    assert(mentions(PROMPT_ARGUMENT_NAMES, value), value);
  for (const value of [
    "id_ed25519.pub",
    "environment.ts",
    "src/keyboard.ts",
    "monkey.js",
    ".gitignore",
    "docs/config.md",
  ])
    assert(!mentions(PROMPT_ARGUMENT_NAMES, value), value);
});

test("file tools read but never write files that run outside the sandbox; secrets stay unreadable", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ow-protected-")));
  for (const dir of [".husky", ".claude", "deploy", "src"])
    await mkdir(join(root, dir));
  await writeFile(join(root, ".claude", "settings.json"), "{}");
  await writeFile(join(root, ".husky", "pre-commit"), "npm test");
  for (const path of [
    ".husky/pre-commit",
    ".claude/settings.json",
    ".mcp.json",
    ".envrc",
    ".gitmodules",
    "packages/a/.husky/pre-push",
  ])
    await assert.rejects(target(root, path, true), /Protected path/, path);
  for (const path of [".husky/pre-commit", ".claude/settings.json"])
    assert.equal(await target(root, path), join(root, path));
  // Editor context names a file without writing it.
  assert.equal(
    await target(root, ".claude/settings.json", true, false),
    join(root, ".claude/settings.json"),
  );
  assert.equal(
    await target(root, "src/new.ts", true),
    join(root, "src/new.ts"),
  );
  for (const path of ["deploy/id_ed25519", ".netrc", "certs/client.pfx"])
    await assert.rejects(target(root, path), /sensitive/, path);
});

test("commands naming secrets or credential-bearing files are never auto-approved", () => {
  for (const [exe, args] of [
    ["cat", [".git/config"]],
    ["cat", ["deploy/id_ed25519"]],
    ["head", ["-n", "5", ".env.production"]],
    ["rg", ["token", ".netrc"]],
    ["cat", ["infra/prod.tfstate"]],
    ["bash", ["-c", "cat .git/config"]],
    ["git", ["show", "HEAD:.npmrc"]],
  ])
    assert(!repeatableCommand(exe, args), JSON.stringify([exe, args]));
  for (const [exe, args] of [
    ["cat", ["README.md"]],
    ["rg", ["config", "src"]],
    ["git", ["status"]],
    ["cat", ["deploy/id_ed25519.pub"]],
  ])
    assert(repeatableCommand(exe, args), JSON.stringify([exe, args]));
});
