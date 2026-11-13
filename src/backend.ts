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
  ) {
    super(message);
  }
}
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
      await r.body?.cancel();
      throw new BackendHttpError(
        r.status,
        (
          {
            401: "Authentication expired or invalid; login again",
            403: "Access denied; check API-key permissions",
            404: "Endpoint or model not found",
            429: "Rate limited; try later",
          } as Record<number, string>
        )[r.status] ?? `Backend failed (HTTP ${r.status})`,
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
    maxResponseBytes = MAX,
    onUsage?: (used: number) => Promise<void>,
  ): Promise<Message> {
    if (JSON.stringify(messages).length > MAX)
      throw new Error(
        "Context budget exceeded; start a new session. History retained.",
      );
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
    const consume = async (x: any, stream: boolean) => {
      if (x.error)
        throw new Error(
          "Backend rejected completion; check context size and function-calling support",
        );
      const reported = completionContextTokens(x.usage);
      if (reported !== undefined) used = reported;
      if (Array.isArray(x.choices) && x.choices.length === 0 && x.usage) return;
      const choice = x.choices?.[0];
      if (!choice) throw new Error("Malformed completion");
      const d = stream ? choice.delta : choice.message;
      if (!d) throw new Error("Malformed completion delta");
      if (d.content != null) {
        if (typeof d.content !== "string") throw new Error("Malformed text");
        content += d.content;
        await emit(d.content);
      }
      for (const [i, t] of (d.tool_calls ?? []).entries()) {
        const index = stream ? t.index : i;
        if (!Number.isInteger(index) || index < 0 || index > 63)
          throw new Error("Malformed tool index");
        const c = calls.get(index) ?? {
          id: "",
          type: "function",
          function: { name: "", arguments: "" },
        };
        c.id += t.id ?? "";
        c.function.name += t.function?.name ?? "";
        c.function.arguments += t.function?.arguments ?? "";
        calls.set(index, c);
      }
      if (choice.finish_reason) finish = choice.finish_reason;
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
          if (bytes > maxResponseBytes)
            throw new Error("Response limit exceeded");
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
            await consume(parseResponse(data), true);
          }
        }
        buffer += decoder.decode();
        if (!done && !finish) throw new Error("Truncated stream");
      } catch (e) {
        await r.body.cancel().catch(() => {});
        throw e;
      }
    } else
      await consume(
        parseResponse(await bounded(r, signal, maxResponseBytes)),
        false,
      );
    signal.throwIfAborted();
    if (used !== undefined) await onUsage?.(used);
    if (finish === "length")
      throw new Error(
        "Context or response limit reached; history retained, no pending tools executed",
      );
    if (finish && !["stop", "tool_calls"].includes(finish))
      throw new Error("Unsupported completion finish reason");
    await emit("", true);
    const all = [...calls.values()];
    if (
      all.some((c) => !c.id || !c.function.name) ||
      new Set(all.map((c) => c.id)).size !== all.length
    )
      throw new Error("Malformed tool calls");
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
