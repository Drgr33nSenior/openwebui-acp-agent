import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { dirname, isAbsolute, parse } from "node:path";
import { createHash } from "node:crypto";
import { z } from "zod";
import { endpoint } from "./config.js";
import { RequestError, type McpServer } from "@agentclientprotocol/sdk";

// These messages are agent-authored and contain no policy values or credentials.
// Preserve them across ACP instead of the SDK's generic unknown-error response.
export class PolicyError extends RequestError {
  constructor(message: string) {
    const error = RequestError.invalidParams(undefined, message);
    super(error.code, error.message);
  }
}
export const policyPath =
  process.platform === "darwin"
    ? "/private/etc/openwebui-acp-agent/policy.json"
    : "/etc/openwebui-acp-agent/policy.json";
const urls = z
  .array(
    z
      .string()
      .max(2048)
      .transform((s) => endpoint(s, "")),
  )
  .max(64);
export const policySchema = z
  .object({
    version: z.literal(1),
    sandboxModes: z
      .array(z.enum(["workspace", "read_only", "full_access"]))
      .min(1)
      .max(3)
      .optional(),
    permissionModes: z
      .array(z.enum(["read_only", "ask", "scoped", "edits", "development"]))
      .min(1)
      .max(5)
      .optional(),
    inferenceUrls: urls.optional(),
    mcpHttpUrls: urls.optional(),
    allowStdioMcp: z.boolean().optional(),
    allowServerTools: z.boolean().optional(),
    allowScopeExpansion: z.boolean().optional(),
    networkDestinations: z
      .array(
        z
          .object({
            host: z
              .string()
              .min(1)
              .max(253)
              .regex(/^[a-zA-Z0-9.:[\]-]+$/)
              .transform((s) => s.toLowerCase()),
            port: z.number().int().min(1).max(65535),
          })
          .strict(),
      )
      .max(128)
      .optional(),
    alwaysAsk: z
      .array(z.enum(["edit", "command", "mcp-server", "mcp-tool", "network"]))
      .max(5)
      .optional(),
    reviewerModels: z.array(z.string().min(1).max(256)).max(64).optional(),
  })
  .strict()
  .refine(
    (p) => !p.sandboxModes || p.sandboxModes.some((m) => m !== "full_access"),
    "A sandboxed mode is required",
  )
  .refine(
    (p) =>
      !p.permissionModes ||
      p.permissionModes.some((m) => ["scoped", "ask", "read_only"].includes(m)),
    "A non-automatic permission mode is required",
  );
export type Policy = z.infer<typeof policySchema>;
export type PolicySnapshot = {
  rules: Policy;
  revision: string;
  managed: boolean;
};
export function snapshotPolicy(value?: unknown): PolicySnapshot {
  let rules: Policy;
  try {
    rules = policySchema.parse(value === undefined ? { version: 1 } : value);
  } catch {
    throw new PolicyError(
      "Invalid administrator policy; ask the administrator to validate policy.json",
    );
  }
  return {
    rules,
    managed: value !== undefined,
    revision: createHash("sha256")
      .update(JSON.stringify([value !== undefined, rules]))
      .digest("hex"),
  };
}

// Testable file reader; production always uses the fixed system path and uid 0.
// No environment, workspace or user configuration can select a policy source.
export async function readPolicyFile(
  path: string,
  owner = 0,
): Promise<PolicySnapshot> {
  if (!isAbsolute(path))
    throw new PolicyError("Administrator policy path must be absolute");
  try {
    for (let p = dirname(path); ; p = dirname(p)) {
      const st = await lstat(p).catch((e: NodeJS.ErrnoException) => {
        if (e.code === "ENOENT") return undefined;
        throw e;
      });
      if (
        st &&
        (!st.isDirectory() ||
          st.isSymbolicLink() ||
          st.uid !== owner ||
          st.mode & 0o022)
      )
        throw new PolicyError(
          "Administrator policy directory must be administrator-owned and not writable by other users",
        );
      if (p === parse(p).root) break;
    }
    const file = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const st = await file.stat();
      if (
        !st.isFile() ||
        st.uid !== owner ||
        st.mode & 0o022 ||
        st.size > 32768
      )
        throw new PolicyError(
          "Unsafe administrator policy file ownership, permissions, type or size",
        );
      const buffer = Buffer.alloc(32769);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
      if (bytesRead > 32768)
        throw new PolicyError("Administrator policy exceeds size limit");
      return snapshotPolicy(
        JSON.parse(buffer.subarray(0, bytesRead).toString("utf8")),
      );
    } finally {
      await file.close();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return snapshotPolicy();
    if (error instanceof PolicyError) throw error;
    throw new PolicyError(
      "Cannot safely read administrator policy; ask the administrator to inspect policy.json",
    );
  }
}
export const loadPolicy = () => readPolicyFile(policyPath);
export function enforceDestination(
  p: PolicySnapshot,
  kind: "inference" | "mcp",
  url: string,
) {
  const allowed =
    kind === "inference" ? p.rules.inferenceUrls : p.rules.mcpHttpUrls;
  if (allowed && !allowed.includes(endpoint(url, "")))
    throw new PolicyError(
      `Administrator policy denies this ${kind} destination`,
    );
}
export function enforceSandbox(
  p: PolicySnapshot,
  mode: string,
  expanded = false,
) {
  if (
    (p.rules.sandboxModes &&
      !p.rules.sandboxModes.some((value) => value === mode)) ||
    (mode === "full_access" && p.rules.networkDestinations !== undefined) ||
    (expanded && p.rules.allowScopeExpansion === false)
  )
    throw new PolicyError(
      "Administrator policy denies this sandbox mode or scope expansion",
    );
}
export function enforcePermissionMode(p: PolicySnapshot, mode: string) {
  if (
    p.rules.permissionModes &&
    !p.rules.permissionModes.some((value) => value === mode)
  )
    throw new PolicyError("Administrator policy denies this permission mode");
}
export function enforceMcp(p: PolicySnapshot, server: McpServer) {
  if ("command" in server) {
    if (p.rules.allowStdioMcp === false)
      throw new PolicyError("Administrator policy denies stdio MCP");
  } else enforceDestination(p, "mcp", server.url);
}
export function enforceNetwork(p: PolicySnapshot, host: string, port: number) {
  if (
    p.rules.networkDestinations &&
    !p.rules.networkDestinations.some(
      (d) => d.host === host.toLowerCase() && d.port === port,
    )
  )
    throw new PolicyError(
      "Administrator policy denies this sandbox network destination",
    );
}
