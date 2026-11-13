import { z } from "zod";

export const planSchema = z
  .array(
    z
      .object({
        content: z
          .string()
          .min(1)
          .max(1000)
          .regex(/\S/, "Plan content must not be blank"),
        priority: z.enum(["high", "medium", "low"]),
        status: z.enum(["pending", "in_progress", "completed"]),
      })
      .strict(),
  )
  .max(32)
  .refine(
    (entries) =>
      entries.filter((entry) => entry.status === "in_progress").length <= 1,
    "Only one plan step may be in progress",
  );

export const planArgumentsSchema = z.object({ entries: planSchema }).strict();

export const planToolDefinition = {
  type: "function",
  function: {
    name: "update_plan",
    description:
      "Show progress for a multi-step task. Send the complete current plan, not a partial update; send an empty list to clear it. Keep at most one step in progress. Mark a step completed only after its work and required verification are done. Updating the plan does not execute actions or grant permission. Skip this tool for simple one-step requests.",
    parameters: z.toJSONSchema(planArgumentsSchema),
  },
};

export function planningInstruction(mode: "code" | "plan"): string {
  const progress =
    "For multi-step tasks, use update_plan to show the complete plan and update progress as work changes. Keep at most one step in_progress. Mark steps completed only when their work and required verification are done; never claim success for blocked, untested or merely proposed work. Skip plans for simple one-step requests. Plans are progress reports, not permission grants.";
  return mode === "plan"
    ? `Plan mode is active. Inspect and propose a plan; do not apply edits, run commands or call MCP/server tools. Only list_files, read_file, search_text and update_plan are available. Ask the user to switch to Code mode before implementation. ${progress}`
    : `Code mode is active. Inspect relevant code, implement the requested change and verify it using the available tools, subject to workspace, approval and sandbox policy. ${progress}`;
}
