# Testing and compatibility

## OpenMettle branding (unreleased)

The rename is based on main `f219d6e`. It changes package, executable, ACP/MCP
metadata, proposed registry identity and repository links to OpenMettle ACP.
The legacy executable alias, credential service, configuration directory,
environment variables and fixed policy paths are retained. The original MIT
copyright notice is unchanged. No dependency versions changed.

On macOS 27.0 with Node 26.11.1, `npm ci --ignore-scripts`, lint, typecheck,
Prettier, build and the full suite passed: **561 tests, 553 passed, eight skips,
zero failures**. The renamed tarball installed outside the checkout and passed
the ACP metadata, both executable-alias, authentication-discovery and real
sandbox checks. The installed production audit found zero vulnerabilities.

The GitHub repository transfer preserved the repository ID and the existing
0.6.0 release and asset IDs. Its public tarball downloaded from the new address
with the original SHA-256 digest. No renamed release or npm package was
published, and the installed IDE agents were not replaced by this branch.

## Automated checks

Use the pinned Node release from `.node-version` and a private temporary
`OPENWEBUI_ACP_HOME` set before starting Node. Tests create their own isolated
state and fake Open WebUI/MCP services. No real API key or deployment is required.

```sh
npm ci
npm run lint
npm run typecheck
npm test
npm run build
npm pack
npx --no-install prettier --check src test package.json package-lock.json registry/agent.json
npm audit --omit=dev --audit-level=high
```

`npm test` builds before running `test/*.test.mjs`. For a focused test, build first
and use `node --test test/NAME.test.mjs`. Real sandbox tests need local listener
and process permissions; outer sandboxes can prevent those checks from running.
Do not replace enforcement failures with silent skips.

Install the packed artifact into a fresh prefix outside the checkout. For a
public release, first download the `.tgz` and verify it against `SHA256SUMS` from
GitHub Releases:

```sh
npm install --prefix /path/to/isolated-install --ignore-scripts ./openwebui-acp-agent-0.6.0.tgz
npm audit --prefix /path/to/isolated-install --omit=dev --audit-level=high
node test/package-install.mjs /path/to/isolated-install
```

The installed-package check covers ACP stdout/handshake, terminal authentication
and logout discovery, context reporting and real command isolation. Dependency
compatibility must also hold in the installed bundled runtime tree.

The suite covers protocol/authentication, stream parsing, tool validation,
permissions, workspace boundaries, redaction, MCP, commands, queue/interruption,
verification repair limits, context masking, compaction, jobs, checkpoints,
scoped instructions and session listing/fork/export. Browser wrapper tests and
the optional container fixture smoke are described in [browser setup](browser.md).

`test/manual-context-benchmark.mjs` is an offline comparison, excluded from
ordinary tests. A scripted fake model replays one 60-round session against a
built checkout and reports summed and peak prompt size, compactions, mask
batches and how much of each request a prefix cache would have to evaluate
again. Sizes are serialized characters divided by 3.75, not tokenizer counts.
It needs no model and writes only to a temporary directory. Run it with the
pinned Node release, once per build to compare:
`node test/manual-context-benchmark.mjs CHECKOUT`.

## Long-session benchmark

The long-session benchmark gives a built agent a task and records how the
session went. It has two tasks: `long`, a synthetic Python project, and `game`,
a browser game with hidden acceptance checks. It uses a real model, so it is
excluded from ordinary tests and runs only when started explicitly.

| File                                         | Purpose                                                                       |
| -------------------------------------------- | ----------------------------------------------------------------------------- |
| `test/manual-long-benchmark-fixture.mjs`     | `long` task: 14 modules, 28 seeded bugs, 126 unittest tests                   |
| `test/fixtures/long-benchmark-game/`         | `game` task: sealed acceptance source (brief, hidden play-through, references) |
| `test/manual-long-benchmark-game.mjs`        | `game` evaluator: seal, play-through, judge, PLAN-04 checker, play-test, probes |
| `test/manual-long-benchmark-game-driver.mjs` | Browser driver that the evaluator runs in the browser container               |
| `test/manual-long-benchmark.mjs`             | Runner: one ACP session against the agent built in a checkout                 |
| `test/manual-long-benchmark-wait.mjs`        | Wrapper for a shared server: overnight window and idle check, then runner     |
| `test/manual-long-benchmark-summary.mjs`     | Markdown table of runs, with a mean row per build                             |
| `test/long-benchmark.test.mjs`               | Offline self-test of the kit and the `long` task, part of `npm test`          |
| `test/long-benchmark-game.test.mjs`          | Offline self-test of the `game` task, part of `npm test`                      |

### Offline self-test

`node --test test/long-benchmark.test.mjs` needs a built checkout and, for the
fixture checks, `python3`. It checks that the fixture is deterministic, that
its buggy version fails exactly the 28 seeded tests and that its fixed version
passes all 126. It also runs the runner against a loopback fake model that
plays a fixed sequence of tool calls, and checks the report, the summary,
wrapper settings validation, metrics parsing and the start rules. It contacts
no model or remote host. It uses a synthetic key and temporary state.

`node --test test/long-benchmark-game.test.mjs` covers the `game` task; see
[interactive game task](#interactive-game-task).

### Live run

The runner copies only non-secret fields (`url`, `model`, `header` and the
timeouts) from the agent's `config.json` into fresh scratch state and sets 100
rounds per prompt. The child agent authenticates normally: through the OS
credential store, or through `OPENWEBUI_API_KEY` if that variable is already
set. The runner never reads or copies `auth-state.json`. It approves workspace
activation, edits and commands inside the workspace sandbox, and denies anything
else. When a turn ends at the tool-call limit, it sends "Continue with the
remaining work." up to eight times. When an edit is blocked by the checkpoint
budget, it sends `/checkpoints clear` first. The workspace and state stay in a
scratch directory, which the runner prints. Results go to
`$LONG_BENCHMARK_RESULTS/LABEL`; a label that already has a report is refused.

On a shared inference server, start runs through the wrapper. It checks two
separate services: SGLang, and service-tools, the separate MCP, media and
research service. Every site setting comes from the environment and has no
default. service-tools has its own settings; none is derived from the SGLang
ones.

| Variable                         | Meaning                                                              |
| -------------------------------- | -------------------------------------------------------------------- |
| `LONG_BENCHMARK_SSH`             | ssh destination (`user@host` or a host alias) that can run `kubectl` |
| `LONG_BENCHMARK_NAMESPACE`       | Kubernetes namespace of the SGLang service                           |
| `LONG_BENCHMARK_SERVICE`         | SGLang service name                                                  |
| `LONG_BENCHMARK_METRICS_PORT`    | SGLang port that serves `/metrics`                                   |
| `LONG_BENCHMARK_TOOLS_NAMESPACE` | Kubernetes namespace of the service-tools service                    |
| `LONG_BENCHMARK_TOOLS_SERVICE`   | service-tools service name                                           |
| `LONG_BENCHMARK_TOOLS_PORT`      | service-tools port that serves `/health` and `/metrics`              |
| `LONG_BENCHMARK_RESULTS`         | Absolute results directory, outside the checkout                     |
| `LONG_BENCHMARK_NOT_BEFORE`      | Optional. Earliest start, ISO time with `Z` or an offset             |
| `LONG_BENCHMARK_IDLE_SECONDS`    | Optional. Quiet period before the start; default 300, minimum 60     |

```sh
LONG_BENCHMARK_SSH=... LONG_BENCHMARK_NAMESPACE=... LONG_BENCHMARK_SERVICE=... \
LONG_BENCHMARK_METRICS_PORT=... LONG_BENCHMARK_TOOLS_NAMESPACE=... \
LONG_BENCHMARK_TOOLS_SERVICE=... LONG_BENCHMARK_TOOLS_PORT=... \
LONG_BENCHMARK_RESULTS=/absolute/results \
LONG_BENCHMARK_NOT_BEFORE=2026-11-16T20:00:00Z \
  node test/manual-long-benchmark-wait.mjs new-1 /path/to/agent-checkout 30 [long|game]
```

Each sample is one ssh command that only reads. It runs `kubectl get svc` for
both service addresses and `kubectl get endpointslices` for service-tools. It
then reads SGLang `/metrics` and service-tools `/health` and `/metrics` with
`curl`. A sample is idle only when all of the following hold:

| Source                  | Idle when                                                                                                                                                                                          |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SGLang `/metrics`       | `num_running_reqs` and `num_queue_reqs` are both zero (rank 0 when ranks are labelled)                                                                                                             |
| service-tools endpoints | exactly one endpoint, and it is ready                                                                                                                                                              |
| service-tools `/health` | `requests.active` is 0; `status` is `process-ready`; `image_active` is 0; `image_busy`, `image_recovery_required` and `video_active` are false; `deep_research.active` and `kv_tail.jobs` are 0 or the feature is disabled |
| service-tools `/metrics` | every `workstation_assistant_active_requests{route}` is 0, and `workstation_assistant_requests_started_total{route}` equals `requests.started_total` from `/health`                               |
| previous sample         | the same service-tools process (`process_started_unix_seconds`), the same `requests.started_total` on every route, and the same total of the `workstation_assistant_*` counters and histogram counts |

**The wrapper requires the service-tools request lifecycle.** The lifecycle
counts every request on the work routes (`/mcp`, the picture adapter, web search
and fetch) from its start until its response ends, including a streamed answer.
It reports the count in flight and the count started per route (`image`, `mcp`,
`web`), and the process start time. `/health` and `/metrics` are not counted.
With no request in flight at two samples and no start between them, no request
ran in between. The outcome counters alone cannot show that: a call that is
still running has not been counted yet. The lifecycle comes from PLAN-01. It is
not in the deployed service-tools as of this change, so every sample is
unavailable and the wrapper does not start until a service-tools with the
lifecycle is deployed. The gateway's active-request gauge belongs to a
different service and is not used.

A sample is unavailable, never idle, if:

- any read fails;
- a request gauge is missing;
- there is not exactly one ready service-tools endpoint;
- a `/health` field is missing or has an unexpected type;
- the lifecycle is missing from `/health` or `/metrics`, its route set is not
  exactly `image`, `mcp` and `web`, or the per-route counts do not add up to
  `requests.active`;
- `/health` and `/metrics` report different process start times (the metric
  has a 12-digit precision, so the wrapper allows 0.01 s);
- the service-tools `/metrics` page lacks its families.

A different process between two samples, a started request or a counter change
makes the sample busy. The remaining limits of this observation:

- One ready endpoint means one pod. If that pod runs more than one service-tools
  process, each process reports only its own requests; the wrapper cannot see
  the others.
- Work that is not on a work route and not in the `/health` media, research and
  KV-tail fields is not observed.
- The observation ends at the last sample. A request that starts after it is
  not prevented; the samples during the run report it as other load.

An unavailable or busy sample restarts the quiet period. The wrapper starts the
runner only when:

- the local time is between 20:00 and 07:00, and the run can end, with its
  timeout and a five-minute margin, before 07:00;
- the not-before time, if set, has passed (the wrapper waits for it);
- every 30-second sample for the whole quiet period was idle.

If the window closes first, the wrapper exits with status 3, so a loop over
labels can stop:

```sh
for label in base-1 new-1 base-2 new-2; do
  case $label in base-*) dir=/path/to/base ;; *) dir=/path/to/new ;; esac
  node test/manual-long-benchmark-wait.mjs "$label" "$dir" 30 || [ $? -ne 3 ] || break
done
```

During the run the wrapper samples both services every 15 seconds
(`running-samples.txt`). It saves service-tools `/health` before and after the
run (`tools-health-*.json`) and SGLang counter changes (`sglang-delta.json`).
It writes `wrapper.json` with the runner's exit status, whether other load was
seen and the service-tools observation identity: one ready endpoint, and the
process start time and started-request counts before and after the run. Other
load means:

- on SGLang, more than one running request or any queued request;
- on service-tools, any request or background work in flight, a started
  request, a counter change or a different process, since the benchmarked agent
  does not call service-tools.

The self-test covers the parsing, the idle, busy and unavailable decisions and
the start rules with synthetic metrics, health and endpoint output. This
includes a service-tools without the lifecycle that never starts a run. It also
checks that the remote command passes `sh -n` and uses only read operations.
The ssh, `kubectl` and `curl` reads have not been run against a real cluster.
If a network policy blocks the ssh host from service-tools, every sample is
unavailable and the wrapper never starts.

### Report and summary

`report.json` records, per run:

- **Hidden checks**: for `game`, the PLAN-04 verdict (`accepted`, `rejected`
  or `unavailable`) with the number of hidden checks passed, failed and
  unavailable, the reasons, and the checker, specification and seal digests.
  `null` (not applicable) for `long`, whose tests are visible to the agent;
  there the runner runs the suite itself after the session (`finalSuite`) and
  checks that the data tables and tests are unchanged.
- **Rounds**: coding requests minus single recoveries (`logicalRounds`), plus
  summary requests and turns.
- **Failed tool calls**: total, by tool (`toolFailuresByTool`), by tool and
  failure (`toolFailures`, with command exits grouped by exit code), non-zero
  command exits and checkpoint blocks.
- **Tokens**: prompt, completion and reasoning tokens as the server reported
  them, read from a copy of each response, with the number of requests that
  reported each count. Nothing is estimated.
- **Identity**: model ID, rounds, request timeouts, agent commit and version.
  The backend address is not recorded.
- **Wall time** (`elapsedMs`), peak and latest context usage, compactions and
  mask batches.
- **`view_image`**: calls and failed calls.
- **Unprompted play-test**: for `game`, whether the agent played its game
  without being asked (`observed`), and whether it did so after its last edit
  (`afterLastEdit`); `null` (not applicable) for `long`.
- For `long`: reads, repeat reads, edits, test runs and whether the full suite
  ran after the last edit. For `game`: the isolation probe results, the
  evaluator identity and reference outcomes, denied operations and MCP tool
  names.

```sh
node test/manual-long-benchmark-summary.mjs /absolute/results/base-1 /absolute/results/new-1
```

The summary shows `n/a` for values that do not apply to the task and `unknown`
for values the run did not record, such as token counts some requests did not
report or metrics from a run without the wrapper. A token sum with partial
coverage is shown as a lower bound. Means use only known values and state how
many runs they cover. Reports from earlier versions of the runner can be
summarised; their new fields show as `unknown`.

### Interactive game task

The `game` task gives the agent a brief for a browser game, Lights Out, and
judges the result with hidden acceptance checks. It measures whether the agent
plays its game without being asked and whether the game meets the brief.

**Acceptance source.** `test/fixtures/long-benchmark-game/` is a task
acceptance source in the PLAN-04 contract, schema 1. It holds the
specification (`acceptance.json`), the agent-visible fixture (`fixture/BRIEF.md`
only), the hidden play-through script (`playthrough.json`), a trusted reference
game (`reference/`) and six known-bug games (`mutants/`). Its seal is pinned in
`GAME_SEAL` in `test/manual-long-benchmark-game.mjs`, outside the source and
every workspace. A changed byte changes the seal, and the runner then refuses
the source. The specification declares the oracle not applicable: the
play-through runs in the evaluator, which writes its observation as the
external-state file. The external-state checks require each hidden check to be
`true`. The deliverable is `index.html`, and the linkage check requires the
observation's `entry_sha256` to equal the checker's own digest of that file.

**Brief.** The prompt asks the agent to build the game described in
`BRIEF.md` and to summarise what it built. Neither the prompt nor the brief
asks the agent to test, preview, play or screenshot the game; the self-test
checks this. The brief states the rules and the page structure that the
play-through reads (element ids, `data-row`, `data-col`, `aria-pressed`).

**Play-through.** The evaluator sends the produced files, from memory, to
`test/manual-long-benchmark-game-driver.mjs` in a real Chromium. The driver
serves them on one fixed origin and aborts and counts every other request. It
reads the page only through Playwright locator methods (attributes, text,
disabled state); it runs no script of its own in the page. It takes PNG
screenshots at four steps. The evaluator compares the
observations with the hidden expectations: board layout, start state,
distinct lit colour, corner and edge moves, undo, solve, the lock after
solving, restart, page errors, external requests and screenshots. Before it
judges an attempt, it plays the reference (which must pass every check) and
each mutant (which must fail the checks it was built to break). If they do not
behave as declared, the play-through is unproven and the verdict is
`unavailable`.

The results directory receives `playthrough-state.json` (the observation),
`screenshots/*.png` and `acceptance-result.json` (the PLAN-04 result). Each
screenshot entry holds its SHA-256 and the digest of the exact files played
(`served_tree_sha256`). The runner then runs the PLAN-04 checker's `check` and
`validate` commands.

**Isolation.** The hidden source is in the scratch directory next to the
workspace and in the harness checkout. Before the evaluated session, the runner
proves that the agent cannot read or change it. A scripted fake model sends
tool calls through the same agent build, child process, permission policy,
sandbox and browser configuration as the evaluated session, from a sibling
workspace. The calls are:

- controls that must work: write, read and `cat` a workspace file;
- `read_file`, `view_image`, `edit_file` and `write_file` on the hidden source,
  by absolute and relative path;
- `list_files` and `search_text` on the parent directory;
- `run_command` with `cat`, `ls`, a symbolic link, a copy, an append and a new
  file, on the scratch copy and on the checkout copy;
- `start_preview` of a hidden file;
- `browser_navigate` to a `file://` URL of the hidden file, when the browser is
  configured.

Every probe other than the controls must fail without revealing the hidden
marker or file names, and the source seal must be unchanged afterwards. The
report keeps only the outcome and the first line of each refusal. The
boundary that this demonstrates:

- the file tools refuse paths outside the workspace;
- the command sandbox denies reads of the home directory, `/tmp`, `$TMPDIR` and
  the agent state, except the workspace;
- the runner approves no extra read or write paths and no escalation;
- the runner approves browser navigation only to a preview that the agent
  started;
- the preview serves only listed workspace files;
- the browser container mounts no host directory.

The evaluator plays the reference and mutants before the session and the
attempt after it ends, from memory; neither play-through uses the agent's tools
or leaves files in the browser container.

**Unprompted play-testing.** From the saved transcript, the runner counts a
play-test when the agent wrote a game file and then started a preview, opened
that preview in the browser, interacted with the page (click, key press, typing
or form input) and read it (snapshot, find or wait), all successfully.
`afterLastEdit` shows whether a complete play-test followed the last game-file
edit. Without the browser the behaviour cannot be measured and the run does not
start.

**Preconditions.** For `--task game` the runner checks the following before it
starts a session. If any of them fails, it writes the report with the reasons,
starts no session and exits with status 4:

| Variable                                   | Meaning                                                                                 |
| ------------------------------------------ | --------------------------------------------------------------------------------------- |
| `LONG_BENCHMARK_GAME_BROWSER`              | Evaluator browser: `container:NAME` (the browser container) or `local:/abs/chromium` (needs `npm ci --ignore-scripts` in `browser/`) |
| `LONG_BENCHMARK_ACCEPTANCE_CHECKER`        | Absolute path of `lib/workstation/task_acceptance.py` in a stack checkout               |
| `LONG_BENCHMARK_ACCEPTANCE_CHECKER_SHA256` | Optional. SHA-256 that `task_acceptance.py` must have                                   |
| `LONG_BENCHMARK_BROWSER_MCP_URL`           | The agent's browser: `http://127.0.0.1:PORT/mcp` of the browser container               |

The checker's own `seal` of the copied source must equal the pinned seal, the
reference and mutants must give their declared outcomes, and the isolation
probes must pass. The report records the evaluator transport, the SHA-256 of the
checker files, the reference outcomes and every probe result.

To check the evaluator browser without a model:

```sh
node test/manual-long-benchmark-game.mjs --check-browser container:NAME
```

The browser container workflow runs this check in CI. On macOS 27.0 with Node
26.11.1, a local Chromium run gave the declared outcomes: the reference passed
all 12 checks, and each mutant failed its declared check (`diagonal`:
`edge-move`, `solve`, `solved-locked`; `wraps`: `corner-move`, `edge-move`,
`solve`, `solved-locked`; `no-lock`: `solved-locked`; `undo-count`: `undo`,
`solve`, `solved-locked`; `restart-moves`: `restart`; `solved-text`: `solve`,
`solved-locked`).

**Self-test.** `test/long-benchmark-game.test.mjs` checks the seal, the brief,
the judge against a rule simulator of every mutant, play-test detection and
probe judging. It also runs the runner without an evaluator: the probes pass on
the platform and the run stops before a session. One test needs the checker
and an evaluator browser and is skipped in CI. With both set, it runs the full
`--task game` flow twice with a scripted model and a fake browser server:

- a model that writes the reference and plays it is `accepted` (13 passed) and
  the play-test is observed;
- a model that writes the `no-lock` mutant without playing it is `rejected`
  with `external_state:solved-locked`, and no play-test is observed.

**Limits.**

- The play-through checks the rules in the brief through the page structure
  that the brief requires; a game that draws without those elements fails.
- The checker is the merged PLAN-04 contract. Its protection corrections are
  in progress separately; re-pin the seal and rerun the self-test with the
  corrected checker.
- The probes demonstrate the boundary on the platform where they run. The
  runner repeats them before every evaluated session, on that machine.

## YOLO permissions

`test/yolo.test.mjs` checks one-time confirmation, rejected/invalid/late decisions,
actual unsandboxed commands, cancellation, cross-session revocation, safe restore
and fork, administrator restrictions, MCP filters and optional project checks.
Server-task tests cover YOLO approval and administrator overrides separately.
These fixtures use synthetic services and isolated temporary state. Live IDE
selector rendering and the confirmation flow still require manual acceptance.

## Server-tool version compatibility (0.4.1)

Discovery requires Open WebUI 0.9.0 or newer, records the actual version and
invalidates scoped task grants when it changes. Tests cover the minimum, newer
releases, prerelease/build suffixes, rejected older or malformed versions,
tool validation, discovery HTTP 403 errors and the exact `/api/v1/tools/` path.
The [source evidence](design.md#server-task-minimum-version) distinguishes the
0.8.12 and 0.9.0 endpoint and acknowledgement contracts. These checks do not
establish live compatibility with other Open WebUI releases. The changes are
not included in the published 0.4.0 artifact.

On macOS 27.0 with Node 26.11.1, lint, typecheck, build and the standard Prettier
check passed. `node --test test/*.test.mjs` passed 370 tests with six platform
skips and no failures. `npm pack` and the isolated installed-package check passed,
including discovery with a synthetic future version. Documentation audits found
no issues.

## Runtime verification guidance (0.5.0)

The harness refreshes entrypoint, failure-case, background-job, browser and
documentation guidance from each request's filtered tools. Tests cover absent
tools, separate MCP servers, missing interaction tools, server-search feature
gating, untrusted descriptions, Plan/read-only transitions and non-persistence.
The full-file edit description and stale-content error are also checked. Existing
browser permission tests still require approval for each call; the sandbox policy
test explicitly retains blocked local binding.

On macOS 27.0 and Node 26.11.1, `npm ci`, lint, typecheck, `npm test`, build,
Prettier and the production dependency audit passed: **372 tests passed, six
platform skips, zero failures; zero audit vulnerabilities**. An initial full-suite
invocation was intentionally interrupted and restarted with an explicit temporary
application-state directory; its partial result is not counted as a pass.
No Linux or Windows execution was performed locally for this revision.

`npm pack`, installation into a fresh temporary prefix and
`test/package-install.mjs` passed, including clean ACP/auth discovery and real
sandbox execution outside the checkout. The installed production dependency
audit also found zero vulnerabilities. Documentation clarity audits passed.
One repack attempt could not write the IDE-managed npm cache; it was retried with
the temporary cache. No cache ownership or IDE configuration was changed.

The [live comparison and source evidence](runtime-verification.md) distinguish
actual execution from source inspection and mocks. Live tests use normal agent
sign-in, isolated scratch workspaces and fixed prompts. OpenCode was unavailable
locally. At that revision the macOS sandbox blocked a dev-server listener, so
browser play-through was unverified. The static preview follow-up below covers
the missing hosting path without changing command socket permissions.

## Approved static preview (0.5.0)

`start_preview` serves only approved frontend files from an immutable snapshot;
`stop_preview`, turn completion, cancellation and expiry close the listener.
Tests cover denied/invalid/late approvals, revocation, interrupt-and-replace,
administrator denial, unsaved editor content, no fallback after editor denial,
path/symlink/hard-link boundaries, asset mapping, occupied ports, output/request
limits and HTTP Host/Origin/method checks. Plan/read-only tool catalogs omit
preview startup. The command sandbox still denies local binding.

On macOS 27.0 with Node 26.11.1, lint, typecheck, build, Prettier and the full
suite passed: **382 tests passed, six platform skips, zero failures**. An initial
attempt under the outer execution sandbox could not bind test listeners; the
suite passed with the permissions required for real sandbox tests. No agent
enforcement check was disabled. `npm ci` was already completed for this branch;
the dependency files are unchanged.

`npm pack`, installation into a fresh temporary prefix and
`test/package-install.mjs` passed, including preview startup/fetch/shutdown,
clean ACP/auth discovery and real command isolation outside the checkout.
Checkout and installed production audits found zero vulnerabilities. The first
audit attempt had no DNS access; the network-enabled retry passed. Documentation
clarity audits found no issues. The installed IDE agent remains unchanged.

The explicit `test/preview-browser.mjs` check passed through the actual ACP loop
with deterministic fake inference and the real configured Chromium container:
write files → approve preview → navigate → Start → score 1 → Restart → score 0
→ stop. It used 12 tools and 13 approvals, with no workspace server process.
The [browser guide](browser.md#starting-an-application-for-browser-checks)
documents static-only scope, resource limits and local-reader exposure.

Two signed-in live model attempts failed before coding with HTTP 503
`requested_model_unavailable`. Autonomous model play-through and interactive IDE
acceptance remain unverified. These tests ran on macOS; they do not establish
Linux container routing or Windows support. See the
[follow-up results](runtime-verification-results.md#static-preview-follow-up).

## 0.5.0 release candidate

On macOS 27.0 with Node 26.11.1, `npm ci --ignore-scripts`, lint, typecheck,
Prettier, build and `npm test` passed: 382 tests passed, six platform skips and
zero failures. The 0.5.0 tarball installed into a fresh temporary prefix and
passed ACP/auth discovery, preview startup/fetch/shutdown and real command
isolation. Both production dependency audits reported zero vulnerabilities.
Package inspection included the preview module and release notes, with no
application state or credential files.

The merged feature revision `60ae33cc` also passed CI on macOS, Ubuntu 24.04 and
26.04, the browser container, the dependency audit and Windows rejection checks.
The Windows check does not establish native Windows support. Publication and
public-download verification are separate results in the GitHub release workflow.

## Targeted file edits (included in 0.6.0)

`edit_file` shares the full protected application path with `write_file`.
Tests cover zero/unique/multiple matches, explicit replacement of all matches,
literal replacement text, CRLF/trailing newlines and the resulting file limit.
ACP tests exercise full diffs, checkpoints/undo, read-only modes, protected and
out-of-root paths, instruction changes, denied/invalid/late approvals, unsaved
editor content and stale edits. Client denial has no local fallback. Automatic
IDE and project checks run after changes; no-ops preserve cached project results.

Validation tests cover concise field-specific errors, whitespace-only command
justification and oversized arguments. Guidance tests cover filtered tool catalogs,
model output metadata, model switching, fallback configuration and the absence of
provider output-cap overrides. A partial truncated tool call never executes; its
single recovery asks for smaller changes only through tools currently offered.

On macOS 27.0 with Node 26.11.1, `npm ci --ignore-scripts`, lint, typecheck and
`npm test` passed: **396 tests passed, six platform skips, zero failures**.
The initial focused suite passed 62 tests; the final harness-only check passed
27 tests, including argument-versus-result schema errors. The checkout production audit found zero
vulnerabilities. Real sandbox tests ran with the required host process/listener
permissions and isolated application state. No Linux, Windows or interactive IDE
acceptance was run for this revision.

Prettier, build, `npm pack` and the isolated installed-package check passed,
including the new edit module, clean ACP/auth discovery, preview lifecycle and
real command isolation outside the checkout. The installed production audit also
found zero vulnerabilities. Documentation clarity audits found no issues.

The [live comparison](edit-verification.md) records successful before/after runs:
six fixture tests passed in each, with 16 versus 13 tool calls and eight versus
nine model rounds. Two earlier changed-build attempts returned HTTP 503 before
tool execution. The completed run used `edit_file`, recovering from one zero-match
edit and one malformed command. This small sample does not establish a general
efficiency improvement. The default was 40 rounds then (now 100) and the 64-call budget is unchanged;
schema failures still count toward both.

## Session modes, model controls and ACP v2 readiness (included in 0.6.0)

`test/session-modes.test.mjs` covers the Ask/Plan/Code mapping, administrator
mode limits, v1 `session/set_mode` and `current_mode_update`, slash commands,
per-session persistence and restore, model display names and declared reasoning
defaults. Ask and Plan tests start from the development permission mode, then
send `write_file`, `edit_file` and `run_command` calls. No file changes, command
or operation approval occurs, and the request omits those tools. Returning to
Code does not restore development or YOLO. A v2-shaped `initialize` receives
protocol version 1. File edits then use local atomic writes and commands use the
owned runner; no client `fs/*` or `terminal/*` request is made.

On macOS 27.0 with Node 26.11.1, `npm ci --ignore-scripts`, lint, typecheck,
Prettier, build and `npm test` passed: **412 tests, 406 passed, six platform
skips, zero failures**. `npm pack`, installation into a fresh temporary prefix
and `test/package-install.mjs` passed. Checkout and installed production audits
found zero vulnerabilities. Real sandbox tests ran with the required host
permissions and isolated application state.

The reasoning fixture uses the `provider_model_controls.reasoning_effort` shape
with Off, low, medium and Max levels and a declared default. No live Open WebUI,
JetBrains or Zed session was run. Selector rendering, `session/set_mode` use by a real
client and provider reasoning effects remain unverified.

## Pre-request compaction and edit locations (included in 0.6.0)

`test/auto-compaction.test.mjs` uses a fake service that reports four serialized
characters per prompt token. It covers the usable-input calculation, the
measured-ratio requirement, bounded summary requests, a compaction triggered
while reported usage is under 80%, system-message and tool-pair preservation in
the continued request, the visible notice, the retained transcript, a failed
summary that stops the turn before any oversized request, disabled automatic
compaction, and the three-per-turn limit. `test/edit-file.test.mjs` checks the
`locations` entry, that the completed call repeats the approved diff, and the
error naming undeclared fields when a required argument is missing.
Results for this revision are in its pull request. Live client rendering of
diffs, locations and the context indicator was not checked.

## Sessions, rewind, steering and job status (included in 0.6.0)

`test/sessions.test.mjs` covers advertised `resume`/`close` capabilities. Load
replays text and tool calls with completed or failed outcomes and makes no
inference request, re-read or approval. Resume returns options and modes without
replay. Close stops a running job and frees the slot; it is idempotent and keeps
the saved transcript. Steering tests cover joining after a tool group, continuing
after a final reply, arrival order, withdrawal, Stop, and queued fallback.
Commands never join. Rewind tests cover turn listing, one diff approval, restore
and truncation, the next request's context, and refusal after a later user edit.
They also cover `--keep-files`, read-only mode, running jobs, bad arguments,
checkpoint chain gaps (which `--keep-files` ignores) and the compaction reset.
A full undo history test makes two edits in one turn: both succeed, the two
oldest checkpoints and their turn tags are dropped, and one notice reports it.
`/rewind` then refuses to restore files for the affected turns, also after
reload, `--keep-files` still works, and `/undo` restores only what remains.
`test/checkpoints.test.mjs` covers eviction by count and by UTF-8 bytes, oldest
first, and text too large to checkpoint. Created files are removed on
Linux; elsewhere the test deletes them manually, then rewinds. Job tests cover
coalesced progress, output size and tail, completion updates, notices only
with the client capability, and one model report per finished job.
`test/auto-compaction.test.mjs` adds a steered message that joins mid-turn.
It is sent in the next request, before the size check that triggers compaction.
After compaction it survives beside the pinned original request. A unit test
covers the pinned steering block.

On macOS 27.0 with Node 26.11.1, after merging main at `27e6a9f`,
`npm ci --ignore-scripts`, lint, typecheck, `npm test`, build and Prettier passed:
**442 tests, 436 passed, six platform skips, zero failures**. `npm pack`,
installation into a fresh temporary prefix and `test/package-install.mjs` passed.
Checkout and installed production audits found zero vulnerabilities.

No live Open WebUI, JetBrains or Zed session was run. Client rendering of
replayed tool calls, of updates after a turn ends and of notices is unverified.
Whether a JetBrains client calls `session/resume` or `session/close` is also
unverified. The steering client matrix in [session controls](sessions.md) comes
from vendor documentation and earlier observation, not a test.

## Compaction during corrected replies (included in 0.6.0)

The recovery-order regression failed against unchanged main `27e6a9f`: the
second request still carried coding tools instead of first requesting a summary.
The follow-up shares the pre-request checks from PR #22 with the single recovery
attempt. It retains that change's usable-input estimate, bounded summary requests
and three-compaction limit; it does not replace the compaction algorithm.
The follow-up is based on main `6be76dd`, including PR #23's session and steering
changes. Steering received during a truncated reply joins before the recovery
compaction check and remains in the corrected request.

Fake-backend tests cover truncated and malformed tool replies, compaction before
the correction, rebuilt instructions/plan/tool guidance, retained partial text
and tool correlations, cancellation and interrupt during the summary, failed or
disabled compaction, and blocking a corrected request that cannot fit. They also
check that a context notice cannot split buffered reply text, does not repeat
after compaction, and does not suppress measured ACP usage updates. No discarded
tool call or historical edit executes.

On macOS 27.0 with Node 26.11.1, `npm ci --ignore-scripts`, lint, typecheck,
build, Prettier and `npm test` passed: **443 tests passed, six platform skips,
zero failures**. `npm pack` and installation outside the checkout passed, including
the installed ACP handshake and sandbox command. Both checkout and installed
production audits found zero vulnerabilities. Documentation clarity audits found
no issues. No live inference or interactive IDE acceptance was run for this
revision. The context wheel still depends on
subsequent provider usage; no estimated percentage or artificial reset is sent.

## Saved session size and file listings (included in 0.6.0)

`test/session-store.test.mjs` covers the trimming function: an unchanged record
within the limit, oldest-first excerpts with intact tool-call pairing, IDs,
names, paths and failure status, untouched latest turns, system message,
guidance, summary and pinned request, deterministic output, the fallback that
keeps only the summary and latest turns (with remapped compaction index,
turn tags and latest turn without checkpoints), the 10,000-message limit, a
near-8 MB record that saves, lists and loads, and a fork fitted by UTF-8
bytes. `test/sessions.test.mjs` adds ACP tests: a 9 MB transcript saves under 8 MB with redacted excerpts, the live
transcript is unchanged and the notice appears once; a trimmed session loads
without inference or approval, replays markers and rewinds files exactly from
checkpoints; after turns are dropped, `/rewind` refuses missing turn numbers and
leaves edits from dropped turns to `/undo`. `test/next-workflows.test.mjs` now
checks that a transcript larger than the limit no longer blocks an edit and
that its checkpoint is stored exactly; it previously asserted the refusal.
`test/core.test.mjs` covers the default ignores, `.gitignore` re-inclusion, a
large `.venv` that previously exceeded the discovery limit, the listing cap and
note, `path` subtrees with refusal of outside, sensitive, symlinked and file
paths, and `search_text` finding a match beyond the capped listing.

Synthetic timing on macOS 27.0 with Node 26.11.1 (sessions of 7.99 MB and 1588
messages, built from the size profile of a real long session, not its content):
listing 1, 8 and 31 such sessions took 34, 142 and 686 ms; one validated load
took 10 to 14 ms. Fitting a 10.7 MB in-memory transcript took 25 to 62 ms and the
private atomic write 43 to 75 ms per save. Process peak RSS, including fixture
generation, stayed under 270 MB. ACP replay sends one update per message, with
tool results capped at 16,000 characters, so no single message approaches the
2 MB inbound line limit.

On macOS 27.0 with Node 26.11.1, `npm ci --ignore-scripts`, lint, typecheck,
Prettier, build and `npm test` passed: **462 tests, 456 passed, six platform
skips, zero failures**. `npm pack`, installation into a fresh temporary prefix
and `test/package-install.mjs` passed. Checkout and installed production audits
found zero vulnerabilities. No live Open WebUI or IDE session was run; how a
client renders the notice and replayed markers is unverified.
## Compaction summary requests (included in 0.6.0)

`test/auto-compaction.test.mjs` sets the session to `xhigh` with levels declared
out of order. The summary request carries `low` and `max_tokens` 6,000, and the
coding requests carry `xhigh` with no cap. Its input plus the cap fits the
window. A summary cut off once by `finish_reason: "length"` is retried over fewer
older messages and then succeeds. Notices name each failure without quoting the
reply: HTTP refusal, empty, cut off after the retry, over 16,000 characters.
Manual `/compact` uses the same request, with a 3,000-token advertised allowance
lowering the cap and requested length. It reports an empty summary and a save
refused by the transcript quota. Unit tests cover effort ranking and fallbacks,
cap and input sizing for a 100,768-token window, the single retry, unretried
failures and reason texts.

On macOS 27.0 with Node 26.11.1, `npm ci --ignore-scripts`, lint, typecheck,
Prettier, build and `npm test` passed: **456 tests, 450 passed, six platform
skips, zero failures**. `npm pack`, installation into a fresh prefix and
`test/package-install.mjs` passed. Checkout and installed production audits
found zero vulnerabilities. No live Open WebUI or IDE session was run: whether
the gateway honours `max_tokens` and `low` for summaries, and the summary quality
at that level, are unverified.
## YOLO in the Mode selector (included in 0.6.0)

JetBrains reported "Mode: yolo (the agent rejected the value)" on new sessions
after PR #21 moved ACP category `mode` from Permissions to the new Mode
selector. The cause is inferred from that message and JetBrains' per-category
memory of the last choice; the exact replay request (`session/set_config_option`
or `session/set_mode`) was not captured, so tests cover both.

Fake-backend tests replay `yolo` through both requests. Each is accepted, shows
YOLO in both views and approves nothing. The next prompt asks for confirmation
before any model request or command; declining leaves YOLO, and accepting runs
the command unsandboxed. Other tests cover the other Permissions IDs, rejection
of unknown values, administrator rules that hide and refuse YOLO, and leaving
YOLO through Code and Plan. Three PR #21 assertions changed only because YOLO is
now a mode: the mode lists, `/status` modes and the helper results.

On macOS 27.0 with Node 26.11.1, `npm ci`, lint, typecheck, build, Prettier and
`npm test` passed: **449 tests passed, six platform skips, zero failures**.
`npm pack` and installation outside the checkout passed, including the installed
ACP handshake and sandbox command. Both checkout and installed production audits
found zero vulnerabilities. No live Open WebUI or JetBrains session was run, so
JetBrains rendering of the fourth mode and removal of the warning are unverified.

## Paged reads, capped search and definition of done (included in 0.6.0)

`test/reading.test.mjs` covers numbered whole reads of small files, files without
a final newline and empty files; default 400-line pages, `offset`/`limit`, the
last page, a limit past the end and an offset past the end; CRLF display and
footer; truncated long lines and the page character cap. Through the agent it
pages a 600-line file, then refuses an `edit_file` whose `old_string` carries
copied prefixes and a `write_file` whose `before` does, writing nothing, and
applies the same edit without prefixes. Search tests cover the 50-result
default and count note, `max_results`, `path`, name and path globs, literal
regex characters, no matches, default-ignored `.venv`, and refusal of outside,
sensitive and file paths and an oversized `max_results`. Reminder tests cover
one reminder after a code edit with no later run, none after docs-only edits,
none when a run follows the last code edit, a fresh reminder in the next turn,
and none when project checks are configured. Removing either of the last two
conditions from the built agent makes its test fail. A unit test checks that the
definition of done appears only when `run_command` is offered, and an ACP test
parses the example calls in the `edit_file` and `run_command` descriptions. Existing tests
that compared a read result with raw file text now expect the numbered format;
the automatic-compaction fixture files became about 20,000 characters of short lines,
because a single 60,000-character line is now cut to 2,000 characters.

`test/manual-read-tokens.mjs` replays a fixed read-heavy task with a scripted
fake model, offline: `list_files`, two searches and `read_file` without
`offset` for 13 files from main `c9dbc9f` (ten `src` modules of 2–23 KB and
three test files of 36–49 KB). Tokens are estimated at four characters each.

| Build                              | Read calls | Read-result characters | Estimated tokens |
| ---------------------------------- | ---------: | ---------------------: | ---------------: |
| main `c9dbc9f`, whole files        |         13 |                275,340 |           68,835 |
| this change, default page          |         13 |                179,469 |           44,867 |
| this change, every page to the end |         28 |                308,198 |           77,050 |

The default first page saves 35%: two thirds on the three test files and 8% on
the ten modules, most of which are 400–600 lines and fit nearly whole in a page. A
task that needs every line pays about 12% more for line numbers and footers, in
more calls. Search results were unchanged at fewer than 50 matches. These are
replayed calls, not model behavior: whether a model reads fewer pages, or
finishes tasks better, needs the live comparison in the research plan.

On macOS 27.0 with Node 26.11.1, `npm ci --ignore-scripts`, lint, typecheck,
Prettier, build and `npm test` passed: **488 tests, 482 passed, six platform
skips, zero failures**. `npm pack`, installation into a fresh temporary prefix
and `test/package-install.mjs` passed. Checkout and installed production audits
found zero vulnerabilities. No live Open WebUI or IDE session was run.

## Image viewing and interactive definition of done (unreleased)

`test/view-image.test.mjs` covers the following:

- format and size detection for PNG, GIF, JPEG and the three WebP chunk types;
- refusal of non-images, images over 1280 pixels on a side and files over 1 MB;
- refusal of outside, sensitive, symlinked and missing paths through the agent;
- the request shape: tool results stay contiguous, then a user message with a
  text part and an `image_url` `data:` URI equal to the file;
- a saved session that holds the path, size and SHA-256 but no image data, and
  that sends the stub after `session/load` without replaying the attachment as
  a user message;
- batch clearing: requests carry 1, 2, 3 and 4 images, then 2 after the fifth;
- capability gating on `info.meta.capabilities.vision` and the `viewImage`
  override;
- token estimates, text-size accounting that excludes inline image data, and a
  near-1 MB image that is still sent;
- image messages excluded from user turns and pinned requests;
- the interactive rule shown only with `run_command` and `view_image`, and the
  browser addition only with both;
- one visual reminder per turn for a pygame file changed after the last viewed
  screenshot, none after a later `view_image`, and none for non-GUI code.

The Plan and read-only tool lists in `permissions.test.mjs` and
`workflow.test.mjs` now include `view_image`, an inspection tool.

On macOS 27.0 with Node 26.11.1, lint, typecheck, Prettier, build and `npm test`
passed: **522 tests, 516 passed, six platform skips, zero failures**. `npm pack`,
installation into a fresh temporary prefix and `test/package-install.mjs`
passed. Checkout and installed production audits found zero vulnerabilities.

One live turn ran `test/manual-image-check.mjs` through Open WebUI 0.13.3, the
deployment gateway and the served model. The model called `view_image` on a
640×480 PNG and answered "The left half is red and the right half is blue."
Reported usage rose from 4,733 to 5,153 tokens between the two requests. That
fits the 302-token estimate plus the call, result, label and answer. No IDE UI
was driven, and no model play-test of a real game was run.

## Content-only write_file (unreleased)

`test/edit-file.test.mjs` covers the following through the ACP loop:

- creation of a new file; refusal of an unread existing file and of a file
  changed after the agent's write, both before approval; replacement after a
  read and after a re-read;
- a `read_file` page that counts as a read; a blind `edit_file` that does not;
  an `edit_file` after a read that keeps the record current;
- unsaved editor text changed after the read, through client file methods;
- legacy `{before, after}` calls: a mismatched `before` ignored, creation with
  `before: null`, the read rule still applied, and the note in the result;
- `edit_file` on a missing file and writes into a missing folder, with no raw
  `ENOENT` in any result;
- records saved as hashes and used after `session/load`, cleared by `/rewind`,
  and an unreadable saved map dropped;
- the 8 KB refusal before the read check, undo through a new-form checkpoint,
  and the existing mode, path, instruction and approval refusals.

Elision and placeholder tests in `context-mask.test.mjs` cover the new stub
text, the older stub wording, and a placeholder in an ignored legacy `before`.
`reading.test.mjs` covers numbered-line content. Tests that rewrote an existing
file without reading it now read it first or record the read in the fixture:
`core`, `edit-file`, `harness`, `interrupt`, `next-workflows`, `permissions`,
`sessions`, `verification` and `yolo`. `permissions.test.mjs` writes after a
reconnect without reading again. Historical transcripts in `workflow.test.mjs`
and `session-store.test.mjs` keep the older form.

On macOS 27.0 with Node 26.11.1, lint, typecheck, Prettier, build and `npm test`
passed: **529 tests, 523 passed, six platform skips, zero failures**. `npm pack`,
installation into a fresh temporary prefix and `test/package-install.mjs`
passed. Checkout and installed production audits found zero vulnerabilities.
No live model or IDE session was run for this change.

## 0.6.0 release candidate

This candidate includes main `b945e39` and updates package, lockfile, ACP/MCP
metadata and registry pins to 0.6.0 without dependency changes.
On macOS 27.0 with Node 26.11.1, `npm ci --ignore-scripts`, lint, typecheck,
Prettier, build and `npm test` passed: **508 tests, 502 passed, six platform
skips, zero failures**. The browser wrapper passed all 17 tests. Its pinned
Playwright catalog also passed the agent integration check without launching a
browser. Production audits of the checkout and wrapper found zero vulnerabilities.

Package installation, platform CI and public-download results are recorded in
the release PR and publication workflow. No live inference or interactive IDE
acceptance was repeated for this candidate. The existing browser container was
not changed; the CI browser job tests its own disposable container. Windows CI
checks unsupported-platform behavior, not native Windows support.

## Loopback network shortcuts

`test/loopback.test.mjs` checks the loopback address rules (literal addresses,
`localhost` with a fake resolver, refused aliases such as `127.1` and
`app.localhost`), reserved and control-channel ports, and the macOS `ps`/`lsof`
and Linux `/proc` parsers for both byte orders. It also starts a real listener
in a grandchild of a process-group leader and checks ownership, a non-owned
listener, another loopback address, a stopped job, cancellation and Windows.
`test/permissions.test.mjs` runs the ACP flow: an unsandboxed background job's
server reached without a prompt, a non-owned listener and Ask each time still
prompting, the session localhost option covering other loopback ports but not
reserved, Open WebUI, remote or alias destinations, revocation, and the
administrator controls `allowLoopbackShortcuts`, `alwaysAsk` and
`networkDestinations`. YOLO runs commands without the proxy and is unchanged;
the existing YOLO tests cover it.

On macOS 27.0 with Node 26.11.1, lint, typecheck, build, Prettier and
`npm test` passed: **532 tests, 526 passed, six Linux-only skips, zero
failures**. `npm pack`, installation into a fresh prefix,
`test/package-install.mjs` and both production dependency audits passed with
zero vulnerabilities. The Linux `/proc` path ran only in CI. The JetBrains
prompt rendering of the new option was not checked in a live IDE.

## T3 desktop compatibility (unreleased)

On macOS 27.0, T3 Code Beta 0.1.6 and Node 26.11.1, published 0.6.0 launched
and completed `/status` in a dedicated scratch project. Its first coding prompt
then failed while connecting the client-supplied T3 stdio MCP bridge. The
bridge's public `ELECTRON_RUN_AS_NODE=1` flag was also treated as a secret and
replaced digits in diagnostic JSON.

The local compatibility build maps the verified client-supplied desktop bridge
to its original loopback HTTP endpoint, with the original MCP authorization.
Fake-server tests cover exact descriptor matching, changed destinations,
malformed and duplicate fields, header injection, client provenance, approval
before traffic, credential separation and absence of diagnostic exemptions.
See [the inspected T3 contract](t3.md). No process runs unsandboxed as a fallback.

`npm ci --ignore-scripts`, build, lint, typecheck and the standard Prettier check
passed. The full suite passed **514 tests: 508 passed, six platform skips, zero
failures**. An earlier run used a dependency symlink and failed three sandboxed
stdio fixtures because their dependencies were outside the permitted directory.
A normal local dependency installation resolved those failures without changing
the sandbox or tests. Package installation, the installed handshake, a real
sandbox command and the installed production audit passed; the audit found zero
vulnerabilities. Documentation clarity audits passed.

Through the running T3 server, the patched provider completed `/status` with
valid JSON, then connected its configured MCP catalogs and returned the requested
marker from live inference. Existing sign-in was used through the agent; no key
was inspected or exported. The smoke prompt requested no tool execution or file
access. Interactive approval rendering, edits, commands, terminal login and
session restoration in T3 were not tested. Other T3 platforms and versions remain
unverified. This is an installed local preview, not part of public 0.6.0.

For the PR, the same adapter was applied to current main `f219d6e` and the
required checks were repeated: lint, typecheck, build and Prettier passed; the
full suite reported **565 tests, 557 passed, eight skips, zero failures**.
The packed installation and installed production audit passed with zero
vulnerabilities. The earlier live result applies to the 0.6.0-based preview;
live inference was not repeated against the newer source.

## Compatibility

| Component                            | Scope                                                                                                |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| Node                                 | 26.11.1 test baseline; package accepts supported Node 24 and 26                                      |
| ACP                                  | Stable v1 through SDK 2.6.0; optional UI depends on client capability                                |
| MCP                                  | SDK 1.32.2; stdio, Streamable HTTP and SSE                                                           |
| macOS                                | Real filesystem/network/process boundary tests; Keychain credentials                                 |
| Linux                                | Bubblewrap/namespaces/seccomp; CI targets Ubuntu 24.04 and 26.04                                     |
| Native Windows                       | Unsupported; persistent state fails closed pending ACL/execution support                             |
| WSL2                                 | Linux route; requires separate environment acceptance                                                |
| JetBrains AI Assistant / Air in IDEs | ACP integration; product-specific UI and registry acceptance must be checked on the installed client |
| Open WebUI                           | Core contract based on 0.12.5 and 0.13.3; native server tasks require 0.9.0 or newer, with response validation |

CI checks macOS and Linux suites, Windows rejection behavior and separately
installed packages. A configured workflow is not a test result. Consult the
source PR's checks for the exact revision; skipped platform tests do not establish
support. Standalone Air is not interchangeable with Air in JetBrains IDEs.

Native Windows implementation and preview acceptance are tracked in the
[Windows plan](windows-plan.md); this release does not enable that platform.

Manual acceptance must cover a real backend, secure-store setup, IDE controls
and registry installation. Automated mocks cannot prove provider tool calling,
reasoning effects, editor rendering or all language-plugin diagnostics. See
[the release checklist](release.md). Test results belong with the source revision
and CI run, not a claim of compatibility for future versions.
