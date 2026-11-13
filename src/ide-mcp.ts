import type { McpServer } from "@agentclientprotocol/sdk";
import { isAbsolute } from "node:path";

// The verified IDE descriptor contains public routing metadata as well as its
// credential. Treat all other MCP values conservatively as secrets.
export function mcpSecrets(servers: McpServer[]): string[] {
  return servers.flatMap((server) => {
    const fields = "command" in server ? server.env : server.headers;
    let ide = false;
    try {
      ide = ideMcpConnection(server) !== server;
    } catch {
      // Invalid definitions remain fully redacted; activation validates them.
    }
    return fields
      .filter(
        (field) =>
          !ide ||
          ![
            "IJ_MCP_SERVER_PROJECT_PATH",
            "IJ_MCP_SERVER_PORT",
            "IJ_MCP_DEBUG",
          ].includes(field.name),
      )
      .map((field) => field.value);
  });
}

// Verified against PyCharm 2026.3 (263.7307.206): the native stdio runner
// forwards IJ_MCP_* headers to localhost /sse, excluding IJ_MCP_DEBUG and
// removing only the IJ_MCP_HEADER_ prefix. Do not launch or inspect IDE code.
export function ideMcpConnection(server: McpServer): McpServer {
  if (
    !("command" in server) ||
    !isAbsolute(server.command) ||
    !/\.app\/Contents\/MacOS\/(pycharm|idea)$/.test(server.command) ||
    server.args.length !== 1 ||
    server.args[0] !== "stdioMcpServer" ||
    server.env.some((e) => !e.name.startsWith("IJ_MCP_"))
  )
    return server;
  const port = server.env.find((e) => e.name === "IJ_MCP_SERVER_PORT")?.value;
  const project = server.env.find(
    (e) => e.name === "IJ_MCP_SERVER_PROJECT_PATH",
  )?.value;
  if (
    !port ||
    !/^[1-9][0-9]{0,4}$/.test(port) ||
    Number(port) > 65535 ||
    !project ||
    !isAbsolute(project)
  )
    throw new Error("Invalid IDE MCP connection descriptor");
  const headers = server.env
    .filter((e) => e.name !== "IJ_MCP_DEBUG")
    .map((e) => ({
      name: e.name.replace(/^IJ_MCP_HEADER_/, ""),
      value: e.value,
    }));
  if (new Set(headers.map((h) => h.name.toLowerCase())).size !== headers.length)
    throw new Error("Ambiguous IDE MCP headers");
  // Validate without displaying values, including CR/LF injection rejection.
  new Headers(headers.map((h) => [h.name, h.value]));
  return {
    type: "sse",
    name: server.name,
    url: `http://localhost:${port}/sse`,
    headers,
  };
}
