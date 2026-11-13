import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { browserSettings, workerEnvironment } from "../settings.mjs";
import { createConnection } from "@playwright/mcp";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

test("fixed browser settings isolate the profile and avoid image/file downloads", () => {
  const settings = browserSettings("/tmp/fixture");
  assert.equal(settings.browser.isolated, true);
  assert.equal(settings.browser.launchOptions.headless, true);
  assert.equal(settings.browser.launchOptions.chromiumSandbox, false);
  assert.deepEqual(settings.browser.contextOptions, {
    acceptDownloads: false,
    serviceWorkers: "block",
  });
  assert.equal(settings.webmcp, false);
  assert.equal(settings.imageResponses, "omit");
  assert.deepEqual(settings.snapshot, { mode: "none" });
  assert.deepEqual(settings.timeouts, {
    navigation: 20000,
    action: 5000,
    idle: 600000,
  });
  assert.equal(settings.outputDir, "/tmp/fixture");
  assert.equal(settings.ignoreRoots, true);
  assert.equal(settings.browser.userDataDir, undefined);
});

test("wrapper environment is named and never forwards provider keys or profile overrides", () => {
  const safe = workerEnvironment({
    PATH: "/fixture/bin",
    TMPDIR: "/tmp/fixture",
    OPENWEBUI_API_KEY: "synthetic-provider",
    PLAYWRIGHT_MCP_EXTENSION: "true",
    PLAYWRIGHT_MCP_CONFIG: "/unsafe/config",
    PWTEST_EXTENSION_TOKEN: "synthetic-extension",
    NODE_OPTIONS: "--require arbitrary",
    DEBUG: "*",
    XDG_CACHE_HOME: "/host/cache/must-not-be-inherited",
    HTTPS_PROXY: "http://localhost:1234",
  });
  assert.deepEqual(safe, {
    PLAYWRIGHT_BROWSERS_PATH: "0",
    PATH: "/fixture/bin",
    TMPDIR: "/tmp/fixture",
    HTTPS_PROXY: "http://localhost:1234",
  });
  const settings = browserSettings("/tmp/fixture", {
    ...safe,
    OPENWEBUI_API_KEY: "synthetic-provider",
  });
  assert.equal(settings.browser.launchOptions.env.OPENWEBUI_API_KEY, undefined);
  assert.equal(settings.browser.launchOptions.env.HTTPS_PROXY, undefined);
  assert.equal(
    settings.browser.launchOptions.env.XDG_CACHE_HOME,
    "/tmp/fixture/cache",
  );
  assert.equal(
    settings.browser.launchOptions.proxy.server,
    "http://localhost:1234",
  );
});

test("Chromium cache stays in each process's private temporary directory", () => {
  for (const temporary of ["/tmp/browser-one", "/tmp/browser-two"]) {
    const environment = browserSettings(temporary, {
      XDG_CACHE_HOME: "/host/cache",
      HOME: "/host/home",
    }).browser.launchOptions.env;
    assert.equal(environment.XDG_CACHE_HOME, `${temporary}/cache`);
    assert.equal(environment.TMPDIR, temporary);
    assert.equal(environment.HOME, undefined);
  }
});

test("proxy authentication is an explicit browser option, not a credential-bearing launch argument", () => {
  const { proxy } = browserSettings("/tmp/fixture", {
    HTTP_PROXY: "http://fixture:synthetic-proxy@localhost:1234",
  }).browser.launchOptions;
  assert.deepEqual(proxy, {
    server: "http://localhost:1234",
    username: "fixture",
    password: "synthetic-proxy",
  });
  assert.throws(() =>
    browserSettings("/tmp/fixture", {
      HTTP_PROXY: "http://localhost:1234/path",
    }),
  );
  assert.throws(() =>
    browserSettings("/tmp/fixture", { HTTP_PROXY: "file:///tmp/proxy" }),
  );
});

test("browser dependency pins, tool allowlist and container boundary are explicit", async () => {
  const pkg = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  );
  const lock = JSON.parse(
    await readFile(new URL("../package-lock.json", import.meta.url), "utf8"),
  );
  for (const [name, version] of Object.entries(pkg.dependencies)) {
    assert.match(version, /^\d+\.\d+\.\d+(?:-[\w.-]+)?$/);
    const installed = lock.packages[`node_modules/${name}`];
    assert.equal(installed.version, version);
    assert.match(installed.integrity, /^sha512-/);
  }
  assert.equal(
    pkg.dependencies.playwright,
    pkg.dependencies["playwright-core"],
  );
  const allowed = JSON.parse(
    await readFile(new URL("../allowed-tools.json", import.meta.url), "utf8"),
  );
  assert.equal(new Set(allowed).size, allowed.length);
  assert.ok(allowed.includes("browser_navigate"));
  for (const name of [
    "browser_run_code_unsafe",
    "browser_evaluate",
    "browser_file_upload",
    "browser_install",
    "browser_take_screenshot",
    "browser_pdf_save",
  ])
    assert.ok(!allowed.includes(name));
  const compose = await readFile(
    new URL("../compose.yaml", import.meta.url),
    "utf8",
  );
  assert.match(compose, /127\.0\.0\.1:8931:8931/);
  assert.match(compose, /read_only: true/);
  assert.match(compose, /no-new-privileges:true/);
  assert.doesNotMatch(
    compose,
    /privileged:|network_mode:|docker\.sock|volumes:/,
  );
});

test("the pinned upstream catalog contains every allowed tool without launching a browser", async () => {
  const allowed = JSON.parse(
    await readFile(new URL("../allowed-tools.json", import.meta.url), "utf8"),
  );
  const server = await createConnection(
    browserSettings("/tmp/openwebui-browser-catalog"),
  );
  const client = new Client({ name: "wrapper-catalog-test", version: "0.1.0" });
  const [left, right] = InMemoryTransport.createLinkedPair();
  await server.connect(left);
  try {
    await client.connect(right);
    const catalog = await client.listTools();
    for (const name of allowed)
      assert.ok(
        catalog.tools.some((tool) => tool.name === name),
        `Missing pinned tool ${name}`,
      );
    assert.ok(
      catalog.tools.some((tool) => !allowed.includes(tool.name)),
      "The caller filter must remove upstream tools",
    );
    assert.ok(
      catalog.tools.find((tool) => tool.name === "browser_find").inputSchema
        .properties.filename,
      "Filename rejection remains necessary",
    );
  } finally {
    await client.close();
    await server.close();
  }
});
