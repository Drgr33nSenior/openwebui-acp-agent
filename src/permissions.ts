import { createHash, randomUUID } from "node:crypto";
import { open, unlink } from "node:fs/promises";
import { basename, join } from "node:path";
import { z } from "zod";
import { directory, privateDir, readJson, writeJson } from "./config.js";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const grantSchema = z
  .object({
    kind: z.enum(["edit", "command", "mcp-server", "mcp-tool", "network"]),
    label: z.string().max(300),
  })
  .strict();
const scopeSchema = z
  .object({
    epoch: z.string().uuid(),
    grants: z.record(digest, grantSchema),
  })
  .strict();
const storeSchema = z
  .object({
    version: z.literal(1),
    scopes: z.record(digest, scopeSchema),
  })
  .strict();
type Store = z.infer<typeof storeSchema>;
export type Grant = z.infer<typeof grantSchema> & { id: string };
// Only digests and agent-authored labels are persisted, never argv, MCP headers,
// environment values or tool arguments. Sort object keys for stable identities.
export function fingerprint(value: unknown): string {
  const canonical = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(canonical);
    if (v && typeof v === "object")
      return Object.fromEntries(
        Object.entries(v)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([k, x]) => [k, canonical(x)]),
      );
    return v;
  };
  return createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");
}
export function grant(
  kind: Grant["kind"],
  identity: unknown,
  label: string,
): Grant {
  return { id: fingerprint({ kind, identity }), kind, label };
}
async function readStore(): Promise<Store> {
  const data = storeSchema.parse(
    (await readJson("permissions.json")) ?? { version: 1, scopes: {} },
  );
  if (
    Object.keys(data.scopes).length > 1000 ||
    Object.values(data.scopes).some((s) => Object.keys(s.grants).length > 200)
  )
    throw new Error("Permission storage limit exceeded; revoke unused grants");
  return data;
}
async function persist(data: Store) {
  if (Buffer.byteLength(JSON.stringify(data)) > 3_500_000)
    throw new Error("Permission storage budget exceeded");
  await writeJson("permissions.json", data);
}
async function change(action: (data: Store) => Promise<void>) {
  await privateDir();
  const lock = join(directory, "permissions.lock");
  let handle;
  for (let i = 0; i < 100; i++) {
    try {
      handle = await open(lock, "wx", 0o600);
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      await new Promise((r) => setTimeout(r, 20));
    }
  }
  if (!handle)
    throw new Error("Permission store busy; inspect permissions.lock manually");
  try {
    const data = await readStore();
    await action(data);
  } finally {
    await handle.close();
    await unlink(lock);
  }
}
export const permissionModes = [
  {
    value: "read_only",
    name: "Read only",
    description:
      "Use file inspection tools only. No edits, commands or MCP processes/tools.",
  },
  {
    value: "ask",
    name: "Ask each time",
    description:
      "Ask for each edit, command and MCP operation; ignore saved tool grants.",
  },
  {
    value: "scoped",
    name: "Use scoped approvals",
    description:
      "Ask unless an exact session or remembered tool grant applies.",
  },
  {
    value: "edits",
    name: "Allow workspace edits (session)",
    description:
      "Approve workspace text edits automatically; commands and MCP keep scoped approvals.",
  },
  {
    value: "development",
    name: "Allow edits and development commands (session)",
    description:
      "Approve workspace edits and recognized inspection/test/build commands, including GitHub reads. Network, scope expansion, other commands and MCP still need approval.",
  },
] as const;
export type PermissionMode = (typeof permissionModes)[number]["value"];
export function parsePermissionMode(value: string): PermissionMode {
  if (!permissionModes.some((m) => m.value === value))
    throw new Error("Unknown permission mode");
  return value as PermissionMode;
}
const elevated = (mode: PermissionMode) =>
  mode === "edits" || mode === "development";

export class Permissions {
  readonly scope: string;
  currentMode: PermissionMode = "scoped";
  private modeEpoch?: string;
  private session = new Map<string, { epoch: string; grant: Grant }>();
  constructor(binding: unknown) {
    this.scope = fingerprint(binding);
  }
  async selectMode(value: string) {
    const mode = parsePermissionMode(value);
    this.modeEpoch = elevated(mode) ? (await this.prepare()).epoch : undefined;
    this.currentMode = mode;
  }
  async mode() {
    if (
      elevated(this.currentMode) &&
      (await this.snapshot()).epoch !== this.modeEpoch
    ) {
      this.currentMode = "scoped";
      this.modeEpoch = undefined;
    }
    return this.currentMode;
  }
  savedMode() {
    return elevated(this.currentMode) ? "scoped" : this.currentMode;
  }
  async snapshot() {
    const s = (await readStore()).scopes[this.scope];
    return { epoch: s?.epoch ?? "initial", grants: s?.grants ?? {} };
  }
  async inspect() {
    const s = await this.snapshot();
    return {
      session: [...this.session.values()]
        .filter((x) => x.epoch === s.epoch)
        .map((x) => x.grant),
      remembered: Object.entries(s.grants).map(([id, g]) => ({ id, ...g })),
    };
  }
  has(g: Grant, s: Awaited<ReturnType<Permissions["snapshot"]>>) {
    return !!s.grants[g.id] || this.session.get(g.id)?.epoch === s.epoch;
  }
  async check(epoch: string, signal: AbortSignal) {
    signal.throwIfAborted();
    if ((await this.snapshot()).epoch !== epoch)
      throw new Error("Tool permissions revoked; request approval again");
    signal.throwIfAborted();
  }
  async remember(
    g: Grant,
    lifetime: "session" | "remember",
    epoch: string,
    signal: AbortSignal,
  ) {
    await change(async (data) => {
      signal.throwIfAborted();
      const old = data.scopes[this.scope];
      if ((old?.epoch ?? "initial") !== epoch)
        throw new Error("Tool permissions revoked while approval was pending");
      if (lifetime === "session") {
        this.session.set(g.id, { epoch, grant: g });
        return;
      }
      if (!old) throw new Error("Permission scope was not prepared");
      const scope = old;
      if (Object.keys(scope.grants).length >= 200 && !scope.grants[g.id])
        throw new Error("Tool grant limit exceeded");
      const previous = scope.grants[g.id];
      scope.grants[g.id] = { kind: g.kind, label: g.label };
      await persist(data);
      if (signal.aborted) {
        if (previous) scope.grants[g.id] = previous;
        else delete scope.grants[g.id];
        await persist(data);
        signal.throwIfAborted();
      }
    });
    await this.check(epoch, signal);
  }
  async prepare() {
    await change(async (data) => {
      if (!data.scopes[this.scope]) {
        if (Object.keys(data.scopes).length >= 1000)
          throw new Error("Workspace permission limit exceeded");
        data.scopes[this.scope] = { epoch: randomUUID(), grants: {} };
        await persist(data);
      }
    });
    return this.snapshot();
  }
  async revoke() {
    await change(async (data) => {
      if (!data.scopes[this.scope] && Object.keys(data.scopes).length >= 1000)
        throw new Error("Workspace permission limit exceeded");
      data.scopes[this.scope] = { epoch: randomUUID(), grants: {} };
      await persist(data);
      this.session.clear();
      if (elevated(this.currentMode)) this.currentMode = "scoped";
      this.modeEpoch = undefined;
    });
  }
}

// This recognizes a bounded literal shell form, not arbitrary shell syntax.
// Unrecognized syntax keeps per-call approval. Execution always uses the original
// executable/argv; parsing never rewrites a command or broadens a grant.
function literalShellCommands(script: string): string[][] | undefined {
  if (script.length > 10000 || /[\r\n\0\\]/.test(script)) return undefined;
  const commands: string[][] = [];
  let words: string[] = [],
    word = "",
    started = false,
    quote = "";
  const finishWord = () => {
    if (started) words.push(word);
    word = "";
    started = false;
  };
  for (let i = 0; i < script.length; i++) {
    const c = script[i]!;
    if (quote) {
      if (c === quote) quote = "";
      else {
        if (quote === '"' && /[$`!]/.test(c)) return undefined;
        word += c;
      }
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      started = true;
    } else if (/\s/.test(c)) finishWord();
    else if (c === "|" || c === "&") {
      finishWord();
      if (!words.length || (c === "&" && script[i + 1] !== "&"))
        return undefined;
      if (script[i + 1] === c) i++;
      commands.push(words);
      words = [];
    } else if (/[$`!;<>()[\]{}*?~#]/.test(c)) return undefined;
    else {
      started = true;
      word += c;
    }
  }
  if (quote) return undefined;
  finishWord();
  if (!words.length) return undefined;
  commands.push(words);
  return commands.length <= 16 ? commands : undefined;
}

export function repeatableCommand(
  executable: string,
  args: string[],
  depth = 0,
): boolean {
  const name = basename(executable)
    .toLowerCase()
    .replace(/\.exe$/, "");
  if (depth > 3 || args.some((a) => /[\r\n\0]/.test(a))) return false;
  // A bare program name (found on PATH) or a standard system program directory:
  // "./tools/cat", ".venv/bin/pytest" or any other path could be a workspace file.
  if (
    /[\\/]/.test(executable) &&
    !/^\/(?:usr\/(?:local\/)?)?s?bin\/[^/]+$|^\/opt\/homebrew\/bin\/[^/]+$/.test(
      executable,
    )
  )
    return false;
  if (["sh", "bash", "zsh"].includes(name)) {
    if (args.length !== 2 || !["-c", "-lc"].includes(args[0]!)) return false;
    const commands = literalShellCommands(args[1]!);
    return (
      !!commands &&
      commands.every((c) => repeatableCommand(c[0]!, c.slice(1), depth + 1))
    );
  }
  if (
    [
      "ls",
      "pwd",
      "cat",
      "head",
      "tail",
      "wc",
      "stat",
      "file",
      "which",
      "whoami",
      "uname",
      "printf",
      "echo",
    ].includes(name)
  )
    return true;
  if (name === "cd")
    return (
      depth > 0 && args.length <= 1 && !args.some((a) => a.startsWith("-"))
    );
  // ripgrep --pre and --hostname-bin run another program.
  if (["rg", "grep"].includes(name))
    return !args.some((a) => /^--(?:pre|hostname-bin)(?:=|$)/.test(a));
  if (name === "find")
    return !args.some(
      (a) =>
        a.startsWith("-") &&
        !/^(?:-(?:name|iname|path|ipath|regex|iregex|type|maxdepth|mindepth|print|print0|prune|empty|size|mtime|mmin|atime|amin|ctime|cmin|newer|newermt|perm|user|group|uid|gid|nouser|nogroup|links|inum|depth|xdev|mount|true|false|not|and|or|a|o|L|H|P|E|s|X|f|d)|-\d+)$/.test(
          a,
        ),
    );
  if (name === "gh") return repeatableGithub(args);
  if (name === "git") {
    const rest = [...args];
    while (rest[0] === "-C" && rest.length > 2) rest.splice(0, 2);
    return (
      ["status", "diff", "log", "show", "ls-files", "rev-parse"].includes(
        rest[0] ?? "",
      ) &&
      !rest.some((a) =>
        /^(?:--(?:ext-diff|textconv|output|exec-path|git-dir|work-tree)(?:=|$)|-c|--config-env)/.test(
          a,
        ),
      )
    );
  }
  if (["npm", "pnpm", "yarn"].includes(name)) {
    const task = args[0] === "run" ? args[1] : args[0];
    return (
      ["test", "lint", "typecheck", "build", "check"].includes(task ?? "") &&
      !args.some((a) =>
        /^(?:--(?:prefix|cwd|dir|global|script-shell)|-C)/.test(a),
      )
    );
  }
  if (["node", "python", "python3"].includes(name))
    return (
      args.length === 1 &&
      (args[0] === "--version" ||
        (name === "node" ? args[0] === "-v" : args[0] === "-V"))
    );
  // Test and lint runners already execute project code inside the sandbox; what
  // they must not do unasked is delete or overwrite an arbitrary path: pytest
  // removes --basetemp (and, with --cache-clear, an overridden cache_dir), and the
  // others write a report or bundle wherever an output option points.
  const runnerFlags: Record<string, RegExp> = {
    pytest: /^(?:--basetemp|--override-ini|-o|--cache-clear)(?:=|$)|^-o./,
    tsc: /^--outFile(?:=|$)/,
    eslint: /^(?:-o|--output-file)(?:=|$)/,
    vitest: /^--outputFile(?:=|$|\.)/,
  };
  const denied = runnerFlags[name];
  return !!denied && !args.some((a) => denied.test(a));
}
// Only documented read commands qualify. In particular, gh api fields can
// silently change GET to POST; no payload, header override or GraphQL is reused.
function repeatableGithub(args: string[]): boolean {
  if (args.length === 1 && args[0] === "--version") return true;
  const [group, verb, ...rest] = args;
  if (group === "api") {
    let endpoint: string | undefined;
    const words = args.slice(1);
    for (let i = 0; i < words.length; i++) {
      const a = words[i]!;
      if (["--method", "-X"].includes(a)) {
        if (words[++i] !== "GET") return false;
      } else if (a.startsWith("--method=") || a.startsWith("-X")) {
        if (a !== "--method=GET" && a !== "-XGET") return false;
      } else if (["--jq", "-q", "--template", "-t", "--cache"].includes(a)) {
        if (words[++i] === undefined) return false;
      } else if (
        ["--paginate", "--slurp", "--include", "-i", "--silent"].includes(a)
      )
        continue;
      else if (a.startsWith("-") || endpoint) return false;
      else endpoint = a;
    }
    if (
      !endpoint ||
      endpoint
        .split("?")[0]!
        .split("/")
        .some(
          (part) =>
            [".", "..", "graphql"].includes(part.toLowerCase()) ||
            part.includes("%"),
        )
    )
      return false;
    return (
      !!endpoint &&
      /^(?!\/?graphql(?:$|[/?]))\/?[A-Za-z0-9_{}.-]+(?:[/?][^\s]*)?$/.test(
        endpoint,
      )
    );
  }
  const reads: Record<string, readonly string[]> = {
    pr: ["list", "view", "status", "checks", "diff"],
    issue: ["list", "view", "status"],
    repo: ["list", "view"],
    run: ["list", "view", "watch"],
    workflow: ["list", "view"],
    release: ["list", "view"],
    search: ["code", "commits", "issues", "prs", "repos"],
  };
  if (!group || !verb || !reads[group]?.includes(verb)) return false;
  return !rest.some((a) =>
    /^(?:--(?:web|browser|show-token|verbose|hostname)(?:=|$)|-[^-]*w)/.test(a),
  );
}

export const onceOnlyCommandExplanation =
  "Approval is required each time for this command. Git mutations, cleanup, deployment, arbitrary scripts and unrecognized shell syntax cannot receive a remembered grant. For simple inspection or test commands, use the executable and argument list directly.";
