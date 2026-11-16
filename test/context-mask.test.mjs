import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClientApp } from "@agentclientprotocol/sdk";

const temporary = await realpath(await mkdtemp(join(tmpdir(), "ow-mask-")));
process.env.OPENWEBUI_ACP_HOME = join(temporary, "state");
process.env.OPENWEBUI_API_KEY = "synthetic-mask-key";
const { createAgent } = await import("../dist/agent.js");
const { directory, writeJson, configSchema } =
  await import("../dist/config.js");
assert.equal(
  directory,
  process.env.OPENWEBUI_ACP_HOME,
  "Application state must use the test's private directory before any writes",
);
const {
  applyMask,
  clampMask,
  contextMaskSchema,
  isElidedPlaceholder,
  maskBudget,
  planMask,
  NO_MASK,
  ARGUMENT_MIN_CHARS,
  FAILED_KEEP_CHARS,
  RESULT_MIN_CHARS,
} = await import("../dist/context-mask.js");
const {
  completionContextTokens,
  contextLimits,
  effortOutputAllowance,
  replyTokenCap,
  XHIGH_OUTPUT_TOKENS,
} = await import("../dist/usage.js");
const { planInContext, PLAN_NOTE_PREFIX } = await import("../dist/planning.js");
const { fitSessionRecord } = await import("../dist/session-store.js");
const { compactionStateSchema, contextMessages } =
  await import("../dist/compaction.js");

// ---- Transcript builders ---------------------------------------------------
const call = (id, name, args) => ({
  id,
  type: "function",
  function: { name, arguments: JSON.stringify(args) },
});
const group = (id, name, args, result) => [
  { role: "assistant", content: null, tool_calls: [call(id, name, args)] },
  { role: "tool", tool_call_id: id, content: result },
];
const read = (id, path, chars = 8000, extra = {}) =>
  group(id, "read_file", { path, ...extra }, `${path}:`.padEnd(chars, "x"));
const head = [
  { role: "system", content: "Authoritative instruction" },
  { role: "user", content: "Refactor the fixture" },
];
const none = new Set();
// A budget that clears as much as the protected tail allows.
const everything = (protectChars = 0) => ({
  protectChars,
  excessChars: Infinity,
  minReclaimChars: 1,
});
const cleared = (m) => m.content?.startsWith("[cleared from context: ");
const size = (messages) => JSON.stringify(messages).length;

test("the batch budget starts at 55% of usable input, aims for 30% and scales its tail to the window", () => {
  // Four characters per token; the family and coder windows minus 12,288.
  const family = 88480;
  assert.equal(maskBudget(family * 4 * 0.55 - 4, family, 4), undefined);
  assert.deepEqual(maskBudget(family * 4 * 0.55, family, 4), {
    protectChars: Math.floor(family * 0.15 * 4),
    excessChars: Math.ceil(family * 4 * 0.55 - family * 0.3 * 4),
    minReclaimChars: Math.floor(family * 0.1 * 4),
  });
  const coder = 249824;
  assert.deepEqual(maskBudget(coder * 4 * 0.6, coder, 4), {
    protectChars: Math.floor(coder * 0.15 * 4),
    excessChars: Math.ceil(coder * 4 * 0.6 - coder * 0.3 * 4),
    minReclaimChars: 20000 * 4,
  });
  // A larger window still protects at most 40,000 tokens.
  assert.equal(maskBudget(400000 * 4, 400000, 4).protectChars, 40000 * 4);
  // The measured ratio converts tokens to characters.
  assert.equal(maskBudget(1200, 1000, 2).protectChars, 300);
});

test("masking clears the oldest results only as far as the target needs and keeps every call, id and pairing", () => {
  const messages = [
    ...head,
    ...read("r1", "a.ts"),
    ...read("r2", "b.ts"),
    ...read("r3", "c.ts"),
    { role: "user", content: "Also check d.ts" },
    ...read("r4", "d.ts"),
    ...read("r5", "e.ts"),
    ...read("r6", "f.ts"),
  ];
  const mask = planMask(messages, NO_MASK, none, {
    protectChars: 0,
    excessChars: 15000,
    minReclaimChars: 1,
  });
  // Two results cover the excess; the third stays although it is unprotected.
  assert.deepEqual(mask, { masked: 6, elided: 11, seen: 15 });
  const view = applyMask(messages, mask, none);
  assert.equal(view.length, messages.length);
  assert.deepEqual(
    view.map((m) => m.role),
    messages.map((m) => m.role),
  );
  assert.deepEqual(
    view.map((m) => m.tool_calls ?? m.tool_call_id ?? null),
    messages.map((m) => m.tool_calls ?? m.tool_call_id ?? null),
  );
  assert.equal(
    view[3].content,
    '[cleared from context: read_file {"path":"a.ts"} returned 8000 chars; re-run to see it again]',
  );
  assert(cleared(view[5]));
  assert.deepEqual(view.slice(6), messages.slice(6));
  assert(size(messages) - size(view) >= 15000);
  // The transcript itself is never changed.
  assert.equal(messages[3].content.length, 8000);
  // User messages are never touched, wherever they are.
  const all = applyMask(
    messages,
    planMask(messages, NO_MASK, none, everything()),
    none,
  );
  assert.deepEqual(
    all.filter((m) => m.role === "user"),
    messages.filter((m) => m.role === "user"),
  );
  // The latest two tool groups stay even with no tail budget.
  assert.deepEqual(
    all.map(cleared).map(Boolean),
    [0, 0, 0, 1, 0, 1, 0, 1, 0, 0, 1, 0, 0, 0, 0].map(Boolean),
  );
});

test("a batch that cannot reclaim enough is skipped, and the tail budget keeps more recent results", () => {
  const messages = [
    ...head,
    ...read("r1", "a.ts"),
    ...read("r2", "b.ts"),
    ...read("r3", "c.ts"),
    ...read("r4", "d.ts"),
    ...read("r5", "e.ts"),
  ];
  assert.equal(
    planMask(messages, NO_MASK, none, {
      protectChars: 0,
      excessChars: Infinity,
      minReclaimChars: 30000,
    }),
    undefined,
  );
  // 24,000 characters of tail: the latest three results stay.
  const mask = planMask(messages, NO_MASK, none, everything(24000));
  assert.deepEqual(mask, { masked: 6, elided: 6, seen: 12 });
  // Nothing more to reclaim: a second batch is not started.
  assert.equal(planMask(messages, mask, none, everything(24000)), undefined);
  // Messages before the compaction index are already summarized.
  assert.deepEqual(planMask(messages, NO_MASK, none, everything(), 4), {
    masked: 8,
    elided: 8,
    seen: 12,
  });
});

test("denials, short results and the read behind an applied edit are protected; large failed output is not", () => {
  const denied = "Permission declined by the user; not retried this turn.";
  const messages = [
    ...head,
    ...read("r1", "a.ts"),
    ...read("r2", "b.ts"),
    ...group(
      "c1",
      "run_command",
      { executable: "rm", args: ["-rf", "x"] },
      denied,
    ),
    ...group(
      "c2",
      "run_command",
      { executable: "npm", args: ["test"] },
      "E".repeat(FAILED_KEEP_CHARS + 1),
    ),
    ...group(
      "c3",
      "run_command",
      { executable: "npm", args: ["run", "lint"] },
      "F".repeat(FAILED_KEEP_CHARS),
    ),
    ...group("l1", "list_files", {}, "x".repeat(RESULT_MIN_CHARS)),
    ...read("r3", "c.ts"),
    ...group(
      "e1",
      "edit_file",
      { path: "./a.ts", old_string: "x", new_string: "y" },
      "File updated; checkpoint 1234",
    ),
    ...read("r4", "d.ts"),
  ];
  const failed = new Set(["c1", "c2", "c3"]);
  const mask = planMask(messages, NO_MASK, failed, everything());
  const view = applyMask(messages, mask, failed);
  const result = (id) => view.find((m) => m.tool_call_id === id).content;
  // a.ts was read, then edited, and the edit is still in context: the read
  // stays. b.ts and c.ts were not edited.
  assert.equal(mask.masked, 16);
  assert.equal(result("r1"), messages[3].content);
  assert(result("r3").startsWith("[cleared from context: read_file"));
  // Once the edit itself is behind the boundary, its read goes too.
  assert(
    applyMask(messages, { ...mask, masked: 18, elided: 18 }, failed)
      .find((m) => m.tool_call_id === "r1")
      .content.startsWith("[cleared"),
  );
  assert(result("r2").startsWith("[cleared from context: read_file"));
  assert.equal(result("c1"), denied);
  assert.equal(
    result("c2"),
    `[cleared from context: run_command {"executable":"npm","args":"[\\"test\\"]"} failed with ${FAILED_KEEP_CHARS + 1} chars; re-run to see it again]`,
  );
  assert.equal(result("c3").length, FAILED_KEEP_CHARS);
  assert.equal(result("l1").length, RESULT_MIN_CHARS);
  assert.equal(result("e1"), "File updated; checkpoint 1234");
  // A failed edit does not protect a read.
  const unapplied = new Set([...failed, "e1"]);
  assert(
    applyMask(messages, mask, unapplied)
      .find((m) => m.tool_call_id === "r1")
      .content.startsWith("[cleared"),
  );
});

test("an earlier read of the same range collapses; a different range is a different observation", () => {
  const messages = [
    ...head,
    ...read("r1", "a.ts"),
    ...read("p1", "big.ts", 8000, { offset: 0, limit: 400 }),
    ...read("p2", "big.ts", 8000, { offset: 400, limit: 400 }),
    ...read("r2", "./a.ts"),
    ...read("r3", "b.ts"),
    ...read("r4", "c.ts"),
    ...group(
      "e1",
      "edit_file",
      { path: "big.ts", old_string: "x", new_string: "y" },
      "File updated; checkpoint 9",
    ),
    ...read("r5", "d.ts"),
  ];
  // Elision only: no result is cleared for size.
  const mask = planMask(messages, NO_MASK, none, {
    protectChars: 0,
    excessChars: 0,
    minReclaimChars: 1,
  });
  assert.equal(mask.masked, 0);
  assert.equal(mask.elided, 14);
  const view = applyMask(messages, mask, none);
  const result = (id) => view.find((m) => m.tool_call_id === id).content;
  assert.equal(
    result("r1"),
    '[cleared from context: read_file {"path":"a.ts"} returned 8000 chars; a later read of the same file follows]',
  );
  for (const id of ["p1", "p2", "r2", "r3"])
    assert.equal(result(id).length, 8000, id);
  // Full masking still keeps both pages of the edited file, and nothing else.
  const full = applyMask(
    messages,
    planMask(messages, NO_MASK, none, everything()),
    none,
  );
  assert.deepEqual(
    full
      .filter((m) => m.role === "tool" && !cleared(m))
      .map((m) => m.tool_call_id),
    ["p1", "p2", "e1", "r5"],
  );
});

test("recorded write and edit arguments are elided to sizes; small edits, other tools and unanswered calls are not", () => {
  const big = "B".repeat(5000);
  const small = "s".repeat(ARGUMENT_MIN_CHARS);
  const messages = [
    ...head,
    ...group(
      "w1",
      "write_file",
      { path: "a.ts", before: big, after: big + "!" },
      "File updated; checkpoint 1",
    ),
    ...group(
      "e1",
      "edit_file",
      { path: "a.ts", old_string: small, new_string: big, replace_all: true },
      "File updated; checkpoint 2",
    ),
    ...group(
      "w2",
      "write_file",
      { path: "new.ts", before: null, content: big },
      "Stale edit proposal",
    ),
    ...group(
      "c1",
      "run_command",
      { executable: "node", args: ["-e", big], content: big },
      "ok",
    ),
    ...read("r1", "b.ts"),
    ...read("r2", "c.ts"),
    {
      role: "assistant",
      content: null,
      tool_calls: [
        call("w3", "write_file", { path: "z.ts", before: null, after: big }),
      ],
    },
  ];
  const mask = planMask(messages, NO_MASK, new Set(["w2"]), everything());
  const view = applyMask(messages, mask, new Set(["w2"]));
  const args = (id) =>
    JSON.parse(
      view.flatMap((m) => m.tool_calls ?? []).find((c) => c.id === id).function
        .arguments,
    );
  const stub = (n) =>
    `[elided from context: ${n} chars; not file text; never copy this into a tool call; read the file to see it]`;
  // w1 is a write in the pre-0.7 {before, after} form, still found in older
  // transcripts; both values are elided like content.
  assert.deepEqual(args("w1"), {
    path: "a.ts",
    before: stub(5000),
    after: stub(5001),
  });
  // The result that names the checkpoint stays beside the stub.
  assert.equal(view[3].content, "File updated; checkpoint 1");
  assert.deepEqual(args("e1"), {
    path: "a.ts",
    old_string: small,
    new_string: stub(5000),
    replace_all: true,
  });
  // A failed proposal is recorded too; its arguments are as stale.
  assert.deepEqual(args("w2"), {
    path: "new.ts",
    before: null,
    content: stub(5000),
  });
  assert.equal(args("c1").content, big);
  assert.equal(args("w3").after, big);
  assert(isElidedPlaceholder(args("w1").after));
  assert(!isElidedPlaceholder(big) && !isElidedPlaceholder(null));
  assert.equal(
    messages[2].tool_calls[0].function.arguments.length > 10000,
    true,
  );
});

test("the masked prompt is fixed between batches: later messages, a later edit or re-read, and a save and reload do not change it", () => {
  const messages = [
    ...head,
    ...read("r1", "a.ts"),
    ...read("r2", "b.ts"),
    ...group(
      "w1",
      "write_file",
      { path: "c.ts", before: null, after: "A".repeat(3000) },
      "File updated; checkpoint 1",
    ),
    ...read("r3", "d.ts"),
    ...read("r4", "e.ts"),
  ];
  const failed = new Set();
  const mask = planMask(messages, NO_MASK, failed, everything());
  const first = JSON.stringify(applyMask(messages, mask, failed));
  assert(first.includes("[cleared from context"));
  // Later rounds: an edit of a cleared file, a repeat of a kept read and a
  // failure. None of them reaches back before the boundary.
  const later = [
    ...messages,
    ...group(
      "e1",
      "edit_file",
      { path: "a.ts", old_string: "x", new_string: "y" },
      "File updated; checkpoint 2",
    ),
    ...read("r5", "e.ts"),
    ...group("c1", "run_command", { executable: "false", args: [] }, "exit 1"),
    { role: "user", content: "Carry on" },
  ];
  failed.add("c1");
  const second = JSON.stringify(applyMask(later, mask, failed));
  assert(second.startsWith(first.slice(0, -1)));
  assert.deepEqual(
    applyMask(later, mask, failed).slice(messages.length),
    later.slice(messages.length),
  );
  // The stored form: plain JSON through the schema.
  const reloaded = contextMaskSchema.parse(JSON.parse(JSON.stringify(mask)));
  assert.equal(
    JSON.stringify(
      applyMask(JSON.parse(JSON.stringify(later)), reloaded, new Set(["c1"])),
    ),
    second,
  );
  // The next batch may reach back: a.ts was edited since and that edit is
  // within the kept tail, so its read returns.
  const next = planMask(later, mask, failed, everything(9000));
  assert(next.seen === later.length && next.masked > mask.masked);
  const third = applyMask(later, next, failed);
  assert.equal(third[3].content, messages[3].content);
  assert(cleared(third.find((m) => m.tool_call_id === "r4")));
  // Compaction indexes stay valid on the masked view.
  const state = compactionStateSchema.parse({ summary: "Summary", through: 6 });
  assert.equal(
    contextMessages(third, state).length,
    contextMessages(later, state).length,
  );
});

test("a mask is validated, clamps to a rewound transcript and follows messages a trimmed save removes", () => {
  assert.deepEqual(contextMaskSchema.parse({}), NO_MASK);
  for (const bad of [
    { masked: 3, elided: 2, seen: 5 },
    { masked: 1, elided: 6, seen: 5 },
    { masked: -1, elided: 0, seen: 0 },
    { masked: 0, elided: 0, seen: 0, extra: 1 },
  ])
    assert.throws(() => contextMaskSchema.parse(bad));
  const mask = { masked: 4, elided: 8, seen: 12 };
  assert.equal(clampMask(mask, 12), mask);
  assert.deepEqual(clampMask(mask, 6), { masked: 4, elided: 6, seen: 6 });
  assert.deepEqual(clampMask(mask, 2), { masked: 2, elided: 2, seen: 2 });
  // Four turns; the stored copy keeps the latest three and drops the first.
  const turn = (n) => [
    { role: "user", content: `Request ${n}` },
    ...read(`t${n}`, `f${n}.ts`, 40000),
  ];
  const messages = [head[0], ...turn(1), ...turn(2), ...turn(3), ...turn(4)];
  const input = {
    messages,
    compaction: compactionStateSchema.parse({}),
    contextMask: { masked: 7, elided: 10, seen: 13 },
  };
  assert.equal(fitSessionRecord(input).record, input);
  // Room for the latest three turns only.
  const kept = { ...input, messages: [head[0], ...messages.slice(4)] };
  const { record } = fitSessionRecord(
    input,
    Buffer.byteLength(JSON.stringify(kept)) + 10,
  );
  assert.equal(record.messages.length, 10);
  assert.deepEqual(record.contextMask, { masked: 4, elided: 7, seen: 10 });
});

test("the context meter leaves reasoning out of what the conversation occupies", () => {
  // The server's own count.
  assert.equal(
    completionContextTokens({
      prompt_tokens: 1000,
      completion_tokens: 900,
      completion_tokens_details: { reasoning_tokens: 800 },
    }),
    1100,
  );
  // Without one, the share of characters received as reasoning.
  assert.equal(
    completionContextTokens(
      { prompt_tokens: 1000, completion_tokens: 900 },
      300,
      2700,
    ),
    1090,
  );
  // The reported count wins over the estimate; an impossible one is ignored.
  assert.equal(
    completionContextTokens(
      {
        prompt_tokens: 1000,
        completion_tokens: 900,
        completion_tokens_details: { reasoning_tokens: 0 },
      },
      300,
      2700,
    ),
    1900,
  );
  assert.equal(
    completionContextTokens(
      {
        prompt_tokens: 1000,
        completion_tokens: 900,
        completion_tokens_details: { reasoning_tokens: 901 },
      },
      300,
      2700,
    ),
    1090,
  );
  // No reasoning seen: the whole completion counts, as before.
  assert.equal(
    completionContextTokens(
      { prompt_tokens: 1000, completion_tokens: 900 },
      300,
      0,
    ),
    1900,
  );
  // Only reasoning: nothing visible to carry forward.
  assert.equal(
    completionContextTokens(
      { prompt_tokens: 1000, completion_tokens: 900 },
      0,
      50,
    ),
    1000,
  );
});

test("xhigh gets an explicit reply cap that fits the window, and the input is sized against it", () => {
  const family = { context_window: 100768, max_output_tokens: 12288 };
  assert.equal(XHIGH_OUTPUT_TOKENS, 32768);
  assert.equal(replyTokenCap("xhigh", family), 12288);
  assert.equal(
    replyTokenCap("xhigh", { context_window: 32768, max_output_tokens: 4096 }),
    4096,
  );
  assert.equal(
    replyTokenCap("xhigh", {
      openai: { context_window: 100768, max_output_tokens: 8192 },
    }),
    8192,
  );
  for (const effort of [undefined, "none", "low", "medium", "high", "max"])
    assert.equal(replyTokenCap(effort, family), undefined);
  // Never above half the window or the server's advertised output limit.
  assert.equal(replyTokenCap("xhigh", { context_window: 40000 }), 20000);
  assert.equal(
    replyTokenCap("xhigh", {
      context_window: 262112,
      max_output_tokens: 65536,
    }),
    65536,
  );
  assert.equal(replyTokenCap("xhigh", { openai: { context_window: 9 } }), 4);
  // No explicit window: nothing to fit it to, so none is sent.
  assert.equal(replyTokenCap("xhigh", { max_input_tokens: 50000 }), undefined);
  assert.equal(replyTokenCap("xhigh", { id: "unknown" }), undefined);
  // Reserve the cap actually sent, without exceeding the advertised allowance.
  assert.deepEqual(
    contextLimits(family, 12288, replyTokenCap("xhigh", family)),
    {
      size: 100768,
      usable: 88480,
    },
  );
  assert.deepEqual(contextLimits(family, 12288), {
    size: 100768,
    usable: 88480,
  });
  assert.deepEqual(contextLimits({ context_window: 262112 }, 12288, 32768), {
    size: 262112,
    usable: 229344,
  });
  // An explicit input limit still applies when it is the smaller one.
  assert.deepEqual(
    contextLimits(
      { context_window: 100000, max_input_tokens: 50000 },
      1,
      32768,
    ),
    { size: 100000, usable: 50000 },
  );
  assert.deepEqual(
    contextLimits(
      { context_window: 100000, max_input_tokens: 90000 },
      1,
      32768,
    ),
    { size: 100000, usable: 67232 },
  );
});

test("xhigh uses the limit advertised for that level, within half the window", () => {
  const level = (maxOutputTokens, effort = "xhigh") => ({
    reasoningEffort: effort,
    label: "Max",
    maxOutputTokens,
  });
  const family = { context_window: 100768, max_output_tokens: 12288 };
  const advertised = {
    ...family,
    supportedReasoningEfforts: [{ reasoningEffort: "low" }, level(32768)],
  };
  assert.equal(effortOutputAllowance(advertised, "xhigh"), 32768);
  assert.equal(effortOutputAllowance(advertised, "low"), undefined);
  assert.equal(replyTokenCap("xhigh", advertised), 32768);
  // Open WebUI also keeps the provider's entry under `openai`.
  assert.equal(
    replyTokenCap("xhigh", {
      ...family,
      openai: { supportedReasoningEfforts: [level(24576)] },
    }),
    24576,
  );
  // Clamped to half the window.
  assert.equal(
    replyTokenCap("xhigh", {
      context_window: 40000,
      max_output_tokens: 12288,
      supportedReasoningEfforts: [level(65536)],
    }),
    20000,
  );
  // Absent, malformed or for another level: the general limit, as before.
  for (const supportedReasoningEfforts of [
    undefined,
    "xhigh",
    [level(0)],
    [level(-1)],
    [level("32768")],
    [level(1.5)],
    [level(32768, "medium")],
    [null, { reasoningEffort: "xhigh" }],
  ])
    assert.equal(
      replyTokenCap("xhigh", { ...family, supportedReasoningEfforts }),
      12288,
    );
  assert.equal(
    replyTokenCap("xhigh", {
      context_window: 100768,
      supportedReasoningEfforts: [level(0)],
    }),
    XHIGH_OUTPUT_TOKENS,
  );
  // Other levels still send no cap.
  for (const effort of [undefined, "low", "medium", "high"])
    assert.equal(replyTokenCap(effort, advertised), undefined);
  // The input is sized against the cap actually sent.
  assert.deepEqual(
    contextLimits(advertised, 12288, replyTokenCap("xhigh", advertised)),
    { size: 100768, usable: 68000 },
  );
});

test("the plan counts as visible only when the latest update_plan call states it", () => {
  const plan = [
    { content: "Read", priority: "high", status: "completed" },
    { content: "Edit [redacted]", priority: "medium", status: "in_progress" },
  ];
  const redact = (text) => text.replace("secret", "[redacted]");
  const update = (id, entries) =>
    group(id, "update_plan", { entries }, "Plan updated.");
  const shown = [
    { status: "completed", content: "Read", priority: "high" },
    { priority: "medium", content: "Edit secret", status: "in_progress" },
  ];
  assert(planInContext([...head, ...update("p1", shown)], plan, redact));
  assert(!planInContext(head, plan, redact));
  // An older matching call followed by a different one is not the plan.
  assert(
    !planInContext(
      [...head, ...update("p1", shown), ...update("p2", shown.slice(0, 1))],
      plan,
      redact,
    ),
  );
  assert(
    !planInContext(
      [...head, ...group("p1", "update_plan", { entries: "bad" }, "Invalid")],
      plan,
      redact,
    ),
  );
  assert(PLAN_NOTE_PREFIX.startsWith("Untrusted current task progress"));
});

// ---- Agent fixture ---------------------------------------------------------
// Four serialized characters per prompt token, so thresholds are exact.
const requestChars = (r) =>
  JSON.stringify(r.messages).length + JSON.stringify(r.tools).length;
let model = { id: "fixture", context_window: 1_000_000 };
let pending = [];
let reply; // optional: (request, res) => handled
const requests = [];
const server = createServer(async (req, res) => {
  res.setHeader("Content-Type", "application/json");
  if (req.url === "/api/models")
    return res.end(JSON.stringify({ data: [model] }));
  // Decoded as a stream: a multi-byte character may span two chunks.
  req.setEncoding("utf8");
  let raw = "";
  for await (const part of req) raw += part;
  const request = JSON.parse(raw);
  requests.push(request);
  if (reply?.(request, res)) return;
  const message =
    request.tools.length === 0
      ? { role: "assistant", content: "Summary of earlier work." }
      : (pending.shift() ?? { role: "assistant", content: "Done" });
  res.end(
    JSON.stringify({
      choices: [
        { message, finish_reason: message.tool_calls ? "tool_calls" : "stop" },
      ],
      usage: {
        prompt_tokens: Math.ceil(requestChars(request) / 4),
        completion_tokens: 10,
      },
    }),
  );
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const url = `http://127.0.0.1:${server.address().port}`;
await writeJson("config.json", configSchema.parse({ url, model: "fixture" }));
test.after(() => new Promise((r) => server.close(r)));
test.beforeEach(() => {
  pending = [];
  reply = undefined;
  requests.length = 0;
  model = { id: "fixture", context_window: 1_000_000 };
});

// About 20,000 characters in short lines: one read_file result whether reads
// return the whole file or a numbered page of it.
const FILE = 20000;
const WHOLE = 15000; // any uncleared read result is longer than this
const FILES = ["a", "b", "c", "d", "e", "f", "g", "h"].map((n) => `${n}.txt`);
const tool = (id, name, args) => ({
  role: "assistant",
  content: null,
  tool_calls: [call(id, name, args)],
});
async function client(cwd, sessionId) {
  if (!cwd) {
    cwd = await realpath(await mkdtemp(join(temporary, "project-")));
    for (const name of FILES)
      await writeFile(
        join(cwd, name),
        (`${name} `.padEnd(59, "x") + "\n").repeat(Math.floor(FILE / 60)),
      );
  }
  const app = new ClientApp(),
    agent = createAgent(),
    updates = [];
  app.onNotification("session/update", ({ params }) =>
    updates.push(params.update),
  );
  app.onRequest("session/request_permission", () => ({
    outcome: { outcome: "selected", optionId: "once" },
  }));
  const connection = app.connect(agent.app);
  await connection.agent.request("initialize", {
    protocolVersion: 1,
    clientCapabilities: {},
  });
  if (sessionId)
    await connection.agent.request("session/load", {
      sessionId,
      cwd,
      mcpServers: [],
    });
  else
    sessionId = (
      await connection.agent.request("session/new", { cwd, mcpServers: [] })
    ).sessionId;
  return {
    cwd,
    sessionId,
    updates,
    state: () => agent.sessions.get(sessionId),
    select: (configId, value) =>
      connection.agent.request("session/set_config_option", {
        sessionId,
        configId,
        value,
      }),
    prompt: (text = "Inspect the fixture files") =>
      connection.agent.request("session/prompt", {
        sessionId,
        prompt: [{ type: "text", text }],
      }),
    close: async () => {
      connection.close();
      await agent.close();
    },
  };
}
const coding = () => requests.filter((r) => r.tools.length > 0);
// Request `b` carries everything request `a` did, unchanged, then more.
const extendsPrefix = (a, b) =>
  JSON.stringify(b.tools) === JSON.stringify(a.tools) &&
  JSON.stringify(b.messages).startsWith(
    JSON.stringify(a.messages).slice(0, -1),
  );

test("a plan update leaves the prompt prefix intact: nothing dynamic precedes the conversation", async () => {
  const entries = (status) => [
    { content: "Read the files", priority: "high", status },
    { content: "Report", priority: "medium", status: "pending" },
  ];
  pending = [
    tool("p1", "update_plan", { entries: entries("in_progress") }),
    tool("r1", "read_file", { path: "a.txt" }),
    tool("p2", "update_plan", { entries: entries("completed") }),
    tool("r2", "read_file", { path: "b.txt" }),
  ];
  const c = await client();
  try {
    await c.prompt();
    const sent = coding();
    assert.equal(sent.length, 5);
    assert.equal(c.state().plan[0].status, "completed");
    for (let i = 1; i < sent.length; i++)
      assert(extendsPrefix(sent[i - 1], sent[i]), `request ${i + 1}`);
    // The plan reaches the model through its own update_plan calls only.
    for (const r of sent)
      assert(!r.messages.some((m) => m.content?.startsWith(PLAN_NOTE_PREFIX)));
    assert(
      sent
        .at(-1)
        .messages.some((m) => m.tool_calls?.some((t) => t.id === "p2")),
    );
    // System messages, guidance and tools are byte-identical across rounds.
    const lead = (r) =>
      JSON.stringify(
        r.messages.slice(
          0,
          r.messages.findIndex(
            (m) => m.content === "Inspect the fixture files",
          ),
        ),
      );
    assert(new Set(sent.map(lead)).size === 1);
    // A second turn extends the first turn's last request too.
    await c.prompt("And again");
    assert(extendsPrefix(sent.at(-1), coding().at(-1)));
  } finally {
    await c.close();
  }
});

test("a plan whose update_plan call left the context is restated after the latest messages", async () => {
  pending = [
    tool("p1", "update_plan", {
      entries: [
        { content: "Only step", priority: "high", status: "in_progress" },
      ],
    }),
  ];
  const c = await client();
  try {
    await c.prompt();
    assert.equal(c.state().plan.length, 1);
    // /compact summarizes the turn that held the call.
    await c.prompt("/compact");
    requests.length = 0;
    pending = [tool("r1", "read_file", { path: "a.txt" })];
    await c.prompt("Continue");
    const sent = coding();
    assert.equal(sent.length, 2);
    for (const r of sent) {
      const notes = r.messages.filter((m) =>
        m.content?.startsWith(PLAN_NOTE_PREFIX),
      );
      assert.equal(notes.length, 1);
      assert.equal(r.messages.at(-1), notes[0]);
      assert(notes[0].content.includes("Only step"));
    }
    // The note is last, so the earlier request is still a prefix up to it.
    const withoutNote = (r) => JSON.stringify(r.messages.slice(0, -1));
    assert(withoutNote(sent[1]).startsWith(withoutNote(sent[0]).slice(0, -1)));
  } finally {
    await c.close();
  }
});

test("the agent masks in batches before compacting, saves the boundary and sends the same prefix after a reload", async () => {
  // Usable input 40,000 tokens: masking starts at 22,000 (88,000 characters).
  model = { id: "fixture", context_window: 48000, max_output_tokens: 8000 };
  pending = FILES.map((path, i) => tool(`r${i + 1}`, "read_file", { path }));
  const c = await client();
  let saved;
  try {
    await c.prompt();
    const sent = coding();
    assert.equal(sent.length, FILES.length + 1);
    assert.equal(requests.length, sent.length, "no summary request was needed");
    const stubs = (r) => r.messages.filter(cleared).length;
    const recorded = (id) =>
      c.state().messages.find((m) => m.tool_call_id === id).content;
    const batches = [];
    for (let i = 1; i < sent.length; i++) {
      if (extendsPrefix(sent[i - 1], sent[i])) continue;
      batches.push(i);
      // A batch only ever clears more.
      assert(stubs(sent[i]) > stubs(sent[i - 1]));
    }
    // Eight 20,000-character reads cross the trigger a few times, not on
    // every round: every other request reuses the previous prefix.
    assert(batches.length >= 2 && batches.length <= 3, String(batches));
    for (const r of sent) {
      assert(requestChars(r) / 4 <= 40000 * 0.55 + (FILE + 4000) / 4);
      // Every call and result is still paired; the latest two results are whole.
      const results = r.messages.filter((m) => m.role === "tool");
      assert.equal(
        results.length,
        r.messages.flatMap((m) => m.tool_calls ?? []).length,
      );
      // The latest two results are exactly what the tools returned.
      for (const m of results.slice(-2))
        assert.equal(m.content, recorded(m.tool_call_id));
    }
    assert.equal(
      sent.at(-1).messages.find(cleared).content,
      `[cleared from context: read_file {"path":"a.txt"} returned ${recorded("r1").length} chars; re-run to see it again]`,
    );
    // The transcript keeps every result.
    assert(
      c
        .state()
        .messages.filter((m) => m.role === "tool")
        .every((m) => m.content.length > WHOLE),
    );
    saved = JSON.parse(
      await readFile(
        join(temporary, "state", `session-${c.sessionId}.json`),
        "utf8",
      ),
    );
    assert.deepEqual(saved.contextMask, c.state().mask);
    assert(saved.contextMask.masked > 0);
    assert(
      saved.messages.filter((m) => m.role === "tool").every((m) => !cleared(m)),
    );
  } finally {
    await c.close();
  }
  const last = coding().at(-1);
  requests.length = 0;
  const restored = await client(c.cwd, c.sessionId);
  try {
    assert.deepEqual(restored.state().mask, saved.contextMask);
    await restored.prompt("Summarize what you read");
    // Same masked prefix as before the restart, then the reply and new request.
    // A restored transcript lists a tool message's fields in schema order;
    // the rendered prompt depends on their values, so compare those.
    const fields = (r) => ({
      tools: r.tools,
      messages: r.messages.map((m) => [
        m.role,
        m.content,
        m.tool_calls ?? null,
        m.tool_call_id ?? null,
      ]),
    });
    assert(extendsPrefix(fields(last), fields(coding()[0])));
  } finally {
    await restored.close();
  }
});

const efforts = {
  provider_model_controls: {
    reasoning_effort: {
      label: "Reasoning effort",
      default: "medium",
      options: { medium: {}, high: {}, xhigh: { label: "Max" } },
    },
  },
};

test("only xhigh requests carry max_tokens, and compaction pressure uses the reserved input", async () => {
  model = {
    id: "fixture",
    context_window: 100768,
    max_output_tokens: 12288,
    ...efforts,
  };
  const c = await client();
  try {
    await c.prompt();
    assert.equal(coding().at(-1).reasoning_effort, "medium");
    assert(!("max_tokens" in coding().at(-1)));
    await c.select("reasoning", JSON.stringify(["reasoning_effort", "high"]));
    await c.prompt();
    assert(!("max_tokens" in coding().at(-1)));
    await c.select("reasoning", JSON.stringify(["reasoning_effort", "xhigh"]));
    await c.prompt();
    assert.equal(coding().at(-1).reasoning_effort, "xhigh");
    assert.equal(coding().at(-1).max_tokens, 12288);
  } finally {
    await c.close();
  }
  // A window too small for 32,768: half of it, and the input is sized to fit.
  const base = requestChars(coding()[0]);
  const window = 2 * Math.ceil((base + 1.5 * FILE) / 4);
  model = {
    id: "fixture",
    context_window: window,
    ...efforts,
  };
  pending = [
    tool("r1", "read_file", { path: "a.txt" }),
    tool("r2", "read_file", { path: "b.txt" }),
  ];
  requests.length = 0;
  const small = await client();
  try {
    await small.select(
      "reasoning",
      JSON.stringify(["reasoning_effort", "xhigh"]),
    );
    await small.prompt();
    for (const r of coding()) {
      assert.equal(r.max_tokens, window / 2);
      assert(Math.ceil(requestChars(r) / 4) + r.max_tokens <= window);
    }
    // Both reads together exceed the reserved input: compact before sending.
    assert.equal(requests.filter((r) => r.tools.length === 0).length, 1);
  } finally {
    await small.close();
  }
});

test("Max respects the gateway output limit on the first prompt and keeps selected settings", async () => {
  model = {
    id: "fixture",
    context_window: 100768,
    max_output_tokens: 12288,
    ...efforts,
  };
  reply = (request, res) => {
    if (request.max_tokens > model.max_output_tokens) {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: { code: "output_limit_exceeded" } }));
      return true;
    }
  };
  const c = await client();
  const reasoning = '["reasoning_effort","xhigh"]';
  try {
    await c.select("reasoning", reasoning);
    await c.select("mode", "plan");
    await c.prompt();
    assert.equal(coding().length, 1);
    assert.equal(coding()[0].reasoning_effort, "xhigh");
    assert.equal(coding()[0].max_tokens, 12288);
    assert(
      c
        .state()
        .messages.some((m) => m.role === "assistant" && m.content === "Done"),
    );
    assert(!JSON.stringify(c.updates).includes("output_limit_exceeded"));
    assert.equal(c.state().reasoning, reasoning);
    assert.equal(c.state().workflow, "plan");
  } finally {
    await c.close();
  }
  const restored = await client(c.cwd, c.sessionId);
  try {
    assert.equal(restored.state().reasoning, reasoning);
    assert.equal(restored.state().workflow, "plan");
  } finally {
    await restored.close();
  }
});

test("a first-prompt HTTP 400 does not reset reasoning or mode in saved ACP state", async () => {
  model = {
    id: "fixture",
    context_window: 100768,
    max_output_tokens: 12288,
    ...efforts,
  };
  reply = (_request, res) => {
    res.statusCode = 400;
    res.end(JSON.stringify({ error: { code: "output_limit_exceeded" } }));
    return true;
  };
  const c = await client();
  const reasoning = '["reasoning_effort","xhigh"]';
  try {
    await c.select("reasoning", reasoning);
    await c.select("mode", "plan");
    await c.prompt();
    assert.equal(
      coding().length,
      1,
      "HTTP failure must not automatically retry",
    );
    assert(JSON.stringify(c.updates).includes("output_limit_exceeded"));
    assert.equal(c.state().reasoning, reasoning);
    assert.equal(c.state().workflow, "plan");
    const saved = JSON.parse(
      await readFile(join(directory, `session-${c.sessionId}.json`), "utf8"),
    );
    assert.equal(saved.reasoning, reasoning);
    assert.equal(saved.workflow, "plan");
  } finally {
    await c.close();
  }
  const restored = await client(c.cwd, c.sessionId);
  try {
    assert.equal(restored.state().reasoning, reasoning);
    assert.equal(restored.state().workflow, "plan");
  } finally {
    await restored.close();
  }
});

test("Max sends the limit advertised for Max, which the gateway accepts", async () => {
  const ceiling = 32768;
  model = {
    id: "fixture",
    context_window: 100768,
    max_output_tokens: 12288,
    // As Open WebUI lists the gateway's model: the slider and the raw levels.
    supportedReasoningEfforts: [
      { reasoningEffort: "medium", label: "Medium" },
      { reasoningEffort: "xhigh", label: "Max", maxOutputTokens: ceiling },
    ],
    ...efforts,
  };
  // The gateway's rule: up to the advertised ceiling at xhigh, else the allowance.
  reply = (request, res) => {
    const limit =
      request.reasoning_effort === "xhigh" ? ceiling : model.max_output_tokens;
    if (request.max_tokens > limit) {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: { code: "output_limit_exceeded" } }));
      return true;
    }
  };
  const c = await client();
  try {
    await c.prompt();
    assert(!("max_tokens" in coding().at(-1)));
    await c.select("reasoning", JSON.stringify(["reasoning_effort", "xhigh"]));
    await c.prompt();
    assert.equal(coding().at(-1).reasoning_effort, "xhigh");
    assert.equal(coding().at(-1).max_tokens, ceiling);
    assert(!JSON.stringify(c.updates).includes("output_limit_exceeded"));
    // Runtime guidance names the allowance each request actually gets.
    const guidance = (r) =>
      r.messages
        .find(
          (m) =>
            m.role === "system" && /Plan for \d+ output tokens/.test(m.content),
        )
        ?.content.match(/Plan for (\d+) output tokens/)[1];
    assert.deepEqual(coding().map(guidance), ["12288", "32768"]);
  } finally {
    await c.close();
  }
});

test("a reply whose thinking used the whole limit is asked once more at the same level and cap", async () => {
  // A server declaring both high and xhigh: the re-ask must not move to high,
  // which would go out without the agent's cap.
  model = {
    id: "fixture",
    context_window: 100768,
    max_output_tokens: 12288,
    supportedReasoningEfforts: [
      { reasoningEffort: "xhigh", label: "Max", maxOutputTokens: 32768 },
    ],
    ...efforts,
  };
  const thinkingOnly = (res) => {
    res.setHeader("Content-Type", "text/event-stream");
    const events = [
      { choices: [{ delta: { reasoning_content: "thinking ".repeat(50) } }] },
      { choices: [{ delta: {}, finish_reason: "length" }] },
    ];
    res.end(
      events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("") +
        "data: [DONE]\n\n",
    );
    return true;
  };
  const reasoning = '["reasoning_effort","xhigh"]';
  for (const cuts of [1, 2]) {
    requests.length = 0;
    let cut = 0;
    reply = (request, res) =>
      request.tools.length > 0 && cut++ < cuts && thinkingOnly(res);
    const c = await client();
    try {
      await c.select("reasoning", reasoning);
      const result = await c.prompt();
      // One re-ask at most, with the same effort and the same max_tokens.
      assert.deepEqual(
        coding().map((r) => [r.reasoning_effort, r.max_tokens]),
        [
          ["xhigh", 32768],
          ["xhigh", 32768],
        ],
      );
      const text = c.updates
        .filter((u) => u.sessionUpdate === "agent_message_chunk")
        .map((u) => u.content.text)
        .join("");
      assert.match(
        text,
        /cut off by its output limit: its thinking used the whole limit before any reply\. Asking once more at the same reasoning level for briefer thinking\. No tools from that reply ran\./,
      );
      assert.doesNotMatch(text, /shorter reply with smaller tool calls/);
      const marker = coding()[1].messages.find((m) =>
        m.content?.startsWith("[Your last reply"),
      );
      assert.match(marker.content, /Keep your reasoning short this time/);
      if (cuts === 1) assert.equal(result.stopReason, "end_turn");
      else assert.match(text, /Model reply recovery failed after one re-ask/);
      assert.equal(c.state().reasoning, reasoning);
    } finally {
      await c.close();
    }
  }
});

test("streamed thinking does not fill the context meter", async () => {
  model = { id: "fixture", context_window: 100000 };
  reply = (_, res) => {
    res.setHeader("Content-Type", "text/event-stream");
    const events = [
      { choices: [{ delta: { reasoning_content: "t".repeat(9000) } }] },
      { choices: [{ delta: { content: "v".repeat(1000) } }] },
      { choices: [{ delta: {}, finish_reason: "stop" }] },
      { choices: [], usage: { prompt_tokens: 5000, completion_tokens: 3000 } },
    ];
    res.end(
      events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("") +
        "data: [DONE]\n\n",
    );
    return true;
  };
  const c = await client();
  try {
    await c.prompt();
    const usage = c.updates.filter((u) => u.sessionUpdate === "usage_update");
    // 5,000 prompt tokens plus the visible tenth of the 3,000 completion
    // tokens; counting the thinking would have reported 8,000.
    assert.deepEqual(
      usage.map((u) => [u.used, u.size]),
      [[5300, 100000]],
    );
    assert.deepEqual(c.state().contextUsage, { used: 5300, size: 100000 });
  } finally {
    await c.close();
  }
});

test("a context placeholder copied into a write is refused before anything is written", async () => {
  // The current stub and the wording of earlier releases share the prefix.
  const placeholder =
    "[elided from context: 5000 chars; not file text; never copy this into a tool call; read the file to see it]";
  const older =
    "[elided from context: 5000 chars; read the file for its current content]";
  pending = [
    tool("w1", "write_file", { path: "new.txt", content: placeholder }),
    tool("w2", "write_file", { path: "new.txt", before: null, after: older }),
    tool("e1", "edit_file", {
      path: "a.txt",
      old_string: "a.txt",
      new_string: placeholder,
    }),
    // A legacy before is ignored, so a placeholder there writes nothing from
    // it: only the real after text is used.
    tool("w3", "write_file", {
      path: "other.txt",
      before: placeholder,
      after: "real text\n",
    }),
  ];
  const c = await client();
  try {
    await c.prompt();
    const results = c.state().messages.filter((m) => m.role === "tool");
    assert.equal(results.length, 4);
    for (const m of results.slice(0, 3))
      assert.match(
        m.content,
        /context placeholder.*not file text.*Read the file with read_file.*Nothing was written/,
      );
    await assert.rejects(readFile(join(c.cwd, "new.txt")), /ENOENT/);
    assert(!(await readFile(join(c.cwd, "a.txt"), "utf8")).includes("elided"));
    assert.equal(
      await readFile(join(c.cwd, "other.txt"), "utf8"),
      "real text\n",
    );
    assert.match(results[3].content, /write_file takes \{path, content\}/);
  } finally {
    await c.close();
  }
});
