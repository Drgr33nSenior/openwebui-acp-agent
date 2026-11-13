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
import { mcpOptions, type McpOptions } from "./user-mcp.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";

// Bound data before the SDK's response.json()/SSE parser allocates a message.
// SSE is capped per event, not over the lifetime of the notification stream.
export function boundedMcpResponse(
  response: Response,
  maxFrameBytes: number,
  failed: () => void,
): Response {
  if (!response.body) return response;
  const eventStream =
    response.headers
      .get("content-type")
      ?.split(";")[0]
      ?.trim()
      .toLowerCase() === "text/event-stream";
  let bytes = 0,
    lineBytes = 0,
    wasCR = false;
  const tooLarge = () => {
    failed();
    throw new Error("MCP response frame exceeds its configured limit");
  };
  const body = response.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        if (!eventStream) {
          bytes += chunk.byteLength;
          if (bytes > maxFrameBytes) tooLarge();
        } else {
          for (const byte of chunk) {
            if (++bytes > maxFrameBytes) tooLarge();
            if (byte === 10 && wasCR) {
              wasCR = false;
              continue;
            }
            if (byte === 10 || byte === 13) {
              if (lineBytes === 0) bytes = 0;
              lineBytes = 0;
              wasCR = byte === 13;
            } else {
              lineBytes++;
              wasCR = false;
            }
          }
        }
        controller.enqueue(chunk);
      },
    }),
  );
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

function withoutImages(value: unknown, depth = 0): unknown {
  if (depth > 32) return undefined;
  if (Array.isArray(value))
    return value
      .map((part) => withoutImages(part, depth + 1))
      .filter((part) => part !== undefined);
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    if (
      object.type === "image" ||
      (typeof object.mimeType === "string" &&
        object.mimeType.startsWith("image/") &&
        ("data" in object || "blob" in object))
    )
      return undefined;
    return Object.fromEntries(
      Object.entries(object)
        .map(([key, part]) => [key, withoutImages(part, depth + 1)])
        .filter(([, part]) => part !== undefined),
    );
  }
  return value;
}

export function mcpOutput(result: unknown, options?: McpOptions): string {
  const output = options?.stripImages ? withoutImages(result) : result;
  const text = JSON.stringify(output) ?? "{}";
  if (!options) {
    if (text.length > 100000) throw new Error("MCP output limit exceeded");
    return text;
  }
  if (text.length <= options.maxOutputChars) return text;
  const marker = options.includeTools.includes("browser_find")
    ? "\n…truncated; use browser_find to locate elements"
    : "\n…truncated; request a smaller result";
  const status =
    result &&
    typeof result === "object" &&
    "isError" in result &&
    result.isError
      ? "MCP tool returned an error. "
      : "";
  return (
    status +
    text.slice(0, options.maxOutputChars - marker.length - status.length) +
    marker
  );
}

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
  forceOnce: boolean;
  identity: unknown;
  definition: unknown;
  validate: ValidateFunction;
  call: (args: Record<string, unknown>, signal: AbortSignal) => Promise<string>;
};
export class Mcp {
  clients: Client[] = [];
  tools = new Map<string, RemoteTool>();
  private cleanup = new Map<Client, () => Promise<void>>();
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
        const options = mcpOptions(source);
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
            (options
              ? `; explicit tool allowlist: ${options.includeTools.join(", ") || "none"}; per-call approval: ${options.alwaysApproveTools.join(", ") || "configured scoped policy"}`
              : "") +
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
        const client = new Client({
          name: "openwebui-acp-agent",
          version: "0.3.0",
        });
        let failed = false;
        let cleanupSignal: AbortSignal | undefined;
        const fail = () => {
          if (failed) return;
          failed = true;
          connecting.abort();
          void dispose();
        };
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
            options?.maxFrameBytes,
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
            fetch: async (input, init) => {
              const terminating = cleanupSignal && init?.method === "DELETE";
              if (failed && !terminating)
                throw new Error("MCP connection closed");
              const destination = new URL(
                input instanceof Request ? input.url : input,
              );
              if (
                destination.origin !== url.origin ||
                destination.username ||
                destination.password
              )
                throw new Error("MCP destination change refused");
              const limit = options?.maxFrameBytes ?? 2100000;
              if (
                typeof init?.body === "string" &&
                Buffer.byteLength(init.body) > limit
              ) {
                fail();
                throw new Error("MCP request exceeds its configured limit");
              }
              const response = await fetch(input, {
                ...init,
                redirect: "error",
                signal: AbortSignal.any([
                  ...(terminating
                    ? [cleanupSignal!]
                    : [
                        signal,
                        connecting.signal,
                        ...(init?.signal ? [init.signal] : []),
                      ]),
                ]),
              });
              return boundedMcpResponse(response, limit, fail);
            },
          });
        }
        let disposing: Promise<void> | undefined;
        const dispose = () => {
          disposing ??= (async () => {
            failed = true;
            // close() alone abandons the remote browser session. DELETE only
            // this client's owned session, even after turn cancellation, using
            // a separate bounded signal that cannot resume normal requests.
            if (options && transport instanceof StreamableHTTPClientTransport) {
              cleanupSignal = AbortSignal.timeout(1000);
              try {
                await abortable(transport.terminateSession(), cleanupSignal);
              } catch {
                /* Best effort only; never retry a remote mutation. */
              }
            }
            connecting.abort();
            await client.close().catch(() => {});
          })();
          return disposing;
        };
        this.clients.push(client);
        this.cleanup.set(client, dispose);
        // SSE start() waits for an endpoint event before the SDK request timer
        // starts. Bound that phase too; close on errors to prevent SSE retries.
        if (!("command" in s)) client.onerror = fail;
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
          if (options && !options.includeTools.includes(t.name)) continue;
          if (JSON.stringify(t).length > 20000)
            throw new Error("MCP schema too large");
          const name = `mcp_${i}_${j}`;
          const schema = structuredClone(t.inputSchema);
          if (options?.rejectFileOutput) {
            if (schema.required?.includes("filename"))
              throw new Error(
                "Allowed MCP tool requires forbidden file output",
              );
            if (schema.properties) delete schema.properties.filename;
            schema.allOf = [
              ...(Array.isArray(schema.allOf) ? schema.allOf : []),
              { not: { required: ["filename"] } },
            ];
          }
          const validate = new Ajv({ strict: false }).compile(schema);
          this.tools.set(name, {
            label: `${s.name}/${t.name}`,
            unsandboxed:
              !("command" in s) &&
              ["localhost", "127.0.0.1", "[::1]"].includes(
                new URL(s.url).hostname,
              ),
            forceOnce: options?.alwaysApproveTools.includes(t.name) ?? false,
            identity: {
              server: s,
              ...(s !== source ? { source } : {}),
              tool: t,
              sandbox: sandbox.mode,
              readPaths,
              policyVersion: 1,
              ...(options ? { options } : {}),
            },
            definition: {
              type: "function",
              function: {
                name,
                description: `Untrusted MCP ${s.name}/${t.name}: ${(t.description ?? "").slice(0, 2000)}`,
                parameters: schema,
              },
            },
            validate,
            call: async (args, signal) => {
              if (!validate(args))
                throw new Error("MCP arguments do not match schema");
              if (failed)
                throw new Error(
                  "MCP call failed; connection closed without retry",
                );
              const result = await client
                .callTool({ name: t.name, arguments: args }, undefined, {
                  signal,
                  timeout: options?.callTimeoutMs ?? 30000,
                })
                .catch(async (error) => {
                  // A responsive HTTP server may retain browser state after
                  // cooperative cancellation. This proves responsiveness only,
                  // not that the timed-out operation had no side effects.
                  if (
                    options &&
                    !("command" in s) &&
                    s.type === "http" &&
                    !signal.aborted &&
                    !failed &&
                    error instanceof McpError &&
                    error.code === ErrorCode.RequestTimeout
                  ) {
                    try {
                      await client.ping({ signal, timeout: 1000 });
                    } catch {
                      fail();
                    }
                    if (!failed && !signal.aborted)
                      throw new Error(
                        "MCP call timed out; server responds to ping and connection retained. Cancellation is cooperative; inspect browser state before another action. No automatic retry.",
                      );
                  }
                  // A timed-out local server must not keep pending network
                  // approvals alive. Remote servers still cancel cooperatively.
                  fail();
                  await dispose();
                  throw new Error(
                    "MCP call failed; connection closed without retry",
                  );
                });
              return mcpOutput(result, options);
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
    await Promise.allSettled(
      this.clients.map((c) => this.cleanup.get(c)?.() ?? c.close()),
    );
    this.clients = [];
    this.tools.clear();
    this.cleanup.clear();
  }
}
