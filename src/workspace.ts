import {
  realpath,
  lstat,
  readdir,
  readFile,
  open,
  rename,
  unlink,
} from "node:fs/promises";
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
export async function readText(p: string) {
  const s = await lstat(p);
  if (!s.isFile() || s.size > 100_000)
    throw new Error("Not a bounded text file");
  const t = await readFile(p, "utf8");
  if (t.includes("\0")) throw new Error("Binary file refused");
  return t;
}
export async function files(r: string) {
  const out: string[] = [];
  let visited = 0;
  type Rules = { base: string; matcher: ReturnType<typeof ignore> };
  async function walk(dir: string, inherited: Rules[]) {
    const rules = [...inherited];
    try {
      const path = await target(r, relative(r, join(dir, ".gitignore")));
      rules.push({ base: dir, matcher: ignore().add(await readText(path)) });
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
  const current = await readText(p).catch((e) => {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  });
  if (current !== before)
    throw new Error("Stale file: content changed while approval was pending");
  const tmp = join(dirname(p), ".acp-" + randomUUID());
  const f = await open(tmp, "wx", 0o600);
  try {
    await f.writeFile(after);
    if (current !== null) await f.chmod((await lstat(p)).mode & 0o777);
    await f.sync();
  } finally {
    await f.close();
  }
  try {
    await target(r, path, true);
    const latest = await readText(p).catch((e) => {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw e;
    });
    if (latest !== before) throw new Error("Stale file");
    await rename(tmp, p);
  } finally {
    await unlink(tmp).catch(() => {});
  }
}
