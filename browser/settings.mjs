// Public createConnection configuration equivalents of the fixed CLI flags.
// Using the API avoids CLI environment/config-file overrides and lets our HTTP
// listener reject browser-origin requests before the official MCP transport.
import { join } from "node:path";

export function browserSettings(temporary, environment = {}) {
  let proxy;
  const raw = environment.HTTPS_PROXY || environment.HTTP_PROXY;
  if (raw) {
    const parsed = new URL(raw);
    if (
      !["http:", "https:"].includes(parsed.protocol) ||
      parsed.pathname !== "/" ||
      parsed.search ||
      parsed.hash
    )
      throw new Error("Unsupported browser proxy configuration");
    proxy = {
      server: parsed.origin,
      username: decodeURIComponent(parsed.username),
      password: decodeURIComponent(parsed.password),
    };
  }
  return {
    browser: {
      browserName: "chromium",
      isolated: true,
      launchOptions: {
        headless: true,
        chromiumSandbox: false,
        ...(proxy ? { proxy } : {}),
        env: {
          PATH: environment.PATH || "/usr/local/bin:/usr/bin:/bin",
          LANG: "C.UTF-8",
          TMPDIR: temporary,
          TMP: temporary,
          TEMP: temporary,
          XDG_CACHE_HOME: join(temporary, "cache"),
        },
      },
      contextOptions: { acceptDownloads: false, serviceWorkers: "block" },
    },
    webmcp: false,
    imageResponses: "omit",
    snapshot: { mode: "none" },
    timeouts: { navigation: 20000, action: 5000, idle: 600000 },
    outputDir: temporary,
    outputMaxSize: 16000000,
    ignoreRoots: true,
    saveSession: false,
  };
}

export function workerEnvironment(environment) {
  const safe = { PLAYWRIGHT_BROWSERS_PATH: "0" };
  // Named inputs only. No project .env, DEBUG, NODE_OPTIONS, PWTEST_*, MCP
  // credentials, browser-profile overrides or inherited provider keys.
  for (const name of [
    "PATH",
    "TMPDIR",
    "TMP",
    "TEMP",
    "SystemRoot",
    "WINDIR",
    "HTTP_PROXY",
    "HTTPS_PROXY",
  ])
    if (environment[name]) safe[name] = environment[name];
  return safe;
}
