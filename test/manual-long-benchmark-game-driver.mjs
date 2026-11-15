// Browser driver for the hidden Lights Out play-through. The evaluator in
// manual-long-benchmark-game.mjs sends this file on stdin, after one line
// that sets globalThis.LIGHTS_OUT_PAYLOAD, to `node --input-type=module -`:
// inside the browser container (cwd /opt/openwebui-browser) or on the host
// with browser/ as cwd. It imports nothing from the repository.
//
// The page is served from memory on a fixed origin; nothing is written to
// disk and every request to another origin is aborted and counted. It reads
// the page only through Playwright locators, records raw observations and PNG
// screenshots, and prints one JSON object. It does not judge: the evaluator
// compares the observations with the hidden expectations.
import { chromium } from "playwright";

const ORIGIN = "http://lights-out.test";
const TYPES = {
  html: "text/html; charset=utf-8",
  htm: "text/html; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  mjs: "text/javascript; charset=utf-8",
  css: "text/css; charset=utf-8",
  json: "application/json",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  ico: "image/x-icon",
  woff2: "font/woff2",
};
const {
  files,
  entry,
  steps,
  size,
  launch = {},
} = globalThis.LIGHTS_OUT_PAYLOAD;
const out = {
  steps: [],
  pageErrors: 0,
  consoleErrors: 0,
  externalRequests: 0,
  dialogs: 0,
  litDistinct: null,
  browserVersion: null,
};
const browser = await chromium.launch({ headless: true, ...launch });
try {
  out.browserVersion = browser.version();
  const context = await browser.newContext({
    viewport: { width: 640, height: 640 },
    deviceScaleFactor: 1,
    acceptDownloads: false,
    serviceWorkers: "block",
  });
  await context.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    const name = decodeURIComponent(url.pathname.slice(1)) || entry;
    if (url.origin !== ORIGIN || !Object.hasOwn(files, name)) {
      if (url.origin !== ORIGIN) out.externalRequests++;
      return route.abort();
    }
    const type =
      TYPES[name.split(".").pop().toLowerCase()] ?? "application/octet-stream";
    return route.fulfill({
      status: 200,
      contentType: type,
      body: Buffer.from(files[name], "base64"),
    });
  });
  const page = await context.newPage();
  page.on("pageerror", () => out.pageErrors++);
  page.on("console", (m) => m.type() === "error" && out.consoleErrors++);
  page.on("dialog", (d) => {
    out.dialogs++;
    void d.dismiss().catch(() => {});
  });
  const cell = (row, col) =>
    page.locator(`#board button[data-row="${row}"][data-col="${col}"]`);
  const settle = () => page.waitForTimeout(80);
  const text = async (id) => {
    const l = page.locator(`#${id}`);
    return (await l.count()) === 1 ? await l.textContent() : null;
  };
  async function observe() {
    const buttons = page.locator("#board button");
    const count = await buttons.count();
    const cells = [];
    for (let i = 0; i < Math.min(count, size * size + 1); i++) {
      const b = buttons.nth(i);
      cells.push({
        row: await b.getAttribute("data-row"),
        col: await b.getAttribute("data-col"),
        pressed: await b.getAttribute("aria-pressed"),
      });
    }
    const undo = page.locator("#undo");
    return {
      count,
      cells,
      moves: await text("moves"),
      status: await text("status"),
      undoDisabled: (await undo.count()) === 1 ? await undo.isDisabled() : null,
    };
  }
  for (const step of steps) {
    const record = { id: step.id };
    try {
      if (step.action.load)
        await page.goto(`${ORIGIN}/${entry}`, { timeout: 10000 });
      for (const [row, col] of step.action.clicks ?? [])
        await cell(row, col).click({ timeout: 3000 });
      if (step.action.button)
        await page.locator(`#${step.action.button}`).click({ timeout: 3000 });
      await settle();
    } catch (error) {
      record.error = String(error?.message ?? error)
        .split("\n", 1)[0]
        .slice(0, 300);
    }
    try {
      Object.assign(record, await observe());
      if (step.screenshot)
        record.screenshot = (
          await page.screenshot({ type: "png", timeout: 10000 })
        ).toString("base64");
    } catch (error) {
      record.error ??= String(error?.message ?? error)
        .split("\n", 1)[0]
        .slice(0, 300);
    }
    out.steps.push(record);
    // A lit and an unlit light, captured once while both exist.
    if (out.litDistinct === null && record.cells?.length) {
      const lit = record.cells.find((c) => c.pressed === "true");
      const unlit = record.cells.find((c) => c.pressed === "false");
      if (lit && unlit)
        try {
          const a = await cell(lit.row, lit.col).screenshot({ timeout: 5000 });
          const b = await cell(unlit.row, unlit.col).screenshot({
            timeout: 5000,
          });
          out.litDistinct = !a.equals(b);
        } catch {
          out.litDistinct = false;
        }
    }
  }
} finally {
  await browser.close();
}
process.stdout.write(JSON.stringify(out));
