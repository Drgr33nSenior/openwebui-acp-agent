import { endpoint, type Config } from "./config.js";
import { enforceDestination, loadPolicy } from "./policy.js";
import { completionContextTokens } from "./usage.js";
export type Message = {
  role: string;
  content: string | null;
  tool_calls?: Call[];
  tool_call_id?: string;
};
export type Call = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};
export const MAX = 1_000_000;
// Raw bytes on the wire are protocol overhead (a JSON envelope per streamed chunk,
// reasoning deltas, usage frames), not output. Response limits apply to the text and
// tool arguments a reply produces; this only bounds a runaway stream.
export const WIRE_MAX = 64 * MAX;
export const OUTPUT_LIMIT_NOTICE =
  "\n\n[Output limit reached before the reply finished; any unfinished tool call was not run. Ask to continue, or split the task.]";
function parseResponse(value: string): any {
  try {
    return JSON.parse(value);
  } catch {
    throw new Error("Malformed backend JSON");
  }
}
export class BackendHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
  }
}
// Only failed reply parsing is recoverable. Transport/auth/policy failures and
// resource limits must not trigger another inference request automatically.
export class ModelReplyError extends Error {
  constructor(
    readonly kind: "truncated" | "malformed",
    message: string,
  ) {
    super(message);
  }
}
// The server's own error code or message, from a small JSON error body only: an
// OpenAI-style {"error": {"code" | "message"}} or Open WebUI's {"detail"}. Raw
// non-JSON bodies are never echoed.
async function errorDetail(r: Response): Promise<string | undefined> {
  try {
    const text = await bounded(r, AbortSignal.timeout(5000), 16384);
    const body = JSON.parse(text);
    const error = body?.error;
    const value =
      (typeof error?.code === "string" && error.code) ||
      (typeof error?.message === "string" && error.message) ||
      (typeof error === "string" && error) ||
      (typeof body?.detail === "string" && body.detail) ||
      undefined;
    return value ? value.replace(/\s+/g, " ").slice(0, 200) : undefined;
  } catch {
    return undefined;
  }
}
function retryAfter(r: Response): number | undefined {
  const value = Number(r.headers.get("retry-after"));
  return Number.isFinite(value) && value >= 0 && value <= 86400
    ? value
    : undefined;
}
class StreamTimeout extends Error {}
export class Backend {
  private secrets: string[] = [];
  constructor(
    readonly config: Config,
    private secret: string,
    private policy = loadPolicy,
  ) {
    this.secrets = [secret];
  }
  addSecrets(values: string[]) {
    this.secrets.push(...values.filter(Boolean));
  }
  redact(value: string) {
    for (const secret of this.secrets)
      value = value.split(secret).join("[REDACTED]");
    return value;
  }
  async request(path: string, signal: AbortSignal, body?: unknown) {
    enforceDestination(await this.policy(), "inference", this.config.url);
    signal.throwIfAborted();
    let r: Response;
    try {
      r = await fetch(endpoint(this.config.url, path), {
        method: body ? "POST" : "GET",
        redirect: "error",
        signal,
        headers: {
          [this.config.header]:
            this.config.header.toLowerCase() === "authorization"
              ? "Bearer " + this.secret
              : this.secret,
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        body: body ? this.redact(JSON.stringify(body)) : undefined,
      });
    } catch {
      signal.throwIfAborted();
      throw new Error(
        "Connection failed: check URL, TLS/private CA and network; redirects are refused",
      );
    }
    if (!r.ok) {
      const detail = await errorDetail(r);
      await r.body?.cancel().catch(() => {});
      const wait = retryAfter(r);
      const base =
        (
          {
            401: "Authentication expired or invalid; login again",
            403: "Access denied; check API-key permissions",
            404: "Endpoint or model not found",
            429: "Rate limited; try later",
          } as Record<number, string>
        )[r.status] ?? `Backend failed (HTTP ${r.status})`;
      throw new BackendHttpError(
        r.status,
        base +
          (detail ? ": " + this.redact(detail) : "") +
          (wait !== undefined ? ` (retry after ${wait} s)` : ""),
        wait,
      );
    }
    return r;
  }
  async modelMetadata(signal: AbortSignal) {
    const r = await this.request("api/models", signal);
    const raw = parseResponse(await bounded(r, signal));
    if (
      !Array.isArray(raw.data) ||
      raw.data.some((x: any) => typeof x.id !== "string")
    )
      throw new Error("Malformed model list");
    return raw.data as Array<{ id: string; [key: string]: unknown }>;
  }
  async models(signal: AbortSignal) {
    return (await this.modelMetadata(signal)).map((m) => m.id);
  }
  async json(path: string, signal: AbortSignal, body?: unknown) {
    return parseResponse(
      this.redact(
        await bounded(await this.request(path, signal, body), signal),
      ),
    );
  }
  async complete(
    messages: Message[],
    tools: unknown[],
    signal: AbortSignal,
    onText: (s: string) => Promise<void>,
    extra: Record<string, unknown> = {},
    maxResponseChars = MAX,
    onUsage?: (used: number) => Promise<void>,
  ): Promise<Message> {
    if (JSON.stringify(messages).length > MAX)
      throw new Error(
        "Context budget exceeded; start a new session. History retained.",
      );
    // Per-request budgets, not one deadline for the whole turn: a long reply that
    // keeps streaming runs to completion; a silent one is ended with a clear reason.
    const watchdog = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const arm = (ms: number | undefined, message: string) => {
      clearTimeout(timer);
      timer =
        ms === undefined
          ? undefined
          : setTimeout(() => watchdog.abort(new StreamTimeout(message)), ms);
    };
    const firstMs = this.config.firstContentTimeoutMs;
    const idleMs = this.config.idleTimeoutMs;
    arm(
      firstMs,
      `No response from the model within ${Math.round(firstMs / 1000)} s; the server may be busy or the prompt very long. History retained.`,
    );
    const active = () =>
      arm(
        idleMs,
        `The model stream stalled for ${Math.round(idleMs / 1000)} s; the partial reply was not saved. History retained.`,
      );
    const request = AbortSignal.any([signal, watchdog.signal]);
    try {
      return await this.stream(
        messages,
        tools,
        request,
        onText,
        extra,
        maxResponseChars,
        onUsage,
        active,
        () => arm(undefined, ""),
      );
    } catch (e) {
      if (!signal.aborted && watchdog.signal.reason instanceof StreamTimeout)
        throw new Error(watchdog.signal.reason.message);
      if (
        (e as NodeJS.ErrnoException)?.code ===
        "ERR_ENCODING_INVALID_ENCODED_DATA"
      )
        throw new ModelReplyError(
          "malformed",
          "Malformed UTF-8 in model reply",
        );
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }
  private async stream(
    messages: Message[],
    tools: unknown[],
    signal: AbortSignal,
    onText: (s: string) => Promise<void>,
    extra: Record<string, unknown>,
    maxResponseChars: number,
    onUsage: ((used: number) => Promise<void>) | undefined,
    active: () => void,
    unbounded: () => void,
  ): Promise<Message> {
    const r = await this.request("api/chat/completions", signal, {
      model: this.config.model,
      messages,
      tools,
      stream: true,
      ...extra,
      ...(onUsage ? { stream_options: { include_usage: true } } : {}),
    });
    let content = "",
      pendingText = "";
    const tail = Math.max(1, ...this.secrets.map((s) => s.length)) - 1;
    const emit = async (value: string, final = false) => {
      pendingText = this.redact(pendingText + value);
      const count = final
        ? pendingText.length
        : Math.max(0, pendingText.length - tail);
      if (count) {
        await onText(pendingText.slice(0, count));
        pendingText = pendingText.slice(count);
      }
    };
    const calls = new Map<number, Call>();
    let finish: string | undefined;
    let used: number | undefined;
    let produced = 0;
    const count = (value: string) => {
      produced += value.length;
      if (produced > maxResponseChars)
        throw new Error("Response limit exceeded");
    };
    const consume = async (x: any, stream: boolean) => {
      if (!x || typeof x !== "object")
        throw new ModelReplyError("malformed", "Malformed completion");
      if (x.error)
        throw new Error(
          "Backend rejected completion" +
            (typeof x.error?.message === "string"
              ? ": " + this.redact(x.error.message).slice(0, 200)
              : "; check context size and function-calling support"),
        );
      const reported = completionContextTokens(x.usage);
      if (reported !== undefined) used = reported;
      if (Array.isArray(x.choices) && x.choices.length === 0 && x.usage) return;
      // Streamed events without choices (e.g. Open WebUI's {"sources": [...]}) carry
      // no completion data.
      if (stream && x.choices === undefined && !x.usage) return;
      const choice = x.choices?.[0];
      if (!choice)
        throw new ModelReplyError("malformed", "Malformed completion");
      const d = stream ? choice.delta : choice.message;
      if (!d || typeof d !== "object")
        throw new ModelReplyError("malformed", "Malformed completion delta");
      if (
        d.content ||
        d.reasoning_content ||
        d.reasoning ||
        d.tool_calls?.length ||
        choice.finish_reason
      )
        active();
      if (d.content != null) {
        if (typeof d.content !== "string")
          throw new ModelReplyError("malformed", "Malformed text");
        count(d.content);
        content += d.content;
        await emit(d.content);
      }
      if (d.tool_calls != null && !Array.isArray(d.tool_calls))
        throw new ModelReplyError("malformed", "Malformed tool calls");
      for (const [i, t] of (d.tool_calls ?? []).entries()) {
        if (
          !t ||
          typeof t !== "object" ||
          (t.id != null && typeof t.id !== "string") ||
          (t.function?.name != null && typeof t.function.name !== "string") ||
          (t.function?.arguments != null &&
            typeof t.function.arguments !== "string") ||
          (t.type != null && t.type !== "function")
        )
          throw new ModelReplyError("malformed", "Malformed tool call fields");
        const index = stream ? t.index : i;
        if (!Number.isInteger(index) || index < 0 || index > 63)
          throw new ModelReplyError("malformed", "Malformed tool index");
        const c = calls.get(index) ?? {
          id: "",
          type: "function",
          function: { name: "", arguments: "" },
        };
        c.id += t.id ?? "";
        c.function.name += t.function?.name ?? "";
        c.function.arguments += t.function?.arguments ?? "";
        count((t.function?.name ?? "") + (t.function?.arguments ?? ""));
        calls.set(index, c);
      }
      if (choice.finish_reason) finish = choice.finish_reason;
    };
    const parseCompletion = (data: string) => {
      try {
        return parseResponse(data);
      } catch {
        throw new ModelReplyError("malformed", "Malformed backend JSON");
      }
    };
    if (r.headers.get("content-type")?.includes("text/event-stream")) {
      let buffer = "",
        bytes = 0,
        done = false;
      const decoder = new TextDecoder("utf-8", { fatal: true });
      if (!r.body) throw new Error("Missing response");
      try {
        for await (const chunk of r.body) {
          signal.throwIfAborted();
          bytes += chunk.length;
          if (bytes > WIRE_MAX) throw new Error("Response limit exceeded");
          buffer += decoder.decode(chunk, { stream: true });
          buffer = buffer.replace(/\r\n/g, "\n");
          let end;
          while ((end = buffer.indexOf("\n\n")) >= 0) {
            const event = buffer.slice(0, end);
            buffer = buffer.slice(end + 2);
            const data = event
              .split("\n")
              .filter((l) => l.startsWith("data:"))
              .map((l) => l.slice(5).trimStart())
              .join("\n");
            if (!data) continue;
            if (data === "[DONE]") {
              done = true;
              continue;
            }
            await consume(parseCompletion(data), true);
          }
        }
        buffer += decoder.decode();
        if (!done && !finish)
          throw new ModelReplyError("truncated", "Truncated stream");
      } catch (e) {
        await r.body.cancel().catch(() => {});
        throw e;
      }
    } else {
      // A non-streamed reply sends nothing until it is complete: no budget can tell
      // a slow answer from a stalled one, so only the caller's signal bounds it.
      unbounded();
      await consume(parseCompletion(await bounded(r, signal, MAX)), false);
    }
    signal.throwIfAborted();
    if (used !== undefined) await onUsage?.(used);
    if (finish === "length") {
      // The coding loop may ask again once; never return a cut-short tool call.
      await emit("", true);
      throw new ModelReplyError(
        "truncated",
        "The model reply was cut off by its output limit",
      );
    }
    if (finish === "content_filter")
      throw new Error("Backend declined completion (content filter)");
    if (finish && !["stop", "tool_calls"].includes(finish))
      throw new ModelReplyError(
        "malformed",
        "Unsupported completion finish reason",
      );
    await emit("", true);
    const all = [...calls.values()];
    if (
      all.some((c) => !c.id || !c.function.name) ||
      new Set(all.map((c) => c.id)).size !== all.length
    )
      throw new ModelReplyError("malformed", "Malformed tool calls");
    return {
      role: "assistant",
      content: this.redact(content),
      ...(all.length ? { tool_calls: all } : {}),
    };
  }
}
export async function bounded(r: Response, signal: AbortSignal, limit = MAX) {
  let result = "",
    bytes = 0;
  const d = new TextDecoder("utf-8", { fatal: true });
  if (!r.body) throw new Error("Missing response");
  for await (const c of r.body) {
    signal.throwIfAborted();
    bytes += c.length;
    if (bytes > limit) throw new Error("Response limit exceeded");
    result += d.decode(c, { stream: true });
  }
  return result + d.decode();
}
