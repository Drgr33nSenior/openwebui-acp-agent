import { z } from "zod";
import type { McpServer } from "@agentclientprotocol/sdk";
import { readJson, endpoint } from "./config.js";
const env = z.record(
  z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
  z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
);
const schema = z
  .array(
    z.discriminatedUnion("type", [
      z
        .object({
          type: z.literal("stdio"),
          name: z.string(),
          command: z.string(),
          args: z.array(z.string()),
          envFrom: env.default({}),
        })
        .strict(),
      z
        .object({
          type: z.enum(["http", "sse"]),
          name: z.string(),
          url: z.string(),
          headersFrom: env.default({}),
        })
        .strict(),
    ]),
  )
  .max(16);
function values(refs: Record<string, string>) {
  return Object.entries(refs).map(([name, variable]) => {
    const value = process.env[variable];
    if (!value)
      throw new Error("Configured MCP credential environment variable missing");
    return { name, value };
  });
}
export async function userMcp(): Promise<McpServer[]> {
  const raw = await readJson("mcp.json");
  if (raw === undefined) return [];
  return schema.parse(raw).map((s) => {
    if (s.type === "stdio")
      return {
        name: s.name,
        command: s.command,
        args: s.args,
        env: values(s.envFrom),
      };
    endpoint(s.url, "");
    return {
      type: s.type,
      name: s.name,
      url: s.url,
      headers: values(s.headersFrom),
    };
  });
}
