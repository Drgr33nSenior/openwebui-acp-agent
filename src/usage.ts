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
// replyCap is the max_tokens the request itself carries (see replyTokenCap):
// that much of the window is reserved for the reply whatever else is advertised.
export function contextLimits(
  model: unknown,
  outputBudget: number,
  replyCap?: number,
): { size: number; usable: number } | undefined {
  const size = contextSize(model);
  if (size === undefined) return undefined;
  const capped = (usable: number) => ({
    size,
    usable:
      replyCap !== undefined && replyCap < size
        ? Math.min(usable, size - replyCap)
        : usable,
  });
  const m = model as any;
  const input = tokens
    .positive()
    .safeParse(m?.max_input_tokens ?? m?.openai?.max_input_tokens);
  if (input.success) return capped(Math.min(size, input.data));
  const reserve = outputAllowance(model) ?? outputBudget;
  // An allowance at or above the window describes no usable split; reserving
  // half keeps both sides possible rather than refusing every request.
  return capped(reserve < size ? size - reserve : Math.ceil(size / 2));
}

// An explicit output limit the catalog declares for one reasoning_effort level:
// maxOutputTokens on that level's supportedReasoningEfforts entry, the largest
// max_tokens the server accepts at that level. Never inferred.
export function effortOutputAllowance(
  model: unknown,
  effort: string,
): number | undefined {
  const m = model as any;
  for (const levels of [
    m?.supportedReasoningEfforts,
    m?.openai?.supportedReasoningEfforts,
  ]) {
    if (!Array.isArray(levels)) continue;
    const level = levels.find((l) => l?.reasoningEffort === effort);
    const parsed = tokens.positive().safeParse(level?.maxOutputTokens);
    if (parsed.success) return parsed.data;
  }
  return undefined;
}

// Output cap the agent sends itself at the "xhigh" reasoning_effort level.
// Other levels send none and keep the server's own cap (the advertised
// max_output_tokens). A server that leaves xhigh uncapped lets one reply think
// until the context window is full, holding the model for many minutes and
// leaving no room the input was sized against.
//
// 32,768 tokens is 2.67 times the default allowance, so long thinking is not
// routinely cut short, and bounds one reply to about a third of a 100k window.
// It is a fixed figure, not a measured percentile: no distribution of xhigh
// reply sizes has been recorded yet.
export const XHIGH_OUTPUT_TOKENS = 32768;
const CAPPED_EFFORT = "xhigh";

// The cap for one coding request, or undefined to send none. It needs the
// declared reasoning_effort level and an explicit context_window: a cap is
// never guessed from a model name, and never set where the window it must fit
// is unknown. The level's own advertised limit comes first (reasoning shares
// the cap, so the general allowance can be too small for xhigh thinking). A
// server that advertises none may still refuse more than its general output
// limit, which then bounds the request; otherwise use the fixed fallback.
// Half the window remains available for input.
export function replyTokenCap(
  effort: string | undefined,
  model: unknown,
): number | undefined {
  if (effort !== CAPPED_EFFORT) return undefined;
  const m = model as any;
  const window = tokens
    .positive()
    .safeParse(m?.context_window ?? m?.openai?.context_window);
  if (!window.success) return undefined;
  return Math.max(
    1,
    Math.min(
      effortOutputAllowance(model, CAPPED_EFFORT) ??
        outputAllowance(model) ??
        XHIGH_OUTPUT_TOKENS,
      Math.floor(window.data / 2),
    ),
  );
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

// Context the conversation occupies after this call: its prompt plus the
// visible reply, plus reasoning only when the provider declares replay.
// The server's own reasoning_tokens count is used when reported. Otherwise the
// completion is split by the characters received as reasoning and as visible
// output (text and tool calls); with neither, the whole completion counts.
export function completionContextTokens(
  usage: unknown,
  visibleChars = 0,
  reasoningChars = 0,
  replayReasoning = false,
): number | undefined {
  if (!usage || typeof usage !== "object") return undefined;
  const u = usage as Record<string, unknown>;
  // input_tokens/output_tokens/total_tokens may aggregate multiple server calls.
  // The context wheel must use the latest call, never cumulative billing usage.
  const prompt = tokens.safeParse(u.prompt_tokens ?? u.prompt_eval_count);
  const completion = tokens.safeParse(u.completion_tokens ?? u.eval_count ?? 0);
  if (!prompt.success || !completion.success) return undefined;
  const reported = tokens.safeParse(
    (u.completion_tokens_details as Record<string, unknown> | null | undefined)
      ?.reasoning_tokens,
  );
  const reasoning =
    reported.success && reported.data <= completion.data
      ? reported.data
      : reasoningChars > 0
        ? Math.floor(
            (completion.data * reasoningChars) /
              (reasoningChars + Math.max(0, visibleChars)),
          )
        : 0;
  const used =
    prompt.data + completion.data - (replayReasoning ? 0 : reasoning);
  return Number.isSafeInteger(used) ? used : undefined;
}
