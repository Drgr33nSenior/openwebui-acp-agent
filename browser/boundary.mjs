// Origin boundary for a confined browser session.
//
// Chromium sends every request of a confined session through this loopback
// proxy, loopback targets included. The proxy forwards plain HTTP to an
// allowed origin and refuses everything else: other origins, HTTPS and
// WebSocket tunnels (CONNECT), upgrades and malformed targets. An origin
// becomes allowed only when the MCP client itself opens a URL there
// (browser_navigate, or browser_tabs "new" with a URL). Page content cannot
// add one, so links, popups, redirects, scripts, frames and history stay
// inside the origins the client chose.
//
// Enforcement is at the network because request interception is not enough:
// the pinned Playwright never offers a redirect hop or a WebSocket handshake
// to a route handler, so upstream's network.allowedOrigins lets a redirect
// from an allowed origin reach any other origin.
import http from "node:http";

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);
const REFUSAL =
  "Blocked by the browser origin boundary. This session loads only plain-HTTP origins that the client opened with browser_navigate.\n";

// The authority (host[:port]) that an MCP message opens explicitly, if any.
export function navigatedAuthority(message) {
  if (message?.method !== "tools/call") return undefined;
  const { name, arguments: args } = message.params ?? {};
  if (
    name !== "browser_navigate" &&
    !(name === "browser_tabs" && args?.action === "new")
  )
    return undefined;
  return httpAuthority(args?.url);
}
function httpAuthority(value) {
  if (typeof value !== "string") return undefined;
  let url;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  return url.protocol === "http:" && !url.username && !url.password
    ? url.host
    : undefined;
}

export async function startOriginBoundary() {
  const allowed = new Set();
  const refuse = (res) => {
    res.writeHead(403, {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
      Connection: "close",
    });
    res.end(REFUSAL);
  };
  const server = http.createServer({ maxHeaderSize: 16384 }, (req, res) => {
    // A proxy request names its target in absolute form.
    const authority = httpAuthority(req.url);
    if (!authority || !allowed.has(authority)) return refuse(res);
    const target = new URL(req.url);
    const headers = {};
    for (const [name, value] of Object.entries(req.headers))
      if (!HOP_BY_HOP.has(name)) headers[name] = value;
    headers.host = target.host;
    const upstream = http.request(
      {
        host: target.hostname.replace(/^\[|\]$/g, ""),
        port: target.port || 80,
        method: req.method,
        path: target.pathname + target.search,
        headers,
        agent: false,
      },
      (response) => {
        const forwarded = [];
        for (let i = 0; i < response.rawHeaders.length; i += 2)
          if (!HOP_BY_HOP.has(response.rawHeaders[i].toLowerCase()))
            forwarded.push(response.rawHeaders[i], response.rawHeaders[i + 1]);
        res.writeHead(response.statusCode, response.statusMessage, forwarded);
        response.pipe(res);
      },
    );
    upstream.setTimeout(30000, () => upstream.destroy());
    upstream.on("error", () => {
      if (res.headersSent) return res.destroy();
      res.writeHead(502, { "Cache-Control": "no-store", Connection: "close" });
      res.end();
    });
    res.on("close", () => upstream.destroy());
    req.pipe(upstream);
  });
  // No tunnel and no protocol upgrade leaves a confined session.
  server.on("connect", (_req, socket) => {
    socket.on("error", () => {});
    socket.end(
      "HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
    );
  });
  server.on("upgrade", (_req, socket) => socket.destroy());
  // Every socket, so that closing never waits for a peer: a refused tunnel
  // is no longer one of the server's HTTP connections.
  const sockets = new Set();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return {
    // Playwright launch option. "<-loopback>" removes Chromium's implicit
    // proxy bypass for loopback addresses.
    proxy: {
      server: `http://127.0.0.1:${server.address().port}`,
      bypass: "<-loopback>",
    },
    observe(message) {
      const authority = navigatedAuthority(message);
      if (authority) allowed.add(authority);
    },
    async close() {
      const closed = new Promise((resolve) => server.close(resolve));
      for (const socket of sockets) socket.destroy();
      await closed;
    },
  };
}
