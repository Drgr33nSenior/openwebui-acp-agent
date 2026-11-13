import {
  realpath,
  lstat,
  readdir,
  open,
  rename,
  unlink,
} from "node:fs/promises";
import { constants } from "node:fs";
import { resolve, relative, isAbsolute, parse, dirname, join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import ignore from "ignore";
import { directory, readJson, writeJson, privateDir } from "./config.js";
import {
  agentCodePaths,
  EXECUTION_DIRECTORIES,
  EXECUTION_FILES,
  namesPattern,
  SECRET_NAMES,
} from "./protected-paths.js";
const records = z.record(
  z.string(),
  z.object({ destination: z.string(), allow: z.boolean() }).strict(),
);
export async function root(cwd: string) {
  if (!isAbsolute(cwd)) throw new Error("Workspace must be absolute");
  const r = await realpath(cwd);
  if (r === parse(r).root || r === (await realpath(homedir())))
    throw new Error("Home and filesystem roots cannot be workspaces");
  if (!(await lstat(r)).isDirectory())
    throw new Error("Workspace is not a directory");
  return r;
}
export async function trust() {
  return records.parse((await readJson("trust.json")) ?? {});
}
export async function changeTrust(
  r: string,
  destination: string,
  allow: boolean,
) {
  await privateDir();
  const lock = join(directory, "trust.lock");
  let handle;
  for (let i = 0; i < 100; i++) {
    try {
      handle = await open(lock, "wx", 0o600);
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  if (!handle)
    throw new Error("Trust store busy; inspect stale trust.lock manually");
  try {
    const data = await trust();
    data[r] = { destination, allow };
    await writeJson("trust.json", data);
  } finally {
    await handle.close();
    await unlink(lock);
  }
}
// Hidden from the file tools for reading and writing: agent and IDE state, and secrets.
const sensitive = new RegExp(
  `(^|/)(?:${namesPattern([
    ".git",
    ".agents",
    ".codex",
    ".idea",
    ".vscode",
    ".config",
    "node_modules",
    ...SECRET_NAMES,
  ])})(/|$)`,
  "i",
);
// Readable, but never written by the agent: their contents run outside the sandbox.
const executionConfig = new RegExp(
  `(^|/)(?:${namesPattern([...EXECUTION_DIRECTORIES, ...EXECUTION_FILES])})(/|$)`,
  "i",
);
export async function target(
  r: string,
  input: string,
  create = false,
  write = create,
) {
  const candidate = resolve(r, input),
    privateRelative = relative(resolve(directory), candidate);
  for (const protectedPath of agentCodePaths()) {
    const rel = relative(protectedPath, candidate);
    if (
      create &&
      (!rel || (!isAbsolute(rel) && !rel.split(/[\\/]/).includes("..")))
    )
      throw new Error("Agent executable and dependency files are protected");
  }
  if (
    !privateRelative ||
    (!isAbsolute(privateRelative) &&
      !privateRelative.split(/[\\/]/).includes(".."))
  )
    throw new Error("Application state is outside tool scope");
  const p = resolve(r, input),
    rel = relative(r, p);
  if (
    !rel ||
    rel === ".." ||
    rel.startsWith(".." + parse(p).root) ||
    isAbsolute(rel) ||
    rel.split(/[\\/]/).includes("..") ||
    sensitive.test(rel.replaceAll("\\", "/"))
  )
    throw new Error("Path outside permitted scope or sensitive");
  if (write && executionConfig.test(rel.replaceAll("\\", "/")))
    throw new Error(
      "Protected path: files here run outside the sandbox; edit them yourself",
    );
  let cur = r;
  for (const part of rel.split(/[\\/]/)) {
    cur = join(cur, part);
    try {
      const s = await lstat(cur);
      if (s.isSymbolicLink()) throw new Error("Symlink access refused");
    } catch (e) {
      if (create && cur === p && (e as NodeJS.ErrnoException).code === "ENOENT")
        break;
      throw e;
    }
  }
  return p;
}
// target() checks the path, then the file is used by path, so a concurrent process
// could swap a folder for a symlink in between. Node has no openat(), so each
// access is bracketed instead: the device, inode and status-change time (ctime,
// which an unprivileged process cannot set) of every folder from the root to the
// file are recorded before and after. Renaming or replacing anything in a folder
// changes its ctime, so an unchanged chain proves the open resolved through these
// same real folders. Filesystems with coarse timestamps weaken this check.
type Ident = { dev: bigint; ino: bigint; ctimeNs: bigint };
async function chain(r: string, dir: string): Promise<Ident[]> {
  const rel = relative(r, dir);
  const out: Ident[] = [];
  let cur = r;
  for (const part of ["", ...(rel ? rel.split(/[\\/]/) : [])]) {
    if (part) cur = join(cur, part);
    const s = await lstat(cur, { bigint: true });
    if (s.isSymbolicLink() || !s.isDirectory())
      throw new Error("Symlink access refused");
    out.push({ dev: s.dev, ino: s.ino, ctimeNs: s.ctimeNs });
  }
  return out;
}
const sameChain = (a: Ident[], b: Ident[]) =>
  a.length === b.length &&
  a.every(
    (x, i) =>
      x.dev === b[i]!.dev && x.ino === b[i]!.ino && x.ctimeNs === b[i]!.ctimeNs,
  );
// The entry at `p`, reached through an unchanged chain of real folders, is `file`.
async function proven(
  r: string,
  p: string,
  file: { dev: bigint; ino: bigint },
  before?: Ident[],
) {
  const start = before ?? (await chain(r, dirname(p)));
  const here = await lstat(p, { bigint: true });
  const end = await chain(r, dirname(p));
  return (
    !here.isSymbolicLink() &&
    here.dev === file.dev &&
    here.ino === file.ino &&
    sameChain(start, end)
  );
}
export async function readText(r: string, p: string) {
  const before = await chain(r, dirname(p));
  let f;
  try {
    f = await open(
      p,
      constants.O_RDONLY |
        (constants.O_NOFOLLOW ?? 0) |
        (constants.O_NONBLOCK ?? 0),
    );
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ELOOP")
      throw new Error("Symlink access refused");
    throw e;
  }
  try {
    const s = await f.stat({ bigint: true });
    if (!s.isFile() || s.size > 100_000n)
      throw new Error("Not a bounded text file");
    // Another name for the same file (inside or outside the root) defeats path checks.
    if (s.nlink > 1n) throw new Error("Hard-linked file refused");
    if (!(await proven(r, p, s, before)))
      throw new Error("File changed during access; retry");
    const t = await f.readFile("utf8");
    if (t.includes("\0")) throw new Error("Binary file refused");
    return t;
  } finally {
    await f.close();
  }
}
export async function files(r: string) {
  const out: string[] = [];
  let visited = 0;
  type Rules = { base: string; matcher: ReturnType<typeof ignore> };
  async function walk(dir: string, inherited: Rules[]) {
    const rules = [...inherited];
    try {
      const path = await target(r, relative(r, join(dir, ".gitignore")));
      rules.push({ base: dir, matcher: ignore().add(await readText(r, path)) });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    for (const e of await readdir(dir, { withFileTypes: true })) {
      if (++visited > 10000) throw new Error("Discovery limit exceeded");
      const p = join(dir, e.name),
        rel = relative(r, p).replaceAll("\\", "/");
      if (e.isSymbolicLink() || sensitive.test(rel)) continue;
      let ignored = false;
      for (const rule of rules) {
        const decision = rule.matcher.test(
          relative(rule.base, p).replaceAll("\\", "/") +
            (e.isDirectory() ? "/" : ""),
        );
        if (decision.ignored) ignored = true;
        else if (decision.unignored) ignored = false;
      }
      if (ignored) continue;
      if (e.isDirectory()) await walk(p, rules);
      else if (e.isFile()) out.push(rel);
    }
  }
  await walk(r, []);
  return out;
}
export async function atomicEdit(
  r: string,
  path: string,
  before: string | null,
  after: string,
) {
  const p = await target(r, path, true);
  const current = await readText(r, p).catch((e) => {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  });
  if (current !== before)
    throw new Error("Stale file: content changed while approval was pending");
  const tmp = join(dirname(p), ".acp-" + randomUUID());
  const f = await open(tmp, "wx", 0o600);
  let created;
  try {
    created = await f.stat({ bigint: true });
    // Prove the temporary file was created inside the root before writing to it:
    // a parent swapped for a symlink would have created it elsewhere. Only the
    // agent can create it, so finding it here proves where it was created.
    if (!(await proven(r, tmp, created)))
      throw new Error("Workspace changed during write; nothing was replaced");
    await f.writeFile(after);
    if (current !== null) await f.chmod((await lstat(p)).mode & 0o777);
    await f.sync();
  } catch (e) {
    await f.close();
    await unlink(tmp).catch(() => {});
    throw e;
  }
  await f.close();
  try {
    await target(r, path, true);
    const latest = await readText(r, p).catch((e) => {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw e;
    });
    if (latest !== before) throw new Error("Stale file");
    // A parent swapped after this point moves the rename elsewhere, where the
    // temporary file does not exist: it fails instead of writing outside.
    await rename(tmp, p);
    if (!(await proven(r, p, created)))
      throw new Error("Workspace changed during write; check the file");
  } finally {
    await unlink(tmp).catch(() => {});
  }
}
