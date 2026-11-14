import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { basename, extname, relative, posix } from "node:path";
import { z } from "zod";
import { abortable } from "./cancel.js";
import { readBytes, target } from "./workspace.js";

export const previewSchema = z
  .object({
    files: z.array(z.string().min(1).max(4096)).min(1).max(128),
    entry: z.string().min(1).max(4096),
    port: z
      .number()
      .int()
      .min(0)
      .max(65535)
      .refine((p) => p === 0 || p >= 1024)
      .default(0),
    timeout_ms: z.number().int().min(1000).max(600000).default(120000),
  })
  .strict();

const types: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".wav": "audio/wav",
  ".mp3": "audio/mpeg",
  ".ogg": "audio/ogg",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".wasm": "application/wasm",
};
const textTypes = new Set([".html", ".css", ".js", ".mjs", ".json", ".svg"]);
export type PreviewInfo = {
  id: string;
  url: string;
  containerUrl: string;
  files: string[];
  bytes: number;
  expiresAt: string;
};
type Live = {
  controller: AbortController;
  server?: Server;
  info?: PreviewInfo;
  timer?: ReturnType<typeof setTimeout>;
  assets: Map<string, { bytes: Buffer; mime: string }>;
};

// Validate explicit names only. No directory discovery, project execution,
// symlinks, implicit index lookup, dotfiles or unrestricted static-file middleware.
export async function previewPaths(root: string, names: string[]) {
  const result: string[] = [];
  for (const name of names) {
    if (
      name.includes("\\") ||
      name.split("/").some((p) => !p || p.startsWith(".")) ||
      /[?#%\x00-\x1f\x7f]/.test(name)
    )
      throw new Error("Preview requires plain workspace-relative file paths");
    if (!types[extname(name).toLowerCase()])
      throw new Error("Unsupported preview asset type");
    const path = await target(root, name);
    const normalized = relative(root, path).replaceAll("\\", "/");
    if (result.includes(normalized)) throw new Error("Duplicate preview file");
    result.push(normalized);
  }
  return result;
}

export function previewRoute(entry: string, file: string) {
  const path = posix.relative(posix.dirname(entry), file);
  if (!path || path.split("/").includes("..") || posix.isAbsolute(path))
    throw new Error("Preview assets must be within the HTML entry's directory");
  return "/" + path;
}

// One bounded immutable snapshot per session/turn, never persisted or restored.
// This listener is agent-owned; no workspace executable receives socket access.
export class Preview {
  private live?: Live;
  info() {
    return this.live?.info;
  }

  async start(
    root: string,
    input: z.infer<typeof previewSchema>,
    check: () => Promise<void>,
    signal: AbortSignal,
    readEditorText?: (path: string) => Promise<string>,
  ): Promise<PreviewInfo> {
    if (this.live)
      throw new Error("Stop the current preview before starting another");
    const live: Live = { controller: new AbortController(), assets: new Map() };
    this.live = live;
    const expiresAt = new Date(Date.now() + input.timeout_ms).toISOString();
    const combined = AbortSignal.any([signal, live.controller.signal]);
    const close = () => {
      void this.closeLive(live);
    };
    combined.addEventListener("abort", close, { once: true });
    live.timer = setTimeout(close, input.timeout_ms);
    live.timer.unref();
    const recheck = async () => {
      combined.throwIfAborted();
      await abortable(check(), combined);
      combined.throwIfAborted();
    };
    try {
      await recheck();
      const paths = await previewPaths(root, input.files);
      if (
        !paths.includes(input.entry) ||
        extname(input.entry).toLowerCase() !== ".html"
      )
        throw new Error("Preview entry must be an explicitly listed HTML file");
      for (const name of paths) previewRoute(input.entry, name);
      let total = 0;
      for (const name of paths) {
        await recheck();
        const path = await target(root, name);
        const bytes =
          readEditorText && textTypes.has(extname(name).toLowerCase())
            ? Buffer.from(await abortable(readEditorText(name), combined))
            : await abortable(readBytes(root, path, 1_000_000), combined);
        if (bytes.length > 1_000_000 || (total += bytes.length) > 8_000_000)
          throw new Error(
            "Preview snapshot exceeds the 1 MB file / 8 MB total limit",
          );
        live.assets.set(previewRoute(input.entry, name), {
          bytes,
          mime: types[extname(name).toLowerCase()]!,
        });
      }
      await recheck();
      let requests = 0,
        sent = 0,
        pending = 0;
      const server = createServer({ maxHeaderSize: 8192 }, (req, res) => {
        const denied = () => {
          if (!res.destroyed) res.writeHead(403).end();
        };
        if (++requests > 512 || pending >= 8) {
          res.writeHead(429).end();
          if (requests > 512) close();
          return;
        }
        const address = server.address();
        if (!address || typeof address === "string") {
          res.destroy();
          return;
        }
        const port = address.port;
        const hosts = ["127.0.0.1", "localhost", "host.docker.internal"].map(
          (h) => `${h}:${port}`,
        );
        if (
          req.rawHeaders.filter(
            (v, i) => i % 2 === 0 && v.toLowerCase() === "host",
          ).length !== 1 ||
          !hosts.includes(req.headers.host ?? "") ||
          (req.headers.origin &&
            req.headers.origin !== `http://${req.headers.host}`) ||
          ["cross-site", "same-site"].includes(
            req.headers["sec-fetch-site"] as string,
          )
        ) {
          denied();
          return;
        }
        if (req.method !== "GET" && req.method !== "HEAD") {
          res.writeHead(405, { Allow: "GET, HEAD" }).end();
          return;
        }
        pending++;
        void (async () => {
          await recheck();
          // Do not use URL normalization: reject encoded traversal/separators,
          // queries and ambiguous paths rather than resolving them to an asset.
          let name: string;
          try {
            if (/%2f|%5c/i.test(req.url ?? "")) {
              denied();
              return;
            }
            name = decodeURIComponent(req.url ?? "");
          } catch {
            denied();
            return;
          }
          if (name === "/") name = "/" + basename(input.entry);
          if (
            /[?#%\\\x00-\x1f\x7f]/.test(name) ||
            name
              .split("/")
              .slice(1)
              .some((p) => !p || p.startsWith("."))
          ) {
            denied();
            return;
          }
          const asset = live.assets.get(name);
          if (!asset) {
            res.writeHead(404).end();
            return;
          }
          if ((sent += asset.bytes.length) > 64_000_000) {
            res.writeHead(429).end();
            close();
            return;
          }
          res.writeHead(200, {
            "Content-Type": asset.mime,
            "Content-Length": asset.bytes.length,
            "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff",
            "Referrer-Policy": "no-referrer",
            "Cross-Origin-Resource-Policy": "same-origin",
            "Content-Security-Policy":
              "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; media-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'; frame-ancestors 'none'; worker-src 'none'",
          });
          res.end(req.method === "HEAD" ? undefined : asset.bytes);
        })()
          .catch(() => {
            denied();
            close();
          })
          .finally(() => {
            pending--;
          });
      });
      live.server = server;
      server.maxConnections = 8;
      server.maxRequestsPerSocket = 64;
      server.headersTimeout = 3000;
      server.requestTimeout = 5000;
      server.keepAliveTimeout = 1000;
      server.setTimeout(5000, (socket) => socket.destroy());
      server.on("upgrade", (_req, socket) => socket.destroy());
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(
          { host: "127.0.0.1", port: input.port, signal: combined },
          () => {
            server.removeListener("error", reject);
            server.on("error", close);
            resolve();
          },
        );
        combined.addEventListener(
          "abort",
          () => reject(new Error("Preview cancelled")),
          { once: true },
        );
      });
      await recheck();
      const port = (server.address() as { port: number }).port;
      const entry = encodeURIComponent(basename(input.entry));
      live.info = {
        id: randomUUID(),
        url: `http://127.0.0.1:${port}/${entry}`,
        containerUrl: `http://host.docker.internal:${port}/${entry}`,
        files: paths,
        bytes: total,
        expiresAt,
      };
      return live.info;
    } catch (error) {
      await this.closeLive(live);
      throw error;
    }
  }
  private async closeLive(live: Live) {
    if (this.live === live) this.live = undefined;
    clearTimeout(live.timer);
    const server = live.server;
    live.server = undefined;
    // Detach ownership before abort dispatch re-enters cleanup.
    if (!live.controller.signal.aborted) live.controller.abort();
    live.assets.clear();
    if (server) {
      const closed = new Promise<void>((resolve) =>
        server.close(() => resolve()),
      );
      server.closeAllConnections();
      await closed;
    }
  }
  async stop(id: string) {
    if (this.live?.info?.id !== id)
      throw new Error("Unknown active preview in this session");
    await this.close();
    return "Preview stopped; its listener is closed and snapshot released.";
  }
  async close() {
    if (this.live) await this.closeLive(this.live);
  }
}
