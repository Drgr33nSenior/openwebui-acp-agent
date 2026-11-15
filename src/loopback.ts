// Loopback shortcuts for sandbox network approval. A sandboxed connection to a
// loopback port served by this session's own background job (or its static
// preview) needs no prompt, and one session choice can cover other loopback
// ports. Both keep the reviewed service ports below on per-port prompts.
// Detection failure, timeouts and unsupported platforms return "not owned":
// the normal prompt is the fallback, never an allow.
import { execFile } from "node:child_process";
import { lookup } from "node:dns/promises";
import { readdir, readFile, readlink } from "node:fs/promises";
import { BlockList, isIP } from "node:net";
import { endianness } from "node:os";

// Reviewed local services that can expose credentials, data or code execution.
// They always keep a per-port prompt for sandboxed commands, even when this
// session's own process listens on them or the session localhost grant applies.
// Ports are matched on loopback destinations only; remote hosts are unaffected.
const SENSITIVE_PORTS: readonly (readonly [number, number, string])[] = [
  // The built-in server moves to the following ports when 63342 is taken, for
  // example with several IDEs open; reserve that range.
  [63342, 63361, "JetBrains IDE built-in server"],
  [64342, 64342, "JetBrains IDE MCP server (default port)"],
  [2375, 2376, "Docker Engine API (control of the container host)"],
  [9222, 9222, "Chromium remote debugging (full browser control)"],
  [9229, 9229, "Node.js inspector (code execution in the debugged process)"],
  [1433, 1433, "Microsoft SQL Server"],
  [1521, 1521, "Oracle Database"],
  [3306, 3306, "MySQL / MariaDB"],
  [5432, 5432, "PostgreSQL"],
  [6379, 6379, "Redis"],
  [9200, 9200, "Elasticsearch / OpenSearch"],
  [11211, 11211, "Memcached"],
  [27017, 27017, "MongoDB"],
  [11434, 11434, "Ollama"],
  [1234, 1234, "LM Studio server"],
  // 8080 (Open WebUI's default) and 8000 are also common development-server
  // ports. They are not listed; the configured Open WebUI and MCP ports are
  // excluded dynamically by excludedLoopbackPort().
];
export const sensitiveLoopbackPorts = SENSITIVE_PORTS.map(
  ([from, to, service]) => ({ from, to, service }),
);

const loopback = new BlockList();
loopback.addSubnet("127.0.0.0", 8, "ipv4");
loopback.addAddress("::1", "ipv6");

// Canonical text for an IP literal; IPv4-mapped IPv6 becomes dotted IPv4.
export function canonicalAddress(address: string): string | undefined {
  const family = isIP(address);
  if (family === 4) return address;
  if (family !== 6) return undefined;
  const host = new URL(`http://[${address}]`).hostname.slice(1, -1);
  const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(host);
  if (!mapped) return host;
  const high = parseInt(mapped[1]!, 16),
    low = parseInt(mapped[2]!, 16);
  return [high >> 8, high & 255, low >> 8, low & 255].join(".");
}
export function isLoopbackAddress(address: string) {
  const canonical = canonicalAddress(address);
  return (
    !!canonical &&
    loopback.check(canonical, isIP(canonical) === 6 ? "ipv6" : "ipv4")
  );
}

type Resolve = (
  host: string,
) => Promise<readonly { address: string; family: number }[]>;
const resolveLocal: Resolve = (host) => lookup(host, { all: true });
// Loopback addresses for a destination, or undefined when it is not one.
// Only literal loopback IPs and the exact name "localhost" qualify, and
// localhost only when every locally resolved address is loopback. Other names
// (including *.localhost and inet_aton shorthand such as 127.1) keep the
// ordinary per-host prompt; the sandbox runtime's resolved-address guard
// separately refuses non-loopback answers for localhost.
export async function loopbackAddresses(
  host: string,
  resolve: Resolve = resolveLocal,
): Promise<string[] | undefined> {
  if (isIP(host))
    return isLoopbackAddress(host) ? [canonicalAddress(host)!] : undefined;
  if (host.toLowerCase() !== "localhost") return undefined;
  try {
    const answers = await resolve("localhost");
    const addresses = answers.map((a) => canonicalAddress(a.address));
    return addresses.length > 0 &&
      addresses.every((a) => a !== undefined && isLoopbackAddress(a))
      ? [...new Set(addresses as string[])]
      : undefined;
  } catch {
    return undefined;
  }
}

// Ports of the agent's own control channels (Open WebUI, MCP and IDE MCP URLs)
// when they are local. Unparsable URLs and remote hosts contribute nothing.
export function controlPorts(urls: readonly string[]): Set<number> {
  const ports = new Set<number>();
  for (const value of urls) {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      continue;
    }
    const host = url.hostname.replace(/^\[|\]$/g, "");
    if (host.toLowerCase() !== "localhost" && !isLoopbackAddress(host))
      continue;
    const port = url.port
      ? Number(url.port)
      : url.protocol === "https:"
        ? 443
        : url.protocol === "http:"
          ? 80
          : undefined;
    if (port) ports.add(port);
  }
  return ports;
}
export function excludedLoopbackPort(port: number, control: Set<number>) {
  return (
    control.has(port) ||
    SENSITIVE_PORTS.some(([from, to]) => port >= from && port <= to)
  );
}

export type ProcessEntry = { pid: number; ppid: number; pgid: number };
export type ListenerSocket = {
  address: string;
  port: number;
  pid?: number;
  inode?: string;
};

// `ps -A -o pid= -o ppid= -o pgid=` (macOS).
export function parsePs(text: string): ProcessEntry[] {
  const out: ProcessEntry[] = [];
  for (const line of text.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s*$/.exec(line);
    if (m) out.push({ pid: +m[1]!, ppid: +m[2]!, pgid: +m[3]! });
  }
  return out;
}
// One /proc/<pid>/stat record (Linux). The command name can contain spaces
// and parentheses, so fields are read after its final ")".
export function parseProcStat(text: string): ProcessEntry | undefined {
  const open = text.indexOf("("),
    close = text.lastIndexOf(")");
  if (open < 1 || close < open) return undefined;
  const pid = Number(text.slice(0, open).trim());
  const fields = text
    .slice(close + 1)
    .trim()
    .split(/\s+/);
  const ppid = Number(fields[1]),
    pgid = Number(fields[2]);
  return [pid, ppid, pgid].every(Number.isSafeInteger)
    ? { pid, ppid, pgid }
    : undefined;
}
// `lsof -F ptn` output for TCP listeners (macOS). Wildcards become 0.0.0.0/::.
export function parseLsof(text: string): ListenerSocket[] {
  const out: ListenerSocket[] = [];
  let pid: number | undefined, type: string | undefined;
  for (const line of text.split("\n")) {
    const field = line[0],
      value = line.slice(1);
    if (field === "p") {
      pid = Number(value);
      type = undefined;
    } else if (field === "f") type = undefined;
    else if (field === "t") type = value;
    else if (field === "n" && pid !== undefined) {
      const m = /^(\*|\[[0-9a-fA-F:.%a-z]+\]|[0-9.]+):(\d+)$/.exec(value);
      if (!m) continue;
      const host = m[1]!.replace(/^\[|\]$/g, "").replace(/%.*$/, "");
      const address =
        host === "*" ? (type === "IPv6" ? "::" : "0.0.0.0") : host;
      out.push({ address, port: Number(m[2]), pid });
    }
  }
  return out;
}
// /proc/net/tcp or tcp6 (Linux): listening sockets with their inodes. Address
// words are printed in host byte order.
export function parseProcNetTcp(
  text: string,
  littleEndian = endianness() === "LE",
): ListenerSocket[] {
  const out: ListenerSocket[] = [];
  for (const line of text.split("\n").slice(1)) {
    const f = line.trim().split(/\s+/);
    if (f.length < 10 || f[3] !== "0A") continue;
    const [hex, portHex] = f[1]!.split(":");
    if (!hex || !portHex || !/^[0-9A-Fa-f]+$/.test(hex + portHex)) continue;
    const bytes: number[] = [];
    for (let i = 0; i < hex.length; i += 8) {
      const word = hex
        .slice(i, i + 8)
        .match(/../g)!
        .map((b) => parseInt(b, 16));
      bytes.push(...(littleEndian ? word.reverse() : word));
    }
    let address: string | undefined;
    if (bytes.length === 4) address = bytes.join(".");
    else if (bytes.length === 16) {
      const groups: string[] = [];
      for (let i = 0; i < 16; i += 2)
        groups.push(((bytes[i]! << 8) | bytes[i + 1]!).toString(16));
      address = canonicalAddress(groups.join(":"));
    }
    if (address)
      out.push({
        address: canonicalAddress(address) ?? address,
        port: parseInt(portHex, 16),
        inode: f[9],
      });
  }
  return out;
}

// Job roots, their descendants by parent link, and members of their process
// groups (each job is started as its own group leader).
export function ownedProcesses(
  table: readonly ProcessEntry[],
  roots: readonly number[],
): Set<number> {
  const owned = new Set(roots);
  const groups = new Set(roots);
  for (const p of table) if (groups.has(p.pgid)) owned.add(p.pid);
  for (let changed = true; changed;) {
    changed = false;
    for (const p of table)
      if (!owned.has(p.pid) && owned.has(p.ppid)) {
        owned.add(p.pid);
        changed = true;
      }
  }
  return owned;
}
// Whether a listener bound to `listener` accepts a connection to `target`.
// A "::" listener is treated as dual-stack (the macOS and Linux default).
export function reaches(listener: string, target: string) {
  const l = canonicalAddress(listener),
    t = canonicalAddress(target);
  if (!l || !t) return false;
  if (l === t || l === "::") return true;
  return l === "0.0.0.0" && isIP(t) === 4;
}
// Every visible listener that could answer the destination must be owned, and
// there must be at least one. A non-owned listener on another loopback address
// of the same port (e.g. ::1 vs 127.0.0.1 for "localhost") keeps the prompt.
export function ownedListenerDecision(
  listeners: readonly ListenerSocket[],
  owned: (listener: ListenerSocket) => boolean,
  targets: readonly string[],
  port: number,
) {
  const relevant = listeners.filter(
    (l) => l.port === port && targets.some((t) => reaches(l.address, t)),
  );
  return relevant.length > 0 && relevant.every(owned);
}

const DETECTION_MS = 2000;
const MAX_PROCESSES = 65536;
const MAX_OWNED = 512;
const MAX_FDS = 8192;
const run = (file: string, args: string[], signal: AbortSignal) =>
  new Promise<string>((resolve, reject) =>
    execFile(
      file,
      args,
      {
        signal,
        timeout: DETECTION_MS,
        maxBuffer: 1 << 20,
        env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LC_ALL: "C" },
      },
      (error, stdout) => {
        // lsof exits 1 when nothing matches.
        if (error && !((error as { code?: unknown }).code === 1 && !stdout))
          reject(error);
        else resolve(stdout);
      },
    ),
  );

async function linuxOwned(
  roots: readonly number[],
  pids: readonly number[],
  targets: readonly string[],
  port: number,
  signal: AbortSignal,
) {
  const listeners = (
    await Promise.all(
      ["/proc/net/tcp", "/proc/net/tcp6"].map((path) =>
        readFile(path, { encoding: "utf8", signal }).catch(() => ""),
      ),
    )
  ).flatMap((text) => parseProcNetTcp(text));
  const relevant = listeners.filter(
    (l) => l.port === port && targets.some((t) => reaches(l.address, t)),
  );
  if (!relevant.length) return false;
  const names = (await readdir("/proc")).filter((n) => /^\d+$/.test(n));
  if (names.length > MAX_PROCESSES) return false;
  const table: ProcessEntry[] = [];
  for (let i = 0; i < names.length; i += 128) {
    signal.throwIfAborted();
    const batch = await Promise.all(
      names
        .slice(i, i + 128)
        .map((n) =>
          readFile(`/proc/${n}/stat`, "utf8").then(
            parseProcStat,
            () => undefined,
          ),
        ),
    );
    for (const p of batch) if (p) table.push(p);
  }
  const owned = new Set([...ownedProcesses(table, roots), ...pids]);
  if (owned.size > MAX_OWNED) return false;
  const inodes = new Set<string>();
  for (const pid of owned) {
    signal.throwIfAborted();
    const fds = await readdir(`/proc/${pid}/fd`).catch(() => []);
    if (fds.length > MAX_FDS) return false;
    for (const fd of fds) {
      const link = await readlink(`/proc/${pid}/fd/${fd}`).catch(() => "");
      const m = /^socket:\[(\d+)\]$/.exec(link);
      if (m) inodes.add(m[1]!);
    }
  }
  return ownedListenerDecision(
    relevant,
    (l) => !!l.inode && inodes.has(l.inode),
    targets,
    port,
  );
}
async function macOwned(
  roots: readonly number[],
  pids: readonly number[],
  targets: readonly string[],
  port: number,
  signal: AbortSignal,
) {
  // Without -p, lsof lists every listener on this port that the user can see.
  // Other OS accounts' processes are not visible without root.
  const listeners = parseLsof(
    await run(
      "/usr/sbin/lsof",
      ["-nP", "-w", `-iTCP:${port}`, "-sTCP:LISTEN", "-F", "ptn"],
      signal,
    ),
  );
  if (!ownedListenerDecision(listeners, () => true, targets, port))
    return false;
  const table = parsePs(
    await run(
      "/bin/ps",
      ["-A", "-o", "pid=", "-o", "ppid=", "-o", "pgid="],
      signal,
    ),
  );
  if (table.length > MAX_PROCESSES) return false;
  const owned = new Set([...ownedProcesses(table, roots), ...pids]);
  return ownedListenerDecision(
    listeners,
    (l) => l.pid !== undefined && owned.has(l.pid),
    targets,
    port,
  );
}

// Positive answers only, briefly: a test client can open many connections in a
// row, while a server that has not started listening yet must be re-checked.
const cache = new Map<string, number>();
const CACHE_MS = 1500;
export type OwnershipQuery = {
  // Group leaders of this session's running unsandboxed background jobs.
  roots: readonly number[];
  // Individual processes whose own listeners count (not their descendants).
  pids?: readonly number[];
  targets: readonly string[];
  port: number;
  signal?: AbortSignal;
  platform?: NodeJS.Platform;
};
export async function ownsLoopbackListener(q: OwnershipQuery) {
  const platform = q.platform ?? process.platform;
  const pids = q.pids ?? [];
  if (
    (!q.roots.length && !pids.length) ||
    !q.targets.length ||
    !(platform === "darwin" || platform === "linux")
  )
    return false;
  const key = JSON.stringify([
    platform,
    [...q.roots].sort(),
    [...pids].sort(),
    [...q.targets].sort(),
    q.port,
  ]);
  const now = Date.now();
  if ((cache.get(key) ?? 0) > now) return true;
  const signal = AbortSignal.any([
    AbortSignal.timeout(DETECTION_MS),
    ...(q.signal ? [q.signal] : []),
  ]);
  try {
    const owned = await (platform === "linux" ? linuxOwned : macOwned)(
      q.roots,
      pids,
      q.targets,
      q.port,
      signal,
    );
    signal.throwIfAborted();
    if (owned) {
      if (cache.size >= 64) cache.clear();
      cache.set(key, Date.now() + CACHE_MS);
    }
    return owned;
  } catch {
    return false;
  }
}
