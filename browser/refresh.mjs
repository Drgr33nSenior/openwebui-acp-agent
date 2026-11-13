import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const [mcp, playwright] = process.argv.slice(2);
if (
  process.argv.length !== 4 ||
  ![mcp, playwright].every((v) => /^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(v))
) {
  console.error("Usage: node refresh.mjs MCP_VERSION PLAYWRIGHT_VERSION");
  process.exit(2);
}
const cwd = fileURLToPath(new URL(".", import.meta.url));
function run(command, args, capture = false) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
    maxBuffer: 1000000,
    timeout: 600000,
  });
  if (result.status !== 0)
    throw new Error(
      `${command} failed; review the working changes and command output`,
    );
  return result.stdout?.trim();
}
const dependency = JSON.parse(
  run(
    "npm",
    ["view", `@playwright/mcp@${mcp}`, "dependencies", "--json"],
    true,
  ),
);
if (
  dependency.playwright !== playwright ||
  dependency["playwright-core"] !== playwright
)
  throw new Error(
    "Requested Playwright versions do not match the MCP package pins",
  );
const path = new URL("./package.json", import.meta.url);
const pkg = JSON.parse(await readFile(path, "utf8"));
pkg.dependencies["@playwright/mcp"] = mcp;
pkg.dependencies.playwright = playwright;
pkg.dependencies["playwright-core"] = playwright;
await writeFile(path, JSON.stringify(pkg, null, 2) + "\n");
const composePath = new URL("./compose.yaml", import.meta.url);
const compose = await readFile(composePath, "utf8");
if (!/^    image: openwebui-acp-browser:[A-Za-z0-9.-]+$/m.test(compose))
  throw new Error(
    "Compose image reference changed; update it explicitly before refreshing",
  );
await writeFile(
  composePath,
  compose.replace(
    /^    image: openwebui-acp-browser:[A-Za-z0-9.-]+$/m,
    `    image: openwebui-acp-browser:${mcp}`,
  ),
);
run("npm", ["install", "--package-lock-only", "--ignore-scripts"]);
run("npm", ["ci", "--ignore-scripts"]);
run("npm", ["test"]);
const image = `openwebui-acp-browser:${mcp}`;
run("docker", ["build", "-t", image, "."]);
let id;
try {
  id = run(
    "docker",
    [
      "run",
      "--detach",
      "--rm",
      "--init",
      "--user",
      "1000:1000",
      "--read-only",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "--pids-limit",
      "256",
      "--memory",
      "2g",
      "--cpus",
      "2",
      "--shm-size",
      "256m",
      "--tmpfs",
      "/tmp:rw,noexec,nosuid,nodev,size=536870912,mode=1777",
      "--tmpfs",
      "/workspace:rw,noexec,nosuid,nodev,size=67108864,uid=1000,gid=1000,mode=0700",
      "--publish",
      "127.0.0.1::8931",
      image,
    ],
    true,
  );
  if (!/^[a-f0-9]{64}$/.test(id))
    throw new Error("Unexpected container identifier");
  const port = run(
    "docker",
    [
      "inspect",
      "--format",
      '{{(index (index .NetworkSettings.Ports "8931/tcp") 0).HostPort}}',
      id,
    ],
    true,
  );
  if (!/^[0-9]+$/.test(port)) throw new Error("Published port unavailable");
  const endpoint = `http://127.0.0.1:${port}/mcp`;
  let ready = false;
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      ready =
        (await fetch(endpoint, { signal: AbortSignal.timeout(1000) }))
          .status === 400;
    } catch {
      /* Container is starting. */
    }
    if (ready) break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  if (!ready) throw new Error("Browser container did not become ready");
  run(process.execPath, ["smoke.mjs", "--url", endpoint]);
  console.log(
    "Refresh and container smoke passed. Review package/lock changes, Chromium revision and the Docker base digest before committing. Nothing was published.",
  );
} finally {
  if (id && /^[a-f0-9]{64}$/.test(id))
    run("docker", ["stop", "--time", "5", id]);
}
