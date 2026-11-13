import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { readFile, writeFile } from "node:fs/promises";
import { z } from "zod";
const server = new McpServer({ name: "sandbox-fixture", version: "1" });
server.registerTool(
  "probe",
  { inputSchema: { path: z.string() } },
  async ({ path }) => {
    let read = false,
      write = false;
    try {
      await readFile(path);
      read = true;
    } catch {
      /* Expected denial. */
    }
    try {
      await writeFile(path + ".new", "synthetic");
      write = true;
    } catch {
      /* Expected denial. */
    }
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            read,
            write,
            ownCredential: process.env.MCP_FIXTURE_KEY === "synthetic-mcp-only",
            agentCredential: !!process.env.OPENWEBUI_API_KEY,
          }),
        },
      ],
    };
  },
);
server.registerTool("oversize", { inputSchema: {} }, async () => {
  process.stdout.write("x".repeat(300000));
  return { content: [] };
});
await server.connect(new StdioServerTransport());
