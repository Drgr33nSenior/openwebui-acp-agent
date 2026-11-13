import test from "node:test";
import assert from "node:assert/strict";
import {
  compactionStateSchema,
  contextMessages,
  compactHistory,
  shouldAutoCompact,
} from "../dist/compaction.js";
import { MAX, OUTPUT_LIMIT_NOTICE } from "../dist/backend.js";

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
    /did not reduce/,
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
