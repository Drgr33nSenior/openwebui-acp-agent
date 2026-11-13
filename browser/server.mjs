import http from "node:http";
import { randomUUID } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

export async function startHttpServer({
  createConnection,
  host = "127.0.0.1",
  port = 8931,
}) {
  const sessions = new Map();
  let opening = 0;
  const localHost = (req) => {
    const rawCount = req.rawHeaders.filter(
      (_, index) =>
        index % 2 === 0 && req.rawHeaders[index].toLowerCase() === "host",
    ).length;
    const match =
      /^(?:localhost|127\.0\.0\.1|\[::1\])(?::([1-9][0-9]{0,4}))?$/.exec(
        req.headers.host?.toLowerCase() ?? "",
      );
    return (
      rawCount === 1 && !!match && (!match[1] || Number(match[1]) <= 65535)
    );
  };
  const reply = (res, status, message) => {
    if (res.headersSent) return res.destroy();
    res.writeHead(status, {
      "Content-Type": "text/plain",
      "Cache-Control": "no-store",
    });
    res.end(message);
  };
  async function readBody(req) {
    const parts = [];
    let length = 0;
    for await (const part of req) {
      length += part.length;
      if (length > 256000) throw new Error("body-limit");
      parts.push(part);
    }
    return JSON.parse(Buffer.concat(parts).toString("utf8"));
  }
  const server = http.createServer(
    { maxHeaderSize: 8192, requestTimeout: 30000, headersTimeout: 10000 },
    async (req, res) => {
      if (
        !localHost(req) ||
        req.headers.origin !== undefined ||
        (req.headers["sec-fetch-site"] !== undefined &&
          !["none", "same-origin"].includes(req.headers["sec-fetch-site"]))
      )
        return reply(
          res,
          403,
          "Browser-origin and non-loopback-host requests are refused",
        );
      if (req.url !== "/mcp") return reply(res, 404, "Not found");
      if (!["GET", "POST", "DELETE"].includes(req.method))
        return reply(res, 405, "Method not allowed");
      const id = req.headers["mcp-session-id"];
      if (Array.isArray(id) || (id && (id.length > 100 || !sessions.has(id))))
        return reply(res, 404, "Session not found");
      let body;
      if (req.method === "POST") {
        if (
          req.headers["content-type"]?.split(";")[0].trim().toLowerCase() !==
          "application/json"
        )
          return reply(res, 415, "JSON required");
        if (Number(req.headers["content-length"]) > 256000)
          return reply(res, 413, "Request too large");
        try {
          body = await readBody(req);
        } catch (error) {
          return reply(
            res,
            error.message === "body-limit" ? 413 : 400,
            "Invalid or oversized JSON",
          );
        }
      }
      if (id) {
        const session = sessions.get(id);
        session.lastUsed = Date.now();
        try {
          await session.transport.handleRequest(req, res, body);
        } catch {
          reply(res, 500, "MCP request failed");
        }
        return;
      }
      if (req.method !== "POST" || body?.method !== "initialize")
        return reply(res, 400, "Initialize a session first");
      if (sessions.size + opening >= 4)
        return reply(res, 503, "Browser session limit reached");
      opening++;
      let connection;
      let transport;
      try {
        connection = await createConnection();
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: randomUUID,
          // The SDK awaits this callback before acknowledging DELETE. Wait
          // for the owned browser as well as the MCP transport to close.
          onsessionclosed: () => connection.close(),
          onsessioninitialized: (sessionId) => {
            sessions.set(sessionId, {
              connection,
              transport,
              lastUsed: Date.now(),
            });
          },
        });
        await connection.connect(transport);
        const onclose = transport.onclose;
        transport.onclose = () => {
          sessions.delete(transport.sessionId);
          onclose?.();
        };
        await transport.handleRequest(req, res, body);
        if (!transport.sessionId) await connection.close();
      } catch {
        await connection?.close().catch(() => {});
        reply(res, 500, "Browser session could not start");
      } finally {
        opening--;
      }
    },
  );
  server.maxHeadersCount = 32;
  server.maxConnections = 32;
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
  const actualPort = server.address().port;
  const cleanup = setInterval(() => {
    for (const [id, session] of sessions)
      if (Date.now() - session.lastUsed > 600000) {
        sessions.delete(id);
        void session.connection.close().catch(() => {});
      }
  }, 30000);
  cleanup.unref();
  return {
    server,
    url: `http://127.0.0.1:${actualPort}/mcp`,
    close: async () => {
      clearInterval(cleanup);
      await Promise.allSettled(
        [...sessions.values()].map((s) => s.connection.close()),
      );
      sessions.clear();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
