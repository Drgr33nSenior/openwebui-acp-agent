import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import type { McpServer } from "@agentclientprotocol/sdk";
import { Ajv, type ValidateFunction } from "ajv";
import { endpoint } from "./config.js";
import { SandboxMcpTransport } from "./sandbox-mcp.js";
import type { SandboxRun } from "./sandbox.js";
import { lstat } from "node:fs/promises";
import { dirname, isAbsolute, join, parse } from "node:path";
import { homedir } from "node:os";
import { scopePaths } from "./sandbox.js";
import { PolicyError } from "./policy.js";
import { ideMcpConnection } from "./ide-mcp.js";
import { abortable } from "./cancel.js";

// Explicitly named executable/script installation only. Never inspect project
// configuration or infer a workspace grant from Git metadata.
export async function mcpReadPaths(server: McpServer): Promise<string[]> {
  if (!("command" in server)) return [];
  const paths = new Set<string>();
  for (const value of [server.command, ...server.args]) {
    if (!isAbsolute(value) || paths.size >= 8) continue;
    if (!(await lstat(value).catch(() => undefined))?.isFile()) continue;
    let path = (await scopePaths([value]))[0]!;
    if (/\.[cm]?js$/.test(value)) {
      let parent = dirname(path);
      for (
        let i = 0;
        i < 8 && parent !== parse(parent).root && parent !== homedir();
        i++
      ) {
        if (
          (
            await lstat(join(parent, "package.json")).catch(() => undefined)
          )?.isFile()
        ) {
          path = (await scopePaths([parent]))[0]!;
          break;
        }
        parent = dirname(parent);
      }
    }
    paths.add(path);
  }
  return [...paths];
}
export type RemoteTool = {
  label: string;
  // Runs on this machine outside the agent's sandbox: a local HTTP/SSE server,
  // including the IDE bridge (terminal, run configurations). Like any unsandboxed
  // execution, each call needs its own approval; no session or remembered grant.
  unsandboxed: boolean;
  identity: unknown;
  definition: unknown;
  validate: ValidateFunction;
  call: (args: Record<string, unknown>, signal: AbortSignal) => Promise<string>;
};
export class Mcp {
  clients: Client[] = [];
  tools = new Map<string, RemoteTool>();
  async connect(
    servers: McpServer[],
    cwd: string,
    approve: (
      label: string,
      server: McpServer,
      readPaths: string[],
      source?: McpServer,
    ) => Promise<void>,
    signal: AbortSignal,
    sandbox: SandboxRun = {
      mode: "workspace",
      root: cwd,
      network: async () => false,
    },
  ) {
    let stage = "configuration validation";
    let serverNumber = 0;
    try {
      if (servers.length > 16 || JSON.stringify(servers).length > 64000)
        throw new Error("MCP configuration limit exceeded");
      for (const [i, source] of servers.entries()) {
        serverNumber = i + 1;
        stage = "configuration validation";
        const s = ideMcpConnection(source);
        if (!("command" in s)) endpoint(s.url, "");
        const readPaths = await mcpReadPaths(s);
        const label =
          "command" in s
            ? `MCP ${s.name}: ${s.command} ${JSON.stringify(s.args)}; cwd ${cwd}; explicit environment names: ${s.env.map((e) => e.name).join(", ")}`
            : `MCP ${s.name}: ${s.type} ${s.url}; authentication headers are redacted` +
              (s !== source && "command" in source
                ? `; direct IDE connection instead of stdioMcpServer; IDE project: ${source.env.find((e) => e.name === "IJ_MCP_SERVER_PROJECT_PATH")!.value}`
                : "");
        stage = "connection approval";
        await approve(
          label +
            (readPaths.length
              ? `; sandbox read access to explicit program installation: ${JSON.stringify(readPaths)}`
              : ""),
          s,
          readPaths,
          s !== source ? source : undefined,
        );
        signal.throwIfAborted();
        let transport;
        const connecting = new AbortController();
        if ("command" in s) {
          transport = new SandboxMcpTransport(
            s.command,
            s.args,
            {
              ...sandbox,
              readPaths,
              env: Object.fromEntries(s.env.map((e) => [e.name, e.value])),
            },
            signal,
          );
        } else {
          const url = new URL(s.url);
          const Transport =
            s.type === "sse"
              ? SSEClientTransport
              : StreamableHTTPClientTransport;
          transport = new Transport(url, {
            requestInit: {
              headers: Object.fromEntries(
                s.headers.map((h) => [h.name, h.value]),
              ),
              redirect: "error",
            },
            fetch: (input, init) => {
              const destination = new URL(
                input instanceof Request ? input.url : input,
              );
              if (
                destination.origin !== url.origin ||
                destination.username ||
                destination.password
              )
                throw new Error("MCP destination change refused");
              return fetch(input, {
                ...init,
                redirect: "error",
                signal: AbortSignal.any([
                  signal,
                  connecting.signal,
                  ...(init?.signal ? [init.signal] : []),
                ]),
              });
            },
          });
        }
        const client = new Client({
          name: "openwebui-acp-agent",
          version: "0.3.0",
        });
        this.clients.push(client);
        // SSE start() waits for an endpoint event before the SDK request timer
        // starts. Bound that phase too; close on errors to prevent SSE retries.
        if (!("command" in s) && s.type === "sse")
          client.onerror = () => {
            connecting.abort();
            void client.close().catch(() => {});
          };
        stage = "transport connection or initialization";
        const timer = setTimeout(() => connecting.abort(), 15000);
        try {
          await abortable(
            client.connect(transport, { timeout: 15000 }),
            AbortSignal.any([signal, connecting.signal]),
          );
        } finally {
          clearTimeout(timer);
        }
        signal.throwIfAborted();
        stage = "tool catalog or schema validation";
        const listed = await client.listTools({}, { signal, timeout: 15000 });
        if (listed.tools.length > 100 || listed.nextCursor)
          throw new Error("MCP tool catalog exceeds supported limit");
        for (const [j, t] of listed.tools.entries()) {
          if (JSON.stringify(t).length > 20000)
            throw new Error("MCP schema too large");
          const name = `mcp_${i}_${j}`;
          const validate = new Ajv({ strict: false }).compile(t.inputSchema);
          this.tools.set(name, {
            label: `${s.name}/${t.name}`,
            unsandboxed:
              !("command" in s) &&
              ["localhost", "127.0.0.1", "[::1]"].includes(
                new URL(s.url).hostname,
              ),
            identity: {
              server: s,
              ...(s !== source ? { source } : {}),
              tool: t,
              sandbox: sandbox.mode,
              readPaths,
              policyVersion: 1,
            },
            definition: {
              type: "function",
              function: {
                name,
                description: `Untrusted MCP ${s.name}/${t.name}: ${(t.description ?? "").slice(0, 2000)}`,
                parameters: t.inputSchema,
              },
            },
            validate,
            call: async (args, signal) => {
              const result = await client
                .callTool({ name: t.name, arguments: args }, undefined, {
                  signal,
                  timeout: 30000,
                })
                .catch(async () => {
                  // A timed-out local server must not keep pending network
                  // approvals alive. Remote servers still cancel cooperatively.
                  await client.close();
                  throw new Error(
                    "MCP call failed; connection closed without retry",
                  );
                });
              const text = JSON.stringify(result);
              if (text.length > 100000)
                throw new Error("MCP output limit exceeded");
              return text;
            },
          });
        }
      }
    } catch (error) {
      await this.close();
      signal.throwIfAborted();
      if (error instanceof PolicyError) throw error;
      throw new Error(
        `MCP server ${serverNumber || "configuration"} failed during ${stage}; check its transport, MCP credentials, reachability and schema. Local stdio servers also require sandbox dependencies and explicit program read scope.`,
      );
    }
  }
  async close() {
    await Promise.allSettled(this.clients.map((c) => c.close()));
    this.clients = [];
    this.tools.clear();
  }
}
