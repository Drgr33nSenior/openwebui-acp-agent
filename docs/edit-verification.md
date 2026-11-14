# Targeted-edit comparison

## Task and method

The synthetic fixture in `test/fixtures/edit-task.mjs` contains three Python
modules of roughly 350–380 lines and six unit tests. Six function bugs require
edits while large data tables, signatures and tests must remain intact. The fixed
prompt asks the agent to run tests before and after its changes. It does not
require any particular editing tool.

`test/manual-edit-benchmark.mjs` is an explicit live runner, excluded from ordinary
tests. Run it once for each build against the same signed-in model:

```sh
node test/manual-edit-benchmark.mjs --live /absolute/released-package baseline
node test/manual-edit-benchmark.mjs --live /absolute/modified-checkout after
```

The runner uses fresh scratch workspaces and private application state. The child
agent uses its normal OS credential store; the runner does not retrieve a key or
read/copy the user's `auth-state.json`. No user project is used. It approves only
scratch activation, file edits and workspace-sandbox commands without scope
expansion; network requests are denied. No MCP servers are loaded. A 15-minute
deadline cancels the turn. The report records request/tool counters, bounded
sanitized errors, test outcomes and unchanged fixture data. Local transcripts
remain in scratch state; they are not committed.

## Live results, 14 November 2026

Both builds used the same normally configured model and installation. The baseline
was the installed 0.5.0 package; the changed build branched from `45e4088`. Tests
ran on macOS 27.0 with Node 26.11.1. Private deployment and model identifiers are
omitted.

| Metric | 0.5.0 baseline | Changed build, completed run |
| --- | --- | --- |
| Inference requests / logical rounds | 8 / 8 | 9 / 9 |
| Tool calls | 16 | 13 |
| Output cut-offs / recovery attempts | 0 / 0 | 0 / 0 |
| Model failures | None | None |
| Tool failures | Initial test command: six expected failures | Initial test command plus two recoverable errors below |
| Final tests | Six passed | Six passed |
| Elapsed | 79.180 s | 36.854 s |
| Latest context usage | 39,408 tokens, prompt + completion | 39,080 tokens, prompt + completion |
| Separate prompt-token count | Unavailable | Unavailable |

Baseline tools: `list_files` 1, `read_file` 4, `run_command` 3, `update_plan` 2,
`search_text` 6. It used an inline Python replacement script through
`run_command`, with no `write_file` calls. Its recorded command results were six
failing tests, a successful replacement command, then six passing tests. The
fixture data tables, public function signatures and test file remained unchanged.

Changed-build tools: `list_files` 1, `read_file` 4, `run_command` 3, `edit_file` 5.
Four edits succeeded. One edit returned `old_string matched 0 occurrences`; the
model corrected its blank-line mismatch and continued. The first command returned
exit 127 because the model put the complete command in the executable field.
It then supplied separate arguments, observed six failing tests, applied the
repairs and observed six passing tests. Data tables, public signatures and tests
remained unchanged.
There were no stale full-file writes or output-limit failures in either run.

Two earlier changed-build attempts returned HTTP 503
`requested_model_unavailable` before tools executed (1.297 s and 0.923 s, one
request each). ACP returned `end_turn` with an error; that stop reason alone is
not task success. The completed run used a fresh copy of the same fixture after
backend availability recovered. No service configuration was changed.

Both builds completed this task. The baseline did not reproduce the reported
stale-write failures; it used a command-based workaround. The changed build used
the new editing path with fewer tools and shorter elapsed time, but one more
model round and more recoverable tool errors. This single pair is not a general
quality, speed or token-efficiency result. Latest context usage is not total
billed input tokens. The live run preceded the final distinction between argument
errors and response/state schema errors; it did not exercise either schema-error
case. Deterministic tests cover that distinction and the security cases separately.

## Restricted incident evidence

Only tool names, argument keys and first result lines were inspected from the
user-designated saved session. At inspection it contained 180 calls, including
32 `write_file` calls, 18 stale-edit failures and one unknown `edit_file` call.
The supplied prompt described an earlier total of 170. No claim is made about
the difference. No project content, argument values or session transcript was
copied into this fixture or document. The raw-validation details in the prompt
were reproduced with synthetic test inputs instead of expanding that inspection.
