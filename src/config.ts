import { z } from "zod";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  mkdir,
  lstat,
  readFile,
  open,
  rename,
  unlink,
  readdir,
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
export const directory =
  process.env.OPENWEBUI_ACP_HOME ??
  join(
    process.env.XDG_CONFIG_HOME ??
      (process.platform === "win32"
        ? (process.env.APPDATA ?? homedir())
        : join(homedir(), ".config")),
    "openwebui-acp-agent",
  );
export const configSchema = z
  .object({
    url: z.string().url(),
    model: z.string().min(1),
    header: z
      .string()
      .regex(/^[A-Za-z0-9-]+$/)
      .default("Authorization"),
    rounds: z.number().int().min(1).max(100).default(12),
    // Discovery and metadata requests (model list, server-tool discovery).
    timeoutMs: z.number().int().min(100).max(3600000).default(120000),
    // Each model request: the wait for its first streamed content (queueing, prompt
    // processing and silent thinking), then the longest silence between chunks.
    // A reply that keeps streaming is never cut short by these. Defaults sit above
    // typical server-side budgets so the server reports its own limit first.
    firstContentTimeoutMs: z
      .number()
      .int()
      .min(1000)
      .max(3600000)
      .default(900000),
    idleTimeoutMs: z.number().int().min(1000).max(3600000).default(300000),
  })
  .strict();
export type Config = z.infer<typeof configSchema>;
export function endpoint(base: string, path: string): string {
  const u = new URL(base);
  if (
    u.username ||
    u.password ||
    u.search ||
    u.hash ||
    (u.protocol !== "https:" &&
      !(
        u.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname)
      ))
  )
    throw new Error(
      "Use an HTTPS installation URL without credentials, query or fragment",
    );
  u.pathname = u.pathname.replace(/\/$/, "") + "/" + path;
  return u.href;
}
export async function privateDir() {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const s = await lstat(directory);
  if (
    !s.isDirectory() ||
    s.isSymbolicLink() ||
    (process.platform !== "win32" && s.mode & 0o077)
  )
    throw new Error(
      "Configuration directory must be private and not a symlink",
    );
  if (process.platform === "win32")
    throw new Error(
      "Persistent storage on Windows requires ACL verification; unsupported in this preview",
    );
}
export async function readJson(name: string): Promise<unknown> {
  await privateDir();
  const p = join(directory, name);
  try {
    const s = await lstat(p);
    if (
      !s.isFile() ||
      s.isSymbolicLink() ||
      s.size > 4_000_000 ||
      s.mode & 0o077
    )
      throw new Error("Unsafe application state file");
    return JSON.parse(await readFile(p, "utf8"));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw e;
  }
}
export async function writeJson(name: string, value: unknown) {
  await privateDir();
  await readJson(name);
  if (name.startsWith("session-")) {
    const names = (await readdir(directory)).filter((n) =>
      /^session-.*\.json$/.test(n),
    );
    if (names.length >= 1000 && !names.includes(name))
      throw new Error(
        "Transcript count limit reached; delete old sessions explicitly",
      );
    let total = 0;
    for (const n of names) total += (await lstat(join(directory, n))).size;
    if (total + Buffer.byteLength(JSON.stringify(value)) > 64_000_000)
      throw new Error(
        "Transcript storage quota reached; delete old sessions explicitly",
      );
  }
  const p = join(directory, name),
    tmp = p + "." + randomUUID();
  const f = await open(tmp, "wx", 0o600);
  try {
    await f.writeFile(JSON.stringify(value));
    await f.sync();
  } finally {
    await f.close();
  }
  try {
    await rename(tmp, p);
  } finally {
    await unlink(tmp).catch(() => {});
  }
}
export async function config() {
  const raw = await readJson("config.json");
  if (!raw) throw new Error("Setup required: run openwebui-acp-agent login");
  const c = configSchema.parse(raw);
  endpoint(c.url, "api/models");
  return c;
}
export async function key(c: Config) {
  const state = await readJson("auth-state.json");
  if (
    state &&
    typeof state === "object" &&
    "loggedOut" in state &&
    state.loggedOut === true
  )
    throw new Error("Authentication required: complete setup through your IDE");
  if (process.env.OPENWEBUI_API_KEY) return process.env.OPENWEBUI_API_KEY;
  try {
    const { Entry } = await import("@napi-rs/keyring");
    const value = new Entry("openwebui-acp-agent", c.url).getPassword();
    if (value) return value;
  } catch {
    /* No insecure fallback. */
  }
  throw new Error(
    "Authentication required: run openwebui-acp-agent login or supply OPENWEBUI_API_KEY for this process",
  );
}
export async function saveKey(c: Config, value: string) {
  const { Entry } = await import("@napi-rs/keyring");
  new Entry("openwebui-acp-agent", c.url).setPassword(value);
  await writeJson("auth-state.json", { epoch: randomUUID() });
}
export async function logout(c?: Config) {
  if (!c) {
    const raw = await readJson("config.json");
    if (raw !== undefined) c = configSchema.parse(raw);
  }
  // Invalidate other processes even if secure-store deletion fails. Never let
  // an inherited environment key silently undo an explicit logout.
  await writeJson("auth-state.json", { epoch: randomUUID(), loggedOut: true });
  delete process.env.OPENWEBUI_API_KEY;
  if (c) {
    try {
      const { Entry } = await import("@napi-rs/keyring");
      new Entry("openwebui-acp-agent", c.url).deletePassword();
    } catch {
      throw new Error(
        "Signed out, but credential-store removal failed. Retry logout when the OS credential store is available.",
      );
    }
  }
}
