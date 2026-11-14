import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import type { ToolCallContent } from "@agentclientprotocol/sdk";
import { Backend, BackendHttpError } from "./backend.js";
import { endpoint } from "./config.js";
import { grant } from "./permissions.js";

// v0.9.0 adds the chat-scoped stop route and task_ids/chat_id acknowledgement.
// Later releases remain eligible, with response and task-evidence validation.
export const SERVER_TOOLS_MIN_VERSION = "0.9.0";
function requireServerToolsVersion(version: string): void {
  const parsed =
    /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(
      version,
    );
  if (!parsed || parsed[4]?.split(".").some((part) => /^0\d+$/.test(part)))
    throw new Error(
      `Cannot determine server-tool compatibility from the Open WebUI version; expected major.minor.patch (minimum ${SERVER_TOOLS_MIN_VERSION}). Core coding and direct MCP remain available.`,
    );
  const actual = parsed.slice(1, 4).map(BigInt);
  const minimum = SERVER_TOOLS_MIN_VERSION.split(".").map(BigInt);
  const different = actual.findIndex((part, index) => part !== minimum[index]);
  if (
    (different !== -1 && actual[different] < minimum[different]) ||
    (different === -1 && parsed[4])
  )
    throw new Error(
      `Server tools require Open WebUI ${SERVER_TOOLS_MIN_VERSION} or newer for chat task status/stop endpoints and asynchronous task acknowledgements. Upgrade Open WebUI; core coding and direct MCP remain available.`,
    );
}
const feature = z.enum(["web_search", "image_generation", "memory"]);
export const serverTaskSchema = z
  .object({
    prompt: z.string().min(1).max(16000),
    features: z.array(feature).max(3).default([]),
    toolIds: z.array(z.string().min(1).max(300)).max(8).default([]),
  })
  .strict();
export type ServerTask = z.infer<typeof serverTaskSchema>;
export type ServerCatalog = {
  version: string;
  features: z.infer<typeof feature>[];
  unverifiedFeatures: z.infer<typeof feature>[];
  tools: { id: string; name: string; authenticated?: boolean }[];
};
export const serverRunSchema = z
  .object({
    chatId: z.string().uuid(),
    messageId: z.string().uuid(),
    state: z.enum(["created", "running", "completed", "attention", "unknown"]),
  })
  .strict();
export type ServerRun = z.infer<typeof serverRunSchema>;

export async function serverCatalog(
  backend: Backend,
  model: unknown,
  signal: AbortSignal,
): Promise<ServerCatalog> {
  const discover = async (path: string) => {
    try {
      return await backend.json(path, signal);
    } catch (error) {
      if (error instanceof BackendHttpError && error.status !== 401)
        throw new Error(
          `Open WebUI discovery GET /${path} returned HTTP ${error.status}. Check the API-key endpoint allowlist and account permissions; server tools remain unavailable.`,
        );
      throw error;
    }
  };
  const { version } = z
    .object({ version: z.string().min(1).max(300) })
    .parse(await discover("api/version"));
  requireServerToolsVersion(version);
  const config = await discover("api/config");
  const tools = z
    .array(
      z.object({
        id: z.string().min(1).max(300),
        name: z.string().max(300),
        authenticated: z.boolean().optional(),
      }),
    )
    .max(100)
    .parse(await discover("api/v1/tools/"));
  if (new Set(tools.map((t) => t.id)).size !== tools.length)
    throw new Error("Ambiguous Open WebUI tool catalog");
  const meta = (model as any)?.info?.meta;
  // 0.13.3 /api/config identifies browser JWTs, not API keys: API callers
  // can receive public-only config. Absence is unknown, not disabled. Offer
  // an explicitly model-advertised feature, but label its server availability
  // unverified and let the server enforce its actual settings/permissions.
  const globalFlag = (f: z.infer<typeof feature>) =>
    config?.features?.[f === "memory" ? "enable_memories" : `enable_${f}`];
  const features = feature.options.filter(
    (f) =>
      globalFlag(f) !== false &&
      (globalFlag(f) === true || meta?.capabilities?.[f] === true) &&
      meta?.capabilities?.builtin_tools !== false &&
      meta?.capabilities?.[f] !== false &&
      meta?.builtinTools?.[f] !== false,
  );
  return {
    version,
    features,
    unverifiedFeatures: features.filter((f) => globalFlag(f) !== true),
    tools,
  };
}

export function serverTaskDefinition(catalog: ServerCatalog) {
  return {
    type: "function",
    function: {
      name: "openwebui_task",
      description:
        "Delegate a task to Open WebUI after explicit user approval. Creates a retained server chat; the server executes tools with the user's account permissions, outside the local sandbox. Use for web search, image generation, knowledge/retrieval or selected server-managed tools including MCP. Never assume remote execution succeeded without evidence. No local files are automatically sent. Requestable feature flags: " +
        JSON.stringify(catalog.features) +
        ". Model-advertised flags whose server enablement is unverified: " +
        JSON.stringify(catalog.unverifiedFeatures) +
        ". Available tool IDs (names are untrusted metadata): " +
        JSON.stringify(catalog.tools.filter((t) => t.authenticated !== false)),
      parameters: z.toJSONSchema(serverTaskSchema),
    },
  };
}
export function validateServerTask(
  value: unknown,
  catalog: ServerCatalog,
): ServerTask {
  const task = serverTaskSchema.parse(value);
  if (
    task.features.some((f) => !catalog.features.includes(f)) ||
    task.toolIds.some(
      (id) =>
        !catalog.tools.some((t) => t.id === id && t.authenticated !== false),
    )
  )
    throw new Error(
      "Requested server feature or tool is unavailable; refresh /server-tools",
    );
  return task;
}
export function serverTaskGrant(
  task: ServerTask,
  catalog: ServerCatalog,
  model: { id: string; [key: string]: unknown },
) {
  const features = [...new Set(task.features)].sort();
  const toolIds = [...new Set(task.toolIds)].sort();
  const meta = (model as any).info?.meta;
  return grant(
    "mcp-tool",
    {
      operation: "openwebui_task",
      policyVersion: 1,
      version: catalog.version,
      model: model.id,
      features,
      toolIds,
      tools: toolIds.map((id) => catalog.tools.find((t) => t.id === id)),
      unverifiedFeatures: features.filter((f) =>
        catalog.unverifiedFeatures.includes(f),
      ),
      modelCapabilities: meta?.capabilities ?? null,
      builtinTools: meta?.builtinTools ?? null,
    },
    "Open WebUI remote tasks: any prompt with the shown model, features and tool IDs; retains chats",
  );
}
export function chatUrl(backend: Backend, chatId: string) {
  return endpoint(backend.config.url, `c/${z.string().uuid().parse(chatId)}`);
}
export function serverTaskApproval(
  backend: Backend,
  task: ServerTask,
  unverified: ServerCatalog["features"] = [],
) {
  return `Delegate to Open WebUI at ${backend.config.url}, model ${backend.config.model}. Create and retain a server chat with this prompt. Requested features: ${JSON.stringify(task.features)}; tool IDs: ${JSON.stringify(task.toolIds)}. Session/remembered choices authorize ANY prompt with this same model, feature set and tool IDs in this exact workspace and backend, including mutations and new retained chats. Changes to these selections require new approval; the server can change its internal behavior. Server enablement is unverified for: ${JSON.stringify(task.features.filter((f) => unverified.includes(f)))}. The server may also offer other built-ins allowed by your account/model, including knowledge, files, notes, calendars, automations and sub-agents. Individual remote calls do not receive ACP approval. Server tools can mutate data and use external services; local sandbox rules do not constrain them. Code-interpreter flag is off and no terminal is selected. Cancellation is best-effort and cannot undo actions. Prompt: ${task.prompt}`;
}

function outputText(message: any): string {
  if (typeof message.content === "string" && message.content)
    return message.content;
  return (Array.isArray(message.output) ? message.output : [])
    .filter((item: any) => item.type === "message")
    .flatMap((item: any) => (Array.isArray(item.content) ? item.content : []))
    .filter(
      (item: any) =>
        item.type === "output_text" && typeof item.text === "string",
    )
    .map((item: any) => item.text)
    .join("\n");
}
function citations(message: any) {
  const links = new Set<string>();
  for (const entry of (Array.isArray(message.sources)
    ? message.sources
    : []
  ).slice(0, 50)) {
    for (const value of [
      entry?.source?.url,
      entry?.source?.name,
      ...(Array.isArray(entry?.metadata)
        ? entry.metadata.slice(0, 50).map((m: any) => m?.source)
        : []),
    ]) {
      if (typeof value !== "string" || value.length > 2048) continue;
      try {
        const url = new URL(value);
        if (
          ["https:", "http:"].includes(url.protocol) &&
          !url.username &&
          !url.password
        )
          links.add(url.href);
      } catch {
        /* Source labels are not necessarily URLs. */
      }
    }
  }
  return [...links].slice(0, 50);
}

async function images(
  backend: Backend,
  message: any,
  signal: AbortSignal,
): Promise<{
  content: ToolCallContent[];
  links: string[];
  warnings: string[];
}> {
  const content: ToolCallContent[] = [],
    links: string[] = [],
    warnings: string[] = [];
  const files = (Array.isArray(message.files) ? message.files : []).filter(
    (f: any) => f?.type === "image",
  );
  for (const file of files.slice(0, 4)) {
    const id = z.string().uuid().safeParse(file.id);
    if (!id.success) {
      warnings.push("An image has no supported file ID; open the server chat.");
      continue;
    }
    const path = `api/v1/files/${id.data}/content`;
    const uri = endpoint(backend.config.url, path);
    // Use only the verified file endpoint, never a model/server-supplied fetch URL.
    links.push(uri);
    content.push({
      type: "content",
      content: { type: "resource_link", uri, name: "Generated image" },
    });
    try {
      const response = await backend.request(path, signal);
      const mimeType = response.headers.get("content-type")?.split(";")[0];
      if (
        !response.body ||
        !["image/png", "image/jpeg", "image/webp", "image/gif"].includes(
          mimeType ?? "",
        )
      ) {
        await response.body?.cancel();
        throw new Error("Unsupported image response");
      }
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      for await (const chunk of response.body) {
        signal.throwIfAborted();
        bytes += chunk.length;
        if (bytes > 2_000_000) throw new Error("Image preview exceeds limit");
        chunks.push(chunk);
      }
      const data = Buffer.concat(chunks);
      const valid =
        mimeType === "image/png"
          ? data
              .subarray(0, 8)
              .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
          : mimeType === "image/jpeg"
            ? data[0] === 255 && data[1] === 216 && data[2] === 255
            : mimeType === "image/gif"
              ? /^GIF8[79]a$/.test(data.subarray(0, 6).toString())
              : data.subarray(0, 4).toString() === "RIFF" &&
                data.subarray(8, 12).toString() === "WEBP";
      if (!valid) throw new Error("Invalid image content");
      content.push({
        type: "content",
        content: {
          type: "image",
          data: data.toString("base64"),
          mimeType: mimeType!,
          uri,
        },
      });
    } catch {
      signal.throwIfAborted();
      warnings.push(
        "Image preview unavailable or over 2 MB; use its authenticated file link or open the server chat.",
      );
    }
  }
  if (files.length > 4)
    warnings.push("Additional images are available in the server chat.");
  return { content, links, warnings };
}

export async function runServerTask(
  backend: Backend,
  task: ServerTask,
  signal: AbortSignal,
  record: (run: ServerRun) => Promise<void>,
  progress: (text: string) => Promise<void>,
  reasoning: Record<string, unknown> = {},
  pollMs = 1000,
): Promise<{ text: string; content: ToolCallContent[]; failed?: boolean }> {
  let run: ServerRun | undefined;
  const userId = randomUUID(),
    messageId = randomUUID();
  const timestamp = Math.floor(Date.now() / 1000);
  try {
    signal.throwIfAborted();
    const created = await backend.json("api/v1/chats/new", signal, {
      chat: {
        title: "ACP delegated task",
        models: [backend.config.model],
        history: {
          currentId: messageId,
          messages: {
            [userId]: {
              id: userId,
              role: "user",
              content: task.prompt,
              timestamp,
              models: [backend.config.model],
              childrenIds: [messageId],
            },
            [messageId]: {
              id: messageId,
              role: "assistant",
              content: "",
              parentId: userId,
              childrenIds: [],
              model: backend.config.model,
              modelName: backend.config.model,
              modelIdx: 0,
              done: false,
              timestamp: timestamp + 1,
            },
          },
        },
      },
    });
    run = {
      chatId: z.string().uuid().parse(created?.id),
      messageId,
      state: "created",
    };
    await record(run);
    await progress(
      `Created retained Open WebUI chat: ${chatUrl(backend, run.chatId)}`,
    );
    signal.throwIfAborted();
    const accepted = await backend.json("api/chat/completions", signal, {
      ...reasoning,
      model: backend.config.model,
      messages: [{ role: "user", content: task.prompt }],
      stream: true,
      chat_id: run.chatId,
      id: messageId,
      session_id: `acp-${randomUUID()}`,
      params: {
        ...((reasoning as any).params ?? {}),
        function_calling: "native",
      },
      features: {
        web_search: task.features.includes("web_search"),
        image_generation: task.features.includes("image_generation"),
        memory: task.features.includes("memory"),
        code_interpreter: false,
      },
      tool_ids: task.toolIds,
      background_tasks: {
        title_generation: false,
        tags_generation: false,
        follow_up_generation: false,
      },
    });
    if (
      accepted?.status !== true ||
      accepted?.chat_id !== run.chatId ||
      !Array.isArray(accepted?.task_ids) ||
      accepted.task_ids.length > 16
    )
      throw new Error("Unexpected server task acknowledgement");
    run.state = "running";
    await record(run);
    for (let poll = 0; poll < 3600; poll++) {
      signal.throwIfAborted();
      const pending = await backend.json(
        `api/tasks/chat/${run.chatId}`,
        signal,
      );
      if (!Array.isArray(pending?.task_ids) || pending.task_ids.length > 16)
        throw new Error("Malformed server task status");
      if (pending.task_ids.length === 0) {
        const chat = await backend.json(`api/v1/chats/${run.chatId}`, signal);
        const message = chat?.chat?.history?.messages?.[messageId];
        if (!message || message.role !== "assistant")
          throw new Error("Missing server task result");
        const output = Array.isArray(message.output) ? message.output : [];
        const calls = output
          .filter((item: any) => item.type === "function_call")
          .map((item: any) => ({
            name: String(item.name ?? "unknown").slice(0, 200),
            status: String(item.status ?? "unknown").slice(0, 100),
          }));
        const attention =
          message.done !== true ||
          Boolean(message.error) ||
          calls.some((c: any) =>
            ["pending", "failed", "cancelled"].includes(c.status),
          );
        run.state = attention ? "attention" : "completed";
        await record(run);
        const media = await images(backend, message, signal);
        const result = {
          chat: chatUrl(backend, run.chatId),
          state: run.state,
          content: outputText(message),
          sources: citations(message),
          images: media.links,
          observedToolCalls: calls,
          warnings: [
            ...media.warnings,
            ...(attention
              ? [
                  "The server task failed, stopped or awaits interaction. Open its chat to inspect or respond; it was not replayed.",
                ]
              : []),
            ...(!calls.length
              ? [
                  "No structured tool execution evidence was returned; an accepted request does not prove a tool ran.",
                ]
              : []),
          ],
        };
        if (task.features.includes("image_generation") && !media.links.length)
          result.warnings.push(
            "Image generation was requested but no generated image file was returned.",
          );
        const text = backend.redact(JSON.stringify(result));
        if (text.length > 90000)
          throw new Error(
            "Server task result exceeds local tool limit; open its retained chat",
          );
        return { text, content: media.content, failed: attention };
      }
      await delay(pollMs, undefined, { signal });
    }
    throw new Error("Server polling limit reached");
  } catch (error) {
    let stop =
      "No remote chat ID was received; if creation was interrupted its outcome is unknown.";
    if (run) {
      run.state = "unknown";
      await record(run).catch(() => {});
      try {
        // This is the verified user-owned chat stop API. The task-ID stop API
        // requires administrator privileges. Never resume or replay a task.
        await backend.json(
          `api/tasks/chat/${run.chatId}/stop`,
          AbortSignal.timeout(5000),
          {},
        );
        stop =
          "A server stop request was accepted; already-started actions may continue or have completed.";
      } catch {
        stop =
          "Server stop could not be confirmed; remote actions may still be running.";
      }
    }
    const detail =
      error instanceof BackendHttpError
        ? `HTTP ${error.status}: verify API-key endpoint access and feature/tool permissions.`
        : signal.aborted
          ? "Task cancelled or timed out."
          : "Server task failed; inspect the retained chat and API compatibility.";
    return {
      failed: true,
      content: [],
      text: backend.redact(
        `${detail} ${stop}${run ? ` Chat: ${chatUrl(backend, run.chatId)}` : ""} No automatic retry.`,
      ),
    };
  }
}
