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
