import { z } from "zod";
import type { McpServer } from "@agentclientprotocol/sdk";
import { readJson, endpoint } from "./config.js";
const env = z.record(
  z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
  z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
);
const toolNames = z
  .array(z.string().regex(/^[A-Za-z0-9_.-]{1,128}$/))
  .max(100)
  .refine(
    (names) => new Set(names).size === names.length,
    "Duplicate tool name",
  );
export const mcpOptionsSchema = z
  .object({
    includeTools: toolNames,
    alwaysApproveTools: toolNames.default(["browser_navigate"]),
    maxOutputChars: z.number().int().min(256).max(100000).default(24000),
    callTimeoutMs: z.number().int().min(100).max(600000).default(60000),
    maxFrameBytes: z.number().int().min(256000).max(8000000).default(1000000),
    stripImages: z.boolean().default(true),
    rejectFileOutput: z.boolean().default(true),
  })
  .strict();
export type McpOptions = z.infer<typeof mcpOptionsSchema>;
// App-owned policy is not an ACP extension. Only objects created from the
// explicit user configuration receive these options, never client JSON fields.
const optionsByServer = new WeakMap<McpServer, McpOptions>();
export function mcpOptions(server: McpServer) {
  return optionsByServer.get(server);
}
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
          options: mcpOptionsSchema.optional(),
        })
        .strict(),
      z
        .object({
          type: z.enum(["http", "sse"]),
          name: z.string(),
          url: z.string(),
          headersFrom: env.default({}),
          options: mcpOptionsSchema.optional(),
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
  return parseUserMcp(raw);
}
export function parseUserMcp(raw: unknown): McpServer[] {
  return schema.parse(raw).map((s) => {
    let server: McpServer;
    if (s.type === "stdio") {
      server = {
        name: s.name,
        command: s.command,
        args: s.args,
        env: values(s.envFrom),
      };
    } else {
      endpoint(s.url, "");
      server = {
        type: s.type,
        name: s.name,
        url: s.url,
        headers: values(s.headersFrom),
      };
    }
    if (s.options) optionsByServer.set(server, s.options);
    return server;
  });
}
