import { basename, dirname, join, parse } from "node:path";
import { fileURLToPath } from "node:url";

// Used by both file tools and the OS policy: modifying the broker or its
// dependencies would change what the next process executes outside the sandbox.
export function agentCodePaths(): string[] {
  const dist = dirname(fileURLToPath(import.meta.url));
  const paths = [
    dist,
    process.execPath,
    join(dirname(dist), "node_modules"),
    join(dirname(dist), "package.json"),
    join(dirname(dist), "package-lock.json"),
  ];
  for (let p = dirname(dist); p !== parse(p).root; p = dirname(p)) {
    if (basename(p) === "node_modules") paths.push(p);
  }
  return paths;
}

// One list per concern, shared by the file tools (workspace.ts), the OS policy
// (sandbox.ts) and command auto-approval (permissions.ts), so a path protected
// in one place is protected in all of them.

// Files whose contents later run outside the sandbox, or configure tools that do
// (Git, shells, direnv, MCP clients, IDEs, Claude Code hooks, Git hook managers).
// Mirrors sandbox-runtime 0.0.83 DANGEROUS_FILES/getDangerousDirectories(), which
// only cover sandboxed commands; test/protected-paths.test.mjs keeps it a superset.
export const EXECUTION_FILES = [
  ".gitconfig",
  ".gitmodules",
  ".bashrc",
  ".bash_profile",
  ".zshrc",
  ".zprofile",
  ".profile",
  ".ripgreprc",
  ".mcp.json",
  ".envrc",
];
export const EXECUTION_DIRECTORIES = [
  ".git",
  ".agents",
  ".codex",
  ".aws",
  ".idea",
  ".vscode",
  ".claude",
  ".husky",
  ".githooks",
];
// Secret material: refused to read_file, denied to sandboxed reads, and never
// auto-approved as a command argument.
export const SECRET_NAMES = [
  ".ssh",
  ".aws",
  ".env",
  ".env.*",
  ".npmrc",
  ".netrc",
  ".pgpass",
  "*.pem",
  "*.key",
  "*.p12",
  "*.pfx",
  "id_rsa",
  "id_dsa",
  "id_ecdsa",
  "id_ed25519",
  "ide-mac-key.json",
  "retrieval-key",
];
// Readable by sandboxed tools that need them (Git reads its config, Terraform its
// state), but a command naming them is not approved automatically.
export const PROMPT_ARGUMENT_NAMES = [
  ...SECRET_NAMES,
  ".git/config",
  ".kube",
  "kubeconfig",
  "*.tfstate",
  "*.tfstate.backup",
];
// A name list as one path-segment pattern: `*` matches within a segment only.
export function namesPattern(names: string[]): string {
  return names
    .map((n) =>
      n
        .split("*")
        .map((part) => part.replace(/[.+?^${}()|[\]\\/]/g, "\\$&"))
        .join("[^/\\\\]*"),
    )
    .join("|");
}
// True when any path segment run of `value` is one of `names` (at any depth),
// e.g. "deploy/id_ed25519", "--file=.env.local", ".git/config" or Git's
// "HEAD:.npmrc" revision:path form.
export function mentions(names: string[], value: string): boolean {
  return new RegExp(
    `(?:^|[/\\\\=:])(?:${namesPattern(names)})(?:[/\\\\]|$)`,
    "i",
  ).test(value);
}
