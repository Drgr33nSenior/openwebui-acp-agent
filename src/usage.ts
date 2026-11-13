import { z } from "zod";

const tokens = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export const contextUsageSchema = z
  .object({
    used: tokens,
    size: tokens.positive(),
  })
  .strict();
export type ContextUsage = z.infer<typeof contextUsageSchema>;

// Prefer an explicit full window. Older catalogs expose only the usable input
// budget. Never sum input/output limits: scheduler reserves may be separate.
export function contextSize(model: unknown): number | undefined {
  const m = model as any;
  const result = tokens
    .positive()
    .safeParse(
      m?.context_window ??
        m?.openai?.context_window ??
        m?.max_input_tokens ??
        m?.openai?.max_input_tokens,
    );
  return result.success ? result.data : undefined;
}

export function completionContextTokens(usage: unknown): number | undefined {
  if (!usage || typeof usage !== "object") return undefined;
  const u = usage as Record<string, unknown>;
  // input_tokens/output_tokens/total_tokens may aggregate multiple server calls.
  // The context wheel must use the latest call, never cumulative billing usage.
  const prompt = tokens.safeParse(u.prompt_tokens ?? u.prompt_eval_count);
  const completion = tokens.safeParse(u.completion_tokens ?? u.eval_count ?? 0);
  if (!prompt.success || !completion.success) return undefined;
  const used = prompt.data + completion.data;
  return Number.isSafeInteger(used) ? used : undefined;
}
