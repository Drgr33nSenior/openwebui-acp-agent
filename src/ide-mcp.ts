import type { McpServer } from "@agentclientprotocol/sdk";
import { isAbsolute, relative, sep } from "node:path";
import { lstat, realpath } from "node:fs/promises";
import { z } from "zod";
import { target } from "./workspace.js";

export type IdeFileProblems = { projectPath: string };

// This is an observed IDE contract, not a server-provided authorization hint.
// A changed or extended input contract must be inspected before it can receive
// the diagnostic exemption. Unknown tools retain their ordinary approvals.
export function isIdeFileProblemsTool(tool: {
  name: string;
  inputSchema: unknown;
}) {
  if (tool.name !== "get_file_problems") return false;
  const schema = z
    .object({
      type: z.literal("object"),
      properties: z.record(
        z.string(),
        z.object({ type: z.string() }).passthrough(),
      ),
      required: z.array(z.string()),
    })
    .passthrough()
    .safeParse(tool.inputSchema);
  if (!schema.success) return false;
  const known = {
    filePath: "string",
    errorsOnly: "boolean",
    projectPath: "string",
    timeout: "integer",
  };
  return (
    schema.data.required.length === 1 &&
    schema.data.required[0] === "filePath" &&
    Object.keys(schema.data.properties).length === Object.keys(known).length &&
    Object.entries(known).every(
      ([name, type]) => schema.data.properties[name]?.type === type,
    )
  );
}

export async function ideFileProblemsScope(
  source: McpServer,
  mapped: McpServer,
  cwd: string,
  ideServers: readonly McpServer[],
): Promise<IdeFileProblems | undefined> {
  // Provenance comes from this session's ACP setup, not an arbitrary HTTP URL,
  // name, description, annotation, or a look-alike user-configured definition.
  if (
    !ideServers.includes(source) ||
    mapped === source ||
    !("command" in source)
  )
    return undefined;
  const project = source.env.find(
    (e) => e.name === "IJ_MCP_SERVER_PROJECT_PATH",
  )?.value;
  if (!project) return undefined;
  try {
    const projectPath = await realpath(project);
    return projectPath === (await realpath(cwd)) ? { projectPath } : undefined;
  } catch {
    return undefined;
  }
}

const problemArguments = z
  .object({
    filePath: z.string().min(1).max(4096),
    errorsOnly: z.boolean().default(true),
    projectPath: z.string().min(1).max(4096).optional(),
    timeout: z.number().int().min(1).max(30000).default(10000),
  })
  .strict();

export async function ideFileProblemsArguments(
  projectPath: string,
  input: Record<string, unknown>,
) {
  const args = problemArguments.parse(input);
  if ((await realpath(projectPath)) !== projectPath)
    throw new Error("IDE diagnostic workspace path changed");
  if (
    args.projectPath !== undefined &&
    (await realpath(args.projectPath)) !== projectPath
  )
    throw new Error("IDE diagnostic project does not match the workspace");
  // Missing leaf files can exist only in the IDE's unsaved editor state. Check
  // their existing parent chain without granting filesystem creation or writes.
  const path = await target(projectPath, args.filePath, true, false);
  const stat = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (stat && (!stat.isFile() || stat.nlink !== 1 || stat.size > 100000))
    throw new Error("IDE diagnostics require a bounded workspace text file");
  return {
    filePath: relative(projectPath, path).split(sep).join("/"),
    projectPath,
    errorsOnly: args.errorsOnly,
    timeout: args.timeout,
  };
}

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
  new Headers(headers.map((h): [string, string] => [h.name, h.value]));
  return {
    type: "sse",
    name: server.name,
    url: `http://localhost:${port}/sse`,
    headers,
  };
}
