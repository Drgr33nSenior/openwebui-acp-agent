# Recorded runtime-verification runs

These are live scratch-workspace observations from 14 November 2026. The fixed
prompts are in `test/fixtures/runtime-tasks.json`; setup, versions and limitations
are in [the evidence record](runtime-verification.md). Commands and tool results
below are trimmed, with private paths replaced by workspace-relative names.
No generated application code was added to this repository.

## Counts and outcomes

Tool calls count model-requested operations, including failed/invalid attempts.
They exclude workspace/MCP activation. Permission counts include activation and
network decisions. Durations include agent startup and shutdown, exclude human
approval delay, and are not controlled latency measurements.

| Task                  | Baseline 0.4.1: calls / permissions / seconds | Final: calls / permissions / seconds | Observed outcome                                                                                                                                                           |
| --------------------- | --------------------------------------------- | ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Browser game          | 8 / 7 / 29.8                                  | 13 / 12 / 85.8                       | Before: wrote/read code; browser connection failed. After: actual script executed against a DOM stub, 12 assertions passed. No browser play-through in either run.         |
| CLI bad input         | 9 / 10 / 23.8                                 | 14 / 11 / 60.7                       | Both executed valid/invalid inputs. Before: six runs. After: eight runs including zero and large integers. The final run was slower and included two rejected stale edits. |
| Regression first      | 21 / 8 / 57.3                                 | 12 / 8 / 32.1                        | Both demonstrated failing tests before the fix, then four passing tests. Full-file edit clarification reduced rejected edit attempts in this observation.                  |
| Current documentation | 9 / 11 / 44.3                                 | 8 / 10 / 45.4                        | Both retrieved the official page, supplied an example and cited it. Neither executed the example.                                                                          |

An intermediate repeat, before the full-file error clarification, is retained
rather than omitted: game **3 / 4 / 24.1**, CLI **12 / 13 / 38.3**, regression
**25 / 8 / 99.2**, documentation **10 / 12 / 32.1**. Its game requested an
unsandboxed server; the client declined it and the agent stopped and disclosed
the missing verification. Its regression task repeatedly missed the trailing
newline, then passed five tests. This led to the edit-contract clarification.
The final repeat used fresh workspaces and the same four prompts again.

This is one observation per task per revision, with normal backend sampling and
shared service load. More tool calls, longer duration or `end_turn` are not
quality scores. The baseline already performed meaningful checks in three tasks.
No live OpenCode result is available, so there is no cross-agent performance
claim. No reasoning setting was changed or its effect established.

## Browser game

Baseline sequence:

```text
list_files → []
write_file index.html → completed
browser_navigate file:///home/user/project/index.html → permission declined
run_command python3 -m http.server 8765 --directory /home/user/project
  background job → socket bind: Operation not permitted; exit 1
browser_navigate http://localhost:8765/index.html → ERR_CONNECTION_REFUSED
poll_job → failed, exit 1
read_file index.html; write_file README.md → completed
final response: live click-test could not be performed
```

The invented project path was wrong. Container localhost was also wrong, and
the socket-bind restriction independently blocked the server. The browser error
arrived as MCP `isError: true` inside a completed tool response; it was not a
successful navigation. No click tools were used.

Final sequence:

```text
list_files; write_file index.html → completed
run_command python3 -m http.server 8000 (background, timeout 5000 ms)
  socket bind: Operation not permitted; exit 1
poll_job → failed
run_command pwd → actual workspace
browser_navigate file://[SCRATCH]/browser-game/index.html → permission declined
run_command node --version → v26.11.1
write_file test_game.js → extracts index.html script into a minimal DOM stub
run_command node test_game.js → exit 0; 12 passed, 0 failed
write_file test_game.js → empty; run_command rm -f test_game.js → exit 0
list_files; write_file README.md → completed
final response: logic checked; full browser visual/click-through not verified
```

The assertions exercised initial visibility/score, target clicks before Start,
Start, three target clicks and Restart. They executed the actual page script but
cannot establish browser rendering, browser event semantics or accessibility.
The model still incorrectly inferred that the browser shared the host filesystem
before the denied navigation. Guidance did not eliminate that mistake. The
temporary test was removed by the model; its code and output remain in the local
ACP transcript, not as a delivered regression test. The failed jobs had already
exited; these runs do not demonstrate successful server→browse→stop orchestration.

## CLI bad input

Baseline opened no existing source files; it created `sum.mjs` and `README.md`.
Final read `sum.mjs` twice, created the CLI, and put usage in its final answer.

```text
Baseline, node sum.mjs:
  3 7     → 10, exit 0
  -4 9    → 5, exit 0
  3       → short error/usage, exit 1
  <none>  → short error/usage, exit 1
  abc 5   → short error/usage, exit 1
  3.5 2   → short error/usage, exit 1

Final, node sum.mjs:
  2 3     → 5, exit 0
  -7 3    → -4, exit 0
  0 0     → 0, exit 0
  1234567890123456789 1234567890123456789
          → 2469135780246913578, exit 0
  <none>, 10 5 extra, 1.5 3, abc 3
          → short error/usage, exit 1 in each run
```

The final source used BigInt and strict integer validation. Tool output combines
stdout/stderr; code inspection of the generated source confirms error writes to
stderr. The ACP results alone do not distinguish those streams. Two attempts to
add a help flag failed stale-content checks; the final file retained the working
CLI. These attempts are included in the counts.

## Regression first

Both runs opened `package.json`, `clamp.js` and `clamp.test.js`, added tests, ran
them before editing `clamp.js`, then reran after the fix.

```text
Baseline:
  search_text/list_files; six read_file calls
  seven write_file attempts; four update_plan calls
  npm test → exit 1; upper boundary passed, three new cases failed
  write_file clamp.js → completed
  npm test → exit 0; four passed

Final:
  list_files/search_text; four read_file calls
  three write_file attempts; no update_plan call
  run_command → validation rejected unjustified scope expansion; no process
  npm test → exit 1; upper boundary passed, three new cases failed
  write_file clamp.js → completed
  npm test → exit 0; four passed
```

Both runs declined two attempted npm registry network connections; local tests
still ran. The final `before` text initially missed the newline once, then the
model corrected it. No stale edit bypass was added. The final run omitted a
structured plan, despite unchanged planning guidance.

## Current documentation

Both runs navigated to the requested official Node.js test-runner page, read
accessibility snapshots and searched within the page. No workspace files or
command tools were used. Both returned a timer/Date example using
`context.mock.timers.enable`, `tick()` and `node --test`, with official citations.

```text
Baseline:
  browser_navigate https://nodejs.org/api/test.html
  browser_wait_for → tool error (snapshot lookup was still possible)
  browser_snapshot ×2; browser_find ×4; browser_close

Final:
  browser_navigate https://nodejs.org/api/test.html
  browser_find ×4: mock timers, now, working together, queueMicrotask
  browser_snapshot ×3: targeted documentation sections
  answer: explanation, minimal example, run command and official links
```

The live page identified itself as Node.js v26.13.1 documentation. The installed
runtime was v26.11.1. Retrieval proves access to current sources, not that every
sentence is correct or the example works on all Node releases; answer accuracy
was not independently scored. Browser shutdown occurred when each turn closed
its MCP session, including the final run without an explicit browser-close call.

## Remaining work

- Design and test a narrowly approved application preview host and browser-origin
  boundary before reducing localhost/snapshot approvals.
- Repeat these tasks across more runs and available models before claiming a
  quality or latency improvement. The CLI and game took longer in the final run.
- Run the identical task set through OpenCode when it is available, keeping the
  same model, prompts and permission scope, and record those differences.
- Perform interactive IDE acceptance separately. These runs used a local ACP test
  client, not JetBrains UI automation. No release or IDE installation was changed.
