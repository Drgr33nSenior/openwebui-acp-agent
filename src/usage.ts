import { z } from "zod";

const tokens = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export const DEFAULT_OUTPUT_TOKEN_BUDGET = 12288;

// An explicit catalog allowance, never inferred from model names or context size.
// This guides reply size only; it does not override the server's request limits.
export function outputAllowance(model: unknown): number | undefined {
  const m = model as any;
  for (const value of [m?.max_output_tokens, m?.openai?.max_output_tokens]) {
    const parsed = tokens.positive().safeParse(value);
    if (parsed.success) return parsed.data;
  }
  return undefined;
}
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

// Input the server can accept for one request. An advertised max_input_tokens
// is that limit. Otherwise the full context_window is shared with the reply, so
// the output allowance is reserved: the catalog's explicit value or the
// configured outputTokenBudget, never a guess from the model name.
export function contextLimits(
  model: unknown,
  outputBudget: number,
): { size: number; usable: number } | undefined {
  const size = contextSize(model);
  if (size === undefined) return undefined;
  const m = model as any;
  const input = tokens
    .positive()
    .safeParse(m?.max_input_tokens ?? m?.openai?.max_input_tokens);
  if (input.success) return { size, usable: Math.min(size, input.data) };
  const reserve = outputAllowance(model) ?? outputBudget;
  // An allowance at or above the window describes no usable split; reserving
  // half keeps both sides possible rather than refusing every request.
  return {
    size,
    usable: reserve < size ? size - reserve : Math.ceil(size / 2),
  };
}

// Serialized request characters per reported prompt token, from the server's
// own count for the latest request. A floor stops an implausibly large count
// from forcing compaction; a small count (some servers omit cached input) only
// lowers the estimate, which leaves the reported-usage threshold in charge.
export function charsPerToken(
  requestChars: number,
  promptTokens: number,
): number | undefined {
  if (!(requestChars > 0) || !(promptTokens > 0)) return undefined;
  return Math.max(1.5, requestChars / promptTokens);
}

export function promptContextTokens(usage: unknown): number | undefined {
  if (!usage || typeof usage !== "object") return undefined;
  const u = usage as Record<string, unknown>;
  const prompt = tokens.safeParse(u.prompt_tokens ?? u.prompt_eval_count);
  return prompt.success ? prompt.data : undefined;
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
