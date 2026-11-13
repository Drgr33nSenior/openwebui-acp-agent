import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
const server = new McpServer({ name: "fixture", version: "1.0.0" });
server.registerTool(
  "search",
  { inputSchema: { query: z.string() } },
  async ({ query }) => ({
    content: [{ type: "text", text: "fixture result " + query }],
  }),
);
await server.connect(new StdioServerTransport());
