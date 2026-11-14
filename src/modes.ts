import { permissionModes, type PermissionMode } from "./permissions.js";

// Session modes are a view over existing controls, not separate authority:
// Ask is the read-only permission mode, Plan is the planning workflow, Code
// keeps the selected permission policy and YOLO is Code with the yolo
// permission mode, which still needs its own confirmation before any effect.
export const sessionModes = [
  {
    id: "ask",
    name: "Ask",
    description:
      "Answer questions with file inspection only. Uses the Read only permission mode: no edits, commands, MCP processes/tools or server tasks.",
  },
  {
    id: "plan",
    name: "Plan",
    description:
      "Inspect files and maintain a plan. Edits, commands, MCP startup and server tasks are blocked.",
  },
  {
    id: "code",
    name: "Code",
    description:
      "Inspect, edit and verify under the selected Permissions and Sandbox settings.",
  },
  {
    id: "yolo",
    name: "YOLO",
    description:
      "Code with the YOLO — full access (session) permission mode. Asks for explicit confirmation at the next workspace prompt; after that, operations are approved automatically and commands and local MCP run without a sandbox. Not remembered; administrator rules still apply.",
  },
] as const;
export type SessionModeId = (typeof sessionModes)[number]["id"];

// Before the Mode selector existed, the Permissions option carried ACP
// category "mode". Clients such as JetBrains remember the last value per
// category and replay it onto new sessions, so permission-mode IDs are still
// accepted here. "ask" is both a mode and a permission-mode ID; it keeps its
// Mode meaning (Ask). An accepted ID never bypasses YOLO confirmation.
export function parseSessionMode(value: string): {
  mode: SessionModeId;
  permissionMode?: PermissionMode;
} {
  const mode = sessionModes.find((m) => m.id === value);
  if (mode) return { mode: mode.id };
  const legacy = permissionModes.find((m) => m.value === value)?.value;
  if (legacy === "read_only") return { mode: "ask" };
  if (legacy) return { mode: "code", permissionMode: legacy };
  throw new Error("Unknown mode; choose ask, plan, code or yolo");
}

export function currentSessionMode(
  workflow: "code" | "plan",
  permissionMode: PermissionMode,
): SessionModeId {
  if (workflow === "plan") return "plan";
  if (permissionMode === "yolo") return "yolo";
  return permissionMode === "read_only" ? "ask" : "code";
}

// Administrator permission-mode rules decide which views are reachable. Plan
// relies only on the workflow, so it is always available. YOLO also needs the
// administrator to allow unsandboxed (full_access) execution.
export function availableSessionModes(
  allowedPermissionModes: readonly PermissionMode[] | undefined,
  fullAccessAllowed: boolean,
) {
  return sessionModes.filter((m) =>
    m.id === "plan"
      ? true
      : m.id === "yolo"
        ? fullAccessAllowed &&
          (!allowedPermissionModes || allowedPermissionModes.includes("yolo"))
        : !allowedPermissionModes ||
          (m.id === "ask"
            ? allowedPermissionModes.includes("read_only")
            : codePermissionMode(undefined, allowedPermissionModes) !==
              undefined),
  );
}

// Code restores only a non-elevated choice the user made before Ask or YOLO.
// Elevated modes need a fresh explicit selection, matching session restore.
export function codePermissionMode(
  previous: PermissionMode | undefined,
  allowedPermissionModes: readonly PermissionMode[] | undefined,
): PermissionMode | undefined {
  const candidates = [
    ...(previous === "ask" || previous === "scoped" ? [previous] : []),
    "scoped",
    "ask",
  ] as const;
  return candidates.find(
    (m) => !allowedPermissionModes || allowedPermissionModes.includes(m),
  );
}
