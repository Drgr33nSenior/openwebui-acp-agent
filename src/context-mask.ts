import { z } from "zod";
import type { Call, Message } from "./backend.js";

// A cheaper tier than compaction: older tool observations are replaced by
// short stubs in what the model is sent. The transcript itself is unchanged.
//
// Everything here is a pure function of (transcript, mask, failed calls). The
// mask records three transcript indexes. Decisions that depend on later
// messages (a read superseded by a later read, a read of a file edited later)
// only look at messages before `seen`, the transcript length when the mask was
// last moved. The masked prompt is therefore identical on every later round
// and after a save and reload, and only changes when a new batch moves the
// mask. That keeps the server's prompt prefix cache valid between batches.
const index = z.number().int().min(0).max(1_000_000);
export const contextMaskSchema = z
  .object({
    // Tool results before this index are cleared unless protected.
    masked: index.default(0),
    // Recorded write/edit arguments and superseded reads before this index
    // are elided. Never behind `masked`.
    elided: index.default(0),
    // Transcript length when the mask was decided.
    seen: index.default(0),
  })
  .strict()
  .refine((m) => m.masked <= m.elided && m.elided <= m.seen, {
    message: "Invalid context mask",
  });
export type ContextMask = z.infer<typeof contextMaskSchema>;
export const NO_MASK: ContextMask = { masked: 0, elided: 0, seen: 0 };

// Share of the usable input at which a batch starts, and the share it clears
// down to. One batch re-prefills the prompt once; between batches the prefix
// is stable, so masking must reclaim enough to stay quiet for many rounds.
export const MASK_TRIGGER = 0.55;
export const MASK_TARGET = 0.3;
// The most recent tool results are kept: the lesser of 40,000 tokens (the
// figure opencode protects) and 15% of the usable input, which is half the
// target on a small window. The latest two tool groups are kept whatever
// their size: the model is still acting on them.
export const PROTECT_TOKENS = 40_000;
export const PROTECT_SHARE = 0.15;
export const PROTECT_GROUPS = 2;
// A batch that cannot reclaim this much is not worth a re-prefill (opencode
// uses 20,000 tokens); the lesser of that and 10% of the usable input.
export const MIN_RECLAIM_TOKENS = 20_000;
export const MIN_RECLAIM_SHARE = 0.1;
// Results at or below this size stay: a stub would save little, and short
// results carry outcomes (checkpoint ids, denials, exit states).
export const RESULT_MIN_CHARS = 600;
// Failed and declined results explain what the model did next; they stay
// unless they are large command output.
export const FAILED_KEEP_CHARS = 2000;
// Shorter write/edit argument values stay verbatim, so a kept read plus the
// small edits that followed still describe the file.
export const ARGUMENT_MIN_CHARS = 200;

const WRITE_TOOLS = new Set(["write_file", "edit_file"]);
const READ_TOOL = "read_file";
const ELIDED_FIELDS = [
  "before",
  "after",
  "content",
  "old_string",
  "new_string",
];
const ELIDED_PREFIX = "[elided from context: ";
// A placeholder must never be written to a file as if it were content. The
// prefix is unchanged across versions, so older stubs are still recognized.
export const isElidedPlaceholder = (value: unknown) =>
  typeof value === "string" && value.startsWith(ELIDED_PREFIX);

export function clampMask(mask: ContextMask, length: number): ContextMask {
  return mask.seen <= length
    ? mask
    : {
        masked: Math.min(mask.masked, length),
        elided: Math.min(mask.elided, length),
        seen: length,
      };
}

type Observation = {
  call: Call;
  args: Record<string, unknown> | undefined;
  failed: boolean;
};

function parseArguments(call: Call) {
  try {
    const value: unknown = JSON.parse(call.function.arguments);
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

const filePath = (args: Record<string, unknown> | undefined) =>
  typeof args?.path === "string" ? args.path.replace(/^\.\//, "") : undefined;

// The same file and the same range: any other argument (an offset, a limit)
// makes it a different observation.
const readKey = (args: Record<string, unknown>) =>
  JSON.stringify(
    Object.keys(args)
      .sort()
      .map((key) => [key, key === "path" ? filePath(args) : args[key]]),
  );

// What each tool result before `seen` answers, which calls have a recorded
// result, the latest read per file range and the latest applied edit per file.
function describe(
  messages: Message[],
  seen: number,
  failed: ReadonlySet<string>,
) {
  const observations = new Map<number, Observation>();
  const answered = new Set<Call>();
  const latestRead = new Map<string, number>();
  const latestEdit = new Map<string, number>();
  let open = new Map<string, Call>();
  for (let i = 0; i < seen; i++) {
    const m = messages[i]!;
    if (m.role !== "tool") {
      // Call ids can repeat between rounds; a result belongs to the nearest
      // preceding assistant message.
      open = new Map((m.tool_calls ?? []).map((c) => [c.id, c]));
      continue;
    }
    const call = m.tool_call_id ? open.get(m.tool_call_id) : undefined;
    if (!call) continue;
    const observation = {
      call,
      args: parseArguments(call),
      failed: failed.has(call.id),
    };
    observations.set(i, observation);
    answered.add(call);
    const path = filePath(observation.args);
    if (observation.failed || path === undefined) continue;
    if (call.function.name === READ_TOOL)
      latestRead.set(readKey(observation.args!), i);
    else if (WRITE_TOOLS.has(call.function.name)) latestEdit.set(path, i);
  }
  return { observations, answered, latestRead, latestEdit };
}

const short = (text: string, max: number) =>
  text.length > max ? text.slice(0, max) + "…" : text;

// Enough of the arguments to repeat the call: every key, long values cut.
// Generic on purpose, so it holds for any tool and any future argument.
function keyArguments({ call, args }: Observation) {
  if (!args) return short(call.function.arguments, 120);
  return short(
    JSON.stringify(
      Object.fromEntries(
        Object.entries(args).map(([key, value]) => [
          key,
          typeof value === "string"
            ? short(value, 80)
            : typeof value === "object" && value !== null
              ? short(JSON.stringify(value), 120)
              : value,
        ]),
      ),
    ),
    300,
  );
}

function clearedStub(o: Observation, content: string, superseded: boolean) {
  return `[cleared from context: ${o.call.function.name} ${keyArguments(o)} ${o.failed ? "failed with" : "returned"} ${content.length} chars; ${superseded ? "a later read of the same file follows" : "re-run to see it again"}]`;
}

function elideArguments(call: Call): Call {
  const args = parseArguments(call);
  if (!args) return call;
  let changed = false;
  for (const field of ELIDED_FIELDS) {
    const value = args[field];
    if (typeof value !== "string" || value.length <= ARGUMENT_MIN_CHARS)
      continue;
    args[field] =
      `${ELIDED_PREFIX}${value.length} chars; not file text; never copy this into a tool call; read the file to see it]`;
    changed = true;
  }
  return changed
    ? {
        ...call,
        function: { ...call.function, arguments: JSON.stringify(args) },
      }
    : call;
}

type Level = "elided" | "masked";

// The form message `i` takes at each level; the message itself when unchanged.
function forms(
  messages: Message[],
  { masked, seen }: ContextMask,
  failed: ReadonlySet<string>,
) {
  const { observations, answered, latestRead, latestEdit } = describe(
    messages,
    seen,
    failed,
  );
  return (i: number, level: Level): Message => {
    const m = messages[i]!;
    if (m.tool_calls?.length) {
      const calls = m.tool_calls.map((call) =>
        WRITE_TOOLS.has(call.function.name) && answered.has(call)
          ? elideArguments(call)
          : call,
      );
      return calls.some((call, n) => call !== m.tool_calls![n])
        ? { ...m, tool_calls: calls }
        : m;
    }
    const o = observations.get(i);
    if (!o || m.role !== "tool" || typeof m.content !== "string") return m;
    if (m.content.length <= RESULT_MIN_CHARS) return m;
    const stub = (superseded: boolean) => {
      const content = clearedStub(o, m.content!, superseded);
      return content.length < m.content!.length ? { ...m, content } : m;
    };
    const path = filePath(o.args);
    const reads = !o.failed && o.call.function.name === READ_TOOL;
    if (reads && path !== undefined && o.args) {
      // An identical read happened later: this one adds nothing.
      if (latestRead.get(readKey(o.args))! > i) return stub(true);
      // The read an applied edit was based on stays while that edit is itself
      // still in context. Once the edit is behind the boundary the work on
      // that file is old, and keeping its read would pin one whole file per
      // edited file for the rest of the session.
      const edit = latestEdit.get(path) ?? -1;
      if (edit > i && edit >= masked) return m;
    }
    if (level === "elided") return m;
    if (o.failed && m.content.length <= FAILED_KEEP_CHARS) return m;
    return stub(false);
  };
}

// What the model is sent in place of the transcript: the same messages in the
// same order with the same roles, calls and ids, so compaction indexes and
// tool pairing are unaffected. Only tool-result text and recorded write/edit
// arguments change. User and plain assistant messages are never touched.
export function applyMask(
  messages: Message[],
  mask: ContextMask,
  failed: ReadonlySet<string>,
): Message[] {
  const clamped = clampMask(mask, messages.length);
  const { masked, elided } = clamped;
  if (!elided) return messages.slice();
  const form = forms(messages, clamped, failed);
  return messages.map((m, i) =>
    i < masked ? form(i, "masked") : i < elided ? form(i, "elided") : m,
  );
}

// Serialized sizes of transcript messages; they never change once recorded.
const sizes = new WeakMap<Message, number>();
function size(m: Message) {
  let value = sizes.get(m);
  if (value === undefined) sizes.set(m, (value = JSON.stringify(m).length));
  return value;
}

// Where the protected tail begins: the latest `groups` tool groups, extended
// backwards while the kept tool results stay within `chars`.
function protectedTail(
  messages: Message[],
  floor: number,
  chars: number,
  groups: number,
) {
  let start = messages.length;
  let kept = 0;
  let count = 0;
  for (let i = messages.length - 1; i >= floor; i--) {
    if (!messages[i]!.tool_calls?.length) continue;
    let results = 0;
    for (let n = i + 1; messages[n]?.role === "tool"; n++)
      results += messages[n]!.content?.length ?? 0;
    count++;
    if (count > groups && kept + results > chars) break;
    kept += results;
    start = i;
  }
  return start;
}

export type MaskBudget = {
  // Tool-result characters kept at the end of the transcript.
  protectChars: number;
  // Characters to remove to reach the target.
  excessChars: number;
  // A batch reclaiming less than this is skipped.
  minReclaimChars: number;
};

// The budget for one batch, or undefined while the request is below the
// trigger. `ratio` is serialized characters per token, as measured from the
// server's own prompt count.
export function maskBudget(
  requestChars: number,
  usableTokens: number,
  ratio: number,
): MaskBudget | undefined {
  if (requestChars / ratio < usableTokens * MASK_TRIGGER) return undefined;
  return {
    protectChars: Math.floor(
      Math.min(PROTECT_TOKENS, usableTokens * PROTECT_SHARE) * ratio,
    ),
    excessChars: Math.ceil(requestChars - usableTokens * MASK_TARGET * ratio),
    minReclaimChars: Math.floor(
      Math.min(MIN_RECLAIM_TOKENS, usableTokens * MIN_RECLAIM_SHARE) * ratio,
    ),
  };
}

// The next mask, or undefined when a batch would not reclaim enough. Elision
// (stale arguments, superseded reads) is applied up to the protected tail
// first; tool results are then cleared oldest first, only as far as the
// target needs. `floor` is the compaction index: earlier messages are already
// replaced by the summary.
export function planMask(
  messages: Message[],
  mask: ContextMask,
  failed: ReadonlySet<string>,
  budget: MaskBudget,
  floor = 0,
): ContextMask | undefined {
  const current = clampMask(mask, messages.length);
  const seen = messages.length;
  const elided = Math.max(
    current.elided,
    protectedTail(messages, floor, budget.protectChars, PROTECT_GROUPS),
  );
  const viewSize = (candidate: ContextMask) =>
    applyMask(messages, candidate, failed)
      .slice(floor)
      .reduce((total, m) => total + size(m), 0);
  const before = viewSize(current);
  const at = (masked: number) => viewSize({ masked, elided, seen });
  // The boundary only moves forward, and only to just after a tool result.
  const start = Math.max(current.masked, Math.min(floor, elided));
  const boundaries = [start];
  for (let i = start; i < elided; i++)
    if (messages[i]!.role === "tool") boundaries.push(i + 1);
  // A later boundary never yields a larger view, so the first one that
  // reaches the target can be found by bisection.
  const target = before - budget.excessChars;
  let low = 0;
  let high = boundaries.length - 1;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (at(boundaries[middle]!) <= target) high = middle;
    else low = middle + 1;
  }
  const masked = boundaries[low]!;
  if (before - at(masked) < Math.max(1, budget.minReclaimChars))
    return undefined;
  return { masked, elided, seen };
}
