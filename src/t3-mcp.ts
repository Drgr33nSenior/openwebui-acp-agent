import type { McpServer } from "@agentclientprotocol/sdk";

// T3 Code Beta 0.1.6 supplies an Electron stdio bridge that only forwards
// JSON-RPC to this loopback HTTP endpoint. Use the same endpoint directly;
// never launch the desktop application outside the process sandbox.
export function t3McpConnection(server: McpServer): McpServer {
  if (!("command" in server) || server.name !== "t3-code") return server;
  const match = server.command.match(
    /^(\/.*\/(T3 Code(?: \(Beta\))?)\.app)\/Contents\/MacOS\/\2$/,
  );
  if (
    !match ||
    server.args.length !== 2 ||
    server.args[0] !==
      `${match[1]}/Contents/Resources/app.asar/apps/server/dist/bin.mjs` ||
    server.args[1] !== "acp-mcp-bridge" ||
    server.env.length !== 3 ||
    server.env.some(
      (field) =>
        ![
          "ELECTRON_RUN_AS_NODE",
          "T3_ACP_MCP_ENDPOINT",
          "T3_ACP_MCP_AUTHORIZATION",
        ].includes(field.name),
    )
  )
    return server;
  if (new Set(server.env.map((field) => field.name)).size !== 3)
    throw new Error("Ambiguous T3 MCP connection descriptor");
  const fields = Object.fromEntries(
    server.env.map((field) => [field.name, field.value]),
  );
  let url: URL;
  try {
    url = new URL(fields.T3_ACP_MCP_ENDPOINT!);
  } catch {
    throw new Error("Invalid T3 MCP endpoint");
  }
  if (
    fields.ELECTRON_RUN_AS_NODE !== "1" ||
    url.protocol !== "http:" ||
    !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
    !url.port ||
    url.username ||
    url.password ||
    url.pathname !== "/mcp" ||
    url.search ||
    url.hash ||
    !/^Bearer [^\s]+$/.test(fields.T3_ACP_MCP_AUTHORIZATION!)
  )
    throw new Error("Invalid T3 MCP connection descriptor");
  const headers = [
    { name: "Authorization", value: fields.T3_ACP_MCP_AUTHORIZATION! },
  ];
  new Headers(
    headers.map((field): [string, string] => [field.name, field.value]),
  );
  return { type: "http", name: server.name, url: url.href, headers };
}
