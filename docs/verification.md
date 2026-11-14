# Testing and compatibility

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
npm install --prefix /path/to/isolated-install --ignore-scripts ./openwebui-acp-agent-0.5.0.tgz
npm audit --prefix /path/to/isolated-install --omit=dev --audit-level=high
node test/package-install.mjs /path/to/isolated-install
```

The installed-package check covers ACP stdout/handshake, terminal authentication
and logout discovery, context reporting and real command isolation. Dependency
compatibility must also hold in the installed bundled runtime tree.

The suite covers protocol/authentication, stream parsing, tool validation,
permissions, workspace boundaries, redaction, MCP, commands, queue/interruption,
verification repair limits, compaction, jobs, checkpoints, scoped instructions
and session listing/fork/export. Browser wrapper tests and the optional container
fixture smoke are described in [browser setup](browser.md).

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

## Targeted file edits (unreleased)

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
efficiency improvement. The default 40 rounds and 64-call budget are unchanged;
schema failures still count toward both.

## Session modes, model controls and ACP v2 readiness (unreleased)

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

## Pre-request compaction and edit locations (unreleased)

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

## Sessions, rewind, steering and job status (unreleased)

`test/sessions.test.mjs` covers advertised `resume`/`close` capabilities. Load
replays text and tool calls with completed or failed outcomes and makes no
inference request, re-read or approval. Resume returns options and modes without
replay. Close stops a running job and frees the slot; it is idempotent and keeps
the saved transcript. Steering tests cover joining after a tool group, continuing
after a final reply, arrival order, withdrawal, Stop, and queued fallback.
Commands never join. Rewind tests cover turn listing, one diff approval, restore
and truncation, the next request's context, and refusal after a later user edit.
They also cover `--keep-files`, read-only mode, running jobs, bad arguments,
checkpoint chain gaps and the compaction reset. Created files are removed on
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

## Compaction during corrected replies (unreleased)

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

## Saved session size and file listings (unreleased)

`test/session-store.test.mjs` covers the trimming function: an unchanged record
within the limit, oldest-first excerpts with intact tool-call pairing, IDs,
names, paths and failure status, untouched latest turns, system message,
guidance, summary and pinned request, deterministic output, the fallback that
keeps only the summary and latest turns (with remapped compaction index and
turn tags), the 10,000-message limit, a near-8 MB record that saves, lists and
loads, and a fork fitted by UTF-8 bytes. `test/sessions.test.mjs` adds ACP
tests: a 9 MB transcript saves under 8 MB with redacted excerpts, the live
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
## Compaction summary requests (unreleased)

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
## YOLO in the Mode selector (unreleased)

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

## Paged reads, capped search and definition of done (unreleased)

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
