import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { browserSettings } from "./settings.mjs";
import { startHttpServer } from "./server.mjs";
import { createOwnedConnection } from "./connection.mjs";

const temporary = await mkdtemp(join(tmpdir(), "openwebui-browser-"));
const mode = process.argv[2];
let close = async () => {};
let stopping = false;
async function finish(code = 0) {
  if (stopping) return;
  stopping = true;
  await close().catch(() => {});
  await rm(temporary, { recursive: true, force: true }).catch(() => {});
  process.exit(code);
}
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"])
  process.once(signal, () => void finish());
try {
  // Playwright's Linux cache resolver is memoized. Set its supported location
  // before importing Playwright, including the MCP server-registry cache used
  // before Chromium starts. The container's real home stays read-only.
  const cache = join(temporary, "cache");
  await mkdir(cache, { mode: 0o700 });
  process.env.XDG_CACHE_HOME = cache;
  const { createConnection } = await import("@playwright/mcp");
  const { chromium } = await import("playwright");
  const connect = () =>
    createOwnedConnection({
      createConnection,
      chromium,
      settings: browserSettings(temporary, process.env),
    });
  if (mode === "--http") {
    const server = await startHttpServer({
      createConnection: connect,
      host: "0.0.0.0",
      port: 8931,
    });
    close = server.close;
    console.error(
      "Browser MCP ready on container port 8931; publish to host loopback only.",
    );
  } else if (mode === "--stdio") {
    const server = await connect();
    close = () => server.close();
    await server.connect(new StdioServerTransport());
    process.stdin.once("end", () => void finish());
  } else throw new Error("Invalid wrapper mode");
} catch {
  console.error(
    "Browser MCP failed to start; check the pinned installation and runtime.",
  );
  await finish(1);
}
