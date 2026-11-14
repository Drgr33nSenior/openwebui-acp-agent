import type { PermissionMode } from "./permissions.js";

// Session modes are a view over existing controls, not separate authority:
// Ask is the read-only permission mode, Plan is the planning workflow and Code
// keeps the selected permission policy. A mode can never widen permissions.
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
] as const;
export type SessionModeId = (typeof sessionModes)[number]["id"];

export function parseSessionMode(value: string): SessionModeId {
  const mode = sessionModes.find((m) => m.id === value);
  if (!mode) throw new Error("Unknown mode; choose ask, plan or code");
  return mode.id;
}

export function currentSessionMode(
  workflow: "code" | "plan",
  permissionMode: PermissionMode,
): SessionModeId {
  if (workflow === "plan") return "plan";
  return permissionMode === "read_only" ? "ask" : "code";
}

// Administrator permission-mode rules decide which views are reachable. Plan
// relies only on the workflow, so it is always available.
export function availableSessionModes(
  allowedPermissionModes: readonly PermissionMode[] | undefined,
) {
  return sessionModes.filter(
    (m) =>
      !allowedPermissionModes ||
      m.id === "plan" ||
      (m.id === "ask"
        ? allowedPermissionModes.includes("read_only")
        : codePermissionMode(undefined, allowedPermissionModes) !== undefined),
  );
}

// Code restores only a non-elevated choice the user made before Ask. Elevated
// modes need a fresh explicit selection, matching session restore behavior.
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
