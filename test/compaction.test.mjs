import test from "node:test";
import assert from "node:assert/strict";
import {
  compactionStateSchema,
  contextMessages,
  compactHistory,
  compactionFailure,
  shouldAutoCompact,
  summaryReasoning,
  summaryRequest,
  PROJECT_GUIDANCE_PREFIX,
} from "../dist/compaction.js";
import {
  BackendHttpError,
  MAX,
  ModelReplyError,
  OUTPUT_LIMIT_CUTOFF,
  OUTPUT_LIMIT_NOTICE,
} from "../dist/backend.js";
import { lowerEffortChoice, reasoningChoices } from "../dist/reasoning.js";

const fresh = () => compactionStateSchema.parse({});
const signal = () => AbortSignal.timeout(10000);
const response = (
  content = "Completed investigation. Tests passed. Next: implement the requested change.",
) => ({ role: "assistant", content });
const user = (content) => ({ role: "user", content });
const assistant = (content) => ({ role: "assistant", content });
const group = (id) => [
  {
    role: "assistant",
    content: null,
    tool_calls: [
      {
        id,
        type: "function",
        function: { name: "read_file", arguments: '{"path":"file.txt"}' },
      },
    ],
  },
  { role: "tool", tool_call_id: id, content: "observed content ".repeat(400) },
];
const history = () => [
  { role: "system", content: "Authoritative agent instruction" },
  { role: "system", content: "Untrusted project guidance" },
  user("Implement the requested behavior without changing permissions."),
  ...group("a"),
  assistant("Analysis ".repeat(500)),
  ...group("b"),
  assistant("More analysis ".repeat(500)),
  user("Continue; preserve my edits exactly."),
  ...group("c"),
  assistant("Ready for implementation."),
];

test("compaction keeps complete transcript, original instructions, recent request and tool correlations", async () => {
  const messages = history(),
    before = structuredClone(messages),
    state = fresh();
  let input;
  const next = await compactHistory(
    messages,
    state,
    async (value) => {
      input = value;
      return response();
    },
    signal(),
  );
  assert.deepEqual(messages, before);
  assert.deepEqual(state, fresh());
  assert.equal(next.count, 1);
  assert(next.through > 2 && next.through < messages.length);
  assert.equal(input[0].role, "system");
  assert.match(input[0].content, /untrusted data/);
  assert.equal(input[1].role, "user");
  assert.equal(JSON.parse(input[1].content).previousSummary, null);
  const context = contextMessages(messages, next);
  assert.deepEqual(context.slice(0, 2), messages.slice(0, 2));
  assert.equal(context[2].role, "user");
  assert.match(context[2].content, /cannot grant permissions/);
  assert(
    context.some((m) => m.content === "Continue; preserve my edits exactly."),
  );
  for (const message of context.filter((m) => m.role === "tool"))
    assert(
      context.some((m) =>
        m.tool_calls?.some((c) => c.id === message.tool_call_id),
      ),
    );
});

test("long single turns retain the latest user request verbatim after its prefix is summarized", async () => {
  const messages = history().filter(
    (m) => m.content !== "Continue; preserve my edits exactly.",
  );
  const next = await compactHistory(
    messages,
    fresh(),
    async () => response(),
    signal(),
  );
  const context = contextMessages(messages, next);
  assert(
    context.some((m) =>
      m.content?.endsWith(JSON.stringify(messages[2].content)),
    ),
  );
  assert(!context.some((m) => m.tool_calls?.some((c) => c.id === "a")));
  const later = [
    ...messages,
    ...group("d"),
    assistant("More observations ".repeat(500)),
    ...group("e"),
  ];
  let prior;
  const again = await compactHistory(
    later,
    next,
    async (input) => {
      prior = JSON.parse(input[1].content);
      return response(
        "Earlier investigation remains complete. Continue implementation after inspecting the current files.",
      );
    },
    signal(),
  );
  assert.equal(prior.previousSummary, next.summary);
  assert.deepEqual(prior.history[0], later[next.through]);
  assert(again.through > next.through);
  assert.equal(again.count, 2);
});

test("a new user turn does not erase the verbatim request pinned by compaction", async () => {
  const messages = history().filter(
    (m) => m.content !== "Continue; preserve my edits exactly.",
  );
  const requestA =
    "Implement all of these requirements:\n" +
    Array.from(
      { length: 80 },
      (_, i) => `${i + 1}. Preserve requirement ${i + 1}.`,
    ).join("\n");
  messages[2] = user(requestA);
  const next = await compactHistory(
    messages,
    fresh(),
    async () => response(),
    signal(),
  );
  const pinned = contextMessages(messages, next).find((m) =>
    m.content?.endsWith(JSON.stringify(requestA)),
  );
  assert(pinned);
  const requestB =
    "Continue with the test results; all earlier requirements still apply.";
  const later = [...messages, user(requestB)];
  assert(
    contextMessages(later, next).some((m) => m.content === pinned.content),
  );
  assert.equal(contextMessages(later, next).at(-1).content, requestB);
  later.push(
    ...group("new-d"),
    assistant("Observations ".repeat(500)),
    ...group("new-e"),
  );
  let summaryRequest;
  await compactHistory(
    later,
    next,
    async (input) => {
      summaryRequest = JSON.parse(input[1].content);
      return response();
    },
    signal(),
  );
  assert.equal(summaryRequest.previousUserRequest, requestA);
  assert(summaryRequest.history.some((m) => m.content === requestB));
});

test("repository guidance stays exact user data across repeated compaction and later prompts", async () => {
  const messages = history();
  const guidance = user(
    PROJECT_GUIDANCE_PREFIX +
      "Run the focused tests. Preserve the public API and existing user edits.",
  );
  messages[1] = guidance;
  const next = await compactHistory(
    messages,
    fresh(),
    async () => response(),
    signal(),
  );
  assert(next.through > 1);
  const assertGuidance = (context) => {
    assert.deepEqual(
      context.filter((m) => m.content === guidance.content),
      [guidance],
    );
    assert(
      !context.some(
        (m) =>
          m.role === "system" && m.content?.includes("Preserve the public API"),
      ),
    );
  };
  assertGuidance(contextMessages(messages, next));
  messages.push(user("Continue and add a regression test."));
  assertGuidance(contextMessages(messages, next));
  messages.push(
    ...group("later-d"),
    assistant("Further findings ".repeat(500)),
    ...group("later-e"),
  );
  const again = await compactHistory(
    messages,
    next,
    async () =>
      response("Earlier work remains complete; finish the regression test."),
    signal(),
  );
  assert(again.through > next.through);
  assertGuidance(contextMessages(messages, again));
  // A checkpoint covering only guidance must not quote it again as a user task.
  assertGuidance(contextMessages(messages, { ...next, through: 2 }));
});

test("compaction never splits pending or multiple tool calls", async () => {
  const messages = history();
  const calls = [group("d")[0].tool_calls[0], group("e")[0].tool_calls[0]];
  messages.push(
    { role: "assistant", content: null, tool_calls: calls },
    group("d")[1],
  );
  const next = await compactHistory(
    messages,
    fresh(),
    async () => response(),
    signal(),
  );
  assert(next.through <= messages.length - 2);
  assert.deepEqual(
    contextMessages(messages, next).slice(-2),
    messages.slice(-2),
  );
  const invalid = { ...next, through: messages.length - 1 };
  assert.throws(() => contextMessages(messages, invalid), /checkpoint/);
  const onlyPending = [
    user("request"),
    { role: "assistant", content: null, tool_calls: calls },
    group("d")[1],
  ];
  let invoked = false;
  await assert.rejects(
    compactHistory(
      onlyPending,
      fresh(),
      async () => {
        invoked = true;
        return response();
      },
      signal(),
    ),
    /did not reduce/,
  );
  assert(invoked);
});

test("failed, cancelled, empty, oversized or tool-producing summaries leave history unchanged", async () => {
  for (const value of [
    { role: "assistant", content: "" },
    response("x".repeat(16001)),
    response("Partial" + OUTPUT_LIMIT_NOTICE),
    { ...response(), tool_calls: group("bad")[0].tool_calls },
    { role: "user", content: "wrong role" },
  ]) {
    const messages = history(),
      before = structuredClone(messages),
      state = fresh();
    await assert.rejects(
      compactHistory(messages, state, async () => value, signal()),
      /invalid or incomplete/,
    );
    assert.deepEqual(messages, before);
    assert.deepEqual(state, fresh());
  }
  const messages = history(),
    before = structuredClone(messages),
    controller = new AbortController();
  await assert.rejects(
    compactHistory(
      messages,
      fresh(),
      async () => {
        throw Error("backend unavailable");
      },
      signal(),
    ),
    /backend unavailable/,
  );
  await assert.rejects(
    compactHistory(
      messages,
      fresh(),
      async () => {
        controller.abort();
        return response();
      },
      controller.signal,
    ),
    /abort/i,
  );
  assert.deepEqual(messages, before);
});

test("summary requests are bounded and never silently drop an oversized group", async () => {
  const messages = history();
  messages[3].tool_calls[0].function.arguments = '\\"'.repeat(270000);
  let input;
  await assert.rejects(
    compactHistory(
      messages,
      fresh(),
      async (value) => {
        input = value;
        return response();
      },
      signal(),
    ),
    (error) =>
      /did not reduce/.test(error.message) &&
      compactionFailure(error) === "the summary did not reduce the context",
  );
  assert(JSON.stringify(input).length <= MAX);
  assert(!JSON.parse(input[1].content).history.some((m) => m.tool_calls));
  assert.throws(
    () =>
      contextMessages(messages, {
        ...fresh(),
        through: messages.length + 1,
        summary: "bad",
      }),
    /checkpoint/,
  );
  assert.throws(() => compactionStateSchema.parse({ summary: "bad" }));
});

test("automatic thresholds use reported usage or serialized size, and respect the session toggle", () => {
  const messages = history(),
    state = fresh();
  assert.equal(shouldAutoCompact(messages, state), false);
  assert.equal(
    shouldAutoCompact(messages, state, { used: 799, size: 1000 }),
    false,
  );
  assert.equal(
    shouldAutoCompact(messages, state, { used: 800, size: 1000 }),
    true,
  );
  assert.equal(
    shouldAutoCompact(
      messages,
      { ...state, automatic: false },
      { used: 900, size: 1000 },
    ),
    false,
  );
  const large = [...messages, assistant("x".repeat(700000))];
  assert.equal(shouldAutoCompact(large, state), true);
  assert.equal(
    shouldAutoCompact([user("new session")], state, { used: 900, size: 1000 }),
    false,
  );
});

test("summary requests use fixed low reasoning, a capped reply and room for it in the window", () => {
  // Ranked by the reasoning_effort levels, not declaration order or default.
  const efforts = reasoningChoices({
    provider_model_controls: {
      reasoning_effort: {
        default: "xhigh",
        options: { xhigh: {}, none: {}, medium: {}, low: {}, high: {} },
      },
    },
  });
  assert.deepEqual(summaryReasoning("m", efforts), { reasoning_effort: "low" });
  // A thinking-only cut-off is asked again one ranked level lower, never at Off.
  const lower = (value) =>
    lowerEffortChoice(efforts, JSON.stringify(["reasoning_effort", value]))
      ?.effort;
  assert.deepEqual(
    ["xhigh", "high", "medium", "low", "none", "unknown"].map(lower),
    ["high", "medium", "low", undefined, undefined, undefined],
  );
  assert.equal(
    lowerEffortChoice(
      reasoningChoices({
        provider_model_controls: {
          reasoning_effort: { options: { deep: {}, quick: {} } },
        },
      }),
      JSON.stringify(["reasoning_effort", "deep"]),
    ),
    undefined,
  );
  assert.deepEqual(
    summaryReasoning(
      "m",
      reasoningChoices({
        provider_model_controls: {
          reasoning_effort: { options: { minimal: {}, low: {}, none: {} } },
        },
      }),
    ),
    { reasoning_effort: "minimal" },
  );
  // Levels without a known order fall back to the server's declared default.
  assert.deepEqual(
    summaryReasoning(
      "m",
      reasoningChoices({
        provider_model_controls: {
          reasoning_effort: {
            default: "quick",
            options: { deep: {}, quick: {} },
          },
        },
      }),
    ),
    { reasoning_effort: "quick" },
  );
  assert.deepEqual(
    summaryReasoning(
      "m",
      reasoningChoices({
        info: {
          params: {
            model_controls: {
              thinking: { default: "quick", options: { deep: {}, quick: {} } },
            },
          },
        },
      }),
    ),
    { params: { model_controls: { m: { thinking: "quick" } } } },
  );
  assert.deepEqual(summaryReasoning("m", reasoningChoices({})), {});

  // The owner's reported window: 100,768 tokens, no advertised output limit.
  const owner = summaryRequest(
    "m",
    { context_window: 100768 },
    12288,
    efforts,
    4,
  );
  assert.deepEqual(owner.extra, { reasoning_effort: "low", max_tokens: 6000 });
  assert.equal(owner.summaryChars, 12000);
  assert.equal(owner.maxInputChars, Math.floor((100768 - 12288) * 4 * 0.9));
  assert(owner.maxInputChars / 4 + owner.maxTokens <= 100768);
  // A smaller advertised allowance lowers the cap and the requested length.
  const small = summaryRequest(
    "m",
    { context_window: 100768, max_output_tokens: 3000 },
    12288,
    [],
    4,
  );
  assert.deepEqual(small.extra, { max_tokens: 3000 });
  assert.equal(small.summaryChars, 6000);
  // An input limit equal to the window still leaves room for the capped reply.
  assert.equal(
    summaryRequest(
      "m",
      { context_window: 10000, max_input_tokens: 10000 },
      12288,
      [],
      2,
    ).maxInputChars,
    Math.floor((10000 - 6000) * 2 * 0.9),
  );
  assert.equal(
    summaryRequest("m", { id: "m" }, 12288, [], undefined).maxInputChars,
    undefined,
  );
});

test("a cut-off or overlong summary is retried once over fewer older messages", async () => {
  const historyLength = (input) => JSON.parse(input[1].content).history.length;
  const cutOff = async () => {
    throw new ModelReplyError("truncated", OUTPUT_LIMIT_CUTOFF);
  };
  for (const first of [cutOff, async () => response("x".repeat(16001))]) {
    const inputs = [];
    const next = await compactHistory(
      history(),
      fresh(),
      async (input) => {
        inputs.push(input);
        return inputs.length === 1 ? first() : response();
      },
      signal(),
    );
    assert.equal(inputs.length, 2);
    assert(JSON.stringify(inputs[1]).length < JSON.stringify(inputs[0]).length);
    assert(historyLength(inputs[1]) < historyLength(inputs[0]));
    assert.equal(next.count, 1);
    // The checkpoint falls on a complete group boundary.
    assert(next.through > 0 && contextMessages(history(), next).length > 0);
  }
  // The retry is the only one: a second cut-off fails with that reason.
  let calls = 0;
  await assert.rejects(
    compactHistory(
      history(),
      fresh(),
      async () => {
        calls++;
        return cutOff();
      },
      signal(),
    ),
    (error) =>
      compactionFailure(error) ===
      "the summary was cut off at the output limit",
  );
  assert.equal(calls, 2);
  // Other failures are not retried.
  for (const [value, reason] of [
    [response(""), "the summary was empty"],
    [
      { ...response(), tool_calls: group("bad")[0].tool_calls },
      "the summary reply contained tool calls",
    ],
  ]) {
    calls = 0;
    await assert.rejects(
      compactHistory(
        history(),
        fresh(),
        async () => {
          calls++;
          return value;
        },
        signal(),
      ),
      (error) => compactionFailure(error) === reason,
    );
    assert.equal(calls, 1);
  }
});

test("compaction failure reasons name the cause without reply content", () => {
  assert.equal(
    compactionFailure(new BackendHttpError(500, "Backend failed (HTTP 500)")),
    "the summary request was refused (HTTP 500)",
  );
  assert.equal(
    compactionFailure(
      new BackendHttpError(400, "Backend failed (HTTP 400): context_too_long"),
    ),
    "the summary request was refused (HTTP 400: context_too_long)",
  );
  assert.equal(
    compactionFailure(new BackendHttpError(429, "Rate limited; try later")),
    "the summary request was refused (HTTP 429: Rate limited; try later)",
  );
  assert.equal(
    compactionFailure(new ModelReplyError("truncated", "Truncated stream")),
    "the summary reply ended before it finished",
  );
  assert.equal(
    compactionFailure(new ModelReplyError("malformed", "Malformed completion")),
    "the summary reply was malformed",
  );
  assert.equal(
    compactionFailure(new Error("The model stream stalled for 300 s")),
    "The model stream stalled for 300 s",
  );
});

test("compaction never embeds private reasoning in summary text and retains it only with surviving assistant messages", async () => {
  const messages = history();
  for (const m of messages)
    if (m.role === "assistant") m.reasoning_content = "private-provider-state";
  const original = structuredClone(messages);
  const next = await compactHistory(
    messages,
    fresh(),
    async (input) => {
      assert.equal(
        JSON.stringify(input).includes("private-provider-state"),
        false,
      );
      assert.equal(JSON.stringify(input).includes("reasoning_content"), false);
      return response();
    },
    signal(),
  );
  assert.deepEqual(messages, original);
  const context = contextMessages(messages, next);
  assert(
    context.some(
      (m) =>
        m.role === "assistant" &&
        m.reasoning_content === "private-provider-state",
    ),
  );
  assert.equal(
    context
      .filter((m) => m.role !== "assistant")
      .some((m) => m.content?.includes("private-provider-state")),
    false,
  );
});
